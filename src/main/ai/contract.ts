// Contract between the main-process shell (windows, IPC, storage) and the
// AI service (src/main/ai/). The shell owns persistence and secrets; the AI
// service owns HTTP, streaming, prompts and conversation state.

import type {
  ChatEvent,
  ChatSendRequest,
  ChatSendResult,
  ConnectionTestResult,
  ModelListResult,
  SttRequest,
  SttResult,
  TtsRequest,
  TtsResult,
} from '../../shared/ipc.ts';
import type { Settings } from '../../shared/settings.ts';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** ISO timestamp */
  at: string;
}

export interface AiConfigSnapshot {
  settings: Settings;
  /** null when no key is configured; the service then fails fast with kind 'no-key'. */
  apiKey: string | null;
}

export interface CharacterInfo {
  name: string;
  /** All animation names in the loaded ACS file. */
  animations: string[];
}

export interface AiServiceOptions {
  /** Called for every request so settings / key changes apply immediately. */
  getConfig: () => AiConfigSnapshot;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Called after the history changes (append, reset, trim) so the shell can persist it. */
  onHistoryChanged?: (history: ChatMessage[]) => void;
  /** Optional diagnostic logger. Must never receive the API key. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

export interface AiService {
  setCharacterInfo(info: CharacterInfo): void;

  /**
   * Starts a streaming chat turn and returns immediately with a requestId
   * (or an error such as 'no-key'). Events for the turn are delivered via emit:
   * exactly one 'start', zero or more 'delta', then exactly one 'done' or 'error'.
   * Starting a new turn cancels any active one (which ends with error kind 'cancelled').
   */
  sendChat(req: ChatSendRequest, emit: (ev: ChatEvent) => void): ChatSendResult;
  cancelChat(requestId?: string): void;

  resetConversation(): void;
  getHistory(): ChatMessage[];
  setHistory(history: ChatMessage[]): void;

  synthesize(req: TtsRequest): Promise<TtsResult>;
  transcribe(req: SttRequest): Promise<SttResult>;
  listModels(): Promise<ModelListResult>;
  testConnection(): Promise<ConnectionTestResult>;

  /** Aborts all in-flight requests (app shutdown). */
  dispose(): void;
}

// Implemented in src/main/ai/index.ts:
// export function createAiService(options: AiServiceOptions): AiService;
