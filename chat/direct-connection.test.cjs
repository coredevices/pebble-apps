const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ChatController } = require('./src/controller');
const { chatId } = require('./src/chat-reference');
const { DirectAdapter } = require('./src/direct-adapter');

function fixture() {
  const storage = new Map();
  const calls = [];
  const states = Object.fromEntries(['whatsapp', 'telegram'].map(network => [network, {
    account: network + '-account', connected: true, ready: true,
    approved: [{ account: network + '-account', roomId: 'friend', name: 'Alex', network, nickname: '' }],
  }]));
  const options = { storage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    fingerprint: value => createHash('sha256').update(value).digest('hex'), operationId: () => 'op-1',
    native: { request: async (method, args) => {
      calls.push({ method, args });
      if (method === 'capabilities') return { whatsapp_available: true, telegram_available: true };
      if (method === 'contacts.search') return { contacts: [], next_cursor: '' };
      assert.equal(method, 'direct.request');
      const state = states[args.network];
      if (args.operation === 'status') return structuredClone(state);
      if (args.operation === 'send') return { status: 'accepted_by_' + args.network, recipient_name: 'Alex', event_id: 'accepted' };
      if (args.operation === 'chats.search') return { chats: [{ room_id: 'friend', name: 'Alex', bridge_id: args.network, can_send: true }], next_cursor: '' };
      if (args.operation === 'logout') { state.ready = false; state.connected = false; state.approved = []; return { session_removed: true }; }
      return { ok: true };
    } } };
  return { controller: new ChatController(options), options, calls, states };
}
test('WhatsApp and Telegram stay separate through enable, search, send, pause, and delete', async () => {
  const f = fixture();
  for (const connection of ['whatsapp', 'telegram']) await f.controller.request('connections.enable', { connection });
  const search = await f.controller.request('chats.search', { query: 'Alex' });
  assert.equal(search.chats.length, 2);
  await assert.rejects(f.controller.request('send', { recipient: 'Alex', text: 'hello' }), /Several allowed chats/);
  const args = { chat_id: chatId('telegram', 'telegram-account', 'friend'), text: 'hello 👋', operation_id: 'one' };
  const result = await f.controller.request('send', args);
  assert.equal(result.connection, 'telegram');
  assert.equal(result.status, 'accepted_by_telegram');
  assert.deepEqual(await new ChatController(f.options).request('send', args), result);
  assert.equal(f.calls.filter(call => call.args?.operation === 'send').length, 1);
  await f.controller.request('connections.disable', { connection: 'whatsapp' });
  assert.equal((await f.controller.request('approved.list')).chats.length, 1);
  assert.ok(f.calls.some(call => call.args?.network === 'whatsapp' && call.args.operation === 'directory.stop'));
  await f.controller.request('connections.delete', { connection: 'telegram', account: 'telegram-account' });
  assert.equal((await f.controller.request('approved.list')).chats.length, 0);
});
test('new networks reject references to a previous signed-in account', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'whatsapp' });
  await assert.rejects(f.controller.request('approve', { chat_id: chatId('whatsapp', 'other-account', 'friend') }), /account has changed/);
  assert.ok(!f.calls.some(call => call.args?.operation === 'approve'));
});

test('WhatsApp directory search works when phone Contacts permission is denied', async () => {
  const adapter = new DirectAdapter({ request: async (method, args) => {
    if (method === 'contacts.search') return { granted: false, contacts: [], error: 'Contacts could not be read. Try again.' };
    assert.equal(method, 'direct.request');
    if (args.operation === 'status') return { account: 'test-account', connected: true };
    assert.equal(args.operation, 'chats.search');
    return { chats: [{ room_id: '15555550123@s.whatsapp.net', name: 'Alex', can_send: true }], next_cursor: '' };
  } }, 'whatsapp');
  const result = await adapter.request('chats.search', { query: 'Alex' });
  assert.deepEqual(result.chats.map(chat => chat.name), ['Alex']);
  assert.equal(result.error, '');
  assert.equal(result.next_cursor, '');
});

test('maintenance only checks enabled WhatsApp and skips other connections and concurrent actions', async () => {
  const f = fixture();
  await f.controller.request('connections.enable', { connection: 'telegram' });
  await f.controller.request('connections.maintain');
  assert.equal(f.calls.filter(c => c.args?.operation === 'maintenance').length, 0);
  await f.controller.request('connections.enable', { connection: 'whatsapp' });
  await f.controller.request('connections.maintain');
  assert.deepEqual(f.calls.filter(c => c.args?.operation === 'maintenance').map(c => c.args.network), ['whatsapp']);
  f.controller.locks.add('whatsapp');
  await f.controller.request('connections.maintain');
  f.controller.locks.delete('whatsapp');
  await f.controller.request('connections.disable', { connection: 'whatsapp' });
  await f.controller.request('connections.maintain');
  assert.equal(f.calls.filter(c => c.args?.operation === 'maintenance').length, 1);
  assert.equal(f.calls.filter(c => c.args?.operation === 'send').length, 0);
});
