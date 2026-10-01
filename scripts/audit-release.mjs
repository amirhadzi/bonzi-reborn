// Release audit: fails when packaged output contains build-machine paths,
// the builder's user name in a path, or anything that looks like an API key.
//
// Scans release/win-unpacked (including the extracted app.asar) and every
// installer/portable .exe in release/ (extracted with 7-Zip when available,
// otherwise scanned raw). Also removes electron-builder's build logs from
// release/ (builder-debug.yml, builder-effective-config.yaml), which record
// absolute local paths and are never meant to be shipped.
//
// Needles are derived at runtime from this machine (home dir, user name,
// project root, OPENAI_API_KEY value), so this script itself contains no
// private data. Findings never print secret values.
//
// Usage: node scripts/audit-release.mjs [--release <dir>] [--keep-logs]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const RELEASE = path.resolve(ROOT, argValue('--release') ?? 'release');
const KEEP_LOGS = args.includes('--keep-logs');
const WORK = path.join(ROOT, '.scratch', 'audit');

const BUILD_LOGS = ['builder-debug.yml', 'builder-effective-config.yaml'];

// ---------------------------------------------------------------------------
// Needles

function pathVariants(p) {
  if (!p) return [];
  const back = p.replace(/\//g, '\\');
  const fwd = p.replace(/\\/g, '/');
  // JSON / JS string escaped form as well (C:\\Users\\...)
  const escaped = back.replace(/\\/g, '\\\\');
  return [...new Set([back, fwd, escaped])];
}

function buildNeedles() {
  const user = os.userInfo().username;
  const home = os.homedir();
  const literals = new Map(); // text -> label
  for (const v of pathVariants(ROOT)) literals.set(v, 'project path');
  for (const v of pathVariants(home)) literals.set(v, 'home directory');
  if (user && user.length >= 3) {
    for (const sep of ['\\', '/', '\\\\']) literals.set(`Users${sep}${user}`, 'user name in a path');
  }
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey && envKey.length >= 8) literals.set(envKey, 'value of OPENAI_API_KEY');
  return { literals, user };
}

// Key-shaped strings. Short placeholders like "sk-...abcd" do not match.
const KEY_PATTERNS = [
  // Not preceded by a word character (third-party binaries contain words like
  // "task-Submit..."), and long enough to be a real key.
  { label: 'OpenAI-style secret key', re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, keyLike: true },
  { label: 'Anthropic-style secret key', re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{32,}/g, keyLike: true },
  { label: 'Bearer token literal', re: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/g },
  { label: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { label: 'API key assignment', re: /(?:OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{12,}/g },
];
// Test-only values that should never ship in production code.
const TEST_MARKERS = ['sk-test-local', 'MOCK_OPENAI_READY', '__mock/requests'];

// ---------------------------------------------------------------------------
// Scanning

const findings = [];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

function context(buf, index, length, encoding) {
  if (encoding === 'utf16le') {
    // Keep the same byte parity as the match so code units decode correctly.
    const start = index >= 48 ? index - 48 : index % 2;
    const end = Math.min(buf.length, index + length + 48);
    return buf.subarray(start, end).toString('utf16le').replace(/[^\x20-\x7E]/g, '.');
  }
  const start = Math.max(0, index - 24);
  const end = Math.min(buf.length, index + length + 24);
  return buf.subarray(start, end).toString('latin1').replace(/[^\x20-\x7E]/g, '.');
}

function caseInsensitiveIndexes(hay, needle) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < 5) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

function scanBuffer(buf, label, needles) {
  const lowerLatin = buf.toString('latin1').toLowerCase();
  const lowerUtf16 = buf.toString('utf16le').toLowerCase();
  for (const [text, what] of needles.literals) {
    const n = text.toLowerCase();
    for (const i of caseInsensitiveIndexes(lowerLatin, n)) {
      const secret = what.startsWith('value of');
      findings.push({ file: label, what, encoding: 'ascii/utf8', at: i, context: secret ? '(redacted)' : context(buf, i, n.length, 'latin1') });
    }
    for (const i of caseInsensitiveIndexes(lowerUtf16, n)) {
      const secret = what.startsWith('value of');
      findings.push({ file: label, what, encoding: 'utf16le', at: i * 2, context: secret ? '(redacted)' : context(buf, i * 2, n.length * 2, 'utf16le') });
    }
    // utf16 decoded at an odd offset
    const odd = buf.subarray(1).toString('utf16le').toLowerCase();
    for (const i of caseInsensitiveIndexes(odd, n)) {
      const secret = what.startsWith('value of');
      findings.push({ file: label, what, encoding: 'utf16le', at: i * 2 + 1, context: secret ? '(redacted)' : context(buf, i * 2 + 1, n.length * 2, 'utf16le') });
    }
  }
  const latin = buf.toString('latin1');
  for (const { label: what, re, keyLike } of KEY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    let count = 0;
    while ((m = re.exec(latin)) && count < 5) {
      // Real keys are random: they mix digits with upper and lower case letters.
      if (keyLike && !(/[0-9]/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]))) continue;
      count++;
      const shown = m[0].slice(0, 6) + '...(' + m[0].length + ' chars, redacted)';
      findings.push({ file: label, what, encoding: 'ascii/utf8', at: m.index, context: shown });
    }
  }
  for (const marker of TEST_MARKERS) {
    const i = latin.indexOf(marker);
    if (i !== -1) findings.push({ file: label, what: `test-only marker "${marker}"`, encoding: 'ascii/utf8', at: i, context: context(buf, i, marker.length, 'latin1') });
  }
}

function scanFile(file, label, needles) {
  const stat = fs.statSync(file);
  if (stat.size === 0) return;
  scanBuffer(fs.readFileSync(file), label, needles);
}

function scanTree(dir, labelPrefix, needles) {
  let n = 0;
  for (const file of walk(dir)) {
    scanFile(file, path.join(labelPrefix, path.relative(dir, file)), needles);
    n++;
  }
  return n;
}

function find7z() {
  const candidates = [
    path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', '7z.exe'),
    'C:\\Program Files\\7-Zip\\7z.exe',
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

async function extractAsar(asarPath, outDir) {
  const asar = await import('@electron/asar');
  fs.rmSync(outDir, { recursive: true, force: true });
  (asar.default ?? asar).extractAll(asarPath, outDir);
}

// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(RELEASE)) {
    console.error(`audit-release: ${path.relative(ROOT, RELEASE)} does not exist. Run npm run dist first.`);
    process.exit(2);
  }
  const needles = buildNeedles();
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });

  // Build logs: remove (they always contain local paths) unless --keep-logs.
  for (const name of BUILD_LOGS) {
    const p = path.join(RELEASE, name);
    if (fs.existsSync(p)) {
      if (KEEP_LOGS) console.log(`note: ${name} kept (--keep-logs); it contains local paths, do not distribute it`);
      else {
        fs.rmSync(p);
        console.log(`removed ${name} (electron-builder log with local paths)`);
      }
    }
  }

  let scanned = 0;
  const unpacked = path.join(RELEASE, 'win-unpacked');
  if (fs.existsSync(unpacked)) {
    scanned += scanTree(unpacked, 'win-unpacked', needles);
    const asarPath = path.join(unpacked, 'resources', 'app.asar');
    if (fs.existsSync(asarPath)) {
      const out = path.join(WORK, 'app.asar');
      await extractAsar(asarPath, out);
      scanned += scanTree(out, 'win-unpacked/resources/app.asar!', needles);
    }
  } else {
    console.warn('warning: release/win-unpacked not found; scanning installers only');
  }

  const sevenZip = find7z();
  for (const name of fs.readdirSync(RELEASE)) {
    const full = path.join(RELEASE, name);
    if (!fs.statSync(full).isFile()) continue;
    if (/\.(exe|blockmap|yml|yaml|json)$/i.test(name)) {
      scanFile(full, name, needles);
      scanned++;
    }
    if (/\.exe$/i.test(name) && sevenZip) {
      const out = path.join(WORK, 'exe-' + name.replace(/[^A-Za-z0-9.-]/g, '_'));
      const r = spawnSync(sevenZip, ['x', '-y', `-o${out}`, full], { stdio: 'ignore' });
      if (r.status === 0 && fs.existsSync(out)) {
        scanned += scanTree(out, `${name}!`, needles);
        // Nested app archives inside the installer (app-64.7z)
        for (const inner of walk(out)) {
          if (/\.7z$/i.test(inner)) {
            const innerOut = inner + '.d';
            const r2 = spawnSync(sevenZip, ['x', '-y', `-o${innerOut}`, inner], { stdio: 'ignore' });
            if (r2.status === 0) {
              scanned += scanTree(innerOut, `${name}!${path.basename(inner)}!`, needles);
              const innerAsar = [...walk(innerOut)].find((f) => f.endsWith(path.join('resources', 'app.asar')));
              if (innerAsar) {
                const asarOut = innerOut + '.asar';
                await extractAsar(innerAsar, asarOut);
                scanned += scanTree(asarOut, `${name}!app.asar!`, needles);
              }
            }
          }
        }
      } else {
        console.warn(`warning: could not extract ${name} with 7-Zip; scanned raw bytes only`);
      }
    }
  }
  if (!sevenZip) console.warn('warning: 7-Zip not found; installer contents were scanned as raw (compressed) bytes only');

  // De-duplicate identical findings (same file + what + offset)
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.file}|${f.what}|${f.at}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`audit-release: scanned ${scanned} files under ${path.basename(RELEASE)}/`);
  if (unique.length === 0) {
    console.log('audit-release: PASS (no local paths, user names in paths, key-shaped strings or test markers found)');
    fs.rmSync(WORK, { recursive: true, force: true });
    return;
  }
  console.error(`audit-release: FAIL (${unique.length} finding(s))`);
  for (const f of unique.slice(0, 100)) console.error(`  - ${f.what} in ${f.file} @${f.at} [${f.encoding}]: ${f.context}`);
  if (unique.length > 100) console.error(`  ... and ${unique.length - 100} more`);
  process.exit(1);
}

main().catch((err) => {
  console.error('audit-release crashed:', err);
  process.exit(2);
});
