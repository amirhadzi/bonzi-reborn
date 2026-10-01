# Mock OpenAI API

`scripts/mock-openai.mjs` is a dependency-free stand-in for the parts of the OpenAI API that BonziBuddy Reborn uses. It exists so the app can be exercised end to end (chat streaming, speech with lip-sync, transcription, error handling) without a real API key. It uses only Node built-ins, binds to `127.0.0.1` only, and never makes outbound requests.

## Running it

```bash
npm run mock:openai                      # http://127.0.0.1:8787
node scripts/mock-openai.mjs --port 9000
MOCK_OPENAI_PORT=9000 node scripts/mock-openai.mjs
node scripts/mock-openai.mjs --port 0    # ephemeral port, printed on startup
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-p, --port <n>` | `$MOCK_OPENAI_PORT`, else `8787` | Port to listen on (`0` picks a free port). `--port` wins over the env var. |
| `-q, --quiet` | off | Suppress the one-line-per-request log. |
| `--chunk-delay <min>-<max>` | `20-40` | Delay in ms between streamed chat chunks. Use `0-1` for fast automated runs. |
| `--slow-ms <n>` | `3000` | Delay before the first token for `trigger slow`. |
| `-h, --help` | | Print usage. |

On startup it prints the URLs and finishes with a machine-readable line that scripts can wait for:

```
MOCK_OPENAI_READY http://127.0.0.1:8787/v1
```

Each request is logged as one line, for example `[mock-openai] 07:08:47.350 POST /v1/chat/completions 200 1532ms model=gpt-5-mini stream trigger=slow`. The API key and the query string are never logged. Stop the server with Ctrl+C.

## Pointing the app at it

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key | any non-empty key, e.g. `sk-test-local` |

Enter these wherever the app (or a test harness) configures the OpenAI base URL and key. The key `sk-bad` is special: it is always rejected with 401, which is handy for testing the key-validation flow in settings. Any other non-empty Bearer token is accepted.

With the official SDK the equivalent is `new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'sk-test-local' })`.

## Endpoints

All `/v1/*` routes require `Authorization: Bearer <key>`. Missing, malformed or `sk-bad` keys get:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "param": null, "code": "invalid_api_key" } }
```

Unknown routes return 404 `Invalid URL (METHOD /path)` in the same error shape. Every response carries `x-request-id`, `openai-version` and `x-mock-server: bonzi-mock-openai` headers.

### `GET /v1/models` and `GET /v1/models/{id}`

Returns `{ "object": "list", "data": [{ id, object: "model", created, owned_by }, ...] }` with a mix of model types so clients can test filtering: `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini`, `o4-mini`, `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`, `text-embedding-3-small`, `text-embedding-3-large`, `dall-e-3`, `gpt-image-1`, `omni-moderation-latest`.

### `POST /v1/chat/completions`

Accepts `{ model, messages, stream?, stream_options?, max_completion_tokens?, max_tokens?, ... }`. Unrecognised parameters (tools, response_format and so on) are accepted and ignored.

The default reply is a friendly 3 to 4 sentence Bonzi-style message that quotes part of the last user message (trimmed to about 48 characters, with `[[`, `]]` and sentence punctuation removed). It always contains `[[Wave]]` in the first sentence and `[[Pleased]]` in the last one, and sometimes `[[Think]]` or `[[Explain]]` in between. All tag names are real animations from `Bonzi.acs`. Replies are deterministic for a given model and last user message, so the streamed text always equals the non-streamed text for the same request.

* **Non-stream** returns a standard `chat.completion` object with `choices[0].message.content`, `finish_reason: "stop"` and an estimated `usage` block (about 4 characters per token).
* **Stream** (`stream: true`) returns `text/event-stream` in the `chat.completion.chunk` format: a first chunk with `delta: { role: "assistant", content: "" }`, then content deltas of 2 to 6 characters spaced 20 to 40 ms apart, then a chunk with an empty delta and `finish_reason: "stop"`, then `data: [DONE]`. The first `[[Tag]]` is always split across two chunks on purpose, so the client's tag parser must buffer partial tags. With `stream_options: { include_usage: true }`, every chunk carries `usage: null` and a final `choices: []` chunk with the usage totals is sent before `[DONE]`.
* If `max_completion_tokens` (or `max_tokens`) is smaller than the reply's estimated token count, the content is cut to `limit * 4` characters and `finish_reason` becomes `"length"`.

Validation errors use the real API's shape: missing `model` (400), missing or empty `messages` (400, `param: "messages"`), an invalid role (400, `param: "messages[i].role"`), invalid JSON (400), and `stream_options` without `stream: true` (400). Model checks are lenient so the app can use any current model name. The exceptions are known non-chat models such as `whisper-1` or `dall-e-3`, which return 404 "not a chat model", and any id starting with `nonexistent`, which returns 404 `model_not_found`.

### `POST /v1/audio/speech`

Accepts `{ model, input, voice, response_format?, instructions?, speed? }`. `instructions` is accepted and ignored.

The audio is a synthetic voice-like signal designed for lip-sync testing rather than listening. Each input character occupies 60 ms (divided by `speed`), and the total is capped at 30 s. Letters and digits produce a low-passed sawtooth buzz at 120 to 180 Hz (the base pitch is stable per voice) shaped by a 4 to 6 Hz syllable-like amplitude envelope; spaces and punctuation produce silence. Output is deterministic for the same input and voice.

| `response_format` | What you get |
| --- | --- |
| `wav` | RIFF/WAVE, PCM16, mono, 24 kHz, 44-byte header, `content-type: audio/wav` |
| `pcm` | Raw 24 kHz 16-bit little-endian mono samples, `content-type: audio/pcm` |
| `mp3` (the API default), `opus`, `aac`, `flac` | **WAV** (as above) with `content-type: audio/wav` and an `x-mock-note` header explaining the substitution, because these codecs cannot be encoded without dependencies |

Responses also carry `x-mock-duration-ms` and `x-mock-sample-rate`. A client that decodes audio with the Web Audio API (`decodeAudioData`) handles the WAV substitution transparently; a client that trusts the requested format blindly will see the mismatch, which the note header makes easy to spot.

Validation: `input` must be a non-blank string of at most 4096 characters (400 `empty_string` or `string_above_max_length`, `param: "input"`), `voice` must be one of `alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer, verse, marin, cedar`, `response_format` must be one of the formats above, and `speed` must be between 0.25 and 4.0.

### `POST /v1/audio/transcriptions`

Expects `multipart/form-data` with a `file` part and a `model` field (`language`, `prompt` and `response_format` are optional). Returns:

```json
{ "text": "Hello Bonzi, this is a mock transcription (N bytes)." }
```

where `N` is the uploaded file size. `response_format` may be `json` (default), `text`, `verbose_json` (duration is read from a WAV header when present), `srt` or `vtt`. Errors: no `file` part (400, `param: "file"`), no `model` (400), an empty file (400 `audio_too_short`), and a non-multipart body (400).

## Magic triggers

Put one of these phrases anywhere in the **last user message** of a chat request (case-insensitive). Errors are returned as normal JSON error responses even when `stream: true` was requested, just like the real API.

| Phrase | Effect |
| --- | --- |
| `trigger 429` | 429, `code: "rate_limit_exceeded"`, `type: "requests"`, headers `retry-after: 1` and `retry-after-ms: 1000` |
| `trigger quota` | 429, `type` and `code` both `"insufficient_quota"`, no retry-after header (retrying will not help) |
| `trigger 500` | 500, `type: "server_error"` |
| `trigger slow` | Waits 3 s (`--slow-ms`) before the first token. For streams the 200 headers are flushed immediately, so this tests a first-token timeout rather than a connect timeout. |
| `trigger long` | About 12 sentences with several different tags |
| `trigger badparam` | 400 `{ message: "Unsupported parameter: 'temperature' is not supported with this model.", type: "invalid_request_error", param: "temperature", code: "unsupported_parameter" }`, but **only** when the request body contains `temperature`. A retry without `temperature` succeeds normally. |
| `trigger hang` | Streams the role chunk and two content chunks, then stalls forever. Non-stream requests never get a response. Use it to test client aborts and timeouts. |

Adding `once` after an error trigger (for example `trigger 429 once` or `trigger 500 once`) makes it fire only on the first request with that exact message; repeating the same message then succeeds, which is useful for testing automatic retry. `POST /__mock/reset` re-arms it. `trigger slow` and `trigger long` can be combined in one message.

## Inspecting traffic

These control routes need no auth and are not themselves recorded.

| Route | Purpose |
| --- | --- |
| `GET /__mock/requests` | JSON array of recorded requests |
| `POST /__mock/reset` | Clears the recording (and re-arms `once` triggers); returns `{ ok: true, cleared: N }` |
| `GET /__mock/health` | `{ ok: true }`, for readiness checks |

Each recorded request looks like this:

```json
{
  "id": 2, "time": "2026-10-01T07:08:47.279Z",
  "method": "POST", "path": "/v1/chat/completions", "query": {},
  "headers": { "content-type": "application/json", "...": "..." },
  "hasAuth": true,
  "body": { "model": "gpt-5-mini", "messages": [ ... ], "stream": true },
  "status": 200, "durationMs": 1532, "completed": true
}
```

`headers` never includes `authorization` (or `cookie`, `api-key`, `x-api-key`); `hasAuth` only says whether one was sent. JSON bodies are stored parsed. Multipart bodies are summarised as `{ fields: { model: "whisper-1", ... }, files: [{ field, filename, contentType, size }] }` without the file bytes. `status`, `durationMs` and `completed` are filled in when the response closes; `completed: false` means the client went away first (for example after aborting a `trigger hang` stream).

## Using it from tests

```ts
// @ts-ignore: the script is plain .mjs without a declaration file
import { startMockServer } from '../scripts/mock-openai.mjs';

const mock = await startMockServer({ port: 0, log: false, chunkDelayMs: [0, 1] });
// mock.url      -> 'http://127.0.0.1:54321'      (origin, for /__mock/* routes)
// mock.baseURL  -> 'http://127.0.0.1:54321/v1'   (give this to the app)
// mock.requests -> live array of recorded requests (same data as GET /__mock/requests)
// mock.reset()  -> clears it and returns how many were removed
await mock.close(); // also tears down hung streams
```

Options: `port` (default `0`, i.e. ephemeral, when used as a library), `log` (`true` logs to stdout, `false` is silent, or pass a function that receives each line), `chunkDelayMs` (`[min, max]`, default `[20, 40]`) and `slowDelayMs` (default `3000`).

The module also exports a few helpers that are useful for audio tests without a server: `synthesizeSpeech(text, { voice, speed })` returns an `Int16Array` of 24 kHz samples, `encodeWav(samples)` wraps them in a WAV header, and `speechDurationMs(text, speed)` gives the expected duration.

The mock's own tests live in `tests/mock-openai.test.ts`:

```bash
npx vitest run tests/mock-openai.test.ts
```

## Limitations

* Only the endpoints above exist. The Responses API (`/v1/responses`), embeddings, images, moderation and the Realtime API return 404.
* Tool calls, structured outputs, `n > 1` and logprobs are not simulated; those parameters are accepted and ignored.
* Speech output is always PCM (WAV or raw) whatever format was requested, and streaming TTS (`stream_format: "sse"`) is not supported.
* Token counts are rough estimates (characters divided by 4).
