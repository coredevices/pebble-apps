const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ChatController } = require('./src/controller');
const { IMessageAdapter } = require('./src/imessage-adapter');

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

function fixture() {
  const data = storage();
  const state = { accountId: 'account-one', ready: true };
  const contacts = [{ name: 'Alex', address: 'tel:+15555550101' }, { name: 'Alex Work', address: 'mailto:alex@example.test' }];
  let sends = 0, fail = false;
  const controller = {
    configuration: { status: () => state },
    async handleConfig(message) {
      if (message.type === 'saveContacts') contacts.splice(0, contacts.length, ...message.contacts);
      if (message.type === 'disconnect') { state.accountId = ''; state.ready = false; }
      return { ok: true, status: state.ready ? 'ready' : 'disconnected', contacts: contacts.slice(), handles: ['tel:+15555550999'], selectedSender: 'tel:+15555550999' };
    },
    async handleAction(request, respond) {
      sends++;
      if (fail) return respond.error('FAILED', 'The connection closed before acceptance was confirmed.');
      respond.ok({ data: { messageId: 'fixture-message', recipient: request.args.recipient } });
    },
  };
  const options = { controller, storage: data, fingerprint: value => createHash('sha256').update(value).digest('hex'), operationId: () => 'generated-operation' };
  return { data, state, contacts, controller, options, adapter: new IMessageAdapter(options), sends: () => sends, fail: () => { fail = true; } };
}

test('failed sign-in saves credentials for a restart without exposing secrets in status', async () => {
  const f = fixture();
  const credentials = { appleId: 'person@example.test', macValidationData: 'fixture-token', password: 'fixture-password' };
  const calls = [];
  const original = f.controller.handleConfig;
  f.controller.handleConfig = async message => {
    if (message.type !== 'configure') return original(message);
    calls.push(message);
    return { ok: false, message: 'Fixture connection failed' };
  };
  await assert.rejects(f.adapter.request('imessage.configure', credentials), /Fixture connection failed/);
  const restarted = new IMessageAdapter(f.options);
  await assert.rejects(restarted.request('imessage.configure', { appleId: credentials.appleId }), /Fixture connection failed/);
  assert.deepEqual(calls, [{ ...credentials, type: 'configure' }, { ...credentials, type: 'configure' }]);
  const status = await restarted.status();
  assert.deepEqual(status.saved_sign_in, { apple_id: credentials.appleId, activation_token: true, password: true });
  assert.ok(!JSON.stringify(status).includes(credentials.password));
  assert.ok(!JSON.stringify(status).includes(credentials.macValidationData));
});

test('changing Apple accounts requires a new password and replacements are persisted', async () => {
  const f = fixture();
  await f.adapter.request('imessage.configure', { appleId: 'first@example.test', password: 'first-secret', macValidationData: 'fixture-token' });
  await assert.rejects(f.adapter.request('imessage.configure', { appleId: 'second@example.test' }), /different account needs its own password/);
  assert.equal(f.adapter.savedCredentials().appleId, 'first@example.test');
  await f.adapter.request('imessage.configure', { appleId: 'second@example.test', password: 'second-secret' });
  assert.deepEqual(f.adapter.savedCredentials(), { appleId: 'second@example.test', password: 'second-secret', macValidationData: 'fixture-token' });
});

test('forgetting sign-in clears credentials without revoking the current account or approvals', async () => {
  const f = fixture();
  await f.adapter.request('approve', { room_id: f.contacts[0].address });
  await f.adapter.request('imessage.configure', { appleId: 'first@example.test', password: 'fixture-secret', macValidationData: 'fixture-token' });
  await f.adapter.request('imessage.forgetSignIn');
  const status = await f.adapter.status();
  assert.equal(status.saved_sign_in, null);
  assert.equal(status.ready, true);
  assert.equal(status.approved.length, 1);
  await assert.rejects(f.adapter.request('imessage.configure'), /Enter your Mac activation/);
});

test('disconnect erases saved credentials even if disconnecting the remote identity fails', async () => {
  const f = fixture();
  await f.adapter.request('imessage.configure', { appleId: 'first@example.test', password: 'fixture-secret', macValidationData: 'fixture-token' });
  const original = f.controller.handleConfig;
  f.controller.handleConfig = async message => message.type === 'disconnect' ? { ok: false, message: 'Fixture disconnect failed' } : original(message);
  await assert.rejects(f.adapter.request('imessage.disconnect'), /Fixture disconnect failed/);
  assert.equal(f.adapter.savedCredentials(), null);
});

test('sign-in does not start when credentials cannot be saved securely', async () => {
  const f = fixture();
  const original = f.controller.handleConfig;
  f.controller.handleConfig = async message => {
    assert.notEqual(message.type, 'configure');
    return original(message);
  };
  f.data.setItem = () => { throw Error('Secure storage unavailable'); };
  await assert.rejects(f.adapter.request('imessage.configure', { appleId: 'first@example.test', password: 'fixture-secret', macValidationData: 'fixture-token' }), /Secure storage unavailable/);
});

test('direct iMessage rejects raw unapproved recipients and scopes approvals to the Apple account', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.request('send', { recipient: '+15555550101', text: 'fixture' }), /No allowed/);
  await f.adapter.request('approve', { room_id: f.contacts[0].address });
  f.state.accountId = 'different-account';
  await assert.rejects(f.adapter.request('send', { recipient: '+15555550101', text: 'fixture' }), /No allowed/);
  assert.equal(f.sends(), 0);
});

test('accepted sends survive adapter restart; changed text cannot reuse an operation', async () => {
  const f = fixture();
  await f.adapter.request('approve', { room_id: f.contacts[0].address, nickname: 'Friend' });
  const args = { recipient: 'friend', text: 'Keep this literal <message>.', operation_id: 'send-one' };
  const result = await f.adapter.request('send', args);
  assert.equal(result.status, 'accepted_by_imessage');
  assert.equal(result.recipient_name, 'Friend');
  assert.deepEqual(await new IMessageAdapter(f.options).request('send', args), result);
  await assert.rejects(f.adapter.request('send', { ...args, text: 'Changed' }), /different message/);
  assert.equal(f.sends(), 1);
  assert.ok(![...f.data.values.values()].some(value => value.includes(args.text)));
});

test('an uncertain send remains blocked after restart instead of sending a duplicate', async () => {
  const f = fixture();
  await f.adapter.request('approve', { room_id: f.contacts[0].address });
  f.fail();
  const args = { recipient: 'Alex', text: 'fixture', operation_id: 'uncertain' };
  await assert.rejects(f.adapter.request('send', args), /closed/);
  await assert.rejects(new IMessageAdapter(f.options).request('send', args), /unconfirmed/);
  assert.equal(f.sends(), 1);
});

test('storage failure before sending prevents the transport call', async () => {
  const f = fixture();
  await f.adapter.request('approve', { room_id: f.contacts[0].address });
  f.data.setItem = () => { throw Error('Disk unavailable'); };
  await assert.rejects(f.adapter.request('send', { recipient: 'Alex', text: 'fixture' }), /Disk unavailable/);
  assert.equal(f.sends(), 0);
});

test('ambiguous names cannot choose a recipient and removing a saved contact revokes its approval', async () => {
  const f = fixture();
  for (const contact of f.contacts) await f.adapter.request('approve', { room_id: contact.address });
  await assert.rejects(f.adapter.request('send', { recipient: 'Al', text: 'fixture' }), /Several allowed/);
  await f.adapter.request('imessage.saveContacts', { contacts: [f.contacts[1]] });
  await assert.rejects(f.adapter.request('send', { recipient: '+15555550101', text: 'fixture' }), /No allowed/);
  await f.adapter.request('imessage.disconnect');
  assert.equal(f.adapter.approvals().length, 0);
  assert.equal(f.contacts.length, 0);
  assert.equal(f.sends(), 0);
});

test('address-book recipients can be approved and searched without network lookups', async () => {
  const f = fixture();
  const address = 'tel:+13177303794';
  f.options.contacts = { request: async () => ({ contacts: [{ key: 'phone-contact', name: 'Fixture Person', address: '+1 (317) 730-3794', type: 'phone' }], next_cursor: '' }) };
  const adapter = new IMessageAdapter(f.options);
  const results = await adapter.request('chats.search', { query: '3177303794' });
  assert.equal(results.chats[0].room_id, address);
  await adapter.request('approve', { room_id: address, contact_key: 'phone-contact' });
  assert.equal((await adapter.status()).approved[0].name, 'Fixture Person');
  assert.equal(f.contacts.at(-1).address, address);
  assert.equal(f.sends(), 0);
});

test('address-book lookup errors remain visible instead of approving a made-up recipient', async () => {
  const f = fixture();
  f.options.contacts = { request: async () => ({ error: 'Contacts unavailable' }) };
  const adapter = new IMessageAdapter(f.options);
  await assert.rejects(adapter.request('chats.search', { query: 'Fixture' }), /Contacts unavailable/);
  await assert.rejects(adapter.request('approve', { room_id: 'tel:+13177303794' }), /Contacts unavailable/);
  assert.equal(adapter.approvals().length, 0);
});

test('stale iMessage account references cannot send, approve, remove, or disconnect', async () => {
  const f = fixture();
  await f.adapter.request('approve', { room_id: f.contacts[0].address });
  for (const method of ['send', 'approve', 'remove', 'imessage.disconnect', 'imessage.saveContacts', 'imessage.forgetSignIn']) {
    await assert.rejects(f.adapter.request(method, {
      account: 'old-account', recipient: f.contacts[0].address, room_id: f.contacts[0].address, text: 'fixture', contacts: [],
    }), /account has changed/);
  }
  assert.equal(f.sends(), 0);
  assert.equal((await f.adapter.status()).approved.length, 1);
  assert.equal(f.state.accountId, 'account-one');
});

test('forget sign-in recovers malformed saved credentials without changing the connected account', async () => {
  const f = fixture();
  f.data.setItem('chat.imessage.credentials.v1', '{malformed');
  const state = await f.adapter.request('imessage.forgetSignIn', { account: f.state.accountId });
  assert.equal(state.saved_sign_in, null);
  assert.equal(state.account, 'account-one');
});

test('cloud Mac selection keeps the key out of settings responses and supplies it to sign-in', async () => {
  const f = fixture();
  const calls = [];
  const key = { id: 'mac-1', computer_name: 'Fixture Mac', created_at: '2026-09-17T00:00:00Z' };
  f.adapter.activationKeys = { request: async (operation, args) => {
    if (operation === 'activationKeys.list') return { signed_in: true, account: 'pebble-one', keys: [key] };
    if (operation === 'activationKeys.account') return { account: 'pebble-one' };
    assert.equal(operation, 'activationKeys.read');
    assert.deepEqual(args, { account: 'pebble-one', id: 'mac-1' });
    return { macValidationData: 'private-fixture-mac-key' };
  } };
  const original = f.controller.handleConfig;
  f.controller.handleConfig = async args => { if (args.type === 'configure') calls.push(args); return original(args); };
  assert.deepEqual((await f.adapter.request('imessage.activationKeys')).keys, [key]);
  const selected = await f.adapter.request('imessage.selectActivationKey', { pebble_account: 'pebble-one', key_id: 'mac-1' });
  assert.deepEqual(selected, { loaded: true, key_id: 'mac-1' });
  const status = await f.adapter.request('imessage.configure', { pebble_account: 'pebble-one', key_id: 'mac-1', appleId: 'apple@example.test', password: 'fixture-secret' });
  assert.equal(calls[0].macValidationData, 'private-fixture-mac-key');
  assert.ok(!JSON.stringify(status).includes('private-fixture-mac-key'));
  await f.adapter.request('imessage.configure', {});
  assert.equal(calls[1].macValidationData, calls[0].macValidationData);
  await f.adapter.request('imessage.disconnect');
  assert.equal(f.data.getItem('chat.imessage.mac-key.v1'), null);
  assert.equal(f.adapter.savedCredentials(), null);
  assert.equal((await f.adapter.status()).connected, false);
});

test('cloud keys cannot be reused after switching Pebble account, including saved credentials', async () => {
  const f = fixture();
  let account = 'pebble-one';
  f.adapter.activationKeys = { request: async operation => operation === 'activationKeys.read' ? { macValidationData: 'private-fixture-key' } : { account, keys: [] } };
  const selection = { pebble_account: account, key_id: 'mac-1' };
  await f.adapter.request('imessage.selectActivationKey', selection);
  await f.adapter.request('imessage.configure', { ...selection, appleId: 'apple@example.test', password: 'fixture-secret' });
  await f.adapter.request('imessage.configure', { macValidationData: '   ' });
  assert.equal(f.adapter.savedCredentials().macKeyOwner, account);
  account = 'pebble-two';
  await assert.rejects(f.adapter.request('imessage.configure', selection), /Pebble account changed/);
  await assert.rejects(f.adapter.request('imessage.configure', {}), /Pebble account changed/);
  await f.adapter.request('imessage.activationKeys');
  assert.equal(f.data.getItem('chat.imessage.mac-key.v1'), null);
  await assert.rejects(f.adapter.request('imessage.configure', selection), /Choose your saved Mac again/);
  await f.adapter.request('imessage.configure', { macValidationData: 'manual-fixture-key' });
  assert.equal(f.adapter.savedCredentials().macValidationData, 'manual-fixture-key');
  assert.equal(f.adapter.savedCredentials().macKeyOwner, undefined);
});

test('a failed cloud read never replaces a selected key or returns a success', async () => {
  const f = fixture();
  f.adapter.activationKeys = { request: async () => { throw Error('Fixture offline'); } };
  await assert.rejects(f.adapter.request('imessage.selectActivationKey', { pebble_account: 'fixture', key_id: 'mac-1' }), /Fixture offline/);
  assert.equal(f.data.getItem('chat.imessage.mac-key.v1'), null);
});
