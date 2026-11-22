var API_ROOT = 'https://workflowy.com/api/v1';
var KEY_KEY = 'workflowy_api_key';
var CONFIG_KEY = 'workflowy.config.v1';
var TARGETS_KEY = 'workflowy.targets.v1';
var TARGETS_MAX_AGE_MS = 10 * 60 * 1000;
var NOTE_ID = 'workflowy';
var DEFAULT_TARGET = 'inbox';
var REFRESHED = ['notes/destination', 'notes/configured', 'reminders/list', 'reminders/configured'];

// Without Pebble.permissions the host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['workflowy.com', 'https://workflowy.com/']];
var BLOCKED_KEY = 'workflowy.blocked.v1';

// Resolves with the first domain whose request fails, or null once every request has answered.
function unreachableHost() {
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve().then(function () { return fetch(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
async function blockedHost() {
  var permissions = typeof Pebble !== 'undefined' && Pebble.permissions;
  if (permissions) {
    for (var i = 0; i < PROBES.length; i++) {
      if (await permissions.query('Internet/' + PROBES[i][0]) !== 'granted') return { host: PROBES[i][0], sure: true };
    }
    return null;
  }
  var host = await unreachableHost();
  return host && { host: host, sure: false };
}

async function checkReach() {
  var blocked = await blockedHost();
  try {
    if (blocked) localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
    else localStorage.removeItem(BLOCKED_KEY);
  } catch (e) {}
  return blocked;
}

function lastBlocked() {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function blockedMessage(blocked) {
  return 'Workflowy doesn\'t have permission to connect to ' + blocked.host + '. Turn on "Connect to ' + blocked.host + '" in Workflowy\'s Permissions' + (blocked.sure ? '.' : ', or check your internet connection.');
}

// Probes have no deadline, so an error answers from the last check and starts a new one.
function unreachableMessage(fallback, error) {
  var blocked = null;
  try {
    blocked = error && error.name === 'NotAllowedError' ? { host: PROBES[0][0], sure: true } : lastBlocked();
    checkReach().catch(function () {});
  } catch (e) {}
  return blocked ? blockedMessage(blocked) : fallback;
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || null;
  } catch (e) {
    return null;
  }
}

function settings() {
  var stored = readJson(CONFIG_KEY) || {};
  return {
    noteTarget: stringValue(stored.noteTarget) || DEFAULT_TARGET,
    reminderTarget: stringValue(stored.reminderTarget) || DEFAULT_TARGET,
  };
}

async function apiKey() {
  return stringValue(await Pebble.secureStorage.getItem(KEY_KEY));
}

async function request(key, method, path, body) {
  try {
    var options = { method: method, headers: { 'Authorization': 'Bearer ' + key } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    var response = await fetch(API_ROOT + path, options);
    var json = null;
    try { json = JSON.parse(await response.text()); } catch (e) {}
    return { status: response.status, json: json };
  } catch (error) {
    console.error('Workflowy request failed: ' + (error && error.name));
    return { status: 0, json: null, cause: error };
  }
}

// Every target but the calendar root: that one is a container for days, not a place to put things.
function cleanTargets(raw) {
  return (Array.isArray(raw) ? raw : []).filter(function (target) {
    return target && typeof target.key === 'string' && target.key && target.key !== 'calendar';
  }).map(function (target) {
    return { key: target.key, name: stringValue(target.name) || target.key, type: target.type === 'shortcut' ? 'shortcut' : 'system' };
  });
}

async function loadTargets(key) {
  var response = await request(key, 'GET', '/targets');
  if (response.status !== 200 || !response.json || !Array.isArray(response.json.targets)) return { response: response };
  var targets = cleanTargets(response.json.targets);
  try { localStorage.setItem(TARGETS_KEY, JSON.stringify({ at: Date.now(), targets: targets })); } catch (e) {}
  return { targets: targets, response: response };
}

// Cached list, refreshed when stale; the cache answers when Workflowy can't.
async function targets(key, fresh) {
  var cached = readJson(TARGETS_KEY);
  if (!fresh && cached && Array.isArray(cached.targets) && Date.now() - cached.at < TARGETS_MAX_AGE_MS) return cached.targets;
  var loaded = await loadTargets(key);
  if (loaded.targets) return loaded.targets;
  return cached && Array.isArray(cached.targets) ? cached.targets : [];
}

var SYSTEM_TARGETS = [
  { key: 'inbox', name: 'Inbox', type: 'system' },
  { key: 'today', name: 'Today', type: 'system' },
  { key: 'tomorrow', name: 'Tomorrow', type: 'system' },
  { key: 'next_week', name: 'Next Week', type: 'system' },
];

function hasTarget(list, key) {
  return list.some(function (target) { return target.key === key; });
}

// Where a write may go: { list, verified }. A fresh cache that has the place answers; otherwise Workflowy is
// asked. If it can't answer, only the built-in places are trusted, since a cached shortcut may be gone.
async function writableTargets(key, wanted) {
  var cached = readJson(TARGETS_KEY);
  var list = cached && Array.isArray(cached.targets) ? cached.targets : [];
  if (cached && Date.now() - cached.at < TARGETS_MAX_AGE_MS && hasTarget(list, wanted)) return { list: list, verified: true };
  var loaded = await loadTargets(key);
  if (loaded.targets) return { list: loaded.targets, verified: true };
  return { list: SYSTEM_TARGETS, verified: false, response: loaded.response };
}

// The parent for a write, or null after answering with why it can't be used. Nothing has been sent yet,
// so every failure here is certain.
async function resolveParent(key, wanted, configured, respond) {
  var found = await writableTargets(key, wanted);
  if (hasTarget(found.list, wanted)) return { key: wanted, list: found.list };
  if (!found.verified) {
    var status = found.response && found.response.status;
    if (status === 401 || status === 403 || status === 429) {
      var failed = failure(found.response, 'request');
      respond.error(failed.code, failed.message);
    } else {
      respond.error('UNKNOWN', unreachableMessage('Could not reach Workflowy.', found.response && found.response.cause) + ' Nothing was saved; try again.');
    }
  } else if (configured) {
    respond.error('INVALID_ARGS', '"' + wanted + '" is no longer in Workflowy. Choose another place in Workflowy\'s settings.');
  } else {
    respond.error('INVALID_ARGS', 'instanceId must be a list from reminders/list.');
  }
  return null;
}

function targetName(list, key) {
  var match = list.filter(function (target) { return target.key === key; })[0];
  return match ? match.name : key;
}

function pad(number) { return String(number).padStart(2, '0'); }

function parseRfc3339(value) {
  if (typeof value !== 'string') return null;
  var match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?([zZ]|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  var year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  var hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || 0);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
      hour > 23 || minute > 59 || second > 59) return null;
  var offset = 0;
  if (match[7].toUpperCase() !== 'Z') {
    if (Number(match[7].slice(1, 3)) > 14 || Number(match[7].slice(4, 6)) > 59) return null;
    offset = (Number(match[7].slice(1, 3)) * 60 + Number(match[7].slice(4, 6))) * (match[7][0] === '-' ? -1 : 1);
  }
  var instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000);
  return isNaN(instant.getTime()) ? null : instant;
}

function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0));
    return true;
  } catch (e) {
    return false;
  }
}

// Wall-clock date and time of an instant in a time zone (the phone's when none is given).
function wallClock(date, timeZone) {
  if (!timeZone) {
    return { date: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()), time: pad(date.getHours()) + ':' + pad(date.getMinutes()) };
  }
  var parts = {};
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).forEach(function (part) { parts[part.type] = part.value; });
  return { date: parts.year + '-' + parts.month + '-' + parts.day, time: parts.hour + ':' + parts.minute };
}

// The first line is the bullet; anything after it goes in the bullet's note.
function splitText(text) {
  var normalized = String(text).replace(/\r\n?/g, '\n').trim();
  var newline = normalized.indexOf('\n');
  if (newline === -1) return { name: normalized, note: '' };
  return { name: normalized.slice(0, newline).trim(), note: normalized.slice(newline + 1).trim() };
}

function nodeUrl(id) {
  var hex = String(id || '').replace(/-/g, '');
  return hex.length >= 12 ? 'https://workflowy.com/#/' + hex.slice(-12) : 'https://workflowy.com/';
}

function failure(response, what) {
  console.error('Workflowy ' + what + ' failed: HTTP ' + response.status);
  if (response.status === 401 || response.status === 403) {
    return { code: 'AUTH_REQUIRED', message: 'Workflowy rejected the API key. Paste a new one in Workflowy\'s settings.' };
  }
  if (response.status === 404) {
    return { code: 'INVALID_ARGS', message: 'That place no longer exists in Workflowy. Choose another in Workflowy\'s settings.' };
  }
  if (response.status === 400) {
    return { code: 'INVALID_ARGS', message: 'Workflowy rejected the ' + what + '.' };
  }
  if (response.status === 429) {
    return { code: 'RATE_LIMITED', message: 'Workflowy is receiving requests too quickly. Try again shortly.' };
  }
  var uncertain = 'Workflowy may have saved this ' + what + ', but Pebble could not confirm it. Check Workflowy before retrying.';
  var blocked = response.status === 0 && unreachableMessage(null, response.cause);
  if (blocked) return { code: 'UNKNOWN', message: blocked + ' Workflowy may have saved this ' + what + ', so check before retrying.' };
  return { code: 'UNKNOWN', message: uncertain };
}

async function createNode(key, parent, name, note, layoutMode, what, respond) {
  var body = { parent_id: parent, name: name, layoutMode: layoutMode, position: 'top' };
  if (note) body.note = note;
  var response = await request(key, 'POST', '/nodes', body);
  if (response.status !== 200 || !response.json || !response.json.item_id) {
    var failed = failure(response, what);
    respond.error(failed.code, failed.message);
    return null;
  }
  return response.json.item_id;
}

function shortText(text) { return { shortText: { text: String(text) } }; }
function longText(text) { return { longText: { text: String(text) } }; }
function boolText(value) { return { boolean: { value: !!value }, shortText: { text: value ? 'Connected' : 'Not connected' } }; }

function single(instanceId, properties) {
  return { validUntilMs: Date.now() + 60000, instances: [{ instanceId: instanceId, properties: properties }] };
}

Pebble.registerSourceHandler(async function (req, respond) {
  var key = await apiKey();
  var current = settings();
  if (req.item === 'configured' && (req.category === 'notes' || req.category === 'reminders')) {
    respond.data(single(req.category === 'notes' ? NOTE_ID : 'workflowy-reminders', { name: shortText('Workflowy'), configured: boolText(!!key) }));
    return;
  }
  if (req.category === 'notes' && req.item === 'destination') {
    var noteList = key ? await targets(key) : [];
    respond.data(single(NOTE_ID, {
      name: shortText('Workflowy'),
      configured: boolText(!!key),
      location: { shortText: { text: targetName(noteList, current.noteTarget) }, longText: { text: 'Top of ' + targetName(noteList, current.noteTarget) + ' in Workflowy' } },
    }));
    return;
  }
  if (req.category === 'reminders' && req.item === 'list') {
    var list = key ? await targets(key) : [];
    respond.data({
      validUntilMs: Date.now() + 60000,
      instances: list.map(function (target) {
        return {
          instanceId: target.key,
          properties: {
            name: shortText(target.name),
            destination: shortText(target.key === current.reminderTarget ? 'Workflowy (default)' : 'Workflowy'),
            url: longText('https://workflowy.com/'),
          },
        };
      }),
    });
    return;
  }
  console.error('Unsupported source: ' + req.category + '/' + req.item);
  respond.error('PLUGIN_UNAVAILABLE', 'Unsupported Workflowy source.');
});

async function createNote(args, key, respond) {
  if (args.instanceId !== undefined && args.instanceId !== NOTE_ID) {
    respond.error('INVALID_ARGS', 'instanceId must be ' + NOTE_ID + '.');
    return;
  }
  if (typeof args.text !== 'string' || !args.text.trim()) {
    respond.error('INVALID_ARGS', 'text must not be empty.');
    return;
  }
  var parts = splitText(args.text);
  var parent = await resolveParent(key, settings().noteTarget, true, respond);
  if (!parent) return;
  var id = await createNode(key, parent.key, parts.name, parts.note, 'bullets', 'note', respond);
  if (id) respond.ok({ text: 'Added to ' + targetName(parent.list, parent.key) + ' in Workflowy.', url: nodeUrl(id) });
}

async function createReminder(args, key, respond) {
  if (typeof args.title !== 'string' || !args.title.trim()) {
    respond.error('INVALID_ARGS', 'title must not be empty.');
    return;
  }
  var due = null;
  if (args.due_iso !== undefined) {
    due = parseRfc3339(args.due_iso);
    if (!due) {
      respond.error('INVALID_ARGS', 'due_iso must be an RFC3339 instant with a UTC offset.');
      return;
    }
  }
  if (args.timezone !== undefined && (typeof args.timezone !== 'string' || !validTimeZone(args.timezone))) {
    respond.error('INVALID_ARGS', 'timezone must be an IANA time-zone name.');
    return;
  }
  if (args.instanceId !== undefined && (typeof args.instanceId !== 'string' || !args.instanceId)) {
    respond.error('INVALID_ARGS', 'instanceId must be a list from reminders/list.');
    return;
  }
  var name = splitText(args.title).name;
  var when = due && wallClock(due, args.timezone);
  if (when) name += ' [' + when.date + ' ' + when.time + ']';
  var parent, place;
  if (args.instanceId === undefined && when) {
    // A dated reminder with no list goes on its day in the Workflowy calendar.
    parent = when.date;
    place = 'the ' + when.date + ' calendar day';
  } else {
    var resolved = await resolveParent(key, args.instanceId === undefined ? settings().reminderTarget : args.instanceId, args.instanceId === undefined, respond);
    if (!resolved) return;
    parent = resolved.key;
    place = targetName(resolved.list, parent);
  }
  var id = await createNode(key, parent, name, '', 'todo', 'reminder', respond);
  if (!id) return;
  respond.ok({ text: 'Added a todo to ' + place + ' in Workflowy. Workflowy doesn\'t send alerts.', url: nodeUrl(id) });
}

Pebble.registerActionHandler(async function (req, respond) {
  if (req.action !== 'create_note' && req.action !== 'create_reminder') {
    console.error('Unsupported action: ' + req.action);
    respond.error('PLUGIN_UNAVAILABLE', 'Unsupported Workflowy action.');
    return;
  }
  var key = await apiKey();
  if (!key) {
    respond.error('AUTH_REQUIRED', 'Paste your Workflowy API key in Workflowy\'s settings first.');
    return;
  }
  var args = req.args || {};
  if (req.action === 'create_note') await createNote(args, key, respond);
  else await createReminder(args, key, respond);
});

function validateKey(value) {
  var key = stringValue(value);
  if (!key) return { error: 'Paste your Workflowy API key.' };
  if (key.length > 256 || /\s/.test(key)) return { error: 'That doesn\'t look like a Workflowy API key.' };
  return { value: key };
}

function chosenTarget(list, value) {
  var key = stringValue(value) || DEFAULT_TARGET;
  return list.some(function (target) { return target.key === key; }) ? key : DEFAULT_TARGET;
}

// list: places just loaded, if any. Otherwise the settings page asks Workflowy each time it opens, so a
// shortcut made since shows up.
async function status(list) {
  var key = await apiKey();
  var current = settings();
  return { configured: !!key, noteTarget: current.noteTarget, reminderTarget: current.reminderTarget, targets: key ? list || await targets(key, true) : [] };
}

Pebble.registerConfigHandler(async function (message, respond) {
  switch (message && message.type) {
    case 'reach':
      respond({ blocked: await checkReach().catch(function () { return null; }) });
      return;

    case 'status':
      respond(await status());
      return;

    case 'save': {
      var keyResult = validateKey(stringValue(message.apiKey) || await apiKey());
      if (keyResult.error) {
        respond({ error: keyResult.error });
        return;
      }
      // Listing targets is read-only, so it checks the key without writing anything.
      var loaded = await loadTargets(keyResult.value);
      if (!loaded.targets) {
        var failed = failure(loaded.response, 'request');
        respond({ error: failed.code === 'UNKNOWN' ? unreachableMessage('Could not reach Workflowy. Check your connection and try again.', loaded.response.cause) : failed.message });
        return;
      }
      await Pebble.secureStorage.setItem(KEY_KEY, keyResult.value);
      localStorage.setItem(CONFIG_KEY, JSON.stringify({
        noteTarget: chosenTarget(loaded.targets, message.noteTarget),
        reminderTarget: chosenTarget(loaded.targets, message.reminderTarget),
      }));
      Pebble.refreshSources(REFRESHED);
      respond(await status(loaded.targets));
      return;
    }

    case 'unlink':
    case 'disconnect':
      await Pebble.secureStorage.removeItem(KEY_KEY);
      localStorage.removeItem(CONFIG_KEY);
      localStorage.removeItem(TARGETS_KEY);
      Pebble.refreshSources(REFRESHED);
      respond(await status());
      return;

    default:
      respond({ error: 'Unknown message type.' });
  }
});
