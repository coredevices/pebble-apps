const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');

function load(fetch, permissions) {
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
      permissions,
      registerSourceHandler: (h) => (handlers.source = h),
      registerConfigHandler: (h) => (handlers.config = h),
      refreshSources() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { context, handlers, local };
}

const reach = (handlers) => new Promise((resolve) => handlers.config({ type: 'reach' }, resolve));

const plain = (value) => JSON.parse(JSON.stringify(value));
const permissions = (states) => ({ query: async (key) => states[key] || 'granted' });
const noRequest = () => { throw new Error('no request expected'); };
const add = (handlers, symbol) => new Promise((resolve) => handlers.config({ type: 'add', symbol }, resolve));

test('with Pebble.permissions, a domain not granted is named for sure, without any request', async () => {
  const states = { 'Internet/query1.finance.yahoo.com': 'prompt' };
  const { context, handlers } = load(noRequest, permissions(states));
  context.REACH_HOSTS.unshift('granted.example');
  assert.deepStrictEqual(plain((await reach(handlers)).blocked), { host: 'query1.finance.yahoo.com', sure: true });
  assert.deepStrictEqual(plain(context.lastBlocked()), { host: 'query1.finance.yahoo.com', sure: true });
  states['Internet/query1.finance.yahoo.com'] = 'granted';
  assert.strictEqual((await reach(handlers)).blocked, null);
  assert.strictEqual(context.lastBlocked(), null);
});

test('without it, an unreachable host is named as a guess and remembered until it answers again', async () => {
  let fetch = () => Promise.reject(new TypeError('fetch failed'));
  const { context, handlers } = load((url) => fetch(url));
  assert.deepStrictEqual(plain((await reach(handlers)).blocked), { host: 'query1.finance.yahoo.com', sure: false });
  assert.deepStrictEqual(plain(context.lastBlocked()), { host: 'query1.finance.yahoo.com', sure: false });
  fetch = async () => ({ status: 404, ok: false });
  assert.strictEqual((await reach(handlers)).blocked, null);
  assert.strictEqual(context.lastBlocked(), null);
  context.localStorage.setItem('stocks.blocked.v1', 'query1.finance.yahoo.com');
  assert.strictEqual(context.lastBlocked(), null);
});

test('a stalled probe does not hold up a failed one', async () => {
  const { context } = load(() => Promise.reject(new TypeError('fetch failed')));
  context.REACH_HOSTS.push('stalled.example');
  context.fetch = (url) => (url.includes('stalled') ? new Promise(() => {}) : Promise.reject(new TypeError('fetch failed')));
  assert.strictEqual((await context.blockedHost()).host, 'query1.finance.yahoo.com');
});

test('adding a ticker while blocked explains the permission', async () => {
  const { handlers, local } = load(() => Promise.reject(new TypeError('fetch failed')));
  local.set('stocks.blocked.v1', JSON.stringify({ host: 'query1.finance.yahoo.com', sure: false }));
  const reply = await add(handlers, 'goog');
  assert.strictEqual(reply.error, 'Stocks doesn\'t have permission to connect to query1.finance.yahoo.com. Turn on "Connect to query1.finance.yahoo.com" in Stocks\'s Permissions, or check your internet connection.');
});

test('adding a ticker the user has not allowed names the domain for sure, even with nothing cached', async () => {
  const { handlers } = load((url) => Promise.reject(Object.assign(new Error('fetch not allowed: ' + url), { name: 'NotAllowedError' })),
    permissions({ 'Internet/query1.finance.yahoo.com': 'denied' }));
  const reply = await add(handlers, 'goog');
  assert.strictEqual(reply.error, 'Stocks doesn\'t have permission to connect to query1.finance.yahoo.com. Turn on "Connect to query1.finance.yahoo.com" in Stocks\'s Permissions.');
});
