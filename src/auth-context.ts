import { AsyncLocalStorage } from 'node:async_hooks';

const authStorage = new AsyncLocalStorage<string | undefined>();

export function runWithForwardedAuth<T>(
  authorization: string | undefined,
  fn: () => T,
): T {
  return authStorage.run(authorization, fn);
}

export function getForwardedAuth(): string | undefined {
  return authStorage.getStore();
}
