// Minimal, dependency-free Chrome DevTools Protocol client for the E2E runner.
// Uses the global WebSocket and fetch available in Node 22+.

import { writeFile } from 'node:fs/promises';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lists DevTools targets exposed on http://127.0.0.1:<port>/json/list. */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) });
  if (!res.ok) throw new Error(`/json/list returned ${res.status}`);
  return /** @type {Array<{id:string,type:string,url:string,title:string,webSocketDebuggerUrl?:string}>} */ (await res.json());
}

/**
 * Polls /json/list until a page target whose url starts with urlPrefix appears.
 * isAlive() lets the caller stop early when the app process has already exited.
 */
export async function waitForTarget(port, urlPrefix, { timeoutMs = 30_000, isAlive = () => true, exclude = [] } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error(`app exited while waiting for a target starting with ${urlPrefix}`);
    try {
      const targets = await listTargets(port);
      const t = targets.find((x) => x.type === 'page' && x.url.startsWith(urlPrefix) && x.webSocketDebuggerUrl && !exclude.includes(x.id));
      if (t) return t;
      lastErr = null;
    } catch (err) {
      lastErr = err;
    }
    await sleep(200);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for a page target starting with ${urlPrefix}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message ?? 'CDP error'}${error?.data ? ` (${error.data})` : ''}`);
    this.name = 'CdpError';
    this.code = error?.code;
  }
}

/** Thrown by evaluate() when the page-side expression throws or rejects. */
export class EvaluateError extends Error {
  constructor(details) {
    const ex = details?.exception;
    super(ex?.description ?? ex?.value ?? details?.text ?? 'evaluation failed');
    this.name = 'EvaluateError';
  }
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
};

export class CdpSession {
  /** @param {string} wsUrl */
  constructor(wsUrl, { label = 'page', defaultTimeoutMs = 15_000 } = {}) {
    this.wsUrl = wsUrl;
    this.label = label;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    /** Collected page errors: exceptions, console.error, Log errors. */
    this.errors = [];
    this.ws = null;
  }

  static async connect(wsUrl, options) {
    const s = new CdpSession(wsUrl, options);
    await s.open();
    return s;
  }

  async open() {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WebSocket connect timeout (${this.label})`)), 10_000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(`WebSocket connect failed (${this.label})`)); }, { once: true });
    });
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => this.#onClose());
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method);
      if (set) for (const cb of [...set]) {
        try { cb(msg.params ?? {}); } catch { /* listener errors must not break the session */ }
      }
    }
  }

  #onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`CDP connection closed (${this.label}) during ${p.method}`));
    }
    this.pending.clear();
    const set = this.listeners.get('__close');
    if (set) for (const cb of [...set]) cb({});
  }

  /** Sends a CDP command and resolves with its result. */
  send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`CDP connection is closed (${this.label}), cannot send ${method}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms (${this.label})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribes to a CDP event ('__close' fires when the socket closes). Returns an unsubscribe function. */
  on(method, cb) {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** Resolves with the params of the next matching event. */
  once(method, { timeoutMs = this.defaultTimeoutMs, filter = () => true } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (p) => {
        if (!filter(p)) return;
        clearTimeout(timer);
        off();
        resolve(p);
      });
    });
  }

  /** Enables Runtime/Log/Page domains and starts collecting page errors. */
  async enableErrorCollection() {
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails ?? {};
      this.errors.push({ source: 'exception', at: Date.now(), text: d.exception?.description ?? d.text ?? 'exception', url: d.url });
    });
    this.on('Runtime.consoleAPICalled', (p) => {
      if (p.type !== 'error' && p.type !== 'assert') return;
      const text = (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ');
      this.errors.push({ source: 'console', at: Date.now(), text });
    });
    this.on('Log.entryAdded', (p) => {
      if (p.entry?.level !== 'error') return;
      this.errors.push({ source: `log:${p.entry.source}`, at: Date.now(), text: p.entry.text, url: p.entry.url });
    });
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
  }

  /** Errors collected since the given timestamp (ms). */
  errorsSince(ts) {
    return this.errors.filter((e) => e.at >= ts);
  }

  /**
   * Evaluates an expression in the page main world and returns its value.
   * Pass a function to have it serialised and called with JSON args.
   */
  async evaluate(expr, { awaitPromise = true, returnByValue = true, timeoutMs, args = [], allowUnsafeEval = true } = {}) {
    const expression = typeof expr === 'function' ? `(${expr.toString()})(...${JSON.stringify(args)})` : expr;
    // allowUnsafeEval false makes eval()/new Function inside the expression obey the page CSP.
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue, userGesture: true, allowUnsafeEvalBlockedByCSP: allowUnsafeEval }, { timeoutMs: timeoutMs ?? this.defaultTimeoutMs });
    if (res.exceptionDetails) throw new EvaluateError(res.exceptionDetails);
    return returnByValue ? res.result?.value : res.result;
  }

  /**
   * Polls a page expression until it returns a truthy value. Resolves with that value.
   * Evaluation errors count as falsy (the page may be mid-load).
   */
  async waitFor(expr, { timeoutMs = 10_000, intervalMs = 100, args = [], message } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(expr, { args, timeoutMs: Math.max(1000, Math.min(5000, deadline - Date.now())) });
        if (v) return v;
        lastErr = null;
      } catch (err) {
        lastErr = err;
        if (this.closed) break;
      }
      await sleep(intervalMs);
    }
    const what = message ?? (typeof expr === 'function' ? expr.toString().slice(0, 120) : String(expr).slice(0, 120));
    throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
  }

  /** Captures a PNG of the page viewport and writes it to path. Returns the PNG bytes. */
  async screenshot(path, { timeoutMs = 10_000 } = {}) {
    let res;
    try {
      res = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, { timeoutMs });
    } catch (err) {
      // Some Chromium builds reject unknown flags; retry with the bare command.
      if (!(err instanceof CdpError)) throw err;
      res = await this.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs });
    }
    const buf = Buffer.from(res.data, 'base64');
    if (path) await writeFile(path, buf);
    return buf;
  }

  /** Clicks at CSS pixel coordinates (relative to the viewport). */
  async click(x, y, { button = 'left', clickCount = 1, delayMs = 40 } = {}) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(delayMs);
    for (let i = 1; i <= clickCount; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount: i });
      await sleep(delayMs);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i });
      if (i < clickCount) await sleep(delayMs);
    }
  }

  async mouseMove(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  }

  /** Inserts text into the focused element as if typed (fires input events). */
  async type(text) {
    await this.send('Input.insertText', { text });
  }

  /** Presses and releases a named key (Enter, Escape, Tab, Backspace, arrows) or a single character. */
  async press(name) {
    const k = KEYS[name] ?? { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, keyCode: name.length === 1 ? name.toUpperCase().charCodeAt(0) : 0, text: name.length === 1 ? name : undefined };
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
    await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.ws?.close(); } catch { /* ignore */ }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`CDP session closed (${this.label})`));
    }
    this.pending.clear();
  }
}
