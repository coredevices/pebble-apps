const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');

function load(fetch) {
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

test('an unreachable host is named and remembered until it answers again', async () => {
  let fetch = () => Promise.reject(new TypeError('fetch failed'));
  const { context, handlers } = load((url) => fetch(url));
  assert.strictEqual((await reach(handlers)).blocked, 'query1.finance.yahoo.com');
  assert.strictEqual(context.lastBlocked(), 'query1.finance.yahoo.com');
  fetch = async () => ({ status: 404, ok: false });
  assert.strictEqual((await reach(handlers)).blocked, null);
  assert.strictEqual(context.lastBlocked(), null);
});

test('a stalled probe does not hold up a failed one', async () => {
  const { context } = load(() => Promise.reject(new TypeError('fetch failed')));
  context.PROBES.push(['stalled.example', 'https://stalled.example/']);
  context.fetch = (url) => (url.includes('stalled') ? new Promise(() => {}) : Promise.reject(new TypeError('fetch failed')));
  assert.strictEqual(await context.blockedHost(), 'query1.finance.yahoo.com');
});

test('adding a ticker while blocked explains the permission', async () => {
  const { handlers, local } = load(() => Promise.reject(new TypeError('fetch failed')));
  local.set('stocks.blocked.v1', 'query1.finance.yahoo.com');
  const reply = await new Promise((resolve) => handlers.config({ type: 'add', symbol: 'goog' }, resolve));
  assert.strictEqual(reply.error, 'Stocks doesn\'t have permission to connect to query1.finance.yahoo.com. Turn on "Connect to query1.finance.yahoo.com" in Stocks\'s Permissions, or check your internet connection.');
});
