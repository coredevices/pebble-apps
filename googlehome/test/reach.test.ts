import { describe, expect, it } from 'vitest';
import { blockedHost, blockedMessage, checkReach, lastBlocked } from '../src/reach';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

describe('reach', () => {
  it('names the domain that fails; any HTTP answer counts as reachable', async () => {
    expect(await blockedHost(async () => ({ status: 401 }))).toBeNull();
    expect(await blockedHost(async (url) => {
      if (url.includes('android.clients')) throw new TypeError(`fetch failed: ${url}`);
      return { status: 404 };
    })).toBe('android.clients.google.com');
    expect(blockedMessage('android.clients.google.com')).toBe(
      'Google Home doesn\'t have permission to connect to android.clients.google.com. Turn on "Connect to android.clients.google.com" in Google Home\'s Permissions, or check your internet connection.',
    );
  });

  it('reports a failed domain without waiting for a stalled one', async () => {
    const host = await blockedHost((url) => (url.includes('foyer') ? new Promise(() => {}) : Promise.reject(new TypeError('blocked'))));
    expect(host).toBe('android.clients.google.com');
  });

  it('remembers the last check until everything is reachable', async () => {
    const storage = memory();
    await checkReach(storage, () => Promise.reject(new TypeError('blocked')));
    expect(lastBlocked(storage)).toBe('googlehomefoyer-pa.clients6.google.com');
    await checkReach(storage, async () => ({ status: 200 }));
    expect(lastBlocked(storage)).toBeNull();
  });
});
