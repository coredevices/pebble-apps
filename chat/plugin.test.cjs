const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function load(request, values = new Map()) {
  const handlers = {};
  const forbidden = () => assert.fail('Status must not start authentication or networking');
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'), {
    Pebble: {
      chat: { request: async (method, args) => method === 'capabilities' ? { beeper_connection: 'beeper-ios', imessage_available: true } : request(method, args) },
      registerActionHandler: handler => handlers.action = handler,
      registerConfigHandler: handler => handlers.config = handler,
    },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    _HostCrypto: { request: json => {
      const request = JSON.parse(json);
      assert.equal(request.operation, 'digest');
      return JSON.stringify({ ok: true, data: crypto.createHash('sha256').update(Buffer.from(request.data, 'base64')).digest('base64') });
    } },
    _HostX86: { request: forbidden }, _HostTimer: { schedule: forbidden, cancel() {} },
    _HostWebSocket: { open: forbidden }, _HostTlsSocket: { open: forbidden, write: forbidden, close() {} }, XMLHttpRequest: forbidden,
  });
  return handlers;
}
const state = { account: 'fixture', ready: true, connected: true, approved: [{ account: 'fixture', roomId: '!room', name: 'Test Group', nickname: 'Saved Nickname', network: 'fixture' }] };

test('bundled action preserves exact text and operation ID after resolving the allowed chat', async () => {
  let result;
  const handlers = load(async (method, args) => {
    if (method === 'status') return state;
    assert.equal(method, 'send'); assert.equal(args.recipient, '!room');
    assert.equal(args.text, 'Hello <world> — exactly this.'); assert.equal(args.operation_id, 'unique-test-operation');
    return { status: 'accepted_by_beeper', recipient_name: 'Saved Nickname' };
  });
  await handlers.action({ action: 'send_message', args: { recipient: 'Test Group', text: 'Hello <world> — exactly this.', operation_id: 'unique-test-operation' } }, {
    ok: value => result = value, error: (code, message) => assert.fail(message),
  });
  assert.equal(result.text, 'Sent to Saved Nickname');
});

test('bundled MCP list only exposes allowed chats and rejects unknown recipients', async () => {
  const handlers = load(async method => { assert.equal(method, 'status'); return state; });
  let result, failure;
  await handlers.action({ action: 'list_chats' }, { ok: value => result = value, error: assert.fail });
  assert.equal(result.data.chats.length, 1);
  assert.equal(result.data.chats[0].chat_id, 'chat:beeper-ios:fixture:!room');
  await handlers.action({ action: 'send_message', args: { recipient: 'Unknown', text: 'fixture' } }, {
    ok: () => assert.fail('Unapproved send succeeded'), error: (code, message) => failure = message,
  });
  assert.match(failure, /No allowed chat/);
});

test('config rejects direct native message.send', async () => {
  let result;
  await load(() => assert.fail('must not reach native')).config({ operation: 'message.send' }, reply => result = reply);
  assert.equal(result.error, 'Unknown Chat operation');
});

test('bundled direct iMessage restores its empty sign-in without starting Go or a network request', async () => {
  const values = new Map([['chat.connection.v1', 'imessage']]);
  let result;
  await load(() => assert.fail('must not start Go'), values).config({ operation: 'status', args: { connection: 'imessage' } }, reply => result = reply);
  assert.equal(result.imessage_phase, 'disconnected');
  assert.equal(result.approved.length, 0);
});

test('bundled failed sign-in keeps secure credentials and exposes only presence flags', async () => {
  const values = new Map([['chat.connection.v1', 'imessage']]);
  let result;
  const handlers = load(() => assert.fail('must not start Go'), values);
  await handlers.config({ operation: 'imessage.configure', args: { connection: 'imessage', appleId: 'fixture@example.test', macValidationData: 'invalid-fixture-token', password: 'fixture-password' } }, reply => result = reply);
  assert.ok(result.error);
  await handlers.config({ operation: 'status', args: { connection: 'imessage' } }, reply => result = reply);
  assert.equal(result.saved_sign_in.apple_id, 'fixture@example.test');
  assert.equal(result.saved_sign_in.password, true);
  assert.ok(!JSON.stringify(result).includes('fixture-password'));
  assert.ok(!JSON.stringify(result).includes('invalid-fixture-token'));
});
