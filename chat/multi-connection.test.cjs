const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ChatController } = require('./src/controller');
const { chatId } = require('./src/chat-reference');
const { searchDirectory } = require('./src/directory');

function fixture() {
  const values = new Map([['chat.connection.v1', 'beeper-ios']]);
  const calls = [];
  const states = {
    'beeper-ios': { account: '@fixture:example.test', ready: true, connected: true, approved: [{ account: '@fixture:example.test', roomId: '!room', name: 'Alex', nickname: '', network: 'WhatsApp' }] },
    imessage: { account: 'apple-fixture', ready: true, connected: true, approved: [{ account: 'apple-fixture', roomId: 'tel:+15555550101', name: 'Alex', nickname: '', network: 'iMessage' }] },
  };
  const adapter = id => ({ request: async (method, args) => {
    calls.push({ id, method, args });
    if (method === 'status') return structuredClone(states[id]);
    if (method === 'send') return { status: id === 'imessage' ? 'accepted_by_imessage' : 'accepted_by_beeper', recipient_name: 'Alex' };
    if (method === 'logout' || method === 'imessage.disconnect') { states[id].account = ''; states[id].approved = []; return { session_removed: true }; }
    return { ok: true };
  } });
  const native = adapter('beeper-ios');
  const options = {
    storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    native: { request: (method, args) => method === 'capabilities' ? Promise.resolve({ beeper_connection: 'beeper-ios', imessage_available: true }) : native.request(method, args) },
    createIMessage: () => adapter('imessage'),
    fingerprint: value => createHash('sha256').update(value).digest('hex'), operationId: () => 'generated-id',
  };
  return { controller: new ChatController(options), options, values, calls, states, native };
}

test('migration retains the selected connection and enabling another keeps both after restart', async () => {
  const f = fixture();
  let info = await f.controller.request('connections');
  assert.deepEqual(info.connections.filter(item => item.enabled).map(item => item.id), ['beeper-ios']);
  await f.controller.request('connections.enable', { connection: 'imessage' });
  info = await new ChatController(f.options).request('status');
  assert.equal(info.approved.length, 2);
  assert.equal(new Set(info.approved.map(chat => chat.chat_id)).size, 2);
  assert.ok(!f.calls.some(call => call.method === 'logout' || call.method === 'session.release'));
});

test('ambiguous cross-network names require a choice and qualified references send only once', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  await assert.rejects(f.controller.request('send', { recipient: 'Alex', text: 'fixture' }), /Several allowed chats.*Beeper.*iMessage/);
  assert.equal(f.calls.filter(call => call.method === 'send').length, 0);
  const args = { chat_id: chatId('imessage', 'apple-fixture', 'tel:+15555550101'), text: 'exact <fixture>', operation_id: 'send-one' };
  const result = await f.controller.request('send', args);
  assert.equal(result.connection, 'imessage');
  assert.deepEqual(await new ChatController(f.options).request('send', args), result);
  assert.equal(f.calls.filter(call => call.method === 'send').length, 1);
  await assert.rejects(f.controller.request('send', { ...args, text: 'changed' }), /already used/);
  await assert.rejects(f.controller.request('send', { ...args, chat_id: chatId('beeper-ios', '@fixture:example.test', '!room') }), /different chat/);
  assert.ok(![...f.values.values()].some(value => value.includes('exact <fixture>')));
});

test('disabled connections are excluded from MCP and never used as a sending fallback', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  await f.controller.request('connections.disable', { connection: 'beeper-ios' });
  const result = await f.controller.request('approved.list');
  assert.equal(result.chats.length, 1);
  assert.equal(result.chats[0].connection, 'imessage');
  await assert.rejects(f.controller.request('send', { chat_id: chatId('beeper-ios', '@fixture:example.test', '!room'), text: 'fixture' }), /no longer allowed/);
  assert.ok(f.calls.some(call => call.method === 'session.release'));
  assert.equal(f.states['beeper-ios'].approved.length, 1);
});

test('old account references cannot approve, remove, or send after the account changes', async () => {
  const f = fixture();
  const id = chatId('beeper-ios', '@old:example.test', '!room');
  for (const method of ['approve', 'remove']) await assert.rejects(f.controller.request(method, { chat_id: id }), /account has changed/);
  await assert.rejects(f.controller.request('send', { chat_id: id, text: 'fixture' }), /no longer allowed/);
  assert.equal(f.calls.filter(call => call.method === 'send' || call.method === 'approve' || call.method === 'remove').length, 0);
});

test('deleting a paused connection removes its approvals without deleting another connection', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  await f.controller.request('connections.disable', { connection: 'imessage' });
  const paused = (await f.controller.request('connections')).connections.find(item => item.id === 'imessage');
  assert.equal(paused.enabled, false);
  assert.equal(paused.configured, true);
  await f.controller.request('connections.delete', { connection: 'imessage' });
  const result = await f.controller.request('status');
  assert.equal(result.approved.length, 1);
  assert.equal(result.approved[0].connection, 'beeper-ios');
  assert.equal(f.states['beeper-ios'].account, '@fixture:example.test');
});

test('a failing enabled connection prevents an ambiguous name from silently selecting another', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  f.native.request = async () => { throw Error('Fixture offline'); };
  const status = await f.controller.request('status');
  assert.equal(status.approved.length, 1);
  await assert.rejects(f.controller.request('send', { recipient: 'Alex', text: 'fixture' }), /Could not check allowed chats/);
  const result = await f.controller.request('send', { chat_id: chatId('imessage', 'apple-fixture', 'tel:+15555550101'), text: 'fixture' });
  assert.equal(result.connection, 'imessage');
});

test('uncertain sends and secure-storage failures do not cause retries on a different connection', async () => {
  const f = fixture();
  const original = f.native.request;
  f.native.request = async (method, args) => { if (method === 'send') throw Error('Fixture response lost'); return original(method, args); };
  const args = { recipient: 'Alex', text: 'fixture', operation_id: 'uncertain' };
  await assert.rejects(f.controller.request('send', args), /response lost/);
  await assert.rejects(new ChatController(f.options).request('send', args), /unconfirmed/);
  f.options.storage.setItem = () => { throw Error('Storage unavailable'); };
  await assert.rejects(f.controller.request('send', { ...args, operation_id: 'new' }), /Storage unavailable/);
});

test('one connection can be configured while another is checked; the same connection is locked', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  let finish;
  const original = f.native.request;
  f.native.request = (method, args) => method === 'login.start' ? new Promise(resolve => { finish = resolve; }) : original(method, args);
  const pending = f.controller.request('login.start', { connection: 'beeper-ios' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.controller.request('status', { connection: 'imessage' })).account, 'apple-fixture');
  await assert.rejects(f.controller.request('connections.disable', { connection: 'beeper-ios' }), /in progress/);
  finish({ flow: 'fixture' }); await pending;
});

test('federated search requests one bounded page per connection with 8,000 rooms', async () => {
  const connections = [{ id: 'beeper-ios', name: 'Beeper', account: 'b' }, { id: 'imessage', name: 'iMessage', account: 'i' }];
  const chats = {
    'beeper-ios': Array.from({ length: 8000 }, (_, index) => ({ room_id: 'room-' + index, name: 'Chat ' + index, is_group: index >= 50, last_activity: 100000 - index })),
    imessage: Array.from({ length: 60 }, (_, index) => ({ room_id: 'tel:+' + (15555550000 + index), name: 'Contact ' + index, is_group: false, last_activity: 0 })),
  };
  let calls = 0;
  const search = async (id, args) => {
    calls++;
    const start = Number(args.cursor || 0);
    return { chats: chats[id].slice(start, start + 25), next_cursor: start + 25 < chats[id].length ? String(start + 25) : '' };
  };
  let cursor = '', found = [];
  for (let page = 0; page < 6; page++) {
    const before = calls;
    const result = await searchDirectory(connections, { query: '', cursor }, search);
    assert.ok(calls - before <= 2);
    assert.ok(result.chats.length <= 25);
    found.push(...result.chats); cursor = result.next_cursor;
  }
  assert.equal(new Set(found.map(chat => chat.chat_id)).size, found.length);
  assert.equal(found.filter(chat => !chat.is_group).length, 110);
  assert.ok(found.slice(0, 110).every(chat => !chat.is_group));
  await assert.rejects(searchDirectory(connections, { query: 'changed', cursor }, search), /search has changed/);
  await assert.rejects(searchDirectory(connections.slice(0, 1), { query: '', cursor }, search), /search has changed/);
});

test('a search failure keeps the other connection results and reports which connection failed', async () => {
  const result = await searchDirectory([{ id: 'a', account: '1' }, { id: 'b', account: '2' }], {}, async id => {
    if (id === 'a') throw Error('Fixture offline');
    return { chats: [{ room_id: 'one', name: 'Fixture' }] };
  });
  assert.equal(result.chats.length, 1);
  assert.equal(result.errors[0].connection, 'a');
});

test('search fails closed when an account changes between status and its directory request', async () => {
  const f = fixture();
  const original = f.native.request;
  let reads = 0;
  f.native.request = async (method, args) => {
    if (method === 'status' && ++reads === 2) f.states['beeper-ios'].account = '@replacement:example.test';
    return original(method, args);
  };
  const result = await f.controller.request('chats.search', { query: 'Alex' });
  assert.equal(result.chats.length, 0);
  assert.match(result.errors[0].error, /account has changed/);
  assert.equal(f.calls.filter(call => call.method === 'chats.search').length, 0);
});

test('disconnecting Android Beeper releases its cached directory', async () => {
  const f = fixture();
  f.values.set('chat.connection.v1', 'beeper-android');
  f.options.native.request = (method, args) => method === 'capabilities'
    ? Promise.resolve({ beeper_connection: 'beeper-android', imessage_available: true }) : f.native.request(method, args);
  await f.controller.request('connections.delete', { connection: 'beeper-android' });
  assert.deepEqual(f.calls.filter(call => ['connection.delete', 'session.release'].includes(call.method)).map(call => call.method),
    ['connection.delete', 'session.release']);
});

test('conflicting destination fields fail before any message is sent', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  const id = chatId('imessage', 'apple-fixture', 'tel:+15555550101');
  for (const args of [
    { chat_id: id, connection: 'beeper-ios' },
    { chat_id: id, recipient: 'Someone else' },
    { chat_id: 'invalid', recipient: 'Alex' },
  ]) await assert.rejects(f.controller.request('send', { ...args, text: 'fixture' }));
  assert.equal(f.calls.filter(call => call.method === 'send').length, 0);
});

test('a qualified reference works as recipient and passes the selected account to transport', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  const id = chatId('imessage', 'apple-fixture', 'tel:+15555550101');
  const result = await f.controller.request('send', { recipient: id, text: 'fixture' });
  assert.equal(result.chat_id, id);
  assert.equal(f.calls.find(call => call.method === 'send').args.account, 'apple-fixture');
});

test('a nickname can accompany an exact reference even when other chats share the name', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'imessage' });
  const id = chatId('imessage', 'apple-fixture', 'tel:+15555550101');
  assert.equal((await f.controller.request('send', { chat_id: id, recipient: 'Alex', text: 'fixture' })).chat_id, id);
});

test('concurrent connection changes keep both preferences', async () => {
  const f = fixture();
  await f.controller.request('connections.disable', { connection: 'beeper-ios' });
  await Promise.all(['beeper-ios', 'imessage'].map(connection => f.controller.request('connections.enable', { connection })));
  assert.deepEqual((await f.controller.request('connections')).connections.filter(c => c.enabled).map(c => c.id), ['beeper-ios', 'imessage']);
});

test('a short provider page cannot put groups ahead of DMs on its next page', async () => {
  const connections = [{ id: 'direct', account: 'a' }, { id: 'beeper', account: 'b' }];
  let calls = 0;
  const search = async (id, args) => {
    calls++;
    if (id === 'beeper') return { chats: [{ room_id: 'group', name: 'Family', is_group: true, last_activity: 999999 }] };
    if (!args.cursor) return { chats: [{ room_id: 'first', name: 'Alex', is_group: false }], next_cursor: 'next' };
    return { chats: [{ room_id: 'second', name: 'Sam', is_group: false }] };
  };
  const first = await searchDirectory(connections, {}, search);
  assert.deepEqual(first.chats.map(chat => chat.room_id), ['first']);
  assert.equal(calls, 2);
  const second = await searchDirectory(connections, { cursor: first.next_cursor }, search);
  assert.deepEqual(second.chats.map(chat => chat.room_id), ['second', 'group']);
  assert.equal(calls, 4);
  assert.equal(second.next_cursor, '');
});
