# BonziBuddy Reborn: Technical Research Brief

Snapshot date: 2026-10-01. Scope: OpenAI API (chat, TTS, STT, models, errors, policy), Electron 44,
electron-builder 26, Microsoft Agent runtime semantics, and BonziBuddy background.

## How this was verified

- **OpenAI**: live docs at `developers.openai.com/api/docs/...` (all `platform.openai.com/docs/...`
  URLs now 301-redirect there) plus the official OpenAPI spec `openai/openai-openapi` (branch `main`,
  latest commit 2026-10-01T05:02Z, spec `info.version` 2.3.0). Where a guide and the spec disagree on
  wire format, trust the spec.
- **Electron**: electronjs.org docs, release notes and breaking-changes page, cross-checked against the
  installed `node_modules/electron/electron.d.ts` (Electron **44.5.1**, generated from that version's
  docs).
- **electron-builder**: the installed `app-builder-lib` **26.15.3** (`scheme.json`, compiled `out/`
  sources, NSIS templates). Upstream latest is 26.17.0 (2026-09-26); 27.0.0 is in alpha.
- **Microsoft Agent**: Microsoft Learn archive of the Agent 2.0 docs (`learn.microsoft.com/windows/win32/lwef/...`),
  Remy Lebeau's ACS format spec, and the DoubleAgent source (Cinnamon Software, GPL, mirrored at
  `github.com/rschiang/cinsoft-double-agent`, archived 2025-02-05).
- Confidence tags: **[V]** verified in official docs/spec today, **[L]** verified in the locally installed
  package or the bundled `Bonzi.acs`, **[DA]** read from DoubleAgent source, **[S]** secondary source
  (GitHub issue, community post, Wikipedia), **[I]** inference or recommendation.

---

## 0. Recommended defaults at a glance

| Area | Recommended default | Notes |
|---|---|---|
| Chat transport | Chat Completions, `POST {baseUrl}/chat/completions`, `stream: true` | Works with OpenAI, Azure v1, OpenRouter, Ollama, LM Studio. [V][I] |
| Default chat model | `gpt-6-luna` with `reasoning_effort: "none"` | $0.10 in / $0.50 out per 1M tokens; `none` keeps latency low and re-enables `temperature`. [V] |
| Smarter preset | `gpt-6-sol` with `reasoning_effort: "low"` | $2 / $10 per 1M; supports `none` through `max`. [V] |
| "Max" preset (optional) | `gpt-6.1-sol` (or `gpt-6-astra`) with `reasoning_effort: "low"` | Neither accepts `none`; no `temperature`. [V] |
| Output cap | `max_completion_tokens: 600` | Counts reasoning tokens too. Never send `max_tokens` to OpenAI. [V] |
| Sampling | `temperature: 0.9` only when effort is `none` (or model is non-reasoning) | Rejected otherwise. [V] |
| Verbosity | `verbosity: "low"` | Values `low`/`medium`/`high`, default `medium`. Strip on rejection. [V] |
| Storage | `store: false` sent explicitly | Chat Completions default is already `false`; Responses defaults to `true`. [V] |
| Usage chunk | `stream_options: { include_usage: true }` only when host is `api.openai.com` | Retry without it on 400 elsewhere. [V][I] |
| Roles | `system` role for the persona prompt | Broadest compatibility with local servers. [I] |
| TTS | `gpt-4o-mini-tts`, voice `cedar`, `response_format: "pcm"`, `stream_format: "audio"`, `speed: 1.0`, persona `instructions` | One request per sentence, max 4096 chars input. [V] |
| Offline / classic voice | Web Speech API with a SAPI 5 voice (e.g. Microsoft David) | Chromium on Windows uses SAPI 5. [S] |
| STT | `gpt-transcribe`, `audio/webm;codecs=opus` from `MediaRecorder`, file name `speech.webm`, `response_format: "json"` | `gpt-4o-*-transcribe` and `whisper-1` shut down 2027-02-26. [V] |
| Agent window | `transparent`, `frame:false`, `backgroundColor:'#00000000'`, `hasShadow:false`, `roundedCorners:false`, `thickFrame:false`, `resizable:false`, `skipTaskbar:true`, `alwaysOnTop` level `floating` | See B1 for bugs and trade-offs. [V][S] |
| Click-through | `setIgnoreMouseEvents(true, { forward: true })` toggled by renderer alpha hit test; re-apply after every load or renderer crash | Known forwarding bugs on Windows, fixes still landing for 44.x. [L][S] |
| Key storage | `safeStorage.encryptStringAsync` / `decryptStringAsync` after `ready` (DPAPI) | Sync API "may be deprecated in a future version". [V] |
| Packaging | electron-builder `nsis` (assisted, per-user default, dir choice) + `portable`, x64, unsigned, fuses flipped | Unsigned 26.15.3 builds do not download winCodeSign. [L] |
| Idle levels | L1 after ~8 s idle (pick every 6-12 s), L2 after ~90 s, L3 (sleep) after ~5 min | MS never documented exact timings; DoubleAgent emulation in D4. [I][DA] |

---

## A. OpenAI API

### A1. Current chat-capable models

Source: models overview, per-model pages and the spec's `ModelIdsShared` enum. [V]

| Model id | Released | Reasoning efforts accepted (default) | Price per 1M (in / cached in / out) | Context / max out | Notes |
|---|---|---|---|---|---|
| `gpt-6-astra` | 2026-09-03 | `low` to `max` (no `none`) | $10 / n.a. / $50 | 1.05M / 128K | Frontier. Chat Completions has no function calling for this model; use Responses for tools. |
| `gpt-6.1-sol` | 2026-09-29 | `low`, `medium` (default), `high`, `xhigh`, `max` | $2 / $0.10 / $10 | 1.05M / 128K | "near-Astra" for coding, computer use. No `none`/`minimal`. Requests over 272K input tokens cost 2x input, 1.5x output. |
| `gpt-6-sol` | 2026-09-22 | `none`, `low`, `medium` (default), `high`, `xhigh`, `max` | $2 / $0.20 / $10 | 1.05M / 128K | Balanced. Function calling in Chat Completions only with effort `none`. |
| `gpt-6-luna` | 2026-09-22 | `none`, `low`, `medium` (default), `high`, `xhigh`, `max` | $0.10 / $0.01 / $0.50 | 1.05M / 128K | "most efficient model for focused, high-volume tasks". Tier 1: 500 RPM, 500K TPM. Text and image in, text out. |
| `gpt-5.6-sol` / `-terra` / `-luna` | 2026-07-09 | `none` to `max` | Luna: $0.20 / $0.02 / $1.20 | 1.05M / 128K | Previous generation, still listed. |
| `gpt-5.5`, `gpt-5.5-pro` | 2026-04-23 | default `medium` | n.v. | n.v. | Listed under reasoning models. |
| `gpt-5.4-mini` / `gpt-5.4-nano` | 2026-03-17 | `none` (default), `low`, `medium`, `high`, `xhigh` | mini: $0.75 / $0.075 / $4.50 | 400K / 128K | Have dated snapshots (`gpt-5.4-mini-2026-03-17`). Good "stable snapshot" fallback. |

- **Every current GPT-5.x and GPT-6 model is a reasoning model.** The only non-reasoning chat models left
  in the catalogue are legacy ones (`gpt-4.1*`, `gpt-4o*`, `gpt-4-turbo`, `gpt-3.5-turbo`). `*-chat-latest`
  aliases (for example `gpt-5.3-chat-latest`, `chat-latest` updated 2026-08-06) are moving targets; do not
  default to them. [V]
- **Shutdowns to avoid as defaults**: `gpt-5-2025-08-07`, `gpt-5-mini-2025-08-07`, `gpt-5-nano-2025-08-07`,
  `gpt-5-pro-2025-10-06`, `o3-2025-04-16`, `o3-pro-2025-06-10` all shut down **2026-12-11** (replacements
  `gpt-5.6-sol/terra/luna`). The Assistants API was shut down 2026-08-26. [V]
- **Recommendation** [I]: default `gpt-6-luna` + `reasoning_effort: "none"`. Luna's default effort is
  `medium`, so omitting the parameter silently adds reasoning latency and cost and can starve a small
  `max_completion_tokens` budget (empty reply with `finish_reason: "length"`). "Smarter" preset:
  `gpt-6-sol` + `low`. Keep the model id a free-text field with a picker (see A6) because ids churn every
  few months.
- Optional latency lever: `service_tier: "fast"` (or `"priority"`) opts into Fast mode at higher cost;
  the response echoes `service_tier: "priority"`. `ultrafast` was removed from the request enum on
  2026-10-01. Not recommended as a default. [V]

### A2. Chat Completions vs Responses

- Official position: "While Chat Completions remains supported, Responses is recommended for all new
  projects." No deprecation timeline is published for Chat Completions. [V]
- Responses-only advantages we do not need for v1: server-side conversation state
  (`previous_response_id`), built-in tools (web search, file search, code interpreter, MCP, computer use),
  compaction, WebSocket mode, async tool calling. Function calling with `gpt-6-astra` and `gpt-6.1-sol`
  requires Responses. [V]
- Compatibility of custom base URLs:
  - **Azure OpenAI v1**: base `https://<resource>.openai.azure.com/openai/v1/`, `api-key` header or
    Bearer token, `model` = deployment name; supports Chat Completions and Responses. [S]
  - **OpenRouter**: Chat Completions is primary; Responses is a stateless **beta** that rejects
    `store: true` and any non-null `previous_response_id` with HTTP 400. Sends `: OPENROUTER PROCESSING`
    SSE comment lines as keep-alives. [S]
  - **Ollama**: `/v1/chat/completions`, `/v1/models`, plus `/v1/responses` since v0.13.3 (stateless). [S]
  - **LM Studio**: `/v1/chat/completions`, `/v1/responses`, `/v1/models`. [S]
  - OpenAI also published "Open Responses", an open multi-provider spec (2026-01-15), so Responses
    support across providers is growing but is not yet universal. [V]
- **Recommendation** [I]: ship a single **Chat Completions** transport (stateless: send the trimmed history
  every turn, `store: false`). Animations are driven by inline `[[Gesture]]` tags in text, so no tool
  calling is needed and every model above works through Chat Completions. Keep the AI client behind an
  interface so a Responses transport can be added later for `api.openai.com` only (also stateless:
  `store: false`, full `input` each turn, never `previous_response_id`).

#### Chat Completions request (recommended shape)

```json
{
  "model": "gpt-6-luna",
  "messages": [
    { "role": "system", "content": "You are Bonzi..." },
    { "role": "user", "content": "Tell me a joke" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "max_completion_tokens": 600,
  "reasoning_effort": "none",
  "temperature": 0.9,
  "verbosity": "low",
  "store": false
}
```

#### Chat Completions streaming wire format [V]

Server-sent events over `text/event-stream`. Each event is a single `data:` line followed by a blank line;
there are no `event:` lines. The stream ends with the literal sentinel `data: [DONE]`.

```
data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1759300000,"model":"gpt-6-luna","system_fingerprint":null,"choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}],"usage":null,"obfuscation":"x1Yz"}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1759300000,"model":"gpt-6-luna","choices":[{"index":0,"delta":{"content":"Hey"},"finish_reason":null}],"usage":null,"obfuscation":"9a"}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1759300000,"model":"gpt-6-luna","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","created":1759300000,"model":"gpt-6-luna","choices":[],"usage":{"prompt_tokens":812,"completion_tokens":41,"total_tokens":853,"completion_tokens_details":{"reasoning_tokens":0}}}

data: [DONE]
```

- Chunk fields: `id`, `object: "chat.completion.chunk"`, `created`, `model`, `choices[].index`,
  `choices[].delta.{role,content,refusal,tool_calls}`, `choices[].finish_reason`
  (`stop`, `length`, `content_filter`, `tool_calls`), `usage` (null except the final usage chunk). [V]
- With `include_usage`, one extra chunk with `choices: []` and the totals arrives **before** `[DONE]`;
  if the stream is interrupted you may never get it. [V]
- `obfuscation`: random padding string added to delta events by default (side-channel mitigation). Ignore
  it, or send `stream_options.include_obfuscation: false` to save bandwidth (OpenAI only). [V]
- Robust parser rules [I]: accept `\n` and `\r\n`; ignore lines starting with `:` (comments/keep-alives);
  tolerate `event:` and `id:` lines; join multiple `data:` lines of one event; tolerate chunks with empty
  `choices` (Azure sends `prompt_filter_results` first); if a parsed JSON object has an `error` key, treat
  it as a mid-stream error; treat EOF without `[DONE]` as success only if a `finish_reason` was seen.

#### Responses streaming wire format (for a future transport) [V]

Typed SSE events, each with an `event:` line and a JSON `data:` line whose `type` repeats the event name;
every event carries a monotonically increasing `sequence_number`. There is **no** `[DONE]` sentinel; the
stream ends after a terminal event.

```
event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-6-luna","store":false,...}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hey","sequence_number":4,"logprobs":[]}

event: response.completed
data: {"type":"response.completed","sequence_number":12,"response":{"id":"resp_1","status":"completed","output":[...],"usage":{...}}}
```

Minimum set to handle: `response.created`, `response.output_text.delta` (append `delta`),
`response.output_text.done`, `response.refusal.delta`, `response.completed` (usage in
`response.usage`), `response.incomplete` (`response.incomplete_details.reason`, e.g. `max_output_tokens`),
`response.failed` (`response.error.{code,message}`), and `error` (`{type:"error", code, message, param,
sequence_number}`). Ignore unknown types (the union has ~60 members, including reasoning summary and tool
events). `output_index` can be 1 when a reasoning item precedes the message. Responses uses
`instructions` (top-level system prompt), `input`, `max_output_tokens` (minimum 16), `reasoning.effort`,
`text.verbosity`, and `store` defaults to **true**. [V]

### A3. Parameter compatibility gotchas

| Parameter | Facts | Client policy [I] |
|---|---|---|
| `max_tokens` | Deprecated in Chat Completions; "not compatible with o-series models". [V] | Send `max_completion_tokens`; only fall back to `max_tokens` when a custom server rejects the new name. |
| `max_completion_tokens` | Upper bound including reasoning tokens. [V] | 600 for chat; raise to ~2000 if effort is above `none`. |
| `temperature` / `top_p` / `logprobs` / `top_logprobs` | For current reasoning models these are only allowed with `reasoning_effort: "none"`; otherwise remove them. Older reasoning models return 400 `unsupported_parameter` (they accept the exact default value 1). [V][S] | Send `temperature` only when effort is `none` or the model is known non-reasoning; never send `top_p`. |
| `reasoning_effort` | Enum `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` (spec default text says `medium`, but defaults are model-dependent). `gpt-6-astra`: no `none` (HTTP 400). `gpt-6.1-sol`: no `none`/`minimal`. `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-*`: `none` to `max`. `gpt-5.4-mini`: `none` (default) to `xhigh`. Name is `reasoning_effort` in Chat Completions, `reasoning.effort` in Responses. [V] | Ladder on rejection: `none` -> `low` -> omit; `minimal` -> `low`. Never send to custom base URLs unless the user enables it. |
| `verbosity` | `low`/`medium`/`high`, default `medium`. Responses uses `text.verbosity`. [V] | Send `low` to OpenAI; drop on rejection. |
| `stream_options` | `include_usage`, `include_obfuscation`; "Only set this when you set `stream: true`". [V] | OpenAI host only by default. |
| `store` | Chat Completions default **false** (spec). Responses default **true**. [V] | Always send `false` to OpenAI; omit for custom hosts if rejected (OpenRouter Responses rejects `true`). |
| `user` | Deprecated, replaced by `safety_identifier` (max 64 chars) and `prompt_cache_key`. [V] | Omit `user`. Optional `prompt_cache_key` = random per-install id to improve caching of the long system prompt. |
| `prompt_cache_retention` | Deprecated; use `prompt_cache_options.ttl` (e.g. `"30m"`). [V] | Not needed. |
| Function calling | Chat Completions: none for `gpt-6-astra`/`gpt-6.1-sol`; `gpt-6-sol`/`gpt-6-luna` only with effort `none`. [V] | Not used (tags in text). |

**Unsupported-parameter error shape** (HTTP 400) [S, matches spec `Error` object]:

```json
{ "error": { "message": "Unsupported parameter: 'temperature' is not supported with this model.",
             "type": "invalid_request_error", "param": "temperature", "code": "unsupported_parameter" } }
```

Unsupported **value** variant: `code: "unsupported_value"`, e.g. message
`Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.`, `param:
"reasoning_effort"`. [S]

**Auto-retry algorithm** [I]:
1. Keep a per `(baseUrl, model)` capability profile in memory (and optionally persisted):
   `{ tokenParam, sendTemperature, effort, sendVerbosity, sendStreamOptions, sendStore }`.
2. On HTTP 400: read `error.param` and `error.code`. If `code` is `unsupported_parameter` drop that param;
   if `unsupported_value` and param is `reasoning_effort`, step down the ladder. If `param` is null, fall
   back to regex on `message` for known names (`temperature|top_p|reasoning_effort|verbosity|
   stream_options|max_completion_tokens|max_tokens|store`) plus phrases like `Unsupported parameter`,
   `Unrecognized request argument`, `unknown field`, `extra_forbidden`, `not supported`.
3. Retry immediately (no backoff), at most 3 adjustments per request, then surface the error.
4. Custom servers may return `{"error":"string"}`, `{"error":{"message":...}}`, `{"detail":...}` or plain
   text; normalise all of them before matching.

### A4. Text-to-speech (`POST /v1/audio/speech`)

Facts [V] (guide plus spec `CreateSpeechRequest`):

- **Models**: `gpt-4o-mini-tts` (alias, default snapshot `gpt-4o-mini-tts-2025-12-15`; older
  `gpt-4o-mini-tts-2025-03-20`), `tts-1` (lower latency, lower quality), `tts-1-hd`. No newer TTS model and
  no TTS deprecation notice as of today. Pricing `gpt-4o-mini-tts`: $0.60 per 1M text input tokens, $12 per
  1M audio output tokens. Tier 1 limits 500 RPM / 50K TPM.
- **Voices** (13 built-in): `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`,
  `shimmer`, `verse`, `marin`, `cedar`. `gpt-4o-mini-tts` supports all 13; `tts-1`/`tts-1-hd` support 9
  (not `ballad`, `verse`, `marin`, `cedar`). OpenAI recommends `marin` or `cedar` for best quality.
  Custom voices can be referenced as `{ "id": "voice_1234" }` (creation needs consent recordings or, as of
  2026-10-01, a text prompt); not needed here.
- **`instructions`**: max 4096 chars; controls accent, emotion, intonation, impressions, speed, tone,
  whispering. "Does not work with `tts-1` or `tts-1-hd`."
- **`input`**: max **4096 characters**. Required fields: `model`, `input`, `voice`.
- **`response_format`**: `mp3` (default), `opus`, `aac`, `flac`, `wav`, `pcm`. PCM = raw samples, **24 kHz,
  16-bit signed little-endian, no header** (mono). Fastest formats per the guide: `wav` or `pcm`.
- **`speed`**: 0.25 to 4.0, default 1.0.
- **`stream_format`**: `audio` (default; raw bytes with chunked transfer encoding, playable before
  generation finishes) or `sse` (not supported for `tts-1`/`tts-1-hd`). SSE events:
  `{"type":"speech.audio.delta","audio":"<base64>"}` repeated, then
  `{"type":"speech.audio.done","usage":{"input_tokens":14,"output_tokens":101,"total_tokens":115}}`.
- **Disclosure**: usage policies require a clear disclosure to end users that the voice is AI-generated.
- **Languages**: follows Whisper language coverage, voices optimised for English.

Recommendations [I]:
- Split the streamed reply into sentences and synthesize each sentence as soon as it completes (max 2 in
  flight, as ARCHITECTURE.md already plans). Use `pcm` + `stream_format: "audio"` and play chunks as they
  arrive (carry an odd trailing byte to the next chunk; convert Int16 to Float32; create
  `AudioBuffer`s at 24000 Hz, Chromium resamples). If streaming plumbing is deferred, per-sentence whole
  buffers are still fine because sentences are short.
- Keep the API call in the main process (key never reaches the renderer, no CORS problems with localhost
  servers); pass audio to the renderer as transferable `ArrayBuffer`s or over a `MessagePort`.
- Default voice `cedar` with persona instructions along the lines of "Upbeat, goofy, friendly cartoon
  gorilla; quick, bouncy pacing; playful; slightly nasal retro computer-assistant energy". Offer `ash`,
  `echo`, `onyx`, `verse` as alternatives. Do not claim to reproduce the original L&H voice.
- Show "Voice is AI-generated" in Settings next to the voice picker and in About.

Newer voice options worth knowing (not recommended for v1) [V]: `gpt-live-1` voice sessions (GA
2026-09-10, $0.05 per minute), `gpt-realtime-2.1` / `gpt-realtime-2.1-mini` realtime models,
`gpt-live-transcribe`. Legacy `gpt-realtime`, `gpt-audio`, `gpt-4o-*-realtime`/`-audio` shut down
2027-01-20.

### A5. Speech-to-text (`POST /v1/audio/transcriptions`)

Facts [V]:
- **Models**: `gpt-transcribe` (recommended general model, $0.0045 per minute, supports streaming,
  `keywords`, `languages`), `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
  `gpt-4o-mini-transcribe-2025-12-15`, `gpt-4o-transcribe-diarize`, `whisper-1`. **Deprecated**:
  `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize` shut down
  **2027-02-26** (replacements `gpt-transcribe` or `gpt-live-transcribe`).
- **Input formats** (spec): `flac`, `mp3`, `mp4`, `mpeg`, `mpga`, `m4a`, `ogg`, `wav`, `webm`. The spec adds:
  "The request must include enough format metadata for the file to be identified. We recommend an
  extension-bearing filename and an appropriate content type." Chromium `MediaRecorder` output
  `audio/webm;codecs=opus` is therefore accepted; send it as `file` with filename `speech.webm` and
  content type `audio/webm`.
- **Size limit**: 25 MB per file.
- **Multipart fields**: `file` (required), `model` (required), `language` (ISO-639-1), `languages` (array,
  `gpt-transcribe` only), `keywords` (array, `gpt-transcribe` only), `prompt`, `response_format`,
  `temperature` (0 to 1), `include[]` (`logprobs`), `timestamp_granularities[]` (`word`/`segment`,
  `verbose_json` only), `stream`, `chunking_strategy`, `known_speaker_names[]`,
  `known_speaker_references[]`.
- **Response formats**: `json` (default), `text`, `srt`, `verbose_json`, `vtt`, `diarized_json`. The
  `gpt-4o-*` models support only `json`. JSON body: `{ "text": "...", "languages": [...], "logprobs": [...],
  "usage": {...} }` (`languages` from `gpt-transcribe`).
- **Streaming** (`stream: true`, not for `whisper-1`): `transcript.text.delta` (`delta`), then
  `transcript.text.done` (final `text`, usage).

Recommendations [I]: default `gpt-transcribe`, `response_format: "json"`, no `language` by default
(auto-detect) with an optional setting, `keywords: ["Bonzi", "BonziBuddy"]`. For custom base URLs let the
user pick the STT model id (local Whisper servers usually expose `whisper-1`). Non-streaming is fine for
push-to-talk utterances.

### A6. `GET /v1/models`

Shape [V]:

```json
{ "object": "list",
  "data": [ { "id": "gpt-6-luna", "object": "model", "created": 1758500000, "owned_by": "openai",
              "shutdown_date": null } ] }
```

`shutdown_date` (ISO date or null) is a recent optional field; older servers omit it. The list contains
every model the key's project can access, including audio, image, embedding, moderation and fine-tuned
models.

Heuristic chat filter for `api.openai.com` [I]:
- include ids matching `^(gpt-|o\d|chatgpt-)` or fine-tunes `^ft:gpt-`;
- exclude ids containing `audio`, `realtime`, `live`, `transcribe`, `tts`, `whisper`, `image`, `dall-e`,
  `embedding`, `moderation`, `search`, `codex`, `computer-use`, `diarize`, `sora`, `cyber`,
  `deep-research`, `instruct`, `babbage`, `davinci`, `rosalind`;
- drop entries whose `shutdown_date` is in the past, badge entries with a future `shutdown_date`;
- pin the recommended defaults (A1) at the top.
- For custom base URLs show every id unfiltered (Ollama/LM Studio names are arbitrary).

### A7. Errors and headers

Error body is always `{ "error": { "message", "type", "param", "code" } }` (spec `ErrorResponse`). [V]

| HTTP | `error.type` / `error.code` | Meaning | App action [I] |
|---|---|---|---|
| 400 | `invalid_request_error` / `unsupported_parameter`, `unsupported_value` | Param not valid for model | Auto-retry (A3). [S] |
| 400 | `invalid_request_error` / `context_length_exceeded` | Prompt too long | Trim oldest history, retry once. [S] |
| 401 | `invalid_request_error` / `invalid_api_key` | Wrong or revoked key ("Incorrect API key provided") | Ask for a new key; no retry. [V][S] |
| 401 | (message) "You must be a member of an organization", "IP not authorized" | Org or IP allowlist problem | Show message. [V] |
| 403 | (message) "Country, region, or territory not supported" | Region block | Show message. [V] |
| 404 | `invalid_request_error` / `model_not_found` | Model id unknown or not available to this project | Offer model picker. [S] |
| 429 | `insufficient_quota` / `credit_balance_exhausted` (older: `insufficient_quota`) | No prepaid credit; no `retry-after` header | Tell user to add credits; never retry. [V][S] |
| 429 | `organization_spend_limit_exceeded`, `project_spend_limit_exceeded`, `organization_usage_limit_exceeded` | Spend caps | No retry. [V] |
| 429 | rate limit (`rate_limit_exceeded`) | RPM/TPM exhausted | Honour `retry-after`, exponential backoff with jitter, max ~3 tries. [V] |
| 429 | `slow_down` (new 2026-09-02) | Traffic ramped too fast, even under limits | Back off, ramp up gradually. [V] |
| 500 | `server_error` | Server issue | Retry with backoff. [V] |
| 503 | `server_is_overloaded` (new 2026-09-02) | Temporary overload | Follow `retry-after`. [V] |

Headers [V]: `x-request-id` (log it, show it in error details for support), `retry-after` (seconds),
`x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`,
`x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests` (e.g. `1s`), `x-ratelimit-reset-tokens`
(e.g. `6m0s`, Go-style durations). `openai-processing-ms` is also commonly present. [S]

### A8. Usage policy points relevant to a character app

- Usage Policies were unified on 2025-10-29. They prohibit impersonating real people or organisations
  without consent and "misrepresenting or concealing the role of AI technology". A fictional cartoon
  persona that is clearly presented as an AI companion is fine; the persona prompt should never claim to
  be human. [S]
- TTS requires telling users the voice is AI-generated (see A4). [V]
- Minimum age 13; under-18 users need a parent or guardian's permission (terms). Say "13+" in the README
  and first-run text. [S]
- BYOK: OpenAI discourages sharing API keys; community guidance from OpenAI staff is that a BYOK app is
  acceptable when the key stays on the user's machine and is only sent to the API, never to the
  developer. Our design (DPAPI at rest, main-process only, no telemetry, no proxy) matches that. [S]
- `safety_identifier` is optional; in a single-user BYOK app the key holder is the end user, so omit it by
  default to avoid sending a stable identifier. [I]

---

## B. Electron 44

Version facts [V]: 44.0.0 released 2026-08-24/25 with Chromium 152.0.7977.54, Node 24.18.1, V8 15.2. The
project pins `^44.5.1`. Supported majors today: 44 (EOL 2027-03-02), 43, 42 (EOL 2026-10-20). [S]

Breaking changes 38 to 44 that touch this project [V]:
- **42**: the `electron` npm package no longer downloads the binary in `postinstall`; it downloads on first
  run of `electron .` or via `npx install-electron --no`. `ELECTRON_SKIP_BINARY_DOWNLOAD` is no longer
  supported. Our `node_modules/electron` currently has no `dist/` folder, so the first `npm start`
  downloads ~100 MB. [V][L]
- **44**: `clipboard` removed from renderers and all clipboard methods are now Promise-based; use
  `navigator.clipboard` or a main-process IPC helper. 32-bit Windows (ia32) builds removed (x64 is
  unaffected). ANGLE statically linked. macOS 12 dropped.
- **43**: file dialogs default to the Downloads folder when `defaultPath` is unset.
- **39**: `window.open` popups are always resizable (irrelevant: we deny all window creation).
- No breaking changes to `setIgnoreMouseEvents`, `safeStorage`, `Tray`, `Menu`, `globalShortcut`,
  `screen`, `powerMonitor` or `protocol` in 38 to 44.
- New and experimental in 44: `windowStatePersistence` constructor option (needs a window `name`).
  Prefer our own position persistence because we clamp to work areas. [L]

### B1. Transparent, frameless, always-on-top desktop-pet window (Windows)

Recommended options [V][L][I]:

```ts
new BrowserWindow({
  show: false, transparent: true, frame: false, backgroundColor: '#00000000',
  hasShadow: false, roundedCorners: false, thickFrame: false,
  resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
  skipTaskbar: true, alwaysOnTop: true, focusable: true,
  webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false,
                    backgroundThrottling: false, spellcheck: false, devTools: !app.isPackaged },
});
win.setAlwaysOnTop(true, 'floating');
win.showInactive(); // do not steal focus at startup
```

- `transparent`: "On Windows, does not work unless the window is frameless." `backgroundColor` alpha
  (`#AARRGGBB`) is honoured only when `transparent` is true; the default is opaque white. [L]
- Transparent windows are documented as not resizable ("Setting `resizable` to `true` may make a
  transparent window stop working on some platforms"); the window is not transparent while DevTools is
  docked (use detached DevTools); on Windows it cannot be maximised from the system menu. [V]
- Known bugs:
  - Windows 11 frameless transparent windows started showing a shadow and rounded-corner border after
    35.1.3 (issue #46468); workaround `hasShadow: false`, `roundedCorners: false`, `thickFrame: false`. [S]
  - v39 regression made resizable transparent frameless windows non-resizable; fixed (PR #49428, merged
    2026-03-16, backported to 39 to 42). Not relevant with `resizable: false`. [S]
  - Long-standing reports of black backgrounds after display changes or off-screen drags, mostly tied to
    GPU paths. Keep hardware acceleration on and clamp the window to work areas. [S]
- `alwaysOnTop` levels: `normal`, `floating`, `torn-off-menu`, `modal-panel`, `main-menu`, `status`,
  `pop-up-menu`, `screen-saver`, `dock`. On Windows the default level for `true` is `floating`; levels
  `floating` to `status` sit **below the taskbar**, `pop-up-menu` and higher sit **above the taskbar**. [V]
  Recommendation: `floating` by default; a "Stay above everything" setting uses `screen-saver` (beware it
  can cover full-screen apps and games). [I]
- `setVisibleOnAllWorkspaces` "does nothing on Windows". [V]
- `focusable: false` on Windows also implies `skipTaskbar: true`, but it would stop keyboard input into the
  chat bar living in the same window. Keep `focusable: true` and avoid focus stealing with
  `showInactive()`; call `win.focus()` only when the chat bar opens. [V][I]
- `type: 'toolbar'` is the only documented Windows window type; it creates a tool window, which is
  reported to hide the window from Alt+Tab. Optional, test before adopting. [V][S]
- `setShape(rects)` (Windows/Linux, experimental) is an alternative to click-through via window regions;
  not recommended because the shape would need updating every animation frame. [V][I]

### B2. Click-through for transparent pixels

- `win.setIgnoreMouseEvents(ignore, { forward })`: when ignoring, events pass to the window below;
  `forward: true` (macOS, Windows) "forwards mouse move messages to Chromium, enabling mouse related
  events such as `mouseleave`" and is only used when `ignore` is true. Keyboard events still reach the
  window if it has focus. Still fully supported in 44.5.1. [L]
- Official pattern: renderer listens for mouse movement and asks main (IPC) to toggle ignore. [V]
- Known Windows issues with forwarding [S]:
  - Forwarding breaks or enter/leave events flap after a renderer crash/reload, navigation or web-contents
    view change; `:hover` can stay stuck. Fix PR #52633 (targets 43, 44, 45) was approved 2026-10-01 but is
    not merged yet; PR #52631 (stuck hover near window edges) targets 44 and 45.
  - Cursor flicker between arrow and hand on forwarded moves (PR #54201, draft); disabling `forward` stops
    it.
  - No forwarded events while certain elevated windows (Task Manager, Device Manager) have focus (issue
    #33281). Click-through itself still works.
- Recommended pattern [I]:
  1. Start with `setIgnoreMouseEvents(true, { forward: true })`.
  2. Renderer: on every `mousemove`, hit-test the current composited frame's alpha at the CSS-pixel
     position (divide by the sprite scale, not by `devicePixelRatio`) plus the DOM rects of balloon, chat
     bar and buttons. Send IPC **only on state change** (`interactive` true/false).
  3. Main: `true` -> `setIgnoreMouseEvents(false)`; `false` -> `setIgnoreMouseEvents(true, { forward: true })`.
     While a drag is active, never re-enable ignore.
  4. Re-apply the current state in main on `did-finish-load`, `render-process-gone` recovery and
     `screen` `display-metrics-changed`.
  5. Do not rely on CSS `:hover` for the character; drive hover visuals from the hit-test state.
  6. Fallback when forwarded moves stop (focus stolen by an elevated window): main polls
     `screen.getCursorScreenPoint()` at ~20 Hz only while the cursor is inside the window bounds and asks the
     renderer to hit-test.
  7. Dragging: do not use `app-region: drag` (drag regions swallow all pointer events, so no clicks or
     context menus); use the IPC + cursor-polling drag already planned in ARCHITECTURE.md. [V][I]

### B3. `safeStorage` on Windows

API in 44.5.1 [L][V]:
- Sync: `isEncryptionAvailable(): boolean`, `encryptString(plain): Buffer` (throws on failure),
  `decryptString(buf): string`.
- Async: `isAsyncEncryptionAvailable(): Promise<boolean>`, `encryptStringAsync(plain): Promise<Buffer>`,
  `decryptStringAsync(buf): Promise<{ shouldReEncrypt: boolean; result: string }>`. The async encryptor is
  initialised lazily on first use after `ready`. The docs recommend the async API and say "The synchronous
  API may be deprecated in a future version of Electron."
- Windows backend is DPAPI: "only a user with the same logon credential as the user who encrypted the data
  can typically decrypt the data". It protects against other users on the machine, **not** against other
  apps running as the same user.
- Availability: on Windows `isEncryptionAvailable()` returns true **once the app has emitted `ready`**;
  calling encrypt/decrypt before `ready` fails. `setUsePlainTextEncryption` is a Linux-only no-op on
  Windows.
- Recommendations [I]: use the async pair; store the Buffer as-is in `credentials.bin`; if
  `shouldReEncrypt` is true, re-encrypt and rewrite; if decryption throws (profile moved to another
  machine or user), discard the blob and ask for the key again. A portable copy carried to another PC will
  always need the key re-entered.

### B4. Security checklist for Electron 44

The official checklist has 20 items; how they map to this app [V][I]:

1. Only load local content via `app://bonzi/` (no remote pages).
2. `nodeIntegration: false` (default since 5).
3. `contextIsolation: true` (default since 12).
4. `sandbox: true` (default since 20) plus `app.enableSandbox()`.
5. Permission handlers: **Electron approves every permission request by default** if no handler is set,
   so set both `ses.setPermissionRequestHandler` and `ses.setPermissionCheckHandler` (each is incomplete
   without the other). Allow only `permission === 'media'` where
   `details.mediaTypes` contains only `'audio'` and the requesting origin is `app://bonzi`; deny the rest
   (including `clipboard-read`, `notifications`, `openExternal`, `local-network-access`). [V][L]
6. Keep `webSecurity: true`.
7. Strict CSP (header from the protocol handler plus meta tag), as already specified in ARCHITECTURE.md.
   `default-src 'none'` baseline. With main-process networking the renderer needs no remote
   `connect-src`. Add `worker-src 'self' blob:` only if an AudioWorklet is introduced.
8. No `allowRunningInsecureContent`. 9. No `experimentalFeatures`. 10. No `enableBlinkFeatures`.
11-12. No `<webview>`.
13. Block navigation (`will-navigate`, `will-redirect` -> `preventDefault()`).
14. `setWindowOpenHandler(() => ({ action: 'deny' }))`.
15. `shell.openExternal` only for a fixed allowlist.
16. Stay on a supported Electron (44.x).
17. Validate `event.senderFrame` on every IPC message.
18. Prefer a custom protocol over `file://`: `protocol.registerSchemesAsPrivileged([{ scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])` **before**
    `ready`, then `protocol.handle('app', req => net.fetch(pathToFileURL(safePath)))` with a check that the
    resolved path stays inside `dist/renderer` (the docs warn about `app://bundle/../../secret_file.txt`).
    `secure: true` makes the origin a secure context, which `getUserMedia` and AudioWorklet need.
    `registerFileProtocol` and friends are deprecated since 25.
19. Fuses (below).
20. Do not expose raw Electron APIs through `contextBridge`; expose narrow functions.

Also [L]: Windows microphone privacy: `systemPreferences.getMediaAccessStatus('microphone')` works on Windows
(reflects the global "let desktop apps access your microphone" setting); show a hint when it is `denied`.

**Fuses** (electron-builder 26 `electronFuses`, uses bundled `@electron/fuses` 1.8.0) [L][V]:

```json
"electronFuses": {
  "runAsNode": false,
  "enableCookieEncryption": true,
  "enableNodeOptionsEnvironmentVariable": false,
  "enableNodeCliInspectArguments": false,
  "enableEmbeddedAsarIntegrityValidation": true,
  "onlyLoadAppFromAsar": true,
  "grantFileProtocolExtraPrivileges": false,
  "loadBrowserProcessSpecificV8Snapshot": false
}
```

- ASAR integrity validation is supported on Windows since Electron 30; electron-builder 26 writes the
  integrity resource into the exe with `resedit` whenever `asar` is on (unless `disableAsarIntegrity`). [L]
- `runAsNode: false` breaks `process.fork` from main (use `utilityProcess` if ever needed). [L]
- `grantFileProtocolExtraPrivileges: false` is safe because pages load from `app://`; ARCHITECTURE.md's fuse
  list should add it. [I]
- `onlyLoadAppFromAsar: true` requires all app code inside `app.asar`; data files in `extraResources` are
  unaffected. [L][I]

### B5. Other main-process APIs

- **Tray**: keep a module-level reference (garbage collection removes the icon); use a multi-size `.ico`
  (16 and 32 px at least) for crisp DPI rendering; `tray.setContextMenu(menu)` plus a `click` handler to
  toggle visibility. [I]
- **Menu.popup**: `menu.popup({ window, x, y, callback })` from main in response to a renderer IPC
  (`contextmenu` event). [V]
- **globalShortcut**: register after `ready`; "When the accelerator is already taken by other applications,
  this call will silently fail" (returns false). Unregister on `will-quit`. [L]
- **Single instance**: `app.requestSingleInstanceLock(additionalData?)` returns false in the second
  instance (quit immediately); the first gets `second-instance (event, argv, workingDirectory,
  additionalData)`. [V]
- **Login item** (`app.setLoginItemSettings`, Windows options): `openAtLogin`, `path` (default
  `process.execPath`), `args`, `enabled` (Task Manager startup-approved state, default true), `name`
  (registry value name, default the AppUserModelId). Portable caveat: the portable exe self-extracts to
  `%TEMP%` on every launch, so `process.execPath` points at a temporary copy; use
  `process.env.PORTABLE_EXECUTABLE_FILE` as `path`. Call `app.setAppUserModelId(appId)` early, matching
  electron-builder `appId`. [L][V]
- **screen**: `getAllDisplays()`, `getDisplayNearestPoint()`, `getCursorScreenPoint()` (DIP), `workArea` vs
  `bounds`, `scaleFactor`; events `display-added`, `display-removed`, `display-metrics-changed` (with
  changed metrics such as `bounds`, `workArea`, `scaleFactor`, `rotation`). All window coordinates are DIPs;
  re-clamp on every event. [L]
- **Throttling**: `webPreferences.backgroundThrottling: false` (or `webContents.setBackgroundThrottling(false)`)
  keeps timers and rAF running for idle animations. [L]
- **powerMonitor** (Windows-relevant): `suspend`/`resume`, `lock-screen`/`unlock-screen` (macOS,
  Windows), `on-ac` (macOS, Windows), `on-battery` (typed macOS-only in 44), `getSystemIdleTime()` (s),
  `getSystemIdleState(threshold)` (`active`/`idle`/`locked`/`unknown`), `isOnBatteryPower()`. Use them to
  pause idle chatter while locked or away and to jump to idle level 3 when the system is idle. [L]
- **ESM main**: supported since Electron 28; ESM entry points load asynchronously, so only side effects of
  imports run before `ready` unless you use top-level `await`. Our `"type": "module"` package with a
  `.cjs` main bundle runs as CommonJS and avoids this entirely. [V]
- **Preloads**: sandboxed preloads "are run as plain JavaScript without an ESM context" and can only
  `require` `electron` (`contextBridge`, `crashReporter`, `ipcRenderer`, `nativeImage`, `webFrame`,
  `webUtils`), `events`, `timers`, `url` (and `node:` variants); they cannot require relative files. Bundle
  each preload into one CommonJS file (esbuild `format: 'cjs'`, `external: ['electron']`). [V]

### B6. Audio in the renderer

- `autoplayPolicy` web preference defaults to **`no-user-gesture-required`** in Electron, so an
  `AudioContext` created at startup runs without a click. Still call `ctx.resume()` defensively; the
  command-line switch `autoplay-policy=no-user-gesture-required` is the documented fallback if a context
  starts suspended. [L][S]
- `decodeAudioData`: Chromium decodes WAV/PCM, MP3, FLAC, Ogg Opus and WebM Opus; Electron ships its FFmpeg
  with proprietary codecs (MP3, AAC, H.264). For OpenAI TTS prefer `pcm` (no decode step, stream-friendly);
  `opus` from OpenAI is an Ogg container and decodes fine as a whole file. [S]
- **SpeechSynthesis** on Windows: Chromium's Windows backend uses SAPI 5 (Electron fixed voice enumeration
  on Windows in PR #14070). Expect classic voices such as "Microsoft David", "Microsoft Zira", "Microsoft
  Mark"; OneCore and "Natural" voices only appear if registered as SAPI 5 tokens; Chrome's online Google
  voices are not available. `getVoices()` can be empty until `voiceschanged` fires. Word `boundary` events
  are usually available on SAPI voices and can drive balloon pacing. [S][I]
- **MediaRecorder**: `audio/webm;codecs=opus` is supported (Chromium default); `audio/ogg` is not supported
  in Chromium; `audio/mp4` depends on platform encoders. Always pick via `MediaRecorder.isTypeSupported`
  in that order. [S]
- Lip-sync source: `AnalyserNode.getFloatTimeDomainData` RMS every 50 to 80 ms (see D5). [I]

---

## C. electron-builder 26 (Windows x64)

Verified against installed 26.15.3 [L]:
- **Targets**: `win.target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }]`.
- **NSIS options and defaults**: `oneClick` (true), `perMachine` (false), `allowElevation` (true),
  `allowToChangeInstallationDirectory` (false, assisted only), `selectPerMachineByDefault` (false),
  `createDesktopShortcut` (true), `createStartMenuShortcut` (true), `runAfterFinish` (true),
  `deleteAppDataOnUninstall` (false, one-click only), `packElevateHelper` (true), `shortcutName`,
  `installerIcon`/`uninstallerIcon` (default `build/installerIcon.ico` or app icon). With `oneClick: false`
  and `perMachine: false` the assisted installer shows an install-mode page ("only for me" vs "anyone"),
  defaulting to per-user unless `selectPerMachineByDefault` is true; there is no built-in switch to hide that
  page while keeping the assisted UI.
- **Portable options**: `artifactName`, `requestExecutionLevel` (default `user`), `unpackDirName` (default
  a unique uuid dir in `%TEMP%`; `false` uses the per-launch `$PLUGINSDIR`), `splashImage` (`.bmp`),
  `useZip`. At launch the stub sets `PORTABLE_EXECUTABLE_DIR`, `PORTABLE_EXECUTABLE_FILE`,
  `PORTABLE_EXECUTABLE_APP_FILENAME`. Startup is slower because of extraction on every launch.
- **Artifact names**: default NSIS `${productName} Setup ${version}.${ext}`, global default
  `${productName}-${version}.${ext}`. Macros include `${productName}`, `${name}`, `${version}`, `${arch}`,
  `${os}`, `${ext}`. Avoid the space in "BonziBuddy Reborn" by hardcoding the prefix.
- **Icon**: `win.icon` default `build/icon.ico`; input `.ico`, `.png` or `.svg`, at least 256x256 (512x512 or
  SVG recommended). NSIS header 150x57 `.bmp`, sidebar 164x314 `.bmp` if customised. [V]
- **asar**: default `true`; native module unpacking is automatic.
- **files**: default `**/*` minus a built-in ignore list; set it explicitly so `src/`, `tests/`, `scripts/`,
  `.scratch/` and raw `assets/` stay out of `app.asar`. devDependencies are never packed.
- **extraResources**: copied to `resources/` (read at runtime from `process.resourcesPath`).
- **Config file discovery** (load.js): `electron-builder.yml`, `.yaml`, `.json`, `.json5`, `.toml`, `.js`,
  `.cjs`, `.ts`, or the `build` key in `package.json`. `.mjs` works only via `--config`. A `.js` config is
  imported as ESM when `package.json` has `"type": "module"`; prefer YAML/JSON. A `"type": "module"`
  package with `"main": "dist/main/main.cjs"` is fine.
- **Signing and resource editing**:
  - Icon, version info and execution level are written with `resedit` (pure JS). `signAndEditExecutable`
    (default true) controls both editing and signing; setting it `false` drops the icon and metadata, so do
    not. `signExecutable: false` skips only signing.
  - With no certificate configured (`CSC_LINK`/`WIN_CSC_LINK`, `signtoolOptions`, `azureSignOptions` all
    unset) signing is skipped ("no signing info identified, signing is skipped") **before** any signing
    toolset is resolved. Therefore an unsigned 26.15.3 build does not download `winCodeSign-2.6.0.7z`, and
    the classic error `Cannot create symbolic link : A required privilege is not held by the client`
    (7-Zip extracting macOS symlinks without Developer Mode or admin) should not occur. [L, inferred from
    the code path]
  - When signing is enabled with the legacy default toolset (`toolsets.winCodeSign: "0.0.0"`), the 7z is
    still downloaded and the symlink error can still happen. Workarounds: enable Windows Developer Mode,
    run the first build elevated so the cache extracts once, or opt into `toolsets.winCodeSign: "1.1.0"`
    (beta, per-platform zip bundles). [L][S]
  - `CSC_IDENTITY_AUTO_DISCOVERY=false` only affects macOS keychain discovery and does nothing for Windows
    builds. [L]
  - Unsigned installers trigger SmartScreen "Windows protected your PC"; document "More info, Run anyway".
- **Electron zip**: electron-builder downloads `electron-v44.5.1-win32-x64.zip` into its cache on the first
  build (network needed once).

Suggested `electron-builder.yml` [I]:

```yaml
appId: io.github.amirhadzi.bonzireborn
productName: BonziBuddy Reborn
directories: { output: release, buildResources: build }
files: [ "dist/**/*", "package.json" ]
extraResources: [ { from: "assets/characters", to: "characters" } ]
asar: true
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  grantFileProtocolExtraPrivileges: false
win:
  target: [ { target: nsis, arch: [x64] }, { target: portable, arch: [x64] } ]
  icon: build/icon.ico
  requestedExecutionLevel: asInvoker
nsis:
  oneClick: false
  perMachine: false
  selectPerMachineByDefault: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: BonziBuddy Reborn
  artifactName: "BonziBuddy-Reborn-Setup-${version}-${arch}.${ext}"
portable:
  artifactName: "BonziBuddy-Reborn-${version}-${arch}-portable.${ext}"
```

---

## D. Microsoft Agent runtime semantics

### D1. Frames and timing

- Frame duration is stored in **1/100 s** (centiseconds). MS guidance: at least 10 (100 ms, 10 fps). [V]
- Frames with no images and zero duration are invisible and exist only as branch points; a frame with no
  images but a non-zero duration is shown as empty (looks like the character vanished). DoubleAgent drops
  zero-duration frames from the playback sequence entirely but still evaluates their branches. [V][DA]
- A frame can carry a sound effect, played when the frame is shown. Agent does not signal "animation
  complete" until the sound finishes, so long sounds stretch the animation. [V]
- A finished, non-looping animation holds its last frame until the next request. [V][DA]

### D2. Branching probabilities

- Up to three branches per frame, each `{ targetFrameIndex (0-based), probabilityPercent }`. [V]
- Runtime rule (DoubleAgent, consistent with the MS editor docs) [DA]:
  ```
  r = randomInt(1, 100)
  for each branch in order (max 3, skip probability 0):
      r -= branch.probability
      if r <= 0: next = branch.target; stop
  if no branch taken: next = current + 1      // remainder (100 - sum) continues forward
  if next >= frameCount: animation complete
  ```
  So probabilities are cumulative in declaration order, and whatever is left below 100 % falls through to
  the next frame. Backward branches create loops ("looping animations") that run until stopped; MS warns
  that queued animations will not play until a Stop or user event ends the loop. [V]
- Use an injectable RNG for tests, and cap runaway loops in non-looping contexts (DoubleAgent caps
  precomputed sequences by duration and frame count). [DA][I]

### D3. Stopping, exit branches and Return animations

- Each animation has a transition type: **0 = use the named Return animation**, **1 = use exit branches**,
  **2 = no transition**. [V Lebeau spec]
- Exit branch = per-frame `exitFrame` index taken "when the animation is stopped and before the next
  animation is played"; exit chains must not loop and must reach the end. If a frame has no exit branch, the
  animation follows the frame's normal branching, else the next frame. [V]
- DoubleAgent's exit traversal, which guarantees termination [DA]:
  `exitFrame >= 0` jump there; `exitFrame == -1` end now; `exitFrame == -2` (none) follow branch 0 only if it
  is a 100 % forward branch, else go to the next frame. Probabilistic branches are ignored while exiting.
- Return animations: "When the server gets a request to play another animation, it will attempt to play
  the Return animation for the last animation it played, if a Return animation is assigned." The server
  also plays the Return animation before Idling state animations. Return animations should be 2 to 4
  frames. [V]
- `Stop()` with no argument stops all animations and clears the queue, except while the Showing or Hiding
  animation is playing. [V] DoubleAgent cuts idle animations without exit animations ("MS Agent doesn't
  play idle exit animations"). [DA]
- Interruption recipe for Reborn [I]: on a new request while something plays, if the current animation is
  looping or waiting, run its exit traversal (type 1) or its Return animation (type 0), then play the new
  one. Idle animations are interrupted immediately, followed by the Return/RestPose.

### D4. Idle levels

- States `IdlingLevel1`, `IdlingLevel2`, `IdlingLevel3` are progressive: Level 1 for the first idle period,
  Level 2 for the second, then Level 3 "remains in this state until canceled". When several animations
  are assigned to a state the server picks one at random. Level 3 is meant for sleeping or headphones. MS
  only says idle starts after the user "has not interacted with the character for several seconds"; no
  exact thresholds are documented. [V]
- DoubleAgent's emulation [DA]: a 750 ms idle timer; idle is active only when the queue is empty and the
  last animation is complete; it then inserts 4 empty ticks (about 3 s), plays the current level's
  animation list, and advances a counter per batch: Level 1 for the first 3 batches, Level 2 for the next
  3, then Level 3 indefinitely. Any queued request stops idle and resets the level.
- Bonzi's assignments (from the bundled ACS) [L]: IdlingLevel1 = 19 `IDLE1_*` variants; IdlingLevel2 = 21
  (`IDLE1_*` including `IDLE1_7`, `IDLE1_8`, `IDLE1_21`, `IDLE1_26`); IdlingLevel3 = `IDLE3_1`, `IDLE3_2`.
- Recommended timings for Reborn [I]: enter idle 8 s after the last activity; Level 1 random pick every
  6 to 12 s; after ~90 s switch to Level 2 (every 10 to 20 s); after ~5 min Level 3 (play once, hold the
  sleep loop). Avoid repeating the previous pick. Any click, chat or speech exits idle. Pause idle while the
  screen is locked or the system is suspended.

### D5. Speaking, mouth overlays and visemes

- Mouth overlay types [V]: `0 Closed` (m, b, f), `1 Wide1` (g, l, "ear"), `2 Wide2` (n, d, t), `3 Wide3`
  (u in "hut", "ea" in "head", "ur"), `4 Wide4` (a in "hat", "ow" in "how"), `5 Medium` ("oy", o in
  "hot"), `6 Narrow` (o in "hoop"/"hope", w).
- Speaking frame [V]: overlays are drawn on top of the **last frame** of the current animation (the
  "speaking frame"). "A character cannot speak while animating", and a looping animation cannot speak.
  Overlays are clipped to the base frame's outline; the "Replace Base Frame Top Image" flag swaps the
  frame's top image instead of overlaying.
- What Speak does [V][DA]: if the current (last played) animation has a speaking frame, the character holds
  that frame and lip-syncs on it; otherwise "the animation services use the Speaking state" (Bonzi:
  `RESTPOSE`) and speak on its final frame. DoubleAgent's order: current animation's first frame with
  overlays, then the `SPEAKING` state, then `RestPose`, then `Explain`. Gesturing animations with overlays
  let the character speak while pointing.
- SAPI 5 viseme to overlay mapping used by DoubleAgent [DA], with SAPI phonemes [V]:

  | Overlay | SAPI visemes (phonemes) |
  |---|---|
  | 0 Closed | 0 (silence), 21 (p b m) |
  | 1 Wide1 | 12 (h), 13 (r), 14 (l), 15 (s z), 16 (sh ch jh zh), 17 (th dh), 18 (f v), 19 (d t n), 20 (k g ng) |
  | 2 Wide2 | 1 (ae ax ah), 5 (er) |
  | 3 Wide3 | 4 (ey eh uh), 11 (ay) |
  | 4 Wide4 | 2 (aa) |
  | 5 Medium | 3 (ao), 6 (y iy ih ix), 9 (aw) |
  | 6 Narrow | 7 (w uw), 8 (ow), 10 (oy) |

- For audio without phoneme data Agent lip-synced from "the audio characteristics" of the sound;
  DoubleAgent sums a few 16-bit samples per buffer, uses Closed below a threshold, else scales amplitude
  into the Wide range. [V][DA]
- Reborn mapping for OpenAI TTS (no visemes available) [I]: every 60 ms compute RMS from an `AnalyserNode`;
  with hysteresis map silence to Closed and rising loudness to Wide1, Wide2, Wide3, Wide4; occasionally
  substitute Medium or Narrow when the sentence text around the current playback position contains
  rounded vowels (o, u, w). Return to Closed at sentence end.

### D6. Word balloon

- MS behaviour [V]: balloon text accompanies Speak (and Think shows a thought balloon with no audio). Options:
  characters per line, fixed number of lines or size-to-text, **auto-hide** after Speak completes, and
  **auto-pace** (words revealed paced to the speech output rate). Users could override the font.
- DoubleAgent details [DA]: with TTS, words are revealed on the voice's word-boundary events; without
  audio, auto-pace reveals one word every **300 ms**; auto-hide delays derive from the Windows tooltip
  delays (with auto-pace on, half the tooltip auto-pop time, about 2.5 s with default settings). The
  balloon is hidden while a MoveTo plays.
- Bonzi's balloon in the ACS [L]: 2 lines, 28 characters per line, font "MS Sans Serif" height -13, weight
  400, black text and border. Raw background bytes are `FF FF E1 00`. Decoded as a Win32 **COLORREF**
  (R, G, B, 0) that is `#FFFFE1`, the classic tooltip yellow; decoded as RGBQUAD (B, G, R, 0) it would be
  `#E1FFFF` (pale cyan). DoubleAgent's native runtime stores the raw DWORD as a COLORREF. The current
  parser (`rgbQuad()` in `src/shared/acs/parse.ts`) reports `{r:225,g:255,b:255}`, so the classic balloon
  style will likely render cyan instead of yellow (see Open questions).

### D7. Show, Hide, MoveTo, GestureAt

- **Show / Hide** [V]: play the `Showing` / `Hiding` state animation (Bonzi: `SHOW`, `HIDE`) and set
  visibility; Showing animations end on the neutral pose, Hiding animations start from it.
- **MoveTo(x, y, speed)** [V]: `speed` in milliseconds, default **1000**, `0` moves instantly without
  animation. The server plays the `Moving<Dir>` state animation to get into the moving pose; "The last
  frame of this animation is displayed as the character's frame is moved on the screen. There is no support
  for animating the character while its frame moves." Coordinates are the frame's top-left. Direction is
  from the **character's** point of view: DoubleAgent maps movement toward screen-left to `MOVINGRIGHT`
  and toward screen-right to `MOVINGLEFT`, with up/down chosen when the vertical offset dominates (45 degree
  split). [DA]
- **GestureAt(x, y)** [V][DA]: picks `Gesturing<Dir>` relative to the frame centre, again from the
  character's perspective (a point to the screen-left plays `GESTURINGRIGHT`); same dominant-axis rule.

---

## E. BonziBuddy background

- **Voice** [L][S]: the bundled `Bonzi.acs` names TTS engine `{CA141FD0-AC7F-11D1-97A3-0060082730FF}` (Lernout
  & Hauspie TruVoice for SAPI 4), mode `{CA141FD0-AC7F-11D1-97A3-006008273001}`, speed **157**, pitch
  **140**, language 1033, gender male, age 30. Fan and archive sources identify this as "Adult Male #2" at
  pitch 140, speed 157. TruVoice is proprietary and cannot be shipped; use OpenAI TTS persona instructions
  or a SAPI 5 voice with raised pitch as a "classic" approximation.
- **History** (for the "clean recreation" framing) [S]: BonziBuddy (1999 to 2004, final 4.1 in 2005) was
  built by Joe and Jay Bonzi on Microsoft Agent, first with Peedy and then the purple gorilla. It installed
  toolbars, reset browser home pages, tracked users and served ads, and was classified as adware/spyware by
  Trend Micro and Symantec. A 2002 class action targeted banner ads that imitated Windows dialogs, and in
  February 2004 the FTC fined Bonzi Software US$75,000 under COPPA for collecting personal data from
  children under 13 without parental consent. Reborn deliberately inverts that: no telemetry, no ads, local
  key storage, one network destination chosen by the user.

---

## F. Open questions and risks

1. **Balloon colour decoding**: confirm with the ACS owner whether `BALLOONINFO` colours are COLORREF
   (gives `#FFFFE1`, matches period screenshots and DoubleAgent's native runtime) rather than RGBQUAD. The
   palette is definitely RGBQUAD.
2. **IP and branding**: `Bonzi.acs` art, sounds and the "BonziBuddy" name belong to Bonzi Software (status
   of rights today unclear). Shipping the ACS inside a distributed installer needs a legal decision; an
   alternative is "bring your own .acs" with a file picker.
3. **`gpt-transcribe` and `language`**: the spec lists both `language` (string) and `languages` (array,
   gpt-transcribe only). Whether `gpt-transcribe` rejects `language` is not documented; auto-detect by
   default and retry without on 400. Multipart encoding of the `languages`/`keywords` arrays (repeated
   `keywords[]` fields vs repeated `keywords`) needs a live test.
4. **Model churn**: GPT-6 family is days old (Luna and Sol 2026-09-22, 6.1 Sol 2026-09-29); the
   models overview already lists only Astra, 6.1 Sol and Luna as flagships. Re-check defaults before
   release and keep the model id user-editable.
5. **Click-through fixes**: PR #52633 (forwarding after reload/crash) and #54201 (cursor flicker) are not
   merged; re-test on the newest 44.x before release and keep the polling fallback.
6. **`type: 'toolbar'`** effect on Alt+Tab and virtual desktops is reported, not documented; verify on
   Windows 10 and 11.
7. **Portable data location**: decide whether portable mode keeps userData in `%APPDATA%` (default) or next
   to the exe (`PORTABLE_EXECUTABLE_DIR`); DPAPI blobs will not decrypt on another machine either way.
8. **SAPI boundary events in Electron**: verify that `SpeechSynthesisUtterance` `boundary` events fire with
   SAPI 5 voices in Electron 44 before relying on them for the "system voice" balloon pacing.
9. **winCodeSign claim**: the "no download for unsigned builds" conclusion comes from reading 26.15.3
   sources; confirm with a clean-cache `npm run dist` on a machine without Developer Mode.

---

## Sources

OpenAI
- Models overview: https://developers.openai.com/api/docs/models
- All models: https://developers.openai.com/api/docs/models/all
- GPT-6 Luna: https://developers.openai.com/api/docs/models/gpt-6-luna
- GPT-6 Sol: https://developers.openai.com/api/docs/models/gpt-6-sol
- GPT-6.1 Sol: https://developers.openai.com/api/docs/models/gpt-6.1-sol
- GPT-5.6 Luna: https://developers.openai.com/api/docs/models/gpt-5.6-luna
- GPT-5.4 mini: https://developers.openai.com/api/docs/models/gpt-5.4-mini
- Latest model guide: https://developers.openai.com/api/docs/guides/latest-model
- Reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- Migrate to Responses: https://developers.openai.com/api/docs/guides/migrate-to-responses
- Streaming guide: https://developers.openai.com/api/docs/guides/streaming-responses
- Chat Completions create reference: https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create
- Responses create reference: https://developers.openai.com/api/reference/python/resources/responses/methods/create
- Text to speech guide: https://developers.openai.com/api/docs/guides/text-to-speech
- Speech create reference: https://developers.openai.com/api/reference/python/resources/audio/subresources/speech/methods/create
- gpt-4o-mini-tts: https://developers.openai.com/api/docs/models/gpt-4o-mini-tts
- Speech to text guide: https://developers.openai.com/api/docs/guides/speech-to-text
- Transcriptions reference: https://developers.openai.com/api/reference/python/resources/audio/subresources/transcriptions/methods/create
- gpt-transcribe: https://developers.openai.com/api/docs/models/gpt-transcribe
- Models list reference: https://developers.openai.com/api/reference/python/resources/models/methods/list
- Error codes: https://developers.openai.com/api/docs/guides/error-codes
- Rate limits: https://developers.openai.com/api/docs/guides/rate-limits
- Deprecations: https://developers.openai.com/api/docs/deprecations
- Changelog: https://developers.openai.com/api/docs/changelog
- OpenAPI spec: https://github.com/openai/openai-openapi (openapi.json on `main`)
- Unsupported temperature error example: https://github.com/openai/openai-python/issues/2072
- credit_balance_exhausted example: https://github.com/promptfoo/promptfoo/issues/10855
- Usage policies: https://openai.com/policies/usage-policies/ and update note https://help.openai.com/en/articles/12092907-were-updating-our-usage-policies
- BYOK discussion: https://community.openai.com/t/bring-your-own-key-policy/446168
- Azure OpenAI v1 API: https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
- OpenRouter Responses beta: https://openrouter.ai/docs/api_reference/responses/overview
- Ollama OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
- LM Studio OpenAI compatibility: https://lmstudio.ai/docs/developer/openai-compat

Electron
- Breaking changes: https://www.electronjs.org/docs/latest/breaking-changes
- v44.0.0 release notes: https://releases.electronjs.org/release/v44.0.0
- Support status: https://endoflife.date/electron
- Custom window styles: https://www.electronjs.org/docs/latest/tutorial/custom-window-styles
- Custom window interactions: https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions
- BaseWindow API: https://www.electronjs.org/docs/latest/api/base-window
- safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- Security checklist: https://www.electronjs.org/docs/latest/tutorial/security
- Fuses: https://www.electronjs.org/docs/latest/tutorial/fuses
- ESM: https://www.electronjs.org/docs/latest/tutorial/esm
- Sandbox: https://www.electronjs.org/docs/latest/tutorial/sandbox
- Protocol: https://www.electronjs.org/docs/latest/api/protocol
- Session permissions: https://www.electronjs.org/docs/latest/api/session
- App (login items, single instance): https://www.electronjs.org/docs/latest/api/app
- Forwarding fixes: https://github.com/electron/electron/pull/52633, https://github.com/electron/electron/pull/52631, https://github.com/electron/electron/pull/54201, https://github.com/electron/electron/issues/33281
- Transparent window issues: https://github.com/electron/electron/issues/46468, https://github.com/electron/electron/pull/49428
- SpeechSynthesis voices on Windows: https://github.com/electron/electron/pull/14070
- Chrome autoplay policy: https://developer.chrome.com/blog/autoplay
- MediaRecorder isTypeSupported: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static
- Local typings: `node_modules/electron/electron.d.ts` (44.5.1)

electron-builder
- Icons: https://www.electron.build/docs/features/icons-and-images/
- Windows config: https://www.electron.build/docs/win
- Releases: https://github.com/electron-userland/electron-builder/releases
- Local sources: `node_modules/app-builder-lib` 26.15.3 (`scheme.json`, `out/winPackager.js`,
  `out/codeSign/windowsSignToolManager.js`, `out/toolsets/windows.js`, `out/util/config/load.js`,
  `out/electron/electronWin.js`, `templates/nsis/*.nsh`, `templates/nsis/portable.nsi`)

Microsoft Agent and Bonzi
- Agent states and standard animation set: https://learn.microsoft.com/en-us/windows/win32/lwef/agent-states
- Animations (frames, duration, mouth positions, speaking frame): https://learn.microsoft.com/en-us/windows/win32/lwef/animations
- Creating animations (branching, exit branching, Return animation): https://learn.microsoft.com/en-us/windows/win32/lwef/creating-animations
- Defining a new character (balloon options): https://learn.microsoft.com/en-us/windows/win32/lwef/defining-a-new-character
- Word balloon support: https://learn.microsoft.com/en-us/windows/win32/lwef/word-balloon-support
- MoveTo: https://learn.microsoft.com/en-us/windows/win32/lwef/moveto-method
- Stop: https://learn.microsoft.com/en-us/windows/win32/lwef/stop-method
- SAPI viseme enum: https://learn.microsoft.com/en-us/previous-versions/windows/desktop/ms720881(v=vs.85)
- ACS spec (Remy Lebeau) mirror: https://uploads.s.zeid.me/ms-agent-format-spec.html
- DoubleAgent source: https://github.com/rschiang/cinsoft-double-agent (files `Core/AgentWnd.cpp`,
  `Core/AgentStreamInfo.cpp`, `Core/QueuedSpeech.cpp`, `Core/QueuedAction.cpp`, `Core/Sapi5Voice.cpp`,
  `Core/DirectSoundLipSync.cpp`, `Core/AgentBalloonWnd.cpp`, `Core/AgentText.cpp`,
  `Core/AgentFileBinary.cpp`, `Common/DaCmnCharacter.cpp`); project page https://sourceforge.net/projects/doubleagent/
- clippy.js animator: https://github.com/smore-inc/clippy.js/blob/master/src/animator.js
- BonziBuddy: https://en.wikipedia.org/wiki/BonziBuddy
- FTC COPPA settlement: https://www.ftc.gov/news-events/news/press-releases/2004/02/umg-recordings-inc-pay-400000-bonzi-software-inc-pay-75000-settle-coppa-civil-penalty-charges
- Bonzi voice settings: https://agentpedia.tmafe.com/wiki/Bonzi
