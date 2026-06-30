import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
} from '@opencode-ai/sdk';
import { getForwardedAuth } from './auth-context.js';
import type { Config } from './types.js';

export interface Backend {
  client: OpencodeClient;
  url: string;
  close: () => Promise<void>;
}

const forwardingFetch = (request: Request): Promise<Response> => {
  const authorization = getForwardedAuth();
  if (!authorization) return globalThis.fetch(request);
  const headers = new Headers(request.headers);
  headers.set('Authorization', authorization);
  return globalThis.fetch(new Request(request, { headers }));
};

export async function startBackend(config: Config): Promise<Backend> {
  const fetchImpl = config.forwardAuth ? forwardingFetch : undefined;

  if (config.opencodeServerUrl) {
    const url = config.opencodeServerUrl.replace(/\/$/, '');
    console.log(`[backend] connecting to existing OpenCode server at ${url}`);
    const client = createOpencodeClient({ baseUrl: url, fetch: fetchImpl });
    return { client, url, close: async () => {} };
  }

  console.log('[backend] starting embedded OpenCode server...');
  const server = await createOpencodeServer({
    hostname: '127.0.0.1',
    port: config.opencodePort,
  });
  console.log(`[backend] embedded OpenCode server ready at ${server.url}`);
  const client = createOpencodeClient({
    baseUrl: server.url,
    fetch: fetchImpl,
  });
  return {
    client,
    url: server.url,
    close: async () => server.close(),
  };
}
