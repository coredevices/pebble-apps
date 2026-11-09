import { afterEach, expect, it, vi } from 'vitest';
import { FoyerAuth, FoyerClient } from '../src/foyer-client';
import type { GpsOAuth } from '../src/gpsoauth';

afterEach(() => vi.unstubAllGlobals());

it('concurrent 403s move to the next scope once and share one new token', async () => {
  const getAuthToken = vi.fn(async (_m: string, _a: string, scope: string) => ({
    auth: `token-${scope}`,
    expiryEpochSeconds: null,
  }));
  const auth = new FoyerAuth('master', 'android', { getAuthToken } as unknown as GpsOAuth, ['A', 'B']);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string> }) => ({
      status: init.headers['Authorization'] === 'Bearer token-A' ? 403 : 200,
      text: async () => '[]',
    })),
  );
  const foyer = new FoyerClient(auth);

  await Promise.all(Array.from({ length: 14 }, (_, i) => foyer.getTraits([`d${i}`])));

  expect(getAuthToken.mock.calls.map((c) => c[2])).toEqual(['A', 'B']);
});
