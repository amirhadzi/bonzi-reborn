# BonziBuddy Reborn: Architecture

A clean, modern recreation of BonziBuddy as a Windows x64 desktop companion. The character is
rendered from the original Microsoft Agent `.acs` file; conversation, voice and listening are
powered by OpenAI with the user's own API key (BYOK). Any OpenAI-compatible endpoint can be used.

"Clean" is a product requirement: the original BonziBuddy was adware/spyware. This app has no
telemetry, no ads, no auto-update pings, and talks to exactly one host: the configured AI
base URL (default `https://api.openai.com/v1`). The key is encrypted at rest with Windows DPAPI
(Electron `safeStorage`) and never leaves the main process except in the `Authorization` header.

## Stack

- Electron 44, TypeScript 5.9 (strict), esbuild bundling, vitest, electron-builder 26.
- No UI framework. Plain DOM + CSS in renderers. No runtime npm dependencies.
- Node 24 runs `.ts` scripts directly (type stripping), so source uses `.ts` import
  extensions, `import type`, and no enums / namespaces / parameter properties.

## Processes and modules

```
src/
  shared/                      pure TS, no Node/DOM imports unless noted
    acs/                       ACS parser + frame compositor (see docs/ACS-NOTES.md)
    settings.ts                Settings schema, defaults, validation (CONTRACT)
    ipc.ts                     IPC channels + preload API types (CONTRACT)
    layout.ts                  agent window geometry (CONTRACT)
    character-controller.ts    engine <-> conversation interface (CONTRACT, uses DOM types)
    gestures.ts                gesture catalog for the AI prompt + validation
  main/                        Electron main process (CommonJS bundle)
    main.ts                    entry: lifecycle, single instance, security setup
    ai/                        OpenAI client (chat stream, TTS, STT, models), conversation + persona
    ...                        windows, tray, menu, settings store, secrets, protocol, ipc
  preload/
    agent.ts                   exposes window.bonzi (BonziAgentApi)
    settings.ts                exposes window.bonziSettings (BonziSettingsApi)
  renderer/
    agent/                     transparent character window
      character/               animation engine implementing CharacterController
      ...                      bootstrap, balloon, chat bar, speech pipeline, mic, hit test, drag
    settings/                  settings window
    global.d.ts                window.bonzi / window.bonziSettings typings
scripts/                       build.mjs, acs-dump.ts, make-icon.ts, mock-openai.mjs
tests/                         vitest
assets/characters/Bonzi.acs    bundled default character (copied to resources/characters)
build/                         icon.ico and other electron-builder resources (generated)
```

Files under "CONTRACT" are the interfaces between parallel work streams. Change them only
when necessary, keep changes additive where possible, and record the change in the final report.

## Data flow

1. Main starts, loads settings (`userData/settings.json`) and the encrypted key
   (`userData/credentials.bin`), registers the `app://` protocol, creates the agent window.
2. Agent renderer calls `bonzi.loadCharacter()`; main reads the configured `.acs` (bundled
   Bonzi by default), validates it with `parseAcs` and returns the bytes. The renderer parses
   it again locally (lazy image decode) and builds the engine.
3. User clicks Bonzi / presses the hotkey: chat bar opens. On submit, renderer calls
   `bonzi.chat.send({text, source})`. Main appends to history, builds the system prompt
   (persona + gesture catalog + local date/time + user name), streams Chat Completions and
   forwards `ChatEvent`s.
4. Renderer: on `start`, engine `startActivity('thinking')`. Deltas go through the tag
   parser (`[[Animation]]` tags) and the sentence splitter. Each complete sentence becomes a
   speech item `{text, gestures}`; TTS for upcoming sentences is requested ahead (max 2 in
   flight) via `bonzi.tts.synthesize`. Playback is sequential: gesture (if any), then
   `beginSpeaking()`, play audio through an `AnalyserNode`, map loudness to `MouthShape`
   with `setMouth()`, reveal the sentence in the balloon in sync with audio progress,
   `endSpeaking()`.
5. Voice input: mic button / toggle hotkey records with `MediaRecorder` (engine activity
   'listening'), then `bonzi.stt.transcribe`, then sends the text as `source: 'voice'`.
   Recording stops after 1.5 s of silence once speech was heard, or after 8 s if no speech
   was heard at all. When the level meter works and heard nothing (including a manual stop
   before speaking), the result is 'empty' and nothing is uploaded.

## Main process rules

- `app.enableSandbox()`. Every BrowserWindow: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, `webSecurity: true`, `spellcheck: false`, devtools only when not
  packaged.
- Renderer content is served from `dist/renderer` through a privileged `app://bonzi/` scheme
  via `protocol.handle` with path traversal protection and a strict CSP response header:
  `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
  media-src 'self' blob: data:; font-src 'self'; connect-src 'self'; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'`. HTML files also carry the same CSP meta tag.
- Block all navigation (`will-navigate`, `will-redirect`) and window creation
  (`setWindowOpenHandler` deny). External links only through `openExternal(id)` with the fixed
  allowlist in `EXTERNAL_LINKS`.
- Permissions: allow only `media` with audio-only for the agent window's `app://bonzi` origin;
  deny everything else in both the request and check handlers.
- Every IPC handler validates the sender (`event.senderFrame?.url` starts with
  `app://bonzi/` and belongs to the expected window) and validates payload types and sizes
  (`LIMITS` in settings.ts). Never trust renderer input.
- The API key: stored with `safeStorage.encryptString` in `credentials.bin`. If encryption is
  unavailable it is kept in memory for the session only (`apiKeySource: 'session'`). If no key
  is stored, `OPENAI_API_KEY` is used when present (`apiKeySource: 'env'`); it is read once at
  the top of `main.ts` (`takeEnvApiKey`) and deleted from `process.env`, so child processes
  never inherit it. The key
  is never logged, never sent to renderers (only `apiKeyHint` with the last 4 chars), and only
  sent to the configured base URL. Base URL must be https except loopback (`normalizeBaseUrl`).
- Timeouts: chat time-to-first-byte 30 s and total 120 s; TTS 30 s; STT 60 s; models 15 s.
  All requests abortable. One active chat request at a time: a new send cancels the old one.
- Error mapping to `AiError` kinds; auto-retry once without `temperature` /
  `reasoning_effort` / `max_completion_tokens` when the provider rejects an unsupported
  parameter (and remember that for the session per model).
- Electron fuses flipped at package time (RunAsNode off, NodeOptions off, CLI inspect off,
  embedded ASAR integrity on, only load app from ASAR on, cookie encryption on).
- Single instance lock; second launch focuses / shows Bonzi and opens the chat bar.
- Tray icon with: Show/Hide Bonzi, Talk to Bonzi, Settings, Exit. Left click toggles visibility.
  The first time the user hides Bonzi (from any source), the tray shows a one-time balloon
  saying he is still there and how to bring him back (`settings.hideHintShown`, persisted).
- Native context menu on right-click of Bonzi (via `win:context-menu`): Talk to Bonzi..., Tell
  me a joke, Fun fact, What time is it?, Animations submenu (gesture catalog), Stop talking,
  Reset conversation, Settings..., Hide Bonzi, Exit.
- Global hotkey (settings.hotkey) opens the chat bar. Registration failures are reported in
  settings, not fatal. While the settings capture box records a shortcut
  (`settings:hotkey-capture`), main unregisters the global hotkey so the same combination can
  be recorded; capture ends on blur, window close or a settings renderer crash.
- Packaged builds strip `--remote-debugging-port` / `--remote-debugging-pipe` at startup.
- Settings window: normal framed window, 760x640, single instance, opened from tray/menu, or
  on first run without a key by the agent when the intro reaches the key line. Main keeps a
  45 s fallback (`FIRST_RUN_SETTINGS_FALLBACK_MS`) in case the renderer never asks.
- Agent window: `transparent: true`, `frame: false`, `backgroundColor: '#00000000'`,
  `resizable: false`, `hasShadow: false`, `skipTaskbar: true`, `alwaysOnTop` per settings
  (level 'floating' or stronger if research says so), sized by `computeAgentLayout`,
  positioned from `settings.position` via `windowPositionForCharacter`, clamped with
  `clampCharacterToWorkAreas` on start, on drag end and on display changes. Starts with
  `setIgnoreMouseEvents(true, { forward: true })`. `backgroundThrottling: false` so idle
  animations keep running.
- Drag: on `win:drag-start` main records the cursor offset and follows
  `screen.getCursorScreenPoint()` at ~60 Hz until `win:drag-end`, then clamps and persists the
  character position (debounced). A safety timer ends the drag after 10 s without cursor
  movement (`DRAG_IDLE_MS`, re-armed on every move) and sends `{type: 'drag-cancelled'}` to the
  agent.
- Renderer health: the agent window is made click-through again when its renderer is gone,
  unresponsive, or starts a new document; the requested state is restored on `responsive`.
- Power: lock, unlock, suspend and resume are forwarded to the agent as `{type: 'power'}`;
  `app:idle-state` returns `powerMonitor.getSystemIdleState()` (threshold clamped to 60..14400 s).

## Agent renderer rules

- Canvas drawn at device pixel ratio with image smoothing disabled (crisp pixel art at any
  scale). The canvas is placed at `layout.charX/charY`.
- Click-through: the window starts ignoring mouse events with forwarding. On mousemove, hit
  test the current frame (and the balloon / chat bar DOM rects); call
  `setIgnoreMouseEvents(false)` when over something interactive, `true` otherwise.
- Single click on Bonzi: open chat bar (and play a small reaction). Drag (move > 4 px with
  button down) moves the window. Right click: native context menu. Double click: random fun
  animation.
- Balloon: placed above the character when there is screen room (use `window.screenY`,
  `screen.availTop`, etc.), otherwise below; horizontally shifted to stay on screen. Modern
  style by default (rounded, soft shadow, system font, tail pointing at Bonzi), classic style
  uses the ACS balloon colors/font. Text reveals word by word in sync with speech; auto-hides
  a few seconds after speaking. Shows errors in a friendly way.
- Chat bar: single-line input, send button, mic button (if enabled), Esc closes, Enter sends,
  Up recalls the last message. Placed below the character if there is room, else above.
- Tags: `[[Name]]` where Name is in the gesture catalog AND present in the character file are
  played; other tags are stripped silently. Markdown, emoji and URLs are cleaned before TTS.
- Interruptions: clicking Bonzi while he talks, pressing Esc, or sending a new message stops
  current speech (audio + queue) and cancels the in-flight chat request.
- Voice modes: 'openai' (TTS via main), 'system' (Windows SAPI voice rendered to WAV by main,
  see "Windows voice" below), 'off' (balloon only, auto-paced reading speed with mouth flapping).
  Fallback chain per sentence (`speechEngineChain`): 'openai' tries OpenAI TTS (key present, item
  allows it, not failed this turn), then the Windows voice, then paced text; 'system' tries the
  Windows voice, then paced text; 'off' is paced only. Local error lines skip OpenAI so they are
  audible when OpenAI is the problem. Both audio engines play through the same TtsPlayer
  (AnalyserNode lip-sync).
- Idle: engine handles idle animations. Idle chatter (if enabled) sends `source:
  'idle-chatter'` after N minutes without interaction, never while the user is typing or Bonzi
  is busy, nor while the OS reports the user idle or locked (`app.getIdleState(300)`) or a lock
  or suspend `power` command is active. Chatter failures are silent and back off (the wait
  doubles, up to 16x); a successful chatter reply or any real turn resets it. After resume the
  chatter clock restarts.
- First run (`firstRunComplete` false): Show, Greet, introduce himself (local canned text, no
  API call), mention he is the clean version and how to click, right-click and drag him, and if
  no key is configured say so and open settings as that line starts playing; then set
  `firstRunComplete`.
- Without a key: chatting makes Bonzi explain (locally) that a key is needed and open
  settings. Quick action "What time is it?" is answered locally, no API call.

## Windows voice (SAPI bridge)

Electron on Windows exposes no `speechSynthesis` voices, so the Web Speech API is not used.
Instead `src/main/voice/` runs a persistent hidden Windows PowerShell 5.1 host with
`System.Speech.Synthesis.SpeechSynthesizer`:

- Spawned lazily on the first request from
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` (never PATH) with
  `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand <fixed script>`,
  `windowsHide: true`, and an environment without `OPENAI_*`, `BONZI_*` or key/token-like
  variables.
- Line protocol: one JSON object per line each way (`voices`, `speak`), requests serialized, 15 s
  per-request timeout, host restarted after a crash or timeout, back-off after three failed
  starts, killed in `controller.shutdown()`; it also exits by itself when stdin closes. It is
  stopped after 5 minutes without requests (`idleTimeoutMs`) and restarted lazily, so the
  next line after a long pause pays the PowerShell start-up cost again.
- The text only travels as JSON data and reaches `SpeechSynthesizer.Speak(string)` (plain text,
  never SSML); nothing is interpolated into script code. The voice name is resolved against the
  installed list in main before it is sent.
- Output: 22050 Hz 16-bit mono PCM (`SetOutputToAudioStream` with `SpeechAudioFormatInfo`),
  silence-trimmed and wrapped in a WAV header in Node, returned through `tts:synthesize` with
  `engine: 'system'`.
- Pitch: the renderer plays the WAV with `playbackRate = systemVoicePitch`; main asks SAPI for an
  integer rate so the heard speed matches `systemVoiceRate` (`sapiRateFor`, SAPI speed is about
  3^(rate/10)). Voice: `systemVoiceName`, or Microsoft David, else the first en-US male voice,
  else the first en-US voice, else the Windows default.
- Logs never contain spoken text: host error messages are logged with quoted parts removed and
  stderr only as a byte count.

## Testing strategy

- Unit tests (vitest) for the ACS parser, settings validation, layout math, tag parser and
  sentence splitter, lip-sync mapping, AI client (against `scripts/mock-openai.mjs`), engine
  branching logic (with injectable RNG and clock).
- E2E: run the built app with `BONZI_USER_DATA=<dir>` (isolated userData, honoured only when
  not packaged) and a base URL pointing at the mock server; capture the agent window with
  `webContents.capturePage()` when `BONZI_E2E_CAPTURE=<dir>` is set (dev builds only) and
  inspect the PNGs.
- Packaging smoke test: `npm run dist`, launch the portable exe, confirm the process starts and
  the window appears, then close it.

## Decisions from docs/RESEARCH.md (binding)

- Transport: OpenAI **Chat Completions** with `stream: true` and `store: false`, behind an
  adapter interface so a Responses transport can be added later. Send `stream_options`,
  `verbosity` and `reasoning_effort` only when the base URL host is `api.openai.com`, unless
  the user explicitly picked a reasoning effort other than 'auto'. Use
  `max_completion_tokens` (fall back to `max_tokens` if a custom server rejects it).
- Defaults: chat `gpt-6-luna` with `reasoning_effort: "none"`; TTS `gpt-4o-mini-tts`, voice
  `cedar`, with persona `instructions` (not sent to `tts-1*`); STT `gpt-transcribe` (custom base
  URLs often need `whisper-1`; the field is editable). All model ids stay editable and the
  settings UI offers the list from `GET /v1/models` (filter heuristic in RESEARCH.md; show
  everything unfiltered for non-OpenAI hosts).
- Unsupported parameter handling: on 400 with `code` `unsupported_parameter` or
  `unsupported_value`, drop `error.param` (or step reasoning effort) and retry, max 3 times,
  remembering the result per (baseUrl, model) for the session. Regex on the message when
  `param` is null. Normalise non-OpenAI error shapes (`{error: "str"}`, `{detail}`).
- Errors: `insufficient_quota` / spend-limit codes: never retry. Rate limit: retry once if
  `retry-after` <= 5 s, otherwise surface with `retryAfterSec`. `context_length_exceeded`:
  trim history by half and retry once. 5xx / `server_is_overloaded`: one retry with backoff.
  Capture `x-request-id` into `AiError.requestId`. Chat streams may carry an `error` object
  inside a `data:` chunk; treat it as an error event.
- TTS: one request per sentence, max 2 in flight, `response_format: "wav"` (low latency and
  decodable everywhere with `decodeAudioData`), whole-body response returned to the renderer
  as an ArrayBuffer. Input max 4096 chars, speed 0.25 to 4.
- STT: multipart with `file` named `speech.webm` and content type `audio/webm` (MediaRecorder
  `audio/webm;codecs=opus`), `model`, `response_format: "json"`; for `gpt-transcribe` also
  send `keywords[]` = Bonzi, BonziBuddy only when the host is api.openai.com.
- Usage policy: the settings window must state that Bonzi's voice is AI-generated and that
  Bonzi is an AI. Bonzi never claims to be human.
- Agent window extra options: `roundedCorners: false`, `thickFrame: false`, `maximizable`,
  `minimizable`, `fullscreenable` false, `show: false` then `showInactive()`;
  `setAlwaysOnTop(true, 'floating')`. Re-apply ignore-mouse state on `did-finish-load`,
  `render-process-gone` and `display-metrics-changed`. Never toggle ignore-mouse mid-drag.
- `safeStorage` is only usable after `app.whenReady()`.
- Sandboxed preloads must be single-file CommonJS bundles that only `require('electron')`.
- Login item for the portable build must use `process.env.PORTABLE_EXECUTABLE_FILE` as the
  path. Call `app.setAppUserModelId('io.github.amirhadzi.bonzireborn')`.
- Fuses (electron-builder `electronFuses`): runAsNode false, enableCookieEncryption true,
  enableNodeOptionsEnvironmentVariable false, enableNodeCliInspectArguments false,
  enableEmbeddedAsarIntegrityValidation true, onlyLoadAppFromAsar true,
  grantFileProtocolExtraPrivileges false, loadBrowserProcessSpecificV8Snapshot false.
- Do NOT set `signAndEditExecutable: false` (it drops the exe icon and metadata). Unsigned
  builds skip winCodeSign.
- Electron 42+ does not download its binary on `npm install`; run `npx electron --version`
  once (already done on this machine).

## Animation behaviour (from docs/ACS-NOTES.md, binding)

- Names are upper case in records; always look up case-insensitively.
- Placeholders that show only the rest pose for Bonzi: THINKING, PROCESSING, HEARING1-3,
  SUGGEST, DOMAGIC1/2, GETATTENTIONCONTINUED/RETURN, IDLE3_3 and the diagonal/blink LOOK*
  variants. Never use them for visible feedback.
- Activities: thinking = THINK (plays once, about 3 s; if still waiting afterwards, SEARCHING
  loop, exited via SEARCHINGRETURN); listening = STARTLISTENING then hold ALERT, STOPLISTENING
  at the end; processing = THINK; searching = SEARCHING; reading = READ then READING loop then
  READRETURN; writing = WRITE then WRITING loop then WRITINGRETURN; dragging = MOVEUP held on
  its last frame, MOVEUPRETURN on drop.
- Idle: start after about 8 s without activity; level 1 random pick every 6 to 12 s; level 2
  after about 90 s; level 3 (IDLE3_1 yawn, IDLE3_2 doze, endless) after about 5 minutes.
  Any user interaction wakes him (exit the current idle gracefully).
- Speaking: hold the current gesture's last frame when it has mouth overlays, else RESTPOSE
  frame 0. Mouth updates at 10 to 15 Hz from audio loudness with hysteresis.
- Gesture directions are the character's own: GESTURELEFT/LOOKLEFT face the right edge of
  the screen.

## Conventions

- No em dashes anywhere (code, comments, docs, UI strings).
- Keep comments sparse and useful. Strict types, no `any` unless at a validated boundary.
- Never log secrets or full request bodies containing user text at info level.
