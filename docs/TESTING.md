# Testing BonziBuddy Reborn

There are three layers of tests:

1. **Unit tests** (vitest) for pure logic: the ACS parser, settings validation, layout math, the tag parser and sentence splitter, lip-sync mapping, the AI client, the engine scheduler, IPC validation and so on.
2. **The mock OpenAI server** (`scripts/mock-openai.mjs`), a local stand-in for every OpenAI endpoint the app uses. Unit tests and the E2E runner both talk to it, so no real key or network access is ever needed.
3. **End-to-end tests** (`scripts/e2e.mjs`), which launch the real, built Electron app and drive it through the Chrome DevTools Protocol (CDP).

## Unit tests

```bash
npm test                                  # vitest run, all tests in tests/
npx vitest run tests/agent-tags.test.ts   # one file
npx vitest                                # watch mode
npm run typecheck                         # tsc --noEmit over src/, scripts/*.ts and tests/
```

Unit tests never start Electron. Code under `src/main/ai/` is pure Node (it must not import `electron`) so the AI client is tested against the mock server in-process.

## Mock OpenAI server

Full reference: [docs/MOCK-OPENAI.md](MOCK-OPENAI.md). The short version:

```bash
npm run mock:openai                     # http://127.0.0.1:8787/v1
node scripts/mock-openai.mjs --port 0   # ephemeral port
```

Point the app at `http://127.0.0.1:8787/v1` with any key (`sk-bad` is always rejected with 401). Put a magic phrase in a chat message to provoke behaviour: `trigger 429`, `trigger quota`, `trigger 500`, `trigger slow`, `trigger long`, `trigger badparam`, `trigger hang` (add `once` to fire a single time). `GET /__mock/requests` shows what the app sent (without the Authorization header).

## End-to-end tests

```bash
npm run e2e                               # build, then run every scenario
node scripts/e2e.mjs --scenario chat      # one scenario (repeatable or comma separated)
node scripts/e2e.mjs --list               # list scenarios
node scripts/e2e.mjs --no-build           # reuse the current dist/
node scripts/e2e.mjs --keep-open --scenario startup   # leave the app + mock running to poke at
```

Requirements: `node_modules/electron/dist/electron.exe` must exist (run `npx electron --version` once after `npm install`, since Electron 42+ no longer downloads it on install). The runner builds with `node scripts/build.mjs` first unless `--no-build` is given, then checks that `dist/main/main.cjs`, `dist/preload/agent.cjs` and `dist/renderer/agent/index.html` exist.

| Option | Meaning |
| --- | --- |
| `--scenario <name>` | Run only matching scenarios. A name also selects its sub-scenarios (`errors` runs `errors` and `errors-auth`). |
| `--list` | Print the scenarios with their launch profile and exit. |
| `--no-build` | Skip `scripts/build.mjs`. |
| `--app <dir>` | Launch a different Electron app directory (used for the harness self-test below). Implies `--no-build`. |
| `--keep-open` | After the run, leave the last app instance and the mock running and print the CDP and mock URLs. Ends when the app exits or on Ctrl+C. |
| `--headed` | Default and currently the only mode: the app shows its windows normally. |
| `--audible` | Do not pass `--mute-audio` to Electron (by default TTS playback is muted; Web Audio timing still runs normally). |
| `--tts-speed <n>` | `ttsSpeed` written into the test settings (default `2`, which halves the mock's speech length). |
| `--chunk-delay <a-b>` | Mock delay between streamed chat chunks in ms (default `10-20`). |
| `--settings <json>` | Extra `settings.json` fields merged into every launch profile, for example `--settings '{"balloonStyle":"classic","scale":2}'`. |

Exit code: `0` when every scenario and every global check passed, `1` on any failure, `2` when the runner itself could not start (build failed, Electron missing, bad option). Set `E2E_VERBOSE=1` to print each step as it happens.

### How it works

1. The mock server is started **in-process** on an ephemeral port (`startMockServer({ port: 0 })`).
2. Scenarios are grouped by **launch profile**. Each launch gets a **fresh, isolated userData dir** (`.scratch/e2e/run-<n>/<nn>-<profile>/userdata`) with a pre-written `settings.json`: `schemaVersion: 1`, `baseUrl` = the mock, `voiceMode: 'openai'`, `idleAnimations: true`, `idleChatter: false`, `position: null`, `hotkey: ''` (so a test never grabs your global hotkey), `firstRunComplete` and the rest per profile.
3. Electron is started as `electron.exe . --remote-debugging-port=<free port> --remote-allow-origins=* --mute-audio` with `BONZI_USER_DATA=<dir>` (honoured only by unpackaged builds) and the API key in `OPENAI_API_KEY` (the env key source, so nothing is ever written to `credentials.bin`). The runner removes `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `BONZI_USER_DATA` and `BONZI_E2E_CAPTURE` from the inherited environment first, so your real key can never reach a test run. stdout and stderr go to `<launch dir>/electron.log`.
4. `scripts/lib/cdp.mjs` polls `http://127.0.0.1:<port>/json/list` until a page target at `app://bonzi/agent/` appears, connects over WebSocket (Node's global `WebSocket`, no dependencies) and enables Runtime, Log and Page. Uncaught exceptions, `console.error` and Log errors are collected per scenario. A small recorder is injected into the page that logs every `body[data-state]` change and every balloon text change with timestamps, so short states such as `thinking` are never missed by polling.
5. Interaction is real input: `Input.dispatchMouseEvent` for clicks on an opaque pixel of Bonzi (found with `__bonziDebug.character.hitTest`, else from canvas pixels), `Input.insertText` for typing and `Input.dispatchKeyEvent` for Enter. These events go straight to the renderer, so they work although the transparent window ignores OS mouse events.
6. Screenshots use `Page.captureScreenshot` (PNG, `captureBeyondViewport: false`). The transparent background is preserved, and each PNG is decoded (`scripts/lib/e2e-png.mjs`) to record opaque-pixel statistics in the summary.
7. Cleanup: the Electron process tree is killed with `taskkill /T /F` after each profile, on errors and on Ctrl+C. A detached watchdog (`scripts/lib/e2e-watchdog.mjs`) also kills Electron if the runner itself is force-terminated.

### What the app must provide (DOM and debug contract)

The runner relies on these, as specified for the agent window:

* `canvas#character` inside `div#stage`.
* `div#balloon` (with the `hidden` attribute when not shown) containing `div#balloon-text`.
* `div#chat-bar` (hidden when closed) containing `input#chat-input`, `button#chat-send`, `button#chat-mic`.
* `__bonziDebug.audioLog` (dev builds only): one entry per playback attempt, `{ engine: 'openai' | 'system' | 'paced', outcome: 'ended' | 'stopped' | 'failed', durationMs, peakRms, chars, at }`. `peakRms` is the highest RMS the lip-sync AnalyserNode saw, so it proves audio really played (it is non-zero even with `--mute-audio`, which mutes only the output device).
* `document.body.dataset.state`: one of `loading`, `showing`, `idle`, `thinking`, `speaking`, `listening`, `transcribing`, `hiding`, `hidden`, `error`.
* When `AppInfo.isPackaged === false`: `window.__bonziDebug = { character, getState(), speechLog, lastError, playAnimation(name) }`, where `speechLog` is `Array<{ text, gestures, at }>` (one entry per spoken sentence, tags already removed) and `lastError` is the most recent `AiError` (read on every poll, so a getter or a reassigned property both work).
* Optional: `__bonziDebug.runCommand(cmd: AppCommand)` (or `dispatchCommand`). If present, the `commands` scenario also tests the local "What time is it?" quick action.

### Scenarios

| Scenario | Profile | What it checks |
| --- | --- | --- |
| `startup` | default | `body[data-state]` reaches `idle` within 20 s of launch; `canvas#character` sits in `#stage` and has opaque pixels; all DOM contract elements exist and the chat bar starts hidden; `AppInfo.isPackaged` is false; `__bonziDebug` is exposed; screenshot. |
| `chat` | default | Clicks Bonzi, types a message, presses Enter. State goes `thinking` then `speaking`; the reply balloon itself is shown (open, not fading out, and showing a line that `speechLog` recorded after the send, so the fading greeting can never satisfy it; mid-speech screenshot). The balloon rules live in `scripts/lib/e2e-balloon.mjs` and are unit-tested in `tests/e2e-balloon.test.ts`. The mock got `POST /v1/chat/completions` with `stream: true`, `store: false`, an Authorization header and no API key in the body; TTS calls `POST /v1/audio/speech` with `response_format: "wav"` and no `[[tags]]` in the input. Back to `idle`; `speechLog` gained items with gestures such as Wave or Pleased; no `[[tags]]` ever appeared in the balloon or speech text. |
| `interruption` | default | Sends `trigger slow`, then a second message right away. The first request is aborted by the client (mock records `completed: false`), the second completes and is spoken, and the cancelled reply is never spoken. |
| `errors` | default | `trigger 429` gives `lastError.kind === 'rate-limit'`, `trigger quota` gives `quota` with exactly one request (never retried), `trigger 500` gives `server`. Each shows a balloon message (warned if it looks like raw JSON) and gets a screenshot. |
| `commands` | default | `__bonziDebug.playAnimation('Wave')` draws WAVE frames (observed through `character.onFrame`); an unknown animation name does not throw. The time quick action is tested only if a command hook is exposed (see above), since AppCommands normally come from the main process (tray, context menu) and cannot be sent from the renderer. |
| `security` | default | In the agent renderer: no `require`, `process`, `module` or `Buffer`; `fetch` to an external URL and to the mock base URL are both rejected with a CSP `connect-src` violation; `eval` is blocked by CSP; CSP meta tag present; `window.bonzi` has exactly the documented keys and nested functions and nothing named like ipc/electron/process; `window.open` creates no window; `location.href = ...` does not navigate away from `app://bonzi/agent/`; none of this reached the mock. Probes use the reserved `.invalid` TLD so nothing leaves the machine even if a guard is missing. |
| `exit` | default | `window.bonzi.app.quit()` makes the process exit within 8 s (exit code 0 is a warning-level check). |
| `first-run` | first-run | `firstRunComplete: false` with the env key: intro text appears in the balloon (screenshot), no chat API call is made, the intro PLAYED audio with the OpenAI voice (`audioLog` entry with `engine: 'openai'`, `outcome: 'ended'`, `peakRms` above 0.005), `settings.json` gets `firstRunComplete: true`, no settings window opens. |
| `errors-auth` | bad-key | `OPENAI_API_KEY=sk-bad`: chatting gives `lastError.kind === 'auth'` and an explanatory balloon that PLAYED audio with the Windows voice; the bad key never appears in a request body. |
| `no-key` | no-key | No key anywhere: the greeting and the local no-key line PLAYED audio with the Windows voice (`engine: 'system'`), the settings window target (`app://bonzi/settings/`) appears and is screenshotted, it exposes `window.bonziSettings` and no `require`, and no AI request reaches the mock. |
| `first-run-no-key` | first-run-no-key | `firstRunComplete: false` and no key: every intro line PLAYED audio with the Windows voice, no `/v1` request is made, and the settings window opens by itself (the agent opens it when the intro reaches the key line). |
| `voice-off` | voice-off | `voiceMode: 'off'`: the reply shows in the balloon and the app returns to idle without any `POST /v1/audio/speech`, and `audioLog` contains only `paced` entries (no audio engine was used). |

After all scenarios, global checks run over everything the mock recorded: only known endpoints were called, every `/v1` request carried an Authorization header, and the API key never appeared in a body, header or query. Each launch's `electron.log` and its whole userData dir (including the app's own `logs/`) are also scanned for the key; a hit is reported as `key-leak (<profile>)` and fails the run.

Checks are either **hard** (the scenario fails and stops) or **soft** (recorded as a warning, shown in the table and in `summary.json`). Uncaught page exceptions fail a scenario; console errors are warnings.

### Output

Everything goes to `.scratch/e2e/run-<n>/` (n increments per run):

```
run-<n>/
  summary.json                      results, checks, steps, page errors, mock traffic, launches
  mock.log                          one line per mock request
  01-startup-01-idle.png            <scenario index>-<scenario>-<shot index>-<label>.png
  02-chat-01-mid-speech.png
  ...
  02-chat-failure.png               taken automatically when a scenario fails
  01-default/electron.log           app stdout/stderr
  01-default/userdata/              isolated userData (settings.json, logs/, Chromium data)
```

The console prints one line per scenario and a table at the end. Each entry in `summary.json` has `checks` (name, ok, soft, detail), `notes`, `steps` (timestamped actions), `screenshots` (with opaque pixel stats), `pageErrors` and, on failure, `error` and `uiAtFailure` (state, balloon, chat bar, speechLog length, lastError).

### Harness self-test (fixture app)

`.scratch/e2e/fixture/` is a throwaway Electron app that implements the DOM contract, a fake state machine, the `window.bonzi` preload surface, the `app://` protocol with the CSP header, navigation and popup guards, and real chat streaming and TTS against the mock. It exists so the runner can be verified without the real app:

```bash
node scripts/e2e.mjs --app .scratch/e2e/fixture
FIXTURE_INSECURE=1 node scripts/e2e.mjs --app .scratch/e2e/fixture --scenario security   # must FAIL (no popup/navigation guards)
FIXTURE_LEAK=1 node scripts/e2e.mjs --app .scratch/e2e/fixture --scenario startup        # must FAIL with key-leak
node scripts/e2e.mjs --app .scratch/e2e/fixture --scenario startup --settings '{"fixtureStuck":true}'   # must FAIL (never idle)
```

### Not covered (manual or future work)

* Tray menu, native context menu, global hotkey and second-instance behaviour (all driven by the main process or the OS).
* Microphone recording and STT (`listening` / `transcribing`), since there is no audio input in a test run. The mock does support `POST /v1/audio/transcriptions`.
* Dragging the window, multi-monitor clamping and DPI changes.
* Which Windows voices exist differs per machine; the e2e checks only need one working SAPI voice (any Windows 10/11 install has Microsoft David or Zira). On a PC without System.Speech the Windows-voice checks fail, which is the point.
* `tests/voice-sapi.integration.test.ts` (part of `npx vitest run`, skipped off Windows) spawns the real PowerShell host, lists voices, synthesizes "Hello from Bonzi" and checks for a RIFF/WAVE header and non-silent samples, and checks that PowerShell syntax in the text is spoken, never executed.
* Network isolation of the main process beyond the mock: the global checks prove the app sent only expected requests to the mock and never the key, but not that it contacted no other host.
* The packaged build: E2E needs an unpackaged build because `BONZI_USER_DATA` and `__bonziDebug` are disabled when packaged. See the packaging smoke test in docs/ARCHITECTURE.md.

### Troubleshooting

* **Stuck at `loading`**: the agent renderer did not boot. Look at `pageErrors` in `summary.json` and at `electron.log`. Screenshots of a window that has never been shown time out, which is recorded as a note.
* **`chat bar did not open after clicking Bonzi 3 times`**: the click handler did not react to a click on an opaque pixel. Check `steps` for the clicked coordinates and whether `__bonziDebug.character.hitTest` agrees with what is drawn.
* **Another instance is running**: each launch uses its own userData dir, so the single-instance lock does not collide with your normal copy of the app.
* **Leftover processes**: the watchdog kills Electron within about a second if the runner dies; `taskkill /im electron.exe /f` is the manual fallback (it also kills any other Electron app).

## Real-input QA (Windows)

`npm run qa:input` builds the app and runs `scripts/qa-real-input.mjs`, which drives the real
mouse and keyboard with `SendInput`, the way a person would. It checks hover detection
(click-through on and off), left click (chat bar), Esc, right click (context menu), tray
right clicks, dragging with exact grab offset, and main-thread latency while hovering
(`WM_NULL` pings). The CDP-based e2e suite cannot catch input bugs, because DevTools input
bypasses Windows; this harness exists because of exactly such a bug (see STATUS.md).

It moves your mouse for about 45 seconds. Keep your hands off it: before every click the
harness verifies the pointer is where it placed it and aborts instead of clicking anywhere
unintended. Windows 10 moves a new app's tray icon into the hidden-icons overflow after a
short while, after which the tray checks report the icon as not located (not an app bug).
