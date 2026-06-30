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
```

The proxy listens on `http://127.0.0.1:8083` by default.

## CLI

The `oc-openai` command runs the proxy as a **background daemon** and manages its lifecycle.
After `npm run build`, either install it globally (`npm install -g .`, exposing `oc-openai` on
your `PATH`) or invoke it through `npm run cli -- <args>`.

```bash
oc-openai start --port 8083 --host 127.0.0.1   # start in the background
oc-openai status                               # is it running? (pid, address, health)
oc-openai logs --follow                         # tail the daemon's log
oc-openai restart                               # stop then start
oc-openai stop                                  # graceful shutdown (SIGTERM)
```

`start` detaches the server, captures its output to a log file, and waits for `/health` to pass
before returning. State (pid, port, log path) is tracked per port under
`~/.oc-openai/`, so you can run several instances on different ports — `status`, `stop`,
`logs`, and `restart` accept `--port N` to target one (defaulting to `8083`).

| Command   | Description                                                       |
| --------- | ----------------------------------------------------------------- |
| `start`   | Start the proxy in the background (`-f`/`--foreground` to attach). |
| `stop`    | Gracefully stop the running proxy.                                |
| `status`  | Report whether it's running, plus pid, address, and health.       |
| `restart` | Stop then start.                                                  |
| `logs`    | Print the log (`--lines N`, `--follow` to stream).                |

All configuration is passed as flags to `start`; omit any flag to use its default. Run
`oc-openai --help` for the full list.

### Running in the foreground

For development with live reload, or to run under a process supervisor:

```bash
npm run dev                  # tsx watch, foreground
oc-openai start --foreground # built server, foreground (no detach)
```

## Configuration

There is no config file — everything is a flag on `oc-openai start`, and any flag you omit falls
back to its default.

| Flag                | Default                           | Description                                                                 |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `--port`            | `8083`                            | Port the proxy listens on.                                                  |
| `--host`            | `127.0.0.1`                       | Interface to bind.                                                          |
| `--opencode-url`    | _(none)_                          | Connect to an existing OpenCode server instead of spawning an embedded one. |
| `--opencode-port`   | `4097`                            | Port for the embedded OpenCode server.                                      |
| `--request-timeout` | `300000`                          | Per-request timeout in milliseconds.                                        |

```bash
# All defaults — clients must send 'Authorization: Bearer oc-openai'
oc-openai start

# Custom port and key
oc-openai start --port 9000
```

> **Auth is always on.** Every request to `/v1/*` must send `Authorization: Bearer <api-key>`
> (only `/health` and `/` are open).

### Forwarding auth to OpenCode

By default the proxy attaches the **incoming request's `Authorization` header verbatim** to every
HTTP call it makes to the OpenCode server. Since the proxy always requires
`Authorization: Bearer <api-key>`, that exact Bearer header is what gets forwarded — so this only
helps when the OpenCode server accepts the same Bearer token. If your OpenCode server uses a
different scheme (e.g. HTTP basic auth via
[`OPENCODE_SERVER_PASSWORD`](https://opencode.ai/docs/server)), configure that credential out of
band on the backend. The model catalog is cached briefly and shared across callers, so this is
best suited to a single shared server credential rather than per-caller provider keys.

## Endpoints

| Method | Path                   | Description                                              |
| ------ | ---------------------- | ------------------------------------------------------- |
| `GET`  | `/health`              | Liveness check.                                         |
| `GET`  | `/v1/models`           | Lists OpenCode provider/models as OpenAI model objects. |
| `POST` | `/v1/chat/completions` | Chat completions (streaming and non-streaming).         |

Model ids use OpenCode's `provider/model` form, e.g. `opencode/deepseek-v4-flash-free` or
`anthropic/claude-sonnet-4-6`.

## Examples

Every request must send `Authorization: Bearer <api-key>`. 

List models:

```bash
curl http://127.0.0.1:8083/v1/models \
  -H "Authorization: Bearer oc-openai"
```

Non-streaming chat:

```bash
curl -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Authorization: Bearer oc-openai" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{"role": "user", "content": "hi"}]
  }'
```

Streaming chat:

```bash
curl -N -X POST http://127.0.0.1:8083/v1/chat/completions \
  -H "Authorization: Bearer oc-openai" \
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

client = OpenAI(base_url="http://127.0.0.1:8083/v1", api_key="oc-openai")
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
