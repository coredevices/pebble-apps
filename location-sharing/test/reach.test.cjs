const test = require('node:test');
const assert = require('node:assert/strict');
const { blockedHost, blockedMessage, checkReach, lastBlocked } = require('../src/reach');
const { FetchHttpProvider } = require('../src/runtime/fetch-http-provider');
const { exchangeOAuthToken } = require('../src/google/client');

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const permissions = (states) => ({ query: async (key) => states[key] ?? 'granted' });

test('with Pebble.permissions, a domain not granted is named for sure, without any request', async () => {
  const request = () => { throw new Error('no request expected'); };
  assert.equal(await blockedHost(request, permissions({})), null);
  assert.deepEqual(await blockedHost(request, permissions({ 'Internet/google.com': 'denied' })), { host: 'google.com', sure: true });
  assert.deepEqual(await blockedHost(request, permissions({ 'Internet/google.com': 'prompt' })), { host: 'google.com', sure: true });
  assert.equal(blockedMessage({ host: 'google.com', sure: true }), 'Location Sharing doesn\'t have permission to connect to google.com. Turn on "Connect to google.com" in Location Sharing\'s Permissions.');
});

test('without it, an unreachable domain is named as a guess; any HTTP answer counts as reachable', async () => {
  assert.equal(await blockedHost(async () => ({ status: 403 }), null), null);
  assert.deepEqual(await blockedHost(() => Promise.reject(new TypeError('fetch failed')), null), { host: 'google.com', sure: false });
  assert.match(blockedMessage({ host: 'google.com', sure: false }), /"Connect to google\.com".*or check your internet connection\.$/);
});

test('the first failure wins without waiting for a stalled probe', async () => {
  let calls = 0;
  const blocked = await blockedHost(() => (calls++ ? new Promise(() => {}) : Promise.reject(new TypeError('blocked'))), null);
  assert.equal(blocked.host, 'google.com');
});

test('the last check is remembered until a check finds everything allowed', async () => {
  const storage = memory();
  await checkReach(storage, null, permissions({ 'Internet/google.com': 'denied' }));
  assert.deepEqual(lastBlocked(storage), { host: 'google.com', sure: true });
  await checkReach(storage, null, permissions({}));
  assert.equal(lastBlocked(storage), null);
  storage.setItem('location-sharing.blocked.v1', 'google.com');
  assert.equal(lastBlocked(storage), null);
});

test('a fetch the user has not allowed fails with the network error the blocked-host hook answers', async () => {
  const notAllowed = async (url) => { const e = new Error('fetch not allowed: ' + url); e.name = 'NotAllowedError'; throw e; };
  const http = new FetchHttpProvider(notAllowed, { after: () => 1, cancel() {} });
  await assert.rejects(exchangeOAuthToken({ http }, 'token', '0123456789abcdef'), { code: 'GOOGLE_LOCATION_NETWORK_ERROR' });
});
