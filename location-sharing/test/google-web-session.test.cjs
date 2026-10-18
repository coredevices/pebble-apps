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

test('an EmbeddedSetup oauth_token becomes a MergeSession link for the web sign-in', async () => {
  const values = new Map();
  const requests = [];
  const reply = (status, text) => ({ status, headers: [], body: bytes.utf8ToBytes(text) });
  const client = new GoogleMapsClient({
    effects: {
      storage: { get: (k) => values.get(k), set: (k, v) => values.set(k, v), delete: (k) => values.delete(k) },
      random: { bytes: (n) => new Uint8Array(n).fill(7) },
      http: {
        request: async (request) => {
          requests.push(request);
          if (request.url === 'https://android.clients.google.com/auth') {
            const sent = Buffer.from(request.body || []).toString();
            return reply(200, sent.includes('service=ac2dm') ? 'Token=aas_et/master\nEmail=eric@example.com' : 'Auth=ya29.web');
          }
          if (request.url.startsWith('https://accounts.google.com/OAuthLogin')) return reply(200, 'uber/123');
          return reply(404, '');
        },
      },
    },
  });
  client.setCredentials({ oauthToken: 'oauth2_4/abc' });
  const url = new URL(await client.webLoginUrl());
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/MergeSession');
  assert.equal(url.searchParams.get('uberauth'), 'uber/123');
  assert.equal(url.searchParams.get('continue'), 'https://www.google.com/');
  const oauthLogin = requests.find((r) => r.url.startsWith('https://accounts.google.com/OAuthLogin'));
  assert.deepEqual(oauthLogin.headers.find(([name]) => name === 'Authorization'), ['Authorization', 'Bearer ya29.web']);
  assert.equal(client.status().email, 'eric@example.com');
  assert.ok(!requests.some((r) => r.url.startsWith('https://accounts.google.com/MergeSession')));
});
