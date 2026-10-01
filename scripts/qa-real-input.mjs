// Real-input QA (Windows): drives the actual OS mouse and keyboard against Bonzi
// with SendInput, the way a person would, and checks outcomes from Windows' side
// (window styles, menus, window position, main-thread latency) and, in dev mode,
// from the page over CDP. The CDP-based e2e suite cannot catch input bugs because
// DevTools input bypasses Windows; this can.
//
// It MOVES YOUR MOUSE and clicks Bonzi for about 45 seconds. Keep your hands off
// the mouse; before every click it verifies the pointer is where it put it and
// aborts instead of clicking anywhere unintended.
//   npm run qa:input                       (dev build, isolated profile)
//   node scripts/qa-real-input.mjs packaged <path-to-BonziBuddyReborn.exe>
//      (packaged: uses the app's real profile, OS-level checks only)
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchApp, prepareUserData, freePort, killApp } from './lib/e2e-app.mjs';
import { waitForTarget, CdpSession } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.scratch', 'qa-input');
const INPUT_PS1 = path.join(ROOT, 'scripts', 'lib', 'win-input.ps1');
fs.mkdirSync(OUT, { recursive: true });
const mode = process.argv[2] ?? 'dev';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ps(action, args = {}) {
  const a = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INPUT_PS1, '-Action', action];
  for (const [k, v] of Object.entries(args)) a.push(`-${k}`, String(v));
  const r = spawnSync('powershell.exe', a, { encoding: 'utf8' });
  const txt = (r.stdout || '').trim();
  try { return JSON.parse(txt || 'null'); } catch { return txt; }
}
function agentWindow(pid) {
  const list = [].concat(ps('windows', { MainPid: pid }) ?? []);
  for (const line of list) {
    const [hwnd, cls, title, ex, rect] = String(line).split('|');
    const [L, T, R, B] = rect.split(',').map(Number);
    const exStyle = parseInt(ex, 16);
    // Match by size: Windows drops WS_EX_LAYERED/TRANSPARENT while Bonzi is clickable.
    if (cls === 'Chrome_WidgetWin_1' && R - L >= 400 && B - T >= 700) return { hwnd, title, exStyle, L, T, R, B, clickThrough: (exStyle & 0x20) !== 0 };
  }
  return null;
}

// Moves the pointer and confirms it is really there (the user may be using the mouse).
// Throws instead of clicking anywhere unintended.
async function moveVerified(x, y) {
  for (let i = 0; i < 6; i++) {
    ps('move', { X: x, Y: y });
    await sleep(120);
    const p = ps('pos');
    if (p && Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1) return;
    await sleep(400);
  }
  throw new Error('the mouse is being moved by hand; aborting before any click');
}
let proc = null;
let mainPid = 0;
let page = null;
const startCursor = ps('pos');
try {
  if (mode === 'dev') {
    const ud = path.join(OUT, 'userdata-realinput');
    fs.rmSync(ud, { recursive: true, force: true });
    await prepareUserData(ud, { schemaVersion: 1, firstRunComplete: true, voiceMode: 'off', idleAnimations: false, soundEffects: false, baseUrl: 'http://127.0.0.1:9/v1', position: null });
    const port = await freePort();
    proc = await launchApp({ electronPath: path.join(ROOT, 'node_modules/electron/dist/electron.exe'), appDir: ROOT, cdpPort: port, userDataDir: ud, logPath: path.join(OUT, 'electron-realinput.log') });
    mainPid = proc.pid;
    const t = await waitForTarget(port, 'app://bonzi/agent/', { isAlive: () => !proc.exited });
    page = await CdpSession.connect(t.webSocketDebuggerUrl, { defaultTimeoutMs: 20000 });
    for (let i = 0; i < 100; i++) { try { if (String(await page.evaluate('location.href')).startsWith('app://bonzi/agent/')) break; } catch {} await sleep(200); }
    await page.evaluate(`new Promise(r => { const t = setInterval(() => { if (document.body.dataset.state === 'idle') { clearInterval(t); r(); } }, 150); })`, { timeoutMs: 40000 });
  } else {
    const exe = process.argv[3];
    const child = spawn(exe, [], { detached: false, stdio: 'ignore' });
    proc = { pid: child.pid, child, exited: false };
    child.on('exit', () => { proc.exited = true; });
    mainPid = child.pid;
    for (let i = 0; i < 60 && !agentWindow(mainPid); i++) await sleep(500);
    await sleep(7000); // Show animation + greeting
  }
  let w = agentWindow(mainPid);
  check('agent window found', !!w, w ? `${w.R - w.L}x${w.B - w.T} at ${w.L},${w.T}` : 'none');
  if (!w) throw new Error('no agent window');
  const bonzi = { x: w.L + 230, y: w.T + 300 + 100 };      // body centre
  const empty = { x: w.L + 20, y: w.T + 20 };              // transparent corner of the window
  const away = { x: w.L - 200, y: w.T + 300 };             // outside the window

  // 1. idle state: click-through
  await moveVerified(away.x, away.y); await sleep(400);
  check('click-through when the cursor is elsewhere', agentWindow(mainPid)?.clickThrough === true);

  // 2. hover Bonzi -> clickable
  await moveVerified(bonzi.x, bonzi.y); await sleep(400);
  check('clickable while hovering Bonzi', agentWindow(mainPid)?.clickThrough === false);

  // 3. hover a transparent part of the window -> click-through again
  await moveVerified(empty.x, empty.y); await sleep(400);
  check('click-through over empty window area', agentWindow(mainPid)?.clickThrough === true);

  // 4. main-thread responsiveness while hovering around Bonzi (also proves no flapping storm)
  const sweep = ps('sweep', { X: bonzi.x, Y: bonzi.y, MainPid: mainPid, Ms: 3000 });
  check('main process stays responsive while hovering', sweep && sweep.maxMs < 250, JSON.stringify(sweep));
  await moveVerified(bonzi.x, bonzi.y); await sleep(400);
  check('still clickable after 3 s of hovering (no flip-flop)', agentWindow(mainPid)?.clickThrough === false);

  // 5. left click opens the chat bar
  await moveVerified(bonzi.x, bonzi.y); await sleep(300);
  ps('click', { X: bonzi.x, Y: bonzi.y }); await sleep(900);
  if (page) {
    const open = await page.evaluate(`!document.querySelector('#chat-bar').hidden`);
    check('left click opens the chat bar', open === true);
    ps('escape'); await sleep(500);
    check('Esc closes the chat bar', (await page.evaluate(`document.querySelector('#chat-bar').hidden`)) === true);
  } else {
    check('left click accepted (window clickable at click time)', agentWindow(mainPid)?.clickThrough === false);
    ps('escape'); await sleep(400);
  }

  // 6. right click shows the native context menu
  // Electron draws menus as Chromium popup windows, so look for a new window of the app.
  const winCount = () => [].concat(ps('windows', { MainPid: mainPid }) ?? []).filter(Boolean).length;
  await moveVerified(bonzi.x, bonzi.y); await sleep(300);
  const beforeMenu = winCount();
  ps('rclick', { X: bonzi.x, Y: bonzi.y }); await sleep(900);
  const withMenu = winCount();
  check('right click opens the context menu', withMenu > beforeMenu, `${beforeMenu} -> ${withMenu} window(s)`);
  ps('escape'); await sleep(500);
  check('context menu closes with Esc', winCount() === beforeMenu);

  // 6b. tray icon right click (the tray is serviced by the same main thread).
  // The icon rect is looked up fresh before each attempt; the lookup itself can race the taskbar.
  async function trayPoint() {
    for (let i = 0; i < 6; i++) {
      const rows = [].concat(ps('tray', { MainPid: mainPid }) ?? []).filter(Boolean);
      for (const row of rows) {
        const [l, t, r, b] = String(row).split('|')[2].split(',').map(Number);
        if (r - l > 0 && b - t > 0) return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
      }
      await sleep(500);
    }
    return null;
  }
  let trayOk = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const tp = await trayPoint();
    if (!tp) { check(`tray icon located (attempt ${attempt})`, false); continue; }
    await moveVerified(tp.x, tp.y); await sleep(250);
    const n0 = winCount();
    ps('rclick', { X: tp.x, Y: tp.y });
    let opened = false;
    for (let i = 0; i < 20 && !opened; i++) { await sleep(100); opened = winCount() > n0; }
    if (opened) trayOk++;
    check(`tray right click #${attempt} opens the menu`, opened);
    ps('escape'); await sleep(600);
  }

  // 7. drag moves the window, then drag it back
  w = agentWindow(mainPid);
  const before = { L: w.L, T: w.T };
  await moveVerified(bonzi.x, bonzi.y); await sleep(300);
  ps('drag', { X: bonzi.x, Y: bonzi.y, X2: bonzi.x - 300, Y2: bonzi.y - 150 }); await sleep(800);
  const moved = agentWindow(mainPid);
  const dx = moved.L - before.L, dy = moved.T - before.T;
  check('drag moves Bonzi', Math.abs(dx + 300) <= 2 && Math.abs(dy + 150) <= 2, `moved by ${dx},${dy}`);
  await moveVerified(bonzi.x + dx, bonzi.y + dy); await sleep(300);
  ps('drag', { X: bonzi.x + dx, Y: bonzi.y + dy, X2: bonzi.x, Y2: bonzi.y }); // grab at his new position
  await sleep(800);
  const back = agentWindow(mainPid);
  check('drag back to the original spot', Math.abs(back.L - before.L) <= 2 && Math.abs(back.T - before.T) <= 2, `now at ${back.L},${back.T}`);
  if (page) {
    const st = await page.evaluate('document.body.dataset.state');
    check('no chat bar or stray state after drags', st === 'idle', `state=${st}`);
  }
} catch (err) {
  check('harness', false, String(err?.message ?? err));
} finally {
  if (startCursor?.x !== undefined) ps('move', { X: startCursor.x, Y: startCursor.y });
  if (mode === 'dev') await killApp(proc);
  else if (proc && !proc.exited) spawnSync('taskkill', ['/pid', String(mainPid), '/T', '/F'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(OUT, `realinput-${mode}.json`), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
