// Launching and tearing down the Electron app for E2E runs.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCHDOG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e-watchdog.mjs');

/** Finds a free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Environment variables that must never leak from the developer's shell into a test run. */
const SCRUBBED_ENV = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS', 'BONZI_USER_DATA', 'BONZI_E2E_CAPTURE'];

/**
 * Writes settings.json into a fresh userData dir.
 * @param {string} userDataDir
 * @param {Record<string, unknown>} settings
 */
export async function prepareUserData(userDataDir, settings) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(path.join(userDataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Starts electron.exe <appDir> with remote debugging and an isolated userData dir.
 * stdout and stderr go to logPath.
 */
export async function launchApp({ electronPath, appDir, cdpPort, userDataDir, apiKey, logPath, extraArgs = [], extraEnv = {} }) {
  const env = { ...process.env };
  for (const k of SCRUBBED_ENV) delete env[k];
  env.BONZI_USER_DATA = userDataDir;
  if (apiKey) env.OPENAI_API_KEY = apiKey;
  Object.assign(env, extraEnv);

  await mkdir(path.dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: 'a' });
  const args = [appDir, `--remote-debugging-port=${cdpPort}`, '--remote-allow-origins=*', ...extraArgs];
  log.write(`# ${new Date().toISOString()} launching electron ${args.map((a) => JSON.stringify(a)).join(' ')}\n`);
  const child = spawn(electronPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });

  const proc = {
    child,
    pid: child.pid,
    exited: false,
    exitCode: /** @type {number | null} */ (null),
    signal: /** @type {string | null} */ (null),
    exitedAt: 0,
    logPath,
    /** Resolves when the process exits. */
    exitPromise: /** @type {Promise<void>} */ (Promise.resolve()),
  };
  if (child.pid) {
    // Kills Electron if this runner is force-terminated before it can clean up.
    const dog = spawn(process.execPath, [WATCHDOG, String(process.pid), String(child.pid)], { detached: true, stdio: 'ignore', windowsHide: true });
    dog.unref();
  }
  child.stdout.on('data', (d) => log.write(d));
  child.stderr.on('data', (d) => log.write(d));
  proc.exitPromise = new Promise((resolve) => {
    const done = (code, signal) => {
      if (proc.exited) return;
      proc.exited = true;
      proc.exitCode = code;
      proc.signal = signal;
      proc.exitedAt = Date.now();
      log.write(`\n# process exited code=${code} signal=${signal}\n`);
      log.end();
      resolve();
    };
    child.on('exit', done);
    child.on('error', (err) => {
      log.write(`\n# spawn error: ${err.message}\n`);
      done(-1, null);
    });
  });
  return proc;
}

/** Waits until the process exits or the timeout elapses. Returns true if it exited. */
export async function waitForExit(proc, timeoutMs) {
  if (proc.exited) return true;
  let timer;
  const timeout = new Promise((r) => { timer = setTimeout(() => r(false), timeoutMs); });
  const res = await Promise.race([proc.exitPromise.then(() => true), timeout]);
  clearTimeout(timer);
  return res;
}

/** Kills the process and all of its children (Electron spawns GPU/renderer/utility processes). */
export async function killApp(proc) {
  if (!proc || proc.exited) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* not a group leader */ }
    try { proc.child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await waitForExit(proc, 5000);
}

/** Synchronous best-effort kill for process 'exit' handlers. */
export function killAppSync(proc) {
  if (!proc || proc.exited) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else try { proc.child.kill('SIGKILL'); } catch { /* ignore */ }
}
