import { createApp } from './app.js';
import { startBackend } from './backend.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const backend = await startBackend(config);
  const app = createApp(config, backend);

  const server = app.listen(config.port, config.host, () => {
    console.log(`[proxy] OpenAI-compatible API listening on http://${config.host}:${config.port}`);
    console.log(`[proxy] backend: ${backend.url}`);
    console.log(`[proxy] auth: ${config.apiKey ? 'enabled' : 'disabled'}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[proxy] ${signal} received, shutting down...`);
    server.close();
    await backend.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[proxy] fatal:', err);
  process.exit(1);
});
