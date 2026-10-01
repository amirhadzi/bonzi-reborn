import { DEFAULT_SETTINGS, LIMITS } from '../../../shared/settings.ts';
import type { SettingsContext } from '../context.ts';
import { card, datalist, group, h, row, setDatalist, textInput, toggle, uid } from '../dom.ts';
import { bindText, bindToggle } from '../fields.ts';
import { isOpenAiHost } from '../lib/format.ts';
import { STT_MODEL_SUGGESTIONS, mergeModelOptions } from '../lib/models.ts';
import type { Section } from './types.ts';

export function listeningSection(ctx: SettingsContext): Section {
  const micRow = row({
    label: 'Microphone',
    description: 'Shows a mic button in the chat bar so you can talk to Bonzi.',
    iconName: 'listening',
  });
  const mic = toggle(uid('mic'), micRow.labelId, micRow.descId);
  micRow.row.append(h('div', { class: 'row-control' }, mic.wrap));

  const sttId = uid('stt');
  const listId = uid('stt-models');
  const list = datalist(listId);
  setDatalist(list, [...STT_MODEL_SUGGESTIONS]);
  const stt = textInput(sttId, { maxLength: LIMITS.modelName, placeholder: DEFAULT_SETTINGS.sttModel, list: listId });
  const sttRow = row({
    label: 'Transcription model',
    description: 'Turns your speech into text.',
    forId: sttId,
    control: h('div', { class: 'inline' }, stt, list),
  });
  stt.setAttribute('aria-describedby', sttRow.descId);
  bindText(ctx, stt, (s) => s.sttModel, {
    write: (v) => (v.trim() ? { sttModel: v.trim() } : null),
    after: (s) => {
      sttRow.desc.textContent = isOpenAiHost(s.baseUrl)
        ? 'Turns your speech into text. gpt-transcribe is the most accurate.'
        : 'Turns your speech into text. Many OpenAI-compatible servers only offer whisper-1.';
    },
  });
  ctx.onModels((m) => setDatalist(list, mergeModelOptions(m.stt, STT_MODEL_SUGGESTIONS)));

  bindToggle(ctx, mic, (s) => s.micEnabled, (on) => ({ micEnabled: on }), (s) => {
    stt.disabled = !s.micEnabled;
  });

  const privacy = card(
    row({
      label: 'Your privacy',
      description:
        'Bonzi never listens in the background. Audio is recorded only when you use the mic button, and it is sent to your AI provider only to turn it into text. Recordings are not kept.',
      iconName: 'shield',
    }).row,
  );

  const element = h('div', { class: 'page' }, group('Voice input', card(micRow.row, sttRow.row)), group('Privacy', privacy));

  return {
    id: 'listening',
    title: 'Listening',
    subtitle: 'Talk to Bonzi with your microphone.',
    iconName: 'listening',
    element,
    onShow: () => {
      if (ctx.settings.hasApiKey) void ctx.loadModels(false);
    },
  };
}
