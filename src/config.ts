import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export interface Config {
  /** Port the OpenAI-compatible proxy listens on. */
  port: number;
  /** Host/interface the proxy binds to. */
  host: string;
  /** Optional bearer token required on requests. Empty string disables auth. */
  apiKey: string;
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

const defaults: Config = {
  port: 8083,
  host: '127.0.0.1',
  apiKey: '',
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

function readFileConfig(): Partial<Config> {
  const configPath = path.join(projectRoot, 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<Config>;
    console.log('[config] loaded config.json');
    return parsed;
  } catch (err) {
    console.error(`[config] failed to parse config.json: ${(err as Error).message}`);
    return {};
  }
}

function readEnvConfig(): Partial<Config> {
  const env = process.env;
  const out: Partial<Config> = {};
  if (env.PORT) out.port = Number(env.PORT);
  if (env.HOST) out.host = env.HOST;
  if (env.API_KEY) out.apiKey = env.API_KEY;
  if (env.DEFAULT_MODEL) out.defaultModel = env.DEFAULT_MODEL;
  if (env.REQUEST_TIMEOUT_MS) out.requestTimeoutMs = Number(env.REQUEST_TIMEOUT_MS);
  if (env.OPENCODE_SERVER_URL) out.opencodeServerUrl = env.OPENCODE_SERVER_URL;
  if (env.OPENCODE_PORT) out.opencodePort = Number(env.OPENCODE_PORT);
  const forwardAuth = parseBool(env.FORWARD_AUTH);
  if (forwardAuth !== undefined) out.forwardAuth = forwardAuth;
  return out;
}

/** Resolve config with precedence: env > config.json > defaults. */
export function loadConfig(): Config {
  return { ...defaults, ...readFileConfig(), ...readEnvConfig() };
}
