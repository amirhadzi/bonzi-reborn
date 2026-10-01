#!/usr/bin/env node
// End-to-end runner for BonziBuddy Reborn.
// Drives the real Electron app through the Chrome DevTools Protocol against the
// in-process mock OpenAI server, with an isolated userData dir per launch.
// See docs/TESTING.md.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CdpSession, listTargets, waitForTarget } from './lib/cdp.mjs';
import { freePort, killApp, killAppSync, launchApp, prepareUserData, waitForExit } from './lib/e2e-app.mjs';
import { balloonTextExpression, balloonTextMessage } from './lib/e2e-balloon.mjs';
import { pngStats } from './lib/e2e-png.mjs';
import { startMockServer } from './mock-openai.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_KEY = 'sk-test-local';
const BAD_KEY = 'sk-bad';
const AGENT_PREFIX = 'app://bonzi/agent/';
const SETTINGS_PREFIX = 'app://bonzi/settings/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Audio that really played: an audio engine, played to the end, with signal seen by the analyser. */
const AUDIBLE_RMS = 0.005;
const audible = (entries, engine = null) =>
  (entries ?? []).filter((e) => e.engine !== 'paced' && (!engine || e.engine === engine) && e.outcome === 'ended' && e.durationMs >= 200 && e.peakRms >= AUDIBLE_RMS);
const audioSummary = (entries) => (entries ?? []).map((e) => `${e.engine}/${e.outcome}/${e.durationMs}ms/rms${e.peakRms.toFixed(3)}`);

// ---------------------------------------------------------------------------
// CLI

const HELP = `Usage: node scripts/e2e.mjs [options]

  --scenario <name>   Run only matching scenarios (repeatable, or comma separated).
                      A name also selects its sub-scenarios (errors -> errors-auth).
  --list              List scenarios and exit.
  --no-build          Do not run scripts/build.mjs first.
  --app <dir>         Electron app directory to launch (default: repo root). Implies --no-build.
  --keep-open         Leave the last app instance and the mock running until Ctrl+C.
  --headed            Show the app windows normally (default; the app owns its windows).
  --audible           Do not pass --mute-audio to Electron.
  --tts-speed <n>     settings.ttsSpeed for test launches (default 2, shortens speech).
  --chunk-delay <a-b> Mock chat chunk delay range in ms (default 10-20).
  --settings <json>   Extra settings.json fields merged into every launch profile.
  -h, --help          Show this help.
`;

function parseJsonObject(text, what) {
  let v;
  try { v = JSON.parse(text); } catch (err) { throw new Error(`${what}: invalid JSON (${err.message})`); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what}: expected a JSON object`);
  return v;
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', multiple: true },
      list: { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
      app: { type: 'string' },
      'keep-open': { type: 'boolean', default: false },
      headed: { type: 'boolean', default: true },
      audible: { type: 'boolean', default: false },
      'tts-speed': { type: 'string', default: '2' },
      'chunk-delay': { type: 'string', default: '10-20' },
      settings: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  const [a, b] = values['chunk-delay'].split('-').map((n) => Number(n));
  return {
    scenarios: (values.scenario ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean),
    list: values.list,
    build: !values['no-build'] && !values.app,
    appDir: values.app ? path.resolve(values.app) : ROOT,
    customApp: Boolean(values.app),
    keepOpen: values['keep-open'],
    headed: values.headed,
    audible: values.audible,
    ttsSpeed: Math.min(4, Math.max(0.25, Number(values['tts-speed']) || 2)),
    settingsOverride: values.settings ? parseJsonObject(values.settings, '--settings') : {},
    chunkDelay: [Number.isFinite(a) ? a : 10, Number.isFinite(b) ? b : Number.isFinite(a) ? a : 20],
    help: values.help,
  };
}

// ---------------------------------------------------------------------------
// Launch profiles: each needs its own app process and fresh userData dir.

const PROFILES = {
  default: { apiKey: TEST_KEY, settings: { firstRunComplete: true } },
  'first-run': { apiKey: TEST_KEY, settings: { firstRunComplete: false } },
  'bad-key': { apiKey: BAD_KEY, settings: { firstRunComplete: true } },
  'no-key': { apiKey: null, settings: { firstRunComplete: true } },
  'first-run-no-key': { apiKey: null, settings: { firstRunComplete: false } },
  'voice-off': { apiKey: TEST_KEY, settings: { firstRunComplete: true, voiceMode: 'off' } },
};

function settingsFor(profile, mock, opts) {
  return {
    schemaVersion: 1,
    baseUrl: mock.baseURL,
    voiceMode: 'openai',
    ttsSpeed: opts.ttsSpeed,
    idleAnimations: true,
    idleChatter: false,
    launchAtLogin: false,
    // Do not grab the developer's global hotkey during a test run.
    hotkey: '',
    position: null,
    firstRunComplete: true,
    ...PROFILES[profile].settings,
    ...opts.settingsOverride,
  };
}

// ---------------------------------------------------------------------------
// Page-side snippets (run in the agent window main world via Runtime.evaluate)

const RECORDER = `(() => {
  if (window.__e2e) return true;
  const e2e = (window.__e2e = { states: [], balloon: [], frames: [] });
  const rec = () => {
    const s = document.body ? document.body.dataset.state ?? null : null;
    const last = e2e.states[e2e.states.length - 1];
    if (!last || last.state !== s) e2e.states.push({ state: s, at: Date.now() });
  };
  const bal = () => {
    const el = document.getElementById('balloon-text');
    const b = document.getElementById('balloon');
    const text = el ? (el.textContent || '').trim() : '';
    const visible = !!b && !b.hidden;
    const last = e2e.balloon[e2e.balloon.length - 1];
    if (text && (!last || last.text !== text || last.visible !== visible)) {
      e2e.balloon.push({ text: text.slice(0, 500), visible, at: Date.now() });
      if (e2e.balloon.length > 400) e2e.balloon.splice(0, 100);
    }
  };
  const start = () => {
    rec(); bal();
    new MutationObserver(rec).observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
    new MutationObserver(bal).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  return true;
})()`;

function pageCanvasInfo() {
  const c = document.getElementById('character');
  if (!(c instanceof HTMLCanvasElement)) return { exists: false };
  const stage = document.getElementById('stage');
  const r = c.getBoundingClientRect();
  let opaque = 0;
  let sampleError = null;
  try {
    const off = document.createElement('canvas');
    off.width = c.width;
    off.height = c.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, off.width, off.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 16) opaque++;
  } catch (err) {
    sampleError = String(err);
  }
  return {
    exists: true,
    inStage: !!stage && stage.contains(c),
    width: c.width,
    height: c.height,
    opaque,
    ratio: c.width * c.height ? opaque / (c.width * c.height) : 0,
    sampleError,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
  };
}

/** Finds an opaque point on Bonzi (CSS px, viewport-relative), spiralling out from the centre. */
function pageBonziPoint() {
  const c = document.getElementById('character');
  if (!(c instanceof HTMLCanvasElement)) return null;
  const r = c.getBoundingClientRect();
  const ch = window.__bonziDebug && window.__bonziDebug.character;
  let data = null;
  const sx = c.width / Math.max(1, r.width);
  const sy = c.height / Math.max(1, r.height);
  const test = (x, y) => {
    if (ch && typeof ch.hitTest === 'function') return ch.hitTest(x, y);
    if (!data) {
      const off = document.createElement('canvas');
      off.width = c.width;
      off.height = c.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0);
      data = ctx.getImageData(0, 0, c.width, c.height).data;
    }
    const px = Math.floor(x * sx), py = Math.floor(y * sy);
    return data[(py * c.width + px) * 4 + 3] > 128;
  };
  const cx = r.width / 2, cy = r.height / 2;
  const maxR = Math.max(r.width, r.height) / 2;
  for (let rad = 0; rad < maxR; rad += 4) {
    const steps = rad === 0 ? 1 : 24;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * rad, y = cy + Math.sin(a) * rad;
      if (x >= 0 && y >= 0 && x < r.width && y < r.height && test(x, y)) {
        return { x: Math.round(r.left + x), y: Math.round(r.top + y), via: ch && typeof ch.hitTest === 'function' ? 'hitTest' : 'pixels' };
      }
    }
  }
  return { x: Math.round(r.left + cx), y: Math.round(r.top + cy), via: 'centre' };
}

function pageUiSnapshot() {
  const vis = (id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  const bt = document.getElementById('balloon-text');
  const dbg = window.__bonziDebug;
  let lastError = null;
  try { lastError = dbg && dbg.lastError ? { kind: dbg.lastError.kind, message: dbg.lastError.message } : null; } catch { /* ignore */ }
  return {
    state: document.body ? document.body.dataset.state ?? null : null,
    balloonVisible: vis('balloon'),
    balloonText: bt ? (bt.textContent || '').trim() : '',
    chatBarVisible: vis('chat-bar'),
    speechLogLength: dbg && Array.isArray(dbg.speechLog) ? dbg.speechLog.length : -1,
    lastError,
  };
}

// ---------------------------------------------------------------------------
// Scenario context

class CheckFailed extends Error {}

function makeContext(env, result) {
  const { page, mock, runDir, launch, opts } = env;
  const t0 = Date.now();
  let shotIndex = 0;

  const ctx = {
    page, mock, runDir, launch, opts, t0,
    get app() { return launch.proc; },

    step(msg) {
      result.steps.push({ at: Date.now() - t0, msg });
      if (process.env.E2E_VERBOSE) console.log(`    . ${msg}`);
    },
    /** Hard assertion: records and throws on failure. */
    expect(name, ok, detail) {
      result.checks.push({ name, ok: Boolean(ok), soft: false, detail: detail === undefined ? undefined : detail });
      if (!ok) throw new CheckFailed(`${name}${detail !== undefined ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
    },
    /** Soft assertion: recorded as a warning, does not fail the scenario. */
    soft(name, ok, detail) {
      result.checks.push({ name, ok: Boolean(ok), soft: true, detail: detail === undefined ? undefined : detail });
      return Boolean(ok);
    },
    note(msg) { result.notes.push(msg); },

    async shot(label, session = page) {
      const file = `${result.prefix}-${String(++shotIndex).padStart(2, '0')}-${label}.png`;
      const full = path.join(runDir, file);
      try {
        const buf = await session.screenshot(full);
        let stats = null;
        try { stats = pngStats(buf); } catch (err) { stats = { error: err.message }; }
        result.screenshots.push({ file, label, stats });
        return { file: full, stats };
      } catch (err) {
        result.screenshots.push({ file: null, label, error: err.message });
        ctx.note(`screenshot ${label} failed: ${err.message}`);
        return null;
      }
    },

    ui: () => page.evaluate(pageUiSnapshot),
    state: () => page.evaluate('document.body ? document.body.dataset.state ?? null : null'),
    states: (since = t0) => page.evaluate(`(window.__e2e ? window.__e2e.states : []).filter((s) => s.at >= ${since})`),
    balloonHistory: (since = t0) => page.evaluate(`(window.__e2e ? window.__e2e.balloon : []).filter((s) => s.at >= ${since})`),
    speechLog: () => page.evaluate(`(() => { const d = window.__bonziDebug; return d && Array.isArray(d.speechLog) ? d.speechLog.map((x) => ({ text: String(x.text), gestures: Array.isArray(x.gestures) ? x.gestures.map(String) : [], at: x.at })) : null; })()`),
    lastErrorKind: () => page.evaluate(`(() => { const d = window.__bonziDebug; return d && d.lastError ? d.lastError.kind : null; })()`),
    /** __bonziDebug.audioLog: one entry per playback attempt ({ engine, outcome, durationMs, peakRms, chars, at }). */
    audioLog: (since = 0) => page.evaluate(`(() => { const d = window.__bonziDebug; return d && Array.isArray(d.audioLog) ? d.audioLog.filter((x) => x.at >= ${since}).map((x) => ({ engine: String(x.engine), outcome: String(x.outcome), durationMs: Number(x.durationMs), peakRms: Number(x.peakRms), chars: Number(x.chars), at: Number(x.at) })) : null; })()`),

    async waitState(states, timeoutMs, message) {
      const list = Array.isArray(states) ? states : [states];
      return page.waitFor(`(() => { const s = document.body && document.body.dataset.state; return ${JSON.stringify(list)}.includes(s) ? s : null; })()`, { timeoutMs, message: message ?? `state in ${list.join('|')}` });
    },
    async waitIdle(timeoutMs = 60_000) {
      return ctx.waitState('idle', timeoutMs, 'state idle');
    },
    /**
     * Waits for balloon text that is really on screen: not hidden and with the 'open'
     * class, so a balloon fading out with old text (Balloon.hide()) never matches.
     * With since (a Date.now() taken before the action) the text must also contain a
     * line the speech queue started at or after that time (__bonziDebug.speechLog).
     */
    async waitBalloonText(timeoutMs = 15_000, pattern = null, { since = null } = {}) {
      return page.waitFor(balloonTextExpression({ pattern, since }), { timeoutMs, message: balloonTextMessage({ pattern, since }) });
    },

    async mockRequests() {
      try {
        const res = await fetch(`${mock.url}/__mock/requests`, { signal: AbortSignal.timeout(3000) });
        return await res.json();
      } catch {
        return mock.requests.slice();
      }
    },
    async requestsSince(id0, filter = () => true) {
      return (await ctx.mockRequests()).filter((r) => r.id > id0 && filter(r));
    },
    async waitRequests(id0, filter, { count = 1, timeoutMs = 15_000, message } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const got = await ctx.requestsSince(id0, filter);
        if (got.length >= count) return got;
        if (Date.now() > deadline) throw new CheckFailed(`timed out waiting for ${message ?? 'mock requests'} (have ${got.length}, want ${count})`);
        await sleep(150);
      }
    },
    lastRequestId: () => (mock.requests.length ? mock.requests[mock.requests.length - 1].id : 0),

    async bonziPoint() {
      return page.evaluate(pageBonziPoint);
    },
    async openChat() {
      const visible = () => page.evaluate(`(() => { const e = document.getElementById('chat-bar'); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; })()`);
      if (await visible()) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        const pt = await ctx.bonziPoint();
        if (!pt) throw new CheckFailed('canvas#character not found, cannot click Bonzi');
        ctx.step(`click Bonzi at ${pt.x},${pt.y} (${pt.via})`);
        await page.click(pt.x, pt.y);
        try {
          await page.waitFor(`(() => { const e = document.getElementById('chat-bar'); return !!e && !e.hidden && getComputedStyle(e).display !== 'none'; })()`, { timeoutMs: 2500, message: 'chat bar visible' });
          return;
        } catch {
          await sleep(400);
        }
      }
      throw new CheckFailed('chat bar did not open after clicking Bonzi 3 times');
    },
    async sendMessage(text) {
      await ctx.openChat();
      const r = await page.evaluate(`(() => { const i = document.getElementById('chat-input'); if (!i) return null; const b = i.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!r) throw new CheckFailed('input#chat-input not found');
      await page.click(Math.round(r.x), Math.round(r.y));
      await page.evaluate(`(() => { const i = document.getElementById('chat-input'); if (document.activeElement !== i) i.focus(); i.select(); return document.activeElement === i; })()`);
      await page.type(text);
      const typed = await page.evaluate(`document.getElementById('chat-input').value`);
      ctx.expect('typed text reached input#chat-input', typed === text, { typed });
      ctx.step(`send "${text}"`);
      await page.press('Enter');
    },
  };
  return ctx;
}

const anyIncludes = (haystack, needle) => typeof haystack === 'string' && haystack.includes(needle);
const lastUserText = (r) => {
  const msgs = r.body && Array.isArray(r.body.messages) ? r.body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return typeof msgs[i].content === 'string' ? msgs[i].content : JSON.stringify(msgs[i].content);
  return '';
};
const isChat = (r) => r.method === 'POST' && r.path === '/v1/chat/completions';
const isTts = (r) => r.method === 'POST' && r.path === '/v1/audio/speech';
const noKeyIn = (r) => !anyIncludes(JSON.stringify(r.body ?? null), TEST_KEY) && !anyIncludes(JSON.stringify(r.headers ?? {}), TEST_KEY) && !anyIncludes(JSON.stringify(r.query ?? {}), TEST_KEY);

// ---------------------------------------------------------------------------
// Scenarios

const SCENARIOS = [
  {
    name: 'startup',
    profile: 'default',
    title: 'App starts, reaches idle within 20 s, character drawn',
    async run(ctx) {
      const budget = 20_000 - (Date.now() - ctx.launch.startedAt);
      const st = await ctx.waitState('idle', Math.max(1000, budget), 'state idle within 20 s of launch').catch((err) => err.message);
      ctx.expect('state reaches idle within 20 s', st === 'idle', { elapsedMs: Date.now() - ctx.launch.startedAt, state: st === 'idle' ? st : await ctx.state().catch(() => null), error: st === 'idle' ? undefined : st });
      const states = await ctx.states(0);
      ctx.soft('saw loading/showing before idle', states.some((s) => s.state === 'showing' || s.state === 'loading'), states.map((s) => s.state));
      const info = await ctx.page.evaluate(pageCanvasInfo);
      ctx.expect('canvas#character exists', info.exists);
      ctx.expect('canvas#character is inside div#stage', info.inStage);
      ctx.expect('canvas has non-transparent pixels', info.opaque > 100, { opaque: info.opaque, ratio: info.ratio, sampleError: info.sampleError });
      const dom = await ctx.page.evaluate(`(() => ({ balloon: !!document.getElementById('balloon'), balloonText: !!document.querySelector('#balloon #balloon-text'), chatBar: !!document.getElementById('chat-bar'), input: !!document.querySelector('#chat-bar #chat-input'), send: !!document.querySelector('#chat-bar #chat-send'), mic: !!document.querySelector('#chat-bar #chat-mic'), chatBarHidden: !!(document.getElementById('chat-bar') || {}).hidden }))()`);
      ctx.expect('DOM contract elements present', dom.balloon && dom.balloonText && dom.chatBar && dom.input && dom.send && dom.mic, dom);
      ctx.soft('chat bar hidden at startup', dom.chatBarHidden, dom);
      const appInfo = await ctx.page.evaluate('window.bonzi && window.bonzi.app.getInfo()').catch((e) => ({ error: e.message }));
      ctx.soft('AppInfo.isPackaged is false', appInfo && appInfo.isPackaged === false, appInfo);
      const dbg = await ctx.page.evaluate(`(() => { const d = window.__bonziDebug; if (!d) return null; return { character: !!d.character, getState: typeof d.getState, speechLog: Array.isArray(d.speechLog), playAnimation: typeof d.playAnimation, state: typeof d.getState === 'function' ? d.getState() : null }; })()`);
      ctx.expect('window.__bonziDebug exposed (not packaged)', dbg && dbg.character && dbg.getState === 'function' && dbg.speechLog && dbg.playAnimation === 'function', dbg);
      const s = await ctx.shot('idle');
      if (s && s.stats && !s.stats.error) ctx.soft('screenshot shows something (non-background pixels)', s.stats.differ > 100 || s.stats.opaque < s.stats.total, s.stats);
    },
  },
  {
    name: 'chat',
    profile: 'default',
    title: 'Typed chat: thinking, speaking with TTS, gestures, back to idle',
    async run(ctx) {
      await ctx.waitIdle(30_000);
      const id0 = ctx.lastRequestId();
      const logBefore = (await ctx.speechLog())?.length ?? 0;
      const tSend = Date.now();
      await ctx.sendMessage('Hello Bonzi, how are you today?');
      await ctx.waitState('speaking', 30_000);
      // The reply balloon opens only after the leading gesture and TTS (about 3 s after
      // the first delta); until then the interrupted greeting may still be fading out.
      const shown = await ctx.waitBalloonText(15_000, null, { since: tSend });
      const replyItems = ((await ctx.speechLog()) ?? []).filter((x) => x.at >= tSend && x.text);
      ctx.expect('mid-speech balloon shows the reply', replyItems.length > 0 && shown.length > 0, { shown: shown.slice(0, 120), reply: replyItems.map((x) => x.text.slice(0, 60)) });
      await sleep(600);
      await ctx.shot('mid-speech');
      const seq = (await ctx.states(tSend)).map((s) => s.state);
      const ti = seq.indexOf('thinking'), si = seq.indexOf('speaking');
      ctx.expect('state went thinking then speaking', ti >= 0 && si > ti, seq);

      const chats = await ctx.waitRequests(id0, isChat, { message: 'POST /v1/chat/completions' });
      const c = chats[0];
      ctx.expect('chat request has stream: true', c.body?.stream === true, { stream: c.body?.stream });
      ctx.expect('chat request has store: false', c.body?.store === false, { store: c.body?.store });
      ctx.expect('chat request carried Authorization', c.hasAuth === true);
      ctx.expect('API key not in chat request body/headers', chats.every(noKeyIn));
      ctx.soft('last user message is the typed text', lastUserText(c).includes('how are you today'), lastUserText(c).slice(0, 120));
      ctx.soft('system prompt present', Array.isArray(c.body?.messages) && c.body.messages[0]?.role === 'system');

      const tts = await ctx.waitRequests(id0, isTts, { message: 'POST /v1/audio/speech' });
      ctx.expect('TTS uses response_format wav', tts.every((r) => r.body?.response_format === 'wav'), tts.map((r) => r.body?.response_format));
      ctx.expect('API key not in TTS request bodies', tts.every(noKeyIn));
      ctx.expect('TTS input has no [[tags]]', tts.every((r) => !String(r.body?.input ?? '').includes('[[')), tts.map((r) => r.body?.input));

      await ctx.waitIdle(120_000);
      await ctx.shot('after');
      const log = (await ctx.speechLog()) ?? [];
      const items = log.slice(logBefore);
      ctx.expect('speechLog gained items', items.length > 0, { before: logBefore, after: log.length });
      const gestures = items.flatMap((x) => x.gestures);
      ctx.expect('speechLog has gestures such as Wave/Pleased', gestures.some((g) => /^(wave|pleased)$/i.test(g)), gestures);
      ctx.expect('no [[tags]] in spoken text', items.every((x) => !x.text.includes('[[')), items.map((x) => x.text));
      ctx.soft('spoken text echoes the message', items.map((x) => x.text).join(' ').toLowerCase().includes('how are you today'));
      const balloons = await ctx.balloonHistory(tSend);
      ctx.expect('no [[tags]] ever shown in the balloon', balloons.every((b) => !b.text.includes('[[')), balloons.filter((b) => b.text.includes('[[')).slice(0, 3));
      const ttsAll = await ctx.requestsSince(id0, isTts);
      ctx.soft('one TTS request per spoken item (approx.)', Math.abs(ttsAll.length - items.length) <= 1, { tts: ttsAll.length, items: items.length });
    },
  },
  {
    name: 'interruption',
    profile: 'default',
    title: 'A new message cancels the in-flight request (trigger slow)',
    async run(ctx) {
      await ctx.waitIdle(30_000);
      const id0 = ctx.lastRequestId();
      const logBefore = (await ctx.speechLog())?.length ?? 0;
      await ctx.sendMessage('Please wait for it, trigger slow');
      const [first] = await ctx.waitRequests(id0, (r) => isChat(r) && /trigger slow/i.test(lastUserText(r)), { message: 'slow chat request', timeoutMs: 10_000 });
      await sleep(300);
      await ctx.sendMessage('Now tell me about bananas');
      await ctx.waitRequests(id0, (r) => isChat(r) && /bananas/i.test(lastUserText(r)), { message: 'second chat request', timeoutMs: 10_000 });
      const deadline = Date.now() + 8000;
      let firstNow = null;
      while (Date.now() < deadline) {
        firstNow = (await ctx.mockRequests()).find((r) => r.id === first.id);
        if (firstNow && firstNow.completed !== undefined && firstNow.durationMs !== undefined) break;
        await sleep(150);
      }
      ctx.expect('first request was aborted by the client', firstNow && firstNow.completed === false, firstNow && { status: firstNow.status, completed: firstNow.completed, durationMs: firstNow.durationMs });
      await ctx.waitState('speaking', 30_000);
      await ctx.shot('second-answer');
      await ctx.waitIdle(120_000);
      const items = ((await ctx.speechLog()) ?? []).slice(logBefore);
      const text = items.map((x) => x.text).join(' ');
      ctx.expect('second message answered', /bananas/i.test(text), text.slice(0, 300));
      ctx.expect('first (cancelled) reply never spoken', !/trigger slow/i.test(text), text.slice(0, 300));
      const after = await ctx.requestsSince(id0, (r) => isChat(r) && /bananas/i.test(lastUserText(r)));
      ctx.expect('second request completed', after.some((r) => r.status === 200 && r.completed === true), after.map((r) => ({ status: r.status, completed: r.completed })));
    },
  },
  {
    name: 'errors',
    profile: 'default',
    title: 'Rate limit, quota and server errors become friendly balloons',
    async run(ctx) {
      const cases = [
        { phrase: 'Testing errors, trigger 429', kind: 'rate-limit', maxRequests: 2, label: 'rate-limit' },
        { phrase: 'Testing errors, trigger quota', kind: 'quota', maxRequests: 1, exact: true, label: 'quota' },
        { phrase: 'Testing errors, trigger 500', kind: 'server', maxRequests: 2, label: 'server' },
      ];
      for (const cs of cases) {
        await ctx.waitState(['idle'], 45_000);
        const id0 = ctx.lastRequestId();
        const tSend = Date.now();
        await ctx.sendMessage(cs.phrase);
        const kind = await ctx.page.waitFor(`(() => { const d = window.__bonziDebug; const k = d && d.lastError && d.lastError.kind; return k === ${JSON.stringify(cs.kind)} ? k : null; })()`, { timeoutMs: 25_000, message: `lastError.kind === ${cs.kind}` }).catch(() => null);
        const seen = kind ?? (await ctx.lastErrorKind());
        ctx.expect(`${cs.label}: lastError.kind === '${cs.kind}'`, seen === cs.kind, { got: seen });
        const text = await ctx.waitBalloonText(10_000).catch(() => null);
        const hist = await ctx.balloonHistory(tSend);
        const shown = text ?? hist.at(-1)?.text ?? '';
        ctx.expect(`${cs.label}: balloon shows a message`, shown.length > 0, hist.slice(-3));
        ctx.soft(`${cs.label}: balloon text is friendly (no raw JSON)`, !/[{}]|"error"|invalid_request_error/.test(shown), shown.slice(0, 200));
        await ctx.shot(cs.label);
        const reqs = await ctx.requestsSince(id0, isChat);
        if (cs.exact) ctx.expect(`${cs.label}: not retried`, reqs.length === 1, { requests: reqs.length });
        else ctx.soft(`${cs.label}: at most one automatic retry`, reqs.length >= 1 && reqs.length <= cs.maxRequests, { requests: reqs.length });
        ctx.expect(`${cs.label}: no API key in requests`, reqs.every(noKeyIn));
        await ctx.waitState(['idle'], 45_000).catch(() => ctx.note(`${cs.label}: did not return to idle within 45 s`));
      }
    },
  },
  {
    name: 'commands',
    profile: 'default',
    title: 'Debug playAnimation and (if reachable) the local time quick action',
    async run(ctx) {
      await ctx.waitIdle(30_000);
      await ctx.page.evaluate(`(() => { const d = window.__bonziDebug; window.__e2e.frames = []; if (window.__e2e.offFrame) window.__e2e.offFrame(); window.__e2e.offFrame = d.character.onFrame((f) => { if (window.__e2e.frames.length < 2000) window.__e2e.frames.push({ animation: f.animation, frame: f.frame, at: Date.now() }); }); return true; })()`);
      await ctx.page.evaluate(`(() => { const r = window.__bonziDebug.playAnimation('Wave'); return r && typeof r.then === 'function' ? r.then((x) => String(x)) : String(r); })()`, { awaitPromise: false });
      const anim = await ctx.page.waitFor(`(() => { const f = (window.__e2e.frames || []).find((x) => x.animation && /wave/i.test(x.animation)); return f ? f.animation : null; })()`, { timeoutMs: 8000, message: 'a WAVE frame drawn' }).catch(() => null);
      ctx.expect('playAnimation("Wave") draws WAVE frames', Boolean(anim), { seen: await ctx.page.evaluate(`[...new Set((window.__e2e.frames || []).map((f) => f.animation))]`) });
      await sleep(400);
      await ctx.shot('wave');
      const missing = await ctx.page.evaluate(`(async () => { try { const r = await window.__bonziDebug.playAnimation('NoSuchAnimationE2E'); return { ok: true, result: String(r) }; } catch (e) { return { ok: false, error: String(e) }; } })()`, { timeoutMs: 10_000 }).catch((e) => ({ ok: false, error: e.message }));
      ctx.soft('playAnimation of an unknown name does not throw', missing.ok, missing);
      await ctx.page.evaluate(`(() => { if (window.__e2e.offFrame) { window.__e2e.offFrame(); window.__e2e.offFrame = null; } return true; })()`);

      // Quick actions arrive from the main process (context menu / tray) as AppCommands.
      // They are only reachable from a test if the renderer exposes an optional debug hook.
      const hook = await ctx.page.evaluate(`(() => { const d = window.__bonziDebug; for (const k of ['runCommand', 'dispatchCommand', 'command', 'appCommand']) if (d && typeof d[k] === 'function') return k; return null; })()`);
      if (!hook) {
        ctx.note('quick action "time" skipped: AppCommands come from the main process (tray/context menu) and __bonziDebug exposes no command hook (optional: __bonziDebug.runCommand(cmd))');
        return;
      }
      await ctx.waitIdle(30_000);
      const id0 = ctx.lastRequestId();
      await ctx.page.evaluate(`(() => { window.__bonziDebug[${JSON.stringify(hook)}]({ type: 'quick-action', action: 'time' }); return true; })()`);
      const t = await ctx.waitBalloonText(10_000, '\\d{1,2}[:.]\\d{2}|o.clock|noon|midnight').catch(() => null);
      ctx.expect('time quick action shows the time', Boolean(t), t);
      await ctx.shot('time');
      const chats = await ctx.requestsSince(id0, isChat);
      ctx.expect('time quick action made no chat request', chats.length === 0, { chats: chats.length });
    },
  },
  {
    name: 'security',
    profile: 'default',
    title: 'Renderer isolation, CSP, preload surface, navigation lock',
    expectConsoleErrors: true,
    async run(ctx) {
      await ctx.waitIdle(30_000);
      const p = ctx.page;
      const id0 = ctx.lastRequestId();
      const g = await p.evaluate(`({ require: typeof require, process: typeof process, nodeVersion: typeof process !== 'undefined' && process.versions ? process.versions.node ?? null : null, module: typeof module, Buffer: typeof Buffer, bonziSettings: typeof window.bonziSettings })`);
      ctx.expect('require is undefined', g.require === 'undefined', g);
      ctx.expect('process is undefined (or has no node version)', g.process === 'undefined' || g.nodeVersion === null, g);
      ctx.expect('no Node globals (module, Buffer)', g.module === 'undefined' && g.Buffer === 'undefined', g);
      ctx.soft('window.bonziSettings not exposed in the agent window', g.bonziSettings === 'undefined', g);

      // Probes use the reserved .invalid TLD so nothing can leave the machine even if a guard is missing.
      const probeFetch = (url, match) => p.evaluate(`new Promise((resolve) => {
        let violated = null;
        const onV = (e) => { if (e.blockedURI && e.blockedURI.includes(${JSON.stringify(match)})) violated = e.effectiveDirective || e.violatedDirective; };
        document.addEventListener('securitypolicyviolation', onV);
        fetch(${JSON.stringify(url)}, { cache: 'no-store' }).then(() => 'resolved', (e) => 'rejected: ' + e).then((result) => setTimeout(() => {
          document.removeEventListener('securitypolicyviolation', onV);
          resolve({ result, violated });
        }, 150));
      })`, { timeoutMs: 15_000 }).catch((e) => ({ result: `evaluate error: ${e.message}`, violated: null }));
      const ext = await probeFetch('https://example.invalid/', 'example.invalid');
      ctx.expect('external fetch is rejected', String(ext.result).startsWith('rejected'), ext);
      ctx.expect('external fetch blocked by CSP connect-src', /connect-src/.test(String(ext.violated)), ext);
      const toMock = await probeFetch(`${ctx.mock.baseURL}/models`, '127.0.0.1');
      ctx.expect('renderer cannot reach the AI base URL directly', String(toMock.result).startsWith('rejected'), toMock);
      ctx.soft('AI base URL fetch blocked by CSP connect-src', /connect-src/.test(String(toMock.violated)), toMock);
      const evalRes = await p.evaluate(`(() => { try { return 'allowed: ' + eval('1 + 1'); } catch (e) { return 'blocked: ' + e.name; } })()`, { allowUnsafeEval: false }).catch((e) => `blocked: ${e.message}`);
      ctx.expect('eval() blocked by CSP', String(evalRes).startsWith('blocked'), evalRes);
      const meta = await p.evaluate(`(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy" i]'); return m ? m.getAttribute('content') : null; })()`);
      ctx.soft('CSP meta tag present', Boolean(meta) && /default-src 'none'/.test(meta), meta);

      const surface = await p.evaluate(`(() => {
        const b = window.bonzi;
        if (!b) return null;
        const keys = (o) => Object.keys(o).sort();
        const found = [];
        const walk = (o, pfx, depth) => {
          if (!o || typeof o !== 'object' || depth > 4) return;
          for (const k of Object.keys(o)) {
            if (/ipc|electron|require|remote|process/i.test(k)) found.push(pfx + k);
            walk(o[k], pfx + k + '.', depth + 1);
          }
        };
        walk(b, '', 0);
        const shape = {};
        for (const k of keys(b)) shape[k] = typeof b[k] === 'function' ? 'function' : keys(b[k]);
        return { top: keys(b), shape, suspicious: found };
      })()`);
      const expected = {
        app: ['getIdleState', 'getInfo', 'onCommand', 'openSettings', 'quit'],
        chat: ['cancel', 'onEvent', 'reset', 'send'],
        loadCharacter: 'function',
        settings: ['get', 'onChanged'],
        stt: ['transcribe'],
        tts: ['synthesize'],
        window: ['dragEnd', 'dragStart', 'focus', 'hidden', 'ready', 'releaseFocus', 'setIgnoreMouseEvents', 'showContextMenu'],
      };
      ctx.expect('window.bonzi exists', Boolean(surface));
      ctx.expect('window.bonzi has exactly the documented keys', JSON.stringify(surface.top) === JSON.stringify(Object.keys(expected).sort()), surface.top);
      ctx.expect('window.bonzi nested API matches the contract', JSON.stringify(surface.shape) === JSON.stringify(expected), surface.shape);
      ctx.expect('no ipcRenderer / electron / process exposed', surface.suspicious.length === 0, surface.suspicious);

      const before = await listTargets(ctx.launch.cdpPort);
      const opened = await p.evaluate(`(() => { try { const w = window.open('https://example.invalid/', '_blank'); return w === null ? 'null' : 'window'; } catch (e) { return 'threw: ' + e; } })()`);
      await sleep(1000);
      const afterOpen = await listTargets(ctx.launch.cdpPort);
      const newTargets = afterOpen.filter((t) => t.type === 'page' && !before.some((b) => b.id === t.id));
      ctx.expect('window.open is denied', newTargets.length === 0, { opened, newTargets: newTargets.map((t) => t.url) });

      const href0 = await p.evaluate('location.href');
      await p.evaluate(`setTimeout(() => { location.href = 'https://example.invalid/'; }, 0), true`);
      await sleep(2000);
      const href1 = await p.evaluate('location.href').catch((e) => `evaluate error: ${e.message}`);
      ctx.expect('navigation away from app://bonzi is blocked', typeof href1 === 'string' && href1.startsWith(AGENT_PREFIX), { before: href0, after: href1 });
      const targets = await listTargets(ctx.launch.cdpPort);
      ctx.expect('agent target still on app://bonzi/agent/', targets.some((t) => t.url.startsWith(AGENT_PREFIX)), targets.map((t) => t.url));

      const st = await ctx.state();
      ctx.soft('app still responsive after probes', typeof st === 'string', st);
      const reqs = await ctx.requestsSince(id0);
      ctx.expect('no renderer request reached the mock', reqs.length === 0, reqs.map((r) => `${r.method} ${r.path}`));
    },
  },
  {
    name: 'exit',
    profile: 'default',
    title: 'window.bonzi.app.quit() exits the process within 8 s',
    async run(ctx) {
      await ctx.waitIdle(30_000).catch(() => ctx.note('was not idle before quitting'));
      const t = Date.now();
      await ctx.page.evaluate('window.bonzi.app.quit(), true', { timeoutMs: 3000 }).catch(() => { /* the page may already be gone */ });
      const exited = await waitForExit(ctx.app, 8000);
      ctx.expect('process exited within 8 s', exited, { waitedMs: Date.now() - t });
      ctx.soft('exit code 0', ctx.app.exitCode === 0, { code: ctx.app.exitCode, signal: ctx.app.signal });
      ctx.launch.quitByScenario = true;
    },
  },
  {
    name: 'first-run',
    profile: 'first-run',
    title: 'First run: local intro in the balloon, no chat API call',
    async run(ctx) {
      const text = await ctx.waitBalloonText(30_000);
      ctx.expect('intro text appears in the balloon', text.length > 0, text.slice(0, 200));
      await sleep(800);
      await ctx.shot('intro');
      await ctx.waitIdle(120_000).catch(() => ctx.note('did not reach idle within 120 s after the intro'));
      const hist = await ctx.balloonHistory(0);
      ctx.soft('intro mentions Bonzi', hist.some((h) => /bonzi/i.test(h.text)), hist.slice(-2).map((h) => h.text));
      const chats = await ctx.requestsSince(ctx.launch.firstRequestId, isChat);
      ctx.expect('intro made no chat API call', chats.length === 0, { chats: chats.length });
      const tts = await ctx.requestsSince(ctx.launch.firstRequestId, isTts);
      ctx.soft('intro spoken with TTS (voiceMode openai, env key)', tts.length > 0, { tts: tts.length });
      const log = await ctx.audioLog();
      ctx.expect('__bonziDebug.audioLog exposed', Array.isArray(log));
      ctx.expect('intro PLAYED audio (OpenAI voice, analyser saw signal)', audible(log, 'openai').length > 0, audioSummary(log));
      await sleep(500);
      let persisted = null;
      try { persisted = JSON.parse(await readFile(path.join(ctx.launch.userDataDir, 'settings.json'), 'utf8')).firstRunComplete; } catch { /* missing */ }
      ctx.soft('settings.json firstRunComplete is now true', persisted === true, { firstRunComplete: persisted });
      const settingsTarget = (await listTargets(ctx.launch.cdpPort)).some((t) => t.url.startsWith(SETTINGS_PREFIX));
      ctx.soft('settings window not opened (env key is configured)', !settingsTarget);
    },
  },
  {
    name: 'errors-auth',
    profile: 'bad-key',
    title: 'Invalid key (OPENAI_API_KEY=sk-bad) gives an auth error balloon',
    async run(ctx) {
      await ctx.waitIdle(30_000);
      const id0 = ctx.lastRequestId();
      await ctx.sendMessage('Hello there Bonzi');
      const kind = await ctx.page.waitFor(`(() => { const d = window.__bonziDebug; return d && d.lastError && d.lastError.kind === 'auth' ? 'auth' : null; })()`, { timeoutMs: 20_000, message: "lastError.kind === 'auth'" }).catch(() => null);
      ctx.expect("lastError.kind === 'auth'", kind === 'auth', { got: await ctx.lastErrorKind() });
      const text = await ctx.waitBalloonText(10_000).catch(() => null);
      ctx.expect('balloon explains the key problem', Boolean(text), text);
      await ctx.shot('auth');
      const tAuth = Date.now() - 1000;
      await ctx.waitIdle(60_000).catch(() => ctx.note('did not reach idle after the auth line'));
      const authAudio = await ctx.audioLog(tAuth);
      ctx.expect('auth error line PLAYED audio with the Windows voice', audible(authAudio, 'system').length > 0, audioSummary(authAudio));
      const reqs = await ctx.requestsSince(id0, isChat);
      ctx.soft('auth error not retried', reqs.length === 1, { requests: reqs.length });
      ctx.expect('bad key never in request bodies', reqs.every((r) => !JSON.stringify(r.body ?? null).includes(BAD_KEY)));
    },
  },
  {
    name: 'no-key',
    profile: 'no-key',
    title: 'No key: local explanation (spoken with the Windows voice) and the settings window opens',
    async run(ctx) {
      await ctx.waitIdle(30_000);
      // The greeting has no OpenAI voice without a key, so it must have played with the Windows voice.
      await ctx.page.waitFor(`(() => { const d = window.__bonziDebug; return d && d.audioLog && d.audioLog.length > 0 ? true : null; })()`, { timeoutMs: 30_000, message: 'greeting audio logged' }).catch(() => null);
      const greet = await ctx.audioLog();
      ctx.expect('greeting PLAYED audio with the Windows voice', audible(greet, 'system').length > 0, audioSummary(greet));
      const tLine = Date.now();
      const id0 = ctx.lastRequestId();
      await ctx.sendMessage('Hello Bonzi, are you there?');
      const text = await ctx.waitBalloonText(15_000, null, { since: tLine });
      ctx.expect('balloon shows the local no-key line', text.length > 0, text.slice(0, 200));
      await sleep(500);
      await ctx.shot('no-key');
      const kind = await ctx.lastErrorKind();
      ctx.soft("lastError.kind === 'no-key'", kind === 'no-key', { got: kind });
      let target = null;
      try {
        target = await waitForTarget(ctx.launch.cdpPort, SETTINGS_PREFIX, { timeoutMs: 10_000, isAlive: () => !ctx.app.exited });
      } catch (err) {
        ctx.expect('settings window opened', false, err.message);
      }
      ctx.expect('settings window opened', Boolean(target));
      const sp = await CdpSession.connect(target.webSocketDebuggerUrl, { label: 'settings' });
      try {
        await sp.send('Page.enable');
        await sp.waitFor(`document.readyState === 'complete' && document.body && document.body.innerText.trim().length > 0`, { timeoutMs: 10_000, message: 'settings page rendered' });
        await sleep(500);
        await ctx.shot('settings-window', sp);
        const s = await sp.evaluate(`({ bonziSettings: typeof window.bonziSettings, bonzi: typeof window.bonzi, require: typeof require, title: document.title })`);
        ctx.expect('settings window exposes window.bonziSettings', s.bonziSettings === 'object', s);
        ctx.soft('settings window does not expose window.bonzi', s.bonzi === 'undefined', s);
        ctx.expect('settings window has no require', s.require === 'undefined', s);
        const ai = await sp.evaluate(`/\\bAI\\b/.test(document.body.innerText)`);
        ctx.soft('settings window states that Bonzi is an AI / AI voice', ai);
      } finally {
        await sp.close();
      }
      await ctx.waitIdle(60_000).catch(() => ctx.note('did not reach idle after the no-key line'));
      const lineAudio = await ctx.audioLog(tLine);
      ctx.expect('no-key line PLAYED audio with the Windows voice', audible(lineAudio, 'system').length > 0, audioSummary(lineAudio));
      const reqs = await ctx.requestsSince(id0, (r) => r.path.startsWith('/v1/chat') || r.path.startsWith('/v1/audio'));
      ctx.expect('no AI requests without a key', reqs.length === 0, reqs.map((r) => `${r.method} ${r.path}`));
    },
  },
  {
    name: 'first-run-no-key',
    profile: 'first-run-no-key',
    title: 'First run without a key: the intro is spoken aloud with the Windows voice',
    async run(ctx) {
      const text = await ctx.waitBalloonText(30_000);
      ctx.expect('intro text appears in the balloon', text.length > 0, text.slice(0, 200));
      await sleep(800);
      await ctx.shot('intro');
      await ctx.waitIdle(120_000).catch(() => ctx.note('did not reach idle within 120 s after the intro'));
      const log = await ctx.audioLog();
      const played = audible(log, 'system');
      ctx.expect('intro PLAYED audio with the Windows voice', played.length > 0, audioSummary(log));
      ctx.soft('every intro line was audible', (log ?? []).every((e) => e.engine === 'system' && e.outcome === 'ended'), audioSummary(log));
      const hist = await ctx.balloonHistory(0);
      ctx.soft('intro mentions the API key', hist.some((h) => /key/i.test(h.text)), hist.slice(-2).map((h) => h.text));
      const reqs = await ctx.requestsSince(ctx.launch.firstRequestId, (r) => r.path.startsWith('/v1/'));
      ctx.expect('no AI requests without a key', reqs.length === 0, reqs.map((r) => `${r.method} ${r.path}`));
      const target = await waitForTarget(ctx.launch.cdpPort, SETTINGS_PREFIX, { timeoutMs: 15_000, isAlive: () => !ctx.app.exited }).catch(() => null);
      ctx.soft('settings window opens on a first run without a key', Boolean(target));
    },
  },
  {
    name: 'voice-off',
    profile: 'voice-off',
    title: "voiceMode 'off': balloon text, no TTS requests",
    async run(ctx) {
      await ctx.waitIdle(30_000);
      const id0 = ctx.lastRequestId();
      const logBefore = (await ctx.speechLog())?.length ?? 0;
      const tSend = Date.now();
      await ctx.sendMessage('Hello Bonzi, quiet mode please');
      await ctx.waitRequests(id0, isChat, { message: 'chat request' });
      const text = await ctx.waitBalloonText(30_000, null, { since: tSend });
      ctx.expect('balloon shows the reply', text.length > 0, text.slice(0, 200));
      await sleep(800);
      await ctx.shot('balloon');
      await ctx.waitIdle(120_000);
      const tts = await ctx.requestsSince(ctx.launch.firstRequestId, isTts);
      ctx.expect('no /v1/audio/speech requests', tts.length === 0, { tts: tts.length });
      const items = ((await ctx.speechLog()) ?? []).slice(logBefore);
      ctx.soft('speechLog still records items', items.length > 0, { items: items.length });
      const log = await ctx.audioLog();
      ctx.expect('__bonziDebug.audioLog exposed', Array.isArray(log));
      ctx.expect('voice off: no audio engine was used', (log ?? []).every((e) => e.engine === 'paced'), audioSummary(log));
      ctx.soft('voice off: paced text was logged', (log ?? []).length > 0, audioSummary(log));
    },
  },
];

// ---------------------------------------------------------------------------
// Runner

async function nextRunDir() {
  const base = path.join(ROOT, '.scratch', 'e2e');
  await mkdir(base, { recursive: true });
  const nums = (await readdir(base)).map((n) => /^run-(\d+)$/.exec(n)).filter(Boolean).map((m) => Number(m[1]));
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  const dir = path.join(base, `run-${n}`);
  await mkdir(dir, { recursive: true });
  return { n, dir };
}

function electronBinary() {
  if (process.platform === 'win32') return path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const rel = readFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  return path.join(ROOT, 'node_modules', 'electron', 'dist', rel);
}

function selectScenarios(filters) {
  if (!filters.length) return SCENARIOS;
  const picked = SCENARIOS.filter((s) => filters.some((f) => s.name === f || s.name.startsWith(`${f}-`)));
  const unknown = filters.filter((f) => !SCENARIOS.some((s) => s.name === f || s.name.startsWith(`${f}-`)));
  if (unknown.length) throw new Error(`unknown scenario(s): ${unknown.join(', ')} (use --list)`);
  return picked;
}

/** Scans text files under dir (and extra files) for any of the secrets. */
async function scanForSecrets(paths, secrets) {
  const hits = [];
  const visit = async (p, depth) => {
    let st;
    try { st = await stat(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > 6) return;
      for (const n of await readdir(p).catch(() => [])) await visit(path.join(p, n), depth + 1);
      return;
    }
    if (st.size > 4 * 1024 * 1024) return;
    const buf = await readFile(p).catch(() => null);
    if (!buf) return;
    for (const s of secrets) {
      if (buf.includes(Buffer.from(s, 'utf8')) || buf.includes(Buffer.from(s, 'utf16le'))) hits.push({ file: p, secret: `${s.slice(0, 5)}...` });
    }
  };
  for (const p of paths) await visit(p, 0);
  return hits;
}

async function main() {
  const opts = parseCli();
  if (opts.help) { process.stdout.write(HELP); return 0; }
  if (opts.list) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(14)} [${s.profile}] ${s.title}`);
    return 0;
  }
  const selected = selectScenarios(opts.scenarios);
  const electronPath = electronBinary();
  if (!existsSync(electronPath)) throw new Error(`Electron binary not found at ${electronPath} (run "npx electron --version" once)`);

  if (opts.build) {
    if (!existsSync(path.join(ROOT, 'scripts', 'build.mjs'))) throw new Error('scripts/build.mjs not found; build first or pass --no-build');
    console.log('Building (node scripts/build.mjs) ...');
    const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], { cwd: ROOT, stdio: 'inherit' });
    if (b.status !== 0) throw new Error(`build failed with exit code ${b.status}`);
  }
  if (!opts.customApp) {
    for (const f of ['dist/main/main.cjs', 'dist/preload/agent.cjs', 'dist/renderer/agent/index.html']) {
      if (!existsSync(path.join(ROOT, f))) throw new Error(`${f} is missing; run "npm run build" (or drop --no-build)`);
    }
  }

  const { n, dir: runDir } = await nextRunDir();
  const mockLog = path.join(runDir, 'mock.log');
  const mock = await startMockServer({ port: 0, log: (line) => { appendFile(mockLog, `${line}\n`).catch(() => {}); }, chunkDelayMs: opts.chunkDelay });

  const summary = {
    run: n,
    runDir,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    appDir: opts.appDir,
    mockBaseURL: mock.baseURL,
    options: { scenarios: opts.scenarios, settingsOverride: opts.settingsOverride, keepOpen: opts.keepOpen, audible: opts.audible, ttsSpeed: opts.ttsSpeed, chunkDelay: opts.chunkDelay },
    results: [],
    launches: [],
    global: [],
    ok: false,
  };

  /** @type {Set<any>} */
  const liveLaunches = new Set();
  let cleaning = null;
  const cleanup = async () => {
    if (cleaning) return cleaning;
    cleaning = (async () => {
      for (const l of liveLaunches) {
        await l.page?.close().catch(() => {});
        await killApp(l.proc).catch(() => {});
      }
      liveLaunches.clear();
      await mock.close().catch(() => {});
    })();
    return cleaning;
  };
  const onSignal = (sig) => {
    console.log(`\n${sig} received, cleaning up ...`);
    cleanup().finally(() => process.exit(130));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', () => { for (const l of liveLaunches) killAppSync(l.proc); });

  try {
    return await runAll();
  } finally {
    await cleanup();
  }

  async function runAll() {
    console.log(`E2E run ${n}: ${runDir}`);
    console.log(`Mock OpenAI: ${mock.baseURL}`);

    let launchCount = 0;
    const launchProfile = async (profile) => {
      const idx = ++launchCount;
      const ldir = path.join(runDir, `${String(idx).padStart(2, '0')}-${profile}`);
      const userDataDir = path.join(ldir, 'userdata');
      await prepareUserData(userDataDir, settingsFor(profile, mock, opts));
      const cdpPort = await freePort();
      const apiKey = PROFILES[profile].apiKey;
      const launch = {
        profile, dir: ldir, userDataDir, cdpPort, apiKey, startedAt: Date.now(), firstRequestId: mock.requests.length ? mock.requests[mock.requests.length - 1].id : 0,
        proc: null, page: null, quitByScenario: false, error: null,
      };
      launch.proc = await launchApp({
        electronPath, appDir: opts.appDir, cdpPort, userDataDir, apiKey, logPath: path.join(ldir, 'electron.log'),
        extraArgs: opts.audible ? [] : ['--mute-audio'],
      });
      liveLaunches.add(launch);
      console.log(`  launched [${profile}] pid ${launch.proc.pid}, CDP port ${cdpPort}`);
      const target = await waitForTarget(cdpPort, AGENT_PREFIX, { timeoutMs: 30_000, isAlive: () => !launch.proc.exited });
      launch.page = await CdpSession.connect(target.webSocketDebuggerUrl, { label: `agent:${profile}` });
      await launch.page.enableErrorCollection();
      await launch.page.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER }).catch(() => {});
      await launch.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      // The target can still be on its initial about:blank document here; wait for the real page
      // so the recorder is not installed into a document that is about to be replaced.
      const realPage = `location.href.startsWith(${JSON.stringify(AGENT_PREFIX)}) && !!document.body`;
      await launch.page.waitFor(realPage, { timeoutMs: 15_000, message: 'agent document.body' });
      await launch.page.waitFor(`(${realPage}) ? (${RECORDER}) && !!window.__e2e : false`, { timeoutMs: 15_000, message: 'state recorder installed' });
      return launch;
    };

    const finishLaunch = async (launch, { keep = false } = {}) => {
      if (!launch) return;
      if (!keep) {
        await launch.page?.close().catch(() => {});
        await killApp(launch.proc);
        liveLaunches.delete(launch);
      }
      const secrets = [TEST_KEY, BAD_KEY].filter((s) => s === launch.apiKey);
      const hits = keep ? [] : await scanForSecrets([path.join(launch.dir, 'electron.log'), launch.userDataDir], secrets);
      const rec = {
        profile: launch.profile, dir: launch.dir, pid: launch.proc?.pid, cdpPort: launch.cdpPort,
        exitCode: launch.proc?.exitCode ?? null, quitByScenario: launch.quitByScenario, error: launch.error,
        pageErrors: launch.page ? launch.page.errors.slice(0, 50) : [], keyLeaks: hits,
      };
      summary.launches.push(rec);
      if (hits.length) summary.global.push({ name: `key-leak (${launch.profile})`, ok: false, detail: hits });
    };

    let current = null;
    for (let i = 0; i < selected.length; i++) {
      const sc = selected[i];
      const result = { name: sc.name, profile: sc.profile, title: sc.title, status: 'fail', durationMs: 0, checks: [], notes: [], screenshots: [], steps: [], pageErrors: [], error: null, prefix: `${String(i + 1).padStart(2, '0')}-${sc.name}` };
      summary.results.push(result);
      const t0 = Date.now();
      process.stdout.write(`  ${sc.name.padEnd(14)} ... `);
      try {
        if (current && (current.profile !== sc.profile || current.proc.exited)) {
          if (current.proc.exited && !current.quitByScenario && current.profile === sc.profile) result.notes.push('app had exited; relaunched');
          await finishLaunch(current);
          current = null;
        }
        if (!current) current = await launchProfile(sc.profile);
        const ctx = makeContext({ page: current.page, mock, runDir, launch: current, opts }, result);
        await sc.run(ctx);
        const errs = current.page.errorsSince(t0);
        result.pageErrors = errs.slice(0, 30);
        const exceptions = errs.filter((e) => e.source === 'exception');
        if (exceptions.length) ctx.expect('no uncaught page exceptions', false, exceptions.slice(0, 5).map((e) => e.text));
        if (!sc.expectConsoleErrors) ctx.soft('no console/log errors', errs.length === 0, errs.slice(0, 5).map((e) => `${e.source}: ${e.text}`));
        result.status = 'pass';
      } catch (err) {
        result.status = 'fail';
        result.error = err instanceof CheckFailed ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
        if (current?.page) result.pageErrors = current.page.errorsSince(t0).slice(0, 30);
        if (current?.page && !current.page.closed && !current.proc.exited) {
          try {
            const file = `${result.prefix}-failure.png`;
            await current.page.screenshot(path.join(runDir, file), { timeoutMs: 5000 });
            result.screenshots.push({ file, label: 'failure' });
          } catch (shotErr) {
            result.notes.push(`failure screenshot not taken: ${shotErr.message}`);
          }
          result.uiAtFailure = await current.page.evaluate(pageUiSnapshot, { timeoutMs: 3000 }).catch(() => null);
        }
        if (current && !current.page) current.error = result.error;
        if (current && current.proc?.exited) current.error = current.error ?? `app exited (code ${current.proc.exitCode})`;
      } finally {
        result.durationMs = Date.now() - t0;
        const warn = result.checks.filter((c) => c.soft && !c.ok).length;
        console.log(`${result.status.toUpperCase()} (${(result.durationMs / 1000).toFixed(1)} s)${warn ? `, ${warn} warning(s)` : ''}${result.error ? `\n      ${result.error}` : ''}`);
      }
    }

    const keepLast = opts.keepOpen && current && !current.proc.exited;
    await finishLaunch(current, { keep: keepLast });

    // Global checks on everything the mock saw.
    const all = mock.requests.slice();
    const allowed = new Set(['/v1/chat/completions', '/v1/audio/speech', '/v1/audio/transcriptions', '/v1/models']);
    const unexpected = all.filter((r) => !allowed.has(r.path) && !r.path.startsWith('/v1/models/'));
    summary.global.push({ name: 'mock saw only known endpoints', ok: unexpected.length === 0, detail: unexpected.map((r) => `${r.method} ${r.path}`) });
    const leaked = all.filter((r) => !noKeyIn(r) || JSON.stringify(r.body ?? null).includes(BAD_KEY));
    summary.global.push({ name: 'API key never in request bodies/headers', ok: leaked.length === 0, detail: leaked.map((r) => r.id) });
    const unauth = all.filter((r) => r.path.startsWith('/v1/') && !r.hasAuth);
    summary.global.push({ name: 'every /v1 request carried Authorization', ok: unauth.length === 0, detail: unauth.map((r) => `${r.method} ${r.path}`) });
    summary.mockRequests = all.map((r) => ({ id: r.id, method: r.method, path: r.path, status: r.status, completed: r.completed, durationMs: r.durationMs, trigger: isChat(r) ? (/trigger \w+/i.exec(lastUserText(r))?.[0] ?? null) : null }));

    summary.finishedAt = new Date().toISOString();
    summary.ok = summary.results.every((r) => r.status === 'pass') && summary.global.every((g) => g.ok);
    await writeFile(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

    printTable(summary);
    console.log(`\nSummary: ${path.join(runDir, 'summary.json')}`);

    if (keepLast) {
      console.log(`\n--keep-open: app [${current.profile}] pid ${current.proc.pid} still running; CDP http://127.0.0.1:${current.cdpPort}/json/list ; mock ${mock.baseURL}`);
      console.log('Press Ctrl+C to stop.');
      await new Promise((resolve) => {
        current.proc.exitPromise.then(resolve);
      });
    }
    return summary.ok ? 0 : 1;
  }
}

function printTable(summary) {
  const rows = summary.results.map((r) => {
    const failed = r.checks.filter((c) => !c.ok && !c.soft).length;
    const warns = r.checks.filter((c) => !c.ok && c.soft).map((c) => c.name);
    const detail = r.error ?? (warns.length ? `warn: ${warns.join('; ')}` : r.notes[0] ?? '');
    return [r.name, r.profile, r.status.toUpperCase(), `${(r.durationMs / 1000).toFixed(1)}s`, `${r.checks.length - failed - warns.length}/${r.checks.length}`, String(r.screenshots.length), detail];
  });
  for (const g of summary.global) rows.push([g.name, '(global)', g.ok ? 'PASS' : 'FAIL', '', '', '', g.ok ? '' : JSON.stringify(g.detail).slice(0, 160)]);
  const head = ['scenario', 'profile', 'result', 'time', 'checks', 'shots', 'detail'];
  const widths = head.map((h, i) => Math.min(i === 6 ? 90 : 40, Math.max(h.length, ...rows.map((r) => r[i].length))));
  const fmt = (r) => r.map((c, i) => (c.length > widths[i] ? `${c.slice(0, widths[i] - 3)}...` : c.padEnd(widths[i]))).join('  ');
  console.log(`\n${fmt(head)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const r of rows) console.log(fmt(r));
  const pass = summary.results.filter((r) => r.status === 'pass').length;
  console.log(`\n${pass}/${summary.results.length} scenarios passed${summary.global.some((g) => !g.ok) ? ', global checks FAILED' : ''}. ${summary.ok ? 'OK' : 'FAILED'}`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`\ne2e: ${err?.stack ?? err}`);
    process.exit(2);
  },
);
