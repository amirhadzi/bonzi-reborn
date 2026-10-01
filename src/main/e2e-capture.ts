// Development-only screenshot hook for end-to-end tests. Enabled when the app
// is not packaged and BONZI_E2E_CAPTURE=<dir> is set: captures the agent
// window after it becomes ready and a few seconds after each chat turn ends.

import fs from 'node:fs';
import path from 'node:path';
import type { AppController } from './controller.ts';
import { errorMessage, log } from './logger.ts';

const READY_DELAY_MS = 2_500;
const AFTER_CHAT_DELAY_MS = 3_000;

export function installE2eCapture(controller: AppController, dir: string): void {
  const outDir = path.resolve(dir);
  fs.mkdirSync(outDir, { recursive: true });
  let readyCount = 0;
  let chatCount = 0;

  const capture = async (name: string): Promise<void> => {
    try {
      const png = await controller.agent.capture();
      if (!png) return;
      await fs.promises.writeFile(path.join(outDir, name), png);
      log.info(`[e2e] captured ${name}`);
    } catch (err) {
      log.warn(`[e2e] capture ${name} failed: ${errorMessage(err)}`);
    }
  };

  controller.onAgentReady = () => {
    const name = readyCount++ === 0 ? 'agent-ready.png' : `agent-ready-${readyCount}.png`;
    setTimeout(() => void capture(name), READY_DELAY_MS);
  };
  controller.onChatEvent = (ev) => {
    if (ev.type !== 'done' && ev.type !== 'error') return;
    const n = ++chatCount;
    setTimeout(() => void capture(`agent-chat-${n}.png`), AFTER_CHAT_DELAY_MS);
  };
  log.info(`[e2e] capture enabled: ${outDir}`);
}
