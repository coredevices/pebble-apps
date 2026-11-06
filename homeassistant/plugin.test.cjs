// Runs the plugin script against a fake Home Assistant: fetch is stubbed, and the handlers the
// script registers are called the way the host calls them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LOCAL = 'http://homeassistant.local:8123';
const REMOTE = 'https://abc.ui.nabu.casa';
const DUCK = 'https://myhome.duckdns.org:8123';
const TOKEN = 'secret-token';

function entity(id, state, attributes) {
  return { entity_id: id, state, attributes: attributes || {} };
}

function fakeHome() {
  return {
    states: [
      entity('light.sofa', 'on', { friendly_name: 'Sofa Lamp', brightness: 128, color_temp_kelvin: 2700, supported_color_modes: ['color_temp'] }),
      entity('light.ceiling', 'off', { friendly_name: 'Living Ceiling', supported_color_modes: ['hs'] }),
      entity('light.bed', 'on', { friendly_name: 'Bedside', brightness: 255 }),
      entity('light.porch', 'unavailable', { friendly_name: 'Porch' }),
      entity('switch.kettle', 'off', { friendly_name: 'Kettle', device_class: 'outlet' }),
      entity('media_player.kitchen', 'playing', { friendly_name: 'Kitchen Speaker', volume_level: 0.35, is_volume_muted: false, media_title: 'Song', media_artist: 'Band' }),
      entity('climate.hall', 'heat', { friendly_name: 'Hall', temperature: 20, current_temperature: 19.5 }),
      entity('lock.front', 'locked', { friendly_name: 'Front Door' }),
      entity('cover.blinds', 'closed', { friendly_name: 'Living Blinds', current_position: 0 }),
      entity('sensor.temp', '21.37', { friendly_name: 'Living Temperature', unit_of_measurement: '°C', device_class: 'temperature' }),
      entity('sensor.weather', 'sunny', { friendly_name: 'Forecast' }),
      entity('scene.movie', '2026-11-01T20:00:00+00:00', { friendly_name: 'Movie Night' }),
      entity('script.good_night', 'off', { friendly_name: 'Good Night' }),
      entity('automation.morning', 'on', { friendly_name: 'Morning', last_triggered: '2026-11-05T07:00:00+00:00' }),
      entity('light.attic', 'on', { friendly_name: 'Attic', brightness: 255 }),
    ],
    areas: [
      { id: 'living_room', name: 'Living Room', entities: ['light.sofa', 'light.ceiling', 'cover.blinds', 'sensor.temp'] },
      { id: 'bedroom', name: 'Bedroom', entities: ['light.bed'] },
      { id: 'kitchen', name: 'Kitchen', entities: ['switch.kettle', 'media_player.kitchen'] },
      { id: 'attic', name: 'Attic', entities: ['light.attic'] },
    ],
  };
}

// `permissions`: the app's answers to Pebble.permissions.query, by key; a key that isn't
// 'granted' refuses the request the way the app's network gate does. Without it, no
// Pebble.permissions at all, as in older apps.
function load({ unreachable = [], home = fakeHome(), permissions = null } = {}) {
  const store = {};
  const secrets = {};
  const calls = [];
  const handlers = {};
  const refreshed = [];
  const requested = [];

  async function fetch(url, init) {
    const base = [LOCAL, REMOTE, DUCK].find((b) => url.startsWith(b));
    if (!base || unreachable.includes(base)) throw new Error('network error');
    const key = base === LOCAL ? 'LocalNetwork' : 'Internet/' + new URL(base).hostname;
    if (permissions && permissions[key] !== 'granted') {
      requested.push(key);
      throw new Error('network error');
    }
    const reply = (status, body) => ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    });
    if (init.headers.Authorization !== 'Bearer ' + TOKEN) return reply(401, '401: Unauthorized');
    const route = url.slice(base.length);
    calls.push({ base, route, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (route === '/api/states') return reply(200, home.states);
    if (route === '/api/config') return reply(200, { location_name: 'Home', version: '2026.11.0', unit_system: { temperature: '°C' } });
    if (route === '/api/template') return reply(200, JSON.stringify(home.areas));
    if (route.startsWith('/api/services/')) return reply(200, []);
    return reply(404, 'not found');
  }

  const context = {
    console: { log() {}, info() {}, warn() {}, error() {} },
    fetch,
    Date, JSON, Math, Promise, Object, Array, String, Number, Error, isFinite, isNaN,
    localStorage: {
      getItem: (key) => (key in store ? store[key] : null),
      setItem: (key, value) => { store[key] = String(value); },
      removeItem: (key) => { delete store[key]; },
    },
    Pebble: {
      secureStorage: {
        getItem: async (key) => (key in secrets ? secrets[key] : null),
        setItem: async (key, value) => { secrets[key] = value; },
        removeItem: async (key) => { delete secrets[key]; },
      },
      registerSourceHandler: (fn) => { handlers.source = fn; },
      registerActionHandler: (fn) => { handlers.action = fn; },
      registerConfigHandler: (fn) => { handlers.config = fn; },
      refreshSources: (list) => refreshed.push(list),
      permissions: permissions && { query: async (key) => permissions[key] || 'prompt' },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'src/plugin/index.js'), 'utf8'), context);

  const source = (item) => new Promise((resolve) => handlers.source({ category: 'home', item }, {
    data: (data) => resolve({ ok: true, data }),
    error: (code, message) => resolve({ ok: false, code, message }),
  }));
  const action = (name, args) => new Promise((resolve) => handlers.action({ action: name, args }, {
    ok: (result) => resolve({ ok: true, ...result }),
    error: (code, message) => resolve({ ok: false, code, message }),
  }));
  const config = (message) => new Promise((resolve) => handlers.config(message, resolve));
  const services = () => calls.filter((c) => c.route.startsWith('/api/services/')).map((c) => ({ service: c.route.slice('/api/services/'.length), body: c.body }));
  const byId = (instances) => Object.fromEntries(instances.map((i) => [i.instanceId, i.properties]));

  return { context, store, secrets, calls, refreshed, requested, permissions, source, action, config, services, byId };
}

async function connected(options) {
  const plugin = load(options);
  const result = await plugin.config({ type: 'connect', localUrl: 'homeassistant.local:8123/lovelace/0', remoteUrl: REMOTE + '/', token: TOKEN });
  assert.ok(result.ok, JSON.stringify(result));
  plugin.calls.length = 0;
  return plugin;
}

test('not set up reads as AUTH_REQUIRED', async () => {
  const plugin = load();
  const result = await plugin.source('light');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'AUTH_REQUIRED');
});

test('connect normalizes the addresses, checks both and keeps the token secret', async () => {
  const plugin = load();
  const result = await plugin.config({ type: 'connect', localUrl: 'homeassistant.local:8123/lovelace/0', remoteUrl: REMOTE + '/', token: ' ' + TOKEN + ' ' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.name, 'Home');
  assert.deepStrictEqual(Array.from(result.checked, (c) => c.ok), [true, true]);
  assert.strictEqual(plugin.secrets.ha_token, TOKEN);
  const saved = JSON.parse(plugin.store.homeassistant);
  assert.strictEqual(saved.localUrl, LOCAL);
  assert.strictEqual(saved.remoteUrl, REMOTE);
  assert.ok(!plugin.store.homeassistant.includes(TOKEN));
  const status = await plugin.config({ type: 'status' });
  assert.deepStrictEqual({ ...status, waiting: Array.from(status.waiting) }, { localUrl: LOCAL, remoteUrl: REMOTE, hasToken: true, waiting: [] });
});

test('a wrong token is reported and not saved', async () => {
  const plugin = load();
  const result = await plugin.config({ type: 'connect', localUrl: LOCAL, token: 'nope' });
  assert.match(result.error, /rejected the access token/);
  assert.strictEqual(plugin.secrets.ha_token, undefined);
});

test('lights, rooms and the home read like the Hue plugin', async () => {
  const plugin = await connected();
  const lights = plugin.byId((await plugin.source('light')).data.instances);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(lights['light.sofa'])), {
    name: { shortText: { text: 'Sofa Lamp' } },
    on: { boolean: { value: true }, shortText: { text: 'On' } },
    brightness: { numericValue: { value: 50, unit: '%', min: 0, max: 100 }, shortText: { text: '50%' } },
  });
  assert.strictEqual(lights['light.porch'].on.shortText.text, '--');

  const rooms = plugin.byId((await plugin.source('room_lights')).data.instances);
  assert.deepStrictEqual(Object.keys(rooms).sort(), ['attic', 'bedroom', 'living_room']);
  assert.strictEqual(rooms.living_room.name.shortText.text, 'Living Room');
  assert.strictEqual(rooms.living_room.brightness.numericValue.value, 50);

  const home = (await plugin.source('home_lights')).data.instances;
  assert.strictEqual(home.length, 1);
  assert.strictEqual(home[0].instanceId, 'home');
  // Sofa 50%, bed 100%, attic 100%.
  assert.strictEqual(home[0].properties.brightness.numericValue.value, 83);
});

test('devices read like the Google Home plugin', async () => {
  const plugin = await connected();
  const devices = plugin.byId((await plugin.source('device')).data.instances);
  assert.ok(!devices['sensor.temp'] && !devices['scene.movie']);
  assert.strictEqual(devices['switch.kettle'].type.shortText.text, 'outlet');
  assert.strictEqual(devices['switch.kettle'].room.shortText.text, 'Kitchen');
  assert.strictEqual(devices['media_player.kitchen'].volume.numericValue.value, 35);
  assert.strictEqual(devices['media_player.kitchen'].media_title.longText.text, 'Song – Band');
  assert.strictEqual(devices['climate.hall'].setpoint.shortText.text, '20°C');
  assert.strictEqual(devices['climate.hall'].room.shortText.text, 'Unassigned');
  assert.strictEqual(devices['lock.front'].locked.boolean.value, true);
  assert.strictEqual(devices['lock.front'].on, undefined);
  assert.strictEqual(devices['cover.blinds'].on.boolean.value, false);
});

test('automations and sensors', async () => {
  const plugin = await connected();
  const automations = plugin.byId((await plugin.source('automation')).data.instances);
  assert.deepStrictEqual(Object.keys(automations).sort(), ['automation.morning', 'scene.movie', 'script.good_night']);
  assert.strictEqual(automations['automation.morning'].last_run.timestamp.value, Date.parse('2026-11-05T07:00:00Z') / 1000);
  const sensors = plugin.byId((await plugin.source('sensor')).data.instances);
  assert.deepStrictEqual(Object.keys(sensors), ['sensor.temp', 'sensor.weather']);
  assert.strictEqual(sensors['sensor.temp'].value.shortText.text, '21.4°C');
  assert.strictEqual(sensors['sensor.temp'].value.numericValue.value, 21.37);
  assert.strictEqual(sensors['sensor.temp'].room.shortText.text, 'Living Room');
  assert.strictEqual(sensors['sensor.weather'].value.longText.text, 'sunny');
});

test('a door sensor reports open or closed, next to its battery and voltage', async () => {
  const home = fakeHome();
  home.states.push(
    entity('binary_sensor.myggbett_door', 'off', { friendly_name: 'MYGGBETT door/window sensor', device_class: 'door' }),
    entity('sensor.myggbett_battery', '87', { friendly_name: 'MYGGBETT door/window sensor Battery', unit_of_measurement: '%', device_class: 'battery' }),
    entity('sensor.myggbett_voltage', '2.9', { friendly_name: 'MYGGBETT door/window sensor Voltage', unit_of_measurement: 'V', device_class: 'voltage' }),
    entity('binary_sensor.hall_motion', 'on', { friendly_name: 'Hall Motion', device_class: 'motion' }),
    entity('binary_sensor.leak', 'unavailable', { friendly_name: 'Leak', device_class: 'moisture' }),
    entity('binary_sensor.thing', 'on', { friendly_name: 'Thing' }),
    entity('sensor.last_boot', '2026-11-06T08:00:00+00:00', { friendly_name: 'Last Boot', device_class: 'timestamp' }),
  );
  const plugin = await connected({ home });
  const sensors = JSON.parse(JSON.stringify(plugin.byId((await plugin.source('sensor')).data.instances)));
  assert.deepStrictEqual(sensors['binary_sensor.myggbett_door'], {
    name: { shortText: { text: 'MYGGBETT door/window sensor' } },
    room: { shortText: { text: 'Unassigned' } },
    value: { boolean: { value: false }, shortText: { text: 'Closed' }, longText: { text: 'Closed' } },
    kind: { shortText: { text: 'door' } },
  });
  assert.strictEqual(sensors['sensor.myggbett_battery'].value.shortText.text, '87%');
  assert.strictEqual(sensors['binary_sensor.hall_motion'].value.shortText.text, 'Detected');
  assert.strictEqual(sensors['binary_sensor.leak'].value.longText.text, 'Unavailable');
  assert.strictEqual(sensors['binary_sensor.thing'].value.shortText.text, 'On');
  assert.strictEqual(sensors['binary_sensor.thing'].kind.shortText.text, 'binary');
  assert.strictEqual(sensors['sensor.last_boot'].value.timestamp.value, Date.parse('2026-11-06T08:00:00Z') / 1000);
});

test('a hidden room disappears everywhere', async () => {
  const plugin = await connected();
  await plugin.config({ type: 'setHidden', id: 'attic', hidden: true });
  const rooms = plugin.byId((await plugin.source('room_lights')).data.instances);
  assert.ok(!rooms.attic);
  const lights = plugin.byId((await plugin.source('light')).data.instances);
  assert.ok(!lights['light.attic']);
  const result = await plugin.action('set_on', { name: 'attic', on: false });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'INVALID_ARGS');
  const areas = await plugin.config({ type: 'areas' });
  assert.strictEqual(areas.areas.find((a) => a.id === 'attic').hidden, true);
});

test('a room tile turns its lights off', async () => {
  const plugin = await connected();
  const result = await plugin.action('set_on', { item: 'room_lights', instanceId: 'living_room', on: false });
  assert.ok(result.ok, result.message);
  assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_off', body: { entity_id: ['light.sofa', 'light.ceiling'] } }]);
});

test('toggle on a room turns it off when any light is on', async () => {
  const plugin = await connected();
  await plugin.action('toggle', { item: 'room_lights', instanceId: 'living_room' });
  assert.strictEqual(plugin.services()[0].service, 'light/turn_off');
  plugin.calls.length = 0;
  await plugin.action('toggle', { item: 'device', instanceId: 'switch.kettle' });
  assert.deepStrictEqual(plugin.services(), [{ service: 'switch/turn_on', body: { entity_id: ['switch.kettle'] } }]);
});

test('a room alone switches everything in it; with type light, only its lights', async () => {
  const plugin = await connected();
  const result = await plugin.action('set_on', { room: 'living room', on: true });
  assert.strictEqual(result.text, 'Turned on 3 devices.');
  assert.deepStrictEqual(plugin.services().map((s) => s.service).sort(), ['cover/open_cover', 'light/turn_on']);
  plugin.calls.length = 0;
  await plugin.action('set_on', { room: 'living room', type: 'light', on: true });
  assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_on', body: { entity_id: ['light.sofa', 'light.ceiling'] } }]);
});

// Every way "turn the lights on" can arrive must reach lights and nothing else.
for (const [label, args] of [
  ['type light', { type: 'light' }],
  ['type lights', { type: 'lights' }],
  ['name "lights"', { name: 'lights' }],
  ['name "the lights"', { name: 'the lights' }],
  ['the home_lights instance', { item: 'home_lights', instanceId: 'home' }],
  ['instanceId "home" alone', { instanceId: 'home' }],
  ['instanceId "home" with item device', { item: 'device', instanceId: 'home' }],
  ['instanceId "home" with item light', { item: 'light', instanceId: 'home' }],
]) {
  test(`"turn the lights on" as ${label} switches only lights`, async () => {
    const plugin = await connected();
    const result = await plugin.action('set_on', { ...args, on: true });
    assert.ok(result.ok, result.message);
    assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_on', body: { entity_id: ['light.sofa', 'light.ceiling', 'light.bed', 'light.porch', 'light.attic'] } }]);
  });
}

test('lights in a room, however they are named', async () => {
  const plugin = await connected();
  await plugin.action('set_on', { room: 'living room', name: 'lights', on: false });
  await plugin.action('toggle', { item: 'room_lights', instanceId: 'living_room' });
  assert.deepStrictEqual(plugin.services().map((s) => s.body.entity_id.join()), ['light.sofa,light.ceiling', 'light.sofa,light.ceiling']);
});

// However a room_lights call names the room, it reaches the room's lights and nothing else.
for (const [label, args] of [
  ['its area id', { item: 'room_lights', instanceId: 'living_room' }],
  ['its name as instanceId', { item: 'room_lights', instanceId: 'Living Room' }],
  ['a room selector', { item: 'room_lights', room: 'Living Room' }],
  ['an area id and type all', { item: 'room_lights', instanceId: 'living_room', type: 'all' }],
  ['a room selector and type all', { item: 'room_lights', room: 'living room', type: 'all' }],
  ['its name as name', { item: 'room_lights', name: 'Living Room' }],
]) {
  test(`room_lights by ${label} switches only that room's lights`, async () => {
    const home = fakeHome();
    home.areas[0].entities.push('climate.hall', 'media_player.kitchen', 'switch.kettle');
    const plugin = await connected({ home });
    for (const action of [['set_on', { on: true }], ['toggle', {}], ['set_on', { on: false }]]) {
      plugin.calls.length = 0;
      const result = await plugin.action(action[0], { ...args, ...action[1] });
      assert.ok(result.ok, `${action[0]}: ${result.message}`);
      assert.deepStrictEqual(plugin.services().map((s) => s.service + ' ' + s.body.entity_id.join()),
        [`light/${action[0] === 'set_on' && !action[1].on ? 'turn_off' : action[0] === 'toggle' ? 'turn_off' : 'turn_on'} light.sofa,light.ceiling`]);
    }
  });
}

test('home_lights and light items never reach other devices either', async () => {
  const plugin = await connected();
  await plugin.action('set_on', { item: 'home_lights', instanceId: 'home', type: 'all', on: false });
  await plugin.action('set_on', { item: 'light', room: 'living room', on: true });
  const result = await plugin.action('set_on', { item: 'light', instanceId: 'switch.kettle', on: true });
  assert.strictEqual(result.code, 'INVALID_ARGS');
  assert.deepStrictEqual(plugin.services().map((s) => s.service), ['light/turn_off', 'light/turn_on']);
});

// The dashboard demo sends only { instanceId } for a tap when an action doesn't require `item`.
for (const [label, args] of [
  ['an area id alone', { instanceId: 'living_room' }],
  ['a room name alone', { instanceId: 'Living Room' }],
  ['an area id with item device', { item: 'device', instanceId: 'living_room' }],
]) {
  test(`a room tile tap with ${label} toggles only that room's lights`, async () => {
    const home = fakeHome();
    home.areas[0].entities.push('climate.hall', 'media_player.kitchen', 'switch.kettle');
    const plugin = await connected({ home });
    const result = await plugin.action('toggle', args);
    assert.ok(result.ok, result.message);
    assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_off', body: { entity_id: ['light.sofa', 'light.ceiling'] } }]);
  });
}

test('the room selector is still the whole room', async () => {
  const plugin = await connected();
  await plugin.action('set_on', { room: 'living room', on: false });
  assert.deepStrictEqual(plugin.services().map((s) => s.service).sort(), ['cover/close_cover', 'light/turn_off']);
});

test('no device at all is refused with a hint', async () => {
  const plugin = await connected();
  const vague = await plugin.action('set_on', { on: true });
  assert.strictEqual(vague.code, 'INVALID_ARGS');
  assert.match(vague.message, /type "light"/);
  assert.deepStrictEqual(plugin.services(), []);
});

test('a device actually called "Lights" is still found by name', async () => {
  const home = fakeHome();
  home.states.push(entity('switch.lights', 'off', { friendly_name: 'Lights' }));
  const plugin = await connected({ home });
  await plugin.action('set_on', { name: 'Lights', on: true });
  assert.deepStrictEqual(plugin.services(), [{ service: 'switch/turn_on', body: { entity_id: ['switch.lights'] } }]);
});

test('names: exact first, then substring, then without a trailing kind', async () => {
  const plugin = await connected();
  await plugin.action('set_brightness', { name: 'sofa lamp', percent: 40 });
  assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_on', body: { entity_id: ['light.sofa'], brightness_pct: 40 } }]);
  plugin.calls.length = 0;
  await plugin.action('set_on', { name: 'kettle plug', on: true });
  assert.deepStrictEqual(plugin.services(), [{ service: 'switch/turn_on', body: { entity_id: ['switch.kettle'] } }]);
  plugin.calls.length = 0;
  await plugin.action('set_on', { type: 'lights', room: 'bedroom', on: false });
  assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_off', body: { entity_id: ['light.bed'] } }]);
});

test('brightness 0 turns lights off; the home targets every light', async () => {
  const plugin = await connected();
  await plugin.action('set_brightness', { item: 'home_lights', instanceId: 'home', percent: 0 });
  assert.deepStrictEqual(plugin.services(), [{ service: 'light/turn_off', body: { entity_id: ['light.sofa', 'light.ceiling', 'light.bed', 'light.porch', 'light.attic'] } }]);
});

test('actions refuse devices that cannot do them', async () => {
  const plugin = await connected();
  const result = await plugin.action('set_brightness', { item: 'device', instanceId: 'switch.kettle', percent: 50 });
  assert.strictEqual(result.code, 'INVALID_ARGS');
  const none = await plugin.action('set_on', { on: true });
  assert.strictEqual(none.code, 'INVALID_ARGS');
  const colour = await plugin.action('set_color', { name: 'bedside', color: 'red' });
  assert.strictEqual(colour.code, 'INVALID_ARGS');
  assert.deepStrictEqual(plugin.services(), []);
});

test('speakers, thermostats and locks', async () => {
  const plugin = await connected();
  await plugin.action('set_volume', { type: 'speaker', percent: 60 });
  await plugin.action('media_control', { name: 'kitchen', type: 'speaker', command: 'next' });
  await plugin.action('set_thermostat', { name: 'hall', temperature_f: 70, mode: 'heat' });
  await plugin.action('unlock', { name: 'front door', code: '1234' });
  assert.deepStrictEqual(plugin.services(), [
    { service: 'media_player/volume_set', body: { entity_id: ['media_player.kitchen'], volume_level: 0.6 } },
    { service: 'media_player/media_next_track', body: { entity_id: ['media_player.kitchen'] } },
    { service: 'climate/set_hvac_mode', body: { entity_id: ['climate.hall'], hvac_mode: 'heat' } },
    { service: 'climate/set_temperature', body: { entity_id: ['climate.hall'], temperature: 21 } },
    { service: 'lock/unlock', body: { entity_id: ['lock.front'], code: '1234' } },
  ]);
});

test('run_automation runs scenes and scripts and triggers automations', async () => {
  const plugin = await connected();
  const scene = await plugin.action('run_automation', { name: 'movie' });
  assert.strictEqual(scene.text, 'Started Movie Night.');
  await plugin.action('run_automation', { instanceId: 'automation.morning' });
  assert.deepStrictEqual(plugin.services(), [
    { service: 'scene/turn_on', body: { entity_id: ['scene.movie'] } },
    { service: 'automation/trigger', body: { entity_id: ['automation.morning'] } },
  ]);
  const vague = await plugin.action('run_automation', { name: 'o' });
  assert.strictEqual(vague.code, 'INVALID_ARGS');
  assert.match(vague.message, /Which one/);
});

test('falls back to the remote address and prefers it afterwards', async () => {
  const plugin = await connected({ unreachable: [LOCAL] });
  // connect itself reports the local address as unreachable but still succeeds via remote.
  const result = await plugin.source('light');
  assert.ok(result.ok);
  assert.ok(plugin.calls.every((c) => c.base === REMOTE));
  assert.strictEqual(JSON.parse(plugin.store.homeassistant).preferred, 'remote');
});

test('unreachable everywhere is PLUGIN_UNAVAILABLE', async () => {
  const plugin = await connected();
  plugin.store.homeassistant = JSON.stringify({ localUrl: 'http://192.168.1.9:8123', remoteUrl: null });
  const result = await plugin.source('device');
  assert.strictEqual(result.code, 'PLUGIN_UNAVAILABLE');
});

test('forget clears the token and the addresses', async () => {
  const plugin = await connected();
  await plugin.config({ type: 'forget' });
  assert.strictEqual(plugin.secrets.ha_token, undefined);
  assert.strictEqual(plugin.store.homeassistant, undefined);
  assert.strictEqual((await plugin.source('light')).code, 'AUTH_REQUIRED');
});

test('a new domain: the request is made, refused, explained, and the setup kept', async () => {
  const permissions = { LocalNetwork: 'granted', 'Internet/ui.nabu.casa': 'granted' };
  const plugin = load({ permissions, unreachable: [LOCAL] });
  const result = await plugin.config({ type: 'connect', localUrl: LOCAL, remoteUrl: DUCK, token: TOKEN });
  // The request itself is what makes the app ask the user.
  assert.ok(plugin.requested.includes('Internet/myhome.duckdns.org'));
  assert.match(result.error, /doesn't have permission to connect to myhome\.duckdns\.org/);
  assert.match(result.error, /"Connect to myhome\.duckdns\.org"/);
  assert.strictEqual(result.saved, true);
  assert.strictEqual(plugin.secrets.ha_token, TOKEN);
  assert.strictEqual(JSON.parse(plugin.store.homeassistant).remoteUrl, DUCK);

  const status = await plugin.config({ type: 'status' });
  assert.deepStrictEqual(Array.from(status.waiting, (w) => w.which), ['remote']);

  // A source read away from home says the same thing to the watch or Index.
  const read = await plugin.source('light');
  assert.strictEqual(read.code, 'PLUGIN_UNAVAILABLE');
  assert.match(read.message, /Connect to myhome\.duckdns\.org/);

  // The user turns it on; Connect again with the token field left blank.
  permissions['Internet/myhome.duckdns.org'] = 'granted';
  const again = await plugin.config({ type: 'connect', localUrl: LOCAL, remoteUrl: DUCK, token: '' });
  assert.strictEqual(again.ok, true);
  assert.strictEqual((await plugin.config({ type: 'status' })).waiting.length, 0);
  assert.ok((await plugin.source('light')).ok);
});

test('a local address that answers is enough; the unapproved remote is a warning', async () => {
  const plugin = load({ permissions: { LocalNetwork: 'granted' } });
  const result = await plugin.config({ type: 'connect', localUrl: LOCAL, remoteUrl: DUCK, token: TOKEN });
  assert.strictEqual(result.ok, true);
  const remote = Array.from(result.checked).find((c) => c.which === 'remote');
  assert.strictEqual(remote.ok, false);
  assert.match(remote.error, /permission/);
});

test('a granted domain that does not answer is a network problem, not a permission', async () => {
  const plugin = load({ permissions: { 'Internet/myhome.duckdns.org': 'granted' }, unreachable: [DUCK] });
  const result = await plugin.config({ type: 'connect', remoteUrl: DUCK, token: TOKEN });
  assert.match(result.error, /Could not reach Home Assistant at myhome\.duckdns\.org\. Check the address/);
  assert.strictEqual(result.saved, false);
  assert.strictEqual(plugin.store.homeassistant, undefined);
});

test('without Pebble.permissions both causes are mentioned', async () => {
  const plugin = load({ unreachable: [DUCK] });
  const result = await plugin.config({ type: 'connect', remoteUrl: DUCK, token: TOKEN });
  assert.match(result.error, /If this is a new address, turn on "Connect to myhome\.duckdns\.org"/);
  assert.strictEqual(result.saved, true);
});

test('a refused local network permission names it', async () => {
  const plugin = load({ permissions: { LocalNetwork: 'denied' } });
  const result = await plugin.config({ type: 'connect', localUrl: LOCAL, token: TOKEN });
  assert.match(result.error, /"Local network"/);
  assert.strictEqual(result.saved, true);
});

test('which permission an address needs, split as the app splits hosts', () => {
  const { permissionFor } = load().context;
  const cases = {
    'http://homeassistant.local:8123': 'LocalNetwork',
    'http://192.168.1.20:8123': 'LocalNetwork',
    'http://10.0.0.5': 'LocalNetwork',
    'http://172.20.0.1': 'LocalNetwork',
    'http://100.101.102.103:8123': 'LocalNetwork',
    'http://[fd12::1]:8123': 'LocalNetwork',
    'http://ha.home.arpa': 'LocalNetwork',
    'http://172.32.0.1': 'Internet/172.32.0.1',
    'https://abc.ui.nabu.casa': 'Internet/abc.ui.nabu.casa',
    'https://MyHome.DuckDNS.org:8123': 'Internet/myhome.duckdns.org',
    'https://ha.tail1234.ts.net': 'Internet/ha.tail1234.ts.net',
  };
  for (const [url, permission] of Object.entries(cases)) assert.strictEqual(permissionFor(url), permission, url);
});
