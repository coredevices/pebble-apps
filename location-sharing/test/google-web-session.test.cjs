const test = require('node:test');
const assert = require('node:assert/strict');
const bytes = require('../../chat/imessage/src/runtime/bytes');
const { GoogleMapsClient } = require('../src/google/client');

test('web-session cookies go straight to Maps with a Cookie header', async () => {
  const values = new Map();
  const requests = [];
  const client = new GoogleMapsClient({
    effects: {
      storage: { get: (k) => values.get(k), set: (k, v) => values.set(k, v), delete: (k) => values.delete(k) },
      http: {
        request: async (request) => {
          requests.push(request);
          return { status: 200, headers: [], body: bytes.utf8ToBytes(request.method === 'GET' ? '"SNlM0e":"x" kEI="k"' : '') };
        },
      },
    },
  });
  const status = client.setCredentials({ cookies: { SID: 'a', HSID: 'b', bad: 'x; y' } });
  assert.equal(status.ready, true);
  await client.refresh().catch(() => {});
  assert.deepEqual(requests.map((r) => r.method), ['GET', 'POST']);
  for (const request of requests) {
    assert.match(request.url, /^https:\/\/www\.google\.com\/maps/);
    assert.deepEqual(request.headers.find(([name]) => name === 'Cookie'), ['Cookie', 'SID=a; HSID=b']);
  }
  client.clear();
  assert.equal(client.status().configured, false);
});
