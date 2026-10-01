import type { BonziAgentApi, BonziSettingsApi } from '../shared/ipc.ts';

declare global {
  interface Window {
    /** Exposed by src/preload/agent.ts in the agent window only. */
    bonzi: BonziAgentApi;
    /** Exposed by src/preload/settings.ts in the settings window only. */
    bonziSettings: BonziSettingsApi;
  }
}

export {};
