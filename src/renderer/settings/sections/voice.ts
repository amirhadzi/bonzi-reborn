import type { SystemVoice } from '../../../shared/ipc.ts';
import type { PublicSettings, VoiceMode } from '../../../shared/settings.ts';
import { DEFAULT_SETTINGS, LIMITS } from '../../../shared/settings.ts';
import { playbackRateForPitch } from '../../../shared/voice-tuning.ts';
import { AudioPreview, pickPreviewLine } from '../audio.ts';
import type { SettingsContext } from '../context.ts';
import {
  button,
  card,
  datalist,
  group,
  h,
  note,
  row,
  select,
  setButtonText,
  setDatalist,
  setOptions,
  show,
  slider,
  status,
  textArea,
  textInput,
  toggle,
  uid,
} from '../dom.ts';
import { bindSelect, bindSlider, bindText, bindToggle } from '../fields.ts';
import { icon } from '../icons.ts';
import { errorText, formatMultiplier, formatPercent, friendlyAiError, hostOf } from '../lib/format.ts';
import { OPENAI_VOICES, TTS_MODEL_SUGGESTIONS, isTts1Model, mergeModelOptions, supportsTtsInstructions, voiceSupported } from '../lib/models.ts';
import type { Section } from './types.ts';

const MODES: ReadonlyArray<{ value: VoiceMode; title: string; desc: string; iconName: string }> = [
  { value: 'openai', title: 'OpenAI voice', desc: 'Natural AI voices with style control. Uses your key.', iconName: 'voice' },
  { value: 'system', title: 'Windows voice', desc: 'Built-in Windows voices. Offline and free.', iconName: 'app' },
  { value: 'off', title: 'Text only', desc: 'Bonzi stays quiet and talks in his speech balloon.', iconName: 'info' },
];

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function voiceSection(ctx: SettingsContext): Section {
  // --- Mode radio cards
  const modeName = uid('voice-mode');
  const legendId = uid('legend');
  const radios: HTMLInputElement[] = [];
  const modeCards = MODES.map((m) => {
    const id = uid('mode');
    const descId = uid('mode-desc');
    const input = h('input', { id, class: 'radio-input', attrs: { type: 'radio', name: modeName, value: m.value, 'aria-describedby': descId } });
    radios.push(input);
    input.addEventListener('change', () => {
      if (input.checked) void ctx.save({ voiceMode: m.value });
    });
    return h(
      'label',
      { class: 'radio-card', attrs: { for: id } },
      input,
      h('span', { class: 'radio-card-icon' }, icon(m.iconName)),
      h('span', { class: 'radio-card-text' }, h('span', { class: 'radio-card-title', text: m.title }), h('span', { class: 'radio-card-desc', id: descId, text: m.desc })),
      h('span', { class: 'radio-dot', attrs: { 'aria-hidden': 'true' } }),
    );
  });
  const modeSet = h(
    'fieldset',
    { class: 'radio-cards', attrs: { 'aria-labelledby': legendId } },
    h('legend', { class: 'sr-only', id: legendId, text: 'Voice' }),
    ...modeCards,
  );

  const disclosure = h('p', { class: 'disclosure' }, icon('shield', 'icon icon-sm'), h('span', { text: 'Bonzi is an AI. Voices are AI-generated.' }));

  // --- OpenAI voice
  const ttsModelId = uid('tts-model');
  const ttsListId = uid('tts-models');
  const ttsList = datalist(ttsListId);
  setDatalist(ttsList, [...TTS_MODEL_SUGGESTIONS]);
  const ttsModel = textInput(ttsModelId, { maxLength: LIMITS.modelName, placeholder: DEFAULT_SETTINGS.ttsModel, list: ttsListId });
  const ttsModelRow = row({ label: 'Voice model', description: 'gpt-4o-mini-tts sounds best and follows style instructions.', forId: ttsModelId, control: h('div', { class: 'inline' }, ttsModel, ttsList) });
  ttsModel.setAttribute('aria-describedby', ttsModelRow.descId);
  ctx.onModels((m) => setDatalist(ttsList, mergeModelOptions(m.tts, TTS_MODEL_SUGGESTIONS)));

  const voiceId = uid('voice');
  const voiceSel = select(voiceId, []);
  const voiceRow = row({ label: 'Voice', description: 'Cedar and Marin are the most natural.', forId: voiceId, control: voiceSel });
  voiceSel.setAttribute('aria-describedby', voiceRow.descId);

  const instrId = uid('tts-instr');
  const instr = textArea(instrId, LIMITS.ttsInstructions, 'Describe how Bonzi should sound', 3);
  const instrNote = note('', 'field-hint');
  const instrRow = row({
    label: 'Speaking style',
    description: 'Tone, accent, pace and emotion, in plain words.',
    forId: instrId,
    stack: true,
    control: h('div', { class: 'stack' }, instr.wrap, instrNote),
  });
  instr.input.setAttribute('aria-describedby', `${instrRow.descId}`);

  const speedId = uid('speed');
  const speed = slider(speedId, LIMITS.ttsSpeed.min, LIMITS.ttsSpeed.max, 0.05, formatMultiplier);
  const speedRow = row({ label: 'Speed', description: '1x is normal.', forId: speedId, control: speed.wrap });
  speed.input.setAttribute('aria-describedby', speedRow.descId);
  bindSlider(ctx, speed, (s) => s.ttsSpeed, (v) => ({ ttsSpeed: v }), { min: LIMITS.ttsSpeed.min, max: LIMITS.ttsSpeed.max, step: 0.05 });

  const renderOpenAi = (s: PublicSettings, model: string): void => {
    const tts1 = isTts1Model(model);
    const voices: string[] = [...OPENAI_VOICES];
    if (s.ttsVoice && !voices.includes(s.ttsVoice)) voices.push(s.ttsVoice);
    setOptions(
      voiceSel,
      voices.map((v) => {
        const ok = voiceSupported(model, v);
        return { value: v, label: ok ? capitalize(v) : `${capitalize(v)} (not on tts-1)`, disabled: !ok && v !== s.ttsVoice };
      }),
    );
    voiceSel.value = s.ttsVoice;
    voiceRow.desc.textContent = tts1
      ? voiceSupported(model, s.ttsVoice)
        ? 'tts-1 models support fewer voices.'
        : `${capitalize(s.ttsVoice)} is not available on ${model}. Pick another voice or switch to gpt-4o-mini-tts.`
      : 'Cedar and Marin are the most natural.';
    voiceRow.desc.classList.toggle('row-desc-warning', tts1 && !voiceSupported(model, s.ttsVoice));
    const canStyle = supportsTtsInstructions(model);
    instr.input.disabled = !canStyle;
    instrNote.textContent = canStyle ? '' : `${model} does not support style instructions. They are kept and used again if you switch back.`;
    show(instrNote, !canStyle);
  };

  bindText(ctx, ttsModel, (s) => s.ttsModel, {
    write: (v) => (v.trim() ? { ttsModel: v.trim() } : null),
    onInput: (v) => renderOpenAi(ctx.settings, v.trim() || ctx.settings.ttsModel),
    after: (s) => renderOpenAi(s, ttsModel.value.trim() || s.ttsModel),
  });
  bindSelect(ctx, voiceSel, (s) => s.ttsVoice, (v) => ({ ttsVoice: v }));
  bindText(ctx, instr.input, (s) => s.ttsInstructions, {
    write: (v) => ({ ttsInstructions: v }),
    onInput: () => instr.updateCounter(),
    after: () => instr.updateCounter(),
  });

  // Preview (OpenAI)
  const player = new AudioPreview();
  const previewBtn = button('Preview voice', 'primary', 'play');
  const previewStatus = status();
  const previewRow = row({ label: 'Try it', description: 'Plays a short sample with the settings above.', control: previewBtn });
  let previewing = false;
  const setPreviewing = (on: boolean): void => {
    previewing = on;
    setButtonText(previewBtn, on ? 'Stop' : 'Preview voice');
    previewBtn.querySelector('svg')?.replaceWith(icon(on ? 'stop' : 'play'));
  };
  let previewToken = 0;
  previewBtn.addEventListener('click', async () => {
    if (previewing) {
      previewToken += 1;
      player.stop();
      setPreviewing(false);
      previewStatus.clear();
      return;
    }
    ctx.flushAll();
    const s = ctx.settings;
    if (!s.hasApiKey) {
      previewStatus.set('info', 'Add your API key on the OpenAI account page first, or try a Windows voice.');
      return;
    }
    const token = ++previewToken;
    setPreviewing(true);
    previewStatus.set('busy', 'Generating sample...');
    try {
      const model = ttsModel.value.trim() || s.ttsModel;
      const r = await ctx.api.previewVoice({
        text: pickPreviewLine(),
        model,
        voice: voiceSel.value || s.ttsVoice,
        ...(supportsTtsInstructions(model) && instr.input.value.trim() ? { instructions: instr.input.value } : {}),
      });
      if (token !== previewToken) return;
      if (!r.ok) {
        previewStatus.set('error', friendlyAiError(r.error, hostOf(s.baseUrl)));
        return;
      }
      previewStatus.set('success', 'Playing sample.');
      await player.play(r.audio, ctx.settings.volume);
      if (token === previewToken) previewStatus.clear();
    } catch (e) {
      if (token === previewToken) previewStatus.set('error', errorText(e, 'The sample could not be played.'));
    } finally {
      if (token === previewToken) setPreviewing(false);
    }
  });

  const fallbackRow = row({ label: 'Backup voice', description: 'If the OpenAI voice is unavailable, Bonzi falls back to the Windows voice.', iconName: 'info' });
  const openaiCard = card(ttsModelRow.row, voiceRow.row, instrRow.row, speedRow.row, previewRow.row, previewStatus.el, fallbackRow.row);

  // --- Windows voice (SAPI, rendered to WAV by the main process)
  const shortName = (name: string): string => name.replace(/^Microsoft /, '').replace(/ Desktop$/, '');
  const voiceLabel = (v: SystemVoice): string => {
    const extra = [v.culture, v.gender].filter((x) => x && x !== 'NotSet').join(', ');
    return extra ? `${shortName(v.name)} (${extra})` : shortName(v.name);
  };
  const sysVoiceId = uid('sys-voice');
  const sysVoice = select(sysVoiceId, [{ value: '', label: "Bonzi's default" }]);
  const sysVoiceRow = row({ label: 'Voice', description: 'Looking for Windows voices...', forId: sysVoiceId, control: sysVoice });
  sysVoice.setAttribute('aria-describedby', sysVoiceRow.descId);
  let systemVoices: SystemVoice[] = [];
  let defaultVoice: string | null = null;
  let voicesLoaded = false;
  const renderSystemVoices = (s: PublicSettings): void => {
    const opts = [
      { value: '', label: defaultVoice ? `Bonzi's default (${shortName(defaultVoice)})` : "Bonzi's default" },
      ...systemVoices.map((v) => ({ value: v.name, label: voiceLabel(v) })),
    ];
    if (s.systemVoiceName && !systemVoices.some((v) => v.name === s.systemVoiceName)) {
      opts.push({ value: s.systemVoiceName, label: voicesLoaded ? `${s.systemVoiceName} (not installed)` : s.systemVoiceName });
    }
    setOptions(sysVoice, opts);
    sysVoice.value = s.systemVoiceName;
  };
  bindSelect(ctx, sysVoice, (s) => s.systemVoiceName, (v) => ({ systemVoiceName: v }), renderSystemVoices);
  const refreshVoices = (): void => {
    void ctx.api
      .listSystemVoices()
      .then((r) => {
        voicesLoaded = true;
        if (r.ok) {
          systemVoices = r.voices;
          defaultVoice = r.defaultVoice;
          sysVoiceRow.desc.textContent =
            r.voices.length > 0
              ? 'Voices installed in Windows. They work offline and cost nothing.'
              : 'Windows reports no voices for desktop apps on this PC, so Bonzi will show his words in the balloon instead.';
        } else {
          systemVoices = [];
          defaultVoice = null;
          sysVoiceRow.desc.textContent = `${r.error.message} Bonzi will show his words in the balloon instead.`;
        }
        renderSystemVoices(ctx.settings);
      })
      .catch((e: unknown) => {
        voicesLoaded = true;
        sysVoiceRow.desc.textContent = errorText(e, 'Windows voices could not be loaded.');
      });
  };

  const pitchId = uid('pitch');
  const pitch = slider(pitchId, LIMITS.systemVoicePitch.min, LIMITS.systemVoicePitch.max, 0.05, formatMultiplier);
  const pitchRow = row({ label: 'Pitch', description: "1x is the voice's natural pitch. Bonzi likes it higher.", forId: pitchId, control: pitch.wrap });
  pitch.input.setAttribute('aria-describedby', pitchRow.descId);
  bindSlider(ctx, pitch, (s) => s.systemVoicePitch, (v) => ({ systemVoicePitch: v }), { ...LIMITS.systemVoicePitch, step: 0.05 });

  const rateId = uid('rate');
  const rate = slider(rateId, LIMITS.systemVoiceRate.min, LIMITS.systemVoiceRate.max, 0.05, formatMultiplier);
  const rateRow = row({ label: 'Speed', description: "1x is the voice's normal speed, whatever the pitch.", forId: rateId, control: rate.wrap });
  rate.input.setAttribute('aria-describedby', rateRow.descId);
  bindSlider(ctx, rate, (s) => s.systemVoiceRate, (v) => ({ systemVoiceRate: v }), { ...LIMITS.systemVoiceRate, step: 0.05 });

  const resetSysBtn = button("Use Bonzi's sound", 'secondary');
  const resetSysRow = row({ label: 'Classic Bonzi', description: 'Puts the voice, pitch and speed back to the defaults.', control: resetSysBtn });
  resetSysBtn.addEventListener('click', () => {
    void ctx.save({
      systemVoiceName: DEFAULT_SETTINGS.systemVoiceName,
      systemVoicePitch: DEFAULT_SETTINGS.systemVoicePitch,
      systemVoiceRate: DEFAULT_SETTINGS.systemVoiceRate,
    });
  });

  const sysPlayer = new AudioPreview();
  const sysPreviewBtn = button('Preview voice', 'primary', 'play');
  const sysPreviewStatus = status();
  const sysPreviewRow = row({ label: 'Try it', description: 'Plays a short sample with the settings above.', control: sysPreviewBtn });
  let sysSpeaking = false;
  let sysToken = 0;
  const setSysSpeaking = (on: boolean): void => {
    sysSpeaking = on;
    setButtonText(sysPreviewBtn, on ? 'Stop' : 'Preview voice');
    sysPreviewBtn.querySelector('svg')?.replaceWith(icon(on ? 'stop' : 'play'));
  };
  const stopSysPreview = (): void => {
    sysToken += 1;
    sysPlayer.stop();
    setSysSpeaking(false);
  };
  sysPreviewBtn.addEventListener('click', async () => {
    if (sysSpeaking) {
      stopSysPreview();
      sysPreviewStatus.clear();
      return;
    }
    // Main reads pitch and speed from the saved settings, so save pending slider moves first.
    ctx.flushAll();
    const token = ++sysToken;
    setSysSpeaking(true);
    sysPreviewStatus.set('busy', 'Generating sample...');
    try {
      const r = await ctx.api.previewVoice({ engine: 'system', text: pickPreviewLine(), ...(sysVoice.value ? { voice: sysVoice.value } : {}) });
      if (token !== sysToken) return;
      if (!r.ok) {
        sysPreviewStatus.set('error', r.error.message);
        return;
      }
      sysPreviewStatus.set('success', 'Playing sample.');
      await sysPlayer.play(r.audio, ctx.settings.volume, playbackRateForPitch(Number(pitch.input.value)));
      if (token === sysToken) sysPreviewStatus.clear();
    } catch (e) {
      if (token === sysToken) sysPreviewStatus.set('error', errorText(e, 'The Windows voice could not be played.'));
    } finally {
      if (token === sysToken) setSysSpeaking(false);
    }
  });

  const systemCard = card(sysVoiceRow.row, pitchRow.row, rateRow.row, resetSysRow.row, sysPreviewRow.row, sysPreviewStatus.el);
  const offNote = card(
    row({ label: 'Text only', description: 'Bonzi shows his replies in the speech balloon and moves his mouth while you read. No audio is generated.', iconName: 'info' }).row,
  );

  // --- Shared output
  const volId = uid('volume');
  const vol = slider(volId, 0, 1, 0.01, formatPercent);
  const volRow = row({ label: 'Volume', description: 'For Bonzi\'s voice and sound effects.', forId: volId, control: vol.wrap });
  vol.input.setAttribute('aria-describedby', volRow.descId);
  bindSlider(ctx, vol, (s) => s.volume, (v) => ({ volume: v }), { min: 0, max: 1, step: 0.01 });

  const sfxRow = row({ label: 'Sound effects', description: 'The character\'s built-in sounds, like whooshes and pops.' });
  const sfx = toggle(uid('sfx'), sfxRow.labelId, sfxRow.descId);
  sfxRow.row.append(h('div', { class: 'row-control' }, sfx.wrap));
  bindToggle(ctx, sfx, (s) => s.soundEffects, (on) => ({ soundEffects: on }));

  const openaiGroup = group('OpenAI voice', openaiCard);
  const systemGroup = group('Windows voice', systemCard);
  const offGroup = group('Text only', offNote);

  ctx.bind((s) => {
    for (const r of radios) r.checked = r.value === s.voiceMode;
    show(openaiGroup, s.voiceMode === 'openai');
    show(systemGroup, s.voiceMode === 'system');
    show(offGroup, s.voiceMode === 'off');
    if (s.voiceMode !== 'openai' && previewing) {
      previewToken += 1;
      player.stop();
      setPreviewing(false);
    }
    if (s.voiceMode !== 'system' && sysSpeaking) stopSysPreview();
  });

  const element = h(
    'div',
    { class: 'page' },
    h('section', { class: 'group' }, modeSet, disclosure),
    openaiGroup,
    systemGroup,
    offGroup,
    group('Output', card(volRow.row, sfxRow.row)),
  );

  let voicesRequested = false;
  return {
    id: 'voice',
    title: 'Voice',
    subtitle: 'How Bonzi sounds when he talks.',
    iconName: 'voice',
    element,
    onShow: () => {
      if (!voicesRequested) {
        voicesRequested = true;
        refreshVoices();
      }
      if (ctx.settings.hasApiKey) void ctx.loadModels(false);
    },
  };
}
