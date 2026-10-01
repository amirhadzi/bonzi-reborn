import { describe, expect, it } from 'vitest';
import type { SystemVoice, SystemVoiceListResult } from '../src/shared/ipc.ts';
import { DEFAULT_SETTINGS, LIMITS, applySettingsPatch } from '../src/shared/settings.ts';
import {
  effectiveSpeed,
  pickDefaultSystemVoice,
  playbackRateForPitch,
  resolveSystemVoice,
  sapiRateFor,
  sapiSpeedForRate,
} from '../src/shared/voice-tuning.ts';
import { encodeRequestLine, hostEnvironment, powershellPath, POWERSHELL_ARGS, sanitizeHostMessage } from '../src/main/voice/sapi-host.ts';
import type { SapiHostLike, SapiSpeakRequest } from '../src/main/voice/sapi-host.ts';
import { SapiError } from '../src/main/voice/sapi-host.ts';
import { encodePowerShellCommand, SAPI_HOST_SCRIPT } from '../src/main/voice/sapi-script.ts';
import { cleanSystemSpeechText, SystemVoiceService } from '../src/main/voice/system-voice-service.ts';
import { parseWav, pcm16Levels, pcm16ToWav, trimPcm16Silence } from '../src/main/voice/wav.ts';

const v = (name: string, culture = 'en-US', gender = 'Male'): SystemVoice => ({ name, culture, gender, age: 'Adult', description: name });

describe('pitch and tempo mapping', () => {
  it('uses the pitch as the playback rate, clamped to the settings range', () => {
    expect(playbackRateForPitch(1)).toBe(1);
    expect(playbackRateForPitch(1.3)).toBe(1.3);
    expect(playbackRateForPitch(0)).toBe(LIMITS.systemVoicePitch.min);
    expect(playbackRateForPitch(9)).toBe(LIMITS.systemVoicePitch.max);
    expect(playbackRateForPitch(Number.NaN)).toBe(1);
  });

  it('matches the measured SAPI speed curve (about 3x per 10 steps)', () => {
    expect(sapiSpeedForRate(0)).toBe(1);
    expect(sapiSpeedForRate(10)).toBeCloseTo(3, 5);
    expect(sapiSpeedForRate(-10)).toBeCloseTo(1 / 3, 5);
    expect(sapiSpeedForRate(5)).toBeCloseTo(1.73, 2);
  });

  it('slows SAPI down to compensate for the pitch shift', () => {
    expect(sapiRateFor(1, 1)).toBe(0);
    // 1.3x pitch plays 1.3x faster, so SAPI must speak at about 1 / 1.3.
    expect(sapiRateFor(1, 1.3)).toBe(-2);
    expect(sapiRateFor(1, 2)).toBe(-6);
    expect(sapiRateFor(2, 1)).toBe(6);
    expect(sapiRateFor(2.5, 0.5)).toBe(10);
    expect(sapiRateFor(0.5, 2)).toBe(-10);
  });

  it('keeps the heard speed within one SAPI step of the setting', () => {
    for (const pitch of [0.5, 0.8, 1, 1.3, 1.6, 2]) {
      for (const rate of [0.6, 0.8, 1, 1.2, 1.5, 2]) {
        // Outside SAPI's own range (1/3x to 3x) the rate is clamped; see the next assertion.
        if (rate / pitch < 1 / 3 || rate / pitch > 3) {
          expect(sapiRateFor(rate, pitch)).toBe(rate / pitch < 1 ? -10 : 10);
          continue;
        }
        const heard = effectiveSpeed(rate, pitch);
        // One step is a factor of 3^0.1 (about 11.6 %); rounding keeps us within half a step.
        expect(heard / rate).toBeGreaterThan(1 / 3 ** 0.05 - 1e-9);
        expect(heard / rate).toBeLessThan(3 ** 0.05 + 1e-9);
      }
    }
  });

  it('the Bonzi defaults are a raised pitch at roughly normal speed', () => {
    expect(DEFAULT_SETTINGS.systemVoicePitch).toBeGreaterThan(1.15);
    expect(DEFAULT_SETTINGS.systemVoicePitch).toBeLessThan(1.5);
    const heard = effectiveSpeed(DEFAULT_SETTINGS.systemVoiceRate, DEFAULT_SETTINGS.systemVoicePitch);
    expect(heard).toBeGreaterThan(0.95);
    expect(heard).toBeLessThan(1.2);
  });

  it('settings clamp pitch and speed to the new ranges', () => {
    const s = applySettingsPatch(DEFAULT_SETTINGS, { systemVoicePitch: 0, systemVoiceRate: 9 });
    expect(s.systemVoicePitch).toBe(0.5);
    expect(s.systemVoiceRate).toBe(2.5);
  });
});

describe('Windows voice selection', () => {
  it('prefers Microsoft David, then an en-US male voice, then any en-US voice', () => {
    expect(pickDefaultSystemVoice([v('Microsoft Zira Desktop', 'en-US', 'Female'), v('Microsoft David Desktop')])).toBe('Microsoft David Desktop');
    expect(pickDefaultSystemVoice([v('Microsoft Zira Desktop', 'en-US', 'Female'), v('Acme Bob'), v('Microsoft Hazel Desktop', 'en-GB', 'Female')])).toBe('Acme Bob');
    expect(pickDefaultSystemVoice([v('Microsoft Hazel Desktop', 'en-GB', 'Female'), v('Microsoft Zira Desktop', 'en-US', 'Female')])).toBe('Microsoft Zira Desktop');
    expect(pickDefaultSystemVoice([v('Microsoft Hedda Desktop', 'de-DE', 'Female')])).toBeNull();
    expect(pickDefaultSystemVoice([])).toBeNull();
  });

  it('only ever resolves to an installed voice', () => {
    const voices = [v('Microsoft David Desktop'), v('Microsoft Zira Desktop', 'en-US', 'Female')];
    expect(resolveSystemVoice('Microsoft Zira Desktop', voices)).toEqual({ name: 'Microsoft Zira Desktop', matched: true });
    expect(resolveSystemVoice('microsoft zira desktop', voices)).toEqual({ name: 'Microsoft Zira Desktop', matched: true });
    expect(resolveSystemVoice('', voices)).toEqual({ name: 'Microsoft David Desktop', matched: true });
    expect(resolveSystemVoice("x'); Remove-Item C:\\ -Recurse; ('", voices)).toEqual({ name: 'Microsoft David Desktop', matched: false });
    expect(resolveSystemVoice('Nobody', [])).toEqual({ name: null, matched: false });
  });
});

describe('SAPI host plumbing', () => {
  it('builds the absolute PowerShell path from SystemRoot, never from PATH', () => {
    expect(powershellPath({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({ SystemRoot: 'relative\\path', PATH: 'C:\\evil' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(powershellPath({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(POWERSHELL_ARGS).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  });

  it('does not pass the API key or other secrets to the host', () => {
    const env = hostEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'x', OPENAI_API_KEY: 'sk-test-local', GITHUB_TOKEN: 't', BONZI_USER_DATA: 'd', MY_SECRET: 's', NODE_OPTIONS: '--x' });
    expect(env).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'x' });
  });

  it('keeps the host script fixed: plain-text Speak, no SSML, no dynamic code', () => {
    expect(SAPI_HOST_SCRIPT).toContain('$synth.Speak($text)');
    expect(SAPI_HOST_SCRIPT).toContain('SetOutputToAudioStream');
    expect(SAPI_HOST_SCRIPT).toContain('SpeechAudioFormatInfo(22050');
    expect(SAPI_HOST_SCRIPT).not.toMatch(/SpeakSsml|AppendSsml|Invoke-Expression|\biex\b|ScriptBlock|Add-Type\s+-TypeDefinition/i);
    expect(SAPI_HOST_SCRIPT).not.toMatch(/__[A-Z_]+__/);
    // -EncodedCommand must fit the Windows command line (32767 chars) with room to spare.
    expect(encodePowerShellCommand(SAPI_HOST_SCRIPT).length).toBeLessThan(16_000);
    expect(Buffer.from(encodePowerShellCommand('Get-Date'), 'base64').toString('utf16le')).toBe('Get-Date');
  });

  it('encodes request lines as single ASCII lines', () => {
    const line = encodeRequestLine({ id: 3, op: 'speak', text: 'na\u00efve \u2603\nnext' });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1).includes('\n')).toBe(false);
    expect(/^[\x20-\x7e]+$/.test(line.slice(0, -1))).toBe(true);
    expect(JSON.parse(line)).toEqual({ id: 3, op: 'speak', text: 'na\u00efve \u2603\nnext' });
  });

  it('removes quoted (possibly user) text from host messages before logging', () => {
    expect(sanitizeHostMessage('Invalid JSON primitive: "hello there".')).toBe('Invalid JSON primitive: "...".');
    expect(sanitizeHostMessage("Cannot bind 'x y z'\r\nline")).toBe("Cannot bind '...' line");
    expect(sanitizeHostMessage('e'.repeat(500)).length).toBe(200);
  });
});

describe('WAV helpers', () => {
  it('writes a canonical header that parseWav reads back', () => {
    const pcm = Buffer.alloc(200);
    pcm.writeInt16LE(1000, 10);
    const wav = pcm16ToWav(pcm, 22050);
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(4)).toBe(36 + 200);
    expect(parseWav(wav)).toEqual({ sampleRate: 22050, channels: 1, bitsPerSample: 16, dataOffset: 44, dataLength: 200 });
    expect(parseWav(Buffer.from('not a wav file at all, definitely not one'))).toBeNull();
  });

  it('trims silence but keeps a little padding, and leaves all-silent audio alone', () => {
    const sr = 1000;
    const pcm = Buffer.alloc(2000 * 2);
    for (let i = 900; i < 1000; i++) pcm.writeInt16LE(5000, i * 2);
    const trimmed = trimPcm16Silence(pcm, sr, { keepLeadMs: 40, keepTailMs: 150 });
    expect(trimmed.byteLength / 2).toBe(40 + 100 + 150);
    const silent = Buffer.alloc(100);
    expect(trimPcm16Silence(silent, sr)).toBe(silent);
  });

  it('measures peak and RMS', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(16384, 0);
    pcm.writeInt16LE(-16384, 2);
    expect(pcm16Levels(pcm).peak).toBeCloseTo(0.5, 3);
    expect(pcm16Levels(pcm).rms).toBeCloseTo(Math.sqrt(0.125), 3);
    expect(pcm16Levels(Buffer.alloc(0))).toEqual({ peak: 0, rms: 0 });
  });
});

class FakeHost implements SapiHostLike {
  voices: SystemVoice[] = [v('Microsoft David Desktop'), v('Microsoft Zira Desktop', 'en-US', 'Female')];
  listCalls = 0;
  spoken: SapiSpeakRequest[] = [];
  fail: SapiError | null = null;
  disposed = false;
  async listVoices(): Promise<SystemVoice[]> {
    this.listCalls++;
    if (this.fail) throw this.fail;
    return this.voices;
  }
  async speak(req: SapiSpeakRequest): Promise<Buffer> {
    if (this.fail) throw this.fail;
    this.spoken.push(req);
    return pcm16ToWav(Buffer.alloc(100), 22050);
  }
  dispose(): void {
    this.disposed = true;
  }
}

describe('SystemVoiceService', () => {
  it('lists voices with Bonzi\'s default and caches the list', async () => {
    const host = new FakeHost();
    let now = 0;
    const svc = new SystemVoiceService({ host, now: () => now, voicesTtlMs: 1000 });
    const r = (await svc.listVoices()) as Extract<SystemVoiceListResult, { ok: true }>;
    expect(r.ok).toBe(true);
    expect(r.defaultVoice).toBe('Microsoft David Desktop');
    expect(r.voices.length).toBe(2);
    await svc.listVoices();
    expect(host.listCalls).toBe(1);
    now = 2000;
    await svc.listVoices();
    expect(host.listCalls).toBe(2);
  });

  it('validates the voice, compensates the tempo and returns WAV audio', async () => {
    const host = new FakeHost();
    const logs: string[] = [];
    const svc = new SystemVoiceService({ host, log: (_l, m) => logs.push(m) });
    const ok = await svc.synthesize({ text: ' Hello\u0007 from\nBonzi ', voiceName: 'Microsoft Zira Desktop', rate: 1, pitch: 1.3 });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.mime).toBe('audio/wav');
      expect(parseWav(new Uint8Array(ok.audio))).not.toBeNull();
    }
    expect(host.spoken[0]).toEqual({ text: 'Hello from Bonzi', voice: 'Microsoft Zira Desktop', rate: -2, volume: 100 });

    await svc.synthesize({ text: 'Hi', voiceName: 'Not Installed Voice', rate: 1, pitch: 1 });
    expect(host.spoken[1]!.voice).toBe('Microsoft David Desktop');
    expect(logs.join('\n')).not.toContain('Hi');
    expect(logs.some((l) => l.includes('not installed'))).toBe(true);
  });

  it('maps failures to TtsResult errors', async () => {
    const host = new FakeHost();
    const svc = new SystemVoiceService({ host });
    expect(await svc.synthesize({ text: '  ', voiceName: '', rate: 1, pitch: 1 })).toMatchObject({ ok: false, error: { kind: 'bad-request' } });
    host.fail = new SapiError('unavailable', 'x');
    expect(await svc.synthesize({ text: 'Hi', voiceName: '', rate: 1, pitch: 1 })).toMatchObject({ ok: false, error: { kind: 'unknown', message: 'Windows voices are not available on this PC.' } });
    expect(await svc.listVoices()).toMatchObject({ ok: false });
    host.fail = new SapiError('timeout', 'x');
    expect(await svc.synthesize({ text: 'Hi', voiceName: '', rate: 1, pitch: 1 })).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    svc.dispose();
    expect(host.disposed).toBe(true);
  });

  it('cleans control characters for SAPI', () => {
    expect(cleanSystemSpeechText('a\u0000b\tc\r\nd\u2028e  ')).toBe('a b c d e');
  });
});
