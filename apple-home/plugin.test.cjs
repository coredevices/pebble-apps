const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, 'src', 'plugin', 'index.js'), 'utf8');
const manifest = require('./package.json').pebble.plugin;
function device(id, name, room = 'Kitchen', type = 'light') {
  return { id, name, accessoryName: name, room, roomId: room, type, reachable: true, cachedState: { power: false },
    stateFreshness: 'cached; use get_state for current readings', capabilities: ['power', 'brightness', 'hue', 'saturation', 'color_temperature', 'fan_speed', 'target_temperature', 'thermostat_mode', 'volume', 'muted', 'media_state', 'locked']
      .map(key => ({ id: id + key, key, writable: true })) };
}
function fixture(options = {}) {
  const catalogue = { home: { id: 'home1', name: 'Home' }, rooms: [{ id: 'Kitchen', name: 'Kitchen' }, { id: 'Bedroom', name: 'Bedroom' }],
    devices: [device('lamp1', 'Lamp'), device('lamp2', 'Lamp', 'Bedroom')], scenes: [{ id: 'night', name: 'Good Night', runnable: true }, { id: 'unlock', name: 'Arrive', runnable: false, blockedReason: 'Scene includes a lock' }], ...options.catalogue };
  const handlers = {}, calls = [], refreshed = [];
  const api = { async request(operation, args) {
    calls.push({ operation, args: JSON.parse(JSON.stringify(args)) });
    if (options.request) { const result = await options.request(operation, args); if (result !== undefined) return result; }
    if (operation === 'structure') return catalogue;
    if (operation === 'status') return { supported: true, authorization: 'authorized', ready: true };
    if (operation === 'getState') return { deviceId: args.deviceId, state: { power: { status: 'unavailable', error: 'Offline' } } };
    return { ok: true };
  } };
  vm.runInNewContext(script, { Pebble: { appleHome: options.unsupported ? undefined : api,
    registerSourceHandler: fn => handlers.source = fn, registerActionHandler: fn => handlers.action = fn,
    registerConfigHandler: fn => handlers.config = fn, refreshSources: keys => refreshed.push(...keys) }, Date, console });
  async function dispatch(kind, request) {
    let response, count = 0;
    const save = value => { response = JSON.parse(JSON.stringify(value)); count++; };
    await handlers[kind](request, kind === 'config' ? save : { data: save, ok: value => save({ ok: true, ...value }), error: (code, message) => save({ ok: false, code, message }) });
    assert.equal(count, 1, 'Every request must receive exactly one response');
    return response;
  }
  return { calls, refreshed, catalogue, action: (action, args = {}) => dispatch('action', { action, args }),
    source: item => dispatch('source', { category: 'home', item }), config: message => dispatch('config', message) };
}
test('bundle declares only native HomeKit permission and all handlers', async () => {
  assert.equal(manifest.uuid, require('./package.json').pebble.uuid);
  assert.equal(manifest.actions.length, 15);
  for (const declaration of [...manifest.sources, ...manifest.actions]) {
    assert.deepEqual(declaration.usesPermissions, [{ name: 'AppleHome', parameters: {} }]);
    assert.deepEqual(declaration.callerPermissions, []);
  }
  for (const action of manifest.actions) assert.equal(action.requiresConfirmation, false);
});
test('discovery preserves service IDs and explicitly labels cached values', async () => {
  const f = fixture();
  const response = await f.source('device');
  assert.equal(response.instances[0].instanceId, 'lamp1');
  assert.match(response.instances[0].properties.freshness.shortText.text, /cached/);
  assert.equal(f.calls[0].operation, 'structure');
  assert.equal(f.calls.length, 1);
});
test('all discovery sources and unknown source', async () => {
  const f = fixture();
  for (const item of ['home', 'room', 'device', 'scene', 'automation']) assert.ok((await f.source(item)).instances.length);
  assert.equal((await f.source('unknown')).code, 'INVALID_REQUEST');
});
test('unsupported platform returns a useful error', async () => {
  const f = fixture({ unsupported: true });
  assert.equal((await f.source('home')).code, 'PLUGIN_UNAVAILABLE');
  assert.equal((await f.action('turn_on', { instanceId: 'lamp1' })).code, 'PLUGIN_UNAVAILABLE');
});
test('ambiguous names never choose an arbitrary device', async () => {
  const f = fixture();
  assert.equal((await f.action('turn_on', { device: 'Lamp' })).code, 'INVALID_ARGS');
  assert.equal(f.calls.filter(c => c.operation === 'control').length, 0);
  assert.equal((await f.action('turn_on', { device: 'lamp', room: 'Kitchen' })).ok, true);
  assert.equal(f.calls.at(-1).args.deviceId, 'lamp1');
});
test('exact service IDs and accessory names are supported without fuzzy matching', async () => {
  const f = fixture();
  assert.equal((await f.action('turn_on', { instanceId: 'LAMP1' })).ok, true);
  assert.equal((await f.action('turn_on', { device: 'Lam' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('turn_on', { instanceId: 'lamp1', device: 'Lamp' })).code, 'INVALID_ARGS');
  f.catalogue.devices[0].name = 'Outlet';
  assert.equal((await f.action('turn_on', { device: 'Lamp', room: 'Kitchen' })).ok, true);
});
test('multi-service accessories resolve only an unambiguous writable capability', async () => {
  const first = device('power', 'Switch'), second = device('sensor', 'Temperature');
  first.accessoryName = second.accessoryName = 'Combo'; second.capabilities = [{ key: 'current_temperature', writable: false }];
  const f = fixture({ catalogue: { devices: [first, second] } });
  assert.equal((await f.action('turn_on', { device: 'Combo' })).ok, true);
  assert.equal(f.calls.at(-1).args.deviceId, 'power');
  assert.equal((await f.action('get_state', { device: 'Combo' })).code, 'INVALID_ARGS');
});
test('selected home and room restrictions fail closed', async () => {
  const f = fixture();
  for (const args of [{ instanceId: 'lamp1', home: 'Other home' }, { instanceId: 'lamp1', room: 'Bedroom' }, { device: 'Lamp', room: 'Missing' }]) {
    assert.equal((await f.action('turn_off', args)).code, 'INVALID_ARGS');
  }
  f.catalogue.rooms.push({ id: 'kitchen2', name: 'Kitchen' });
  f.catalogue.rooms[0].id = 'kitchen1';
  assert.equal((await f.action('turn_off', { device: 'Lamp', room: 'Kitchen' })).code, 'INVALID_ARGS');
  assert.equal(f.calls.filter(c => c.operation === 'control').length, 0);
});
test('group control requires explicit all, room, and type and preflights every target', async () => {
  const f = fixture({ catalogue: { devices: [device('a', 'A'), device('b', 'B')] } });
  for (const args of [{ room: 'Kitchen' }, { all: true, room: 'Kitchen' }, { all: true, device_type: 'light' }]) {
    assert.equal((await f.action('turn_off', args)).code, 'INVALID_ARGS');
  }
  assert.equal((await f.action('turn_off', { all: true, room: 'Kitchen', device_type: 'light' })).ok, true);
  assert.deepEqual(f.calls.slice(-4).map(c => c.operation), ['validateControl', 'validateControl', 'control', 'control']);
});
test('group preflight or offline target prevents all writes', async () => {
  const f = fixture({ catalogue: { devices: [device('a', 'A'), device('b', 'B')] }, request: (op, args) => {
    if (op === 'validateControl' && args.deviceId === 'b') throw Object.assign(Error('Bad device range'), { code: 'INVALID_ARGS' });
  } });
  assert.equal((await f.action('set_brightness', { all: true, room: 'Kitchen', device_type: 'light', brightness: 50 })).code, 'INVALID_ARGS');
  assert.equal(f.calls.filter(c => c.operation === 'control').length, 0);
  f.catalogue.devices[1].reachable = false;
  assert.equal((await f.action('turn_on', { all: true, room: 'Kitchen', device_type: 'light' })).code, 'PLUGIN_UNAVAILABLE');
});
test('group partial failures stop subsequent writes and never retry', async () => {
  const f = fixture({ catalogue: { devices: [device('a', 'A'), device('b', 'B'), device('c', 'C')] }, request: (op, args) => {
    if (op === 'control' && args.deviceId === 'b') return { ok: false, code: 'TIMEOUT', message: 'Outcome unknown. Read state before retrying.' };
  } });
  const result = await f.action('turn_on', { all: true, room: 'Kitchen', device_type: 'light' });
  assert.equal(result.code, 'TIMEOUT'); assert.match(result.message, /1 earlier device/);
  assert.deepEqual(f.calls.filter(c => c.operation === 'control').map(c => c.args.deviceId), ['a', 'b']);
});
test('rejects malformed control values and unknown arguments before native writes', async () => {
  const f = fixture();
  for (const brightness of ['50', true, null, -1, 101, Infinity, NaN]) {
    assert.equal((await f.action('set_brightness', { instanceId: 'lamp1', brightness })).code, 'INVALID_ARGS');
  }
  assert.equal((await f.action('turn_on', { instanceId: 'lamp1', unknown: 1 })).code, 'INVALID_ARGS');
  assert.equal((await f.action('turn_on', { instanceId: 'lamp1', all: 'false' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('unlock', { instanceId: 'lamp1', all: true })).code, 'INVALID_ARGS');
  assert.equal(f.calls.filter(c => c.operation === 'control').length, 0);
});
test('thermostat requires explicit unit and maps high-level controls', async () => {
  const f = fixture();
  assert.equal((await f.action('set_thermostat', { instanceId: 'lamp1', temperature: 68 })).code, 'INVALID_ARGS');
  assert.equal((await f.action('set_thermostat', { instanceId: 'lamp1', unit: 'fahrenheit' })).code, 'INVALID_ARGS');
  const result = await f.action('set_thermostat', { instanceId: 'lamp1', temperature: 68, unit: 'fahrenheit', mode: 'heat' });
  assert.equal(result.ok, true);
  assert.deepEqual(f.calls.at(-1).args, { deviceId: 'lamp1', values: { target_temperature: 68, thermostat_mode: 'heat' }, temperatureUnit: 'fahrenheit' });
});
test('all ordinary controls map to native values without implicit power changes', async () => {
  const f = fixture();
  for (const [action, args, expected] of [
    ['set_brightness', { brightness: 20 }, { brightness: 20 }], ['set_color', { hue: 100, saturation: 50 }, { hue: 100, saturation: 50 }],
    ['set_color_temperature', { mireds: 250 }, { color_temperature: 250 }], ['set_fan_speed', { speed: 25 }, { fan_speed: 25 }],
  ]) {
    assert.equal((await f.action(action, { instanceId: 'lamp1', ...args })).ok, true);
    assert.deepEqual(f.calls.at(-1).args.values, expected);
  }
});
test('state reads retain unavailable fields rather than substituting cached values', async () => {
  const f = fixture();
  const result = await f.action('get_state', { instanceId: 'lamp1' });
  assert.equal(result.data.state.power.status, 'unavailable');
  assert.equal(result.data.state.power.value, undefined);
  assert.equal(f.calls.filter(c => c.operation === 'control').length, 0);
});
test('blocked, duplicate, or missing scenes never run', async () => {
  const f = fixture();
  assert.equal((await f.action('run_scene', { scene: 'Arrive' })).code, 'PERMISSION_DENIED');
  assert.equal((await f.action('run_scene', { scene: 'Missing' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('run_scene', { scene: 'Good Night', instanceId: 'night' })).code, 'INVALID_ARGS');
  f.catalogue.scenes.push({ id: 'night2', name: 'Good Night', runnable: true });
  assert.equal((await f.action('run_scene', { scene: 'Good Night' })).code, 'INVALID_ARGS');
  assert.equal(f.calls.filter(c => c.operation === 'runScene').length, 0);
  assert.equal((await f.action('run_scene', { instanceId: 'night' })).ok, true);
});
test('native scene rejection after discovery is preserved', async () => {
  const f = fixture({ request: op => op === 'runScene' ? { ok: false, code: 'PERMISSION_DENIED', message: 'Scene now contains a lock' } : undefined });
  assert.equal((await f.action('run_scene', { scene: 'Good Night' })).code, 'PERMISSION_DENIED');
  assert.equal(f.calls.filter(c => c.operation === 'runScene').length, 1);
});
test('ordinary reads and actions never request access or change setup', async () => {
  const f = fixture();
  await f.source('home'); await f.action('turn_on', { instanceId: 'lamp1' });
  assert.equal(f.calls.some(c => ['requestAccess', 'selectHome', 'disconnect'].includes(c.operation)), false);
  await f.config({ type: 'selectHome', homeId: 'new-home' });
  assert.deepEqual(f.calls.at(-1), { operation: 'selectHome', args: { homeId: 'new-home' } });
  assert.equal(f.refreshed.length, 5);
  assert.match((await f.config({ type: 'control' })).error, /Unknown/);
});

test('Google Home argument aliases preserve exact selection and reject conflicting inputs', async () => {
  const f = fixture();
  assert.equal((await f.action('set_brightness', { name: 'Lamp', room: 'Kitchen', brightness_pct: 35 })).ok, true);
  assert.deepEqual(f.calls.at(-1).args.values, { brightness: 35 });
  assert.equal((await f.action('set_brightness', { name: 'Lamp', device: 'Lamp', brightness: 35 })).code, 'INVALID_ARGS');
  assert.equal((await f.action('set_brightness', { instanceId: 'lamp1', brightness_pct: 35, brightness: 40 })).code, 'INVALID_ARGS');
  assert.equal((await f.action('set_thermostat', { instanceId: 'lamp1', temperature_f: 68 })).ok, true);
  assert.equal(f.calls.at(-1).args.temperatureUnit, 'fahrenheit');
  assert.equal((await f.action('set_thermostat', { instanceId: 'lamp1', temperature_c: 20, temperature_f: 68 })).code, 'INVALID_ARGS');
});
test('Kelvin converts to integral mireds without accepting conflicting units', async () => {
  const f = fixture();
  assert.equal((await f.action('set_color_temperature', { instanceId: 'lamp1', kelvin: 2700 })).ok, true);
  assert.deepEqual(f.calls.at(-1).args.values, { color_temperature: 370 });
  for (const args of [{ kelvin: 0 }, { kelvin: '2700' }, { kelvin: 4000, mireds: 250 }, {}]) {
    assert.equal((await f.action('set_color_temperature', { instanceId: 'lamp1', ...args })).code, 'INVALID_ARGS');
  }
});
test('speaker, media, and single-lock actions use capability-specific native values', async () => {
  const f = fixture();
  for (const [action, args, values] of [
    ['set_volume', { volume_pct: 30 }, { volume: 30 }], ['set_muted', { muted: true }, { muted: true }],
    ['media_control', { command: 'pause' }, { media_state: 'pause' }],
    ['lock', {}, { locked: true }], ['unlock', {}, { locked: false }],
  ]) {
    assert.equal((await f.action(action, { instanceId: 'lamp1', ...args })).ok, true);
    assert.deepEqual(f.calls.at(-1).args.values, values);
  }
  assert.equal((await f.action('set_muted', { instanceId: 'lamp1', muted: 'false' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('media_control', { instanceId: 'lamp1', command: 'next' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('unlock', { all: true, room: 'Kitchen', device_type: 'lock' })).code, 'INVALID_ARGS');
});
test('confirmed controls describe the action and requested values in the feed', async () => {
  const f = fixture({ catalogue: { devices: [device('qa', 'QA Device')] } });
  for (const [action, args, text] of [
    ['lock', {}, 'Locked QA Device.'],
    ['unlock', {}, 'Unlocked QA Device.'],
    ['turn_on', {}, 'Turned on QA Device.'],
    ['turn_off', {}, 'Turned off QA Device.'],
    ['set_brightness', { brightness_pct: 58 }, 'Set QA Device brightness to 58%.'],
    ['set_color', { hue: 210, saturation: 65 }, 'Set QA Device color to hue 210° and 65% saturation.'],
    ['set_color_temperature', { kelvin: 4000 }, 'Set QA Device color temperature to 4000 K.'],
    ['set_color_temperature', { mireds: 300 }, 'Set QA Device color temperature to 300 mireds.'],
    ['set_fan_speed', { speed: 60 }, 'Set QA Device fan speed to 60%.'],
    ['set_volume', { volume_pct: 0 }, 'Set QA Device volume to 0%.'],
    ['set_muted', { muted: true }, 'Muted QA Device.'],
    ['set_muted', { muted: false }, 'Unmuted QA Device.'],
    ['media_control', { command: 'play' }, 'Started playback on QA Device.'],
    ['media_control', { command: 'pause' }, 'Paused playback on QA Device.'],
    ['media_control', { command: 'stop' }, 'Stopped playback on QA Device.'],
    ['set_thermostat', { temperature_c: 22, mode: 'heat' }, 'Set QA Device to 22°C in heat mode.'],
    ['set_thermostat', { temperature_f: 71.6 }, 'Set QA Device to 71.6°F.'],
    ['set_thermostat', { mode: 'off' }, 'Set QA Device to off mode.'],
  ]) {
    const result = await f.action(action, { instanceId: 'qa', ...args });
    assert.equal(result.ok, true, action);
    assert.equal(result.text, text, action);
  }
});
test('group summaries name the confirmed targets and failures never report success', async () => {
  const f = fixture({ catalogue: { devices: [device('a', 'Lamp A'), device('b', 'Lamp B')] } });
  const result = await f.action('turn_off', { all: true, room: 'Kitchen', device_type: 'light' });
  assert.equal(result.text, 'Turned off Lamp A, Lamp B.');
  const rejected = fixture({ request: op => op === 'control' ? { ok: false, code: 'AUTH_REQUIRED', message: 'Authentication cancelled' } : undefined });
  const cancelled = await rejected.action('unlock', { instanceId: 'lamp1' });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.text, undefined);
  assert.match(cancelled.message, /Authentication cancelled/);
});
test('automation alias resolves only inspected runnable scenes', async () => {
  const f = fixture();
  assert.equal((await f.action('run_automation', { name: 'Good Night' })).ok, true);
  assert.equal(f.calls.at(-1).operation, 'runScene');
  assert.equal((await f.action('run_automation', { name: 'Arrive' })).code, 'PERMISSION_DENIED');
});
test('automatic triggers expose starters and actions but cannot run manually', async () => {
  const f = fixture();
  const trigger = { id: 'timer', name: 'Scheduled Lights', kind: 'trigger', enabled: false, runnable: false,
    blockedReason: 'HomeKit scheduled and event automations cannot be started manually',
    starters: [{ type: 'timer', fireDateMs: 100000 }], actions: [{ type: 'characteristic_write', deviceId: 'lamp1', targetValue: 1 }],
    scenes: [{ id: 'night', name: 'Good Night' }], hasConditions: true, endEventCount: 0, executeOnce: false };
  f.catalogue.automations = [...f.catalogue.scenes, trigger];
  const instances = (await f.source('automation')).instances;
  const properties = instances.find(item => item.instanceId === 'timer').properties;
  assert.equal(properties.enabled.boolean.value, false);
  assert.equal(properties.manually_runnable.boolean.value, false);
  assert.deepEqual(JSON.parse(properties.starters.longText.text), trigger.starters);
  assert.deepEqual(JSON.parse(properties.actions.longText.text), trigger.actions);
  assert.deepEqual(JSON.parse(properties.trigger_details.longText.text), {
    scenes: trigger.scenes, hasConditions: true, endEventCount: 0, executeOnce: false,
  });
  assert.equal((await f.source('scene')).instances.length, 2);
  assert.equal((await f.action('run_automation', { name: trigger.name })).code, 'PERMISSION_DENIED');
  assert.equal((await f.action('run_automation', { instanceId: trigger.id })).code, 'PERMISSION_DENIED');
  assert.equal(f.calls.filter(call => call.operation === 'runScene').length, 0);
});
test('automation and scene name collisions require an exact ID', async () => {
  const f = fixture();
  f.catalogue.automations = [...f.catalogue.scenes, { id: 'timer', name: 'Good Night', kind: 'trigger', runnable: false }];
  assert.equal((await f.action('run_automation', { name: 'Good Night' })).code, 'INVALID_ARGS');
  assert.equal((await f.action('run_automation', { instanceId: 'night' })).ok, true);
  assert.equal((await f.action('run_scene', { name: 'Good Night' })).ok, true);
});
test('typed discovery values retain cached freshness and current lock state', async () => {
  const lamp = device('x', 'X'); lamp.cachedState = { power: true, brightness: 37, color_temperature: 250, current_temperature: 22, volume: 30, muted: false, lock_state: 0, locked: true, media_state: 'play', current_media_state: 'pause' };
  const response = await fixture({ catalogue: { devices: [lamp] } }).source('device');
  const values = response.instances[0].properties;
  assert.equal(values.on.boolean.value, true);
  assert.equal(values.brightness.numericValue.value, 37);
  assert.equal(values.color_temperature.numericValue.value, 4000);
  assert.equal(values.locked.boolean.value, false);
  assert.equal(values.media_state.shortText.text, 'pause');
  assert.match(values.freshness.shortText.text, /cached/);
});
