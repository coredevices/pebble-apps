import { describe, expect, it } from 'vitest';
import { blockedHost, blockedMessage, checkReach, failureBlocked, lastBlocked } from '../src/reach';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const permissions = (states: Record<string, 'granted' | 'denied' | 'prompt'>): PebblePermissions => ({
  query: async (key) => states[key] ?? 'granted',
});
const noRequest = (): Promise<unknown> => { throw new Error('no request expected'); };
const notAllowed = (url: string) => Object.assign(new Error(`fetch not allowed: ${url}`), { name: 'NotAllowedError' });

describe('reach', () => {
  it('with Pebble.permissions, names the first domain not granted for sure, without any request', async () => {
    expect(await blockedHost(noRequest, permissions({}))).toBeNull();
    expect(await blockedHost(noRequest, permissions({
      'Internet/googlehomefoyer-pa.clients6.google.com': 'denied',
      'Internet/android.clients.google.com': 'denied',
    }))).toEqual({ host: 'googlehomefoyer-pa.clients6.google.com', sure: true });
    expect(await blockedHost(noRequest, permissions({ 'Internet/android.clients.google.com': 'prompt' })))
      .toEqual({ host: 'android.clients.google.com', sure: true });
    expect(blockedMessage({ host: 'android.clients.google.com', sure: true })).toBe(
      'Google Home doesn\'t have permission to connect to android.clients.google.com. Turn on "Connect to android.clients.google.com" in Google Home\'s Permissions.',
    );
  });

  it('without it, names the domain that fails as a guess; any HTTP answer counts as reachable', async () => {
    expect(await blockedHost(async () => ({ status: 401 }), null)).toBeNull();
    expect(await blockedHost(async (url) => {
      if (url.includes('android.clients')) throw new TypeError(`fetch failed: ${url}`);
      return { status: 404 };
    }, null)).toEqual({ host: 'android.clients.google.com', sure: false });
    expect(blockedMessage({ host: 'android.clients.google.com', sure: false })).toBe(
      'Google Home doesn\'t have permission to connect to android.clients.google.com. Turn on "Connect to android.clients.google.com" in Google Home\'s Permissions, or check your internet connection.',
    );
  });

  it('reports a failed domain without waiting for a stalled one', async () => {
    const blocked = await blockedHost((url) => (url.includes('foyer') ? new Promise(() => {}) : Promise.reject(new TypeError('blocked'))), null);
    expect(blocked?.host).toBe('android.clients.google.com');
  });

  it('remembers the last check until everything is allowed; ignores an old bare-host cache', async () => {
    const storage = memory();
    await checkReach(storage, noRequest, permissions({ 'Internet/android.clients.google.com': 'denied' }));
    expect(lastBlocked(storage)).toEqual({ host: 'android.clients.google.com', sure: true });
    await checkReach(storage, noRequest, permissions({}));
    expect(lastBlocked(storage)).toBeNull();
    storage.setItem('googlehome.blocked.v1', 'android.clients.google.com');
    expect(lastBlocked(storage)).toBeNull();
  });

  it('a NotAllowedError takes the network-failure path and names its own domain', async () => {
    const storage = memory();
    const query = permissions({ 'Internet/googlehomefoyer-pa.clients6.google.com': 'denied' });
    expect(failureBlocked(notAllowed('https://android.clients.google.com/auth'), storage, noRequest, query))
      .toEqual({ host: 'android.clients.google.com', sure: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(lastBlocked(storage)).toEqual({ host: 'googlehomefoyer-pa.clients6.google.com', sure: true });
    expect(failureBlocked(notAllowed('https://elsewhere.example/'), storage, noRequest, query))
      .toEqual({ host: 'googlehomefoyer-pa.clients6.google.com', sure: true });
    expect(failureBlocked(new TypeError('fetch failed'), storage, noRequest, query))
      .toEqual({ host: 'googlehomefoyer-pa.clients6.google.com', sure: true });
    expect(failureBlocked(new Error('HTTP 401'), storage, noRequest, query)).toBeNull();
  });
});
