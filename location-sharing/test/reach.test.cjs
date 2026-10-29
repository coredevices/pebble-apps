const test = require('node:test');
const assert = require('node:assert/strict');
const { blockedHost, blockedMessage, checkReach, lastBlocked } = require('../src/reach');

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test('an unreachable domain is named; any HTTP answer counts as reachable', async () => {
  assert.equal(await blockedHost(async () => ({ status: 403 })), null);
  assert.equal(await blockedHost(() => Promise.reject(new TypeError('fetch failed'))), 'google.com');
  assert.match(blockedMessage('google.com'), /permission to connect to google\.com.*"Connect to google\.com".*internet connection/);
});

test('the first failure wins without waiting for a stalled probe', async () => {
  let calls = 0;
  const host = await blockedHost(() => (calls++ ? new Promise(() => {}) : Promise.reject(new TypeError('blocked'))));
  assert.equal(host, 'google.com');
});

test('the last check is remembered until a check finds everything reachable', async () => {
  const storage = memory();
  await checkReach(storage, () => Promise.reject(new TypeError('blocked')));
  assert.equal(lastBlocked(storage), 'google.com');
  await checkReach(storage, async () => ({ status: 200 }));
  assert.equal(lastBlocked(storage), null);
});
