import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let ts;
try {
  ts = require('typescript');
} catch {
  console.error(
    'Error: "typescript" package not found. Please run `npm install` first.'
  );
  process.exit(1);
}

/**
 * Resolves a file inside an installed package directory by locating its package.json first,
 * avoiding Node's ERR_PACKAGE_PATH_NOT_EXPORTED for UMD subpaths like `react/umd/...`.
 */
function resolvePackageFile(pkgName, relativePaths) {
  try {
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
    const pkgDir = path.dirname(pkgJsonPath);
    for (const rel of relativePaths) {
      const full = path.join(pkgDir, rel);
      if (fs.existsSync(full)) return full;
    }
  } catch {
    // Package not found in node_modules / system paths
  }
  return null;
}

const REACT_UMD_PATH = resolvePackageFile('react', [
  'umd/react.production.min.js',
  'umd/react.development.js',
]);
const REACT_DOM_UMD_PATH = resolvePackageFile('react-dom', [
  'umd/react-dom.production.min.js',
  'umd/react-dom.development.js',
]);
const JSZIP_PATH = resolvePackageFile('jszip', [
  'dist/jszip.min.js',
  'dist/jszip.js',
]);
const HEIC2ANY_PATH = resolvePackageFile('heic2any', [
  'dist/heic2any.min.js',
  'dist/heic2any.js',
]);

const REACT_UMD_BUF = REACT_UMD_PATH ? fs.readFileSync(REACT_UMD_PATH) : null;
const REACT_DOM_UMD_BUF = REACT_DOM_UMD_PATH
  ? fs.readFileSync(REACT_DOM_UMD_PATH)
  : null;
const JSZIP_BUF = JSZIP_PATH ? fs.readFileSync(JSZIP_PATH) : null;
const HEIC2ANY_BUF = HEIC2ANY_PATH ? fs.readFileSync(HEIC2ANY_PATH) : null;

const PUBLIC_CDN_URLS = {
  react: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  reactDom: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  jszip: 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  heic2any: 'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js',
};

const PORT = Number(process.env.PORT || 5173);
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

// Persistent temp cache directory for original source videos and lightweight stage proxies
const SESSION_MEDIA_DIR = path.join(os.tmpdir(), 'carouselflow_media_cache');
try {
  fs.mkdirSync(SESSION_MEDIA_DIR, { recursive: true });
} catch {}

/**
 * Maps serverVideoId -> {
 *   serverVideoId: string,
 *   sourcePath: string,
 *   proxyPath: string,
 *   width: number,
 *   height: number,
 *   proxyWidth: number,
 *   proxyHeight: number,
 *   duration: number,
 *   hasAudio: boolean,
 * }
 */
const uploadedVideos = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function resolveLocalModulePath(baseDir, specifier) {
  if (!specifier.startsWith('.')) return specifier;
  const candidateBase = path.resolve(baseDir, specifier);
  const exts = ['', '.ts', '.tsx', '.js', '.mjs'];
  for (const ext of exts) {
    const full = candidateBase + ext;
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const rel = path.relative(__dirname, full).split(path.sep).join('/');
      return '/' + rel;
    }
  }
  return specifier;
}

function rewriteRelativeImports(code, fileDir) {
  return code
    .replace(
      /(from\s+['"])(\.[^'"]+)(['"])/g,
      (_, p1, spec, p3) => `${p1}${resolveLocalModulePath(fileDir, spec)}${p3}`
    )
    .replace(
      /(import\s*\(\s*['"])(\.[^'"]+)(['"]\s*\))/g,
      (_, p1, spec, p3) => `${p1}${resolveLocalModulePath(fileDir, spec)}${p3}`
    );
}

function runCommandPromise(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => {
      resolve({ ok: false, error: `${cmd}: ${err.message}` });
    });
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        resolve({
          ok: false,
          error: `${cmd} exited with code ${code}: ${(stderr || stdout).slice(-400)}`,
        });
      }
    });
  });
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Converts a .HEIC / .HEIF photo buffer into a high-resolution JPEG using
 * macOS built-in `sips`, `heif-convert` (libheif), or `ffmpeg`.
 */
async function handleConvertHeic(req, res) {
  try {
    const inputBuffer = await collectRequestBody(req);
    if (!inputBuffer.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty HEIC buffer received' }));
      return;
    }

    const tmpDir = os.tmpdir();
    const id = `insta_heic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(tmpDir, `${id}.heic`);
    const outPath = path.join(tmpDir, `${id}.jpg`);

    fs.writeFileSync(inPath, inputBuffer);

    const errors = [];

    // 1. Try macOS built-in `sips` (hardware-accelerated on all Macs)
    if (process.platform === 'darwin' || fs.existsSync('/usr/bin/sips')) {
      const sipsRes = await runCommandPromise('sips', [
        '-s',
        'format',
        'jpeg',
        '-s',
        'formatOptions',
        '98',
        inPath,
        '--out',
        outPath,
      ]);
      if (sipsRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        const jpgBuf = fs.readFileSync(outPath);
        try {
          fs.unlinkSync(inPath);
          fs.unlinkSync(outPath);
        } catch {}
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': jpgBuf.length,
          'Cache-Control': 'no-store',
        });
        res.end(jpgBuf);
        return;
      }
      errors.push(sipsRes.error);
    }

    // 2. Try `heif-convert` (from libheif-examples / brew install libheif)
    const heifRes = await runCommandPromise('heif-convert', [
      '-q',
      '98',
      inPath,
      outPath,
    ]);
    if (heifRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      const jpgBuf = fs.readFileSync(outPath);
      try {
        fs.unlinkSync(inPath);
        fs.unlinkSync(outPath);
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': jpgBuf.length,
        'Cache-Control': 'no-store',
      });
      res.end(jpgBuf);
      return;
    }
    errors.push(heifRes.error);

    // 3. Try `ffmpeg`
    const ffRes = await runCommandPromise(FFMPEG_BIN, [
      '-y',
      '-i',
      inPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outPath,
    ]);
    if (ffRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      const jpgBuf = fs.readFileSync(outPath);
      try {
        fs.unlinkSync(inPath);
        fs.unlinkSync(outPath);
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': jpgBuf.length,
        'Cache-Control': 'no-store',
      });
      res.end(jpgBuf);
      return;
    }
    errors.push(ffRes.error);

    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'HEIC server conversion failed',
        details: errors.filter(Boolean).join(' | '),
      })
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * Normalizes an imported .MOV or HEVC/QuickTime video into a browser-compatible
 * H.264 + AAC .mp4 file using ffmpeg so it plays and renders smoothly in HTML5 <video>.
 */
async function handleNormalizeVideo(req, res) {
  try {
    const inputBuffer = await collectRequestBody(req);
    if (!inputBuffer.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty video buffer received' }));
      return;
    }

    const tmpDir = os.tmpdir();
    const id = `insta_norm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(tmpDir, `${id}_in.mov`);
    const outPath = path.join(tmpDir, `${id}_out.mp4`);

    fs.writeFileSync(inPath, inputBuffer);

    const ffArgs = [
      '-y',
      '-i',
      inPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-profile:v',
      'high',
      '-level',
      '4.2',
      '-crf',
      '17',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      outPath,
    ];

    const ffRes = await runCommandPromise(FFMPEG_BIN, ffArgs);
    try {
      if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    } catch {}

    if (ffRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      const mp4Buffer = fs.readFileSync(outPath);
      try {
        fs.unlinkSync(outPath);
      } catch {}
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': mp4Buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(mp4Buffer);
      return;
    }

    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch {}

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error:
          'Failed to normalize video via ffmpeg. Ensure ffmpeg is installed (e.g., `brew install ffmpeg` on macOS or `sudo apt install ffmpeg` on Linux).',
        details: ffRes.error,
      })
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function parseFfmpegVideoMetadata(stderrText) {
  let duration = 5;
  const durMatch = stderrText.match(
    /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i
  );
  if (durMatch) {
    const hrs = parseInt(durMatch[1], 10) || 0;
    const mins = parseInt(durMatch[2], 10) || 0;
    const secs = parseFloat(durMatch[3]) || 0;
    const total = hrs * 3600 + mins * 60 + secs;
    if (total > 0) duration = total;
  }

  const inputSection = stderrText.split(/Output #0/i)[0] || stderrText;
  const outputSection = stderrText.split(/Output #0/i)[1] || '';

  const hasAudio = /Stream #\d+:\d+.*Audio:/i.test(inputSection);

  let rawSourceW = 1440;
  let rawSourceH = 1800;
  const inDimMatch = inputSection.match(
    /Stream #\d+:\d+.*Video:.*?\s(\d{2,5})x(\d{2,5})(?:[\s,]|$)/i
  );
  if (inDimMatch) {
    rawSourceW = parseInt(inDimMatch[1], 10) || 1440;
    rawSourceH = parseInt(inDimMatch[2], 10) || 1800;
  }

  let proxyW = rawSourceW;
  let proxyH = rawSourceH;
  const outDimMatch = outputSection.match(
    /Stream #\d+:\d+.*Video:.*?\s(\d{2,5})x(\d{2,5})(?:[\s,]|$)/i
  );
  if (outDimMatch) {
    proxyW = parseInt(outDimMatch[1], 10) || rawSourceW;
    proxyH = parseInt(outDimMatch[2], 10) || rawSourceH;
  }

  // If ffmpeg auto-rotated the input stream (e.g. 90/-90 deg portrait iPhone .MOV),
  // align sourceWidth/sourceHeight orientation with the auto-rotated proxy output.
  let sourceW = rawSourceW;
  let sourceH = rawSourceH;
  if (
    proxyW !== proxyH &&
    rawSourceW !== rawSourceH &&
    rawSourceW > rawSourceH !== proxyW > proxyH
  ) {
    sourceW = rawSourceH;
    sourceH = rawSourceW;
  }

  return {
    duration,
    hasAudio,
    width: sourceW,
    height: sourceH,
    proxyWidth: proxyW,
    proxyHeight: proxyH,
  };
}

/**
 * Caches the original uploaded video on disk for lossless/direct offline export,
 * and generates a lightweight, 8-bit yuv420p H.264 stage proxy (max 960px, frequent keyframes)
 * so the browser canvas preview never lags, stutters, or renders black frames.
 */
async function handleImportVideo(req, res, urlObj) {
  try {
    const inputBuffer = await collectRequestBody(req);
    if (!inputBuffer.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty video buffer received' }));
      return;
    }

    const origName = urlObj.searchParams.get('name') || 'video.mp4';
    const rawExt = path.extname(origName).toLowerCase();
    const safeExt =
      rawExt && /^[.][a-z0-9]{2,5}$/.test(rawExt) ? rawExt : '.mp4';

    const serverVideoId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const sourcePath = path.join(
      SESSION_MEDIA_DIR,
      `${serverVideoId}_source${safeExt}`
    );
    const proxyPath = path.join(
      SESSION_MEDIA_DIR,
      `${serverVideoId}_proxy.mp4`
    );

    fs.writeFileSync(sourcePath, inputBuffer);

    const ffArgs = [
      '-y',
      '-i',
      sourcePath,
      '-vf',
      "scale='min(960,iw)':-2,format=yuv420p",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-profile:v',
      'main',
      '-crf',
      '22',
      '-g',
      '15',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      proxyPath,
    ];

    const ffRes = await runCommandPromise(FFMPEG_BIN, ffArgs);
    if (
      !ffRes.ok ||
      !fs.existsSync(proxyPath) ||
      fs.statSync(proxyPath).size === 0
    ) {
      try {
        if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
        if (fs.existsSync(proxyPath)) fs.unlinkSync(proxyPath);
      } catch {}
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Failed to process video with ffmpeg. Ensure ffmpeg is installed (`brew install ffmpeg` on macOS or `sudo apt install ffmpeg` on Linux).',
          details: ffRes.error,
        })
      );
      return;
    }

    const meta = parseFfmpegVideoMetadata(ffRes.stderr || '');
    const record = {
      serverVideoId,
      sourcePath,
      proxyPath,
      width: meta.width,
      height: meta.height,
      proxyWidth: meta.proxyWidth,
      proxyHeight: meta.proxyHeight,
      duration: meta.duration,
      hasAudio: meta.hasAudio,
    };
    uploadedVideos.set(serverVideoId, record);

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        serverVideoId,
        proxyUrl: `/api/video-proxy/${serverVideoId}`,
        width: meta.width,
        height: meta.height,
        proxyWidth: meta.proxyWidth,
        proxyHeight: meta.proxyHeight,
        duration: meta.duration,
        hasAudio: meta.hasAudio,
      })
    );
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

/**
 * Serves the lightweight stage proxy MP4 with full HTTP Range (206 Partial Content) support
 * so browser <video> elements can seek, scrub, and loop instantaneously.
 */
function handleServeVideoProxy(req, res, serverVideoId) {
  const entry = uploadedVideos.get(serverVideoId);
  const proxyPath =
    entry?.proxyPath ||
    path.join(SESSION_MEDIA_DIR, `${serverVideoId}_proxy.mp4`);

  if (!fs.existsSync(proxyPath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Video proxy not found: ${serverVideoId}` }));
    return;
  }

  const stat = fs.statSync(proxyPath);
  const total = stat.size;
  const rangeHeader = req.headers.range;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10) || 0;
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    const clampedStart = Math.max(0, Math.min(start, total - 1));
    const clampedEnd = Math.max(clampedStart, Math.min(end, total - 1));
    const chunkSize = clampedEnd - clampedStart + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${clampedStart}-${clampedEnd}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(proxyPath, {
      start: clampedStart,
      end: clampedEnd,
    }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(proxyPath).pipe(res);
  }
}

/**
 * Offline deterministic ffmpeg compositor for video slides (`POST /api/render-video-slide`).
 * Composites the slide's static underlay PNG, each original source video layer (trimmed, looped/frozen,
 * cropped, scaled, and rounded-corner masked), and optional foreground static overlay PNG directly
 * into a 60fps 1440p H.264 + AAC .mp4 with zero real-time browser capture lag or dropped frames.
 */
async function handleRenderVideoSlide(req, res) {
  const tempFiles = [];
  const cleanupTempFiles = () => {
    for (const f of tempFiles) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch {}
    }
  };

  try {
    const bodyBuf = await collectRequestBody(req);
    const payload = JSON.parse(bodyBuf.toString('utf8'));

    const slideWidth = Math.round(Number(payload.slideWidth) || 1440);
    const slideHeight = Math.round(Number(payload.slideHeight) || 1800);
    const totalDuration = Math.min(
      60,
      Math.max(0.5, Number(payload.totalDuration) || 5)
    );
    const underlayPngBase64 = payload.underlayPngBase64;
    const overlayPngBase64 = payload.overlayPngBase64 || null;
    const videoLayers = Array.isArray(payload.videoLayers)
      ? payload.videoLayers
      : [];

    if (!underlayPngBase64 || videoLayers.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'Missing underlayPngBase64 or videoLayers in render request',
        })
      );
      return;
    }

    const jobId = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const underlayPath = path.join(SESSION_MEDIA_DIR, `${jobId}_underlay.png`);
    fs.writeFileSync(underlayPath, Buffer.from(underlayPngBase64, 'base64'));
    tempFiles.push(underlayPath);

    let overlayPath = null;
    if (overlayPngBase64) {
      overlayPath = path.join(SESSION_MEDIA_DIR, `${jobId}_overlay.png`);
      fs.writeFileSync(overlayPath, Buffer.from(overlayPngBase64, 'base64'));
      tempFiles.push(overlayPath);
    }

    const outPath = path.join(SESSION_MEDIA_DIR, `${jobId}_out.mp4`);
    tempFiles.push(outPath);

    // Prepare inputs and filter_complex graph
    const inputArgs = [
      '-loop',
      '1',
      '-t',
      totalDuration.toFixed(4),
      '-framerate',
      '60',
      '-i',
      underlayPath,
    ];
    let nextInputIdx = 1;

    const filterChains = [
      `[0:v]scale=${slideWidth}:${slideHeight},format=rgba[bg0]`,
    ];
    let currentBgLabel = '[bg0]';
    const audioCandidateLabels = [];

    for (let i = 0; i < videoLayers.length; i++) {
      const layer = videoLayers[i];
      const entry = uploadedVideos.get(layer.serverVideoId);
      if (!entry || !fs.existsSync(entry.sourcePath)) {
        cleanupTempFiles();
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `Cached source video not found for ${layer.serverVideoId}. Please re-import the video file.`,
          })
        );
        return;
      }

      const vidInputIdx = nextInputIdx++;
      inputArgs.push('-i', entry.sourcePath);

      const dx = Math.round(Number(layer.dx) || 0);
      const dy = Math.round(Number(layer.dy) || 0);
      const dw = Math.max(2, Math.round(Number(layer.dw) || slideWidth));
      const dh = Math.max(2, Math.round(Number(layer.dh) || slideHeight));

      const cropX = Math.max(0, Math.min(0.99, Number(layer.crop?.x) || 0));
      const cropY = Math.max(0, Math.min(0.99, Number(layer.crop?.y) || 0));
      const cropW = Math.max(
        0.01,
        Math.min(1 - cropX, Number(layer.crop?.width) || 1)
      );
      const cropH = Math.max(
        0.01,
        Math.min(1 - cropY, Number(layer.crop?.height) || 1)
      );

      const trimStart = Math.max(0, Number(layer.trimStart) || 0);
      const rawTrimEnd = Number(layer.trimEnd);
      const trimEnd =
        rawTrimEnd > trimStart + 0.05
          ? rawTrimEnd
          : Math.max(trimStart + 0.5, entry.duration || totalDuration);
      const clipDur = Math.max(0.1, trimEnd - trimStart);
      const endBehavior = layer.endBehavior === 'freeze' ? 'freeze' : 'loop';

      let vChain = `[${vidInputIdx}:v]trim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},setpts=PTS-STARTPTS,fps=60,crop=w='max(2,iw*${cropW.toFixed(6)})':h='max(2,ih*${cropH.toFixed(6)})':x='iw*${cropX.toFixed(6)}':y='ih*${cropY.toFixed(6)}',scale=${dw}:${dh}:flags=lanczos,format=rgba`;

      if (clipDur < totalDuration - 0.05) {
        if (endBehavior === 'freeze') {
          const padDur = (totalDuration - clipDur + 0.5).toFixed(4);
          vChain += `,tpad=stop_mode=clone:stop_duration=${padDur},trim=duration=${totalDuration.toFixed(4)},setpts=PTS-STARTPTS`;
        } else {
          const loopsNeeded = Math.ceil(totalDuration / clipDur);
          const loopFrames = Math.ceil(clipDur * 60) + 2;
          vChain += `,loop=loop=${loopsNeeded}:size=${loopFrames}:start=0,setpts=N/(60*TB),trim=duration=${totalDuration.toFixed(4)},setpts=PTS-STARTPTS`;
        }
      } else {
        vChain += `,trim=duration=${totalDuration.toFixed(4)},setpts=PTS-STARTPTS`;
      }

      let layerOutLabel = `[vlayer${i}]`;
      if (layer.maskPngBase64) {
        const maskPath = path.join(SESSION_MEDIA_DIR, `${jobId}_mask_${i}.png`);
        fs.writeFileSync(maskPath, Buffer.from(layer.maskPngBase64, 'base64'));
        tempFiles.push(maskPath);

        const maskInputIdx = nextInputIdx++;
        inputArgs.push(
          '-loop',
          '1',
          '-t',
          totalDuration.toFixed(4),
          '-framerate',
          '60',
          '-i',
          maskPath
        );

        const rawLabel = `[vraw${i}]`;
        const maskLabel = `[vmask${i}]`;
        filterChains.push(`${vChain}${rawLabel}`);
        filterChains.push(
          `[${maskInputIdx}:v]scale=${dw}:${dh},format=gray${maskLabel}`
        );
        filterChains.push(
          `${rawLabel}${maskLabel}alphamerge${layerOutLabel}`
        );
      } else {
        filterChains.push(`${vChain}${layerOutLabel}`);
      }

      const nextBgLabel = `[bg${i + 1}]`;
      filterChains.push(
        `${currentBgLabel}${layerOutLabel}overlay=x=${dx}:y=${dy}:format=auto:shortest=1${nextBgLabel}`
      );
      currentBgLabel = nextBgLabel;

      if (!layer.muted && entry.hasAudio) {
        let aChain = `[${vidInputIdx}:a]atrim=start=${trimStart.toFixed(4)}:end=${trimEnd.toFixed(4)},asetpts=PTS-STARTPTS`;
        if (clipDur < totalDuration - 0.05) {
          if (endBehavior === 'freeze') {
            aChain += `,apad=whole_dur=${totalDuration.toFixed(4)}`;
          } else {
            const loopsNeeded = Math.ceil(totalDuration / clipDur);
            const loopSamples = Math.ceil(clipDur * 48000);
            aChain += `,aloop=loop=${loopsNeeded}:size=${loopSamples},atrim=duration=${totalDuration.toFixed(4)},asetpts=PTS-STARTPTS`;
          }
        } else {
          aChain += `,atrim=duration=${totalDuration.toFixed(4)},asetpts=PTS-STARTPTS`;
        }
        const aLabel = `[aud${i}]`;
        filterChains.push(`${aChain}${aLabel}`);
        audioCandidateLabels.push(aLabel);
      }
    }

    if (overlayPath) {
      const ovInputIdx = nextInputIdx++;
      inputArgs.push(
        '-loop',
        '1',
        '-t',
        totalDuration.toFixed(4),
        '-framerate',
        '60',
        '-i',
        overlayPath
      );
      const nextBgLabel = `[bg_ov]`;
      filterChains.push(
        `${currentBgLabel}[${ovInputIdx}:v]overlay=x=0:y=0:format=auto:shortest=1${nextBgLabel}`
      );
      currentBgLabel = nextBgLabel;
    }

    const outEvenW = Math.floor(slideWidth / 2) * 2;
    const outEvenH = Math.floor(slideHeight / 2) * 2;
    filterChains.push(
      `${currentBgLabel}scale=${outEvenW}:${outEvenH},format=yuv420p[vout]`
    );

    const buildFfmpegArgs = (includeAudio) => {
      const chains = [...filterChains];
      const mapArgs = ['-map', '[vout]'];
      if (includeAudio && audioCandidateLabels.length === 1) {
        mapArgs.push('-map', audioCandidateLabels[0]);
      } else if (includeAudio && audioCandidateLabels.length > 1) {
        chains.push(
          `${audioCandidateLabels.join('')}amix=inputs=${audioCandidateLabels.length}:duration=first:dropout_transition=0[aout]`
        );
        mapArgs.push('-map', '[aout]');
      }

      return [
        '-y',
        ...inputArgs,
        '-filter_complex',
        chains.join(';'),
        ...mapArgs,
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-profile:v',
        'high',
        '-level',
        '4.2',
        '-crf',
        '17',
        '-maxrate',
        '15000k',
        '-bufsize',
        '30000k',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '60',
        ...(includeAudio && audioCandidateLabels.length > 0
          ? ['-c:a', 'aac', '-b:a', '256k']
          : ['-an']),
        '-t',
        totalDuration.toFixed(4),
        '-movflags',
        '+faststart',
        outPath,
      ];
    };

    let ffRes = await runCommandPromise(
      FFMPEG_BIN,
      buildFfmpegArgs(audioCandidateLabels.length > 0)
    );

    // If audio mixing failed on an unusual audio stream, retry video-only so export still succeeds
    if (
      (!ffRes.ok || !fs.existsSync(outPath) || fs.statSync(outPath).size === 0) &&
      audioCandidateLabels.length > 0
    ) {
      const videoOnlyChains = filterChains.filter(
        (c) => !c.includes('atrim=') && !c.includes('[aud')
      );
      const fallbackArgs = [
        '-y',
        ...inputArgs,
        '-filter_complex',
        videoOnlyChains.join(';'),
        '-map',
        '[vout]',
        '-c:v',
        'libx264',
        '-preset',
        'fast',
        '-profile:v',
        'high',
        '-level',
        '4.2',
        '-crf',
        '17',
        '-maxrate',
        '15000k',
        '-bufsize',
        '30000k',
        '-pix_fmt',
        'yuv420p',
        '-r',
        '60',
        '-an',
        '-t',
        totalDuration.toFixed(4),
        '-movflags',
        '+faststart',
        outPath,
      ];
      ffRes = await runCommandPromise(FFMPEG_BIN, fallbackArgs);
    }

    if (ffRes.ok && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      const mp4Buffer = fs.readFileSync(outPath);
      cleanupTempFiles();
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': mp4Buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(mp4Buffer);
      return;
    }

    cleanupTempFiles();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'Offline ffmpeg slide render failed',
        details: ffRes.error,
      })
    );
  } catch (err) {
    cleanupTempFiles();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

function handleTranscodeMp4(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const inputBuffer = Buffer.concat(chunks);
    if (!inputBuffer.length) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Empty video buffer' }));
      return;
    }

    const tmpDir = os.tmpdir();
    const id = `insta_slide_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const inPath = path.join(tmpDir, `${id}_in.webm`);
    const outPath = path.join(tmpDir, `${id}_out.mp4`);

    try {
      fs.writeFileSync(inPath, inputBuffer);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
      return;
    }

    const ffArgs = [
      '-y',
      '-i',
      inPath,
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-profile:v',
      'high',
      '-level',
      '4.2',
      '-crf',
      '17',
      '-maxrate',
      '15000k',
      '-bufsize',
      '30000k',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '60',
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a',
      'aac',
      '-b:a',
      '256k',
      '-movflags',
      '+faststart',
      outPath,
    ];

    const proc = spawn(FFMPEG_BIN, ffArgs);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('error', (err) => {
      try {
        if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      } catch {}
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: 'ffmpeg not found or failed to launch',
          details: String(err),
        })
      );
    });

    proc.on('close', (code) => {
      try {
        if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
      } catch {}

      if (code === 0 && fs.existsSync(outPath)) {
        try {
          const mp4Buffer = fs.readFileSync(outPath);
          fs.unlinkSync(outPath);
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': mp4Buffer.length,
            'Cache-Control': 'no-store',
          });
          res.end(mp4Buffer);
          return;
        } catch (readErr) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(readErr) }));
          return;
        }
      } else if (!res.writableEnded) {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'ffmpeg transcode failed',
            details: stderr.slice(-600),
          })
        );
      }
    });
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`
  );
  const pathname = decodeURIComponent(urlObj.pathname);

  if (req.method === 'POST' && pathname === '/api/import-video') {
    handleImportVideo(req, res, urlObj);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/video-proxy/')) {
    const serverVideoId = pathname.slice('/api/video-proxy/'.length);
    handleServeVideoProxy(req, res, serverVideoId);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/render-video-slide') {
    handleRenderVideoSlide(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/transcode-mp4') {
    handleTranscodeMp4(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/convert-heic') {
    handleConvertHeic(req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/normalize-video') {
    handleNormalizeVideo(req, res);
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/vendor/react.umd.js') {
    if (REACT_UMD_BUF) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(REACT_UMD_BUF);
    } else {
      res.writeHead(302, { Location: PUBLIC_CDN_URLS.react });
      res.end();
    }
    return;
  }

  if (pathname === '/vendor/react-dom.umd.js') {
    if (REACT_DOM_UMD_BUF) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(REACT_DOM_UMD_BUF);
    } else {
      res.writeHead(302, { Location: PUBLIC_CDN_URLS.reactDom });
      res.end();
    }
    return;
  }

  if (pathname === '/vendor/jszip.min.js') {
    if (JSZIP_BUF) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(JSZIP_BUF);
    } else {
      res.writeHead(302, { Location: PUBLIC_CDN_URLS.jszip });
      res.end();
    }
    return;
  }

  if (pathname === '/vendor/heic2any.min.js') {
    if (HEIC2ANY_BUF) {
      res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
      res.end(HEIC2ANY_BUF);
    } else {
      res.writeHead(302, { Location: PUBLIC_CDN_URLS.heic2any });
      res.end();
    }
    return;
  }

  if (pathname === '/vendor/react-esm.js') {
    const esm = `
const R = window.React;
export default R;
export const {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  useReducer,
  useContext,
  useLayoutEffect,
  createContext,
  createElement,
  Fragment,
  forwardRef,
  memo
} = R;
`;
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
    res.end(esm);
    return;
  }

  if (pathname === '/vendor/react-dom-esm.js') {
    const esm = `
const RD = window.ReactDOM;
export default RD;
export const { createRoot, flushSync, createPortal } = RD;
`;
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.js'] });
    res.end(esm);
    return;
  }

  const targetPath =
    pathname === '/'
      ? path.join(__dirname, 'index.html')
      : path.join(__dirname, pathname);

  // Prevent directory traversal outside project directory
  if (!targetPath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(targetPath);
  if (ext === '.ts' || ext === '.tsx') {
    try {
      const source = fs.readFileSync(targetPath, 'utf8');
      const result = ts.transpileModule(source, {
        fileName: targetPath,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.React,
          esModuleInterop: true,
          isolatedModules: true,
        },
      });
      const rewritten = rewriteRelativeImports(
        result.outputText,
        path.dirname(targetPath)
      );
      res.writeHead(200, {
        'Content-Type': MIME_TYPES['.js'],
        'Cache-Control': 'no-store',
      });
      res.end(rewritten);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`TypeScript Transpile Error in ${pathname}:\n${String(err)}`);
    }
    return;
  }

  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
  });
  res.end(fs.readFileSync(targetPath));
});

server.listen(PORT, '::', () => {
  console.log(`CarouselFlow Studio running at http://localhost:${PORT}`);
});
