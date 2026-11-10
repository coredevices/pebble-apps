const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');

function load(stored, fetch) {
  const secure = new Map(Object.entries(stored.secure || {}));
  const local = new Map(Object.entries(stored.local || {}));
  const handlers = {};
  const context = {
    console: { log() {}, error() {} },
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k),
    },
    fetch,
    Pebble: {
      secureStorage: {
        getItem: async (k) => (secure.has(k) ? secure.get(k) : null),
        setItem: async (k, v) => secure.set(k, v),
        removeItem: async (k) => secure.delete(k),
      },
      registerSourceHandler: (h) => (handlers.source = h),
      registerActionHandler: (h) => (handlers.action = h),
      registerConfigHandler: (h) => (handlers.config = h),
      refreshSources() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, handlers, local };
}

function responder() {
  const out = {};
  return {
    out,
    ok: (v) => (out.ok = v),
    data: (v) => (out.data = v),
    error: (code, message) => (out.error = { code, message }),
  };
}

const HOST = 'api.todoist.com';
const KEY = 'todoist.blocked.v1';
const SIGNED_IN = {"secure": {"todoist_access_token": "token"}, "local": {}};
const ACTION = { action: 'create_reminder', args: { title: 'x' } };
const offline = () => Promise.reject(new TypeError('fetch failed'));
const reach = (handlers) => new Promise((resolve) => handlers.config({ type: 'reach' }, resolve));

test('reach names a domain that cannot be reached and remembers it until it answers', async () => {
  let reachable = false;
  const { handlers, local } = load({}, async () => {
    if (!reachable) throw new TypeError('fetch failed');
    return { status: 401 };
  });
  assert.deepEqual((await reach(handlers)).blocked, { host: HOST, sure: false });
  assert.deepStrictEqual(JSON.parse(local.get(KEY)), { host: HOST, sure: false });
  reachable = true;
  assert.strictEqual((await reach(handlers)).blocked, null);
  assert.strictEqual(local.has(KEY), false);
});

test('the first failing domain is reported without waiting for a stalled one', async () => {
  const { context, handlers } = load({}, (url) => (url.includes('stalled') ? new Promise(() => {}) : offline()));
  context.PROBES = [['stalled.example', 'https://stalled.example/'], ['blocked.example', 'https://blocked.example/']];
  assert.strictEqual((await reach(handlers)).blocked.host, 'blocked.example');
});

test('an unreachable request names the remembered domain without waiting for a new check', async () => {
  const stored = { secure: SIGNED_IN.secure, local: Object.assign({ [KEY]: JSON.stringify({ host: HOST, sure: false }) }, SIGNED_IN.local) };
  const { handlers } = load(stored, (url) => (url === 'https://' + HOST + '/' ? new Promise(() => {}) : offline()));
  const r = responder();
  await handlers.action(ACTION, r);
  assert.match(r.out.error.message, new RegExp("^Todoist doesn't have permission to connect to " + HOST.replace(/\./g, '\\.') + '\\.'));
});

test('without a remembered domain the error is unchanged and a check starts in the background', async () => {
  const { handlers, local } = load(SIGNED_IN, offline);
  const r = responder();
  await handlers.action(ACTION, r);
  assert.strictEqual(r.out.error.message, 'Could not reach Todoist.');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(JSON.parse(local.get(KEY)), { host: HOST, sure: false });
});

test('with Pebble.permissions, reach names the first domain not granted for sure, without any request', async () => {
  const { context, handlers, local } = load({}, () => { throw new Error('no request expected'); });
  const states = {};
  context.Pebble.permissions = { query: async (key) => states[key] || 'granted' };
  context.PROBES = [['a.example', 'https://a.example/'], ['b.example', 'https://b.example/']];
  assert.strictEqual((await reach(handlers)).blocked, null);
  states['Internet/b.example'] = 'denied';
  assert.deepEqual((await reach(handlers)).blocked, { host: 'b.example', sure: true });
  states['Internet/a.example'] = 'prompt';
  assert.deepEqual((await reach(handlers)).blocked, { host: 'a.example', sure: true });
  assert.deepStrictEqual(JSON.parse(local.get(KEY)), { host: 'a.example', sure: true });
});

test('a NotAllowedError names the domain for sure without waiting for a check', async () => {
  const notAllowed = (url) => Promise.reject(Object.assign(new Error('fetch not allowed: ' + url), { name: 'NotAllowedError' }));
  const { handlers } = load(SIGNED_IN, notAllowed);
  const r = responder();
  await handlers.action(ACTION, r);
  assert.strictEqual(r.out.error.message, `Todoist doesn't have permission to connect to ${HOST}. Turn on "Connect to ${HOST}" in Todoist's Permissions.`);
});

test('a remembered host from an older version is ignored', async () => {
  const { handlers } = load({ secure: SIGNED_IN.secure, local: Object.assign({ [KEY]: HOST }, SIGNED_IN.local) }, (url) => (url === 'https://' + HOST + '/' ? new Promise(() => {}) : offline()));
  const r = responder();
  await handlers.action(ACTION, r);
  assert.strictEqual(r.out.error.message, 'Could not reach Todoist.');
});

test('a refresh the broker reports as REFRESH_REVOKED signs out instead of failing every request', async () => {
  const expired = { secure: { todoist_access_token: 'old', todoist_broker_refresh: 'wrapper' }, local: { todoist_expires_at: '1' } };
  const { context, handlers } = load(expired, async () => { throw new Error('no request expected'); });
  context.Pebble.oauth = { refresh: async () => { throw Object.assign(new Error('Sign in again'), { code: 'REFRESH_REVOKED' }); } };
  const r = responder();
  await handlers.action(ACTION, r);
  assert.equal(r.out.error.code, 'AUTH_REQUIRED');
  assert.equal(await context.Pebble.secureStorage.getItem('todoist_access_token'), null);
  assert.equal(await context.Pebble.secureStorage.getItem('todoist_broker_refresh'), null);
});

test('a transient refresh failure keeps the tokens', async () => {
  const expired = { secure: { todoist_access_token: 'old', todoist_broker_refresh: 'wrapper' }, local: { todoist_expires_at: '1' } };
  const { context, handlers } = load(expired, async () => { throw new Error('no request expected'); });
  context.Pebble.oauth = { refresh: async () => { throw Object.assign(new Error('refresh_failed'), { code: 'REFRESH_FAILED' }); } };
  await assert.rejects(() => handlers.action(ACTION, responder()), /refresh_failed/);
  assert.equal(await context.Pebble.secureStorage.getItem('todoist_broker_refresh'), 'wrapper');
});

test('a refresh result never overwrites tokens another session saved meanwhile', async () => {
  const expired = { secure: { todoist_access_token: 'old', todoist_broker_refresh: 'wrapper' }, local: { todoist_expires_at: '1' } };
  const { context, handlers } = load(expired, async () => ({ status: 401, text: async () => '' }));
  const storage = context.Pebble.secureStorage;
  for (const outcome of ['ok', 'revoked']) {
    await storage.setItem('todoist_broker_refresh', 'wrapper');
    context.Pebble.oauth = { refresh: async () => {
      await storage.setItem('todoist_access_token', 'newer');
      await storage.setItem('todoist_broker_refresh', 'newer-wrapper');
      if (outcome === 'revoked') throw Object.assign(new Error('Sign in again'), { code: 'REFRESH_REVOKED' });
      return { access_token: 'stale', broker_refresh: 'stale-wrapper', expires_in: 3600 };
    } };
    await handlers.action(ACTION, responder());
    assert.equal(await storage.getItem('todoist_access_token'), 'newer', outcome);
    assert.equal(await storage.getItem('todoist_broker_refresh'), 'newer-wrapper', outcome);
  }
});
