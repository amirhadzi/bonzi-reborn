import { LIMITS, OPENAI_BASE_URL } from '../../../shared/settings.ts';
import type { SettingsContext } from '../context.ts';
import { isEditing } from '../context.ts';
import { button, callout, card, group, h, linkButton, row, show, status, textInput, uid } from '../dom.ts';
import { bindText } from '../fields.ts';
import {
  apiKeyPlaceholder,
  apiKeySourceNote,
  checkApiKeyShape,
  checkBaseUrl,
  errorText,
  formatLatency,
  friendlyAiError,
  hostOf,
  plural,
} from '../lib/format.ts';
import type { Section } from './types.ts';

export function accountSection(ctx: SettingsContext): Section {
  // --- Welcome banner when no key is configured
  const welcome = callout('info');

  // --- API key
  const keyId = uid('key');
  const keyInput = textInput(keyId, { type: 'password', maxLength: 1024 });
  keyInput.setAttribute('autocomplete', 'new-password');
  const saveKey = button('Save key', 'primary');
  const removeKey = button('Remove key', 'secondary');
  const keyStatus = status();
  const keyRow = row({
    label: 'API key',
    description: '',
    forId: keyId,
    stack: true,
    control: h('div', { class: 'stack' }, h('div', { class: 'inline' }, keyInput, saveKey, removeKey), keyStatus.el),
  });
  keyInput.setAttribute('aria-describedby', keyRow.descId);
  keyRow.desc.classList.add('row-desc-icon');

  const updateKeyButtons = (): void => {
    saveKey.disabled = keyInput.value.trim().length === 0;
  };
  keyInput.addEventListener('input', () => {
    updateKeyButtons();
    keyStatus.clear();
  });

  const doSaveKey = async (): Promise<void> => {
    const problem = checkApiKeyShape(keyInput.value);
    if (problem) {
      keyStatus.set('error', problem);
      return;
    }
    const key = keyInput.value.trim();
    saveKey.disabled = true;
    keyStatus.set('busy', 'Saving key...');
    try {
      const s = await ctx.run(() => ctx.api.setApiKey(key));
      keyInput.value = '';
      keyStatus.set('success', s.apiKeySource === 'session' ? 'Key saved for this session.' : 'Key saved and encrypted.');
    } catch (e) {
      keyStatus.set('error', errorText(e, 'That key could not be saved.'));
    } finally {
      updateKeyButtons();
    }
  };
  saveKey.addEventListener('click', () => void doSaveKey());
  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void doSaveKey();
    }
  });
  removeKey.addEventListener('click', async () => {
    removeKey.disabled = true;
    keyStatus.set('busy', 'Removing key...');
    try {
      await ctx.run(() => ctx.api.setApiKey(null));
      keyStatus.set('success', 'Key removed from this PC.');
    } catch (e) {
      keyStatus.set('error', errorText(e, 'The key could not be removed.'));
      removeKey.disabled = false;
    }
  });

  // --- Links
  const getKey = linkButton('Get an API key');
  const usage = linkButton('Usage');
  const pricing = linkButton('Pricing');
  getKey.addEventListener('click', () => ctx.api.openExternal('openaiKeys'));
  usage.addEventListener('click', () => ctx.api.openExternal('openaiUsage'));
  pricing.addEventListener('click', () => ctx.api.openExternal('openaiPricing'));
  const linksRow = row({
    label: 'OpenAI dashboard',
    description: 'Create keys, check spending and compare model prices. Opens in your browser.',
    control: h('div', { class: 'inline inline-links' }, getKey, usage, pricing),
  });

  // --- Test connection
  const testBtn = button('Test connection', 'secondary', 'plug');
  const testStatus = status();
  const testRow = row({
    label: 'Connection',
    description: 'Checks the key and lists the models it can use.',
    control: testBtn,
  });
  testBtn.addEventListener('click', async () => {
    ctx.flushAll();
    testBtn.disabled = true;
    testStatus.set('busy', 'Testing...');
    const host = hostOf(ctx.settings.baseUrl);
    try {
      const r = await ctx.api.testConnection();
      if (r.ok) {
        const model = ctx.settings.chatModel;
        const base = `Connected in ${formatLatency(r.latencyMs)}. ${plural(r.modelCount, 'model')} available.`;
        if (r.chatModelAvailable) testStatus.set('success', `${base} ${model} is ready to chat.`);
        else testStatus.set('warning', `${base} The chat model ${model} was not found for this key; pick another on the Brain page.`);
        void ctx.loadModels(true);
      } else {
        testStatus.set('error', friendlyAiError(r.error, host));
      }
    } catch (e) {
      testStatus.set('error', errorText(e, 'The connection test failed.'));
    } finally {
      testBtn.disabled = false;
    }
  });

  // --- Advanced: base URL
  const urlId = uid('url');
  const urlInput = textInput(urlId, { maxLength: LIMITS.baseUrl, placeholder: OPENAI_BASE_URL, type: 'url' });
  const urlHint = h('p', { class: 'field-hint' });
  const hostWarning = callout('warning');
  const resetUrl = button('Use OpenAI', 'subtle');
  const urlRow = row({
    label: 'Base URL',
    description: 'Any OpenAI-compatible server. https is required, except for localhost.',
    forId: urlId,
    stack: true,
    control: h('div', { class: 'stack' }, h('div', { class: 'inline' }, urlInput, resetUrl), urlHint, hostWarning.el),
  });
  urlInput.setAttribute('aria-describedby', `${urlRow.descId}`);

  const renderUrlFeedback = (value: string): void => {
    const c = checkBaseUrl(value);
    if (!c.ok) {
      urlInput.setAttribute('aria-invalid', 'true');
      urlHint.textContent = c.message;
      urlHint.className = 'field-hint field-hint-error';
      show(urlHint, true);
      hostWarning.hide();
      return;
    }
    urlInput.removeAttribute('aria-invalid');
    urlHint.textContent = c.hint ?? '';
    urlHint.className = 'field-hint';
    show(urlHint, !!c.hint);
    if (c.isOpenAi) hostWarning.hide();
    else
      hostWarning.set('warning', [
        h('strong', { text: `Your API key and messages will be sent to ${c.host}. ` }),
        document.createTextNode('Only use a server you trust. Model lists are shown unfiltered for other providers.'),
      ]);
    resetUrl.disabled = c.normalized === OPENAI_BASE_URL;
  };
  bindText(ctx, urlInput, (s) => s.baseUrl, {
    write: (v) => {
      const c = checkBaseUrl(v);
      return c.ok ? { baseUrl: c.normalized } : null;
    },
    onInput: renderUrlFeedback,
    after: (s) => {
      if (!isEditing(urlInput)) renderUrlFeedback(s.baseUrl);
    },
  });
  resetUrl.addEventListener('click', () => {
    urlInput.value = OPENAI_BASE_URL;
    renderUrlFeedback(OPENAI_BASE_URL);
    void ctx.save({ baseUrl: OPENAI_BASE_URL });
  });

  const advanced = h(
    'details',
    { class: 'card details' },
    h('summary', { class: 'details-summary' }, h('span', { class: 'details-title', text: 'Advanced' }), h('span', { class: 'details-sub', text: 'Use a different OpenAI-compatible server' })),
    h('div', { class: 'details-body' }, urlRow.row),
  );

  // --- Render
  ctx.bind((s) => {
    keyInput.placeholder = apiKeyPlaceholder(s);
    keyRow.desc.textContent = apiKeySourceNote(s);
    show(keyRow.desc, true);
    removeKey.disabled = !(s.apiKeySource === 'stored' || s.apiKeySource === 'session');
    updateKeyButtons();
    testBtn.disabled = !s.hasApiKey;
    if (!s.hasApiKey) {
      welcome.set('info', [
        h('strong', { text: 'Bonzi needs an API key to talk. ' }),
        document.createTextNode('Create one in your OpenAI dashboard, paste it below and press Save key. You pay OpenAI directly for what you use.'),
      ]);
    } else welcome.hide();
  });
  if (!ctx.settings.baseUrl.startsWith(OPENAI_BASE_URL)) advanced.open = true;

  const element = h(
    'div',
    { class: 'page' },
    welcome.el,
    group('API key', card(keyRow.row, linksRow.row)),
    group('Check', card(testRow.row, testStatus.el)),
    group('Server', advanced),
  );

  return {
    id: 'account',
    title: 'OpenAI account',
    subtitle: 'Bring your own key. It stays on this PC.',
    iconName: 'account',
    element,
  };
}
