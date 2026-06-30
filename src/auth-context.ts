import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request storage for the caller's `Authorization` header so it can be
 * forwarded onto the proxy's HTTP calls to the OpenCode server.
 */
const authStorage = new AsyncLocalStorage<string | undefined>();

/** Run `fn` with the given Authorization header bound to the current async context. */
export function runWithForwardedAuth<T>(authorization: string | undefined, fn: () => T): T {
  return authStorage.run(authorization, fn);
}

/** The Authorization header to forward for the in-flight request, if any. */
export function getForwardedAuth(): string | undefined {
  return authStorage.getStore();
}
