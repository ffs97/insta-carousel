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
const REACT_UMD_BUF = REACT_UMD_PATH ? fs.readFileSync(REACT_UMD_PATH) : null;
const REACT_DOM_UMD_BUF = REACT_DOM_UMD_PATH
  ? fs.readFileSync(REACT_DOM_UMD_PATH)
  : null;
const JSZIP_BUF = JSZIP_PATH ? fs.readFileSync(JSZIP_PATH) : null;

const PUBLIC_CDN_URLS = {
  react: 'https://unpkg.com/react@18.3.1/umd/react.production.min.js',
  reactDom: 'https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js',
  jszip: 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
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
