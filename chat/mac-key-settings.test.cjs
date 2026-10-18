const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMacKeyPicker } = require('./src/settings/mac-key');

function element(tag) {
  const result = { tag, children: [], value: '', append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }, setAttribute() {} };
  if (tag === 'textarea') Object.defineProperty(result, 'type', { get: () => 'textarea' });
  return result;
}
const key = { id: 'mac-1', computer_name: 'My Mac', created_at: '2026-09-17T01:02:03Z' };
function setup(keys, signedIn = true) {
  global.document = { createElement: element };
  const parent = element('div'), calls = [];
  const picker = renderMacKeyPicker(parent, {}, {
    invoke: async (method, args) => {
      calls.push({ method, args });
      if (method === 'imessage.activationKeys') return { signed_in: signedIn, account: 'pebble-one', keys };
      assert.equal(method, 'imessage.selectActivationKey');
      return { loaded: true };
    },
  });
  return { picker, parent, calls };
}

test('one saved Mac is automatically loaded, without exposing its key to the page', async () => {
  const f = setup([key]);
  assert.deepEqual(await f.picker.args(), { pebble_account: 'pebble-one', key_id: key.id });
  assert.match(f.parent.children[0].textContent, /My Mac · Key ready/);
  assert.equal(f.calls.length, 2);
});

test('multiple Macs require a choice and Advanced allows a manual setup key', async () => {
  const f = setup([key, { ...key, id: 'mac-2' }]);
  await assert.rejects(f.picker.args(), /Choose a saved Mac/);
  assert.equal(f.calls.length, 1);
  const select = f.parent.children[1].children[1];
  select.value = 'mac-2';
  await select.onchange();
  assert.deepEqual(await f.picker.args(), { pebble_account: 'pebble-one', key_id: 'mac-2' });
  const manual = f.parent.children[2].children[2];
  manual.value = 'manual-fixture-key';
  assert.deepEqual(await f.picker.args(), { macValidationData: 'manual-fixture-key' });
  f.picker.clear();
  assert.equal(manual.value, '');
});

test('missing keys and signed-out accounts show the appropriate next step', async () => {
  for (const signedIn of [true, false]) {
    const f = setup([], signedIn);
    await assert.rejects(f.picker.args(), /Choose a saved Mac/);
    assert.match(f.parent.children[0].textContent, signedIn ? /Open Pebble on your Mac/ : /Sign in to your Pebble account/);
    assert.equal(f.calls.length, 1);
  }
});

test('connected iMessage renders Disconnect even when the cloud key lookup fails', async () => {
  const { renderConnection } = require('./src/settings/connections');
  global.document = { createElement: element };
  const parent = element('div'), calls = [];
  renderConnection(parent, { id: 'imessage', enabled: true }, {
    ready: true, connected: true, account: 'apple-fixture', handles: ['tel:+15555550101'],
  }, {
    run: (_target, operation) => operation(),
    call: async (method, args) => {
      if (method === 'imessage.activationKeys') throw Error('Connection unavailable');
      calls.push({ method, args });
    },
    home: async () => calls.push({ method: 'home' }),
    notice() {},
  });
  const all = node => [node, ...node.children.flatMap(all)];
  const disconnect = all(parent).find(node => node.textContent === 'Disconnect…');
  assert.ok(disconnect);
  await disconnect.onclick();
  const confirm = all(parent).find(node => node.textContent === 'Disconnect');
  assert.equal(all(parent).find(node => node.children.includes(confirm)).hidden, false);
  await confirm.onclick();
  assert.deepEqual(calls, [
    { method: 'connections.delete', args: { connection: 'imessage', account: 'apple-fixture' } },
    { method: 'home' },
  ]);
});

test('each iMessage setup opening checks for a saved Mac automatically', async () => {
  global.document = { createElement: element };
  let saved = [], reads = 0;
  const invoke = async method => {
    if (method === 'imessage.activationKeys') { reads++; return { signed_in: true, account: 'pebble-one', keys: saved }; }
    return { loaded: true };
  };
  const first = renderMacKeyPicker(element('div'), {}, { invoke });
  await assert.rejects(first.args(), /Choose a saved Mac/);
  saved = [key];
  const parent = element('div');
  const reopened = renderMacKeyPicker(parent, {}, { invoke });
  assert.deepEqual(await reopened.args(), { pebble_account: 'pebble-one', key_id: key.id });
  assert.equal(reads, 2);
  assert.ok(!parent.children.some(node => node.tag === 'button'));
});

test('connection controls require sign-in across all connectors, including paused connections', async () => {
  const { renderConnection } = require('./src/settings/connections');
  global.document = { createElement: element };
  const all = node => [node, ...node.children.flatMap(all)];
  for (const id of ['beeper-ios', 'beeper-android', 'imessage', 'whatsapp', 'telegram', 'sms-android']) {
    for (const enabled of [true, false]) {
      for (const connected of [true, false]) {
        const parent = element('div'), calls = [];
        renderConnection(parent, { id, name: id, enabled }, {
          connected, ready: connected, verified: connected, account: connected ? 'fixture' : '', handles: [],
        }, {
          run: (_target, operation) => operation(),
          call: async (method, args) => { calls.push({ method, args }); return { signed_in: false, keys: [] }; },
          reload: async () => {},
        });
        const buttons = all(parent).filter(node => node.tag === 'button');
        assert.equal(buttons.some(node => node.textContent === 'Disconnect…'), connected, id);
        assert.equal(buttons.some(node => node.textContent === (enabled ? 'Pause' : 'Resume')), connected, id);
        if (!enabled && !connected) {
          await buttons.find(node => node.textContent === 'Connect ' + id).onclick();
          assert.deepEqual(calls, [{ method: 'connections.enable', args: { connection: id } }]);
        }
      }
    }
  }
});

test('an expired Apple verification can restart without signed-in connection controls', async () => {
  const { renderConnection } = require('./src/settings/connections');
  global.document = { createElement: element };
  const parent = element('div'), calls = [];
  renderConnection(parent, { id: 'imessage', enabled: true }, {
    connected: false, ready: false, account: '', imessage_phase: 'needsTwoFactor', can_submit_two_factor: false,
  }, {
    run: (_target, operation) => operation(),
    call: async (method, args) => calls.push({ method, args }),
    reload: async () => calls.push({ method: 'reload' }),
  });
  const all = node => [node, ...node.children.flatMap(all)];
  assert.ok(!all(parent).some(node => node.textContent === 'Disconnect…'));
  await all(parent).find(node => node.textContent === 'Start again').onclick();
  assert.deepEqual(calls, [
    { method: 'imessage.disconnect', args: { account: '', connection: 'imessage' } }, { method: 'reload' },
  ]);
});

test('revoked WhatsApp offers Reconnect before showing the phone form', async () => {
  const { renderConnection } = require('./src/settings/connections');
  global.document = { createElement: element };
  const parent = element('div');
  renderConnection(parent, { id: 'whatsapp', name: 'WhatsApp', enabled: true }, {
    connected: false, ready: false, needs_reconnect: true,
  }, { run: async (_, fn) => fn(), call: async () => ({}), reload: async () => {} });
  const flatten = e => [e, ...e.children.flatMap(flatten)];
  let elements = flatten(parent);
  assert.equal(elements.filter(e => e.tag === 'input').length, 0);
  const reconnect = elements.find(e => e.textContent === 'Reconnect WhatsApp');
  assert.ok(reconnect);
  await reconnect.onclick();
  elements = flatten(parent);
  assert.ok(elements.some(e => e.tag === 'input' && e.type === 'tel'));
  assert.ok(!elements.some(e => ['Pause', 'Disconnect…'].includes(e.textContent)));
});

test('WhatsApp phone inactivity is visible while the session remains usable', () => {
  const { renderConnection } = require('./src/settings/connections');
  global.document = { createElement: element };
  const parent = element('div');
  const warning = 'Open WhatsApp on your main phone to keep Pebble connected.';
  renderConnection(parent, { id: 'whatsapp', name: 'WhatsApp', enabled: true }, {
    connected: true, ready: true, connection_warning: warning,
  }, { run: async (_, fn) => fn(), call: async () => ({}), reload: async () => {} });
  const flatten = e => [e, ...e.children.flatMap(flatten)];
  assert.ok(flatten(parent).some(e => e.textContent === warning));
  assert.ok(flatten(parent).some(e => e.textContent === 'Connected'));
});
