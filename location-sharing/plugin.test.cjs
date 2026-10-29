const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const app = path.join(__dirname, 'pbw');
const source = fs.readFileSync(path.join(app, 'plugin.js'), 'utf8');
const appinfo = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).pebble;

function load() {
  const handlers = {};
  const forbidden = () => assert.fail('Status must not start authentication, emulation or networking');
  vm.runInNewContext(source, {
    Uint8Array, ArrayBuffer, DataView, Promise, Date, JSON, Math, BigInt, TextEncoder, TextDecoder, WebAssembly,
    console: { info() {} },
    Pebble: {
      registerSourceHandler: handler => handlers.source = handler,
      registerActionHandler: handler => handlers.action = handler,
      registerConfigHandler: handler => handlers.config = handler,
      secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
    },
    _HostCrypto: { request: forbidden }, _HostTimer: { schedule: forbidden, cancel() {} },
    WebSocket: forbidden, _HostTlsSocket: { open: forbidden, write: forbidden, close() {} }, fetch: forbidden,
  });
  return handlers;
}

test('bundle runs NAC inline in bundled Wasm without x86 or worker hosts', () => {
  assert.ok(!source.includes('_HostX86'));
  assert.ok(!source.includes('_HostJsWorker'));
  assert.ok(!appinfo.usesPermissions.includes('CpuEmulation'));
  assert.ok(!appinfo.usesPermissions.includes('JavaScriptWorker'));
});

test('status reports both providers disconnected without touching the host', async () => {
  const reply = await new Promise(resolve => load().config({ type: 'status' }, resolve));
  assert.equal(reply.ok, true);
  assert.equal(reply.apple.status, 'disconnected');
  assert.equal(reply.google.configured, false);
  assert.equal(reply.people.length, 0);
});

test('find_person without a connected provider asks for setup', async () => {
  let failure;
  await load().action({ action: 'find_person', args: { person: 'Danny' } }, {
    ok: () => assert.fail('no provider is connected'), error: (code, message) => failure = { code, message },
  });
  assert.equal(failure.code, 'AUTH_REQUIRED');
  assert.match(failure.message, /Location Sharing settings/);
});

test('bundle uses nothing stock CoreApp lacks', () => {
  for (const hostOnly of ['_HostTimer', '_HostTlsSocket', '_HostCrypto', 'macKeys']) {
    assert.ok(!source.includes(hostOnly), hostOnly);
  }
});
