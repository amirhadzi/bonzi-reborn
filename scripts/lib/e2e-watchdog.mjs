// Detached watchdog: kills the Electron process tree if the E2E runner dies
// without cleaning up (for example when it is force-terminated).
// Usage: node e2e-watchdog.mjs <runnerPid> <electronPid>

import { spawnSync } from 'node:child_process';

const runnerPid = Number(process.argv[2]);
const appPid = Number(process.argv[3]);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

const timer = setInterval(() => {
  if (!alive(appPid)) {
    clearInterval(timer);
    return;
  }
  if (!alive(runnerPid)) {
    clearInterval(timer);
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(appPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else try { process.kill(appPid, 'SIGKILL'); } catch { /* gone */ }
  }
}, 1000);
