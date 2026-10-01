import type { ReasoningEffort } from '../../../shared/settings.ts';
import { DEFAULT_SETTINGS, LIMITS } from '../../../shared/settings.ts';
import type { SettingsContext } from '../context.ts';
import { button, card, datalist, group, h, numberInput, row, select, setDatalist, status, textArea, textInput, toggle, uid } from '../dom.ts';
import { bindNumber, bindSelect, bindText, bindToggle } from '../fields.ts';
import { errorText, friendlyAiError, hostOf, plural } from '../lib/format.ts';
import { REASONING_OPTIONS, mergeModelOptions } from '../lib/models.ts';
import type { Section } from './types.ts';

export function brainSection(ctx: SettingsContext): Section {
  // --- Chat model combobox
  const modelId = uid('chat-model');
  const listId = uid('chat-models');
  const list = datalist(listId);
  const modelInput = textInput(modelId, { maxLength: LIMITS.modelName, placeholder: DEFAULT_SETTINGS.chatModel, list: listId });
  const refresh = button('Refresh models', 'secondary', 'refresh');
  const modelStatus = status();
  const modelRow = row({
    label: 'Chat model',
    description: 'Type a model id or pick one from the list. Fast, low-cost models feel the most like Bonzi.',
    forId: modelId,
    stack: true,
    control: h('div', { class: 'stack' }, h('div', { class: 'inline' }, modelInput, list, refresh), modelStatus.el),
  });
  modelInput.setAttribute('aria-describedby', modelRow.descId);
  bindText(ctx, modelInput, (s) => s.chatModel, {
    write: (v) => (v.trim() ? { chatModel: v.trim() } : null),
  });
  ctx.onModels((m) => setDatalist(list, mergeModelOptions(m.chat, [DEFAULT_SETTINGS.chatModel])));

  const loadModels = async (force: boolean): Promise<void> => {
    if (!ctx.settings.hasApiKey) {
      modelStatus.set('info', 'Add your API key on the OpenAI account page to load the model list.');
      return;
    }
    refresh.disabled = true;
    modelStatus.set('busy', 'Loading models...');
    try {
      const r = await ctx.loadModels(force);
      if (r.ok) modelStatus.set('success', `${plural(r.models.chat.length, 'chat model')} loaded.`);
      else modelStatus.set('error', friendlyAiError(r.error, hostOf(ctx.settings.baseUrl)));
    } catch (e) {
      modelStatus.set('error', errorText(e, 'Could not load the model list.'));
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener('click', () => void loadModels(true));

  // --- Reasoning effort
  const effortId = uid('effort');
  const effort = select(effortId, REASONING_OPTIONS);
  const effortRow = row({
    label: 'Reasoning effort',
    description: 'How long the model thinks before answering. Values a model does not support are adjusted automatically.',
    forId: effortId,
    control: effort,
  });
  effort.setAttribute('aria-describedby', effortRow.descId);
  bindSelect(ctx, effort, (s) => s.reasoningEffort, (v) => ({ reasoningEffort: v as ReasoningEffort }));

  // --- Max reply tokens
  const tokensId = uid('tokens');
  const tokens = numberInput(tokensId, LIMITS.maxReplyTokens.min, LIMITS.maxReplyTokens.max, 50);
  const tokensRow = row({
    label: 'Max reply tokens',
    description: 'Upper limit for each answer. 0 means no limit.',
    forId: tokensId,
    control: tokens,
  });
  tokens.setAttribute('aria-describedby', tokensRow.descId);
  bindNumber(ctx, tokens, (s) => s.maxReplyTokens, (n) => ({ maxReplyTokens: n }), LIMITS.maxReplyTokens.min, LIMITS.maxReplyTokens.max);

  // --- History size
  const histId = uid('history');
  const hist = numberInput(histId, LIMITS.historyMessages.min, LIMITS.historyMessages.max);
  const histRow = row({
    label: 'Conversation memory',
    description: `How many recent messages Bonzi sees (0 to ${LIMITS.historyMessages.max}). More context costs more per message.`,
    forId: histId,
    control: hist,
  });
  hist.setAttribute('aria-describedby', histRow.descId);
  bindNumber(ctx, hist, (s) => s.historyMessages, (n) => ({ historyMessages: n }), LIMITS.historyMessages.min, LIMITS.historyMessages.max);

  // --- Remember conversations
  const rememberId = uid('remember');
  const rememberRow = row({
    label: 'Remember conversations',
    description: 'Keep the chat between restarts. Stored encrypted on this PC.',
  });
  const remember = toggle(rememberId, rememberRow.labelId, rememberRow.descId);
  rememberRow.row.append(h('div', { class: 'row-control' }, remember.wrap));
  bindToggle(ctx, remember, (s) => s.rememberConversation, (on) => ({ rememberConversation: on }));

  const clearBtn = button('Clear conversation history', 'secondary', 'trash');
  const clearStatus = status();
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  const resetClear = (): void => {
    if (confirmTimer !== null) clearTimeout(confirmTimer);
    confirmTimer = null;
    clearBtn.classList.remove('btn-danger');
    clearBtn.classList.add('btn-secondary');
    const t = clearBtn.querySelector('.btn-text');
    if (t) t.textContent = 'Clear conversation history';
  };
  const clearRow = row({
    label: 'Forget everything',
    description: 'Erases the current conversation and any saved history. Bonzi starts fresh.',
    control: clearBtn,
  });
  clearBtn.addEventListener('click', async () => {
    if (confirmTimer === null) {
      clearBtn.classList.remove('btn-secondary');
      clearBtn.classList.add('btn-danger');
      const t = clearBtn.querySelector('.btn-text');
      if (t) t.textContent = 'Click again to confirm';
      confirmTimer = setTimeout(resetClear, 4000);
      return;
    }
    resetClear();
    clearBtn.disabled = true;
    clearStatus.set('busy', 'Clearing...');
    try {
      await ctx.api.clearHistory();
      clearStatus.set('success', 'Conversation history cleared.');
    } catch (e) {
      clearStatus.set('error', errorText(e, 'Could not clear the history.'));
    } finally {
      clearBtn.disabled = false;
    }
  });
  clearBtn.addEventListener('blur', resetClear);

  // --- Your name
  const nameId = uid('name');
  const name = textInput(nameId, { maxLength: LIMITS.userName, placeholder: 'friend' });
  const nameRow = row({
    label: 'Your name',
    description: 'What Bonzi calls you. Leave empty for "friend".',
    forId: nameId,
    control: name,
  });
  name.setAttribute('aria-describedby', nameRow.descId);
  name.setAttribute('spellcheck', 'false');
  bindText(ctx, name, (s) => s.userName, { write: (v) => ({ userName: v }) });

  // --- Custom instructions
  const instrId = uid('instr');
  const instr = textArea(instrId, LIMITS.customInstructions, 'For example: Keep answers short. I like space facts and bad puns.', 5);
  const instrRow = row({
    label: 'Custom instructions',
    description: 'Added to Bonzi\'s personality. Bonzi will always say he is an AI if asked.',
    forId: instrId,
    stack: true,
    control: instr.wrap,
  });
  instr.input.setAttribute('aria-describedby', instrRow.descId);
  bindText(ctx, instr.input, (s) => s.customInstructions, {
    write: (v) => ({ customInstructions: v }),
    after: () => instr.updateCounter(),
    onInput: () => instr.updateCounter(),
  });

  const element = h(
    'div',
    { class: 'page' },
    group('Model', card(modelRow.row, effortRow.row, tokensRow.row)),
    group('Memory', card(histRow.row, rememberRow.row, clearRow.row, clearStatus.el)),
    group('Personality', card(nameRow.row, instrRow.row)),
  );

  let autoLoaded = false;
  return {
    id: 'brain',
    title: 'Brain',
    subtitle: 'Which model Bonzi thinks with, and what he remembers.',
    iconName: 'brain',
    element,
    onShow: () => {
      if (!autoLoaded && ctx.settings.hasApiKey) {
        autoLoaded = true;
        void loadModels(false);
      }
    },
  };
}
