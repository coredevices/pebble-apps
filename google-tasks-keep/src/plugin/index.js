// Google Tasks & Keep plugin.
//
// This ports CoreApp PR #166's proven gpsoauth, Google Keep changes, and tasks-pa Sync
// protocols into the PBW runtime. Both destinations use one master token and Android id.

var UUID = 'a7c6e4b2-874a-4f08-9d7f-0a98e53c6b41';
var AUTH_URL = 'https://android.clients.google.com/auth';
var KEEP_CHANGES_URL = 'https://www.googleapis.com/notes/v1/changes';
var USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
var TASKS_SYNC_URL = 'https://tasks-pa.clients6.google.com/$rpc/google.internal.tasks.v1.TasksApiService/Sync';
var KEEP_SERVICE = 'oauth2:https://www.googleapis.com/auth/memento https://www.googleapis.com/auth/reminders https://www.googleapis.com/auth/tasks';
var USERINFO_SERVICE = 'oauth2:https://www.googleapis.com/auth/userinfo.email';
var CLIENT_SIG = '38918a453d07199354f8b19af05ec6562ced5788';
var PLAY_SERVICES_VERSION = '240913000';
var PLACEHOLDER_EMAIL = 'a@gmail.com';
var DEFAULT_ANDROID_ID = '0123456789abcdef';
var TASKS_CLIENT_VERSION = 'apps-notes.server_20260707.11_p1';
var DEFAULT_TASK_LIST = '~default';
var TASKS_URL = 'https://tasks.google.com/';
var SOURCE_KEYS = ['notes/destination', 'reminders/list', 'notes/configured', 'reminders/configured'];
var STORE_MASTER_TOKEN = 'google_master_token';
var STORE_OAUTH_TOKEN = 'google_oauth_token';
var STORE_ANDROID_ID = 'google_android_id';
var STORE_EMAIL = 'google_email';
var STORE_KEEP_PENDING_MUTATION = 'google_keep_pending_mutation';
var STORE_KEEP_COMPLETED_MUTATIONS = 'google_keep_completed_mutations';
var STORE_ACCOUNT_GENERATION = 'google_account_generation';
var KEEP_CAPABILITIES = ['NC', 'PI', 'LB', 'AN', 'SH', 'DR', 'TR', 'IN', 'SNB', 'MI', 'CO'];
var KEEP_MUTATION_ACTIVE_MS = 2 * 60 * 1000;
var KEEP_COMPLETED_MUTATION_TTL_MS = 15 * 60 * 1000;
var KEEP_COMPLETED_MUTATION_LIMIT = 24;
var BLOCKED_KEY = 'google-tasks-keep.blocked.v1';
var REACH_HOSTS = ['www.googleapis.com', 'tasks-pa.clients6.google.com', 'android.clients.google.com'];
var SECURE_KEYS = [STORE_MASTER_TOKEN, STORE_OAUTH_TOKEN, STORE_ANDROID_ID, STORE_EMAIL];
// Credentials live in Pebble.secureStorage, which is async, while this plugin reads them
// synchronously: they are loaded once per session (and again after a failed write), and writes land,
// in order, before it responds.
var secureCache = (function () {
  var values = {};
  var writing = Promise.resolve();
  var failure = null;
  var SAVE_FAILED = 'Could not save this plugin\'s credentials. Try again.';
  function load() {
    return Promise.all(SECURE_KEYS.map(function (key) {
      return Pebble.secureStorage.getItem(key).then(function (value) { values[key] = value; });
    }));
  }
  var loaded = load();
  function enqueue(write) {
    writing = writing.then(write).catch(function (error) { failure = failure || error; });
  }
  function flush() {
    return writing.then(function () {
      var error = failure;
      failure = null;
      if (!error) return undefined;
      var rethrow = function () { throw error; };
      return load().then(rethrow, rethrow);
    });
  }
  function after(fn, onFailure) {
    return function () {
      var args = arguments;
      return flush().then(function () { return fn.apply(null, args); }, function () { return onFailure(args); });
    };
  }
  function wrap(name, wrapResponder, fail) {
    var register = Pebble[name];
    Pebble[name] = function (handler) {
      register(function (request, respond) {
        var responder = wrapResponder(respond);
        return loaded.then(function () { return handler(request, responder); }, function () { return fail(respond); });
      });
    };
  }
  wrap('registerActionHandler', function (r) {
    var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
    return { ok: after(r.ok, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
  }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
  wrap('registerSourceHandler', function (r) {
    var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
    return { data: after(r.data, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
  }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
  wrap('registerConfigHandler', function (r) {
    return after(r, function () { return r({ error: SAVE_FAILED }); });
  }, function (r) { return r({ error: SAVE_FAILED }); });
  return {
    has: function (key) { return SECURE_KEYS.indexOf(key) !== -1; },
    getItem: function (key) { return values[key] === undefined ? null : values[key]; },
    setItem: function (key, value) {
      values[key] = String(value);
      enqueue(function () { return Pebble.secureStorage.setItem(key, String(value)); });
    },
    removeItem: function (key) {
      values[key] = null;
      enqueue(function () { return Pebble.secureStorage.removeItem(key); });
    },
  };
})();
var keepAppendLocks = {};
var accountOperationTail = Promise.resolve();

function nonBlank(value) {
  value = value === undefined || value === null ? '' : String(value).trim();
  return value ? value : null;
}

function storeFor(key) {
  return secureCache.has(key) ? secureCache : localStorage;
}

function stored(key) {
  return nonBlank(storeFor(key).getItem(key));
}

function save(key, value) {
  var next = nonBlank(value);
  if (next === null) storeFor(key).removeItem(key);
  else storeFor(key).setItem(key, next);
}

function clearCredentials() {
  SECURE_KEYS.forEach(function (key) { secureCache.removeItem(key); });
}

function accountGeneration() {
  var value = Number(localStorage.getItem(STORE_ACCOUNT_GENERATION));
  return isFinite(value) && value >= 0 && Math.floor(value) === value ? value : 0;
}

function advanceAccountGeneration() {
  var next = accountGeneration() + 1;
  localStorage.setItem(STORE_ACCOUNT_GENERATION, String(next));
  return next;
}

function accountIsCurrent(account) {
  if (!account || account.generation !== accountGeneration()) return false;
  return stored(STORE_MASTER_TOKEN) === account.masterToken &&
    (stored(STORE_ANDROID_ID) || DEFAULT_ANDROID_ID) === account.androidId;
}

function requireCurrentAccount(account) {
  if (!accountIsCurrent(account)) {
    throw new Error('The connected Google account changed. Nothing was sent; try again.');
  }
}

function withAccountOperationLock(operation) {
  var running = accountOperationTail.catch(function () {}).then(operation);
  accountOperationTail = running.catch(function () {});
  return running;
}

function sha256(text) {
  var bytes = [];
  text = String(text);
  for (var index = 0; index < text.length; index++) {
    var code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      var low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        index++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    } else {
      bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 63),
        0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    }
  }
  var bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (var shift = 56; shift >= 0; shift -= 8) {
    bytes.push(shift >= 32 ? 0 : (bitLength >>> shift) & 255);
  }
  var state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  var constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  function rotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
  for (var offset = 0; offset < bytes.length; offset += 64) {
    var words = [];
    for (var word = 0; word < 16; word++) {
      var start = offset + word * 4;
      words[word] = ((bytes[start] << 24) | (bytes[start + 1] << 16) |
        (bytes[start + 2] << 8) | bytes[start + 3]) | 0;
    }
    for (word = 16; word < 64; word++) {
      var previous = words[word - 15];
      var sigma0 = rotate(previous, 7) ^ rotate(previous, 18) ^ (previous >>> 3);
      previous = words[word - 2];
      var sigma1 = rotate(previous, 17) ^ rotate(previous, 19) ^ (previous >>> 10);
      words[word] = (words[word - 16] + sigma0 + words[word - 7] + sigma1) | 0;
    }
    var a = state[0], b = state[1], c = state[2], d = state[3];
    var e = state[4], f = state[5], g = state[6], h = state[7];
    for (word = 0; word < 64; word++) {
      var upper1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      var choose = (e & f) ^ (~e & g);
      var temp1 = (h + upper1 + choose + constants[word] + words[word]) | 0;
      var upper0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      var majority = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (upper0 + majority) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    state[0] = (state[0] + a) | 0; state[1] = (state[1] + b) | 0;
    state[2] = (state[2] + c) | 0; state[3] = (state[3] + d) | 0;
    state[4] = (state[4] + e) | 0; state[5] = (state[5] + f) | 0;
    state[6] = (state[6] + g) | 0; state[7] = (state[7] + h) | 0;
  }
  return state.map(function (value) {
    return ('00000000' + (value >>> 0).toString(16)).slice(-8);
  }).join('');
}

function keepMutationFingerprint(kind, destination, text) {
  function part(value) {
    value = value === undefined || value === null ? '' : String(value);
    return value.length + ':' + value;
  }
  return sha256(part('keep-mutation-v1') + part(kind) +
    part(destination && destination.noteId) + part(destination && destination.placement) + part(text));
}

function pendingKeepMutation() {
  var raw = localStorage.getItem(STORE_KEEP_PENDING_MUTATION);
  if (raw === null) return null;
  var parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { parsed = null; }
  if (parsed && parsed.version === 1 && /^[0-9a-f]{64}$/.test(String(parsed.fingerprint || '')) &&
      (parsed.kind === 'create' || parsed.kind === 'append')) {
    parsed = {
      version: 2,
      kind: parsed.kind,
      fingerprint: parsed.fingerprint,
      mutationId: randomFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 32),
      accountGeneration: accountGeneration(),
      startedAt: nonBlank(parsed.startedAt),
      state: parsed.state === 'uncertain' ? 'uncertain' : 'sending',
    };
    localStorage.setItem(STORE_KEEP_PENDING_MUTATION, JSON.stringify(parsed));
  }
  if (!parsed || parsed.version !== 2 || !/^[0-9a-f]{64}$/.test(String(parsed.fingerprint || '')) ||
      !/^[a-zA-Z0-9]{32}$/.test(String(parsed.mutationId || '')) ||
      (parsed.kind !== 'create' && parsed.kind !== 'append' && parsed.kind !== 'unknown')) {
    parsed = {
      version: 2,
      kind: 'unknown',
      fingerprint: sha256('corrupt-keep-mutation:' + raw),
      mutationId: randomFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 32),
      accountGeneration: accountGeneration(),
      startedAt: null,
      state: 'uncertain',
    };
    localStorage.setItem(STORE_KEEP_PENDING_MUTATION, JSON.stringify(parsed));
  }
  return {
    version: 2,
    kind: parsed.kind,
    fingerprint: parsed.fingerprint,
    mutationId: parsed.mutationId,
    accountGeneration: Number(parsed.accountGeneration) || 0,
    startedAt: nonBlank(parsed.startedAt),
    state: parsed.state === 'uncertain' ? 'uncertain' : 'sending',
  };
}

function completedKeepMutations() {
  var raw = localStorage.getItem(STORE_KEEP_COMPLETED_MUTATIONS);
  var parsed;
  try { parsed = JSON.parse(raw || '[]'); } catch (error) { parsed = []; }
  var now = Date.now();
  var entries = (Array.isArray(parsed) ? parsed : []).filter(function (entry) {
    var completedMs = Date.parse(entry && entry.completedAt || '');
    return entry && entry.version === 1 && /^[0-9a-f]{64}$/.test(String(entry.fingerprint || '')) &&
      /^[a-zA-Z0-9]{32}$/.test(String(entry.mutationId || '')) && entry.result &&
      typeof entry.result === 'object' && Number(entry.accountGeneration) >= 0 && isFinite(completedMs) &&
      now - completedMs >= 0 && now - completedMs <= KEEP_COMPLETED_MUTATION_TTL_MS;
  }).slice(0, KEEP_COMPLETED_MUTATION_LIMIT);
  if (JSON.stringify(entries) !== (raw || '[]')) {
    if (entries.length) localStorage.setItem(STORE_KEEP_COMPLETED_MUTATIONS, JSON.stringify(entries));
    else localStorage.removeItem(STORE_KEEP_COMPLETED_MUTATIONS);
  }
  return entries;
}

function findCompletedKeepMutation(fingerprint) {
  var entries = completedKeepMutations();
  for (var index = 0; index < entries.length; index++) {
    if (entries[index].fingerprint === fingerprint &&
        Number(entries[index].accountGeneration) === accountGeneration()) {
      var pending = pendingKeepMutation();
      if (pending && pending.mutationId === entries[index].mutationId) {
        clearPendingKeepMutation(pending.mutationId);
      }
      return entries[index];
    }
  }
  return null;
}

function saveCompletedKeepMutation(pending, result) {
  var entry = {
    version: 1,
    mutationId: pending.mutationId,
    kind: pending.kind,
    fingerprint: pending.fingerprint,
    accountGeneration: pending.accountGeneration,
    completedAt: new Date().toISOString(),
    result: cloneJson(result),
  };
  var entries = completedKeepMutations().filter(function (existing) {
    return existing.fingerprint !== entry.fingerprint;
  });
  entries.unshift(entry);
  localStorage.setItem(
    STORE_KEEP_COMPLETED_MUTATIONS,
    JSON.stringify(entries.slice(0, KEEP_COMPLETED_MUTATION_LIMIT))
  );
  return entry;
}

function pendingKeepMutationMessage(pending, fingerprint) {
  if (pending.fingerprint === fingerprint) {
    return 'This exact Google Keep write may already have succeeded. Check Keep, then resolve it in plugin settings before retrying.';
  }
  return 'A previous Google Keep write may already have succeeded. Check Keep, then resolve it in plugin settings before saving another note.';
}

function ensureNoPendingKeepMutation(fingerprint) {
  var pending = pendingKeepMutation();
  if (pending) throw new Error(pendingKeepMutationMessage(pending, fingerprint));
}

function beginKeepMutation(kind, fingerprint) {
  ensureNoPendingKeepMutation(fingerprint);
  var pending = {
    version: 2,
    kind: kind,
    fingerprint: fingerprint,
    mutationId: randomFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 32),
    accountGeneration: accountGeneration(),
    startedAt: new Date().toISOString(),
    state: 'sending',
  };
  localStorage.setItem(STORE_KEEP_PENDING_MUTATION, JSON.stringify(pending));
  return pending;
}

function markKeepMutationUncertain(fingerprint) {
  var pending = pendingKeepMutation();
  if (!pending || pending.fingerprint !== fingerprint) return;
  pending.state = 'uncertain';
  localStorage.setItem(STORE_KEEP_PENDING_MUTATION, JSON.stringify(pending));
}

function clearPendingKeepMutation(mutationId) {
  var pending = pendingKeepMutation();
  if (pending && pending.mutationId === mutationId) {
    localStorage.removeItem(STORE_KEEP_PENDING_MUTATION);
  }
}

function completeKeepMutation(fingerprint, result) {
  var pending = pendingKeepMutation();
  if (!pending || pending.fingerprint !== fingerprint) {
    throw new Error('The Google Keep write journal changed before completion. Check Keep before retrying.');
  }
  saveCompletedKeepMutation(pending, result);
  clearPendingKeepMutation(pending.mutationId);
  return result;
}

function publicPendingKeepMutation() {
  var pending = pendingKeepMutation();
  if (!pending) return null;
  var startedMs = Date.parse(pending.startedAt || '');
  var active = pending.state === 'sending' && isFinite(startedMs) &&
    Date.now() - startedMs < KEEP_MUTATION_ACTIVE_MS;
  return {
    kind: pending.kind,
    mutationId: pending.mutationId,
    startedAt: pending.startedAt,
    state: pending.state,
    canResolve: !active,
  };
}

function resolvePendingKeepMutation(mutationId, confirmedChecked, outcome) {
  var pending = pendingKeepMutation();
  if (!pending) return null;
  if (nonBlank(mutationId) !== pending.mutationId) {
    throw new Error('The pending Google Keep write changed. Refresh settings before resolving it.');
  }
  if (confirmedChecked !== true || (outcome !== 'saved' && outcome !== 'not_saved')) {
    throw new Error('Check Google Keep and choose whether the write was saved or not saved.');
  }
  var publicPending = publicPendingKeepMutation();
  if (!publicPending.canResolve) {
    throw new Error('That Google Keep write is still in progress. Wait for it to finish, then refresh settings.');
  }
  var completed = null;
  if (outcome === 'saved') {
    completed = saveCompletedKeepMutation(pending, {
      text: 'Google Keep already saved this note.',
      refreshed: ['notes/destination'],
    });
  }
  clearPendingKeepMutation(pending.mutationId);
  return completed;
}

function unresolvedKeepMutationError(error) {
  return new Error(errorText(error) +
    ' This Google Keep write may already have succeeded. Check Keep, then resolve it in plugin settings before retrying.');
}

function randomFrom(alphabet, length) {
  var value = '';
  for (var i = 0; i < length; i++) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

function newAndroidId() {
  return randomFrom('0123456789abcdef', 16);
}

function newTaskId() {
  return randomFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 16);
}

function newNodeId(now) {
  return 'tag.' + randomFrom('abcdefghijklmnopqrstuvwxyz0123456789', 12) + '.' + now.getTime().toString(16);
}

function tenDigits() {
  return String(Math.floor(1000000000 + Math.random() * 9000000000));
}

function newSessionId(now) {
  return 's--' + now.getTime() + '--' + tenDigits();
}

function redact(value) {
  return String(value || '')
    .replace(/aas_et\/[\w./+=-]+/g, '<redacted>')
    .replace(/ya29\.[\w./+=-]+/g, '<redacted>')
    .replace(/bearer\s+[\w./+=-]+/gi, 'Bearer <redacted>')
    .replace(/(EncryptedPasswd|oauth_token|Token|ACCESS_TOKEN|Authorization|Auth)=[^&\s\"]+/gi, '$1=<redacted>');
}

function errorText(error) {
  return redact(error && error.message ? error.message : String(error));
}

// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
function unreachableHost() {
  return new Promise(function (resolve) {
    var answered = 0;
    REACH_HOSTS.forEach(function (host) {
      Promise.resolve()
        .then(function () { return fetch('https://' + host + '/'); })
        .then(function () { if (++answered === REACH_HOSTS.length) resolve(null); }, function () { resolve(host); });
    });
  });
}

// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
async function blockedHost() {
  var permissions = typeof Pebble !== 'undefined' && Pebble.permissions;
  if (permissions) {
    for (var i = 0; i < REACH_HOSTS.length; i++) {
      if (await permissions.query('Internet/' + REACH_HOSTS[i]) !== 'granted') return { host: REACH_HOSTS[i], sure: true };
    }
    return null;
  }
  var host = await unreachableHost();
  return host ? { host: host, sure: false } : null;
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
  return 'Google Tasks & Keep doesn\'t have permission to connect to ' + blocked.host + '. Turn on "Connect to ' + blocked.host +
    '" in Google Tasks & Keep\'s Permissions' + (blocked.sure ? '.' : ', or check your internet connection.');
}

// Probes have no deadline, so a failure answers from the last check and starts a new one.
function recheckReach() {
  var blocked = null;
  try {
    blocked = lastBlocked();
    checkReach().catch(function () {});
  } catch (e) {}
  return blocked;
}

function classifyError(error) {
  var message = errorText(error);
  var unreachable = /^.*?\(HTTP 0\)\./;
  var blocked = unreachable.test(message) ? recheckReach() : null;
  if (blocked) return { code: 'PLUGIN_UNAVAILABLE', message: message.replace(unreachable, blockedMessage(blocked)) };
  if (/not connected|oauth|master.token|authorization|HTTP 40[13]/i.test(message)) {
    return { code: 'AUTH_REQUIRED', message: message };
  }
  if (/rate.limit|HTTP 429/i.test(message)) {
    return { code: 'RATE_LIMITED', message: message };
  }
  if (/required|must be|cannot be empty|invalid|unknown destination/i.test(message)) {
    return { code: 'INVALID_ARGS', message: message };
  }
  return { code: 'PLUGIN_UNAVAILABLE', message: message || 'Google is unavailable.' };
}

function formEncode(values) {
  return Object.keys(values).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]);
  }).join('&');
}

function parseAuthResponse(text) {
  var result = {};
  String(text || '').split('\n').forEach(function (rawLine) {
    var line = rawLine.trim();
    if (!line) return;
    var split = line.indexOf('=');
    if (split >= 0) result[line.substring(0, split)] = line.substring(split + 1);
  });
  return result;
}

function http(method, url, headers, body) {
  return fetch(url, {
    method: method,
    headers: headers || {},
    body: body === undefined || body === null ? undefined : body,
  }).then(async function (response) {
    if (!response.ok) console.error('Google ' + method + ' ' + url.split('?')[0] + ': HTTP ' + response.status);
    return { ok: response.ok, status: Number(response.status), text: String(await response.text() || '') };
  }, function (error) {
    console.error('Google ' + method + ' ' + url.split('?')[0] + ' failed: ' + errorText(error));
    return { ok: false, status: 0, text: '' };
  });
}

async function postAuth(values) {
  var response = await http('POST', AUTH_URL, {
    'User-Agent': 'GoogleAuth/1.4',
    'Accept-Encoding': 'identity',
    'Content-Type': 'application/x-www-form-urlencoded',
  }, formEncode(values));
  if (!response.ok) throw new Error('Google authorization failed (HTTP ' + response.status + ').');
  return parseAuthResponse(response.text);
}

async function exchangeOAuthToken(oauthToken, androidId) {
  var response = await postAuth({
    accountType: 'HOSTED_OR_GOOGLE',
    Email: PLACEHOLDER_EMAIL,
    has_permission: '1',
    add_account: '1',
    ACCESS_TOKEN: '1',
    Token: oauthToken,
    service: 'ac2dm',
    source: 'android',
    androidId: androidId,
    device_country: 'us',
    operatorCountry: 'us',
    lang: 'en',
    sdk_version: '17',
    google_play_services_version: PLAY_SERVICES_VERSION,
    client_sig: CLIENT_SIG,
    callerSig: CLIENT_SIG,
    droidguard_results: 'dummy123',
  });
  if (!response.Token) {
    throw new Error('Google oauth_token exchange failed: ' + redact(response.Error || 'no master token returned') + '.');
  }
  return { masterToken: response.Token, email: nonBlank(response.Email) };
}

async function getAuthToken(credentials, service) {
  var response = await postAuth({
    accountType: 'HOSTED_OR_GOOGLE',
    Email: credentials.email || PLACEHOLDER_EMAIL,
    has_permission: '1',
    EncryptedPasswd: credentials.masterToken,
    service: service,
    source: 'android',
    androidId: credentials.androidId,
    app: 'com.google.android.keep',
    client_sig: CLIENT_SIG,
    device_country: 'us',
    operatorCountry: 'us',
    lang: 'en',
    sdk_version: '17',
    google_play_services_version: PLAY_SERVICES_VERSION,
  });
  if (!response.Auth) {
    throw new Error('Google authorization failed: ' + redact(response.Error || 'no auth token returned') + '.');
  }
  return response.Auth;
}

async function fetchAccountEmail(credentials) {
  try {
    var token = await getAuthToken(credentials, USERINFO_SERVICE);
    var response = await http('GET', USERINFO_URL, {
      Authorization: 'Bearer ' + token,
    });
    if (!response.ok) return null;
    var parsed = JSON.parse(response.text);
    return nonBlank(parsed && parsed.email);
  } catch (error) {
    return null;
  }
}

async function credentials() {
  var generation = accountGeneration();
  var masterToken = stored(STORE_MASTER_TOKEN);
  var oauthToken = stored(STORE_OAUTH_TOKEN);
  var androidId = stored(STORE_ANDROID_ID);
  var email = stored(STORE_EMAIL) || '';
  if (masterToken) {
    return {
      masterToken: masterToken,
      androidId: androidId || DEFAULT_ANDROID_ID,
      email: email,
      generation: generation,
    };
  }
  if (!oauthToken) throw new Error('Google account is not connected.');
  if (!androidId) {
    androidId = newAndroidId();
    if (generation !== accountGeneration() || stored(STORE_OAUTH_TOKEN) !== oauthToken) {
      throw new Error('The connected Google account changed during authorization. Try again.');
    }
    save(STORE_ANDROID_ID, androidId);
  }
  var exchanged = await exchangeOAuthToken(oauthToken, androidId);
  masterToken = exchanged.masterToken;
  email = exchanged.email || email;
  var result = {
    masterToken: masterToken,
    androidId: androidId,
    email: email,
    generation: generation,
  };
  if (!email) email = await fetchAccountEmail(result) || '';
  if (generation !== accountGeneration() || stored(STORE_OAUTH_TOKEN) !== oauthToken ||
      stored(STORE_ANDROID_ID) !== androidId) {
    throw new Error('The connected Google account changed during authorization. Try again.');
  }
  save(STORE_MASTER_TOKEN, masterToken);
  save(STORE_EMAIL, email);
  secureCache.removeItem(STORE_OAUTH_TOKEN);
  return {
    masterToken: masterToken,
    androidId: androidId,
    email: email,
    generation: generation,
  };
}

function keepRequestBody(nodes, targetVersion, sessionId) {
  var request = {
    nodes: nodes,
    clientTimestamp: new Date().toISOString(),
    requestHeader: {
      clientSessionId: sessionId || newSessionId(new Date()),
      clientPlatform: 'ANDROID',
      clientVersion: { major: '9', minor: '9', build: '9', revision: '9' },
      capabilities: KEEP_CAPABILITIES.map(function (type) { return { type: type }; }),
    },
  };
  if (targetVersion !== undefined && targetVersion !== null) {
    request.targetVersion = targetVersion;
  }
  return request;
}

async function sendKeepRequest(account, authToken, request, failureText) {
  requireCurrentAccount(account);
  var response = await postKeep(authToken, request);
  if (response.status === 401) {
    requireCurrentAccount(account);
    authToken = await getAuthToken(account, KEEP_SERVICE);
    requireCurrentAccount(account);
    response = await postKeep(authToken, request);
  }
  if (!response.ok) {
    throw new Error(failureText + ' (HTTP ' + response.status + ').');
  }
  var parsed;
  try { parsed = JSON.parse(response.text); } catch (error) {
    throw new Error('Google Keep returned a malformed response.');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Google Keep returned a malformed response.');
  }
  if (parsed.forceFullResync) {
    throw new Error('Google Keep requested a full resync. Reopen plugin settings and try again.');
  }
  var conflict = Array.isArray(parsed.nodes) && parsed.nodes.some(function (node) {
    return !!(node && node.mergeConflict);
  });
  if (conflict) {
    throw new Error('The selected Google Keep note changed elsewhere. Nothing was appended; try again.');
  }
  return { authToken: authToken, data: parsed };
}

function postKeep(authToken, request) {
  return http('POST', KEEP_CHANGES_URL, {
    Authorization: 'OAuth ' + authToken,
    'Content-Type': 'application/json',
  }, JSON.stringify(request));
}

async function createKeepNote(text, fingerprint) {
  var now = new Date();
  var timestamp = now.toISOString();
  var timestamps = {
    created: timestamp,
    updated: timestamp,
    userEdited: timestamp,
    kind: 'notes#timestamps',
  };
  var noteId = newNodeId(now);
  var note = {
    id: noteId,
    type: 'NOTE',
    parentId: 'root',
    sortValue: tenDigits(),
    timestamps: timestamps,
    kind: 'notes#node',
    text: '',
    title: text,
    color: 'DEFAULT',
    isArchived: false,
    isPinned: false,
  };
  var item = {
    id: newNodeId(now),
    type: 'LIST_ITEM',
    parentId: noteId,
    sortValue: tenDigits(),
    timestamps: timestamps,
    kind: 'notes#node',
    text: '',
    checked: false,
  };
  var account = await credentials();
  var authToken = await getAuthToken(account, KEEP_SERVICE);
  requireCurrentAccount(account);
  beginKeepMutation('create', fingerprint);
  try {
    var result = await sendKeepRequest(
      account,
      authToken,
      keepRequestBody([note, item]),
      'Google Keep failed to create the note'
    );
    var synced = Array.isArray(result.data.nodes) ? result.data.nodes : [];
    var match = synced.find(function (node) { return node && node.id === noteId; });
    var serverId = match && nonBlank(match.serverId);
    if (!serverId) {
      throw new Error('Google Keep did not confirm the created note. Check Keep before trying again.');
    }
    return String(serverId);
  } catch (error) {
    markKeepMutationUncertain(fingerprint);
    throw unresolvedKeepMutationError(error);
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function keepUrl(serverId) {
  return String(serverId).indexOf('tag.') === 0
    ? null
    : 'https://keep.google.com/#NOTE/' + encodeURIComponent(serverId);
}

function nulls(count) {
  var values = [];
  for (var i = 0; i < count; i++) values.push('null');
  return values.join(',');
}

function strictInstant(value) {
  var match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) return null;
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var second = Number(match[6]);
  var offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  var offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  var leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    return null;
  }
  var instant = new Date(value);
  return isNaN(instant.getTime()) ? null : instant;
}

function localParts(instant, timeZone) {
  var formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch (error) {
    throw new Error('timezone must be a valid IANA time-zone name.');
  }
  if (typeof formatter.formatToParts !== 'function') {
    throw new Error('This phone cannot resolve IANA time zones for Google Tasks.');
  }
  var values = {};
  formatter.formatToParts(instant).forEach(function (part) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  });
  if (!values.year || !values.month || !values.day || isNaN(values.hour) || isNaN(values.minute)) {
    throw new Error('Could not resolve the Google Tasks due time.');
  }
  return values;
}

function buildCreateTaskPayload(taskId, listId, title, deadline, timeZone) {
  var now = new Date();
  var timestamp = '[' + Math.floor(now.getTime() / 1000) + ',' + ((now.getTime() % 1000) * 1000000) + ']';
  var task = JSON.stringify(taskId);
  var list = JSON.stringify(listId);
  var escapedTitle = JSON.stringify(title);
  var dateField = 'null';
  var parts = null;
  if (deadline) {
    parts = localParts(deadline, timeZone);
    dateField = '[' + parts.year + ',' + parts.month + ',' + parts.day + ']';
  }
  var operations = [];
  operations.push(
    '[' + JSON.stringify(newTaskId()) + ',3,' + task + ',[1],null,null,' +
    '[[null,[2,4,8,6,13]],[null,' + escapedTitle + ',null,' + dateField + ',null,null,null,null]],' +
    'null,null,' + timestamp + ',' + nulls(15) + ',1]'
  );
  var sequence = 1;
  if (deadline) {
    var due = '[[null,[1]],[[null,[' + parts.year + ',' + parts.month + ',' + parts.day + '],[' +
      parts.hour + ',' + parts.minute + '],' + JSON.stringify(timeZone) + ',null,[' +
      Math.floor(deadline.getTime() / 1000) + ']]]]';
    operations.push(
      '[' + JSON.stringify(newTaskId()) + ',3,' + task + ',[1,1],null,null,null,null,null,' +
      timestamp + ',null,' + due + ',' + nulls(13) + ',1,' + (sequence++) + ',[1]]'
    );
  }
  operations.push(
    '[' + JSON.stringify(newTaskId()) + ',4,' + list + ',[1],null,null,null,null,[' + task +
    ',null,null,null,null,null,1],' + timestamp + ',' + nulls(15) + ',1,' + (sequence++) + ',[null,"1"]]'
  );
  operations.push(
    '[' + JSON.stringify(newTaskId()) + ',3,' + task + ',[1,2],null,null,null,null,null,' +
    timestamp + ',[null,' + list + '],' + nulls(14) + ',1,' + sequence + ',[1,1]]'
  );
  return '[[null,[' + timestamp + ',null,[[[' + operations.join(',') + '],[]]]]],null,null,null,[' +
    JSON.stringify(newTaskId()) + ',[null,4,' + JSON.stringify(TASKS_CLIENT_VERSION) + ',"prod",3,11,2,null,1]]]';
}

var FETCH_ALL_LISTS_PAYLOAD = '[[[[null,null,null,[]]],null],null,null,null,["fetch",[null,4,' +
  JSON.stringify(TASKS_CLIENT_VERSION) + ',"prod",3,11,2,null,1]]]';

async function tasksSync(body) {
  var account = await credentials();
  var authToken = await getAuthToken(account, KEEP_SERVICE);
  requireCurrentAccount(account);
  var response = await postTasks(authToken, body);
  if (response.status === 401) {
    requireCurrentAccount(account);
    authToken = await getAuthToken(account, KEEP_SERVICE);
    requireCurrentAccount(account);
    response = await postTasks(authToken, body);
  }
  if (!response.ok) throw new Error('Google Tasks sync failed (HTTP ' + response.status + ').');
  return response.text;
}

function postTasks(authToken, body) {
  return http('POST', TASKS_SYNC_URL, {
    Authorization: 'OAuth ' + authToken,
    'Content-Type': 'application/json+protobuf',
  }, body);
}

async function createTask(title, dueIso, timeZone, listId) {
  var deadline = dueIso ? strictInstant(dueIso) : null;
  if (dueIso && !deadline) {
    throw new Error('due_iso must be a valid absolute ISO-8601 date-time with Z or a numeric offset.');
  }
  if (deadline && !nonBlank(timeZone)) throw new Error('timezone is required with due_iso.');
  var taskId = newTaskId();
  var body = buildCreateTaskPayload(
    taskId,
    nonBlank(listId) || DEFAULT_TASK_LIST,
    title,
    deadline,
    nonBlank(timeZone)
  );
  var text = await tasksSync(body);
  var parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new Error('Google Tasks returned a malformed create response.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed[0] === null) {
    throw new Error('Google Task was not created.');
  }
  return taskId;
}

async function listTaskLists() {
  var text = await tasksSync(FETCH_ALL_LISTS_PAYLOAD);
  var root;
  try { root = JSON.parse(text); } catch (error) {
    throw new Error('Google Tasks returned a malformed task-list response.');
  }
  var items = Array.isArray(root) && Array.isArray(root[0]) ? root[0] : [];
  var seen = {};
  var lists = [];
  items.forEach(function (item) {
    var record = Array.isArray(item) && Array.isArray(item[3]) ? item[3] : null;
    var id = record && nonBlank(record[0]);
    var title = record && Array.isArray(record[1]) ? nonBlank(record[1][0]) : null;
    if (id && title && !seen[id]) {
      seen[id] = true;
      lists.push({ id: id, title: title });
    }
  });
  return lists;
}

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function longText(text) {
  return { longText: { text: String(text) } };
}

function booleanReading(value) {
  return {
    boolean: { value: !!value },
    shortText: { text: value ? 'Connected' : 'Not connected' },
  };
}

function excerpt(text) {
  var oneLine = String(text).trim().replace(/\s+/g, ' ');
  return oneLine.length > 42 ? oneLine.substring(0, 39) + '...' : oneLine;
}

Pebble.registerSourceHandler(async function (request, respond) {
  try {
    if ((request.category === 'notes' || request.category === 'reminders') && request.item === 'configured') {
      var signedIn = !!(stored(STORE_MASTER_TOKEN) || stored(STORE_OAUTH_TOKEN));
      var title = request.category === 'notes' ? 'Google Keep' : 'Google Tasks';
      respond.data({
        validUntilMs: Date.now() + 60 * 1000,
        instances: [{
          instanceId: request.category === 'notes' ? 'google-keep' : 'google-tasks',
          properties: { name: shortText(title), configured: booleanReading(signedIn) },
        }],
      });
      return;
    }
    if (request.category === 'notes' && request.item === 'destination') {
      var configured = !!(stored(STORE_MASTER_TOKEN) || stored(STORE_OAUTH_TOKEN));
      respond.data({
        validUntilMs: Date.now() + 60 * 1000,
        instances: [{
          instanceId: 'google-keep',
          properties: {
            name: shortText('Google Keep'),
            configured: booleanReading(configured),
            account: shortText(stored(STORE_EMAIL) || 'Shared Google account'),
          },
        }],
      });
      return;
    }
    if (request.category === 'reminders' && request.item === 'list') {
      if (!(stored(STORE_MASTER_TOKEN) || stored(STORE_OAUTH_TOKEN))) {
        respond.error('AUTH_REQUIRED', 'Connect a Google account first.');
        return;
      }
      var lists = await withAccountOperationLock(function () { return listTaskLists(); });
      respond.data({
        validUntilMs: Date.now() + 15 * 60 * 1000,
        instances: lists.map(function (list) {
          return {
            instanceId: list.id,
            properties: {
              name: shortText(list.title),
              destination: shortText('Google Tasks list'),
              url: longText(TASKS_URL),
            },
          };
        }),
      });
      return;
    }
    console.error('Unsupported source: ' + request.category + '/' + request.item);
    respond.error('INVALID_REQUEST', 'Unsupported Google Tasks & Keep source.');
  } catch (error) {
    var sourceFailure = classifyError(error);
    console.error('Reading ' + (request && request.category) + '/' + (request && request.item) + ' failed: ' + sourceFailure.message);
    respond.error(sourceFailure.code, sourceFailure.message);
  }
});

Pebble.registerActionHandler(async function (request, respond) {
  try {
    var args = request.args || {};
    if (request.action === 'create_note') {
      await withAccountOperationLock(async function () {
        if (args.instanceId !== undefined && args.instanceId !== 'google-keep') {
          throw new Error('Unknown Google Keep destination.');
        }
        var noteText = typeof args.text === 'string' ? args.text.trim() : '';
        if (!noteText) throw new Error('The note text cannot be empty.');
        var mutationFingerprint = keepMutationFingerprint('create', null, noteText);
        var completed = findCompletedKeepMutation(mutationFingerprint);
        if (completed) {
          respond.ok(cloneJson(completed.result));
          return;
        }
        ensureNoPendingKeepMutation(mutationFingerprint);
        var noteId = await createKeepNote(noteText, mutationFingerprint);
        var noteResult = {
          text: 'Saved to Google Keep: “' + excerpt(noteText) + '”',
          refreshed: ['notes/destination'],
        };
        var noteUrl = keepUrl(noteId);
        if (noteUrl) noteResult.url = noteUrl;
        completeKeepMutation(mutationFingerprint, noteResult);
        respond.ok(noteResult);
      });
      return;
    }

    if (request.action === 'create_reminder') {
      var title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new Error('title cannot be empty.');
      if (args.instanceId !== undefined && !nonBlank(args.instanceId)) {
        throw new Error('instanceId must be a non-empty Google Tasks list ID.');
      }
      if (args.notify_before_ms !== undefined && args.notify_before_ms !== null &&
          (typeof args.notify_before_ms !== 'number' || !isFinite(args.notify_before_ms) ||
           Math.floor(args.notify_before_ms) !== args.notify_before_ms || args.notify_before_ms < 0)) {
        throw new Error('notify_before_ms must be a non-negative integer.');
      }
      await withAccountOperationLock(async function () {
        await createTask(title, args.due_iso, args.timezone, args.instanceId);
        respond.ok({
          text: 'Created “' + title + '” in Google Tasks.',
          url: TASKS_URL,
          refreshed: ['reminders/list'],
        });
      });
      return;
    }

    console.error('Unsupported action: ' + request.action);
    respond.error('INVALID_REQUEST', 'Unsupported Google Tasks & Keep action.');
  } catch (error) {
    var failure = classifyError(error);
    console.error((request && request.action) + ' failed: ' + failure.message);
    respond.error(failure.code, failure.message);
  }
});

Pebble.registerConfigHandler(async function (message, respond) {
  try {
    switch (message && message.type) {
      case 'reach':
        respond({ blocked: await checkReach().catch(function () { return null; }) });
        return;
      case 'status': {
        var master = stored(STORE_MASTER_TOKEN);
        var oauth = stored(STORE_OAUTH_TOKEN);
        respond({
          configured: !!(master || oauth),
          ready: !!master,
          hasMasterToken: !!master,
          exchangePending: !master && !!oauth,
          email: stored(STORE_EMAIL),
          pendingKeepMutation: publicPendingKeepMutation(),
        });
        return;
      }

      case 'resolveKeepMutation': {
        await withAccountOperationLock(function () {
          resolvePendingKeepMutation(message.mutationId, message.confirmedChecked, message.outcome);
        });
        respond({ ok: true, pendingKeepMutation: null });
        return;
      }

      case 'setCredentials': {
        var masterToken = nonBlank(message.masterToken);
        var oauthToken = nonBlank(message.oauthToken);
        var androidId = nonBlank(message.androidId);
        var email = nonBlank(message.email);
        if (!masterToken && !oauthToken) {
          respond({ error: 'Enter an oauth_token or master token.' });
          return;
        }
        if (androidId && !/^[0-9a-fA-F]{16}$/.test(androidId)) {
          respond({ error: 'Android ID must contain exactly 16 hexadecimal characters.' });
          return;
        }
        await withAccountOperationLock(function () {
          advanceAccountGeneration();
          clearCredentials();
          save(STORE_MASTER_TOKEN, masterToken);
          save(STORE_OAUTH_TOKEN, masterToken ? null : oauthToken);
          save(STORE_ANDROID_ID, androidId || (oauthToken ? newAndroidId() : DEFAULT_ANDROID_ID));
          save(STORE_EMAIL, email);
        });
        Pebble.refreshSources(SOURCE_KEYS);
        respond({ configured: true, ready: !!masterToken, hasMasterToken: !!masterToken });
        return;
      }

      case 'testConnection': {
        var account = await withAccountOperationLock(async function () {
          var current = await credentials();
          await getAuthToken(current, KEEP_SERVICE);
          requireCurrentAccount(current);
          return current;
        });
        respond({
          ok: true,
          configured: true,
          hasMasterToken: true,
          email: account.email || null,
        });
        return;
      }

      case 'unlink':
      case 'disconnect':
        await withAccountOperationLock(function () {
          advanceAccountGeneration();
          clearCredentials();
        });
        Pebble.refreshSources(SOURCE_KEYS);
        respond({ configured: false, ready: false });
        return;

      default:
        respond({ error: 'Unknown message type.' });
    }
  } catch (error) {
    respond({ error: errorText(error) });
  }
});
