# BonziBuddy Reborn

A clean, modern, unofficial recreation of BonziBuddy for Windows. The purple gorilla is back on
your desktop, rendered pixel for pixel from the original Microsoft Agent character file, but this
time he is powered by OpenAI using **your own API key** (BYOK), and he comes without the adware,
the tracking and the "free" toolbar.

<p align="center"><img src="build/icon.png" width="128" height="128" alt="Bonzi"></p>

## Features

- Transparent, always-on-top desktop character with the original animations, idle behaviour
  (he gets bored, yawns and eventually dozes off) and sound effects, drawn crisp at any scale.
- Chat with Bonzi by clicking him or pressing **Ctrl+Shift+B**. Replies stream into a speech
  balloon word by word, in sync with his voice and lip movements.
- Bonzi picks his own gestures while he talks (waves, giggles, explains, thinks) from the
  animations in the character file.
- Three voice modes: OpenAI text-to-speech, the built-in Windows voices, or silent balloon only.
  Bonzi is always audible unless you choose silent: without a key, or when OpenAI speech fails,
  he speaks with the Windows voice.
- Voice input through OpenAI speech-to-text. Recording stops by itself after a short pause, and
  nothing is uploaded if the microphone heard no speech.
- Right-click menu with quick actions: tell me a joke, fun fact, what time is it, any animation,
  stop talking, reset conversation.
- Works with any OpenAI-compatible endpoint (local servers, proxies, other providers).
- Tray icon, global hotkey, remembers where you left him, optional launch at login. The first
  time you hide him, the tray tells you where he went.
- Optional idle chatter (off by default): now and then Bonzi says something unprompted, but never
  while you are away from the PC or it is locked.
- Load other Microsoft Agent characters (`.acs` files).

## Privacy and security

The original BonziBuddy was notorious spyware. This one is built the other way round:

- **No telemetry, no ads, no update pings, no analytics.** The app talks to exactly one host: the
  AI base URL you configure (default `https://api.openai.com/v1`). It contacts no other server.
- **What you say to Bonzi goes to that AI service.** His replies come from it, so everything you
  type or say to him is sent there with your key, and that provider's data policies apply. Bonzi
  says so if you ask him.
- **Your API key stays local.** It is encrypted at rest with Windows DPAPI through Electron's
  `safeStorage` (`credentials.bin` in your user profile), is only ever handled by the main process,
  is never shown to the UI except as its last four characters, is never logged, and is only sent in
  the `Authorization` header to the configured endpoint. If encryption is unavailable the key is
  kept in memory for the current session only. An `OPENAI_API_KEY` environment variable also
  works when no key is saved; the app reads it once at startup and removes it from its own
  environment, so the helper processes it starts never inherit it.
- **Conversations are sent with `store: false`** and history is kept in memory unless you turn on
  "remember conversation".
- **Locked-down windows.** Every renderer is sandboxed with context isolation and no Node.js
  access, pages are served from a private `app://` scheme with a strict Content Security Policy,
  navigation and new windows are blocked, and only microphone access is granted (to the character
  window, audio only). Every IPC message is validated in the main process.
- **Hardened executable.** Electron fuses are flipped at package time: no `ELECTRON_RUN_AS_NODE`,
  no `NODE_OPTIONS`, no `--inspect`, ASAR integrity validation on, the app only loads from its
  ASAR archive, and cookie encryption is on. Packaged builds also ignore
  `--remote-debugging-port` and `--remote-debugging-pipe`.
- Bonzi is an AI and his voice is AI-generated. He will tell you so if you ask.

## Getting started

1. Download the latest release from the
   [Releases page](https://github.com/amirhadzi/bonzi-reborn/releases) (or build one yourself,
   see below):
   - `BonziBuddy-Reborn-Setup-<version>-x64.exe`: installer (per user, no admin needed; you can
     pick the folder and it creates Start menu and desktop shortcuts).
   - `BonziBuddy-Reborn-<version>-x64-portable.exe`: single portable executable, nothing to install.
2. Run it. The builds are not code-signed, so Windows SmartScreen may say "Windows protected your
   PC". Click **More info**, then **Run anyway**.
3. Bonzi introduces himself and opens Settings. Paste your OpenAI API key (create one at
   <https://platform.openai.com/api-keys>) and press **Test connection**.
4. Click Bonzi (or press Ctrl+Shift+B) and say hello. Drag him anywhere; right-click him for the
   menu; use the tray icon to hide, show or quit.

Usage is billed to your own OpenAI account. The defaults favour fast, inexpensive models, and every
model name can be changed in Settings.

Settings live in `%APPDATA%\BonziBuddy Reborn`. Uninstalling (or deleting the portable exe) and
deleting that folder removes everything. The uninstaller also removes the "Start with Windows"
entry if you turned it on.

### Using a custom OpenAI-compatible endpoint

In Settings, set **Base URL** to the server's `/v1` URL (for example `http://127.0.0.1:11434/v1`
for a local server, or your proxy's URL) and enter the key that server expects. HTTPS is required
except for loopback addresses. Then pick models from the list the server reports (or type them):

- Chat uses `POST /chat/completions` with streaming. OpenAI-only extras such as `reasoning_effort`
  are only sent to `api.openai.com`, and parameters a server rejects are dropped automatically.
- Voice output needs `POST /audio/speech`; voice input needs `POST /audio/transcriptions`
  (`whisper-1` is the model name most compatible servers understand). If your server has neither,
  use the System or Off voice mode and type instead of talking.

### Voice modes

| Mode | What you hear | Cost |
| --- | --- | --- |
| OpenAI (default) | Natural AI voice (`gpt-4o-mini-tts`, voice and speaking style configurable) with lip-sync from the audio | Billed per character of speech |
| Windows | A built-in Windows (SAPI) voice, offline, tuned by default to a raised, cartoon-ish pitch in the spirit of the original Bonzi; voice, pitch and speed are adjustable | Free |
| Off | Balloon text only; Bonzi still "talks" with his mouth at reading pace | Free |

In OpenAI mode Bonzi falls back to the Windows voice whenever OpenAI speech is not usable: no key
yet (so the first-run intro is spoken aloud), a rejected key, no credit, a network problem, or a
local line such as an error message. If the Windows voice is not available either, he shows the
words in the balloon at reading pace. Both voices drive the same audio-based lip-sync.

The Windows voice runs in a small hidden Windows PowerShell process that the app starts on first
use and stops on exit, or after 5 minutes without speech (it starts again when needed). It uses `System.Speech` (the classic desktop voices such as Microsoft
David, Zira and Hazel); the newer "natural" voices in Windows Settings are not visible to it.
Bonzi's default is Microsoft David at pitch 1.3x and speed 1.05x, about 4.5 semitones up at a
normal speaking pace.

The microphone button in the chat bar records your voice, then sends the transcript as your
message. Windows must allow desktop apps to use the microphone.

## Building from source

Requirements: Windows 10 or 11 x64, Node.js 24 or newer, npm.

```bash
npm install
npx electron --version   # downloads the Electron binary once (Electron 42+ no longer does this on install)
npm run dev              # build into dist/ and launch the app
```

Useful scripts:

| Command | What it does |
| --- | --- |
| `npm run build` | Bundle main, preloads and renderers into `dist/` with esbuild (source maps on) |
| `npm run watch` | Same, rebuilding on change (restart Electron to pick up main/preload changes) |
| `npm start` | Launch the already built app |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm test` | Unit tests (vitest) |
| `npm run icon` | Regenerate `build/icon.ico`, `build/icon.png` and `build/tray.png` from the character file |
| `npm run dist` | Icons, minified build, then the NSIS installer and portable exe in `release/` |
| `npm run mock:openai` | Start the local mock OpenAI server |
| `npm run e2e` | End-to-end tests against the mock server |
| `npm run acs:dump` | Dump the character's animations to contact sheets (for development) |

`npm run dist` needs network access the first time so electron-builder can fetch the Electron
runtime and NSIS. Builds are unsigned; configure a certificate in `electron-builder.yml` if you
want to sign them.

## Testing without an API key

`scripts/mock-openai.mjs` is a dependency-free stand-in for the OpenAI endpoints the app uses
(streaming chat, speech, transcription, models). It binds to 127.0.0.1 only.

```bash
npm run mock:openai
```

Then set the Base URL to `http://127.0.0.1:8787/v1` and the key to anything, for example
`sk-test-local` (`sk-bad` is always rejected, which is handy for testing key validation). Putting
phrases such as `trigger 429`, `trigger slow` or `trigger long` in a message simulates errors and
edge cases. See [docs/MOCK-OPENAI.md](docs/MOCK-OPENAI.md).

`npm run e2e` builds the app, starts the mock, launches Electron with an isolated profile and runs
scripted scenarios (chat, speech, errors, settings), capturing screenshots of the character
window. See [docs/TESTING.md](docs/TESTING.md) for the scenarios and options.

## Other Microsoft Agent characters

Bonzi is bundled, but any Microsoft Agent 2.x single-file character (`.acs`) should work: open
Settings, go to **Character**, click **Choose .acs file...** and pick the file. Animation names are matched case-insensitively,
and gestures a character does not have are simply skipped, so Bonzi's personality prompt works
with other characters too. Multi-file web characters (`.acf` with separate `.aca` files) are not
supported. Only use character files you have the right to use.

## Project layout

```
src/
  shared/        Pure TypeScript shared by all processes: ACS parser and frame compositor,
                 settings schema, IPC contract, window layout math, gesture catalog
  main/          Electron main process: windows, tray, menus, hotkey, settings and key storage,
                 app:// protocol, IPC, and ai/ (OpenAI client, conversation, persona)
  preload/       Sandboxed preload bridges (window.bonzi, window.bonziSettings)
  renderer/
    agent/       Transparent character window: animation engine, balloon, chat bar, speech, mic
    settings/    Settings window
scripts/         build.mjs (esbuild), make-icon.ts, mock-openai.mjs, e2e.mjs, acs-dump.ts
tests/           Unit tests (vitest)
assets/          Bundled character (Bonzi.acs)
build/           Generated icons and other packaging resources
docs/            Architecture, research notes, ACS format notes, mock server docs
```

`docs/ARCHITECTURE.md` explains how the pieces fit together and the security rules every part
follows.

## Legal

BonziBuddy Reborn is an unofficial, non-commercial fan project. It is not affiliated with,
endorsed by or connected to BONZI Software, Microsoft or OpenAI.

The source code is licensed under the [Apache License 2.0](LICENSE). The original Bonzi
character file (`assets/characters/Bonzi.acs`) and the icons generated from it are included for
preservation and interoperability but are **not** covered by that license: BonziBuddy, the Bonzi
character, his artwork, animations and sounds belong to their respective owners. See
[NOTICE](NOTICE). If you hold rights to this material and want it removed, please open an issue
and it will be taken down. Microsoft Agent is a trademark of Microsoft Corporation. OpenAI is a
trademark of OpenAI.

The software is provided as is, without warranty of any kind. You are responsible for your use of
the OpenAI API and for complying with OpenAI's usage policies.
