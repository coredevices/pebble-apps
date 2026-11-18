// Google Home watchapp, phone side.
//
// Reads this pbw's own plugin (home/device) with Pebble.subscribeToSource and sends one
// AppMessage per device to the watch; the watch's controls come back as ops that become
// Pebble.invokeAction calls on the same plugin, targeted by device id. Favorites live here,
// in localStorage. The plugin re-reads home/device after every action, so the new state
// arrives through onData; only rows that changed are re-sent.
//
// Each device's KEY is a hash of its id, the same across PKJS restarts, and the watch addresses
// devices by KEY, so an action from a row the watch drew earlier can't reach another device.
//
// Values of CMD, OP, KIND, FLAG and MODE must match src/c/googlehome.h.

var PLUGIN_UUID = 'd93ea4f2-6bb2-4f51-a766-29dbe481c170';
var MAX_DEVICES = 48;

var CMD = { HELLO: 1, DEVICE: 2, ACT: 3, TOAST: 4 };
var OP = { POWER: 1, BRIGHT: 2, CTEMP: 3, VOLUME: 4, SETPT: 5, MODE: 6, LOCK: 7, FAV: 8 };
var KIND = { GENERIC: 0, LIGHT: 1, OUTLET: 2, SWITCH: 3, THERMOSTAT: 4, LOCK: 5, SPEAKER: 6, TV: 7, FAN: 8 };
var FLAG = {
  ON: 1, ONLINE: 2, FAV: 4, CAN_POWER: 8, CAN_BRIGHT: 16, CAN_CTEMP: 32, CAN_VOLUME: 64,
  CAN_LOCK: 128, CAN_THERMO: 256, LOCKED: 512, FAHRENHEIT: 1024
};
var MODES = ['', 'off', 'heat', 'cool', 'eco', 'heatcool'];
var MODE_LABEL = ['', 'Off', 'Heat', 'Cool', 'Eco', 'Auto'];

var devices = [];      // sorted: { id, name, room, kind, caps, state... }
var sentRows = [];     // JSON of each row sent and not known to have failed, to skip unchanged ones
// FNV-1a, 31 bits, never 0. ponytail: two ids in one home colliding is ~1 in 10^6 at 48 devices;
// the first match wins. Detect and salt if that ever matters.
function keyFor(id) {
  var h = 0x811c9dc5;
  for (var i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 1) || 1;
}
var fahrenheit = false;
// The SDK emulator's phone (pypkjs) can't sign in to Google: show sample devices there.
var mock = Pebble.platform === 'pypkjs' || typeof Pebble.subscribeToSource !== 'function';

function log(text) { console.log('[googlehome] ' + text); }

function utf8Length(ch) {
  var c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
}

// Clip to `maxBytes` of UTF-8 (the watch's buffer minus its NUL), never splitting a character.
function clip(text, maxBytes) {
  var chars = Array.from(text == null ? '' : String(text));
  var total = 0;
  chars.forEach(function (ch) { total += utf8Length(ch); });
  if (total <= maxBytes) return chars.join('');
  var out = '', used = 0;
  for (var i = 0; i < chars.length; i++) {
    var n = utf8Length(chars[i]);
    if (used + n > maxBytes - 3) break;  // room for the 3-byte ellipsis
    out += chars[i];
    used += n;
  }
  return out + '…';
}

// --- favorites ---------------------------------------------------------------------------------
// The plugin owns favorites (its settings page changes them too) and publishes each device's
// `favorite`. A watch toggle goes through its set_favorite action; favOverride shows the toggle
// until the plugin's next update after the action finishes. Sample data keeps them here.

var favOverride = {};  // id -> { on, settled }

function favorites() {
  try {
    var parsed = JSON.parse(localStorage.getItem('favorites') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function isFavorite(d) {
  return d.id in favOverride ? favOverride[d.id].on : d.favorite === true;
}

function setFavorite(d, on) {
  if (mock) {
    var favs = favorites().filter(function (id) { return id !== d.id; });
    if (on) favs.push(d.id);
    localStorage.setItem('favorites', JSON.stringify(favs));
    d.favorite = on;
    sendRows(false);
    return;
  }
  var override = favOverride[d.id] = { on: on, settled: false };
  sendRows(false);
  Pebble.invokeAction({ plugin: PLUGIN_UUID, action: 'set_favorite', args: { id: d.id, favorite: on }, timeoutMs: 10000 })
    .then(function (result) {
      if (result && result.ok) { override.settled = true; return; }
      undo((result && result.message) || 'Failed');
    }, function () { undo('Failed'); });
  function undo(message) {
    if (favOverride[d.id] === override) delete favOverride[d.id];
    failed(d, message);
  }
}

// --- outbound queue: one message in flight, next after the ACK ---------------------------------

var outbox = [];
var busy = false;

function send(message, onAck, onFail) {
  outbox.push({ message: message, onAck: onAck, onFail: onFail });
  pump();
}

function pump() {
  if (busy || outbox.length === 0) return;
  busy = true;
  var item = outbox[0];
  var attempts = 0;
  function done(callback) {
    outbox.shift();
    busy = false;
    if (callback) callback();
    pump();
  }
  function attempt() {
    attempts++;
    Pebble.sendAppMessage(item.message, function () { done(item.onAck); }, function () {
      if (attempts < 3) setTimeout(attempt, 300 * attempts);
      else done(item.onFail);
    });
  }
  attempt();
}

// --- source -> rows --------------------------------------------------------------------------

function text(p) { return p && p.shortText ? p.shortText.text : p && p.longText ? p.longText.text : null; }
function num(p) { return p && p.numericValue ? p.numericValue.value : null; }
function bool(p) { return p && p.boolean ? p.boolean.value : null; }

function kindOf(type, caps) {
  var t = String(type || '').toLowerCase();
  if (/light|lamp|bulb/.test(t)) return KIND.LIGHT;
  if (/outlet|plug/.test(t)) return KIND.OUTLET;
  if (/switch/.test(t)) return KIND.SWITCH;
  if (/thermostat|ac_unit|heater/.test(t)) return KIND.THERMOSTAT;
  if (/lock/.test(t)) return KIND.LOCK;
  if (/speaker|audio/.test(t)) return KIND.SPEAKER;
  if (/tv|display|settop|remote/.test(t)) return KIND.TV;
  if (/fan|purifier/.test(t)) return KIND.FAN;
  if (caps.thermostat) return KIND.THERMOSTAT;
  if (caps.lock) return KIND.LOCK;
  if (caps.brightness) return KIND.LIGHT;
  if (caps.volume) return KIND.SPEAKER;
  return caps.on_off ? KIND.SWITCH : KIND.GENERIC;
}

function modeCode(mode) {
  var m = String(mode || '').toLowerCase().replace(/[^a-z]/g, '');
  if (m === 'heatcool' || m === 'auto') return 5;
  var i = MODES.indexOf(m);
  return i > 0 ? i : 0;
}

function toUnit(c) { return c == null ? null : fahrenheit ? c * 9 / 5 + 32 : c; }

function degrees(c) {
  var v = toUnit(c);
  return v == null ? '' : (fahrenheit ? Math.round(v) : Math.round(v * 2) / 2) + '°';
}

function deviceFrom(instance) {
  var p = instance.properties || {};
  var caps = {};
  String(text(p.capabilities) || '').split(',').forEach(function (c) { if (c.trim()) caps[c.trim()] = true; });
  return {
    id: instance.instanceId,
    name: text(p.name) || 'Device',
    room: text(p.room) || 'Unassigned',
    kind: kindOf(text(p.type), caps),
    caps: caps,
    favorite: mock ? favorites().indexOf(instance.instanceId) >= 0 : bool(p.favorite),
    hasState: p.online != null || p.on != null || p.locked != null || p.setpoint != null,
    online: bool(p.online) !== false,
    on: bool(p.on),
    brightness: num(p.brightness),
    ctemp: num(p.color_temperature),
    volume: num(p.volume),
    locked: bool(p.locked),
    mode: modeCode(text(p.thermostat_mode)),
    setpoint: num(p.setpoint),
    ambient: num(p.ambient_temperature)
  };
}

function statusOf(d) {
  if (!d.online) return 'Offline';
  if (d.caps.thermostat) {
    var parts = [];
    if (d.ambient != null) parts.push(degrees(d.ambient));
    if (d.mode !== 1 && d.setpoint != null) parts.push('→ ' + degrees(d.setpoint));
    if (d.mode) parts.push(MODE_LABEL[d.mode]);
    return parts.join(' ') || 'Thermostat';
  }
  if (d.caps.lock && d.locked != null) return d.locked ? 'Locked' : 'Unlocked';
  if (d.on === false) return 'Off';
  if (d.brightness != null && d.caps.brightness) return 'On · ' + Math.round(d.brightness) + '%';
  if (d.volume != null && d.caps.volume && d.on == null) return 'Volume ' + Math.round(d.volume) + '%';
  return d.on ? 'On' : '';
}

function rowFor(d, index, total) {
  var flags = 0;
  if (d.on) flags |= FLAG.ON;
  if (d.online) flags |= FLAG.ONLINE;
  if (isFavorite(d)) flags |= FLAG.FAV;
  if (d.caps.on_off) flags |= FLAG.CAN_POWER;
  if (d.caps.brightness) flags |= FLAG.CAN_BRIGHT;
  if (d.caps.color_temperature) flags |= FLAG.CAN_CTEMP;
  if (d.caps.volume) flags |= FLAG.CAN_VOLUME;
  if (d.caps.lock) flags |= FLAG.CAN_LOCK;
  if (d.caps.thermostat) flags |= FLAG.CAN_THERMO;
  if (d.locked) flags |= FLAG.LOCKED;
  if (fahrenheit) flags |= FLAG.FAHRENHEIT;
  var setpoint = toUnit(d.setpoint);
  return {
    CMD: CMD.DEVICE,
    INDEX: index,
    TOTAL: total,
    KEY: keyFor(d.id),
    NAME: clip(d.name, 23),
    ROOM: clip(d.room, 19),
    STATUS: clip(statusOf(d), 27),
    KIND: d.kind,
    FLAGS: flags,
    BRIGHT: Math.round(d.brightness || 0),
    CTEMP: Math.round(d.ctemp || 0),
    VOLUME: Math.round(d.volume || 0),
    SETPT: setpoint == null ? 0 : Math.round(setpoint * 10),
    MODE: d.mode
  };
}

function sendRows(force) {
  if (devices.length === 0) {
    sentRows = [];
    send({ CMD: CMD.DEVICE, INDEX: 0, TOTAL: 0, STATUS: 'No devices in your home' });
    return;
  }
  if (force || sentRows.length !== devices.length) sentRows = [];
  devices.forEach(function (d, i) {
    var row = rowFor(d, i, devices.length);
    var json = JSON.stringify(row);
    if (sentRows[i] === json) return;
    sentRows[i] = json;
    // A row the watch never got is forgotten, so the next update sends it again.
    send(row, null, function () { if (sentRows[i] === json) sentRows[i] = null; });
  });
}

var STATE_FIELDS = ['online', 'on', 'brightness', 'ctemp', 'volume', 'locked', 'mode', 'setpoint', 'ambient'];

function onDevices(instances) {
  var previous = {};
  devices.forEach(function (d) { previous[d.id] = d; });
  devices = (instances || []).map(function (instance) {
    var d = deviceFrom(instance);
    // A read whose live-state call failed lists devices without state: keep what we last knew,
    // for one update only.
    var old = previous[d.id];
    if (!d.hasState && old && !old.inherited) {
      STATE_FIELDS.forEach(function (f) { d[f] = old[f]; });
      d.inherited = true;
    }
    var override = favOverride[d.id];
    if (override && (override.settled || d.favorite === override.on)) delete favOverride[d.id];
    return d;
  }).sort(function (a, b) {
    return a.room.localeCompare(b.room) || a.name.localeCompare(b.name);
  }).slice(0, MAX_DEVICES);
  sendRows(false);
}

var ERROR_TEXT = {
  AUTH_REQUIRED: 'Sign in to Google Home in the Pebble app',
  PERMISSION_DENIED: 'Allow access in the Pebble app',
  RATE_LIMITED: 'Google is busy, try again soon'
};

function onSourceError(err) {
  log('home/device error: ' + (err && err.code));
  if (devices.length > 0) {
    send({ CMD: CMD.TOAST, STATUS: clip(ERROR_TEXT[err && err.code] || 'Could not refresh', 39) });
    return;
  }
  sentRows = [];
  send({ CMD: CMD.DEVICE, INDEX: 0, TOTAL: 0, STATUS: clip(ERROR_TEXT[err && err.code] || (err && err.message) || 'Google Home unavailable', 63) });
}

// --- actions ---------------------------------------------------------------------------------

function actionFor(d, op, value) {
  switch (op) {
    case OP.POWER: return { action: value ? 'turn_on' : 'turn_off', args: {} };
    case OP.BRIGHT: return { action: 'set_brightness', args: { brightness_pct: value } };
    case OP.CTEMP: return { action: 'set_color_temperature', args: { kelvin: value } };
    case OP.VOLUME: return { action: 'set_volume', args: { volume_pct: value } };
    case OP.SETPT:
      return { action: 'set_thermostat', args: fahrenheit ? { temperature_f: value / 10 } : { temperature_c: value / 10 } };
    case OP.MODE: return { action: 'set_thermostat', args: { mode: MODES[value] } };
    case OP.LOCK: return { action: 'lock', args: {} };
  }
  return null;
}

function applyLocally(d, op, value) {
  if (op === OP.POWER) d.on = !!value;
  else if (op === OP.BRIGHT) { d.brightness = value; d.on = value > 0; }
  else if (op === OP.CTEMP) d.ctemp = value;
  else if (op === OP.VOLUME) d.volume = value;
  else if (op === OP.SETPT) d.setpoint = fahrenheit ? (value / 10 - 32) * 5 / 9 : value / 10;
  else if (op === OP.MODE) d.mode = value;
  else if (op === OP.LOCK) d.locked = true;
}

function indexOfKey(key) {
  for (var i = 0; i < devices.length; i++) if (keyFor(devices[i].id) === key) return i;
  return -1;
}

// The watch changed the row optimistically: say why and put the real state back.
function failed(d, message) {
  send({ CMD: CMD.TOAST, STATUS: clip(message, 39) });
  for (var i = 0; i < devices.length; i++) if (devices[i].id === d.id) sentRows[i] = null;
  sendRows(false);
}

function act(key, op, value) {
  var index = indexOfKey(key);
  var d = devices[index];
  if (!d) {
    send({ CMD: CMD.TOAST, STATUS: 'Device no longer listed' });
    sendRows(true);
    return;
  }
  if (op === OP.FAV) {
    setFavorite(d, !!value);
    return;
  }
  var call = actionFor(d, op, value);
  if (!call) return;
  if (mock) {
    applyLocally(d, op, value);
    sendRows(false);
    return;
  }
  call.args.id = d.id;
  log(call.action + ' on #' + index);
  Pebble.invokeAction({ plugin: PLUGIN_UUID, action: call.action, args: call.args, timeoutMs: 20000 })
    .then(function (result) {
      if (result && result.ok) return;
      log(call.action + ' failed: ' + (result && result.code));
      failed(d, (result && result.message) || 'Failed');
    }, function () { failed(d, 'Failed'); });
}

// --- sample devices for the SDK emulator --------------------------------

var MOCK = [
  ['1', 'Ceiling Light', 'Living Room', 'action.devices.types.LIGHT', 'on_off, brightness, color_temperature', { on: true, brightness: 70, color_temperature: 2700 }],
  ['2', 'Floor Lamp', 'Living Room', 'action.devices.types.LIGHT', 'on_off, brightness', { on: false, brightness: 40 }],
  ['3', 'Nest Hub', 'Living Room', 'action.devices.types.SPEAKER', 'on_off, volume, media_transport', { on: true, volume: 35 }],
  ['4', 'Hallway', 'Hallway', 'action.devices.types.THERMOSTAT', 'thermostat', { thermostat_mode: 'heat', setpoint: 21, ambient_temperature: 19.5 }],
  ['5', 'Front Door', 'Hallway', 'action.devices.types.LOCK', 'lock', { locked: true }],
  ['6', 'Coffee Maker', 'Kitchen', 'action.devices.types.OUTLET', 'on_off', { on: false }],
  ['7', 'Pendant Lights', 'Kitchen', 'action.devices.types.LIGHT', 'on_off, brightness', { on: true, brightness: 100 }],
  ['8', 'Ceiling Fan', 'Bedroom', 'action.devices.types.FAN', 'on_off', { on: false, online: false }]
];

function mockInstances() {
  return MOCK.map(function (m) {
    var p = { name: { shortText: { text: m[1] } }, room: { shortText: { text: m[2] } }, type: { shortText: { text: m[3] } }, capabilities: { longText: { text: m[4] } } };
    var s = m[5];
    p.online = { boolean: { value: s.online !== false } };
    ['on', 'locked'].forEach(function (k) { if (k in s) p[k] = { boolean: { value: s[k] } }; });
    ['brightness', 'color_temperature', 'volume', 'setpoint', 'ambient_temperature'].forEach(function (k) {
      if (k in s) p[k] = { numericValue: { value: s[k] } };
    });
    if (s.thermostat_mode) p.thermostat_mode = { shortText: { text: s.thermostat_mode } };
    return { instanceId: m[0], properties: p };
  });
}

// --- events ----------------------------------------------------------------------------------

var started = false;

function start() {
  if (started) return;
  started = true;
  if (mock) {
    log('no plugin API: showing sample devices');
    onDevices(mockInstances());
    return;
  }
  Pebble.subscribeToSource({
    category: 'preferences',
    item: 'units',
    onData: function (envelope) {
      var unit = envelope.instances[0] && text(envelope.instances[0].properties.temperature);
      var f = unit === '°F';
      if (f !== fahrenheit) {
        fahrenheit = f;
        if (devices.length) sendRows(false);
      }
    },
    onError: function (err) { log('preferences/units: ' + (err && err.code)); }
  });
  Pebble.subscribeToSource({
    category: 'home',
    item: 'device',
    plugin: PLUGIN_UUID,
    onData: function (envelope) { onDevices(envelope.instances); },
    onError: onSourceError
  });
}

Pebble.addEventListener('ready', start);

Pebble.addEventListener('appmessage', function (e) {
  var p = (e && e.payload) || {};
  if (p.CMD === CMD.HELLO) {
    start();
    if (devices.length || sentRows.length) sendRows(true);
  } else if (p.CMD === CMD.ACT) {
    act(p.KEY, p.OP, p.VALUE);
  }
});
