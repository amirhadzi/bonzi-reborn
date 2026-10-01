// Agent window entry point.

import { AgentApp } from './app.ts';
import { createCharacter } from './character/index.ts';

const app = new AgentApp({ api: window.bonzi, createCharacter });
app.start().catch((err: unknown) => {
  console.error('agent window failed to start', err);
  document.body.dataset.state = 'error';
  // Let main show the window anyway so the failure is visible.
  void window.bonzi?.window.ready().catch(() => undefined);
});
