import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SapiError, SapiHost, type SapiHostOptions } from '../src/main/voice/sapi-host.ts';
import { parseWav } from '../src/main/voice/wav.ts';

type Req = Record<string, unknown> & { id: number; op: string };
/** What the fake host does with a request: answer, stay silent, or crash. */
type Behaviour = (req: Req, child: FakeChild) => Record<string, unknown> | 'silent' | 'crash' | Promise<Record<string, unknown> | 'silent' | 'crash'>;

const VOICES = [
  { name: 'Microsoft David Desktop', culture: 'en-US', gender: 'Male', age: 'Adult', description: 'Microsoft David Desktop - English (United States)' },
  { name: 'Microsoft Zira Desktop', culture: 'en-US', gender: 'Female', age: 'Adult', description: 'Microsoft Zira Desktop - English (United States)' },
];

/** 100 ms of a 440 Hz tone at 22050 Hz, padded with 300 ms of silence on both sides. */
function tonePcm(): Buffer {
  const sr = 22050;
  const pad = Math.round(sr * 0.3);
  const tone = Math.round(sr * 0.1);
  const buf = Buffer.alloc((pad * 2 + tone) * 2);
  for (let i = 0; i < tone; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000), (pad + i) * 2);
  return buf;
}

const defaultBehaviour: Behaviour = (req) => {
  if (req.op === 'voices') return { id: req.id, ok: true, voices: VOICES };
  if (req.op === 'speak') return { id: req.id, ok: true, sampleRate: 22050, pcm: tonePcm().toString('base64') };
  return { id: req.id, ok: false, error: 'Unknown op.' };
};

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: string[] = [];
  killed = false;
  exited = false;
  private pending = '';

  constructor(behaviour: Behaviour, startup: 'ready' | 'fatal' | 'exit' | 'silent' = 'ready') {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.pending += chunk;
      let nl: number;
      while ((nl = this.pending.indexOf('\n')) >= 0) {
        const line = this.pending.slice(0, nl);
        this.pending = this.pending.slice(nl + 1);
        this.received.push(line);
        void this.handle(JSON.parse(line) as Req, behaviour);
      }
    });
    setImmediate(() => {
      if (startup === 'ready') this.send({ id: 0, ok: true, ready: true });
      else if (startup === 'fatal') {
        this.send({ id: 0, ok: false, fatal: true, error: 'Could not load file or assembly "System.Speech".' });
        this.exit(3);
      } else if (startup === 'exit') this.exit(1);
    });
  }

  private async handle(req: Req, behaviour: Behaviour): Promise<void> {
    const r = await behaviour(req, this);
    if (r === 'silent') return;
    if (r === 'crash') {
      this.exit(255);
      return;
    }
    this.send(r);
  }

  send(obj: Record<string, unknown>): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(obj)}\r\n`);
  }

  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('exit', code, null));
  }

  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
}

function makeHost(o: { behaviour?: Behaviour; startup?: 'ready' | 'fatal' | 'exit' | 'silent'; extra?: Partial<SapiHostOptions> } = {}) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const host = new SapiHost({
    platform: 'win32',
    requestTimeoutMs: 150,
    startTimeoutMs: 150,
    spawn: () => {
      const c = new FakeChild(o.behaviour ?? defaultBehaviour, o.startup ?? 'ready');
      children.push(c);
      return c as unknown as ChildProcess;
    },
    log: (level, message) => logs.push(`${level}: ${message}`),
    ...o.extra,
  });
  return { host, children, logs };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SapiHost line protocol', () => {
  it('starts lazily, once, and keeps the host for later requests', async () => {
    const { host, children } = makeHost();
    expect(children.length).toBe(0);
    const voices = await host.listVoices();
    expect(voices.map((v) => v.name)).toEqual(['Microsoft David Desktop', 'Microsoft Zira Desktop']);
    await host.speak({ text: 'Hello', voice: null, rate: 0, volume: 100 });
    expect(children.length).toBe(1);
    expect(host.spawnCount).toBe(1);
    expect(host.running).toBe(true);
    host.dispose();
  });

  it('wraps the PCM in a RIFF/WAVE header and trims long silences', async () => {
    const { host } = makeHost();
    const wav = await host.speak({ text: 'Hello from Bonzi', voice: 'Microsoft David Desktop', rate: -2, volume: 100 });
    const info = parseWav(wav);
    expect(info).not.toBeNull();
    expect(info).toMatchObject({ sampleRate: 22050, channels: 1, bitsPerSample: 16 });
    // 100 ms of tone plus at most 40 ms lead and 150 ms tail (not the 600 ms of padding).
    const ms = (info!.dataLength / 2 / 22050) * 1000;
    expect(ms).toBeGreaterThan(95);
    expect(ms).toBeLessThan(300);
    host.dispose();
  });

  it('sends one ASCII-only JSON line per request with clamped numbers', async () => {
    const { host, children } = makeHost();
    const text = 'Café "quoted" $(Get-Date) <speak>x</speak> 😀\nline2';
    await host.speak({ text, voice: 'Microsoft Zira Desktop', rate: 42, volume: -5 });
    const line = children[0]!.received.at(-1)!;
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true);
    const req = JSON.parse(line) as Req;
    expect(req).toMatchObject({ op: 'speak', text, voice: 'Microsoft Zira Desktop', rate: 10, volume: 0 });
    expect(typeof req.id).toBe('number');
    host.dispose();
  });

  it('serializes requests: the next line is written only after the previous answer', async () => {
    const order: string[] = [];
    const behaviour: Behaviour = async (req) => {
      order.push(`start ${String(req.text)}`);
      await sleep(30);
      order.push(`end ${String(req.text)}`);
      return defaultBehaviour(req, undefined as unknown as FakeChild);
    };
    const { host } = makeHost({ behaviour });
    await Promise.all([
      host.speak({ text: 'one', voice: null, rate: 0, volume: 100 }),
      host.speak({ text: 'two', voice: null, rate: 0, volume: 100 }),
      host.speak({ text: 'three', voice: null, rate: 0, volume: 100 }),
    ]);
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two', 'start three', 'end three']);
    host.dispose();
  });

  it('handles answers split across chunks and ignores non-protocol output', async () => {
    const behaviour: Behaviour = (req, child) => {
      const line = JSON.stringify({ id: req.id, ok: true, voices: VOICES });
      child.stdout.write('WARNING: something PowerShell printed\r\n');
      child.stdout.write(line.slice(0, 10));
      setTimeout(() => child.stdout.write(`${line.slice(10)}\r\n`), 5);
      return 'silent';
    };
    const { host } = makeHost({ behaviour });
    expect((await host.listVoices()).length).toBe(2);
    host.dispose();
  });

  it('drops malformed voice entries', async () => {
    const behaviour: Behaviour = (req) => ({
      id: req.id,
      ok: true,
      voices: [VOICES[0], null, 7, { name: '' }, { name: 'X'.repeat(400), culture: 3 }, VOICES[0]],
    });
    const { host } = makeHost({ behaviour });
    const voices = await host.listVoices();
    expect(voices.length).toBe(2);
    expect(voices[1]!.name.length).toBe(256);
    expect(voices[1]!.culture).toBe('');
    host.dispose();
  });

  it('reports a host error as failed without restarting the host, and never logs the text', async () => {
    const secret = 'my secret sentence';
    const behaviour: Behaviour = (req) =>
      req.op === 'speak' ? { id: req.id, ok: false, error: `Invalid JSON primitive: "${secret}"` } : defaultBehaviour(req, undefined as unknown as FakeChild);
    const { host, children, logs } = makeHost({ behaviour });
    await expect(host.speak({ text: secret, voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    await host.listVoices();
    expect(children.length).toBe(1);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.some((l) => l.startsWith('warn: SAPI \'speak\' failed'))).toBe(true);
    host.dispose();
  });

  it('times out a silent request, kills the host and starts a fresh one next time', async () => {
    let calls = 0;
    const behaviour: Behaviour = (req) => (++calls === 1 ? 'silent' : defaultBehaviour(req, undefined as unknown as FakeChild));
    const { host, children } = makeHost({ behaviour });
    const err = await host.speak({ text: 'hang', voice: null, rate: 0, volume: 100 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SapiError);
    expect((err as SapiError).code).toBe('timeout');
    expect(children[0]!.killed).toBe(true);
    await host.speak({ text: 'again', voice: null, rate: 0, volume: 100 });
    expect(children.length).toBe(2);
    host.dispose();
  });

  it('restarts after a crash mid-request', async () => {
    let calls = 0;
    const behaviour: Behaviour = (req) => (++calls === 1 ? 'crash' : defaultBehaviour(req, undefined as unknown as FakeChild));
    const { host, children } = makeHost({ behaviour });
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'crashed' });
    expect((await host.listVoices()).length).toBe(2);
    expect(children.length).toBe(2);
    host.dispose();
  });

  it('marks the voice unavailable when System.Speech cannot be loaded, without respawning', async () => {
    const { host, children, logs } = makeHost({ startup: 'fatal' });
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(host.speak({ text: 'hi', voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'unavailable' });
    expect(children.length).toBe(1);
    expect(logs.some((l) => l.includes('could not load System.Speech'))).toBe(true);
    host.dispose();
  });

  it('is unavailable off Windows and never spawns', async () => {
    const { host, children } = makeHost({ extra: { platform: 'linux' } });
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
    expect(children.length).toBe(0);
  });

  it('is unavailable when the process cannot be spawned', async () => {
    const host = new SapiHost({
      platform: 'win32',
      spawn: () => {
        throw new Error('spawn EACCES');
      },
    });
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('backs off after repeated start failures and retries later', async () => {
    let now = 1_000;
    const { host, children } = makeHost({ startup: 'exit', extra: { now: () => now, retryAfterMs: 60_000 } });
    for (let i = 0; i < 3; i++) await expect(host.listVoices()).rejects.toBeInstanceOf(SapiError);
    expect(children.length).toBe(3);
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'unavailable' });
    expect(children.length).toBe(3);
    now += 61_000;
    await expect(host.listVoices()).rejects.toBeInstanceOf(SapiError);
    expect(children.length).toBe(4);
  });

  it('times out a host that never reports ready', async () => {
    const { host, children } = makeHost({ startup: 'silent' });
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'timeout' });
    expect(children[0]!.killed).toBe(true);
  });

  it('dispose kills the host, fails the pending request and refuses new ones', async () => {
    const { host, children } = makeHost({ behaviour: () => 'silent', extra: { requestTimeoutMs: 5_000 } });
    const p = host.listVoices();
    await sleep(30);
    host.dispose();
    await expect(p).rejects.toMatchObject({ code: 'disposed' });
    expect(children[0]!.killed).toBe(true);
    await expect(host.listVoices()).rejects.toMatchObject({ code: 'disposed' });
  });

  it('rejects empty or oversized text before it reaches the host', async () => {
    const { host, children } = makeHost();
    await expect(host.speak({ text: '   ', voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    await expect(host.speak({ text: 'x'.repeat(9000), voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    expect(children.length).toBe(0);
  });

  it('rejects an answer without audio or with an odd sample rate', async () => {
    let n = 0;
    const behaviour: Behaviour = (req) => (++n === 1 ? { id: req.id, ok: true, sampleRate: 22050 } : { id: req.id, ok: true, sampleRate: 12345, pcm: 'AAAA' });
    const { host } = makeHost({ behaviour });
    await expect(host.speak({ text: 'a', voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    await expect(host.speak({ text: 'b', voice: null, rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    host.dispose();
  });
});

describe('SapiHost idle shutdown', () => {
  it('stops an idle host after idleTimeoutMs and restarts it on the next request', async () => {
    const { host, children, logs } = makeHost({ extra: { idleTimeoutMs: 50 } });
    await host.speak({ text: 'Hello', voice: null, rate: 0, volume: 100 });
    expect(host.running).toBe(true);
    await sleep(120);
    expect(host.running).toBe(false);
    expect(children[0]!.killed).toBe(true);
    // Stopped on purpose: no "exited" warning.
    expect(logs.some((l) => l.startsWith('warn:'))).toBe(false);
    expect(logs.some((l) => l.includes('SAPI host stopped (idle)'))).toBe(true);
    await host.speak({ text: 'Again', voice: null, rate: 0, volume: 100 });
    expect(host.spawnCount).toBe(2);
    expect(host.running).toBe(true);
    host.dispose();
  });

  it('keeps the host while requests keep coming', async () => {
    const { host } = makeHost({ extra: { idleTimeoutMs: 80 } });
    for (let i = 0; i < 4; i++) {
      await host.listVoices();
      await sleep(40);
    }
    expect(host.spawnCount).toBe(1);
    expect(host.running).toBe(true);
    host.dispose();
  });

  it('never kills the host in the middle of a slow request', async () => {
    const behaviour: Behaviour = async (req) => {
      await sleep(150);
      return defaultBehaviour(req, undefined as unknown as FakeChild);
    };
    const { host, children } = makeHost({ behaviour, extra: { idleTimeoutMs: 50, requestTimeoutMs: 1_000 } });
    await host.listVoices(); // first request; idle timer armed afterwards
    const slow = host.speak({ text: 'slow', voice: null, rate: 0, volume: 100 });
    await sleep(100); // past the idle timeout, while the request is still in flight
    expect(children[0]!.killed).toBe(false);
    await expect(slow).resolves.toBeInstanceOf(Buffer);
    expect(host.spawnCount).toBe(1);
    host.dispose();
  });

  it('dispose clears the idle timer and 0 disables idle shutdown', async () => {
    const a = makeHost({ extra: { idleTimeoutMs: 50 } });
    await a.host.listVoices();
    a.host.dispose();
    await sleep(80);
    expect(a.children[0]!.killed).toBe(true);
    expect(a.logs.some((l) => l.includes('stopped (idle)'))).toBe(false);

    const b = makeHost({ extra: { idleTimeoutMs: 0 } });
    await b.host.listVoices();
    await sleep(80);
    expect(b.host.running).toBe(true);
    b.host.dispose();
  });
});
