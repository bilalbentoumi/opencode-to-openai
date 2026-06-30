# opencode-to-openai

A small, type-safe proxy that puts an **OpenAI-compatible REST API** in front of the
[OpenCode](https://opencode.ai) server. Point any OpenAI client (Cursor, Continue, the
`openai` SDK, etc.) at it and use OpenCode's models — including the free ones — through the
standard `/v1/chat/completions` interface.

## How it works

```
OpenAI client ──HTTP──▶ opencode-to-openai ──@opencode-ai/sdk──▶ OpenCode server
   (/v1/...)              (this proxy)                            (opencode serve)
```

- On startup the proxy spawns an **embedded `opencode serve`** (via the SDK's
  `createOpencodeServer`), or connects to an existing server if you point it at one.
- Each chat request creates a fresh OpenCode session, replays the OpenAI message history into
  it, and streams the assistant's reply back in OpenAI's SSE format.
- Token usage and reasoning (`reasoning_content`) are passed through from OpenCode.

## Requirements

- **Node.js ≥ 20**
- **OpenCode CLI** installed and on your `PATH` (`curl -fsSL https://opencode.ai/install | bash`)

## Setup

```bash
npm install
npm run build
npm start
```

For development with live reload:

```bash
npm run dev
```

The proxy listens on `http://127.0.0.1:8083` by default.

## Configuration

Settings resolve with precedence **env var → `config.json` → defaults**. Copy the example to
get started (it is git-ignored):

```bash
cp config.example.json config.json
```

| `config.json` key   | Env var               | Default            | Description                                                                 |
| ------------------- | --------------------- | ------------------ | --------------------------------------------------------------------------- |
| `port`              | `PORT`                | `8083`             | Port the proxy listens on.                                                  |
| `host`              | `HOST`                | `127.0.0.1`        | Interface to bind.                                                          |
| `apiKey`            | `API_KEY`             | `""` (no auth)     | If set, requests must send `Authorization: Bearer <key>`.                   |
| `defaultModel`      | `DEFAULT_MODEL`       | `opencode/deepseek-v4-flash-free` | Model used when a request omits `model`.                                  |
| `requestTimeoutMs`  | `REQUEST_TIMEOUT_MS`  | `300000`           | Per-request timeout.                                                        |
| `opencodeServerUrl` | `OPENCODE_SERVER_URL` | `""`               | Connect to an existing OpenCode server instead of spawning an embedded one. |
| `opencodePort`      | `OPENCODE_PORT`       | `4097`             | Port for the embedded OpenCode server.                                      |
| `forwardAuth`       | `FORWARD_AUTH`        | `true`             | Forward the caller's `Authorization` header onto calls to the OpenCode server. |

### Forwarding auth to OpenCode

When `forwardAuth` is on (the default), the proxy attaches the **incoming request's
`Authorization` header verbatim** to every HTTP call it makes to the OpenCode server. This is
what you want when pointing the proxy at an OpenCode server protected with
[`OPENCODE_SERVER_PASSWORD`](https://opencode.ai/docs/server) (HTTP basic auth, username
`opencode`):

```bash
# Start a protected OpenCode server
OPENCODE_SERVER_PASSWORD=secret opencode serve --port 4096

# Run the proxy against it
OPENCODE_SERVER_URL=http://127.0.0.1:4096 npm start

# Call the proxy with the matching basic-auth credential — it is forwarded through
curl http://127.0.0.1:8083/v1/models \
  -H "Authorization: Basic $(printf 'opencode:secret' | base64)"
```

The header is forwarded as-is (no transformation), so send whatever the OpenCode server
expects. Set `forwardAuth` to `false` to keep the proxy's own auth fully separate from the
backend. Note the model catalog is cached briefly and shared across callers, so this is best
suited to a single shared server credential rather than per-caller provider keys.

## Endpoints

| Method | Path                   | Description                                              |
| ------ | ---------------------- | ------------------------------------------------------- |
| `GET`  | `/health`              | Liveness check.                                         |
| `GET`  | `/v1/models`           | Lists OpenCode provider/models as OpenAI model objects. |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming).         |

Model ids use OpenCode's `provider/model` form, e.g. `opencode/deepseek-v4-flash-free` or
`anthropic/claude-sonnet-4-6`.

## Examples

List models:

```bash
curl http://127.0.0.1:8083/v1/models
```

Non-streaming chat:

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

Streaming chat:

```bash
curl -N -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "count to 5"}],
    "stream": true
  }'
```

Using the official `openai` SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8083/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="opencode/deepseek-v4-flash-free",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

## Limitations

- **No tool / function calling translation.** OpenAI `tools`/`function_call` fields are ignored;
  the model answers as text.
- Conversations are stateless per request (the full history is replayed into a new OpenCode
  session each time), matching OpenAI semantics.

## License

MIT
