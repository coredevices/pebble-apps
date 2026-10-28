const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');

function load(stored, replies) {
  const secure = new Map(Object.entries(stored || {}));
  const local = new Map();
  const handlers = {};
  const calls = [];
  const context = {
    console: { log() {}, error() {} },
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k),
    },
    fetch: async (url) => {
      const params = Object.fromEntries(new URL(url).searchParams);
      calls.push(params);
      const reply = replies[params.method];
      return { status: 200, text: async () => JSON.stringify({ rsp: typeof reply === 'function' ? reply(params) : reply }) };
    },
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
  return { context, handlers, calls, secure };
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

const SIGNED_IN = { rtm_api_key: 'key', rtm_shared_secret: 'secret', rtm_auth_token: 'token' };

test('md5 matches node crypto, including non-ASCII text', () => {
  const { context } = load({}, {});
  for (const text of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'Milch kaufen ☕ — für Café', 'x'.repeat(200)]) {
    assert.strictEqual(context.md5(text), crypto.createHash('md5').update(text, 'utf8').digest('hex'));
  }
});

test('requests are signed over the sorted parameters', () => {
  const { context } = load({}, {});
  const query = context.signedQuery({ yxz: 'foo', feg: 'bar', abc: 'baz' }, 'BANANAS');
  assert.ok(query.endsWith('&api_sig=' + crypto.createHash('md5').update('BANANASabcbazfegbaryxzfoo').digest('hex')));
});

test('lists exclude smart, archived and deleted lists', async () => {
  const { handlers } = load(SIGNED_IN, {
    'rtm.lists.getList': { stat: 'ok', lists: { list: [
      { id: '1', name: 'Inbox', deleted: '0', archived: '0', smart: '0' },
      { id: '2', name: 'This week', deleted: '0', archived: '0', smart: '1' },
      { id: '3', name: 'Old', deleted: '0', archived: '1', smart: '0' },
      { id: '4', name: 'Groceries', deleted: '0', archived: '0', smart: '0' },
    ] } },
  });
  const r = responder();
  await handlers.source({ category: 'reminders', item: 'list' }, r);
  assert.strictEqual(r.out.data.instances.map((i) => i.instanceId).join(), '1,4');
});

test('create_reminder adds the task unparsed to the list, then sets the due time in UTC', async () => {
  const { handlers, calls } = load(SIGNED_IN, {
    'rtm.timelines.create': { stat: 'ok', timeline: 'tl' },
    'rtm.tasks.add': { stat: 'ok', list: { id: '4', taskseries: [{ id: 's1', task: [{ id: 't1' }] }] } },
    'rtm.tasks.setDueDate': { stat: 'ok' },
  });
  const r = responder();
  await handlers.action({ action: 'create_reminder', args: {
    title: 'Buy milk #today', instanceId: '4', due_iso: '2026-10-28T14:30:00-07:00', timezone: 'America/Los_Angeles',
  } }, r);
  assert.strictEqual(r.out.ok.url, 'https://www.rememberthemilk.com/app/#list/4/t1');
  const add = calls.find((c) => c.method === 'rtm.tasks.add');
  assert.deepStrictEqual([add.name, add.parse, add.list_id, add.timeline, add.auth_token], ['Buy milk #today', '0', '4', 'tl', 'token']);
  const due = calls.find((c) => c.method === 'rtm.tasks.setDueDate');
  assert.deepStrictEqual([due.due, due.has_due_time, due.taskseries_id, due.task_id], ['2026-10-28T21:30:00Z', '1', 's1', 't1']);
});

test('create_reminder rejects a due time without an offset and maps an expired token', async () => {
  let { handlers, calls } = load(SIGNED_IN, {});
  let r = responder();
  await handlers.action({ action: 'create_reminder', args: { title: 'x', due_iso: '2026-10-28T14:30:00', timezone: 'UTC' } }, r);
  assert.strictEqual(r.out.error.code, 'INVALID_ARGS');
  r = responder();
  await handlers.action({ action: 'create_reminder', args: { title: 'x', due_iso: '2026-02-30T14:30:00Z', timezone: 'UTC' } }, r);
  assert.strictEqual(r.out.error.code, 'INVALID_ARGS');
  assert.strictEqual(calls.length, 0);

  ({ handlers } = load(SIGNED_IN, { 'rtm.timelines.create': { stat: 'fail', err: { code: '98', msg: 'Login failed / Invalid auth token' } } }));
  r = responder();
  await handlers.action({ action: 'create_reminder', args: { title: 'x' } }, r);
  assert.strictEqual(r.out.error.code, 'AUTH_REQUIRED');
});

test('sign-in stores the key, opens a signed auth link, and exchanges the frob for a token', async () => {
  let allowed = false;
  const { handlers, secure } = load({}, {
    'rtm.auth.getFrob': { stat: 'ok', frob: 'frob1' },
    'rtm.auth.getToken': (p) => (allowed && p.frob === 'frob1'
      ? { stat: 'ok', auth: { token: 'tok', user: { fullname: 'Eric' } } }
      : { stat: 'fail', err: { code: '101', msg: 'Invalid frob - did you authenticate?' } }),
  });
  const start = await new Promise((resolve) => handlers.config({ type: 'start', apiKey: 'key', secret: 'secret' }, resolve));
  const auth = new URL(start.authUrl);
  assert.deepStrictEqual([auth.searchParams.get('perms'), auth.searchParams.get('frob')], ['write', 'frob1']);
  assert.strictEqual(auth.searchParams.get('api_sig'), crypto.createHash('md5').update('secretapi_keykeyfrobfrob1permswrite').digest('hex'));

  const early = await new Promise((resolve) => handlers.config({ type: 'finish' }, resolve));
  assert.match(early.error, /not been allowed/);
  allowed = true;
  const done = await new Promise((resolve) => handlers.config({ type: 'finish' }, resolve));
  assert.deepStrictEqual([done.configured, done.user, secure.get('rtm_auth_token')], [true, 'Eric', 'tok']);
});

test('a task whose due time fails to set is still reported as created, so it is not retried', async () => {
  const { handlers } = load(SIGNED_IN, {
    'rtm.timelines.create': { stat: 'ok', timeline: 'tl' },
    'rtm.tasks.add': { stat: 'ok', list: { id: '4', taskseries: [{ id: 's1', task: [{ id: 't1' }] }] } },
    'rtm.tasks.setDueDate': { stat: 'fail', err: { code: '105', msg: 'Service currently unavailable' } },
  });
  const r = responder();
  await handlers.action({ action: 'create_reminder', args: { title: 'x', due_iso: '2026-10-28T14:30:00Z', timezone: 'UTC' } }, r);
  assert.match(r.out.ok.text, /could not set its due time/);
});

test('settings reopened mid sign-in still offer Done', async () => {
  const { handlers } = load({ rtm_api_key: 'key', rtm_shared_secret: 'secret' }, { 'rtm.auth.getFrob': { stat: 'ok', frob: 'f' } });
  await new Promise((resolve) => handlers.config({ type: 'start' }, resolve));
  const status = await new Promise((resolve) => handlers.config({ type: 'status' }, resolve));
  assert.strictEqual(status.pending, true);
});
