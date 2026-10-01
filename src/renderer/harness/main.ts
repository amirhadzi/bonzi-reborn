// Dev harness for the animation engine (served by scripts/harness.mjs).
// Exposes window.__harness for capture scripts.

import { parseAcs } from '../../shared/acs/index.ts';
import type { AcsCharacter } from '../../shared/acs/types.ts';
import type { Activity, LookDirection, MouthShape } from '../../shared/character-controller.ts';
import { createCharacter, DEFAULT_TIMING, type EngineCharacter, type EngineTiming } from '../agent/character/index.ts';

const ACTIVITIES: Activity[] = ['thinking', 'listening', 'processing', 'searching', 'reading', 'writing', 'dragging'];
const LOOKS: LookDirection[] = ['left', 'right', 'up', 'down', 'up-left', 'up-right', 'down-left', 'down-right'];
const MOUTH_NAMES = ['closed', 'wide1', 'wide2', 'wide3', 'wide4', 'medium', 'narrow'];

const FAST_IDLE: Partial<EngineTiming> = {
  idleStartMs: 1_500,
  idleMinGapMs: 800,
  idleMaxGapMs: 1_500,
  idleLevel2Ms: 15_000,
  idleLevel3Ms: 30_000,
};

interface Harness {
  acs: AcsCharacter;
  ch: EngineCharacter;
  setFastIdle(fast: boolean): void;
  setScale(scale: number): void;
  events: string[];
}

declare global {
  interface Window {
    __harness?: Harness;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function input(id: string): HTMLInputElement {
  return $(id) as HTMLInputElement;
}

async function main(): Promise<void> {
  const res = await fetch('/assets/characters/Bonzi.acs');
  if (!res.ok) throw new Error(`failed to load Bonzi.acs: ${res.status}`);
  const acs = parseAcs(await res.arrayBuffer());
  const select = $('sel-scale') as HTMLSelectElement;
  let scale = Number(select.value) || 2;

  const ch = createCharacter(acs, {
    scale,
    idleEnabled: false,
    soundEnabled: input('chk-sound').checked,
    volume: Number(input('rng-volume').value),
  });
  ch.canvas.id = 'character';
  $('stage-checker').appendChild(ch.canvas);

  // Mirrors on dark and light backgrounds copy the live canvas pixel for pixel.
  const mirrors = ['stage-dark', 'stage-light'].map((id) => {
    const c = document.createElement('canvas');
    $(id).appendChild(c);
    return c;
  });
  const syncMirrors = (): void => {
    for (const m of mirrors) {
      m.width = ch.canvas.width;
      m.height = ch.canvas.height;
      m.style.width = ch.canvas.style.width;
      m.style.height = ch.canvas.style.height;
      const ctx = m.getContext('2d');
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, m.width, m.height);
      ctx.drawImage(ch.canvas, 0, 0);
    }
  };

  const events: string[] = [];
  const eventsEl = $('events');
  const log = (line: string): void => {
    events.push(`${(performance.now() / 1000).toFixed(2)}s ${line}`);
    if (events.length > 200) events.splice(0, events.length - 200);
    eventsEl.textContent = events.slice(-40).reverse().join('\n');
  };
  ch.onEvent((e) => {
    if (e.type === 'animation') log(`${e.mode === 'exit' ? 'exit ' : ''}${e.name}`);
    else if (e.type === 'idle') log(`idle L${e.level} ${e.name}`);
    else log(`activity ${e.activity} ${e.phase}`);
  });

  const readout = $('readout');
  const updateReadout = (): void => {
    const f = ch.currentFrame();
    const d = ch.debugState();
    const mouth = f.mouth === null ? '-' : (MOUTH_NAMES[f.mouth] ?? String(f.mouth));
    readout.textContent =
      `${f.animation ?? '(blank)'} #${f.frame} mouth=${mouth} | job=${d.job ?? '-'} queue=${d.queue} ` +
      `held=${d.held ?? '-'} activity=${d.activity ?? '-'} idle=L${d.idleLevel} speaking=${d.speaking} hidden=${d.hidden}`;
    document.body.dataset.state = d.hidden ? 'hidden' : d.speaking ? 'speaking' : 'idle';
  };
  ch.onFrame(() => {
    syncMirrors();
    updateReadout();
  });
  window.setInterval(updateReadout, 250);

  const play = (name: string): void => {
    const now = input('chk-now').checked;
    const p = now ? ch.playNow(name) : ch.play(name);
    void p.then((o) => log(`${name}: ${o}`));
  };

  // Animation buttons
  const grid = $('animations');
  for (const name of ch.animationNames().sort()) {
    const b = document.createElement('button');
    const anim = acs.animationsByName.get(name.toLowerCase());
    const placeholder = !!anim && anim.frames.filter((f) => f.images.length > 0).length <= 1 && name !== 'RESTPOSE';
    b.textContent = `${name}${ch.canSpeakDuring(name) ? ' M' : ''}${placeholder ? ' P' : ''}`;
    if (placeholder) b.className = 'placeholder';
    b.addEventListener('click', () => play(name));
    grid.appendChild(b);
  }

  for (const a of ACTIVITIES) {
    const b = document.createElement('button');
    b.textContent = a;
    b.addEventListener('click', () => ch.startActivity(a));
    $('activities').appendChild(b);
  }
  $('btn-stop-activity').addEventListener('click', () => void ch.stopActivity().then(() => log('activity stopped')));

  for (const d of LOOKS) {
    const b = document.createElement('button');
    b.textContent = d;
    b.addEventListener('click', () => void ch.look(d).then((o) => log(`look ${d}: ${o}`)));
    $('looks').appendChild(b);
  }

  $('btn-show').addEventListener('click', () => void ch.show().then(() => log('shown')));
  $('btn-hide').addEventListener('click', () => void ch.hide().then(() => log('hidden')));
  $('btn-stop').addEventListener('click', () => ch.stopAll());

  // Speaking
  const mouthRange = input('rng-mouth');
  const mouthLabel = $('mouth-label');
  const applyMouth = (): void => {
    const v = Number(mouthRange.value);
    mouthLabel.textContent = v < 0 ? 'none' : (MOUTH_NAMES[v] ?? String(v));
    ch.setMouth(v < 0 ? null : (v as MouthShape));
  };
  mouthRange.addEventListener('input', applyMouth);
  $('btn-speak').addEventListener('click', () => void ch.beginSpeaking().then(() => {
    log('ready to speak');
    applyMouth();
  }));
  let talkTimer = 0;
  const stopTalk = (): void => {
    if (talkTimer) window.clearTimeout(talkTimer);
    talkTimer = 0;
  };
  const talk = (): void => {
    const shapes: Array<MouthShape | null> = [0, 1, 2, 3, 4, 5, 6, 5, 6, null];
    ch.setMouth(shapes[Math.floor(Math.random() * shapes.length)] ?? null);
    talkTimer = window.setTimeout(talk, 70 + Math.random() * 50);
  };
  input('chk-talk').addEventListener('change', () => {
    stopTalk();
    if (input('chk-talk').checked) void ch.beginSpeaking().then(() => input('chk-talk').checked && talk());
  });
  $('btn-unspeak').addEventListener('click', () => {
    stopTalk();
    input('chk-talk').checked = false;
    void ch.endSpeaking();
  });

  // Idle
  const setFastIdle = (fast: boolean): void => {
    ch.setTiming(fast ? FAST_IDLE : DEFAULT_TIMING);
    input('chk-fast').checked = fast;
  };
  input('chk-idle').addEventListener('change', () => ch.setIdleEnabled(input('chk-idle').checked));
  input('chk-fast').addEventListener('change', () => setFastIdle(input('chk-fast').checked));
  $('btn-activity').addEventListener('click', () => ch.notifyUserActivity());

  // Display
  const setScale = (s: number): void => {
    scale = s;
    ch.setScale(s);
    select.value = String(s);
    syncMirrors();
  };
  select.addEventListener('change', () => setScale(Number(select.value) || 1));
  input('chk-sound').addEventListener('change', () => ch.setSoundEnabled(input('chk-sound').checked));
  input('rng-volume').addEventListener('input', () => ch.setVolume(Number(input('rng-volume').value)));

  ch.canvas.addEventListener('mousemove', (ev) => {
    const r = ch.canvas.getBoundingClientRect();
    ch.canvas.style.cursor = ch.hitTest(ev.clientX - r.left, ev.clientY - r.top) ? 'pointer' : 'default';
  });

  window.__harness = { acs, ch, setFastIdle, setScale, events };
  syncMirrors();
  updateReadout();
  log(`loaded ${ch.name} ${ch.width}x${ch.height}, ${ch.animationNames().length} animations, scale ${scale}`);
}

main().catch((err: unknown) => {
  document.body.dataset.state = 'error';
  $('readout').textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
});
