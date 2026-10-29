/*
 * Apple Notes note-destination plugin.
 *
 * This is a deliberately narrow browser-JavaScript port of the proven create path in
 * icloud-md 0.6.2, revision a5160cc78e2bfeab35b8c8b365b1ef25662b21bb.
 * See UPSTREAM.md in the PBW for a file/function mapping and update procedure.
 *
 * Apple does not publish an Apple Notes API. This uses the private CloudKit web service used
 * by icloud.com, so it can break without notice. Sign-in happens in the host's isolated browser
 * (Pebble.webSignIn); the plugin only ever sees the resulting iCloud cookies.
 */

import './textEncodingPolyfill.js';
import { deflate, inflate } from 'pako';
import { clone, create } from '@bufbuild/protobuf';
import { AttributeRunSchema } from '../vendor/icloud-md/src/notes/gen/topotext_pb.js';
import {
  applyTextEdit,
  bytesEqual,
  encodeNoteDocument,
  noteDocumentRoundTrips,
  parseNoteDocument,
  validateDocumentInvariants,
} from '../vendor/icloud-md/src/notes/noteDocument.js';
import { blockedMessage, checkReach, lastBlocked } from './reach.mjs';

var STORE_KEY = 'apple-notes';
var SECURE_KEYS = [STORE_KEY];
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
var DESTINATION_SOURCES = ['notes/destination', 'notes/configured'];
var SETUP_HOST = 'https://setup.icloud.com';
// iCloud's web clients send Safari's; Notes of Fruit does the same.
var ICLOUD_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
var DEFAULT_FOLDER = 'DefaultFolder-CloudKit';
var CKJS_BUILD_VERSION = '2310ProjectDev27';
var CKJS_VERSION = '2.6.4';
var DEFAULT_CLIENT_BUILD_NUMBER = '2624Build27';
var DEFAULT_CLIENT_MASTERING_NUMBER = '2624Build27';
var PRIVATE_NOTES_ZONE = { zoneName: 'Notes' };
var RECENT_NOTE_LIMIT = 10;

function defaultDestination() {
  return { mode: 'create', recordName: null, title: null, placement: 'bottom' };
}

function normalizeDestination(value) {
  if (!value || value.mode !== 'append') return defaultDestination();
  var recordName = typeof value.recordName === 'string' ? value.recordName.trim() : '';
  var title = typeof value.title === 'string' ? value.title.trim() : '';
  if (!recordName) return defaultDestination();
  return {
    mode: 'append',
    recordName: recordName,
    title: title || 'Selected note',
    placement: value.placement === 'top' ? 'top' : 'bottom',
  };
}

function emptyState() {
  return {
    session: null,
    dsid: null,
    appleId: null,
    fullName: null,
    ckdatabasewsUrl: null,
    destination: defaultDestination(),
    editorReplicaId: null,
    authGeneration: null,
  };
}

function state() {
  var saved;
  try { saved = JSON.parse(secureCache.getItem(STORE_KEY)) || {}; } catch (e) { saved = {}; }
  var result = emptyState();
  Object.keys(result).forEach(function (key) {
    if (saved[key] !== undefined) result[key] = saved[key];
  });
  result.destination = normalizeDestination(result.destination);
  return result;
}

function saveState(changes) {
  var next = state();
  Object.keys(changes).forEach(function (key) { next[key] = changes[key]; });
  secureCache.setItem(STORE_KEY, JSON.stringify(next));
  return next;
}

function clearState() {
  var cleared = emptyState();
  // Keep only a fresh, non-secret generation marker so a late validation callback can never
  // repersist the session that unlink just removed.
  cleared.authGeneration = randomUuid();
  secureCache.setItem(STORE_KEY, JSON.stringify(cleared));
  return cleared;
}

function stateWithAuthGeneration() {
  var current = state();
  if (current.session && !current.authGeneration) {
    current = saveState({ authGeneration: randomUuid() });
  }
  return current;
}

function generationIsActive(expectedGeneration, requireSession) {
  var current = state();
  return current.authGeneration === expectedGeneration && (!requireSession || !!current.session);
}

function staleAuthenticationResult() {
  return {
    ok: false,
    status: 401,
    stale: true,
    error: 'Apple Notes was disconnected while the request was running.',
  };
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Session JSON must contain an object.');
  }
  var cookie = typeof value.cookie === 'string' ? value.cookie.trim() : '';
  var clientId = typeof value.clientId === 'string' ? value.clientId.trim() : '';
  var clientBuildNumber = typeof value.clientBuildNumber === 'string'
    ? value.clientBuildNumber.trim()
    : DEFAULT_CLIENT_BUILD_NUMBER;
  var clientMasteringNumber = typeof value.clientMasteringNumber === 'string'
    ? value.clientMasteringNumber.trim()
    : DEFAULT_CLIENT_MASTERING_NUMBER;
  if (!cookie) throw new Error('Session JSON is missing cookie.');
  if (!clientId) throw new Error('Session JSON is missing clientId.');
  if (!clientBuildNumber) throw new Error('Session JSON is missing clientBuildNumber.');
  if (!clientMasteringNumber) throw new Error('Session JSON is missing clientMasteringNumber.');
  return {
    cookie: cookie,
    clientId: clientId,
    clientBuildNumber: clientBuildNumber,
    clientMasteringNumber: clientMasteringNumber,
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : new Date().toISOString(),
  };
}

function parseSessionJson(raw) {
  var parsed;
  try { parsed = JSON.parse(String(raw || '')); } catch (e) {
    throw new Error('Session JSON is not valid JSON.');
  }
  // Accept either icloud-md's session.local.json directly or an object with a `session` field.
  return normalizeSession(parsed && parsed.session ? parsed.session : parsed);
}

/** fetch wrapper. It resolves transport failures rather than rejecting. */
function http(method, url, headers, body) {
  // The query string carries the account's clientId and dsid.
  var path = url.split('?')[0];
  return fetch(url, {
    method: method,
    headers: headers || {},
    body: body === undefined || body === null ? undefined : body,
  }).then(async function (response) {
    var text = (await response.text()) || '';
    var json = null;
    try { json = JSON.parse(text); } catch (e) { /* non-JSON body */ }
    if (!response.ok) console.error('Apple Notes ' + method + ' ' + path + ': HTTP ' + response.status);
    return {
      ok: response.ok,
      status: response.status,
      json: json,
      text: text,
      setCookie: response.headers.get('set-cookie'),
    };
  }, function (e) {
    console.error('Apple Notes ' + method + ' ' + path + ' failed: ' + ((e && e.name) || 'network error'));
    return { ok: false, status: 0, json: null, text: '', setCookie: null };
  });
}

function parseCookieHeader(header) {
  var cookies = [];
  String(header || '').split(';').forEach(function (part) {
    var trimmed = part.trim();
    var equals = trimmed.indexOf('=');
    if (equals > 0) cookies.push([trimmed.substring(0, equals), trimmed.substring(equals + 1)]);
  });
  return cookies;
}

/**
 * Merge cookie rotation from setup.icloud.com. Ktor may flatten multiple Set-Cookie headers into
 * one comma-delimited value; this parser recognizes a new cookie only at the start or after a
 * comma, and ignores Expires' comma because the following text is not immediately NAME=VALUE.
 */
function mergeSetCookie(session, setCookie) {
  if (!setCookie) return session;
  var ordered = parseCookieHeader(session.cookie);
  var values = {};
  ordered.forEach(function (pair) { values[pair[0]] = pair[1]; });
  var changed = false;
  var matcher = /(?:^|,\s*)([A-Za-z0-9_.-]+)=([^;,]*)/g;
  var match;
  while ((match = matcher.exec(String(setCookie))) !== null) {
    var name = match[1];
    var value = match[2];
    if (values[name] !== value) changed = true;
    if (!Object.prototype.hasOwnProperty.call(values, name)) ordered.push([name, value]);
    values[name] = value;
  }
  if (!changed) return session;
  return {
    cookie: ordered.map(function (pair) { return pair[0] + '=' + values[pair[0]]; }).join('; '),
    clientId: session.clientId,
    clientBuildNumber: session.clientBuildNumber,
    clientMasteringNumber: session.clientMasteringNumber,
    capturedAt: session.capturedAt,
  };
}

function queryString(values) {
  return Object.keys(values).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(values[key]);
  }).join('&');
}

function randomBytes(length) {
  var bytes = new Uint8Array(length);
  try {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) return crypto.getRandomValues(bytes);
  } catch (e) { /* WebView lockdown/platform may omit crypto */ }
  for (var i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function uuidFromBytes(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i++) {
    var hex = bytes[i].toString(16);
    out.push(hex.length === 1 ? '0' + hex : hex);
  }
  return out.slice(0, 4).join('') + '-' + out.slice(4, 6).join('') + '-' +
    out.slice(6, 8).join('') + '-' + out.slice(8, 10).join('') + '-' + out.slice(10).join('');
}

function randomUuid() {
  var bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  return uuidFromBytes(bytes);
}

function checkAuthentication(session) {
  var params = queryString({
    clientBuildNumber: session.clientBuildNumber,
    clientMasteringNumber: session.clientMasteringNumber,
    clientId: session.clientId,
    requestId: randomUuid(),
  });
  return http('POST', SETUP_HOST + '/setup/ws/1/validate?' + params, {
    Cookie: session.cookie,
    Origin: 'https://www.icloud.com',
    Referer: 'https://www.icloud.com/',
    'User-Agent': ICLOUD_USER_AGENT,
    Accept: 'application/json',
  }, null).then(function (result) {
    var rotated = mergeSetCookie(session, result.setCookie);
    var body = result.json;
    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        error: body && typeof body.error === 'string' ? body.error :
          (result.status ? 'Apple returned HTTP ' + result.status + '.' : 'Could not reach iCloud.'),
      };
    }
    if (!body || !body.dsInfo) {
      return { ok: false, status: result.status, error: 'iCloud returned an unexpected authentication response.' };
    }
    if (body.hsaChallengeRequired === true || body.dsInfo.hsaChallengeRequired === true) {
      return { ok: false, status: result.status, error: 'Apple sign-in still requires 2FA.' };
    }
    var dsid = typeof body.dsInfo.dsid === 'string' ? body.dsInfo.dsid : '';
    var appleId = typeof body.dsInfo.appleId === 'string' ? body.dsInfo.appleId : '';
    var services = body.webservices || {};
    var notes = services.ckdatabasews || {};
    var host = typeof notes.url === 'string' ? notes.url.replace(/\/$/, '') : '';
    if (!dsid || !appleId) {
      return { ok: false, status: result.status, error: 'iCloud did not return the account identity.' };
    }
    if (!host || !/^https:\/\/[^/]+\.icloud\.com(?::\d+)?$/i.test(host)) {
      return { ok: false, status: result.status, error: 'Apple Notes is unavailable for this account.' };
    }
    return {
      ok: true,
      session: rotated,
      dsid: dsid,
      appleId: appleId,
      fullName: typeof body.dsInfo.fullName === 'string' ? body.dsInfo.fullName : null,
      ckdatabasewsUrl: host,
    };
  });
}

function verifyAndPersist(session, guard) {
  return checkAuthentication(session).then(function (auth) {
    if (!auth.ok) return auth;
    if (guard && !generationIsActive(guard.expectedGeneration, guard.requireSession === true)) {
      return staleAuthenticationResult();
    }
    var changes = {
      session: auth.session,
      dsid: auth.dsid,
      appleId: auth.appleId,
      fullName: auth.fullName,
      ckdatabasewsUrl: auth.ckdatabasewsUrl,
    };
    if (guard && guard.replaceGeneration === true) changes.authGeneration = randomUuid();
    saveState({
      session: changes.session,
      dsid: changes.dsid,
      appleId: changes.appleId,
      fullName: changes.fullName,
      ckdatabasewsUrl: changes.ckdatabasewsUrl,
      authGeneration: changes.authGeneration === undefined ? state().authGeneration : changes.authGeneration,
    });
    return auth;
  });
}

// -------------------------------------------------------------------------
// Minimal initial-note encoder, ported from icloud-md's noteDocument.ts and
// proto/{topotext,versioned_document}.proto. It intentionally handles only a brand-new,
// plain-text, one-replica note; edits, formatting, attachments and reads stay out of scope.

function utf8(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      var low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return new Uint8Array(bytes);
}

function concat(parts) {
  var size = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
  var result = new Uint8Array(size);
  var offset = 0;
  parts.forEach(function (part) { result.set(part, offset); offset += part.length; });
  return result;
}

function varint(value) {
  var current = Number(value);
  var bytes = [];
  do {
    var byte = current % 128;
    current = Math.floor(current / 128);
    bytes.push(current ? byte + 128 : byte);
  } while (current);
  return new Uint8Array(bytes);
}

function varintField(number, value) {
  return concat([varint(number * 8), varint(value)]);
}

function bytesField(number, value) {
  return concat([varint(number * 8 + 2), varint(value.length), value]);
}

function charId(replicaId, clock) {
  return concat([varintField(1, replicaId), varintField(2, clock)]);
}

function substring(replicaId, clock, length, timestampReplica, timestampClock, child) {
  return concat([
    bytesField(1, charId(replicaId, clock)),
    varintField(2, length),
    bytesField(3, charId(timestampReplica, timestampClock)),
    varintField(5, child),
  ]);
}

function sentinelSubstring() {
  var sentinel = 0xffffffff;
  return concat([
    bytesField(1, charId(0, sentinel)),
    varintField(2, 0),
    bytesField(3, charId(0, sentinel)),
  ]);
}

function replicaClock(value) {
  return varintField(1, value);
}

function vectorClock(replicaId, textLength) {
  var clock = concat([
    bytesField(1, replicaId),
    bytesField(2, replicaClock(textLength)),
    bytesField(2, replicaClock(1)),
  ]);
  return bytesField(1, clock);
}

function encodeInitialNote(text, replicaId) {
  var length = text.length; // Apple CRDT clocks count UTF-16 code units.
  var topotext = concat([
    bytesField(2, utf8(text)),
    bytesField(3, substring(0, 0, 0, 0, 0, 1)),
    bytesField(3, substring(1, 0, length, 1, 0, 2)),
    bytesField(3, sentinelSubstring()),
    bytesField(4, vectorClock(replicaId, length)),
    bytesField(5, varintField(1, length)),
  ]);
  var version = concat([
    varintField(1, 0),
    varintField(2, 0),
    bytesField(3, topotext),
  ]);
  return concat([varintField(1, 0), bytesField(2, version)]);
}

function bytesToBase64(bytes) {
  var binary = '';
  var chunk = 0x8000;
  for (var i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function utf8Base64(text) {
  return bytesToBase64(utf8(text));
}

function base64ToBytes(value) {
  var binary = atob(String(value || ''));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64Utf8(value) {
  var bytes = base64ToBytes(value);
  var escaped = '';
  for (var i = 0; i < bytes.length; i++) {
    var hex = bytes[i].toString(16);
    escaped += '%' + (hex.length === 1 ? '0' + hex : hex);
  }
  try { return decodeURIComponent(escaped); } catch (e) { return ''; }
}

function deriveTitle(text) {
  var lineEnd = text.indexOf('\n');
  var firstLine = lineEnd === -1 ? text : text.substring(0, lineEnd);
  if (firstLine.length <= 76) return firstLine;
  var boundary = firstLine.lastIndexOf(' ', 76);
  return boundary > 0 ? firstLine.substring(0, boundary) : firstLine.substring(0, 76);
}

function deriveSnippet(text) {
  var afterTitle = text.substring(deriveTitle(text).length).replace(/^\s+/, '');
  var lineEnd = afterTitle.indexOf('\n');
  var snippet = (lineEnd === -1 ? afterTitle : afterTitle.substring(0, lineEnd)).substring(0, 500);
  return snippet.length ? snippet : 'No additional text';
}

function buildCreateFields(text, compressedBase64, nowMs) {
  var folder = { recordName: DEFAULT_FOLDER, action: 'VALIDATE', zoneID: { zoneName: 'Notes' } };
  return {
    CreationDate: { value: nowMs },
    Folders: { value: [folder] },
    Folder: { value: folder },
    ModificationDate: { value: nowMs },
    TitleEncrypted: { value: utf8Base64(deriveTitle(text)) },
    SnippetEncrypted: { value: utf8Base64(deriveSnippet(text)) },
    FirstAttachmentThumbnail: {},
    FirstAttachmentUTIEncrypted: {},
    TextDataAsset: {},
    TextDataEncrypted: { value: compressedBase64 },
  };
}

function createNote(current, text) {
  var replicaId = randomBytes(16);
  var recordName = randomUuid();
  var documentBytes = encodeInitialNote(text, replicaId);
  var compressed = deflate(documentBytes);
  var nowMs = Date.now();
  var params = queryString({
    ckjsBuildVersion: CKJS_BUILD_VERSION,
    ckjsVersion: CKJS_VERSION,
    clientId: current.session.clientId,
    clientBuildNumber: current.session.clientBuildNumber,
    clientMasteringNumber: current.session.clientMasteringNumber,
    dsid: current.dsid,
  });
  var url = current.ckdatabasewsUrl +
    '/database/1/com.apple.notes/production/private/records/modify?' + params;
  var body = {
    operations: [{
      operationType: 'create',
      record: {
        recordName: recordName,
        recordType: 'Note',
        fields: buildCreateFields(text, bytesToBase64(compressed), nowMs),
      },
    }],
    zoneID: { zoneName: 'Notes' },
  };
  return http('POST', url, {
    Cookie: current.session.cookie,
    'Content-Type': 'application/json',
    Origin: 'https://www.icloud.com',
    Referer: 'https://www.icloud.com/',
    'User-Agent': ICLOUD_USER_AGENT,
    Accept: 'application/json',
  }, JSON.stringify(body)).then(function (result) {
    if (!result.ok) {
      return { ok: false, status: result.status, error: result.status ?
        'Apple Notes returned HTTP ' + result.status + '.' : 'Could not reach Apple Notes.' };
    }
    var entry = result.json && result.json.records && result.json.records[0];
    if (!entry) return { ok: false, status: 500, error: 'Apple Notes returned no created record.' };
    if (entry.serverErrorCode) {
      return {
        ok: false,
        status: 400,
        error: String(entry.reason || entry.serverErrorCode),
        serverErrorCode: String(entry.serverErrorCode),
      };
    }
    return { ok: true, recordName: entry.recordName || recordName };
  });
}

function databaseUrl(current, operation) {
  var params = queryString({
    ckjsBuildVersion: CKJS_BUILD_VERSION,
    ckjsVersion: CKJS_VERSION,
    clientId: current.session.clientId,
    clientBuildNumber: current.session.clientBuildNumber,
    clientMasteringNumber: current.session.clientMasteringNumber,
    dsid: current.dsid,
  });
  return current.ckdatabasewsUrl +
    '/database/1/com.apple.notes/production/private/' + operation + '?' + params;
}

function postDatabase(current, operation, body) {
  return http('POST', databaseUrl(current, operation), {
    Cookie: current.session.cookie,
    'Content-Type': 'application/json',
    Origin: 'https://www.icloud.com',
    Referer: 'https://www.icloud.com/',
    'User-Agent': ICLOUD_USER_AGENT,
    Accept: 'application/json',
  }, JSON.stringify(body)).then(function (result) {
    if (result.ok) return result;
    return {
      ok: false,
      status: result.status,
      error: result.status ? 'Apple Notes returned HTTP ' + result.status + '.' :
        'Could not reach Apple Notes.',
    };
  });
}

function noteIsDeleted(record) {
  return record && (record.deleted === true ||
    (record.fields && record.fields.Deleted && record.fields.Deleted.value === 1));
}

function noteModificationMs(record) {
  var field = record && record.fields && record.fields.ModificationDate;
  if (field && typeof field.value === 'number') return field.value;
  if (record && record.modified && typeof record.modified.timestamp === 'number') {
    return record.modified.timestamp;
  }
  return 0;
}

function noteTitle(record) {
  var field = record && record.fields && record.fields.TitleEncrypted;
  var decoded = field && typeof field.value === 'string' ? base64Utf8(field.value).trim() : '';
  return decoded || 'Untitled note';
}

/** Full private-zone walk, matching icloud-md fetchZoneNoteRecords. */
async function fetchRecentNotes(current) {
  var records = [];
  var syncToken = null;
  var seenTokens = {};
  var moreComing = true;
  while (moreComing) {
    var zoneRequest = {
      zoneID: PRIVATE_NOTES_ZONE,
      desiredKeys: ['TitleEncrypted', 'ModificationDate', 'Deleted'],
      desiredRecordTypes: ['Note'],
      reverse: true,
    };
    if (syncToken) zoneRequest.syncToken = syncToken;
    var result = await postDatabase(current, 'changes/zone', { zones: [zoneRequest] });
    if (!result.ok) return result;
    var zones = result.json && result.json.zones;
    var zone = zones && zones[0];
    if (!zone || typeof zone !== 'object') {
      return { ok: false, status: 500, error: 'Apple Notes returned no Notes zone.' };
    }
    if (zone.serverErrorCode) {
      return {
        ok: false,
        status: 400,
        serverErrorCode: String(zone.serverErrorCode),
        error: String(zone.reason || zone.serverErrorCode),
      };
    }
    if (Array.isArray(zone.records)) records = records.concat(zone.records);
    moreComing = zone.moreComing === true;
    if (moreComing) {
      var nextToken = typeof zone.syncToken === 'string' ? zone.syncToken : '';
      if (!nextToken || seenTokens[nextToken]) {
        return { ok: false, status: 500, error: 'Apple Notes returned invalid list paging data.' };
      }
      seenTokens[nextToken] = true;
      syncToken = nextToken;
    }
  }
  var notes = records.filter(function (record) {
    return record && record.recordType === 'Note' && typeof record.recordName === 'string' &&
      !noteIsDeleted(record);
  }).map(function (record) {
    return {
      recordName: record.recordName,
      title: noteTitle(record),
      modificationDateMs: noteModificationMs(record),
    };
  });
  notes.sort(function (left, right) {
    if (right.modificationDateMs !== left.modificationDateMs) {
      return right.modificationDateMs - left.modificationDateMs;
    }
    return left.recordName < right.recordName ? -1 : left.recordName > right.recordName ? 1 : 0;
  });
  return { ok: true, notes: notes.slice(0, RECENT_NOTE_LIMIT) };
}

async function lookupNote(current, recordName) {
  var result = await postDatabase(current, 'records/lookup', {
    records: [{ recordName: recordName }],
    zoneID: PRIVATE_NOTES_ZONE,
  });
  if (!result.ok) return result;
  var entry = result.json && result.json.records && result.json.records[0];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, status: 404, error: 'The selected Apple Note no longer exists.' };
  }
  if (entry.serverErrorCode) {
    return {
      ok: false,
      status: 400,
      serverErrorCode: String(entry.serverErrorCode),
      error: String(entry.reason || entry.serverErrorCode),
    };
  }
  if (entry.recordName !== recordName || entry.recordType !== 'Note' || !entry.fields) {
    return { ok: false, status: 500, error: 'Apple Notes returned an unexpected selected note.' };
  }
  if (noteIsDeleted(entry)) {
    return { ok: false, status: 404, error: 'The selected Apple Note was deleted.' };
  }
  return { ok: true, record: entry };
}

var ECHOED_UPDATE_FIELDS = [
  'MinimumSupportedNotesVersion', 'Folders', 'Deleted', 'Folder', 'CreationDate',
  'ReplicaIDToNotesVersionDataEncrypted', 'FoldersModificationDate', 'AttachmentViewType',
  'PaperStyleType', 'ReplicaIDToUserIDEncrypted',
];
var NULL_UPDATE_FIELDS = ['FirstAttachmentThumbnail', 'FirstAttachmentUTIEncrypted', 'TextDataAsset'];

/** Exact browser-JS port of icloud-md buildNoteUpdateFields. */
function buildUpdateFields(record, compressedBase64, text, nowMs) {
  var fields = {
    ModificationDate: { value: nowMs },
    TitleEncrypted: { value: utf8Base64(deriveTitle(text)) },
  };
  ECHOED_UPDATE_FIELDS.forEach(function (name) {
    if (record.fields[name] !== undefined) fields[name] = { value: record.fields[name].value };
  });
  fields.SnippetEncrypted = { value: utf8Base64(deriveSnippet(text)) };
  NULL_UPDATE_FIELDS.forEach(function (name) {
    fields[name] = { value: record.fields[name] && record.fields[name].value != null ?
      record.fields[name].value : null };
  });
  fields.TextDataEncrypted = { value: compressedBase64 };
  return fields;
}

/** Each added line is a "–" list item: right under the title for top, after the last line for bottom. */
function appendPlan(existing, incoming, placement) {
  var item = incoming.replace(/\s+$/, '');
  if (!existing) return { text: item, listStart: 0, listLength: 0 };
  if (!item) return { text: existing, listStart: 0, listLength: 0 };
  if (placement === 'top') {
    // Keep the first line as the existing Apple Note title. "Top" means the first body entry.
    var titleEnd = existing.indexOf('\n');
    if (titleEnd === -1) {
      return { text: existing + '\n' + item, listStart: existing.length + 1, listLength: item.length };
    }
    var at = titleEnd + 1;
    var line = item + (at < existing.length ? '\n' : '');
    return { text: existing.substring(0, at) + line + existing.substring(at), listStart: at, listLength: line.length };
  }
  var separator = /\n$/.test(existing) ? '' : '\n';
  var start = existing.length + separator.length;
  return { text: existing + separator + item, listStart: start, listLength: item.length };
}

function appendText(existing, incoming, placement) {
  return appendPlan(existing, incoming, placement).text;
}

// Apple's dashed-list paragraph style and natural alignment, as Notes of Fruit decodes them.
var STYLE_DASHED_LIST = 101;
var ALIGNMENT_NATURAL = 4;
function styleRange(document, start, length, style) {
  if (length <= 0) return;
  var end = start + length;
  var position = 0;
  var out = [];
  document.attributeRuns.forEach(function (run) {
    var runStart = position;
    var runEnd = position + run.length;
    position = runEnd;
    var cuts = [runStart, Math.min(Math.max(start, runStart), runEnd), Math.min(Math.max(end, runStart), runEnd), runEnd];
    for (var i = 0; i < 3; i++) {
      var pieceLength = cuts[i + 1] - cuts[i];
      if (pieceLength <= 0) continue;
      if (i === 1 && run.attachmentInfo !== undefined) throw new Error('Could not style text next to an attachment safely.');
      var piece = i !== 1 ? clone(AttributeRunSchema, run) : style === null ?
        create(AttributeRunSchema, { length: pieceLength }) :
        create(AttributeRunSchema, { length: pieceLength, paragraphStyle: { style: style, alignment: ALIGNMENT_NATURAL } });
      piece.length = pieceLength;
      out.push(piece);
    }
  });
  document.attributeRuns = out;
}

function editorReplicaBytes(current) {
  if (typeof current.editorReplicaId === 'string') {
    try {
      var saved = base64ToBytes(current.editorReplicaId);
      if (saved.length === 16) return saved;
    } catch (error) { /* generate a replacement below */ }
  }
  var created = randomBytes(16);
  saveState({ editorReplicaId: bytesToBase64(created) });
  return created;
}

// iCloud.com moves the editing replica to clock slot 1 and shifts the others down; the Mac
// takes that rotation as its cue to reload the note, and without it merges the edit onto
// its stale copy and duplicates the body (Notes of Fruit's NoteAppender, verified there).
function promoteReplicaToFront(document, replicaId) {
  var oldIndex = document.replicas.findIndex(function (replica) {
    return bytesEqual(replica.id, replicaId);
  });
  var ours;
  if (oldIndex === -1) {
    ours = {
      id: replicaId,
      counters: [
        Math.max.apply(null, [0].concat(document.replicas.map(function (replica) { return replica.counters[0] || 0; }))),
        Math.max.apply(null, [0].concat(document.replicas.map(function (replica) { return replica.counters[1] || 0; }))),
      ],
    };
  } else {
    ours = document.replicas[oldIndex];
  }
  var oldSlot = oldIndex + 1;
  function remap(slot) {
    if (slot === 0) return 0;
    if (oldIndex !== -1 && slot === oldSlot) return 1;
    if (oldIndex === -1 || slot < oldSlot) return slot + 1;
    return slot;
  }
  document.runs.forEach(function (run) {
    run.coord.replica = remap(run.coord.replica);
    run.anchor.replica = remap(run.anchor.replica);
  });
  document.replicas = [ours].concat(document.replicas.filter(function (replica) { return replica !== ours; }));
}

function prepareAppend(record, incoming, placement, replicaId) {
  if (incoming.indexOf('\ufffc') !== -1) {
    return { ok: false, status: 400, error: 'The appended text contains an embedded-object marker.' };
  }
  if (!record.recordChangeTag || typeof record.recordChangeTag !== 'string') {
    return { ok: false, status: 500, error: 'The selected Apple Note has no concurrency token.' };
  }
  var bodyField = record.fields.TextDataEncrypted;
  if (!bodyField || typeof bodyField.value !== 'string') {
    return { ok: false, status: 400, error: 'The selected Apple Note has no editable text body.' };
  }
  if (record.fields.TextDataAsset && record.fields.TextDataAsset.value != null) {
    return { ok: false, status: 400, error: 'The selected Apple Note is too large to edit safely.' };
  }
  try {
    var raw = inflate(base64ToBytes(bodyField.value));
    if (!noteDocumentRoundTrips(raw)) {
      return { ok: false, status: 400, error: 'The selected Apple Note uses an unsupported document format.' };
    }
    var document = parseNoteDocument(raw);
    var plan = appendPlan(document.text, incoming, placement);
    promoteReplicaToFront(document, replicaId);
    applyTextEdit(document, plan.text, { replicaId: replicaId });
    if (plan.listLength > 0) styleRange(document, plan.listStart, plan.listLength, STYLE_DASHED_LIST);
    validateDocumentInvariants(document);
    var rebuilt = encodeNoteDocument(document);
    if (!noteDocumentRoundTrips(rebuilt) || parseNoteDocument(rebuilt).text !== plan.text) {
      return { ok: false, status: 500, error: 'Apple Note append verification failed before upload.' };
    }
    var compressed = deflate(rebuilt);
    if (parseNoteDocument(inflate(compressed)).text !== plan.text) {
      return { ok: false, status: 500, error: 'Compressed Apple Note verification failed before upload.' };
    }
    return {
      ok: true,
      text: plan.text,
      compressedBase64: bytesToBase64(compressed),
    };
  } catch (error) {
    return {
      ok: false,
      status: 400,
      error: 'The selected Apple Note could not be edited safely: ' +
        (error && error.message ? error.message : String(error)),
    };
  }
}

async function appendToNote(current, destination, incoming, expectedGeneration) {
  var lookedUp = await lookupNote(current, destination.recordName);
  if (!lookedUp.ok) return lookedUp;
  if (!generationIsActive(expectedGeneration, true)) return staleAuthenticationResult();
  var prepared = prepareAppend(
    lookedUp.record,
    incoming,
    destination.placement,
    editorReplicaBytes(current),
  );
  if (!prepared.ok) return prepared;
  var record = {
    recordName: lookedUp.record.recordName,
    recordType: 'Note',
    recordChangeTag: lookedUp.record.recordChangeTag,
    fields: buildUpdateFields(lookedUp.record, prepared.compressedBase64, prepared.text, Date.now()),
  };
  if (lookedUp.record.parent && typeof lookedUp.record.parent.recordName === 'string') {
    record.parent = { recordName: lookedUp.record.parent.recordName };
  }
  var result = await postDatabase(current, 'records/modify', {
    operations: [{ operationType: 'update', record: record }],
    zoneID: PRIVATE_NOTES_ZONE,
  });
  if (!result.ok) return result;
  if (!generationIsActive(expectedGeneration, true)) return staleAuthenticationResult();
  var entry = result.json && result.json.records && result.json.records[0];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, status: 500, error: 'Apple Notes returned no updated record.' };
  }
  if (entry.serverErrorCode) {
    return {
      ok: false,
      status: 400,
      serverErrorCode: String(entry.serverErrorCode),
      error: String(entry.reason || entry.serverErrorCode),
    };
  }
  return {
    ok: true,
    recordName: entry.recordName || destination.recordName,
    title: noteTitle(lookedUp.record),
  };
}

function pluginError(result) {
  console.error('Apple Notes request failed: HTTP ' + result.status);
  if (
    result.status === 401 || result.status === 403 || result.status === 421 ||
    /AUTH|NOT_AUTHENTICATED|SESSION/i.test(String(result.serverErrorCode || ''))
  ) {
    return { code: 'AUTH_REQUIRED', message: result.error || 'Apple authorization expired.' };
  }
  if (result.status === 429 || /THROTTL|RATE_LIMIT/i.test(String(result.serverErrorCode || ''))) {
    return { code: 'RATE_LIMITED', message: result.error || 'Apple Notes rate limit reached.' };
  }
  if (/SERVER_RECORD_CHANGED|CONFLICT/i.test(String(result.serverErrorCode || ''))) {
    return { code: 'PLUGIN_UNAVAILABLE', message: 'The selected Apple Note changed; try again.' };
  }
  if (result.status === 404 || /NOT_FOUND|UNKNOWN_ITEM/i.test(String(result.serverErrorCode || ''))) {
    return { code: 'PLUGIN_UNAVAILABLE', message: result.error || 'The selected Apple Note no longer exists.' };
  }
  if (result.status === 0) {
    var host = null;
    try {
      host = lastBlocked(globalThis.localStorage);
      checkReach(globalThis.localStorage).catch(function () {});
    } catch (e) { /* storage unavailable */ }
    if (host) return { code: 'PLUGIN_UNAVAILABLE', message: blockedMessage(host) };
  }
  return { code: 'PLUGIN_UNAVAILABLE', message: result.error || 'Apple Notes is unavailable.' };
}

function shortText(text) {
  return { shortText: { text: String(text) } };
}

function textReading(text) {
  return { shortText: { text: String(text) }, longText: { text: String(text) } };
}

function booleanReading(value) {
  return {
    boolean: { value: !!value },
    shortText: { text: value ? 'Connected' : 'Not connected' },
  };
}

function appleNotesUrl(recordName) {
  return 'applenotes://showNote?identifier=' + encodeURIComponent(recordName);
}

Pebble.registerSourceHandler(function (request, respond) {
  var isConfiguredSource = request.category === 'notes' && request.item === 'configured';
  if (!isConfiguredSource && (request.category !== 'notes' || request.item !== 'destination')) {
    console.error('Unsupported source: ' + request.category + '/' + request.item);
    respond.error('PLUGIN_UNAVAILABLE', 'Unknown source ' + request.category + '/' + request.item + '.');
    return;
  }
  var current = state();
  var configured = !!current.session && !!current.dsid && !!current.ckdatabasewsUrl;
  if (isConfiguredSource) {
    respond.data({
      validUntilMs: Date.now() + 60 * 1000,
      instances: [{
        instanceId: 'apple-notes',
        properties: { name: shortText('Apple Notes'), configured: booleanReading(configured) },
      }],
    });
    return;
  }
  respond.data({
    validUntilMs: Date.now() + 60 * 1000,
    instances: [{
      instanceId: 'apple-notes',
      properties: {
        name: shortText('Apple Notes'),
        configured: booleanReading(configured),
        account: textReading(current.appleId || 'Sign in to Apple in Apple Notes settings'),
        url: { longText: { text: 'https://www.icloud.com/notes/' } },
      },
    }],
  });
});

Pebble.registerActionHandler(async function (request, respond) {
  if (request.action !== 'create_note') {
    console.error('Unsupported action: ' + request.action);
    respond.error('PLUGIN_UNAVAILABLE', 'Unknown action ' + request.action + '.');
    return;
  }
  var args = request.args || {};
  if (args.instanceId !== undefined && args.instanceId !== 'apple-notes') {
    respond.error('INVALID_ARGS', 'Unknown notes destination ' + args.instanceId + '.');
    return;
  }
  var text = typeof args.text === 'string' ? args.text : '';
  if (!text.trim()) {
    respond.error('INVALID_ARGS', 'The note text cannot be empty.');
    return;
  }
  var current = stateWithAuthGeneration();
  if (!current.session) {
    respond.error('AUTH_REQUIRED', 'Sign in to Apple in Apple Notes settings first.');
    return;
  }
  var expectedGeneration = current.authGeneration;

  // /validate is both a liveness check and the authoritative source of dsid/CloudKit host. It
  // also rotates Apple's web-auth cookie, which verifyAndPersist saves before the write.
  var auth = await verifyAndPersist(current.session, {
    expectedGeneration: expectedGeneration,
    requireSession: true,
  });
  if (!auth.ok) {
    var authError = pluginError(auth);
    respond.error(authError.code, authError.message);
    return;
  }
  current = state();
  if (!generationIsActive(expectedGeneration, true)) {
    var disconnected = pluginError(staleAuthenticationResult());
    respond.error(disconnected.code, disconnected.message);
    return;
  }
  var oneLine = text.trim().replace(/\s+/g, ' ');
  var excerpt = oneLine.length > 42 ? oneLine.substring(0, 39) + '...' : oneLine;
  var destination = normalizeDestination(current.destination);
  if (destination.mode === 'append') {
    var appended = await appendToNote(current, destination, text, expectedGeneration);
    if (!appended.ok) {
      var appendError = pluginError(appended);
      respond.error(appendError.code, appendError.message);
      return;
    }
    if (appended.title !== destination.title) {
      destination.title = appended.title;
      saveState({ destination: destination });
    }
    Pebble.refreshSources(DESTINATION_SOURCES);
    respond.ok({
      text: 'Added to the ' + destination.placement + ' of “' + appended.title + '” in Apple Notes',
      url: appleNotesUrl(appended.recordName),
      refreshed: DESTINATION_SOURCES,
    });
    return;
  }

  var created = await createNote(current, text);
  if (!created.ok) {
    var createError = pluginError(created);
    respond.error(createError.code, createError.message);
    return;
  }
  if (!generationIsActive(expectedGeneration, true)) {
    var createDisconnected = pluginError(staleAuthenticationResult());
    respond.error(createDisconnected.code, createDisconnected.message);
    return;
  }
  Pebble.refreshSources(DESTINATION_SOURCES);
  respond.ok({
    text: 'Saved to Apple Notes: “' + excerpt + '”',
    url: appleNotesUrl(created.recordName),
    refreshed: DESTINATION_SOURCES,
  });
});

Pebble.registerConfigHandler(async function (message, respond) {
  if (message && message.type === 'reach') {
    respond({ blocked: await checkReach(globalThis.localStorage).catch(function () { return null; }) });
    return;
  }
  var current = state();
  switch (message && message.type) {
    case 'status':
      respond({
        configured: !!current.session,
        ready: !!current.session && !!current.dsid && !!current.ckdatabasewsUrl,
        appleId: current.appleId,
        fullName: current.fullName,
        capturedAt: current.session && current.session.capturedAt,
        destination: normalizeDestination(current.destination),
      });
      return;

    case 'setSession': {
      var previousAppleId = current.appleId;
      var setSessionGeneration = current.authGeneration;
      var session;
      try { session = parseSessionJson(message.sessionJson); } catch (e) {
        respond({ error: e.message || String(e) });
        return;
      }
      var auth = await verifyAndPersist(session, {
        expectedGeneration: setSessionGeneration,
        requireSession: false,
        replaceGeneration: true,
      });
      if (!auth.ok) {
        respond({ error: auth.error, authRequired: true });
        return;
      }
      if (previousAppleId && previousAppleId !== auth.appleId) {
        saveState({ destination: defaultDestination() });
      }
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({
        configured: true,
        ready: true,
        appleId: auth.appleId,
        fullName: auth.fullName,
        destination: state().destination,
      });
      return;
    }

    case 'verify': {
      current = stateWithAuthGeneration();
      if (!current.session) {
        respond({ error: 'Sign in to Apple first.', authRequired: true });
        return;
      }
      var checked = await verifyAndPersist(current.session, {
        expectedGeneration: current.authGeneration,
        requireSession: true,
      });
      if (!checked.ok) {
        respond({ error: checked.error, authRequired: true });
        return;
      }
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({ ready: true, appleId: checked.appleId, fullName: checked.fullName });
      return;
    }

    case 'listNotes': {
      current = stateWithAuthGeneration();
      if (!current.session) {
        respond({ error: 'Sign in to iCloud first.', authRequired: true });
        return;
      }
      var listGeneration = current.authGeneration;
      var listAuth = await verifyAndPersist(current.session, {
        expectedGeneration: listGeneration,
        requireSession: true,
      });
      if (!listAuth.ok) {
        respond({ error: listAuth.error, authRequired: true });
        return;
      }
      current = state();
      var listed = await fetchRecentNotes(current);
      if (!listed.ok) {
        var listError = pluginError(listed);
        respond({ error: listError.message });
        return;
      }
      if (!generationIsActive(listGeneration, true)) {
        respond({ error: staleAuthenticationResult().error, authRequired: true });
        return;
      }
      respond({ notes: listed.notes, destination: normalizeDestination(current.destination) });
      return;
    }

    case 'setDestination': {
      var destination;
      if (message.mode === 'create') {
        destination = defaultDestination();
      } else if (message.mode === 'append') {
        destination = normalizeDestination({
          mode: 'append',
          recordName: message.recordName,
          title: message.title,
          placement: message.placement,
        });
        if (destination.mode !== 'append') {
          respond({ error: 'Choose an Apple Note to append to.' });
          return;
        }
      } else {
        respond({ error: 'Unknown Apple Notes destination mode.' });
        return;
      }
      saveState({ destination: destination });
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({ saved: true, destination: destination });
      return;
    }

    case 'disconnect':
    case 'unlink':
      clearState();
      Pebble.refreshSources(DESTINATION_SOURCES);
      respond({ configured: false, ready: false });
      return;

    default:
      respond({ error: 'Unknown Apple Notes configuration command.' });
  }
});

// Standalone validation hook. Plugin sessions are isolated and cold-started, so this does not
// expose application data; it lets the PBW's deterministic encoder be compared against the
// upstream icloud-md implementation without duplicating it in a test artifact.
globalThis.__appleNotesPbwTest = {
  encodeInitialNote: encodeInitialNote,
  buildCreateFields: buildCreateFields,
  buildUpdateFields: buildUpdateFields,
  appendText: appendText,
  prepareAppend: prepareAppend,
  parseNoteDocument: parseNoteDocument,
  inflate: inflate,
  deflate: deflate,
  base64ToBytes: base64ToBytes,
  bytesToBase64: bytesToBase64,
  encodeNoteDocument: encodeNoteDocument,
  utf8: utf8,
};
