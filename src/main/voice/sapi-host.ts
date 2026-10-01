// Windows SAPI bridge: a persistent, hidden PowerShell 5.1 process hosting
// System.Speech (see sapi-script.ts for the script and the line protocol).
//
// - Spawned lazily on the first request from the absolute System32 path (never PATH).
// - Requests are serialized: one line out, one line back, matched by id.
// - Each request has a timeout; a timeout or crash kills the host and the next
//   request starts a fresh one. Repeated start failures back off for a minute.
// - The host exits by itself when stdin closes; dispose() also kills it.
// - It is stopped after idleTimeoutMs (default 5 min) without requests, so one
//   greeting does not leave PowerShell resident for days; the next request restarts it.
// - Nothing that could contain spoken text is logged: host messages are logged
//   only after quoted segments are removed, and stderr only as a byte count.
//
// Pure Node: no electron import, so it is unit-testable with a fake child process.

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SystemVoice } from '../../shared/ipc.ts';
import { encodePowerShellCommand, SAPI_HOST_SCRIPT, SAPI_MAX_TEXT } from './sapi-script.ts';
import { pcm16ToWav, trimPcm16Silence } from './wav.ts';

export type SapiErrorCode = 'unavailable' | 'timeout' | 'crashed' | 'failed' | 'disposed';

export class SapiError extends Error {
  readonly code: SapiErrorCode;
  constructor(code: SapiErrorCode, message: string) {
    super(message);
    this.name = 'SapiError';
    this.code = code;
  }
}

export interface SapiSpeakRequest {
  text: string;
  /** An installed voice name, or null for the Windows default voice. */
  voice: string | null;
  /** -10..10 */
  rate: number;
  /** 0..100 */
  volume: number;
}

export interface SapiHostLike {
  listVoices(): Promise<SystemVoice[]>;
  /** Resolves with a complete WAV file (16-bit mono PCM). */
  speak(req: SapiSpeakRequest): Promise<Buffer>;
  dispose(): void;
}

export type SapiLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export interface SapiHostOptions {
  /** Starts the host process. Injectable for tests; defaults to spawning powershell.exe. */
  spawn?: () => ChildProcess;
  platform?: NodeJS.Platform;
  /** Per-request timeout. Default 15 s. */
  requestTimeoutMs?: number;
  /** Time allowed for the host to load System.Speech and report ready. Default 20 s. */
  startTimeoutMs?: number;
  /** Back-off after repeated start failures. Default 60 s. */
  retryAfterMs?: number;
  /** Idle time after the last request before the host is stopped; the next request restarts it. Default 5 min. 0 disables. */
  idleTimeoutMs?: number;
  log?: SapiLog;
  now?: () => number;
}

const MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_VOICES = 200;
const MAX_FIELD = 256;
const START_FAILURES_BEFORE_BACKOFF = 3;
const ALLOWED_SAMPLE_RATES: ReadonlySet<number> = new Set([8000, 11025, 16000, 22050, 24000, 44100, 48000]);

/** Absolute path of Windows PowerShell 5.1 under %SystemRoot%. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? '';
  const base = root && path.win32.isAbsolute(root) ? root : 'C:\\Windows';
  return path.win32.join(base, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export const POWERSHELL_ARGS: readonly string[] = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

/** Environment for the host: the parent's, minus anything the host never needs (the API key above all). */
export function hostEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^(OPENAI_|BONZI_|ELECTRON_|NODE_OPTIONS$)/i.test(k)) continue;
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function defaultSpawn(): ChildProcess {
  return nodeSpawn(powershellPath(), [...POWERSHELL_ARGS, encodePowerShellCommand(SAPI_HOST_SCRIPT)], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: hostEnvironment(),
  });
}

/** JSON with every non-ASCII character escaped, so the line is pure ASCII on the wire. */
export function encodeRequestLine(obj: Record<string, unknown>): string {
  return `${JSON.stringify(obj).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

/** Host error text with quoted segments removed and length capped, safe to log. */
export function sanitizeHostMessage(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"..."')
    .replace(/'[^']*'/g, "'...'")
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 200);
}

function field(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

/** Validates the host's voice list. Invalid entries are dropped. */
export function parseVoiceList(raw: unknown): SystemVoice[] {
  if (!Array.isArray(raw)) return [];
  const out: SystemVoice[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'object' || v === null) continue;
    const o = v as Record<string, unknown>;
    const name = field(o.name).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, culture: field(o.culture), gender: field(o.gender), age: field(o.age), description: field(o.description) });
    if (out.length >= MAX_VOICES) break;
  }
  return out;
}

interface HostMessage {
  id: number;
  ok: boolean;
  [k: string]: unknown;
}

function parseMessage(line: string): HostMessage | null {
  if (!line.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'number' || typeof o.ok !== 'boolean') return null;
    return o as HostMessage;
  } catch {
    return null;
  }
}

interface Pending {
  id: number;
  op: string;
  resolve(msg: HostMessage): void;
  reject(err: SapiError): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Running {
  child: ChildProcess;
  ready: Promise<void>;
  /** Settles the startup wait. */
  readyResolve(): void;
  readyReject(err: SapiError): void;
  started: boolean;
  dead: boolean;
  buffer: string;
  stderrBytes: number;
}

export class SapiHost implements SapiHostLike {
  readonly #spawn: () => ChildProcess;
  readonly #platform: NodeJS.Platform;
  readonly #requestTimeoutMs: number;
  readonly #startTimeoutMs: number;
  readonly #retryAfterMs: number;
  readonly #idleTimeoutMs: number;
  readonly #log: SapiLog;
  readonly #now: () => number;

  #run: Running | null = null;
  #pending: Pending | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #nextId = 1;
  #disposed = false;
  #startFailures = 0;
  #unavailableUntil = 0;
  #unavailableReason = '';
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of host processes started (for tests and diagnostics). */
  spawnCount = 0;

  constructor(options: SapiHostOptions = {}) {
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#platform = options.platform ?? process.platform;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#startTimeoutMs = options.startTimeoutMs ?? 20_000;
    this.#retryAfterMs = options.retryAfterMs ?? 60_000;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
    this.#log = options.log ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    if (this.#platform === 'win32' && !options.spawn) {
      const ps = powershellPath();
      if (!fs.existsSync(ps)) this.#markUnavailable(Number.POSITIVE_INFINITY, 'Windows PowerShell was not found.');
    }
  }

  /** True while a host process is running. */
  get running(): boolean {
    return this.#run !== null && !this.#run.dead;
  }

  async listVoices(): Promise<SystemVoice[]> {
    const msg = await this.#request('voices', {});
    return parseVoiceList(msg.voices);
  }

  async speak(req: SapiSpeakRequest): Promise<Buffer> {
    const text = req.text;
    if (typeof text !== 'string' || !text.trim() || text.length > SAPI_MAX_TEXT) throw new SapiError('failed', 'Nothing to say, or the text is too long.');
    const rate = Math.round(Math.min(10, Math.max(-10, Number.isFinite(req.rate) ? req.rate : 0)));
    const volume = Math.round(Math.min(100, Math.max(0, Number.isFinite(req.volume) ? req.volume : 100)));
    const msg = await this.#request('speak', { text, voice: req.voice ?? '', rate, volume });
    const sampleRate = msg.sampleRate;
    if (typeof msg.pcm !== 'string' || typeof sampleRate !== 'number' || !ALLOWED_SAMPLE_RATES.has(sampleRate)) {
      throw new SapiError('failed', 'The Windows voice returned no audio.');
    }
    const pcm = Buffer.from(msg.pcm, 'base64');
    if (pcm.byteLength < 2) throw new SapiError('failed', 'The Windows voice returned no audio.');
    return pcm16ToWav(trimPcm16Silence(pcm, sampleRate), sampleRate);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelIdle();
    this.#failPending(new SapiError('disposed', 'The Windows voice was shut down.'));
    this.#kill('shutdown');
  }

  // ---------------------------------------------------------------------------

  #markUnavailable(untilMs: number, reason: string): void {
    this.#unavailableUntil = untilMs;
    this.#unavailableReason = reason;
  }

  #request(op: string, payload: Record<string, unknown>): Promise<HostMessage> {
    // Requests are serialized, so a queued request's callback runs as a microtask right
    // after the previous one settles and cancels the idle timer before it can fire.
    const run = this.#chain.then(() => {
      this.#cancelIdle();
      return this.#exec(op, payload).finally(() => this.#scheduleIdle());
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  #cancelIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #scheduleIdle(): void {
    this.#cancelIdle();
    if (this.#disposed || !this.#run || !(this.#idleTimeoutMs > 0) || !Number.isFinite(this.#idleTimeoutMs)) return;
    const t = setTimeout(() => {
      this.#idleTimer = null;
      // #kill marks the run dead before its exit event, so no "exited" warning is logged.
      if (!this.#pending) this.#kill('idle');
    }, this.#idleTimeoutMs);
    t.unref?.();
    this.#idleTimer = t;
  }

  async #exec(op: string, payload: Record<string, unknown>): Promise<HostMessage> {
    if (this.#disposed) throw new SapiError('disposed', 'The Windows voice was shut down.');
    if (this.#platform !== 'win32') throw new SapiError('unavailable', 'Windows voices are only available on Windows.');
    if (this.#now() < this.#unavailableUntil) throw new SapiError('unavailable', this.#unavailableReason || 'The Windows voice is not available.');

    const run = await this.#ensureStarted();
    const id = this.#nextId++;
    const started = this.#now();
    const msg = await new Promise<HostMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending?.id !== id) return;
        this.#pending = null;
        this.#log('warn', `SAPI host did not answer '${op}' within ${this.#requestTimeoutMs} ms; restarting it.`);
        this.#kill('timeout');
        reject(new SapiError('timeout', 'The Windows voice took too long to answer.'));
      }, this.#requestTimeoutMs);
      this.#pending = { id, op, resolve, reject, timer };
      try {
        const ok = run.child.stdin?.write(encodeRequestLine({ id, op, ...payload }));
        if (ok === undefined) throw new Error('no stdin');
      } catch {
        clearTimeout(timer);
        this.#pending = null;
        this.#kill('write failed');
        reject(new SapiError('crashed', 'The Windows voice stopped unexpectedly.'));
      }
    });
    if (!msg.ok) {
      const err = typeof msg.error === 'string' ? msg.error : 'unknown error';
      this.#log('warn', `SAPI '${op}' failed: ${sanitizeHostMessage(err)}`);
      throw new SapiError('failed', 'The Windows voice could not speak that.');
    }
    this.#log('debug', `SAPI '${op}' answered in ${this.#now() - started} ms`);
    return msg;
  }

  #ensureStarted(): Promise<Running> {
    const cur = this.#run;
    if (cur && !cur.dead) return cur.ready.then(() => cur);

    let child: ChildProcess;
    try {
      child = this.#spawn();
    } catch (err) {
      this.#markUnavailable(Number.POSITIVE_INFINITY, 'The Windows voice host could not be started.');
      this.#log('warn', `SAPI host spawn failed: ${sanitizeHostMessage(err instanceof Error ? err.message : String(err))}`);
      return Promise.reject(new SapiError('unavailable', 'The Windows voice host could not be started.'));
    }
    this.spawnCount++;

    let readyResolve!: () => void;
    let readyReject!: (err: SapiError) => void;
    const ready = new Promise<void>((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    const run: Running = { child, ready, readyResolve, readyReject, started: false, dead: false, buffer: '', stderrBytes: 0 };
    this.#run = run;

    const startTimer = setTimeout(() => {
      if (run.started || run.dead) return;
      this.#log('warn', `SAPI host did not start within ${this.#startTimeoutMs} ms.`);
      this.#onStartFailure();
      run.readyReject(new SapiError('timeout', 'The Windows voice took too long to start.'));
      this.#kill('start timeout');
    }, this.#startTimeoutMs);
    void ready.then(
      () => clearTimeout(startTimer),
      () => clearTimeout(startTimer),
    );

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => this.#onStdout(run, typeof chunk === 'string' ? chunk : chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const n = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      run.stderrBytes += n;
      // PowerShell writes CLIXML progress/error records here; never log their content.
      if (run.stderrBytes === n) this.#log('debug', `SAPI host wrote ${n} bytes to stderr`);
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.#log('warn', `SAPI host process error${code ? ` (${code})` : ''}.`);
      if (!run.started && code === 'ENOENT') this.#markUnavailable(Number.POSITIVE_INFINITY, 'Windows PowerShell was not found.');
      this.#onExit(run, null);
    });
    child.on('exit', (code: number | null) => this.#onExit(run, code));

    return ready.then(() => run);
  }

  #onStartFailure(): void {
    this.#startFailures++;
    if (this.#startFailures >= START_FAILURES_BEFORE_BACKOFF) {
      this.#markUnavailable(this.#now() + this.#retryAfterMs, 'The Windows voice keeps failing to start.');
      this.#startFailures = 0;
    }
  }

  #onStdout(run: Running, chunk: string): void {
    if (run.dead) return;
    run.buffer += chunk;
    if (run.buffer.length > MAX_LINE_CHARS) {
      this.#log('warn', 'SAPI host sent an oversized line; restarting it.');
      this.#failPending(new SapiError('failed', 'The Windows voice returned too much data.'));
      this.#kill('oversized line');
      return;
    }
    let nl: number;
    while ((nl = run.buffer.indexOf('\n')) >= 0) {
      const line = run.buffer.slice(0, nl).replace(/\r$/, '').trim();
      run.buffer = run.buffer.slice(nl + 1);
      if (line) this.#onLine(run, line);
    }
  }

  #onLine(run: Running, line: string): void {
    const msg = parseMessage(line);
    if (!msg) {
      this.#log('debug', `SAPI host printed a non-protocol line (${line.length} chars)`);
      return;
    }
    if (msg.id === 0) {
      if (run.started) return;
      if (msg.ok && msg.ready === true) {
        run.started = true;
        this.#startFailures = 0;
        this.#log('info', 'Windows voice host started.');
        run.readyResolve();
      } else {
        const err = typeof msg.error === 'string' ? msg.error : 'unknown error';
        this.#log('warn', `SAPI host could not load System.Speech: ${sanitizeHostMessage(err)}`);
        this.#markUnavailable(Number.POSITIVE_INFINITY, 'Windows speech (System.Speech) is not available on this PC.');
        run.readyReject(new SapiError('unavailable', 'Windows speech is not available on this PC.'));
        this.#kill('fatal');
      }
      return;
    }
    const p = this.#pending;
    if (!p || p.id !== msg.id) {
      this.#log('debug', `SAPI host answered an unknown request ${msg.id}`);
      return;
    }
    clearTimeout(p.timer);
    this.#pending = null;
    p.resolve(msg);
  }

  #onExit(run: Running, code: number | null): void {
    if (run.dead) return;
    run.dead = true;
    if (this.#run === run) this.#run = null;
    if (!run.started) {
      this.#onStartFailure();
      run.readyReject(new SapiError(this.#now() < this.#unavailableUntil ? 'unavailable' : 'crashed', 'The Windows voice host stopped while starting.'));
    }
    if (!this.#disposed) this.#log(run.started ? 'warn' : 'info', `SAPI host exited (code ${code ?? 'none'}).`);
    this.#failPending(new SapiError('crashed', 'The Windows voice stopped unexpectedly.'));
  }

  #failPending(err: SapiError): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  #kill(reason: string): void {
    const run = this.#run;
    if (!run) return;
    this.#run = null;
    run.dead = true;
    if (!run.started) run.readyReject(new SapiError('crashed', 'The Windows voice host was stopped.'));
    try {
      run.child.stdin?.end();
    } catch {
      // already closed
    }
    try {
      run.child.kill();
    } catch {
      // already gone
    }
    this.#log('debug', `SAPI host stopped (${reason}).`);
  }
}
