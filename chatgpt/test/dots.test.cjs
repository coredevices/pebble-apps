const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = readFileSync(path.join(__dirname, '..', 'pbw', 'plugin.js'), 'utf8');
const ACCOUNT = 'acct-1';
const USER = 'user-1';
const ROOM = 'room-1';
const DOT = 'aeon-1';

function token({ account = ACCOUNT, user = USER, exp, email = 'eric@example.com' }) {
  const claims = {
    exp,
    'https://api.openai.com/auth': { chatgpt_account_id: account, chatgpt_user_id: user },
    'https://api.openai.com/profile': { email },
  };
  return 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
}

function json(status, body) {
  return { status, json: async () => body };
}

function fixture({ now = 1_000_000_000_000, expiresIn = 3600_000, routes = {}, storage = new Map() } = {}) {
  const calls = [];
  const access = token({ exp: (now + expiresIn) / 1000 });
  const backend = {
    'GET /tbo/primary': () => json(200, { selection: { thread_id: 't-1', aeon_id: DOT, messaging_room_id: ROOM, available: true } }),
    'GET /tbo/by-thread/t-1': () => json(200, { status: 'active', id: DOT, display_name: 'Sol', messaging_room_id: ROOM }),
    'GET /messaging/rooms/room-1': () => json(200, {
      type: 'DM', app_source: 'chatgpt:messaging', id: ROOM, aeon_id: DOT,
      members: [{ account_user_id: 'dot-member', aeon_id: DOT }, { account_user_id: USER, aeon_id: '' }],
    }),
    'POST /messaging/rooms/room-1/messages': (init) => json(200, { id: 'm-1', request_id: JSON.parse(init.body).request_id }),
    'GET session': () => json(200, { accessToken: access, sessionToken: 'session-2' }),
    ...routes,
  };
  const fetch = async (url, init = {}) => {
    const key = url === 'https://chatgpt.com/api/auth/session'
      ? 'GET session'
      : `${init.method} ${url.replace('https://chatgpt.com/backend-api', '')}`;
    calls.push({ key, init });
    const handler = backend[key];
    assert.ok(handler, 'unexpected request ' + key);
    return handler(init, calls);
  };
  let action, config, source;
  vm.runInNewContext(SOURCE, {
    fetch,
    atob,
    Date: { now: () => now },
    Uint8Array,
    btoa,
    WebSocket: class {},
    Math,
    JSON,
    Pebble: {
      secureStorage: {
        getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: async (k, v) => { storage.set(k, v); },
        removeItem: async (k) => { storage.delete(k); },
      },
      registerActionHandler: (fn) => (action = fn),
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: (fn) => (source = fn),
    },
  });
  const config_ = (message) => new Promise((resolve, reject) =>
    config(message, (r) => (r && r.error ? reject(new Error(r.error)) : resolve(r))));
  return {
    calls,
    storage,
    backend,
    access,
    connect: async (sessionToken = 'session-1') => (await config_({ type: 'dots_connect', session_token: sessionToken })).dots,
    config: config_,
    status: async () => (await config_({ type: 'status' })).dots,
    source: (request) => new Promise((resolve) => source(request, {
      data: (value) => resolve(value),
      error: (code, message) => resolve({ code, message }),
    })),
    action: (name, args, resolve) => action(
      { action: name, args },
      { ok: (value) => resolve({ ok: true, ...value }), error: (code, message) => resolve({ code, message }) },
    ),
    send: (args = { message: 'hello Dot' }) => new Promise((resolve) => action(
      { action: 'send_to_agent', args },
      { ok: (value) => resolve({ ok: true, ...value }), error: (code, message) => resolve({ code, message }) },
    )),
  };
}

test('connect verifies the primary Dot room and reports the account', async () => {
  const f = fixture();
  const state = await f.connect();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), { configured: true, email: 'eric@example.com', dotName: 'Sol' });
  assert.equal(f.calls[0].init.headers.Cookie, '__Secure-next-auth.session-token=session-1');
  const auth = f.calls[1].init.headers;
  assert.equal(auth.Authorization, 'Bearer ' + f.access);
  assert.equal(auth['ChatGPT-Account-Id'], ACCOUNT);
  assert.equal(auth['X-OpenAI-Expected-Account-Id'], ACCOUNT);
  assert.deepEqual(f.calls.map((c) => c.key),
    ['GET session', 'GET /tbo/primary', 'GET /tbo/by-thread/t-1', 'GET /messaging/rooms/room-1']);
  assert.equal(JSON.parse([...f.storage.values()][0]).sessionToken, 'session-2');
  assert.equal((await f.status()).configured, true);
});

test('send posts to the verified room with a matching request id', async () => {
  const f = fixture();
  await f.connect();
  const result = await f.send();
  assert.equal(result.ok, true);
  assert.equal(result.text, 'Message sent to Sol.');
  const post = f.calls.at(-1);
  const body = JSON.parse(post.init.body);
  assert.equal(body.content.text, 'hello Dot');
  assert.match(body.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(body.idempotency_token, body.request_id);
});

test('an unconfirmed send is reported as uncertain', async () => {
  const f = fixture({ routes: { 'POST /messaging/rooms/room-1/messages': () => json(200, { id: 'm-1', request_id: 'other' }) } });
  await f.connect();
  const result = await f.send();
  assert.equal(result.code, 'PLUGIN_UNAVAILABLE');
  assert.match(result.message, /did not confirm/);
});

test('a near-expiry access token renews with the rotated session token before calling ChatGPT', async () => {
  const f = fixture({ expiresIn: 60_000 * 2 });
  await f.connect();
  assert.deepEqual(f.calls.slice(0, 2).map((c) => c.init.headers.Cookie), [
    '__Secure-next-auth.session-token=session-1',
    '__Secure-next-auth.session-token=session-2',
  ]);
  assert.equal(f.calls[2].key, 'GET /tbo/primary');
});

test('a 401 renews once and retries the same request id', async () => {
  let posts = 0;
  const f = fixture({
    routes: {
      'POST /messaging/rooms/room-1/messages': (init) => (++posts === 1
        ? json(401, {})
        : json(200, { id: 'm-1', request_id: JSON.parse(init.body).request_id })),
    },
  });
  await f.connect();
  assert.equal((await f.send()).ok, true);
  const sent = f.calls.filter((c) => c.key.startsWith('POST')).map((c) => JSON.parse(c.init.body).request_id);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.ok(f.calls.some((c) => c.key === 'GET session'));
});

test('renewal that changes account identity requires signing in again', async () => {
  let sessions = 0;
  const f = fixture({ expiresIn: 60_000 * 2 });
  const first = f.backend['GET session'];
  f.backend['GET session'] = (init) => (++sessions === 1
    ? first(init)
    : json(200, { accessToken: token({ user: 'someone-else', exp: 2e9 }), sessionToken: 's' }));
  await assert.rejects(() => f.connect(), /sign-in expired/);
  assert.equal(f.storage.size, 0);
});

test('a room whose human member is not the signed-in user is refused', async () => {
  const f = fixture({
    routes: {
      'GET /messaging/rooms/room-1': () => json(200, {
        type: 'DM', app_source: 'chatgpt:messaging', id: ROOM, aeon_id: DOT,
        members: [{ account_user_id: 'dot-member', aeon_id: DOT }, { account_user_id: 'other', aeon_id: '' }],
      }),
    },
  });
  await assert.rejects(() => f.connect(), /did not match/);
});

test('Dots unavailable in the region is explained', async () => {
  const f = fixture({ routes: { 'GET /tbo/primary': () => json(404, { detail: 'Not Found' }) } });
  await assert.rejects(() => f.connect(), /not available in your region/);
});

test('invalid sessions, actions and messages are rejected without network calls', async () => {
  const f = fixture();
  await assert.rejects(() => f.connect('bad;cookie'), /invalid session/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.send()).code, 'INVALID_ARGS');
  assert.equal((await f.send({ message: 'hi', chat_id: 'dot' })).code, 'AUTH_REQUIRED');
  await f.connect();
  const before = f.calls.length;
  assert.equal((await f.send({ message: '  ' })).code, 'INVALID_ARGS');
  assert.equal((await f.send({ message: 'x'.repeat(16001) })).code, 'INVALID_ARGS');
  assert.equal(f.calls.length, before);
});

test('disconnect removes the saved sign-in', async () => {
  const f = fixture();
  await f.connect();
  assert.equal((await f.config({ type: 'dots_disconnect' })).dots.configured, false);
  assert.equal(f.storage.size, 0);
});

const room = (members) => () => json(200, { type: 'DM', app_source: 'chatgpt:messaging', id: ROOM, aeon_id: DOT, members });

test('a Dot profile pointing at a different root thread is refused', async () => {
  const f = fixture({
    routes: {
      'GET /tbo/by-thread/t-1': () => json(200, {
        status: 'active', id: DOT, display_name: 'Sol', messaging_room_id: ROOM, active_root_thread_id: 't-other',
      }),
    },
  });
  await assert.rejects(() => f.connect(), /did not match/);
});

test('a room with an extra member is refused', async () => {
  const f = fixture({
    routes: {
      'GET /messaging/rooms/room-1': room([
        { account_user_id: 'dot-member', aeon_id: DOT },
        { account_user_id: 'dot-member-2', aeon_id: DOT },
        { account_user_id: USER, aeon_id: '' },
      ]),
    },
  });
  await assert.rejects(() => f.connect(), /did not match/);
});

test('a failed reconnect leaves the saved connection untouched', async () => {
  const f = fixture();
  await f.connect();
  const saved = [...f.storage.values()][0];
  f.backend['GET /tbo/primary'] = () => json(500, {});
  await assert.rejects(() => f.connect('session-x'), /HTTP 500/);
  assert.equal([...f.storage.values()][0], saved);
  assert.equal((await f.status()).dotName, 'Sol');
});

test('a fresh plugin session sends with the saved connection', async () => {
  const first = fixture();
  await first.connect();
  const second = fixture({ storage: first.storage });
  assert.equal((await second.send()).text, 'Message sent to Sol.');
  assert.deepEqual(second.calls.map((c) => c.key), ['POST /messaging/rooms/room-1/messages']);
});

test('agent/configured turns true once the Dot is connected, and names it', async () => {
  const f = fixture();
  const before = await f.source({ category: 'agent', item: 'configured' });
  assert.equal(before.instances[0].properties.configured.boolean.value, false);
  await f.connect();
  const after = await f.source({ category: 'agent', item: 'configured' });
  assert.equal(after.instances.length, 1);
  assert.equal(after.instances[0].properties.configured.boolean.value, true);
  assert.equal(after.instances[0].properties.name.shortText.text, 'Sol');
  assert.equal((await f.source({ category: 'messaging', item: 'dot' })).code, 'INVALID_ARGS');
});

test('agent/chats lists the Dot, and its id, "dot" or its name send to it', async () => {
  const f = fixture();
  assert.equal((await f.source({ category: 'agent', item: 'chats' })).instances.length, 0);
  await f.connect();
  const chats = await f.source({ category: 'agent', item: 'chats' });
  assert.deepEqual(Array.from(chats.instances, (i) => [i.instanceId, i.properties.name.shortText.text]), [['dot', 'Sol']]);
  for (const chat_id of [chats.instances[0].instanceId, 'DOT', 'sol', null]) {
    assert.equal((await f.send({ message: 'hi', chat_id })).text, 'Message sent to Sol.');
  }
});

test('unknown and removed actions are rejected before touching the network', async () => {
  const f = fixture();
  await f.connect();
  const before = f.calls.length;
  for (const name of ['send_to_dot', 'send_to_codex', 'list_codex_chats']) {
    const result = await new Promise((resolve) => f.action(name, { message: 'hi' }, resolve));
    assert.equal(result.code, 'INVALID_ARGS');
  }
  assert.equal((await f.send({ message: 'hi', chat_id: 5 })).code, 'INVALID_ARGS');
  assert.equal(f.calls.length, before);
});
