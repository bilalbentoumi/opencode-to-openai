import type { Config } from './types.js';

export const defaults: Config = {
  port: 8083,
  host: '127.0.0.1',
  requestTimeoutMs: 300_000,
  opencodeServerUrl: '',
  opencodePort: 4097,
  forwardAuth: true,
};
