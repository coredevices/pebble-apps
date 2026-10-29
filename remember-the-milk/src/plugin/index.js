// Remember The Milk plugin. Every RTM call is signed with the user's own API key and shared secret.

var API_URL = 'https://api.rememberthemilk.com/services/rest/';
var AUTH_URL = 'https://www.rememberthemilk.com/services/auth/';
var API_KEY_KEY = 'rtm_api_key';
var SECRET_KEY = 'rtm_shared_secret';
var TOKEN_KEY = 'rtm_auth_token';
var FROB_KEY = 'rtm_frob';
var LIST_REFRESH_MS = 15 * 60 * 1000;
var REMINDER_SOURCES = ['reminders/list', 'reminders/configured'];

// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['api.rememberthemilk.com', 'https://api.rememberthemilk.com/']];
var BLOCKED_KEY = 'remember-the-milk.blocked.v1';

// Resolves with the first domain whose request fails, or null once every request has answered.
function blockedHost() {
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve().then(function () { return fetch(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

async function checkReach() {
  var host = await blockedHost();
  try {
    if (host) localStorage.setItem(BLOCKED_KEY, host);
    else localStorage.removeItem(BLOCKED_KEY);
  } catch (e) {}
  return host;
}

function lastBlocked() {
  return localStorage.getItem(BLOCKED_KEY);
}

function blockedMessage(host) {
  return 'Remember The Milk doesn\'t have permission to connect to ' + host + '. Turn on "Connect to ' + host + '" in Remember The Milk\'s Permissions, or check your internet connection.';
}

// Probes have no deadline, so an error answers from the last check and starts a new one.
function unreachableMessage(fallback) {
  var host = null;
  try {
    host = lastBlocked();
    checkReach().catch(function () {});
  } catch (e) {}
  return host ? blockedMessage(host) : fallback;
}

function md5(text) {
  var bytes = unescape(encodeURIComponent(text));
  var words = [];
  for (var i = 0; i < bytes.length; i++) words[i >> 2] |= bytes.charCodeAt(i) << ((i % 4) * 8);
  words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8);
  var count = (((bytes.length + 8) >> 6) + 1) * 16;
  for (var w = words.length; w < count; w++) words[w] = words[w] | 0;
  words[count - 2] = bytes.length * 8;

  var shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var constants = [];
  for (var k = 0; k < 64; k++) constants[k] = Math.floor(Math.abs(Math.sin(k + 1)) * 4294967296) | 0;

  var h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
  for (var block = 0; block < count; block += 16) {
    var a = h[0], b = h[1], c = h[2], d = h[3];
    for (var j = 0; j < 64; j++) {
      var round = j >> 4, f, g;
      if (round === 0) { f = (b & c) | (~b & d); g = j; }
      else if (round === 1) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
      else if (round === 2) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * j) % 16; }
      var sum = (a + f + constants[j] + words[block + g]) | 0;
      var shift = shifts[round * 4 + (j % 4)];
      a = d; d = c; c = b;
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
  }

  var hex = '';
  for (var n = 0; n < 16; n++) hex += ('0' + ((h[n >> 2] >>> ((n % 4) * 8)) & 255).toString(16)).slice(-2);
  return hex;
}

function signedQuery(params, secret) {
  var keys = Object.keys(params).sort();
  var signature = secret;
  for (var i = 0; i < keys.length; i++) signature += keys[i] + params[keys[i]];
  return keys.map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]);
  }).join('&') + '&api_sig=' + md5(signature);
}

async function secureItem(key) {
  return String(await Pebble.secureStorage.getItem(key) || '').trim();
}

async function credentials() {
  return { apiKey: await secureItem(API_KEY_KEY), secret: await secureItem(SECRET_KEY), token: await secureItem(TOKEN_KEY) };
}

async function clearTokens() {
  await Pebble.secureStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(FROB_KEY);
}

function rtmError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** One signed RTM call; resolves to its `rsp` object or throws an Error with a plugin error code. */
async function call(creds, method, params) {
  var query = Object.assign({ method: method, api_key: creds.apiKey, format: 'json', v: '2' }, params || {});
  if (creds.token) query.auth_token = creds.token;
  var response;
  try {
    response = await fetch(API_URL + '?' + signedQuery(query, creds.secret));
  } catch (e) {
    console.error('Remember The Milk ' + method + ' failed: ' + e);
    throw rtmError('PLUGIN_UNAVAILABLE', unreachableMessage('Could not reach Remember The Milk.'));
  }
  if (response.status === 503) throw rtmError('RATE_LIMITED', 'Remember The Milk is rate limiting requests. Try again shortly.');
  var text = await response.text();
  var rsp = null;
  try {
    rsp = JSON.parse(text).rsp;
  } catch (e) {
    // Reported below with the HTTP status.
  }
  if (!rsp) {
    console.error('Remember The Milk ' + method + ': HTTP ' + response.status);
    throw rtmError('UNKNOWN', 'Remember The Milk failed (HTTP ' + response.status + ').');
  }
  if (rsp.stat !== 'ok') {
    var code = rsp.err && String(rsp.err.code);
    var message = rsp.err && rsp.err.msg || 'Unknown error';
    console.error('Remember The Milk ' + method + ': ' + code + ' ' + message);
    if (code === '98' || code === '99' || code === '101') throw rtmError('AUTH_REQUIRED', 'Remember The Milk sign-in is missing or expired.');
    if (code === '96' || code === '97' || code === '100') {
      throw rtmError('AUTH_REQUIRED', 'Remember The Milk did not accept the API key and shared secret.');
    }
    if (code === '105') throw rtmError('PLUGIN_UNAVAILABLE', 'Remember The Milk is unavailable. Try again later.');
    throw rtmError('UNKNOWN', 'Remember The Milk: ' + message);
  }
  return rsp;
}

function shortText(text) {
  return { shortText: { text: text } };
}

function longText(text) {
  return { longText: { text: text } };
}

function listUrl(listId) {
  return 'https://www.rememberthemilk.com/app/#list/' + listId;
}

function respondWithError(error, respond) {
  respond.error(error.code || 'UNKNOWN', error.message || 'Remember The Milk failed.');
}

/** An absolute ISO-8601 instant with Z or an offset, as RTM's UTC form; null if it is anything else. */
function rtmDue(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  var day = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  if (day.getUTCMonth() !== +match[2] - 1 || day.getUTCDate() !== +match[3] ||
      +match[4] > 23 || +match[5] > 59 || +match[6] > 59 || (match[9] && (+match[9] > 23 || +match[10] > 59))) return null;
  var date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d+Z$/, 'Z');
}

Pebble.registerSourceHandler(async function (request, respond) {
  var creds = await credentials();
  if (request.category === 'reminders' && request.item === 'configured') {
    var configured = creds.token.length > 0;
    respond.data({
      validUntilMs: Date.now() + 60 * 1000,
      instances: [{
        instanceId: 'remember-the-milk',
        properties: {
          name: shortText('Remember The Milk'),
          configured: { boolean: { value: configured }, shortText: { text: configured ? 'Connected' : 'Not connected' } },
        },
      }],
    });
    return;
  }
  if (request.category !== 'reminders' || request.item !== 'list') {
    respond.error('INVALID_REQUEST', 'Unsupported Remember The Milk source.');
    return;
  }
  if (!creds.token) {
    respond.error('AUTH_REQUIRED', 'Connect Remember The Milk in the plugin gear page.');
    return;
  }
  try {
    var rsp = await call(creds, 'rtm.lists.getList');
    var instances = asArray(rsp.lists && rsp.lists.list).filter(function (list) {
      return list && list.id && list.name && list.deleted !== '1' && list.archived !== '1' && list.smart !== '1';
    }).map(function (list) {
      return {
        instanceId: String(list.id),
        properties: {
          name: shortText(list.name),
          destination: shortText('Remember The Milk list'),
          url: longText(listUrl(list.id)),
        },
      };
    });
    respond.data({ validUntilMs: Date.now() + LIST_REFRESH_MS, instances: instances });
  } catch (error) {
    respondWithError(error, respond);
  }
});

Pebble.registerActionHandler(async function (request, respond) {
  if (request.action !== 'create_reminder') {
    respond.error('INVALID_REQUEST', 'Unsupported Remember The Milk action.');
    return;
  }
  var creds = await credentials();
  if (!creds.token) {
    respond.error('AUTH_REQUIRED', 'Connect Remember The Milk in the plugin gear page.');
    return;
  }

  var args = request.args || {};
  var title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) {
    respond.error('INVALID_ARGS', 'title must not be empty.');
    return;
  }
  var add = { name: title, parse: '0' };
  if (args.instanceId !== undefined) {
    if (typeof args.instanceId !== 'string' || !args.instanceId.trim()) {
      respond.error('INVALID_ARGS', 'instanceId must be a non-empty Remember The Milk list ID.');
      return;
    }
    add.list_id = args.instanceId.trim();
  }
  var due = null;
  if (args.due_iso !== undefined) {
    due = typeof args.due_iso === 'string' ? rtmDue(args.due_iso) : null;
    if (!due) {
      respond.error('INVALID_ARGS', 'due_iso must be an absolute ISO-8601 date-time with Z or a numeric offset.');
      return;
    }
    if (typeof args.timezone !== 'string' || !args.timezone.trim()) {
      respond.error('INVALID_ARGS', 'timezone is required with due_iso.');
      return;
    }
  }

  try {
    var timeline = (await call(creds, 'rtm.timelines.create')).timeline;
    add.timeline = timeline;
    var list = (await call(creds, 'rtm.tasks.add', add)).list || {};
    var series = asArray(list.taskseries)[0] || {};
    var task = asArray(series.task)[0] || {};
    if (!list.id || !series.id || !task.id) {
      respond.error('UNKNOWN', 'Remember The Milk created no identifiable task.');
      return;
    }
    var text = 'Created “' + title + '” in Remember The Milk.';
    if (due) {
      try {
        await call(creds, 'rtm.tasks.setDueDate', {
          timeline: timeline, list_id: list.id, taskseries_id: series.id, task_id: task.id,
          due: due, has_due_time: '1', parse: '0',
        });
      } catch (error) {
        text = 'Created “' + title + '” in Remember The Milk, but could not set its due time: ' + error.message;
      }
    }
    respond.ok({ text: text, url: listUrl(list.id) + '/' + task.id });
  } catch (error) {
    respondWithError(error, respond);
  }
});

Pebble.registerConfigHandler(async function (message, respond) {
  if (message && message.type === 'reach') {
    respond({ blocked: await checkReach().catch(function () { return null; }) });
    return;
  }
  var creds = await credentials();
  try {
    switch (message && message.type) {
      case 'status':
        respond({
          configured: creds.token.length > 0, hasKey: creds.apiKey.length > 0, apiKey: creds.apiKey,
          pending: !creds.token && !!localStorage.getItem(FROB_KEY),
        });
        return;
      case 'start': {
        var apiKey = String(message.apiKey || '').trim() || creds.apiKey;
        var secret = String(message.secret || '').trim() || creds.secret;
        if (!apiKey || !secret) {
          respond({ error: 'Enter the API key and shared secret.' });
          return;
        }
        var frob = (await call({ apiKey: apiKey, secret: secret, token: '' }, 'rtm.auth.getFrob')).frob;
        await Pebble.secureStorage.setItem(API_KEY_KEY, apiKey);
        await Pebble.secureStorage.setItem(SECRET_KEY, secret);
        localStorage.setItem(FROB_KEY, frob);
        respond({ authUrl: AUTH_URL + '?' + signedQuery({ api_key: apiKey, perms: 'write', frob: frob }, secret) });
        return;
      }
      case 'finish': {
        var pending = localStorage.getItem(FROB_KEY);
        if (!pending) {
          respond({ error: 'Start sign-in again.' });
          return;
        }
        var auth = (await call({ apiKey: creds.apiKey, secret: creds.secret, token: '' }, 'rtm.auth.getToken', { frob: pending })).auth;
        if (!auth || !auth.token) {
          respond({ error: 'Remember The Milk returned no token. Allow access, then try again.' });
          return;
        }
        await Pebble.secureStorage.setItem(TOKEN_KEY, String(auth.token));
        localStorage.removeItem(FROB_KEY);
        Pebble.refreshSources(REMINDER_SOURCES);
        respond({ configured: true, hasKey: true, apiKey: creds.apiKey, user: auth.user && (auth.user.fullname || auth.user.username) });
        return;
      }
      case 'unlink':
        await clearTokens();
        Pebble.refreshSources(REMINDER_SOURCES);
        respond({ configured: false, hasKey: creds.apiKey.length > 0, apiKey: creds.apiKey });
        return;
      default:
        respond({ error: 'Unknown message type.' });
    }
  } catch (error) {
    respond({ error: error.code === 'AUTH_REQUIRED' && message.type === 'finish'
      ? 'Remember The Milk has not been allowed yet. Allow access, then try again.'
      : error.message || 'Remember The Milk failed.' });
  }
});
