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

const HOST = 'api.ticktick.com';
const KEY = 'ticktick.blocked.v1';
const SIGNED_IN = {"secure": {"ticktick_access_token": "token"}, "local": {}};
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
  assert.match(r.out.error.message, new RegExp("^TickTick doesn't have permission to connect to " + HOST.replace(/\./g, '\\.') + '\\.'));
});

test('without a remembered domain the error is unchanged and a check starts in the background', async () => {
  const { handlers, local } = load(SIGNED_IN, offline);
  const r = responder();
  await handlers.action(ACTION, r);
  assert.strictEqual(r.out.error.message, 'Could not reach TickTick.');
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
  assert.strictEqual(r.out.error.message, `TickTick doesn't have permission to connect to ${HOST}. Turn on "Connect to ${HOST}" in TickTick's Permissions.`);
});

test('a remembered host from an older version is ignored', async () => {
  const { handlers } = load({ secure: SIGNED_IN.secure, local: Object.assign({ [KEY]: HOST }, SIGNED_IN.local) }, (url) => (url === 'https://' + HOST + '/' ? new Promise(() => {}) : offline()));
  const r = responder();
  await handlers.action(ACTION, r);
  assert.strictEqual(r.out.error.message, 'Could not reach TickTick.');
});
