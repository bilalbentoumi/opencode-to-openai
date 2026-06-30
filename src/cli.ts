#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, 'index.js');

const stateDir =
  process.env.OC_OPENAI_STATE_DIR ?? path.join(os.homedir(), '.opencode-to-openai');

interface Instance {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  logFile: string;
}

const stateFile = (port: number) => path.join(stateDir, `instance-${port}.json`);
const logFile = (port: number) => path.join(stateDir, `instance-${port}.log`);

function ensureStateDir(): void {
  fs.mkdirSync(stateDir, { recursive: true });
}

function readInstance(port: number): Instance | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(port), 'utf8')) as Instance;
  } catch {
    return null;
  }
}

function writeInstance(instance: Instance): void {
  ensureStateDir();
  fs.writeFileSync(stateFile(instance.port), JSON.stringify(instance, null, 2));
}

function removeInstance(port: number): void {
  try {
    fs.rmSync(stateFile(port));
  } catch {
    /* ignore */
  }
}

/** True if a process with this pid is currently alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Host clients can dial — 0.0.0.0/:: aren't connectable, so fall back to loopback. */
function dialHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '') return '127.0.0.1';
  return host;
}

async function isHealthy(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${dialHost(host)}:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- commands ---

interface StartOptions {
  port?: number;
  host?: string;
  defaultModel?: string;
  opencodeUrl?: string;
  opencodePort?: number;
  requestTimeoutMs?: number;
  forwardAuth?: boolean;
  foreground?: boolean;
}

/** Build the child env, mapping CLI options onto the env vars config.ts reads. */
function childEnv(opts: StartOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.port !== undefined) env.PORT = String(opts.port);
  if (opts.host !== undefined) env.HOST = opts.host;
  if (opts.defaultModel !== undefined) env.DEFAULT_MODEL = opts.defaultModel;
  if (opts.opencodeUrl !== undefined) env.OPENCODE_SERVER_URL = opts.opencodeUrl;
  if (opts.opencodePort !== undefined) env.OPENCODE_PORT = String(opts.opencodePort);
  if (opts.requestTimeoutMs !== undefined) env.REQUEST_TIMEOUT_MS = String(opts.requestTimeoutMs);
  if (opts.forwardAuth !== undefined) env.FORWARD_AUTH = String(opts.forwardAuth);
  return env;
}

/** Resolve the effective port/host from CLI flags, falling back to config/defaults. */
function resolveTarget(port?: number, host?: string): { port: number; host: string } {
  const config = loadConfig();
  return { port: port ?? config.port, host: host ?? config.host };
}

async function cmdStart(opts: StartOptions): Promise<number> {
  const { port, host } = resolveTarget(opts.port, opts.host);

  if (opts.foreground) {
    // Run the server in this process (handy for debugging / supervisors).
    const env = childEnv({ ...opts, port, host });
    const child = spawn(process.execPath, [serverEntry], { stdio: 'inherit', env });
    return await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
  }

  const existing = readInstance(port);
  if (existing && isAlive(existing.pid)) {
    console.error(`oc-openai is already running on port ${port} (pid ${existing.pid}).`);
    return 1;
  }

  ensureStateDir();
  const log = logFile(port);
  const out = fs.openSync(log, 'a');
  const env = childEnv({ ...opts, port, host });

  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  fs.closeSync(out);

  if (child.pid === undefined) {
    console.error('Failed to spawn the server process.');
    return 1;
  }

  const instance: Instance = {
    pid: child.pid,
    port,
    host,
    startedAt: new Date().toISOString(),
    logFile: log,
  };
  writeInstance(instance);
  child.unref();

  // Wait for the server to come up (or die) before reporting back.
  process.stdout.write('Starting oc-openai');
  for (let i = 0; i < 30; i++) {
    if (!isAlive(child.pid)) {
      process.stdout.write('\n');
      console.error(`Server exited during startup. Recent log (${log}):\n`);
      console.error(tailLog(port, 20));
      removeInstance(port);
      return 1;
    }
    if (await isHealthy(host, port)) {
      process.stdout.write(' ok\n');
      console.log(`oc-openai running on http://${dialHost(host)}:${port} (pid ${child.pid})`);
      console.log(`Logs: ${log}`);
      return 0;
    }
    process.stdout.write('.');
    await sleep(500);
  }

  process.stdout.write('\n');
  console.log(
    `oc-openai started (pid ${child.pid}) but did not pass a health check in time. It may still be initializing.`,
  );
  console.log(`Check status with 'oc-openai status' or inspect the log: ${log}`);
  return 0;
}

async function cmdStop(port: number): Promise<number> {
  const instance = readInstance(port);
  if (!instance) {
    console.error(`No oc-openai instance recorded for port ${port}.`);
    return 1;
  }
  if (!isAlive(instance.pid)) {
    console.log(`oc-openai on port ${port} was not running; cleaning up state.`);
    removeInstance(port);
    return 0;
  }

  try {
    process.kill(instance.pid, 'SIGTERM');
  } catch (err) {
    console.error(`Failed to signal pid ${instance.pid}: ${(err as Error).message}`);
    return 1;
  }

  process.stdout.write(`Stopping oc-openai (pid ${instance.pid})`);
  for (let i = 0; i < 20; i++) {
    if (!isAlive(instance.pid)) {
      process.stdout.write(' stopped\n');
      removeInstance(port);
      return 0;
    }
    process.stdout.write('.');
    await sleep(500);
  }

  // Didn't exit gracefully — force it.
  process.stdout.write('\n');
  console.log('Graceful shutdown timed out; sending SIGKILL.');
  try {
    process.kill(instance.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  removeInstance(port);
  return 0;
}

async function cmdStatus(port: number): Promise<number> {
  const instance = readInstance(port);
  if (!instance) {
    console.log(`oc-openai: stopped (no instance recorded for port ${port}).`);
    return 1;
  }
  if (!isAlive(instance.pid)) {
    console.log(`oc-openai: stopped (stale state for pid ${instance.pid} on port ${port}).`);
    return 1;
  }

  const healthy = await isHealthy(instance.host, instance.port);
  console.log(`oc-openai: running`);
  console.log(`  pid:     ${instance.pid}`);
  console.log(`  address: http://${dialHost(instance.host)}:${instance.port}`);
  console.log(`  health:  ${healthy ? 'ok' : 'not responding'}`);
  console.log(`  started: ${instance.startedAt}`);
  console.log(`  logs:    ${instance.logFile}`);
  return healthy ? 0 : 1;
}

function tailLog(port: number, lines: number): string {
  try {
    const content = fs.readFileSync(logFile(port), 'utf8');
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '(no log file)';
  }
}

function cmdLogs(port: number, follow: boolean, lines: number): number {
  const log = logFile(port);
  if (!fs.existsSync(log)) {
    console.error(`No log file for port ${port} (${log}).`);
    return 1;
  }
  console.log(tailLog(port, lines));
  if (follow) {
    let size = fs.statSync(log).size;
    fs.watchFile(log, { interval: 500 }, () => {
      const next = fs.statSync(log).size;
      if (next > size) {
        const fd = fs.openSync(log, 'r');
        const buf = Buffer.alloc(next - size);
        fs.readSync(fd, buf, 0, buf.length, size);
        fs.closeSync(fd);
        process.stdout.write(buf.toString('utf8'));
        size = next;
      }
    });
  }
  return 0;
}

function printHelp(): void {
  console.log(`oc-openai — OpenAI-compatible proxy for OpenCode

Usage:
  oc-openai start [options]      Start the proxy in the background
  oc-openai stop [--port N]      Stop a running proxy
  oc-openai status [--port N]    Show whether the proxy is running
  oc-openai restart [options]    Restart the proxy
  oc-openai logs [--port N]      Print the proxy log
  oc-openai --help               Show this help

Start options:
  --port N                Port to listen on (default: config/8083)
  --host HOST             Interface to bind (default: config/127.0.0.1)
  --default-model MODEL   Model used when a request omits one
  --opencode-url URL      Connect to an existing OpenCode server
  --opencode-port N       Port for the embedded OpenCode server
  --request-timeout MS    Per-request timeout in milliseconds
  --no-forward-auth       Don't forward the caller's Authorization header
  --foreground, -f        Run in the foreground instead of detaching

Logs options:
  --lines N               Number of trailing lines to print (default: 50)
  --follow                Stream new log output as it is written

Examples:
  oc-openai start --port 8083 --host 0.0.0.0
  oc-openai status
  oc-openai stop`);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return command ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'api-key': { type: 'string' },
      'default-model': { type: 'string' },
      'opencode-url': { type: 'string' },
      'opencode-port': { type: 'string' },
      'request-timeout': { type: 'string' },
      'no-forward-auth': { type: 'boolean' },
      foreground: { type: 'boolean', short: 'f' },
      lines: { type: 'string' },
      follow: { type: 'boolean' },
    },
  });

  const portFlag = values.port !== undefined ? Number(values.port) : undefined;
  if (portFlag !== undefined && !Number.isInteger(portFlag)) {
    console.error(`Invalid --port: ${values.port}`);
    return 1;
  }

  switch (command) {
    case 'start': {
      const startOpts: StartOptions = {
        port: portFlag,
        host: values.host,
        apiKey: values['api-key'],
        defaultModel: values['default-model'],
        opencodeUrl: values['opencode-url'],
        opencodePort: values['opencode-port'] !== undefined ? Number(values['opencode-port']) : undefined,
        requestTimeoutMs:
          values['request-timeout'] !== undefined ? Number(values['request-timeout']) : undefined,
        forwardAuth: values['no-forward-auth'] ? false : undefined,
        foreground: values.foreground,
      };
      return await cmdStart(startOpts);
    }
    case 'stop': {
      const { port } = resolveTarget(portFlag, values.host);
      return await cmdStop(port);
    }
    case 'status': {
      const { port } = resolveTarget(portFlag, values.host);
      return await cmdStatus(port);
    }
    case 'restart': {
      const { port } = resolveTarget(portFlag, values.host);
      await cmdStop(port);
      await sleep(500);
      return await cmdStart({
        port: portFlag,
        host: values.host,
        apiKey: values['api-key'],
        defaultModel: values['default-model'],
        opencodeUrl: values['opencode-url'],
        opencodePort: values['opencode-port'] !== undefined ? Number(values['opencode-port']) : undefined,
        requestTimeoutMs:
          values['request-timeout'] !== undefined ? Number(values['request-timeout']) : undefined,
        forwardAuth: values['no-forward-auth'] ? false : undefined,
      });
    }
    case 'logs': {
      const { port } = resolveTarget(portFlag, values.host);
      const lines = values.lines !== undefined ? Number(values.lines) : 50;
      return cmdLogs(port, Boolean(values.follow), lines);
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    // Don't exit while `logs --follow` is watching the file.
    if (!process.argv.includes('--follow')) process.exit(code);
  })
  .catch((err) => {
    console.error(`oc-openai: ${(err as Error).message}`);
    process.exit(1);
  });
