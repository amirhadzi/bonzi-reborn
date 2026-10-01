# BonziBuddy Reborn: Status

Snapshot after the review fix pass and final integration (2026-10-01). Version 0.1.0, Electron 44.5.1, Windows x64.

## Summary

The app builds, typechecks, passes 532 unit tests and every end-to-end scenario, and packages into an NSIS installer and a portable exe that pass the release audit. A code review raised 34 findings (F01 to F34). All of them are now fixed, with one exception: F04 is fixed except for a narrow Hide, Show, Hide race (see "Known issues"). The packaged portable exe starts, shows Bonzi, opens Settings on a first run without a key, and speaks the intro with the Windows voice.

| Check | Command | Result |
| --- | --- | --- |
| Build | `npm run build` | OK (dev, with source maps) |
| Typecheck | `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| Unit tests | `npx vitest run` | 37 files, 532 tests passed (the SAPI integration file runs on Windows only) |
| End to end | `node scripts/e2e.mjs` | 12/12 scenarios and all 3 global checks (see the note under "How it was verified") |
| Packaging | `npm run dist` | `release/BonziBuddy-Reborn-Setup-0.1.0-x64.exe` (NSIS, 110 MB) and `release/BonziBuddy-Reborn-0.1.0-x64-portable.exe` (110 MB); the new `build/installer.nsh` compiled |
| Release audit | `node scripts/audit-release.mjs` (last step of `dist`) | PASS over 272 files: no local paths, user names in paths, key-shaped strings or test markers |
| Fuses | `npx @electron/fuses read --app release/win-unpacked/BonziBuddyReborn.exe` | RunAsNode, NODE_OPTIONS and CLI inspect off; ASAR integrity, only-load-from-ASAR and cookie encryption on |
| Privacy grep | `dist/` and the extracted `app.asar` | No home path (any slash style), no user name, no `sk-test-local`, no `MOCK_OPENAI`, no `sourceMappingURL` |
| Packaged smoke test | portable exe | Bonzi's layered window appears, the SAPI host starts and synthesizes the intro, `--remote-debugging-port` is ignored |

## What works

- **Character:** the original `Bonzi.acs` is parsed and rendered on a transparent, always-on-top, click-through window. Pixel art stays crisp at scales 1 to 3 and at fractional DPI. The parser enforces hard limits (`ACS_LIMITS`) and decodes shared frames and images only once, so a crafted file cannot exhaust memory during parsing.
- **Animation:** the engine follows MS Agent semantics:
  - Show and Hide, held final frames and wind-back. An interrupted idle winds back quickly, skipping repeated images and capping each frame at 150 ms.
  - Activities (thinking, listening, dragging, and others). A looping activity gives way to queued speech instead of blocking it.
  - Idle levels 1 to 3 and look directions.
  - Speaking on the gesture's own overlay frame. Speech that is still running survives a drag or a `playNow` gesture and resumes on a speaking frame.
  - A gesture's sound effect finishes before Bonzi starts talking (capped at 3 s by `soundTailMaxMs`).
- **Chat:** OpenAI Chat Completions are streamed through the main process. `[[Gesture]]` tags play the gesture, and tags never reach the balloon or TTS. Sentences are spoken in order with TTS (WAV) and lip-sync driven by audio loudness; the analyser taps the signal before the volume control, so the mouth moves at volume 0. The balloon reveals words in step with the audio and widens up front when more text will follow on the same page. A reply that ends with no words gets a short spoken line.
- **Interruptions:** clicking Bonzi, pressing Esc or sending a new message stops audio and the queue and cancels the in-flight request.
- **Errors:** auth, quota, rate-limit, server, network, timeout, model and bad-request errors each get a friendly local line. No-key chat explains the problem locally and opens settings.
- **First run:** the local intro plays (no API call) and mentions click, right-click and drag. Without a key, Settings opens as the line about the key starts playing; main has a 45 s fallback in case the renderer never asks. If the user hides Bonzi during the intro he stays hidden.
- **Visibility:** Hide and Show are robust to late renderer messages (a stale "hidden" after Show is ignored). A Bonzi hidden by the user stays hidden after a renderer reload or crash. The first time Bonzi is hidden, the tray shows a one-time tip saying how to bring him back.
- **Voice:** Bonzi is always audible except in voice mode `off`.
  - `openai`: OpenAI TTS, falling back per sentence to the Windows voice when there is no key, OpenAI speech fails, or the line is a local error line; then to paced text.
  - `system`: a Windows SAPI voice rendered to WAV in main through a hidden PowerShell 5.1 host (`src/main/voice/`), pitch-shifted in the renderer and tempo-compensated in SAPI; then paced text. The host stops after 5 minutes without requests and restarts on demand.
  - `off`: paced balloon text with mouth movement, no audio.
- **Voice input:** recording stops after 1.5 s of silence once speech was heard, or after 8 s if none was heard. Nothing is uploaded when the level meter heard no speech.
- **Idle chatter (opt-in):** never while the OS reports the user idle or locked, or while the PC is locked or suspended (main forwards `power` events). Failures are silent and back off up to 16x.
- **Settings window:** six sections in light and dark, an AI disclosure on every page, an encrypted key (DPAPI) showing only `sk-...last4`, model listing, voice previews, character picker, and hotkey capture that suspends the global shortcut while recording (so the current shortcut can be re-recorded).
- **Focus:** closing the chat bar hands focus back to the previous app.
- **Security and privacy:**
  - sandboxed renderers, a strict CSP header and meta tag;
  - navigation, popups and renderer network access are blocked;
  - the IPC sender and payloads are validated;
  - the key never reaches renderers, logs or request bodies;
  - `OPENAI_API_KEY` is read once at startup and removed from the environment, so the SAPI host never inherits it;
  - packaged builds strip `--remote-debugging-port` and `--remote-debugging-pipe`;
  - a dead or hung renderer leaves the window click-through, so it can never block the desktop;
  - Electron fuses are set as specified;
  - the persona tells users plainly that what they type or say goes to the AI service they connected.
- **Uninstall:** the NSIS uninstaller removes the "Start with Windows" Run and StartupApproved entries (`build/installer.nsh`), but not during an upgrade.

## Review fix pass (F01 to F34)

| Area | Findings | Where |
| --- | --- | --- |
| Engine | F01 queued speech behind looping activities, F02 ACS parser limits and shared decoding, F12 slow wind-back of interrupted idles, F20 speaking state lost after a drag or gesture, F21 sound effects cut by speech | `src/renderer/agent/character/scheduler.ts`, `audio.ts`, `src/shared/acs/parse.ts` |
| Agent UI | F03 Hide/Show race in the renderer, F05 start-up respects a hidden Bonzi, F08 idle chatter back-off, idle and lock awareness, F10 leading numbers kept in speech, F11 mic no-speech timeout, F13 overlays capped to the visible screen, F14 focus release, F16 settings opens with the key line, F22 empty replies, F23 lip-sync at volume 0, F25 intro hints, F26 balloon width | `src/renderer/agent/` |
| Main | F04 stale hidden after Show, F06 ready returns the visibility, F07 click-through on crash, hang and navigation, F09 power events and idle state, F15 release focus, F17 first-run settings fallback, F19 hotkey capture, F27 drag idle timeout, F29 temporarily unavailable custom character, F30 SAPI host idle stop, F31 env key removal, F32 remote debugging stripped | `src/main/` |
| Settings UI | F18 hotkey recorder pauses the global shortcut | `src/renderer/settings/lib/hotkey-recorder.ts`, `sections/app.ts` |
| AI | F24 privacy honesty in the system prompt | `src/main/ai/persona.ts` |
| Build | F33 uninstall removes the Start with Windows entry | `build/installer.nsh`, `electron-builder.yml` |
| E2E | F34 balloon check waits for the reply balloon, not the fading greeting | `scripts/lib/e2e-balloon.mjs`, `scripts/e2e.mjs` |

Contract changes in `src/shared/ipc.ts`:
- New channels: `winReleaseFocus`, `appIdleState`, `settingsHotkeyCapture`.
- New `AppCommand` members: `drag-cancelled` and `power`.
- New methods: `window.releaseFocus()`, `app.getIdleState()` and `BonziSettingsApi.setHotkeyCapture()`.
- `window.ready()` now returns `Promise<AgentReadyResult>`.

`src/shared/settings.ts` gained `hideHintShown`.

Changes made during final integration:
- **F25 (main half):** a one-time tray balloon on the first Hide from any source (tray, context menu, window close). It is persisted in `settings.hideHintShown` and retried if the balloon could not be shown. Code is in `controller.ts` (`#maybeShowHideHint`) and `tray.ts` (`TrayHandle.showHint`), with 3 tests in `tests/main-controller.test.ts`; those tests fail without the hook.
- **Persona length:** the real prompt with all 29 gestures is 2952 characters. A new test keeps the full-gesture prompt under 3100 characters (the old length test only rendered 4 gestures).
- Removed the last literal em dash in the repo (`tests/build-config.test.ts`).
- Docs: ARCHITECTURE (tray tip), TESTING (reply-balloon check), README (privacy of conversations, env key, Windows voice idle stop, debug flags, uninstall cleanup, mic auto-stop, idle chatter, tray tip).

## How it was verified

1. **Unit tests** (vitest, 532) cover the ACS parser and its limits, settings, layout, the AI client against the mock server, SSE, persona and history, and the engine scheduler, behaviour and audio. They also cover tags, sentences, cleaning, lip-sync, placement, and the real `AgentApp` on a fake DOM (26 tests). Further suites cover the speech queue, TTS player, mic, main agent window and controller with fake Electron, IPC validation, storage, protocol and security policy, the hotkey recorder, icons, build config and the e2e balloon rules. Each fixer confirmed that their new tests fail with the fix removed.
2. **E2E** (`scripts/e2e.mjs`, real Electron over CDP against `scripts/mock-openai.mjs`) runs 12 scenarios: startup, chat, interruption, errors, commands, security, exit, first-run, errors-auth, no-key, first-run-no-key and voice-off.
   - Audio played (`__bonziDebug.audioLog`) in first-run (OpenAI voice), errors-auth, no-key and every first-run-no-key line (Windows voice, peak RMS 0.21 to 0.28). Voice-off used no audio engine.
   - Run 32 (all fixes except the final F25 tray tip): 12/12.
   - Run 33 (final code): 11/12. `first-run-no-key` failed only because someone typed a key into the test app's settings window while the run was on screen. Its log shows "API key saved", after which Test connection requests reached the local mock. That scenario's own check, "no AI requests without a key", correctly flagged them.
   - Run 34 reran `first-run-no-key` alone on the final code: 7/7.
   - I read the screenshots for the chat reply, first-run intro, settings window, errors, wave and voice-off. The balloon, chat bar and character render correctly.
3. **Release:** `npm run dist` built both targets, the NSIS script with `build/installer.nsh` compiled, and `audit-release.mjs` passed. A separate grep of `dist/` and the extracted `app.asar` found nothing private (see the table).
4. **Packaged smoke test** (`.scratch/shipper2/smoke.ps1`): launched the portable exe with no key, `BONZI_DEBUG=1` and `--remote-debugging-port=9555`.
   - The "Bonzi" layered window appeared (460x760, extended style `0x80028` = `WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST`, so transparent, click-through and always on top) and was captured.
   - The main log recorded "Ignoring --remote-debugging-port", and port 9555 was not listening.
   - 6 s after launch it logged "Windows voice host started", then four SAPI `speak` round trips (27 to 87 ms each), one per intro line. That shows the intro was spoken aloud without a key.
   - All processes were stopped, and no SAPI host was left running.
   - The settings window was not captured, because it had already been closed by hand when the capture ran (a key was saved through it during the run). Settings opening on a no-key first run is covered by e2e `no-key` and `first-run-no-key`.

## Earlier passes (summary)

- **Integration pass:** `OPENAI_API_KEY` uses a looser check (`validateEnvApiKey`). `firstRunComplete` is set on the first ready. `frame-ancestors` was removed from the CSP meta tags. An AI disclosure was added to the Settings sidebar. The first word shows as soon as the balloon opens. `__bonziDebug.runCommand` was added (dev builds only). An e2e recorder race on `about:blank` was fixed.
- **Voice pass:** Electron on Windows has no `speechSynthesis` voices, so the Windows voice is a SAPI host in main (`src/main/voice/`) behind `tts:synthesize` with `engine: 'system'`, and a per-sentence fallback chain (`speech/engine-chain.ts`). The defaults are Microsoft David, pitch 1.3 (about 124 Hz, 4.5 semitones up) and speed 1.05, measured against the original TruVoice Bonzi (140 Hz, 157 wpm).

## Known issues and gaps

- **Windows voice:**
  - SAPI rates are integers, so the heard speed moves in steps of about 11.6 %.
  - Only the classic desktop (SAPI 5) voices are listed. OneCore / "natural" voices need a WinRT path that was not added.
  - Raising the pitch with `playbackRate` also shifts the formants; at 1.6x and above it sounds like a chipmunk.
  - The first Windows-voice line after launch, or after 5 idle minutes, waits for PowerShell to start (about 0.6 to 1 s). Later lines take 20 to 100 ms.
  - The host is started with `powershell.exe -EncodedCommand`, which some endpoint-security products flag; Bonzi then falls back to paced text. The script is readable in `src/main/voice/sapi-script.ts`.
  - The pitch was tuned from measurements, not by ear.
- **F04 residual:** a Hide, Show, Hide sequence whose first "hidden" arrives late can still hide the window early; the optional hide sequence number was not added.
- **ACS:** the 2M frame-element cap has no test (a file that hits it is 8 MB or more). Images are decoded lazily in the renderer, and their dimensions are not capped, so a crafted character with huge images could still use a lot of memory when drawn.
- **Debug hook:** because of F04, `__bonziDebug.runCommand({type: 'hide'})` no longer hides the window in main. A future e2e hide test must go through main (tray) instead.
- **Not tested with real input:** dragging with a real cursor (including the 10 s idle drag cancel), the tray and its new tip, context menus, the global hotkey and capture, second-instance behaviour, the microphone and STT, power events, and multi-monitor or DPI changes.
- **Real OpenAI:** the automated runs never contacted it; everything ran against the mock.
- **Unsigned builds:** SmartScreen will warn. The NSIS installer and uninstaller were built but not run, so the uninstall registry cleanup is verified only by its config test and a clean compile.
- **Log noise:** Chromium occasionally logs `Message N rejected by interface blink.mojom.WidgetHost` at startup for the transparent window. It is harmless.
- **Not implemented:** the 20 Hz cursor-polling fallback for click-through (RESEARCH.md B2 step 6). Forwarded mouse moves work on Windows 10.

## Next steps

1. Manual pass on a clean Windows 10/11 VM with a real key:
   - install with NSIS;
   - check the first run (intro spoken with and without a key), chat, all three voice modes and the mic;
   - drag Bonzi across monitors;
   - check the tray (including the first-Hide tip), the context menu, and the hotkey (including re-recording the current shortcut);
   - check Exit;
   - uninstall with "Start with Windows" on and confirm the Run entry is gone.
2. Code signing (an Authenticode certificate) to remove SmartScreen warnings.
3. Listen to the Windows voice on real speakers and fine-tune `systemVoicePitch` / `systemVoiceRate`. Optionally add OneCore voices through WinRT.
4. Cap decoded image dimensions for custom characters, and add the hide sequence number for the F04 residual.
5. A Responses API transport behind the existing chat adapter, if newer models need it.

## Fix: Bonzi not clickable, sluggish mouse, tray unresponsive (2026-10-01)

Reported from the installed build: Bonzi could not be clicked, right-clicked or dragged, the
tray icon often ignored right clicks, and the whole PC felt sluggish. Windows logged two
"Application Hang" events for BonziBuddyReborn.exe. Root cause, reproduced with real OS input:

1. `setIgnoreMouseEvents(true, { forward: true })` delivered zero mouse moves to the page on
   this Windows 10 machine, so the renderer never learned the cursor was over Bonzi and the
   window stayed click-through.
2. Toggling click-through makes Windows fire a spurious `mouseleave`; the renderer trusted it
   and flipped back to click-through. Forwarding is implemented with a system-wide low-level
   mouse hook serviced by the main thread, so churn there delayed every mouse move on the PC
   and starved the tray, which runs on the same thread.

Fix: no forwarding (no global mouse hook at all). The main process samples the cursor at about
30 Hz while Bonzi is visible and sends window-relative positions (`win:pointer`) to the
renderer, which hit-tests Bonzi's pixels and toggles click-through; enter/leave events are no
longer trusted. Drag start now carries the original press point so Bonzi stays exactly under
the cursor. Verified with `npm run qa:input`: hover, click, Esc, right-click menu, tray menu
(every time the icon was located), drag to the exact pixel and back, and main-thread latency
under 1 ms median (15 ms worst) while hovering, versus 5+ second hangs before.
