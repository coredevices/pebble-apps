const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ChatController } = require('./src/controller');
const { chatId } = require('./src/chat-reference');

function fixture(available = true) {
  const values = new Map([['chat.connections.v2', JSON.stringify({ enabled: [], configured: [] })]]);
  const calls = [];
  const state = { account: 'phone-fixture', connected: true, ready: true, approved: [
    { account: 'phone-fixture', roomId: 'tel:+14155550123', name: 'Alex', nickname: 'Mom', network: 'SMS', aliases: ['+14155550123'] },
  ] };
  const controller = new ChatController({
    storage: { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v) },
    native: { request: async (method,args) => {
      if (method === 'capabilities') return { sms_available: available, beeper_connection: available ? 'beeper-android' : 'beeper-ios' };
      assert.equal(method, 'sms.request', 'SMS must not use Beeper or a direct Go connection');
      calls.push(args);
      if (args.operation === 'status') return structuredClone(state);
      if (args.operation === 'send') return { status: 'accepted_by_sms', recipient_name: 'Mom' };
      if (args.operation === 'chats.search') return { chats: [{ room_id: 'tel:+14155550123', name: 'Alex', phone: '+14155550123', bridge_id: 'SMS' }], next_cursor: '' };
      if (args.operation === 'logout') { state.approved = []; return { session_removed: true }; }
      return { ok: true };
    } },
    createIMessage: () => { throw Error('SMS must not initialize iMessage'); },
    operationId: () => 'generated', fingerprint: v => createHash('sha256').update(v).digest('hex'),
  });
  return { controller, calls };
}

test('iOS has no SMS connection and cannot enable it', async () => {
  const { controller, calls } = fixture(false);
  assert.ok(!(await controller.request('connections')).connections.some(c => c.id === 'sms-android'));
  await assert.rejects(controller.request('connections.enable', { connection: 'sms-android' }), /unavailable/);
  assert.equal(calls.length, 0);
});

test('SMS joins unified search and approved chats, and routes an exact send once', async () => {
  const { controller, calls } = fixture();
  await controller.request('connections.enable', { connection: 'sms-android' });
  const approved = await controller.request('approved.list');
  assert.equal(approved.chats[0].connection_name, 'SMS');
  const search = await controller.request('chats.search', { query: 'Alex', connections: ['sms-android'] });
  assert.equal(search.chats[0].phone, '+14155550123');
  const args = { chat_id: chatId('sms-android', 'phone-fixture', 'tel:+14155550123'), text: 'fixture 👋', operation_id: 'once' };
  assert.equal((await controller.request('send', args)).status, 'accepted_by_sms');
  await controller.request('send', args);
  assert.equal(calls.filter(c => c.operation === 'send').length, 1);
  assert.equal(calls.find(c => c.operation === 'send').input.text, 'fixture 👋');
});

test('pausing and deleting SMS remove it from MCP without touching another connection', async () => {
  const { controller, calls } = fixture();
  await controller.request('connections.enable', { connection: 'sms-android' });
  await controller.request('connections.disable', { connection: 'sms-android' });
  assert.equal((await controller.request('approved.list')).chats.length, 0);
  await assert.rejects(controller.request('send', { recipient: 'Mom', text: 'fixture' }), /No allowed chat/);
  await controller.request('connections.delete', { connection: 'sms-android', account: 'phone-fixture' });
  assert.ok(calls.some(c => c.operation === 'logout'));
  assert.equal((await controller.request('connections')).connections.find(c => c.id === 'sms-android').configured, false);
});
