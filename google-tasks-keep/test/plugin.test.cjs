const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
const rejected = () => Promise.reject(new TypeError('fetch failed'));

function load(stored, fetch) {
  const secure = new Map(Object.entries(stored || {}));
  const local = new Map();
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

const reach = (handlers) => new Promise((resolve) => handlers.config({ type: 'reach' }, resolve));

test('the first host that fails is named and remembered until all answer', async () => {
  let fetch = (url) => (url.includes('tasks-pa') ? rejected() : Promise.resolve({ status: 404 }));
  const { context, handlers } = load({}, (url) => fetch(url));
  assert.strictEqual((await reach(handlers)).blocked, 'tasks-pa.clients6.google.com');
  assert.strictEqual(context.lastBlocked(), 'tasks-pa.clients6.google.com');
  fetch = async () => ({ status: 401 });
  assert.strictEqual((await reach(handlers)).blocked, null);
  assert.strictEqual(context.lastBlocked(), null);
});

test('a stalled probe does not hold up a failed one', async () => {
  const { context } = load({}, (url) => (url.includes('googleapis') ? new Promise(() => {}) : rejected()));
  assert.strictEqual(await context.blockedHost(), 'tasks-pa.clients6.google.com');
});

test('an unreachable Google names the blocked host without waiting for a probe', async () => {
  const { handlers, local } = load({ google_master_token: 'aas_et/x', google_android_id: '0123456789abcdef' }, rejected);
  local.set('google-tasks-keep.blocked.v1', 'android.clients.google.com');
  const out = {};
  await handlers.action({ action: 'create_reminder', args: { title: 'Milk' } }, {
    ok: (v) => (out.ok = v),
    error: (code, message) => (out.error = { code, message }),
  });
  assert.strictEqual(out.error.code, 'PLUGIN_UNAVAILABLE');
  assert.strictEqual(out.error.message, 'Google Tasks & Keep doesn\'t have permission to connect to android.clients.google.com. Turn on "Connect to android.clients.google.com" in Google Tasks & Keep\'s Permissions, or check your internet connection.');
});
