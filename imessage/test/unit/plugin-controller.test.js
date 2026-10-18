'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var controllerModule = require('../../src/plugin-controller');
var PluginController = controllerModule.PluginController;
var RuntimeError = require('../../src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../src/runtime/errors').ERROR_KINDS;
var UserPreferences = require('../../src/preferences/user-preferences').UserPreferences;

function MemoryStorage() { this.values = Object.create(null); }
MemoryStorage.prototype.get = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};
MemoryStorage.prototype.set = function (key, value) { this.values[key] = value; };
MemoryStorage.prototype.delete = function (key) { delete this.values[key]; };

function fixture(phase, handles) {
  var current = phase || 'disconnected';
  var currentHandles = handles || [];
  var sends = [];
  var senders = [];
  var prepares = 0;
  var configuration = {
    status: function () { return { phase: current, ready: current === 'ready', canSubmitTwoFactor: current === 'needs-two-factor', handles: currentHandles }; },
    configure: async function (credentials) { assert.equal(credentials.password, 'secret'); current = 'ready'; return this.status(); },
    submitTwoFactor: async function () { current = 'ready'; return this.status(); },
    disconnect: async function () { current = 'disconnected'; return this.status(); },
  };
  var storage = new MemoryStorage();
  var preferences = new UserPreferences(storage, { storageKey: 'test.preferences' });
  var subject = new PluginController({
    configuration: configuration,
    preferences: preferences,
    prepareConfiguration: async function () { prepares += 1; },
    createSender: async function (options) { senders.push(options.sender); return {
      send: async function (request) {
        sends.push([request.recipient, request.text]);
        return { messageId: 'FIXTURE-MESSAGE-ID', recipient: request.recipient };
      },
      close: function () {},
    }; },
  });
  return { subject: subject, sends: sends, senders: senders, preferences: preferences, storage: storage,
    prepared: function () { return prepares; } };
}

function invoke(subject, args) {
  return new Promise(function (resolve) {
    subject.handleAction({ action: 'send_message', args: args }, {
      ok: function (value) { resolve(Object.assign({ ok: true }, value)); },
      error: function (code, message) { resolve({ ok: false, code: code, message: message }); },
    });
  });
}

test('controller normalizes one recipient, uses the phone-first sender, preserves exact text, and closes over no plaintext state', async function () {
  var ready = fixture('ready', ['mailto:sender@example.test', 'tel:+15555550123']);
  var result = await invoke(ready.subject, { recipient: ' +1 (415) 555-0123 ', text: ' Hello \u2603 ' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    messageId: 'FIXTURE-MESSAGE-ID',
    recipient: 'tel:+14155550123',
  });
  assert.deepEqual(ready.sends, [['tel:+14155550123', ' Hello \u2603 ']]);
  assert.deepEqual(ready.senders, ['tel:+15555550123']);
  assert.equal(JSON.stringify(ready.subject).indexOf('Hello'), -1);
});

test('controller rejects groups, invalid phones, empty text, and unconfigured sends before networking', async function () {
  var disconnected = fixture();
  for (const args of [
    { recipient: 'a@example.com,b@example.com', text: 'Hi' },
    { recipient: '4155550123', text: 'Hi' },
    { recipient: 'a@example.com', text: '' },
  ]) assert.equal((await invoke(disconnected.subject, args)).code, 'INVALID_ARGS');
  assert.equal((await invoke(disconnected.subject, { recipient: 'a@example.com', text: 'Hi' })).code, 'AUTH_REQUIRED');
  assert.deepEqual(disconnected.sends, []);
});

test('unknown contact names and corrupt preference storage fail without creating a sender', async function () {
  var ready = fixture('ready', ['tel:+15555550123']);
  assert.equal((await invoke(ready.subject, { recipient: 'Unknown Person', text: 'Hi' })).code, 'INVALID_ARGS');
  assert.deepEqual(ready.senders, []);

  ready.storage.values['test.preferences'] = '{not-json';
  var corrupt = await invoke(ready.subject, { recipient: 'Danny', text: 'Hi' });
  assert.equal(corrupt.code, 'PLUGIN_UNAVAILABLE');
  assert.equal(corrupt.message, 'Saved iMessage contacts and sender preference could not be restored.');
  assert.deepEqual(ready.senders, []);
});

test('configuration prepares live endpoints, maps phases for the page, and never returns credentials', async function () {
  var setup = fixture();
  var reply = await setup.subject.handleConfig({
    type: 'configure', macValidationData: 'mac-token', appleId: 'person@example.com', password: 'secret',
  });
  assert.deepEqual(reply, { ok: true, status: 'ready', handles: [], contacts: [], selectedSender: null });
  assert.equal(setup.prepared(), 1);
  assert.equal(JSON.stringify(reply).includes('secret'), false);
  assert.equal((await setup.subject.handleConfig({ type: 'disconnect' })).status, 'disconnected');
});

test('controller reports a reached 2FA challenge without advertising code submission before validation', function () {
  assert.deepEqual(controllerModule.configReply({
    phase: 'needs-two-factor', ready: false, canSubmitTwoFactor: false, handles: [],
  }), {
    ok: true,
    status: 'needsTwoFactor',
    handles: [],
    contacts: [],
    selectedSender: null,
    canSubmitTwoFactor: false,
  });
});

test('controller allows a hardware-only 2FA session to disconnect and start over', async function () {
  var setup = fixture('needs-two-factor');
  setup.subject.configuration.status = function () {
    return { phase: 'needs-two-factor', ready: false, canSubmitTwoFactor: false, handles: [] };
  };
  setup.subject.configuration.disconnect = async function () {
    return { phase: 'disconnected', ready: false, handles: [] };
  };

  assert.deepEqual(await setup.subject.handleConfig({ type: 'disconnect' }), {
    ok: true,
    status: 'disconnected',
    handles: [],
    contacts: [],
    selectedSender: null,
  });
});

test('controller reports disconnected after Apple state deletion even if sender cleanup fails', async function () {
  var setup = fixture('ready', ['tel:+15555550123']);
  setup.preferences.reconcileSelectedSender(['tel:+15555550123']);
  setup.preferences.clearSelectedSender = function () {
    throw new RuntimeError('PREFERENCES_WRITE_FAILED', 'private preference failure', {
      kind: ERROR_KINDS.STORAGE,
    });
  };

  assert.deepEqual(await setup.subject.handleConfig({ type: 'disconnect' }), {
    ok: false,
    code: 'PLUGIN_UNAVAILABLE',
    message: 'Saved iMessage contacts and sender preference could not be restored.',
    status: 'disconnected',
  });
});

test('controller saves contacts, resolves names for sending, and validates send-from selection', async function () {
  var setup = fixture('ready', ['mailto:sender@example.test', 'tel:+15555550123']);
  var saved = await setup.subject.handleConfig({
    type: 'saveContacts',
    contacts: [{ name: 'Danny', address: '+15105085455' }],
  });
  assert.deepEqual(saved.contacts, [{ name: 'Danny', address: 'tel:+15105085455' }]);
  assert.equal(saved.selectedSender, 'tel:+15555550123');

  var selected = await setup.subject.handleConfig({
    type: 'selectSender', sender: 'sender@example.test',
  });
  assert.equal(selected.selectedSender, 'mailto:sender@example.test');
  assert.equal((await setup.subject.handleConfig({
    type: 'selectSender', sender: '+15555550999',
  })).code, 'INVALID_ARGS');

  var sent = await invoke(setup.subject, { recipient: 'danny', text: 'hey whats up' });
  assert.equal(sent.ok, true);
  assert.deepEqual(setup.sends, [['tel:+15105085455', 'hey whats up']]);
  assert.deepEqual(setup.senders, ['mailto:sender@example.test']);

  var disconnected = await setup.subject.handleConfig({ type: 'disconnect' });
  assert.deepEqual(disconnected.contacts, [{ name: 'Danny', address: 'tel:+15105085455' }]);
  assert.equal(disconnected.selectedSender, null);
});

test('controller maps dynamic APS activation and legacy bootstrap errors to safe actionable replies', function () {
  var missing = controllerModule.safeFailure(new RuntimeError(
    'APS_BOOTSTRAP_REQUIRED',
    'internal bootstrap context',
    { kind: ERROR_KINDS.INVALID_INPUT, cause: new Error('private material') }
  ), 'configure');
  assert.deepEqual(missing, {
    code: 'PLUGIN_UNAVAILABLE',
    message: 'Apple Push setup could not be completed.',
  });

  assert.deepEqual(controllerModule.safeFailure(new RuntimeError(
    'APS_ACTIVATION_INVALID_INPUT', 'private activation context', { kind: ERROR_KINDS.INVALID_INPUT }
  ), 'configure'), {
    code: 'INVALID_ARGS',
    message: 'The Mac + RustPush token cannot be used for Apple Push setup.',
  });

  ['APS_ACTIVATION_NETWORK_ERROR', 'APS_ACTIVATION_REJECTED', 'APS_CONNECT_FAILED',
    'APS_CONNECT_TIMEOUT', 'APS_TLS_ERROR'].forEach(function (code) {
    var network = controllerModule.safeFailure(new RuntimeError(code, 'private activation context', {
      kind: ERROR_KINDS.TRANSPORT, retryable: true,
    }), 'configure');
    assert.deepEqual(network, {
      code: 'PLUGIN_UNAVAILABLE',
      message: 'Apple Push setup could not connect. Check your connection and try again.',
    });
    assert.equal(JSON.stringify(network).indexOf('private activation context'), -1);
  });

  var rejected = controllerModule.safeFailure(new RuntimeError(
    'APS_ACTIVATION_REJECTED', 'private deterministic rejection', {
      kind: ERROR_KINDS.TRANSPORT, retryable: false,
    }
  ), 'configure');
  assert.deepEqual(rejected, {
    code: 'PLUGIN_UNAVAILABLE',
    message: 'Apple rejected Apple Push setup. This build cannot continue with the current activation material.',
  });
  assert.equal(rejected.message.includes('try again'), false);
  assert.equal(JSON.stringify(rejected).includes('private deterministic rejection'), false);

  ['APS_ACTIVATION_CRYPTO_ERROR', 'APS_ACTIVATION_RESPONSE_INVALID'].forEach(function (code) {
    assert.deepEqual(controllerModule.safeFailure(new RuntimeError(code, 'private activation context'), 'configure'), {
      code: 'PLUGIN_UNAVAILABLE',
      message: 'Apple Push setup could not be completed.',
    });
  });

  ['APS_BOOTSTRAP_INVALID', 'APS_BOOTSTRAP_NOT_YET_VALID', 'APS_BOOTSTRAP_EXPIRED'].forEach(function (code) {
    var invalid = controllerModule.safeFailure(new RuntimeError(code, 'private material', {
      kind: ERROR_KINDS.INVALID_INPUT,
    }), 'configure');
    assert.deepEqual(invalid, {
      code: 'INVALID_ARGS',
      message: 'The APS bootstrap in the Mac + RustPush token is invalid or expired.',
    });
    assert.equal(JSON.stringify(invalid).indexOf('private material'), -1);
  });

  assert.deepEqual(controllerModule.safeFailure(new RuntimeError(
    'INVALID_MAC_TOKEN', 'private token details', { kind: ERROR_KINDS.INVALID_INPUT }
  ), 'configure'), {
    code: 'INVALID_ARGS',
    message: 'The Mac + RustPush token is invalid.',
  });

  assert.deepEqual(controllerModule.safeFailure(new RuntimeError(
    'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED', 'private hardware details', {
      kind: ERROR_KINDS.INVALID_INPUT,
    }
  ), 'configure'), {
    code: 'INVALID_ARGS',
    message: 'This ExtractKey activation is incomplete. Export the full encrypted Mac hardware activation and try again.',
  });

  assert.deepEqual(controllerModule.safeFailure(new RuntimeError(
    'MAC_VALIDATION_REQUIRED', 'private validation details', { kind: ERROR_KINDS.INVALID_INPUT }
  ), 'configure'), {
    code: 'AUTH_REQUIRED',
    message: 'Fresh Mac validation data is unavailable in this session. Start iMessage setup again.',
  });
});

test('configuration validates malformed Mac data before preparing network endpoints', async function () {
  var setup = fixture();
  setup.subject.configuration.validateConfigurationInput = function () {
    throw new RuntimeError('INVALID_MAC_TOKEN', 'internal details', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  };
  var reply = await setup.subject.handleConfig({
    type: 'configure', macValidationData: 'mac-token', appleId: 'person@example.com', password: 'secret',
  });
  assert.equal(reply.code, 'INVALID_ARGS');
  assert.equal(reply.message, 'The Mac + RustPush token is invalid.');
  assert.equal(setup.prepared(), 0);
  assert.equal(JSON.stringify(reply).indexOf('secret'), -1);
});

test('configuration reports an incomplete ExtractKey activation before preparing endpoints', async function () {
  var setup = fixture();
  setup.subject.configuration.validateConfigurationInput = function () {
    throw new RuntimeError('MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED', 'private hardware details', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  };
  var reply = await setup.subject.handleConfig({
    type: 'configure', macValidationData: 'mac-token', appleId: 'person@example.com', password: 'secret',
  });
  assert.deepEqual(reply, {
    ok: false,
    code: 'INVALID_ARGS',
    message: 'This ExtractKey activation is incomplete. Export the full encrypted Mac hardware activation and try again.',
    status: 'disconnected',
  });
  assert.equal(setup.prepared(), 0);
  assert.equal(JSON.stringify(reply).includes('secret'), false);
});

test('refresh validates readiness and never calls send', async function () {
  var ready = fixture('ready', ['tel:+15555550123']);
  var refreshes = 0;
  ready.subject.createSender = async function (options) {
    assert.equal(options.sender, 'tel:+15555550123');
    return { refresh: async function () { refreshes++; }, send: function () { assert.fail('refresh must not send'); } };
  };
  assert.equal((await ready.subject.handleConfig({ type: 'refresh' })).ok, true);
  assert.equal(refreshes, 1);
  assert.equal(ready.subject.sending, false);
  var disconnected = fixture();
  assert.equal((await disconnected.subject.handleConfig({ type: 'refresh' })).ok, false);
  assert.equal(disconnected.senders.length, 0);
});
