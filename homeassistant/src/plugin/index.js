// Home Assistant plugin.
//
// Talks to the user's own Home Assistant over its REST API with a long-lived access token (made
// on the user's HA profile page, kept in Pebble.secureStorage). Everything is read from three
// endpoints: /api/states for entities, /api/template for areas (the REST API has no area list of
// its own, but a template can render one), and /api/config for the temperature unit.
//
// It serves two families of source, so faces and agents written for either of the other home
// plugins work unchanged:
//   - home/light, home/room_lights, home/home_lights: the Hue plugin's items and properties, with
//     Home Assistant areas as rooms.
//   - home/device, home/automation: the Google Home plugin's items and properties, plus
//     home/sensor for numeric sensors.
//
// Home Assistant is reached at a local URL, a remote one, or both; whichever answered last is
// tried first, so the plugin keeps working when the phone leaves home Wi-Fi.
//
// The manifest declares LocalNetwork and Home Assistant Cloud (*.ui.nabu.casa), which the user
// approves at install. Any other remote address (DuckDNS, a custom domain, Tailscale's ts.net) is
// a domain the app asks the user about the first time the plugin requests it: that request fails,
// and a "Connect to <domain>" request appears in the plugin's permissions. So the plugin always
// makes the request rather than checking first (a check alone raises no request), and only then
// asks Pebble.permissions, where the app has it, whether the failure was a permission.

var STORE_KEY = 'homeassistant';
var TOKEN_KEY = 'ha_token';

// ---------------------------------------------------------------- state

function state() {
  var s;
  try { s = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { s = {}; }
  return {
    localUrl: s.localUrl || null,
    remoteUrl: s.remoteUrl || null,
    // Which of the two answered last: 'local' or 'remote'.
    preferred: s.preferred === 'remote' ? 'remote' : 'local',
    // Area ids the user switched off in settings. Their entities disappear from every source
    // and action; nothing changes in Home Assistant.
    hidden: Array.isArray(s.hidden) ? s.hidden : [],
    // Home Assistant's own temperature unit, '°C' or '°F'.
    tempUnit: s.tempUnit || null,
  };
}

function saveState(next) {
  var merged = state();
  Object.keys(next).forEach(function (key) { merged[key] = next[key]; });
  localStorage.setItem(STORE_KEY, JSON.stringify(merged));
}

/** A URL the user typed, as a base without a trailing slash, or null if it isn't one. */
function normalizeUrl(text) {
  var url = String(text || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  url = url.replace(/\/+$/, '');
  // Pasted from the browser while looking at a dashboard: keep just the origin.
  var origin = /^(https?:\/\/[^\/?#]+)/i.exec(url);
  return origin ? origin[1] : null;
}

// ---------------------------------------------------------------- network

function PluginError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

async function token() {
  var value = await Pebble.secureStorage.getItem(TOKEN_KEY);
  return value && String(value).trim() ? String(value).trim() : null;
}

/** The host of a base URL from normalizeUrl, lowercased, without IPv6 brackets. */
function hostOf(url) {
  var match = /^https?:\/\/(?:[^@\/]*@)?(\[[^\]]+\]|[^:\/]+)/i.exec(url || '');
  return match ? match[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '') : null;
}

function isPrivateIpv4(host) {
  var parts = host.split('.');
  if (parts.length !== 4 || !parts.every(function (p) { return /^\d{1,3}$/.test(p) && Number(p) <= 255; })) return false;
  var a = Number(parts[0]);
  var b = Number(parts[1]);
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); // the last is CGNAT, which Tailscale uses
}

/** Whether the app counts the host as on the local network, the way its network policy does. */
function isLocalHost(host) {
  if (!host) return false;
  if (host.indexOf(':') !== -1) {
    var mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isPrivateIpv4(mapped[1]);
    return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  }
  return host === 'localhost' || /\.(localhost|local|home\.arpa|internal)$/.test(host) || isPrivateIpv4(host);
}

/** The permission the app checks before requesting `url`. */
function permissionFor(url) {
  var host = hostOf(url);
  return isLocalHost(host) ? 'LocalNetwork' : 'Internet/' + host;
}

/** 'granted', 'denied' or 'prompt', or null where the app can't say (no Pebble.permissions). */
async function permissionState(url) {
  var permissions = typeof Pebble !== 'undefined' && Pebble.permissions;
  if (!permissions || typeof permissions.query !== 'function') return null;
  try { return await permissions.query(permissionFor(url)); } catch (e) { return null; }
}

/**
 * Why a request to `url` didn't happen: { host, local, state }, where state is the permission's
 * ('denied' or 'prompt') when that's the reason, 'granted' when it isn't, and null when the app
 * can't tell a refused permission from a dead network.
 */
async function unreachable(url) {
  return { host: hostOf(url), local: isLocalHost(hostOf(url)), state: await permissionState(url) };
}

function unreachableMessage(failure) {
  var where = failure.local ? 'Local network' : 'Connect to ' + failure.host;
  var turnOn = 'turn on "' + where + '" in Home Assistant\'s Permissions in the Pebble app';
  if (failure.state === 'prompt' || failure.state === 'denied') {
    return 'Home Assistant doesn\'t have permission to connect to ' + failure.host + '. To use it, ' + turnOn + ', then try again.';
  }
  if (failure.state === 'granted') {
    return 'Could not reach Home Assistant at ' + failure.host + '. Check the address, and that Home Assistant is running.';
  }
  return 'Could not reach Home Assistant at ' + failure.host + '. If this is a new address, ' + turnOn +
    '; otherwise check the address, and that Home Assistant is running.';
}

/** The failure to tell the user about: a permission they can fix before a network that's down. */
function worstFailure(failures) {
  var blocked = failures.filter(function (f) { return f.state === 'prompt' || f.state === 'denied'; });
  if (blocked.length) return blocked[0];
  var unsure = failures.filter(function (f) { return f.state == null && !f.local; });
  return unsure[0] || failures[0];
}

function bases(current) {
  var local = current.localUrl;
  var remote = current.remoteUrl;
  var order = current.preferred === 'remote' ? [remote, local] : [local, remote];
  return order.filter(function (url, i) { return url && order.indexOf(url) === i; });
}

/**
 * One request to Home Assistant. Tries each configured URL until one answers at all; an HTTP
 * error from the first is final, since the server was reached.
 */
async function ha(path, method, body, overrides) {
  var current = overrides ? Object.assign(state(), overrides) : state();
  var accessToken = overrides && overrides.token != null ? overrides.token : await token();
  var urls = bases(current);
  if (!urls.length) throw PluginError('AUTH_REQUIRED', 'Home Assistant is not set up. Add its address in plugin settings.');
  if (!accessToken) throw PluginError('AUTH_REQUIRED', 'No access token. Add one in plugin settings.');

  var failures = [];
  for (var i = 0; i < urls.length; i++) {
    var response;
    try {
      response = await fetch(urls[i] + path, {
        method: method || 'GET',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // A refused permission fails just like a dead network; find out which it was.
      failures.push(await unreachable(urls[i]));
      continue;
    }
    if (!overrides) {
      var which = urls[i] === current.remoteUrl && urls[i] !== current.localUrl ? 'remote' : 'local';
      if (which !== current.preferred) saveState({ preferred: which });
    }
    if (response.status === 401 || response.status === 403) {
      throw PluginError('AUTH_REQUIRED', 'Home Assistant rejected the access token.');
    }
    if (!response.ok) {
      var detail = '';
      try { detail = (await response.text()).slice(0, 200); } catch (e) { /* none */ }
      throw PluginError(response.status === 400 ? 'INVALID_ARGS' : 'PLUGIN_UNAVAILABLE',
        'Home Assistant answered HTTP ' + response.status + (detail ? ': ' + detail : '') + '.');
    }
    var text = await response.text();
    try { return JSON.parse(text); } catch (e) { return text; }
  }
  var failure = worstFailure(failures);
  console.error('Home Assistant unreachable, permission ' + failure.state);
  var error = PluginError('PLUGIN_UNAVAILABLE', unreachableMessage(failure));
  error.unreachable = failure;
  throw error;
}

// ---------------------------------------------------------------- the home, read

var AREAS_TEMPLATE =
  '{% set ns = namespace(out=[]) %}' +
  '{% for id in areas() %}' +
  '{% set ns.out = ns.out + [{"id": id, "name": area_name(id), "entities": area_entities(id)}] %}' +
  '{% endfor %}' +
  '{{ ns.out | tojson }}';

async function readAreas(overrides) {
  try {
    var areas = await ha('/api/template', 'POST', { template: AREAS_TEMPLATE }, overrides);
    if (typeof areas === 'string') areas = JSON.parse(areas);
    return Array.isArray(areas) ? areas : [];
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') throw e;
    // Without areas everything still works, just with no rooms.
    console.warn('Reading areas failed: ' + e.message);
    return [];
  }
}

async function temperatureUnit() {
  var current = state();
  if (current.tempUnit) return current.tempUnit;
  try {
    var config = await ha('/api/config');
    var unit = config && config.unit_system && config.unit_system.temperature;
    if (unit) {
      saveState({ tempUnit: unit });
      return unit;
    }
  } catch (e) {
    if (e.code === 'AUTH_REQUIRED') throw e;
  }
  return '°C';
}

var DEVICE_DOMAINS = ['light', 'switch', 'fan', 'cover', 'media_player', 'climate', 'lock', 'input_boolean', 'humidifier'];
var AUTOMATION_DOMAINS = ['scene', 'script', 'automation'];

/**
 * Everything the sources and actions need, in one read: entities with their area, and areas
 * with their entities, both with hidden areas left out.
 */
async function snapshot() {
  var results = await Promise.all([ha('/api/states'), readAreas()]);
  var states = Array.isArray(results[0]) ? results[0] : [];
  var areas = results[1];
  var hidden = state().hidden;

  var areaOf = {};
  areas.forEach(function (area) {
    (area.entities || []).forEach(function (id) {
      if (!areaOf[id]) areaOf[id] = area;
    });
  });

  var entities = states
    .filter(function (s) { return s && typeof s.entity_id === 'string'; })
    .map(function (s) {
      var domain = s.entity_id.split('.')[0];
      var area = areaOf[s.entity_id] || null;
      var attrs = s.attributes || {};
      return {
        id: s.entity_id,
        domain: domain,
        name: attrs.friendly_name || s.entity_id,
        areaId: area ? area.id : null,
        areaName: area ? area.name : null,
        state: s.state,
        attrs: attrs,
      };
    })
    .filter(function (e) { return !e.areaId || hidden.indexOf(e.areaId) === -1; });

  return {
    entities: entities,
    areas: areas.filter(function (area) { return hidden.indexOf(area.id) === -1; }),
    allAreas: areas,
  };
}

function isOnline(entity) {
  return entity.state !== 'unavailable' && entity.state !== 'unknown';
}

/** Whether the entity counts as on, or null for one with no on/off reading. */
function isOn(entity) {
  switch (entity.domain) {
    case 'light': case 'switch': case 'fan': case 'input_boolean': case 'humidifier': case 'automation':
      return entity.state === 'on';
    case 'cover':
      return entity.state === 'open' || entity.state === 'opening';
    case 'media_player':
      return ['off', 'standby', 'unavailable', 'unknown'].indexOf(entity.state) === -1;
    case 'climate':
      return entity.state !== 'off' && isOnline(entity);
    default:
      return null;
  }
}

/** A light's brightness in percent: 0 when off, 100 for an on/off-only light that is on. */
function brightnessPercent(entity) {
  if (!isOn(entity)) return 0;
  var bri = entity.attrs.brightness;
  return typeof bri === 'number' ? Math.round((bri / 255) * 100) : 100;
}

// ---------------------------------------------------------------- property shapes

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function longText(text) {
  return { longText: { text: String(text) } };
}

function flag(value, yes, no) {
  return { boolean: { value: !!value }, shortText: { text: value ? yes : no } };
}

function number(value, unit, min, max) {
  var numeric = { value: value };
  if (unit) numeric.unit = unit;
  if (min != null && max != null) { numeric.min = min; numeric.max = max; }
  var rounded = Math.round(value * 10) / 10;
  return { numericValue: numeric, shortText: { text: rounded + (unit || '') } };
}

/** The Hue plugin's reading for a light, a room or the whole home. */
function lightProperties(name, on, percent, reachable) {
  var reading;
  if (!reachable) reading = '--';
  else if (!on) reading = 'Off';
  else reading = percent + '%';
  return {
    name: shortText(name),
    on: { boolean: { value: !!on }, shortText: { text: reachable ? (on ? 'On' : 'Off') : '--' } },
    brightness: {
      numericValue: { value: on ? percent : 0, unit: '%', min: 0, max: 100 },
      shortText: { text: reading },
    },
  };
}

/** Lights read as one: on if any is, at the average brightness of those that are. */
function groupProperties(name, lights) {
  var lit = lights.filter(function (light) { return isOn(light); });
  var total = lit.reduce(function (sum, light) { return sum + brightnessPercent(light); }, 0);
  return lightProperties(
    name,
    lit.length > 0,
    lit.length ? Math.round(total / lit.length) : 0,
    lights.some(isOnline)
  );
}

function deviceType(entity) {
  if (entity.domain === 'switch' && entity.attrs.device_class === 'outlet') return 'outlet';
  if (entity.domain === 'media_player' && entity.attrs.device_class === 'tv') return 'tv';
  if (entity.domain === 'media_player') return 'speaker';
  if (entity.domain === 'climate') return 'thermostat';
  return entity.domain;
}

function deviceProperties(entity, tempUnit) {
  var attrs = entity.attrs;
  var properties = {
    name: shortText(entity.name),
    room: shortText(entity.areaName || 'Unassigned'),
    type: shortText(deviceType(entity)),
    online: flag(isOnline(entity), 'Online', 'Offline'),
  };
  var on = isOn(entity);
  if (on !== null && entity.domain !== 'lock') properties.on = flag(on, 'On', 'Off');
  if (entity.domain === 'light') {
    properties.brightness = number(brightnessPercent(entity), '%', 0, 100);
    if (typeof attrs.color_temp_kelvin === 'number') properties.color_temperature = number(attrs.color_temp_kelvin, 'K');
  }
  if (entity.domain === 'fan' && typeof attrs.percentage === 'number') {
    properties.speed = number(attrs.percentage, '%', 0, 100);
  }
  if (entity.domain === 'cover' && typeof attrs.current_position === 'number') {
    properties.position = number(attrs.current_position, '%', 0, 100);
  }
  if (entity.domain === 'media_player') {
    if (typeof attrs.volume_level === 'number') properties.volume = number(Math.round(attrs.volume_level * 100), '%', 0, 100);
    if (typeof attrs.is_volume_muted === 'boolean') properties.muted = flag(attrs.is_volume_muted, 'Muted', 'Sound');
    if (attrs.media_title) properties.media_title = longText(attrs.media_artist ? attrs.media_title + ' – ' + attrs.media_artist : attrs.media_title);
  }
  if (entity.domain === 'lock' && isOnline(entity)) {
    properties.locked = flag(entity.state === 'locked', 'Locked', 'Open');
  }
  if (entity.domain === 'climate') {
    properties.thermostat_mode = shortText(entity.state);
    if (typeof attrs.temperature === 'number') properties.setpoint = number(attrs.temperature, tempUnit);
    if (typeof attrs.current_temperature === 'number') properties.ambient_temperature = number(attrs.current_temperature, tempUnit);
  }
  return properties;
}

// ---------------------------------------------------------------- sources

var HOME_ID = 'home';

function lights(snap) {
  return snap.entities.filter(function (e) { return e.domain === 'light'; });
}

function lightInstances(snap) {
  return lights(snap).map(function (light) {
    return {
      instanceId: light.id,
      properties: lightProperties(light.name, isOn(light), brightnessPercent(light), isOnline(light)),
    };
  });
}

function roomInstances(snap) {
  var all = lights(snap);
  return snap.areas
    .map(function (area) {
      return {
        instanceId: area.id,
        lights: all.filter(function (light) { return light.areaId === area.id; }),
        name: area.name || area.id,
      };
    })
    .filter(function (room) { return room.lights.length > 0; })
    .map(function (room) {
      return { instanceId: room.instanceId, properties: groupProperties(room.name, room.lights) };
    });
}

function homeInstances(snap) {
  return [{ instanceId: HOME_ID, properties: groupProperties('Home', lights(snap)) }];
}

function deviceInstances(snap, tempUnit) {
  return snap.entities
    .filter(function (e) { return DEVICE_DOMAINS.indexOf(e.domain) !== -1; })
    .map(function (e) { return { instanceId: e.id, properties: deviceProperties(e, tempUnit) }; });
}

function automationInstances(snap) {
  return snap.entities
    .filter(function (e) { return AUTOMATION_DOMAINS.indexOf(e.domain) !== -1; })
    .map(function (e) {
      var properties = {
        name: shortText(e.name),
        type: shortText(e.domain),
        // Scenes and scripts always run; an automation can be triggered even while disabled.
        manually_runnable: flag(isOnline(e), 'Yes', 'No'),
      };
      if (e.domain === 'automation') properties.enabled = flag(e.state === 'on', 'On', 'Off');
      var last = Date.parse(e.attrs.last_triggered || (e.domain === 'scene' ? e.state : ''));
      if (!isNaN(last)) properties.last_run = { timestamp: { value: Math.floor(last / 1000) } };
      return { instanceId: e.id, properties: properties };
    });
}

// What a binary sensor's on and off mean, by device class, in Home Assistant's own words.
var BINARY_STATES = {
  door: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], window: ['Open', 'Closed'], opening: ['Open', 'Closed'],
  lock: ['Unlocked', 'Locked'],
  motion: ['Detected', 'Clear'], occupancy: ['Detected', 'Clear'], presence: ['Home', 'Away'],
  moisture: ['Wet', 'Dry'], smoke: ['Detected', 'Clear'], gas: ['Detected', 'Clear'],
  carbon_monoxide: ['Detected', 'Clear'], sound: ['Detected', 'Clear'], vibration: ['Detected', 'Clear'],
  tamper: ['Tampered', 'Clear'], problem: ['Problem', 'OK'], safety: ['Unsafe', 'Safe'],
  battery: ['Low', 'Normal'], battery_charging: ['Charging', 'Not charging'],
  cold: ['Cold', 'Normal'], heat: ['Hot', 'Normal'], light: ['Light', 'No light'],
  connectivity: ['Connected', 'Disconnected'], plug: ['Plugged in', 'Unplugged'], power: ['Power', 'No power'],
  moving: ['Moving', 'Stopped'], running: ['Running', 'Not running'], update: ['Update', 'Up to date'],
};

/**
 * A sensor's reading as the shapes it has: a number with its unit; a binary sensor's state as a
 * boolean and its words ("Closed"); a moment as a timestamp; anything else as text.
 */
function sensorValue(e) {
  if (!isOnline(e)) return { shortText: { text: '--' }, longText: { text: 'Unavailable' } };
  var unit = e.attrs.unit_of_measurement;
  if (e.domain === 'binary_sensor') {
    var on = e.state === 'on';
    var words = BINARY_STATES[e.attrs.device_class] || ['On', 'Off'];
    var word = on ? words[0] : words[1];
    return { boolean: { value: on }, shortText: { text: word }, longText: { text: word } };
  }
  if (e.state !== '' && isFinite(Number(e.state)) && (unit != null || e.attrs.state_class)) {
    var reading = number(Number(e.state), unit);
    reading.longText = { text: reading.shortText.text };
    return reading;
  }
  if (e.attrs.device_class === 'timestamp') {
    var at = Date.parse(e.state);
    if (!isNaN(at)) return { timestamp: { value: Math.floor(at / 1000) }, longText: { text: e.state } };
  }
  return { shortText: { text: e.state }, longText: { text: e.state + (unit ? ' ' + unit : '') } };
}

function sensorInstances(snap) {
  return snap.entities
    .filter(function (e) { return e.domain === 'sensor' || e.domain === 'binary_sensor'; })
    .map(function (e) {
      var properties = {
        name: shortText(e.name),
        room: shortText(e.areaName || 'Unassigned'),
        value: sensorValue(e),
      };
      var kind = e.attrs.device_class || (e.domain === 'binary_sensor' ? 'binary' : null);
      if (kind) properties.kind = shortText(kind);
      return { instanceId: e.id, properties: properties };
    });
}

var SOURCES = ['home/light', 'home/room_lights', 'home/home_lights', 'home/device', 'home/automation', 'home/sensor'];

Pebble.registerSourceHandler(async function (request, respond) {
  try {
    if (request.category !== 'home') throw PluginError('PLUGIN_UNAVAILABLE', 'unknown category ' + request.category);
    var snap = await snapshot();
    var instances;
    switch (request.item) {
      case 'light': instances = lightInstances(snap); break;
      case 'room_lights': instances = roomInstances(snap); break;
      case 'home_lights': instances = homeInstances(snap); break;
      case 'device': instances = deviceInstances(snap, await temperatureUnit()); break;
      case 'automation': instances = automationInstances(snap); break;
      case 'sensor': instances = sensorInstances(snap); break;
      default: throw PluginError('PLUGIN_UNAVAILABLE', 'unknown item ' + request.item);
    }
    respond.data({ validUntilMs: Date.now() + 30 * 1000, instances: instances });
  } catch (e) {
    // Messages can name the user's devices; the code is enough for the log.
    console.error('Reading home/' + request.item + ' failed: ' + (e.code || e));
    respond.error(e.code || 'PLUGIN_UNAVAILABLE', e.message);
  }
});

// ---------------------------------------------------------------- which things an action means

function lower(text) {
  return String(text == null ? '' : text).trim().toLowerCase();
}

// What people call a kind of device, as a domain (or, for outlet and tv, a device type).
var TYPE_WORDS = {
  light: 'light', lights: 'light', lamp: 'light', lamps: 'light', bulb: 'light', bulbs: 'light',
  switch: 'switch', switches: 'switch', outlet: 'outlet', outlets: 'outlet', plug: 'outlet', plugs: 'outlet', socket: 'outlet',
  fan: 'fan', fans: 'fan',
  cover: 'cover', covers: 'cover', blind: 'cover', blinds: 'cover', shade: 'cover', shades: 'cover',
  curtain: 'cover', curtains: 'cover', shutter: 'cover', shutters: 'cover', garage: 'cover', door: 'cover',
  speaker: 'speaker', speakers: 'speaker', media_player: 'media_player', player: 'media_player', tv: 'tv', television: 'tv',
  thermostat: 'thermostat', climate: 'thermostat', heating: 'thermostat', ac: 'thermostat',
  lock: 'lock', locks: 'lock',
  humidifier: 'humidifier', input_boolean: 'input_boolean', toggle: 'input_boolean',
  scene: 'scene', scenes: 'scene', script: 'script', scripts: 'script', automation: 'automation', automations: 'automation',
};

function typeMatches(entity, type) {
  var wanted = TYPE_WORDS[lower(type)] || lower(type);
  if (wanted === 'media_player') return entity.domain === 'media_player';
  return entity.domain === wanted || deviceType(entity) === wanted;
}

/**
 * Name match: exact name or id first, then substring, then without a trailing kind word.
 * `exact` says whether the user named these devices outright.
 */
function byName(candidates, name) {
  var wanted = lower(name);
  var exact = candidates.filter(function (e) { return lower(e.name) === wanted || lower(e.id) === wanted; });
  if (exact.length) return { matches: exact, exact: true };
  var partial = candidates.filter(function (e) { return lower(e.name).indexOf(wanted) !== -1; });
  if (partial.length) return { matches: partial, exact: false };
  var words = wanted.split(/\s+/);
  if (words.length > 1 && TYPE_WORDS[words[words.length - 1]]) {
    var kind = words.pop();
    var rest = words.join(' ');
    return {
      matches: candidates.filter(function (e) { return lower(e.name).indexOf(rest) !== -1 && typeMatches(e, kind); }),
      // "Desk lamp" names a kind, so it isn't narrowed further.
      exact: true,
    };
  }
  return { matches: [], exact: false };
}

// A type that means every kind of device, for "turn off everything in the kitchen".
var ALL_TYPES = ['all', 'everything', 'any', 'device', 'devices'];
// Words around a kind that don't narrow it: "the lights", "all lights".
var FILLER = ['the', 'all', 'my', 'every'];

function lightsOnly(entities) {
  return entities.filter(function (e) { return e.domain === 'light'; });
}

/** The kind a name means when it names only a kind ("lights", "the lamps"), or null. */
function kindNamed(name) {
  var words = lower(name).split(/\s+/).filter(function (w) { return w && FILLER.indexOf(w) === -1; });
  return words.length === 1 && TYPE_WORDS[words[0]] ? words[0] : null;
}

/**
 * The entities an action's arguments pick out, among those of the given domains. Either a tile's
 * `item` + `instanceId`, or any of `name`, `room` and `type` together.
 *
 * Lights stay lights: anything read from home/home_lights or home/room_lights, the id "home", a
 * type of light, or a name that only says "lights" never reaches other kinds of device. A room
 * on its own, with no kind, means everything in it.
 */
function resolve(snap, args, domains) {
  var capable = snap.entities.filter(function (e) { return domains.indexOf(e.domain) !== -1; });
  var id = args.instanceId != null ? String(args.instanceId) : '';
  var type = lower(args.type);
  if (ALL_TYPES.indexOf(type) !== -1) type = '';
  var name = lower(args.name);
  // "Turn on the lights" can arrive as a name rather than a type.
  var kind = name && !type ? kindNamed(name) : null;
  if (kind && !capable.some(function (e) { return lower(e.name) === name; })) {
    type = kind;
    name = '';
  }

  if (id) {
    // "home" is home/home_lights' only instance: the home's lights, whatever item came with it.
    if (args.item === 'home_lights' || id === HOME_ID) return lightsOnly(capable);
    var entity = capable.filter(function (e) { return e.id === id; });
    if (entity.length) return entity;
    // A room's id, from home/room_lights (its lights) or given as a bare area id (all of it).
    var area = snap.areas.filter(function (a) { return a.id === id; })[0];
    if (area) {
      var inArea = capable.filter(function (e) { return e.areaId === area.id; });
      if (args.item === 'room_lights') return lightsOnly(inArea);
      return type ? inArea.filter(function (e) { return typeMatches(e, type); }) : inArea;
    }
    if (snap.entities.some(function (e) { return e.id === id; })) {
      throw PluginError('INVALID_ARGS', 'That device cannot do this.');
    }
    throw PluginError('INVALID_ARGS', 'No device or room with id ' + id + '.');
  }

  var room = lower(args.room);
  if (!name && !room && !type && !args.type) {
    throw PluginError('INVALID_ARGS', 'Say which device: give instanceId, or a name, room or type. For every light in the home, use type "light".');
  }
  var matches = capable;
  if (room) {
    var areas = snap.areas.filter(function (a) { return lower(a.name) === room || lower(a.id) === room; });
    if (!areas.length) throw PluginError('INVALID_ARGS', 'No room called ' + args.room + '.');
    matches = matches.filter(function (e) { return areas.some(function (a) { return a.id === e.areaId; }); });
  }
  if (type) matches = matches.filter(function (e) { return typeMatches(e, type); });
  if (name) matches = byName(matches, name).matches;
  if (!matches.length) throw PluginError('INVALID_ARGS', 'No devices matched.');
  return matches;
}

// ---------------------------------------------------------------- calling services

/** Calls `domain.service` for each group of entities, all at once; resolves to how many worked. */
async function call(groups) {
  var outcomes = await Promise.all(groups.map(function (group) {
    var body = Object.assign({ entity_id: group.entities.map(function (e) { return e.id; }) }, group.data || {});
    return ha('/api/services/' + group.domain + '/' + group.service, 'POST', body)
      .then(function () { return { ok: true, count: group.entities.length }; })
      .catch(function (e) { return { ok: false, count: group.entities.length, error: e }; });
  }));
  var done = outcomes.filter(function (o) { return o.ok; });
  var failed = outcomes.filter(function (o) { return !o.ok; });
  if (!done.length) throw failed[0].error;
  return {
    done: done.reduce(function (n, o) { return n + o.count; }, 0),
    failed: failed.reduce(function (n, o) { return n + o.count; }, 0),
  };
}

/** Entities split by domain, each domain to the service `serviceFor(domain)` names. */
function byDomain(entities, serviceFor, data) {
  var groups = {};
  entities.forEach(function (e) {
    var service = serviceFor(e.domain);
    if (!service) return;
    var key = e.domain + '/' + service;
    if (!groups[key]) groups[key] = { domain: e.domain, service: service, data: data, entities: [] };
    groups[key].entities.push(e);
  });
  return Object.keys(groups).map(function (key) { return groups[key]; });
}

var SWITCHABLE = ['light', 'switch', 'fan', 'cover', 'media_player', 'climate', 'input_boolean', 'humidifier'];

function onOffService(on) {
  return function (domain) {
    if (domain === 'cover') return on ? 'open_cover' : 'close_cover';
    return on ? 'turn_on' : 'turn_off';
  };
}

function clamp(value, min, max) {
  var n = Number(value);
  if (!isFinite(n)) throw PluginError('INVALID_ARGS', 'Expected a number.');
  return Math.max(min, Math.min(max, n));
}

function describe(entities) {
  if (entities.length === 1) return entities[0].name;
  return entities.length + ' devices';
}

function summary(verb, entities, result) {
  var text = verb + ' ' + describe(entities) + '.';
  if (result.failed) text += ' ' + result.failed + ' did not respond.';
  return text;
}

// Each action: which domains it can act on, and what it does to the entities it resolved to.
var ACTIONS = {
  set_on: {
    domains: SWITCHABLE,
    run: async function (targets, args) {
      var on = !!args.on;
      return summary(on ? 'Turned on' : 'Turned off', targets, await call(byDomain(targets, onOffService(on))));
    },
  },
  toggle: {
    domains: SWITCHABLE,
    run: async function (targets) {
      // A room or the home goes off if anything in it is on, as a wall switch would.
      var on = !targets.some(function (e) { return isOn(e); });
      return summary(on ? 'Turned on' : 'Turned off', targets, await call(byDomain(targets, onOffService(on))));
    },
  },
  set_brightness: {
    domains: ['light'],
    run: async function (targets, args) {
      var percent = Math.round(clamp(args.percent, 0, 100));
      if (percent === 0) {
        return summary('Turned off', targets, await call(byDomain(targets, onOffService(false))));
      }
      var result = await call(byDomain(targets, onOffService(true), { brightness_pct: percent }));
      return summary('Set ' + percent + '% on', targets, result);
    },
  },
  set_color_temperature: {
    domains: ['light'],
    run: async function (targets, args) {
      var kelvin = Math.round(clamp(args.kelvin, 1000, 10000));
      var supported = targets.filter(function (e) {
        var modes = e.attrs.supported_color_modes || [];
        return modes.indexOf('color_temp') !== -1 || modes.indexOf('hs') !== -1 || modes.indexOf('xy') !== -1 ||
          modes.indexOf('rgb') !== -1 || modes.indexOf('rgbw') !== -1 || modes.indexOf('rgbww') !== -1;
      });
      if (!supported.length) throw PluginError('INVALID_ARGS', 'None of those lights can change colour temperature.');
      return summary('Set ' + kelvin + 'K on', supported, await call(byDomain(supported, onOffService(true), { color_temp_kelvin: kelvin })));
    },
  },
  set_color: {
    domains: ['light'],
    run: async function (targets, args) {
      var color = lower(args.color).replace(/\s+/g, '');
      if (!/^[a-z]+$/.test(color)) throw PluginError('INVALID_ARGS', 'Give a colour name such as red or blue.');
      var supported = targets.filter(function (e) {
        var modes = e.attrs.supported_color_modes || [];
        return ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].some(function (mode) { return modes.indexOf(mode) !== -1; });
      });
      if (!supported.length) throw PluginError('INVALID_ARGS', 'None of those lights can change colour.');
      return summary('Set ' + args.color + ' on', supported, await call(byDomain(supported, onOffService(true), { color_name: color })));
    },
  },
  set_volume: {
    domains: ['media_player'],
    run: async function (targets, args) {
      var percent = Math.round(clamp(args.percent, 0, 100));
      var result = await call(byDomain(targets, function () { return 'volume_set'; }, { volume_level: percent / 100 }));
      return summary('Set volume to ' + percent + '% on', targets, result);
    },
  },
  set_muted: {
    domains: ['media_player'],
    run: async function (targets, args) {
      var muted = !!args.muted;
      var result = await call(byDomain(targets, function () { return 'volume_mute'; }, { is_volume_muted: muted }));
      return summary(muted ? 'Muted' : 'Unmuted', targets, result);
    },
  },
  media_control: {
    domains: ['media_player'],
    run: async function (targets, args) {
      var services = { play: 'media_play', pause: 'media_pause', play_pause: 'media_play_pause', stop: 'media_stop', next: 'media_next_track', previous: 'media_previous_track' };
      var service = services[args.command];
      if (!service) throw PluginError('INVALID_ARGS', 'Unknown command ' + args.command + '.');
      var verbs = { play: 'Playing on', pause: 'Paused', play_pause: 'Toggled playback on', stop: 'Stopped', next: 'Skipped forward on', previous: 'Skipped back on' };
      return summary(verbs[args.command], targets, await call(byDomain(targets, function () { return service; })));
    },
  },
  set_thermostat: {
    domains: ['climate'],
    run: async function (targets, args) {
      var said = [];
      var modeGroups = [];
      var tempGroups = [];
      if (args.mode) {
        modeGroups = byDomain(targets, function () { return 'set_hvac_mode'; }, { hvac_mode: args.mode });
        said.push(args.mode);
      }
      var c = args.temperature_c;
      var f = args.temperature_f;
      if (c != null || f != null) {
        var unit = await temperatureUnit();
        var fahrenheit = unit.indexOf('F') !== -1;
        var target = c != null
          ? (fahrenheit ? Number(c) * 9 / 5 + 32 : Number(c))
          : (fahrenheit ? Number(f) : (Number(f) - 32) * 5 / 9);
        if (!isFinite(target)) throw PluginError('INVALID_ARGS', 'Expected a temperature.');
        target = Math.round(target * 2) / 2;
        tempGroups = byDomain(targets, function () { return 'set_temperature'; }, { temperature: target });
        said.push(target + unit);
      }
      if (!said.length) throw PluginError('INVALID_ARGS', 'Give a temperature, a mode, or both.');
      // The mode first, so a setpoint lands in the mode it was meant for.
      var result = modeGroups.length ? await call(modeGroups) : null;
      if (tempGroups.length) {
        var temps = await call(tempGroups);
        result = result ? { done: Math.min(result.done, temps.done), failed: Math.max(result.failed, temps.failed) } : temps;
      }
      return summary('Set ' + said.join(', ') + ' on', targets, result);
    },
  },
  lock: {
    domains: ['lock'],
    run: async function (targets) {
      return summary('Locked', targets, await call(byDomain(targets, function () { return 'lock'; })));
    },
  },
  unlock: {
    domains: ['lock'],
    run: async function (targets, args) {
      var data = args.code ? { code: String(args.code) } : undefined;
      return summary('Unlocked', targets, await call(byDomain(targets, function () { return 'unlock'; }, data)));
    },
  },
  run_automation: {
    domains: AUTOMATION_DOMAINS,
    run: async function (targets, args) {
      // A name like "Good night" can match a scene and the script behind it; run only the best kind.
      if (!args.instanceId && targets.length > 1) {
        var exact = targets.filter(function (e) { return lower(e.name) === lower(args.name); });
        if (exact.length) targets = exact;
        if (targets.length > 1) {
          throw PluginError('INVALID_ARGS', 'That matches ' + targets.length + ' automations: ' +
            targets.slice(0, 5).map(function (e) { return e.name; }).join(', ') + '. Which one?');
        }
      }
      var result = await call(byDomain(targets, function (domain) {
        return domain === 'automation' ? 'trigger' : 'turn_on';
      }));
      return summary('Started', targets, result);
    },
  },
};

Pebble.registerActionHandler(async function (request, respond) {
  try {
    var action = ACTIONS[request.action];
    if (!action) throw PluginError('INVALID_ARGS', 'Unknown action ' + request.action + '.');
    var args = request.args || {};
    var targets = resolve(await snapshot(), args, action.domains);
    if (!targets.length) throw PluginError('INVALID_ARGS', 'Nothing there can do that.');
    var text = await action.run(targets, args);
    respond.ok({ text: text, refreshed: SOURCES });
  } catch (e) {
    console.error(request.action + ' failed: ' + (e.code || e));
    respond.error(e.code || 'PLUGIN_UNAVAILABLE', e.message);
  }
});

// ---------------------------------------------------------------- settings page

// The settings page can't reach a plain-HTTP server on the LAN, so it sends what the user typed
// here and the plugin does the networking.
Pebble.registerConfigHandler(async function (message, respond) {
  try {
    var current = state();
    switch (message && message.type) {
      case 'status': {
        // Addresses whose permission the user hasn't turned on yet, so the page can say so when
        // they come back from approving it. Only a query: nothing is requested.
        var waiting = [];
        var configured = [['local', current.localUrl], ['remote', current.remoteUrl]];
        for (var c = 0; c < configured.length; c++) {
          if (!configured[c][1]) continue;
          var permission = await permissionState(configured[c][1]);
          if (permission === 'prompt' || permission === 'denied') {
            waiting.push({ which: configured[c][0], message: unreachableMessage(await unreachable(configured[c][1])) });
          }
        }
        respond({
          localUrl: current.localUrl,
          remoteUrl: current.remoteUrl,
          hasToken: !!(await token()),
          waiting: waiting,
        });
        return;
      }

      case 'connect': {
        var localUrl = normalizeUrl(message.localUrl);
        var remoteUrl = normalizeUrl(message.remoteUrl);
        if (!localUrl && !remoteUrl) {
          respond({ error: 'Enter the address of your Home Assistant.' });
          return;
        }
        // A blank token field keeps the saved one.
        var newToken = String(message.token || '').trim();
        var accessToken = newToken || (await token());
        if (!accessToken) {
          respond({ error: 'Paste a long-lived access token.' });
          return;
        }
        // Check every address given, so a typo in the remote one doesn't wait to show up until
        // the user is away from home.
        var checked = [];
        var urls = [['local', localUrl], ['remote', remoteUrl]].filter(function (pair) { return pair[1]; });
        var reached = [];
        for (var i = 0; i < urls.length; i++) {
          try {
            var info = await ha('/api/config', 'GET', null, {
              localUrl: urls[i][1], remoteUrl: null, preferred: 'local', token: accessToken,
            });
            reached.push(urls[i][0]);
            checked.push({ which: urls[i][0], ok: true, name: info && info.location_name, version: info && info.version, unit: info && info.unit_system && info.unit_system.temperature });
          } catch (e) {
            if (e.code === 'AUTH_REQUIRED') {
              respond({ error: e.message });
              return;
            }
            checked.push({ which: urls[i][0], ok: false, error: e.message, unreachable: e.unreachable || null });
          }
        }
        if (!reached.length) {
          var failed = checked.filter(function (check) { return check.unreachable; });
          var blocked = failed.filter(function (check) {
            return check.unreachable.state === 'prompt' || check.unreachable.state === 'denied';
          })[0];
          var shown = blocked || checked[0];
          // Nothing answered because a permission isn't on yet, or maybe so: keep what the user
          // typed, so they only have to approve it and press Connect again.
          var keep = failed.length === checked.length && failed.some(function (check) {
            var why = check.unreachable;
            return why.state === 'prompt' || why.state === 'denied' || (why.state == null && !why.local);
          });
          if (keep) {
            if (newToken) await Pebble.secureStorage.setItem(TOKEN_KEY, newToken);
            saveState({ localUrl: localUrl, remoteUrl: remoteUrl });
          }
          respond({ error: shown.error, saved: keep, checked: checked });
          return;
        }
        var good = checked.filter(function (c) { return c.ok; })[0];
        if (newToken) await Pebble.secureStorage.setItem(TOKEN_KEY, newToken);
        saveState({ localUrl: localUrl, remoteUrl: remoteUrl, preferred: reached[0], tempUnit: good.unit || null });
        Pebble.refreshSources(SOURCES);
        respond({ ok: true, name: good.name, version: good.version, checked: checked });
        return;
      }

      case 'areas': {
        var areas = await readAreas();
        var hidden = state().hidden;
        respond({
          // Hidden areas are listed here, unlike everywhere else: this is where they come back.
          areas: areas.map(function (area) {
            return { id: area.id, name: area.name || area.id, count: (area.entities || []).length, hidden: hidden.indexOf(area.id) !== -1 };
          }),
        });
        return;
      }

      case 'setHidden': {
        var next = state().hidden.filter(function (id) { return id !== String(message.id); });
        if (message.hidden) next.push(String(message.id));
        saveState({ hidden: next });
        Pebble.refreshSources(SOURCES);
        respond({ id: message.id, hidden: !!message.hidden });
        return;
      }

      case 'forget':
        await Pebble.secureStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(STORE_KEY);
        Pebble.refreshSources(SOURCES);
        respond({ localUrl: null, remoteUrl: null, hasToken: false });
        return;

      default:
        respond({ error: 'unknown message type' });
    }
  } catch (e) {
    respond({ error: e.message });
  }
});
