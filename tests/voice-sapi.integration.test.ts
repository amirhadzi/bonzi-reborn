// Real Windows SAPI bridge: spawns the actual PowerShell host. Windows only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SapiHost } from '../src/main/voice/sapi-host.ts';
import { SystemVoiceService } from '../src/main/voice/system-voice-service.ts';
import { parseWav, pcm16Levels } from '../src/main/voice/wav.ts';
import { DEFAULT_SETTINGS } from '../src/shared/settings.ts';
import { sapiRateFor } from '../src/shared/voice-tuning.ts';

const isWindows = process.platform === 'win32';

describe.skipIf(!isWindows)('SAPI host (real System.Speech)', () => {
  const logs: string[] = [];
  const host = new SapiHost({ log: (level, message) => logs.push(`${level}: ${message}`) });
  const service = new SystemVoiceService({ host });
  const marker = path.join(os.tmpdir(), `bonzi-sapi-injection-${process.pid}.txt`);

  afterAll(() => {
    service.dispose();
    fs.rmSync(marker, { force: true });
  });

  it('lists installed voices', async () => {
    const r = await service.listVoices();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.voices.length).toBeGreaterThan(0);
    for (const v of r.voices) {
      expect(typeof v.name).toBe('string');
      expect(v.name.length).toBeGreaterThan(0);
    }
    if (r.voices.some((v) => v.name.startsWith('Microsoft David'))) expect(r.defaultVoice).toMatch(/^Microsoft David/);
  }, 40_000);

  it("synthesizes 'Hello from Bonzi' as a non-silent RIFF/WAVE file", async () => {
    const wav = await host.speak({ text: 'Hello from Bonzi', voice: null, rate: 0, volume: 100 });
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
    expect(wav.toString('latin1', 8, 12)).toBe('WAVE');
    const info = parseWav(wav);
    expect(info).toMatchObject({ sampleRate: 22050, channels: 1, bitsPerSample: 16 });
    const pcm = wav.subarray(info!.dataOffset, info!.dataOffset + info!.dataLength);
    const seconds = pcm.byteLength / 2 / info!.sampleRate;
    expect(seconds).toBeGreaterThan(0.4);
    expect(seconds).toBeLessThan(5);
    const { peak, rms } = pcm16Levels(pcm);
    expect(peak).toBeGreaterThan(0.2);
    expect(rms).toBeGreaterThan(0.02);
  }, 40_000);

  it('produces Bonzi-default audio through the service (tempo compensated)', async () => {
    const r = await service.synthesize({
      text: 'Hello from Bonzi',
      voiceName: DEFAULT_SETTINGS.systemVoiceName,
      rate: DEFAULT_SETTINGS.systemVoiceRate,
      pitch: DEFAULT_SETTINGS.systemVoicePitch,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const natural = await host.speak({ text: 'Hello from Bonzi', voice: null, rate: 0, volume: 100 });
    // SAPI speaks slower (rate < 0) so that playback at the raised pitch sounds normal.
    expect(sapiRateFor(DEFAULT_SETTINGS.systemVoiceRate, DEFAULT_SETTINGS.systemVoicePitch)).toBeLessThan(0);
    expect(r.audio.byteLength).toBeGreaterThan(natural.byteLength);
  }, 40_000);

  it('treats text as data: PowerShell syntax in the text is spoken, never run', async () => {
    const p = marker.replace(/'/g, "''");
    const text = `$(New-Item -ItemType File -Path '${p}') '); New-Item -ItemType File -Path '${p}'; (' <speak>x</speak>`;
    const wav = await host.speak({ text, voice: null, rate: 10, volume: 100 });
    expect(parseWav(wav)).not.toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  }, 40_000);

  it('rejects a voice that is not installed but keeps working', async () => {
    await expect(host.speak({ text: 'Hi', voice: 'No Such Voice 12345', rate: 0, volume: 100 })).rejects.toMatchObject({ code: 'failed' });
    const wav = await host.speak({ text: 'Still here', voice: null, rate: 0, volume: 100 });
    expect(parseWav(wav)).not.toBeNull();
    expect(host.spawnCount).toBe(1);
  }, 40_000);

  it('the host exits on dispose', async () => {
    expect(host.running).toBe(true);
    host.dispose();
    expect(host.running).toBe(false);
    expect(logs.join('\n')).not.toContain('Hello from Bonzi');
  });
});
