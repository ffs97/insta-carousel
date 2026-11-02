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
