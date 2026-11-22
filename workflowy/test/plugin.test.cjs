const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
const TARGETS = [
  { key: 'inbox', type: 'system', name: 'Inbox' },
  { key: 'today', type: 'system', name: 'Today' },
  { key: 'calendar', type: 'system', name: 'Calendar' },
  { key: 'groceries', type: 'shortcut', name: 'Groceries' },
];
const ITEM = '5b401959-4740-4e1a-905a-62a961daa8c9';

// A fake Workflowy: records requests, answers /targets and node creation.
function workflowy(overrides = {}) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const call = { url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, auth: options.headers && options.headers.Authorization };
    calls.push(call);
    const reply = (overrides.reply && overrides.reply(call)) || (url.endsWith('/targets') ? [200, { targets: TARGETS }] : [200, { item_id: ITEM }]);
    return { status: reply[0], text: async () => JSON.stringify(reply[1]) };
  };
  return { calls, fetch };
}

function load(fetch, stored = { secure: { workflowy_api_key: 'test-key' } }) {
  const secure = new Map(Object.entries(stored.secure || {}));
  const local = new Map(Object.entries(stored.local || {}));
  const handlers = {};
  const context = {
    console: { log() {}, error() {} },
    Intl, Date,
    localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k) },
    fetch,
    Pebble: {
      secureStorage: { getItem: async (k) => (secure.has(k) ? secure.get(k) : null), setItem: async (k, v) => secure.set(k, v), removeItem: async (k) => secure.delete(k) },
      registerSourceHandler: (h) => (handlers.source = h),
      registerActionHandler: (h) => (handlers.action = h),
      registerConfigHandler: (h) => (handlers.config = h),
      refreshSources() {},
    },
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context);
  return { handlers, secure, local };
}

async function act(handlers, action, args) {
  const out = {};
  await handlers.action({ action, args }, { ok: (v) => (out.ok = v), error: (code, message) => (out.error = { code, message }) });
  return out;
}

const posts = (calls) => calls.filter((c) => c.method === 'POST').map((c) => c.body);

test('a note goes to the top of Inbox, first line as the bullet and the rest as its note', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch);
  const out = await act(handlers, 'create_note', { text: 'Idea\nmore detail\nand more' });
  assert.deepStrictEqual(posts(api.calls), [{ parent_id: 'inbox', name: 'Idea', layoutMode: 'bullets', position: 'top', note: 'more detail\nand more' }]);
  assert.strictEqual(api.calls[0].auth, 'Bearer test-key');
  assert.strictEqual(out.ok.url, 'https://workflowy.com/#/62a961daa8c9');
});

test('a dated reminder goes on its day in the given time zone, with the wall time on it', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch);
  // 01:30 UTC on the 28th is 18:30 on the 27th in Los Angeles.
  const out = await act(handlers, 'create_reminder', { title: 'Call mom', due_iso: '2026-08-28T01:30:00Z', timezone: 'America/Los_Angeles' });
  assert.deepStrictEqual(posts(api.calls), [{ parent_id: '2026-08-27', name: 'Call mom [2026-08-27 18:30]', layoutMode: 'todo', position: 'top' }]);
  assert.match(out.ok.text, /doesn't send alerts/);
});

test('a reminder with a list goes in that list; an undated one with no list goes to the default', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch, { secure: { workflowy_api_key: 'k' }, local: { 'workflowy.config.v1': JSON.stringify({ reminderTarget: 'today' }) } });
  await act(handlers, 'create_reminder', { title: 'Milk', instanceId: 'groceries', due_iso: '2026-08-27T14:30:00-07:00', timezone: 'America/Los_Angeles' });
  await act(handlers, 'create_reminder', { title: 'Stretch' });
  assert.deepStrictEqual(posts(api.calls).map((b) => [b.parent_id, b.name]), [['groceries', 'Milk [2026-08-27 14:30]'], ['today', 'Stretch']]);
});

test('only listed targets are accepted as a list: not the calendar root, root, ids or URLs', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch);
  for (const instanceId of ['calendar', 'None', ITEM, 'https://workflowy.com/#/62a961daa8c9']) {
    const out = await act(handlers, 'create_reminder', { title: 'x', instanceId });
    assert.strictEqual(out.error.code, 'INVALID_ARGS', instanceId);
  }
  assert.deepStrictEqual(posts(api.calls), []);
});

test('reminders/list lists targets without the calendar root', async () => {
  const { handlers } = load(workflowy().fetch);
  let data;
  await handlers.source({ category: 'reminders', item: 'list' }, { data: (d) => (data = d), error() {} });
  assert.deepStrictEqual([...data.instances.map((i) => i.instanceId)], ['inbox', 'today', 'groceries']);
});

test('saving checks the key by listing targets and writes nothing to Workflowy', async () => {
  const api = workflowy();
  const { handlers, secure } = load(api.fetch, {});
  const result = await new Promise((resolve) => handlers.config({ type: 'save', apiKey: ' new-key ', noteTarget: 'groceries', reminderTarget: 'bogus' }, resolve));
  assert.deepStrictEqual([result.configured, result.noteTarget, result.reminderTarget], [true, 'groceries', 'inbox']);
  assert.strictEqual(secure.get('workflowy_api_key'), 'new-key');
  assert.deepStrictEqual(api.calls.map((c) => c.method), ['GET']);
});

test('a rejected key is not saved; a rejected request asks for a new key', async () => {
  const api = workflowy({ reply: () => [401, { code: 'invalid_credentials' }] });
  const { handlers, secure } = load(api.fetch, {});
  const result = await new Promise((resolve) => handlers.config({ type: 'save', apiKey: 'bad' }, resolve));
  assert.match(result.error, /rejected the API key/);
  assert.strictEqual(secure.has('workflowy_api_key'), false);
  const out = await act(load(api.fetch).handlers, 'create_note', { text: 'x' });
  assert.strictEqual(out.error.code, 'AUTH_REQUIRED');
});

test('a lost reply says the note may have been saved, without retrying', async () => {
  const api = workflowy({ reply: (c) => (c.method === 'POST' ? [502, {}] : null) });
  const { handlers } = load(api.fetch);
  const out = await act(handlers, 'create_note', { text: 'x' });
  assert.match(out.error.message, /may have saved this note/);
  assert.strictEqual(posts(api.calls).length, 1);
});

const stale = (list) => JSON.stringify({ at: 0, targets: list });

test('a deleted configured shortcut is refused before anything is written', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch, { secure: { workflowy_api_key: 'k' }, local: { 'workflowy.config.v1': JSON.stringify({ noteTarget: 'gone', reminderTarget: 'gone' }) } });
  for (const [action, args] of [['create_note', { text: 'x' }], ['create_reminder', { title: 'x' }]]) {
    const out = await act(handlers, action, args);
    assert.match(out.error.message, /"gone" is no longer in Workflowy/);
  }
  assert.deepStrictEqual(posts(api.calls), []);
});

test('when Workflowy cannot list places, a cached shortcut is refused but Inbox still works', async () => {
  const api = workflowy({ reply: (c) => (c.url.endsWith('/targets') ? [503, {}] : null) });
  const cached = { 'workflowy.targets.v1': stale([{ key: 'inbox', name: 'Inbox', type: 'system' }, { key: 'old', name: 'Old', type: 'shortcut' }]) };
  const { handlers } = load(api.fetch, { secure: { workflowy_api_key: 'k' }, local: cached });
  const refused = await act(handlers, 'create_reminder', { title: 'x', instanceId: 'old' });
  assert.match(refused.error.message, /Nothing was saved/);
  const ok = await act(handlers, 'create_reminder', { title: 'y', instanceId: 'inbox' });
  assert.ok(ok.ok);
  assert.deepStrictEqual(posts(api.calls).map((b) => b.parent_id), ['inbox']);
});

test('a note is acknowledged without a second lookup after it is written', async () => {
  let posted = false;
  const api = workflowy({ reply: (c) => { if (c.method === 'POST') posted = true; return null; } });
  const fetch = (url, o) => (posted && url.endsWith('/targets') ? new Promise(() => {}) : api.fetch(url, o));
  const out = await act(load(fetch).handlers, 'create_note', { text: 'x' });
  assert.ok(out.ok);
});

test('impossible UTC offsets are refused; times across a DST change land on the right wall time', async () => {
  const api = workflowy();
  const { handlers } = load(api.fetch);
  const bad = await act(handlers, 'create_reminder', { title: 'x', due_iso: '2026-08-27T14:30:00+99:99' });
  assert.strictEqual(bad.error.code, 'INVALID_ARGS');
  // US clocks fall back at 06:00Z on 2026-11-01: 05:30Z is 01:30 EDT, 06:30Z is 01:30 EST.
  await act(handlers, 'create_reminder', { title: 'a', due_iso: '2026-11-01T05:30:00Z', timezone: 'America/New_York' });
  await act(handlers, 'create_reminder', { title: 'b', due_iso: '2026-11-01T06:30:00Z', timezone: 'America/New_York' });
  await act(handlers, 'create_reminder', { title: 'c', due_iso: '2026-03-08T07:30:00Z', timezone: 'America/New_York' });
  assert.deepStrictEqual(posts(api.calls).map((b) => b.name), ['a [2026-11-01 01:30]', 'b [2026-11-01 01:30]', 'c [2026-03-08 03:30]']);
});

test('404, 429 and a dropped connection map to clear errors', async () => {
  const cases = [[404, 'INVALID_ARGS', /no longer exists/], [429, 'RATE_LIMITED', /too quickly/], [0, 'UNKNOWN', /may have saved this note/]];
  for (const [status, code, message] of cases) {
    const api = workflowy({ reply: (c) => (c.method === 'POST' ? [status, {}] : null) });
    const fetch = status ? api.fetch : (url, o) => (o && o.method === 'POST' ? Promise.reject(new TypeError('fetch failed')) : api.fetch(url, o));
    const out = await act(load(fetch).handlers, 'create_note', { text: 'x' });
    assert.strictEqual(out.error.code, code);
    assert.match(out.error.message, message);
  }
});

test('opening settings asks Workflowy for places even with a fresh cache', async () => {
  const api = workflowy();
  const fresh = { 'workflowy.targets.v1': JSON.stringify({ at: Date.now(), targets: [{ key: 'inbox', name: 'Inbox', type: 'system' }] }) };
  const { handlers } = load(api.fetch, { secure: { workflowy_api_key: 'k' }, local: fresh });
  const result = await new Promise((resolve) => handlers.config({ type: 'status' }, resolve));
  assert.deepStrictEqual([...result.targets.map((t) => t.key)], ['inbox', 'today', 'groceries']);
});
