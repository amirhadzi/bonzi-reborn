// AI service: OpenAI-compatible client, conversation and persona.
// Pure Node (no electron import) so it can be tested with vitest.

import type { AiError, ChatEvent, ChatSendRequest, ChatSendResult, ChatSource, SttRequest, SttResult, TtsRequest, TtsResult } from '../../shared/ipc.ts';
import { availableGestures, GESTURES } from '../../shared/gestures.ts';
import { LIMITS } from '../../shared/settings.ts';
import type { AiConfigSnapshot, AiService, AiServiceOptions, ChatMessage, CharacterInfo } from './contract.ts';
import { CompatRegistry, runChat } from './chat.ts';
import type { WireMessage } from './chat.ts';
import { Conversation } from './conversation.ts';
import type { Turn } from './conversation.ts';
import { aiError, createAbortScope, DEFAULT_TIMEOUTS, MESSAGES } from './http.ts';
import type { AbortScope, AiTimeouts, FetchLike } from './http.ts';
import { listModels as listModelsImpl, testConnection as testConnectionImpl } from './models.ts';
import { buildSystemPrompt } from './persona.ts';
import { synthesizeSpeech } from './tts.ts';
import { transcribeAudio } from './stt.ts';

export type { AiTimeouts } from './http.ts';
export { buildSystemPrompt, formatLocalDateTime } from './persona.ts';

/** Test and tuning knobs; production code uses the defaults. */
export interface AiServiceTuning {
  timeouts?: Partial<AiTimeouts>;
  /** Delay before the single 5xx retry. Default 800 ms. */
  serverRetryDelayMs?: number;
  /** Rate limits whose retry-after is at most this many seconds are retried once. Default 5. */
  maxRateLimitWaitSec?: number;
  /** IANA zone for the system prompt. Defaults to the system zone. */
  timeZone?: string;
}

const SYNTHETIC: ReadonlySet<ChatSource> = new Set<ChatSource>(['idle-chatter', 'greeting']);
const SOURCES: ReadonlySet<string> = new Set<ChatSource>(['typed', 'voice', 'quick-action', 'idle-chatter', 'greeting']);

interface ActiveChat {
  requestId: string;
  scope: AbortScope;
  turn: Turn;
  emit: (ev: ChatEvent) => void;
  started: boolean;
  finished: boolean;
  text: string;
  historyLimit: number;
}

let idCounter = 0;
function newRequestId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  const rand = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(16).slice(2, 10);
  return `chat_${Date.now().toString(36)}_${idCounter}_${rand}`;
}

export function createAiService(options: AiServiceOptions & { tuning?: AiServiceTuning }): AiService {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
    try {
      options.log?.(level, message);
    } catch {
      // logging must never break the service
    }
  };
  const tuning = options.tuning ?? {};
  const timeouts: AiTimeouts = { ...DEFAULT_TIMEOUTS, ...tuning.timeouts };
  const serverRetryDelayMs = tuning.serverRetryDelayMs ?? 800;
  const maxRateLimitWaitSec = tuning.maxRateLimitWaitSec ?? 5;

  const conversation = new Conversation(options.onHistoryChanged, now);
  const compat = new CompatRegistry();
  const pending = new Set<AbortScope>();
  let character: CharacterInfo | null = null;
  let active: ActiveChat | null = null;
  let disposed = false;

  const config = (): AiConfigSnapshot => options.getConfig();
  const keyOf = (cfg: AiConfigSnapshot): string | null => {
    const k = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    return k ? k : null;
  };
  const noKey = (): AiError => aiError('no-key', MESSAGES.noKey);

  const safeEmit = (chat: ActiveChat, ev: ChatEvent): void => {
    try {
      chat.emit(ev);
    } catch (err) {
      log('warn', `chat: event listener threw (${err instanceof Error ? err.name : 'error'})`);
    }
  };

  const ensureStarted = (chat: ActiveChat): void => {
    if (chat.started) return;
    chat.started = true;
    safeEmit(chat, { type: 'start', requestId: chat.requestId });
  };

  /** Emits the single terminal event and records the turn in the history. */
  const finish = (chat: ActiveChat, outcome: { ok: true; text: string; finishReason: string | null } | { ok: false; error: AiError }): void => {
    if (chat.finished) return;
    chat.finished = true;
    if (active === chat) active = null;
    chat.scope.abort('cancelled'); // stops any remaining network activity; no-op once settled
    chat.scope.dispose();
    pending.delete(chat.scope);
    ensureStarted(chat);
    if (outcome.ok) {
      conversation.complete(chat.turn, outcome.text, chat.historyLimit);
      safeEmit(chat, { type: 'done', requestId: chat.requestId, text: outcome.text, finishReason: outcome.finishReason });
    } else {
      conversation.fail(chat.turn, chat.text, chat.historyLimit);
      safeEmit(chat, { type: 'error', requestId: chat.requestId, error: outcome.error });
    }
  };

  const cancelActive = (requestId?: string): void => {
    const chat = active;
    if (!chat || (requestId !== undefined && chat.requestId !== requestId)) return;
    finish(chat, { ok: false, error: aiError('cancelled', MESSAGES.cancelled) });
  };

  const characterName = (): string => character?.name?.trim() || 'Bonzi';
  const gestures = () => (character ? availableGestures(character.animations) : [...GESTURES]);

  const run = async (chat: ActiveChat, cfg: AiConfigSnapshot, apiKey: string, synthetic: string | null): Promise<void> => {
    await Promise.resolve();
    if (chat.finished) return;
    ensureStarted(chat);
    const settings = cfg.settings;
    const t0 = Date.now();
    const system = buildSystemPrompt({
      characterName: characterName(),
      gestures: gestures(),
      now: now(),
      ...(tuning.timeZone ? { timeZone: tuning.timeZone } : {}),
      userName: settings.userName,
      customInstructions: settings.customInstructions,
      rememberConversation: settings.rememberConversation,
    });
    const buildMessages = (historyLimit: number): WireMessage[] => {
      const msgs: WireMessage[] = [{ role: 'system', content: system }];
      for (const m of conversation.context(chat.turn, historyLimit)) msgs.push({ role: m.role, content: m.content });
      if (synthetic !== null) msgs.push({ role: 'system', content: synthetic });
      return msgs;
    };
    chat.scope.timer(timeouts.chatTotalMs);
    let result;
    try {
      result = await runChat({
        fetch: fetchImpl,
        apiKey,
        settings,
        profile: compat.get(settings.baseUrl, settings.chatModel),
        buildMessages,
        historyLimit: chat.historyLimit,
        scope: chat.scope,
        timeouts,
        serverRetryDelayMs,
        maxRateLimitWaitSec,
        onDelta: (text) => {
          if (chat.finished || !text) return;
          chat.text += text;
          safeEmit(chat, { type: 'delta', requestId: chat.requestId, text });
        },
        log,
      });
    } catch (err) {
      log('error', `chat ${chat.requestId}: unexpected failure (${err instanceof Error ? err.name : 'error'})`);
      result = { ok: false as const, error: aiError('unknown', 'Something went wrong while talking to the AI.'), text: chat.text };
    }
    if (chat.finished) return;
    const ms = Date.now() - t0;
    if (result.ok) {
      log('info', `chat ${chat.requestId}: done in ${ms} ms, ${result.text.length} chars, finish=${result.finishReason ?? 'none'}${result.requestId ? `, x-request-id=${result.requestId}` : ''}`);
      finish(chat, { ok: true, text: chat.text, finishReason: result.finishReason });
    } else {
      log(result.error.kind === 'cancelled' ? 'info' : 'warn', `chat ${chat.requestId}: ${result.error.kind}${result.error.status ? ` (HTTP ${result.error.status})` : ''}${result.error.requestId ? `, x-request-id=${result.error.requestId}` : ''}`);
      finish(chat, { ok: false, error: result.error });
    }
  };

  const withScope = async <T>(fn: (scope: AbortScope) => Promise<T>): Promise<T> => {
    const scope = createAbortScope();
    pending.add(scope);
    try {
      return await fn(scope);
    } finally {
      scope.dispose();
      pending.delete(scope);
    }
  };

  return {
    setCharacterInfo(info: CharacterInfo): void {
      if (!info || typeof info !== 'object') return;
      const name = typeof info.name === 'string' ? info.name.slice(0, 64) : 'Bonzi';
      const animations = Array.isArray(info.animations) ? info.animations.filter((a): a is string => typeof a === 'string') : [];
      character = { name, animations };
    },

    sendChat(req: ChatSendRequest, emit: (ev: ChatEvent) => void): ChatSendResult {
      if (disposed) return { ok: false, error: aiError('cancelled', MESSAGES.cancelled) };
      const source: ChatSource = req && SOURCES.has(req.source) ? req.source : 'typed';
      const text = req && typeof req.text === 'string' ? req.text.trim().slice(0, LIMITS.chatText) : '';
      if (!text) return { ok: false, error: aiError('bad-request', 'The message is empty.') };
      const cfg = config();
      const apiKey = keyOf(cfg);
      if (!apiKey) return { ok: false, error: noKey() };

      cancelActive();
      const synthetic = SYNTHETIC.has(source);
      const historyLimit = Math.max(0, Math.floor(cfg.settings.historyMessages));
      const chat: ActiveChat = {
        requestId: newRequestId(),
        scope: createAbortScope(),
        turn: conversation.begin(synthetic ? null : text),
        emit,
        started: false,
        finished: false,
        text: '',
        historyLimit,
      };
      pending.add(chat.scope);
      active = chat;
      void run(chat, cfg, apiKey, synthetic ? text : null);
      return { ok: true, requestId: chat.requestId };
    },

    cancelChat(requestId?: string): void {
      cancelActive(requestId);
    },

    resetConversation(): void {
      if (active) active.turn.discarded = true;
      cancelActive();
      conversation.reset();
    },

    getHistory(): ChatMessage[] {
      return conversation.get();
    },

    setHistory(history: ChatMessage[]): void {
      conversation.set(history);
    },

    async synthesize(req: TtsRequest): Promise<TtsResult> {
      if (disposed) return { ok: false, error: aiError('cancelled', MESSAGES.cancelled) };
      const cfg = config();
      const apiKey = keyOf(cfg);
      if (!apiKey) return { ok: false, error: noKey() };
      if (!req || typeof req.text !== 'string') return { ok: false, error: aiError('bad-request', 'There is no text to speak.') };
      return withScope((scope) => synthesizeSpeech({ fetch: fetchImpl, apiKey, settings: cfg.settings, req, scope, timeoutMs: timeouts.ttsMs }));
    },

    async transcribe(req: SttRequest): Promise<SttResult> {
      if (disposed) return { ok: false, error: aiError('cancelled', MESSAGES.cancelled) };
      const cfg = config();
      const apiKey = keyOf(cfg);
      if (!apiKey) return { ok: false, error: noKey() };
      if (!req) return { ok: false, error: aiError('bad-request', 'No audio was recorded.') };
      return withScope((scope) => transcribeAudio({ fetch: fetchImpl, apiKey, settings: cfg.settings, req, scope, timeoutMs: timeouts.sttMs }));
    },

    async listModels() {
      if (disposed) return { ok: false, error: aiError('cancelled', MESSAGES.cancelled) };
      const cfg = config();
      const apiKey = keyOf(cfg);
      if (!apiKey) return { ok: false, error: noKey() };
      return withScope((scope) => listModelsImpl({ fetch: fetchImpl, apiKey, settings: cfg.settings, scope, timeoutMs: timeouts.modelsMs }, now()));
    },

    async testConnection() {
      if (disposed) return { ok: false, error: aiError('cancelled', MESSAGES.cancelled) };
      const cfg = config();
      const apiKey = keyOf(cfg);
      if (!apiKey) return { ok: false, error: noKey() };
      return withScope((scope) => testConnectionImpl({ fetch: fetchImpl, apiKey, settings: cfg.settings, scope, timeoutMs: timeouts.modelsMs }));
    },

    dispose(): void {
      if (disposed) return;
      cancelActive();
      disposed = true;
      for (const scope of pending) scope.abort('cancelled');
      pending.clear();
    },
  };
}
