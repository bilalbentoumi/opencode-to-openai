export interface Config {
  /** Port the OpenAI-compatible proxy listens on. */
  port: number;
  /** Host/interface the proxy binds to. */
  host: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Model used when a request omits one. */
  defaultModel: string;
  /**
   * URL of an existing OpenCode server to connect to. When empty, the proxy
   * spawns an embedded `opencode serve` on {@link Config.opencodePort}.
   */
  opencodeServerUrl: string;
  /** Port for the embedded OpenCode server (ignored if opencodeServerUrl is set). */
  opencodePort: number;
  /** Forward the caller's `Authorization` header onto requests to the OpenCode server. */
  forwardAuth: boolean;
}

export const defaults: Config = {
  port: 8083,
  host: '127.0.0.1',
  requestTimeoutMs: 300_000,
  defaultModel: 'opencode/deepseek-v4-flash-free',
  opencodeServerUrl: '',
  opencodePort: 4097,
  forwardAuth: true,
};

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return undefined;
}

/**
 * Read config from environment variables. This is the channel the CLI uses to
 * hand options to the detached server process — CLI flags are mapped onto these
 * vars before the child is spawned (see cli.ts).
 */
function readEnvConfig(): Partial<Config> {
  const env = process.env;
  const out: Partial<Config> = {};
  if (env.PORT) out.port = Number(env.PORT);
  if (env.HOST) out.host = env.HOST;
  if (env.DEFAULT_MODEL) out.defaultModel = env.DEFAULT_MODEL;
  if (env.REQUEST_TIMEOUT_MS) out.requestTimeoutMs = Number(env.REQUEST_TIMEOUT_MS);
  if (env.OPENCODE_SERVER_URL) out.opencodeServerUrl = env.OPENCODE_SERVER_URL;
  if (env.OPENCODE_PORT) out.opencodePort = Number(env.OPENCODE_PORT);
  const forwardAuth = parseBool(env.FORWARD_AUTH);
  if (forwardAuth !== undefined) out.forwardAuth = forwardAuth;
  return out;
}

/** Resolve config with precedence: CLI flags (via env) > defaults. */
export function loadConfig(): Config {
  return { ...defaults, ...readEnvConfig() };
}
