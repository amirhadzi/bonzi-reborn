#!/usr/bin/env node
/**
 * Builds the app into dist/ with esbuild.
 *
 *   node scripts/build.mjs              development build (source maps on)
 *   node scripts/build.mjs --minify     distribution build (source maps off unless --sourcemap)
 *   node scripts/build.mjs --watch      rebuild on change
 *
 * Layout:
 *   src/main/main.ts              -> dist/main/main.cjs              (node, cjs)
 *   src/preload/<name>.ts         -> dist/preload/<name>.cjs         (sandboxed, cjs, only requires 'electron')
 *   src/renderer/<page>/main.ts   -> dist/renderer/<page>/main.js    (browser, iife)
 *   src/renderer/<page>/{index.html,styles.css,assets/} copied as-is
 *
 * Missing entry points are skipped with a warning so partial trees still build.
 */

import { context as esbuildContext } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch as fsWatch } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disallowedPreloadRequires, formatBytes, parseBuildArgs } from './lib/build-utils.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const rel = (p) => relative(root, p).replaceAll('\\', '/');

const PRELOADS = ['agent', 'settings'];
const PAGES = ['agent', 'settings'];
const PAGE_STATIC = ['index.html', 'styles.css', 'assets'];

/** Data-URL loaders so a renderer can import small media files directly (the CSP allows data:). */
const ASSET_LOADERS = { '.png': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl', '.wav': 'dataurl' };

let flags;
try {
  flags = parseBuildArgs(process.argv.slice(2));
} catch (err) {
  console.error(`build: ${err.message}`);
  console.error('usage: node scripts/build.mjs [--minify] [--sourcemap|--no-sourcemap] [--watch]');
  process.exit(2);
}

const warnings = [];
const warn = (msg) => {
  warnings.push(msg);
  console.warn(`build: warning: ${msg}`);
};

function common() {
  return {
    absWorkingDir: root,
    bundle: true,
    minify: flags.minify,
    sourcemap: flags.sourcemap ? 'linked' : false,
    legalComments: flags.minify ? 'none' : 'eof',
    charset: 'utf8',
    metafile: true,
    logLevel: 'warning',
    tsconfig: join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': JSON.stringify(flags.minify ? 'production' : 'development') },
  };
}

/** Collects the esbuild targets whose entry points exist. */
function collectTargets() {
  const targets = [];
  const add = (label, entry, options, kind) => {
    const abs = join(root, entry);
    if (!existsSync(abs)) {
      warn(`${entry} not found, skipping ${label}`);
      return;
    }
    targets.push({ label, kind, options: { ...common(), entryPoints: [abs], ...options } });
  };

  add('main', 'src/main/main.ts', {
    outfile: join(dist, 'main/main.cjs'),
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: ['electron'],
  }, 'main');

  for (const name of PRELOADS) {
    add(`preload:${name}`, `src/preload/${name}.ts`, {
      outfile: join(dist, `preload/${name}.cjs`),
      platform: 'browser',
      target: 'chrome150',
      format: 'cjs',
      external: ['electron'],
    }, 'preload');
  }

  for (const page of PAGES) {
    add(`renderer:${page}`, `src/renderer/${page}/main.ts`, {
      outfile: join(dist, `renderer/${page}/main.js`),
      platform: 'browser',
      target: 'chrome150',
      format: 'iife',
      loader: ASSET_LOADERS,
    }, 'renderer');
  }
  return targets;
}

/** Sandboxed preloads may only require('electron'); anything else fails at runtime, so fail the build. */
function checkPreload(target, result) {
  const outfile = target.options.outfile;
  const problems = disallowedPreloadRequires(readFileSync(outfile, 'utf8'));
  for (const [file, out] of Object.entries(result.metafile?.outputs ?? {})) {
    if (file.endsWith('.map')) continue;
    for (const imp of out.imports) {
      if (imp.external && imp.path !== 'electron') problems.push(imp.path);
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `${rel(outfile)} requires ${[...new Set(problems)].map((p) => `'${p}'`).join(', ')}; ` +
        "sandboxed preloads may only require 'electron'",
    );
  }
}

function copyPageStatic(page) {
  const srcDir = join(root, 'src/renderer', page);
  if (!existsSync(srcDir)) return [];
  const outDir = join(dist, 'renderer', page);
  const copied = [];
  for (const name of PAGE_STATIC) {
    const from = join(srcDir, name);
    if (!existsSync(from)) {
      if (name !== 'assets') warn(`src/renderer/${page}/${name} not found`);
      continue;
    }
    const to = join(outDir, name);
    mkdirSync(outDir, { recursive: true });
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    copied.push(to);
  }
  return copied;
}

function sizeOf(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}

function printSizes(results, copied) {
  const rows = [];
  for (const { result } of results) {
    for (const [file, out] of Object.entries(result.metafile?.outputs ?? {})) {
      rows.push([file.replaceAll('\\', '/'), out.bytes]);
    }
  }
  for (const path of copied) rows.push([rel(path) + (statSync(path).isDirectory() ? '/' : ''), sizeOf(path)]);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const width = Math.max(0, ...rows.map((r) => r[0].length));
  for (const [file, bytes] of rows) console.log(`  ${file.padEnd(width)}  ${formatBytes(bytes).padStart(9)}`);
}

async function buildOnce(contexts) {
  const results = [];
  for (const { target, ctx } of contexts) {
    const result = await ctx.rebuild();
    if (target.kind === 'preload') checkPreload(target, result);
    results.push({ target, result });
  }
  const copied = PAGES.flatMap((page) => copyPageStatic(page));
  return { results, copied };
}

async function main() {
  const started = Date.now();
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const targets = collectTargets();
  if (targets.length === 0) warn('no entry points found; dist/ is empty');

  const contexts = [];
  try {
    for (const target of targets) contexts.push({ target, ctx: await esbuildContext(target.options) });
    const { results, copied } = await buildOnce(contexts);
    const mode = flags.minify ? 'minified' : 'development';
    console.log(`build: ${mode} build OK in ${Date.now() - started} ms${flags.sourcemap ? ' (source maps)' : ''}`);
    printSizes(results, copied);
    if (warnings.length > 0) console.log(`build: ${warnings.length} warning(s)`);
  } catch (err) {
    await Promise.all(contexts.map(({ ctx }) => ctx.dispose()));
    throw err;
  }

  if (!flags.watch) {
    await Promise.all(contexts.map(({ ctx }) => ctx.dispose()));
    return;
  }

  await startWatch(contexts);
}

/** Watch mode: esbuild watches the bundles, fs.watch handles static page files. */
async function startWatch(contexts) {
  for (const { target, ctx } of contexts) {
    // Report every rebuild after the initial one.
    let first = true;
    const reporter = {
      name: 'report',
      setup(build) {
        build.onEnd((result) => {
          if (first) {
            first = false;
            return;
          }
          if (result.errors.length > 0) {
            console.error(`build: ${target.label} failed (${result.errors.length} error(s))`);
            return;
          }
          try {
            if (target.kind === 'preload') checkPreload(target, result);
            console.log(`build: rebuilt ${target.label} at ${new Date().toLocaleTimeString()}`);
          } catch (err) {
            console.error(`build: ${err.message}`);
          }
        });
      },
    };
    await ctx.dispose();
    const watched = await esbuildContext({ ...target.options, plugins: [reporter] });
    await watched.watch();
  }

  const timers = new Map();
  for (const page of PAGES) {
    const dir = join(root, 'src/renderer', page);
    if (!existsSync(dir)) continue;
    fsWatch(dir, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '').replaceAll('\\', '/');
      if (!PAGE_STATIC.some((s) => name === s || name.startsWith(`${s}/`))) return;
      clearTimeout(timers.get(page));
      timers.set(
        page,
        setTimeout(() => {
          try {
            copyPageStatic(page);
            console.log(`build: copied static files for ${page} at ${new Date().toLocaleTimeString()}`);
          } catch (err) {
            console.error(`build: copying ${page} static files failed: ${err.message}`);
          }
        }, 50),
      );
    });
  }
  console.log('build: watching for changes (Ctrl+C to stop)');
}

main().catch((err) => {
  // esbuild already printed formatted diagnostics for compile errors.
  const msg = err && typeof err === 'object' && 'errors' in err ? `${err.errors.length} error(s)` : err?.message ?? String(err);
  console.error(`build: FAILED: ${msg}`);
  process.exit(1);
});
