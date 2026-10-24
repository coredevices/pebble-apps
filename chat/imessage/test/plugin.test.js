'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
const appinfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appinfo.json'), 'utf8'));

function load(options = {}) {
  let actionHandler;
  let configHandler;
  let endpointDiscoveryAttempts = 0;
  let tlsOpenAttempts = 0;
  const traces = [];
  const values = Object.create(null);
  const context = {
    Uint8Array,
    ArrayBuffer,
    DataView,
    Promise,
    Date,
    JSON,
    Math,
    BigInt,
    TextEncoder,
    TextDecoder,
    console: { info(prefix, kind) { traces.push([prefix, kind]); }, error() {} },
    _HostCrypto: { request() { throw new Error('crypto must not run in validation tests'); } },
    _HostX86: { request() { throw new Error('x86 emulation must not run in validation tests'); } },
    _HostTimer: options.hostTimer || {
      schedule(delayMillis) {
        const handle = setTimeout(function () { context.__hostTimerDispatch(handle); }, delayMillis);
        return Number(handle);
      },
      cancel(handle) { clearTimeout(handle); },
    },
    _HostWebSocket: { open() { throw new Error('WebSocket must not run in validation tests'); } },
    _HostTlsSocket: options.HostTlsSocket || {
      open() { tlsOpenAttempts += 1; throw new Error('TLS must not run in validation tests'); },
      write() { throw new Error('TLS must not write in validation tests'); },
      close() {},
    },
    XMLHttpRequest: function () {
      endpointDiscoveryAttempts += 1;
      if (options.XMLHttpRequest) return new options.XMLHttpRequest();
      throw new Error('XHR must not run in validation tests');
    },
    localStorage: {
      getItem(key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
      setItem(key, value) { values[key] = String(value); },
      removeItem(key) { delete values[key]; },
    },
    Pebble: {
      registerActionHandler(handler) { actionHandler = handler; },
      registerConfigHandler(handler) { configHandler = handler; },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: 'plugin.js' });
  return {
    actionHandler,
    configHandler,
    values,
    traces,
    context,
    endpointDiscoveryAttempts() { return endpointDiscoveryAttempts; },
    tlsOpenAttempts() { return tlsOpenAttempts; },
  };
}

function invokeAction(handler, args) {
  return new Promise((resolve) => {
    handler(
      { action: 'send_message', args },
      {
        ok(result) { resolve({ ok: true, ...result }); },
        error(code, message) { resolve({ ok: false, code, message }); },
      },
    );
  });
}

function invokeConfig(handler, message) {
  return new Promise((resolve) => handler(message, resolve));
}

function macTokenWithoutBootstrap() {
  return JSON.stringify({
    inner: {
      productName: 'Mac15,3',
      ioMacAddress: [0, 17, 34, 51, 68, 85],
      platformSerialNumber: 'SERIAL-FIXTURE',
      platformUuid: '11111111-2222-3333-4444-555555555555',
      rootDiskUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      boardId: 'Mac-FAKEBOARD',
      osBuildNum: '23E224',
      platformSerialNumberEnc: new Array(17).fill(1),
      platformUuidEnc: new Array(17).fill(2),
      rootDiskUuidEnc: new Array(17).fill(3),
      rom: [0, 17, 34, 51, 68, 85],
      romEnc: new Array(17).fill(4),
      mlb: 'MLB-FIXTURE-0000001',
      mlbEnc: new Array(17).fill(5),
    },
    version: '14.4.1',
    protocol_version: 1701,
    device_id: '11111111-2222-3333-4444-555555555555',
    icloud_ua: 'com.apple.iCloudHelper/282 CFNetwork/1492.0.1 Darwin/23.4.0',
    aoskit_version: 'com.apple.AOSKit/282 (com.apple.accountsd/113)',
  });
}

test('production bundle registers with JS activation and without the retired native bridge', function () {
  const plugin = load();
  assert.equal(typeof plugin.actionHandler, 'function');
  assert.equal(typeof plugin.configHandler, 'function');
  assert.equal(source.includes('_IMessageNative'), false);
  assert.equal(source.includes('imessage-native'), false);
  assert.equal(source.includes('ApsProvisioningRunner'), false);
  assert.equal(source.includes('deviceActivation'), true);
  assert.equal(source.includes('FairPlayCertChain'), true);
});

test('production manifest declares transport origins and bag-discovered Apple policy', function () {
  assert.match(appinfo.plugin.actions[0].parameters.properties.recipient.description, /contact name/i);
  assert.match(appinfo.plugin.actions[0].description, /Danny/);
  assert.match(appinfo.plugin.actions[0].description, /recipient ‘Danny’ and text ‘hey whats up’/);
  assert.equal(appinfo.plugin.actions[0].usesPermissions.includes('CpuEmulation'), false);
  const internet = appinfo.plugin.actions[0].usesPermissions.find((permission) => (
    permission && permission.name === 'Internet'
  ));
  assert.deepEqual(internet.parameters.origins, [
    'https://ani.sidestore.io',
    'https://gsa.apple.com',
    'https://setup.icloud.com',
    'https://raw.githubusercontent.com',
    'http://init-p01st.push.apple.com',
    'https://init.ess.apple.com',
    'https://apple.com',
    'https://*.apple.com',
  ]);
  const sockets = appinfo.plugin.actions[0].usesPermissions.find((permission) => (
    permission && permission.name === 'NetworkSockets'
  ));
  assert.equal(sockets.parameters.tlsHosts.includes('init.ess.apple.com'), true);
  assert.equal(sockets.parameters.tlsHosts.includes('gsa.apple.com'), true);
  assert.equal(sockets.parameters.tlsHosts.includes('profile.ess.apple.com'), true);
  assert.equal(sockets.parameters.tlsHosts.includes('identity.ess.apple.com'), true);
  assert.equal(sockets.parameters.tlsHosts.includes('static.ess.apple.com'), true);
  assert.equal(sockets.parameters.tlsPorts.includes('443'), true);
  assert.equal(sockets.parameters.tlsTrustAnchorSha256.includes(
    '2d9b64d8ec50d5d3e5a6659194ce52d607b2ad3c026fdd3d7fab724183c232d5'
  ), true);
  assert.equal(sockets.parameters.tlsTrustAnchorSha256.includes(
    'efd0c3352e8f5cc6c7678a5cb48370c341db58d39fc0569d5e106f02c4fcaceb'
  ), true);
});

test('cold production bundle reports disconnected and rejects send before network or crypto', async function () {
  const plugin = load();
  assert.deepEqual(JSON.parse(JSON.stringify(
    await invokeConfig(plugin.configHandler, { type: 'status' })
  )), {
    ok: true,
    status: 'disconnected',
    handles: [],
    contacts: [],
    selectedSender: null,
  });
  const result = await invokeAction(plugin.actionHandler, {
    recipient: ' person@example.com ',
    text: ' exact text ',
  });
  assert.deepEqual(result, {
    ok: false,
    code: 'AUTH_REQUIRED',
    message: 'Configure iMessage first.',
  });
});

test('production bundle persists configured contact aliases without iMessage network activity', async function () {
  const plugin = load();
  const saved = await invokeConfig(plugin.configHandler, {
    type: 'saveContacts',
    contacts: [{ name: 'Danny', address: '+1 (510) 508-5455' }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    ok: true,
    status: 'disconnected',
    handles: [],
    contacts: [{ name: 'Danny', address: 'tel:+15105085455' }],
    selectedSender: null,
  });
  assert.equal(plugin.endpointDiscoveryAttempts(), 0);
  assert.equal(plugin.tlsOpenAttempts(), 0);
  assert.equal(JSON.stringify(plugin.values).includes('tel:+15105085455'), true);
});

test('production validation rejects groups, local phone numbers, empty text, and missing setup fields', async function () {
  const plugin = load();
  for (const args of [
    { recipient: 'a@example.com,b@example.com', text: 'Hi' },
    { recipient: '4155550123', text: 'Hi' },
    { recipient: 'a@example.com', text: '' },
  ]) {
    assert.equal((await invokeAction(plugin.actionHandler, args)).code, 'INVALID_ARGS');
  }
  const setup = await invokeConfig(plugin.configHandler, {
    type: 'configure', macValidationData: '', appleId: 'person@example.com', password: 'secret',
  });
  assert.equal(setup.ok, false);
  assert.equal(setup.code, 'INVALID_ARGS');
  assert.deepEqual(plugin.values, Object.create(null));
});

test('production configuration accepts hardware-only ExtractKey data before endpoint discovery', async function () {
  const plugin = load();
  const hardwareOnly = await invokeConfig(plugin.configHandler, {
    type: 'configure',
    macValidationData: macTokenWithoutBootstrap(),
    appleId: 'person@example.com',
    password: 'secret',
  });
  assert.equal(hardwareOnly.ok, false);
  assert.equal(hardwareOnly.code, 'PLUGIN_UNAVAILABLE');
  assert.equal(hardwareOnly.message, 'iMessage setup could not be completed.');
  assert.equal(plugin.endpointDiscoveryAttempts(), 0);
  assert.equal(plugin.tlsOpenAttempts(), 1);

  const malformed = await invokeConfig(plugin.configHandler, {
    type: 'configure',
    macValidationData: '{"unexpected":true}',
    appleId: 'person@example.com',
    password: 'secret',
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.code, 'INVALID_ARGS');
  assert.equal(malformed.message, 'The Mac + RustPush token is invalid.');
  assert.equal(plugin.endpointDiscoveryAttempts(), 0);
  assert.equal(plugin.tlsOpenAttempts(), 1);

  const incompleteToken = JSON.parse(macTokenWithoutBootstrap());
  delete incompleteToken.inner.romEnc;
  const incomplete = await invokeConfig(plugin.configHandler, {
    type: 'configure',
    macValidationData: JSON.stringify(incompleteToken),
    appleId: 'person@example.com',
    password: 'secret',
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'INVALID_ARGS');
  assert.equal(incomplete.message, 'This ExtractKey activation is incomplete. Export the full encrypted Mac hardware activation and try again.');
  assert.equal(plugin.endpointDiscoveryAttempts(), 0);
  assert.equal(plugin.tlsOpenAttempts(), 1);
  assert.deepEqual(plugin.values, Object.create(null));
});

test('production configuration aborts a stalled first HTTP request before the host deadline', async function () {
  const scheduled = [];
  const cancelled = [];
  let closeCount = 0;
  let openRequest;

  const plugin = load({
    HostTlsSocket: {
      open(request) { openRequest = JSON.parse(request); return 1; },
      write() {},
      close() { closeCount += 1; },
    },
    hostTimer: {
      schedule(delayMillis) { scheduled.push(delayMillis); return scheduled.length; },
      cancel(handle) { cancelled.push(handle); },
    },
  });
  const replies = [];
  plugin.configHandler({
    type: 'configure',
    macValidationData: macTokenWithoutBootstrap(),
    appleId: 'person@example.com',
    password: 'secret',
  }, function (reply) { replies.push(reply); });

  await new Promise(setImmediate);
  assert.deepEqual(scheduled, [20000]);
  assert.equal(openRequest.host, 'init.ess.apple.com');
  assert.deepEqual(openRequest.alpn, ['http/1.1']);
  assert.equal(openRequest.trustAnchors.length, 2);
  plugin.context.__hostTimerDispatch(1);
  await new Promise(setImmediate);
  assert.equal(closeCount, 1);
  assert.deepEqual(cancelled, [1]);
  assert.equal(replies.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(replies[0])), {
    ok: false,
    code: 'PLUGIN_UNAVAILABLE',
    message: 'iMessage setup could not be completed.',
    status: 'disconnected',
  });
  assert.equal(plugin.endpointDiscoveryAttempts(), 0);
  assert.deepEqual(plugin.values, Object.create(null));
  assert.deepEqual(plugin.traces, [
    ['[iMessage state]', 'configuration.ids-bag-start'],
    ['[iMessage state]', 'http.tls.opening'],
    ['[iMessage state]', 'http.tls.handle-opened'],
    ['[iMessage state]', 'http.tls.timeout'],
  ]);

  plugin.context.__hostTlsSocketDispatch(1, { type: 'data', data: 'bm90LWh0dHA=' });
  plugin.context.__hostTlsSocketDispatch(1, { type: 'close' });
  await new Promise(setImmediate);
  assert.equal(closeCount, 1);
  assert.equal(replies.length, 1);
});
