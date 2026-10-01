// Builds the animation engine dev harness into .scratch/harness/ and serves it
// (plus /assets from the project root) on http://127.0.0.1:5199.
//
//   node scripts/harness.mjs              build + serve
//   node scripts/harness.mjs --build-only
//   node scripts/harness.mjs --port 5200

import { build } from 'esbuild';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'renderer', 'harness');
const outDir = path.join(root, '.scratch', 'harness');
const assetsDir = path.join(root, 'assets');

const args = process.argv.slice(2);
const buildOnly = args.includes('--build-only');
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : Number(process.env.HARNESS_PORT ?? 5199);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.acs': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

async function buildHarness() {
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(srcDir, 'main.ts')],
    outfile: path.join(outDir, 'main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
  await copyFile(path.join(srcDir, 'index.html'), path.join(outDir, 'index.html'));
  await copyFile(path.join(srcDir, 'styles.css'), path.join(outDir, 'styles.css'));
}

/** Maps a URL path to a file inside `base`, or null when it escapes it. */
function resolveInside(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}

async function serve() {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      let file;
      if (url.pathname.startsWith('/assets/')) file = resolveInside(assetsDir, url.pathname.slice('/assets'.length));
      else file = resolveInside(outDir, url.pathname === '/' ? '/index.html' : url.pathname);
      if (!file) {
        res.writeHead(403).end();
        return;
      }
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`engine harness: http://127.0.0.1:${port}/`);
}

await buildHarness();
console.log(`built ${path.relative(root, outDir)}`);
if (!buildOnly) await serve();
