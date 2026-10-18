'use strict';

function PluginError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function bytesToBinary(bytes) {
  var binary = '';
  for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return binary;
}

function binaryToBytes(binary) {
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64(bytes) {
  return btoa(bytesToBinary(bytes));
}

function base64url(bytes) {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(text) {
  var normal = text.replace(/-/g, '+').replace(/_/g, '/');
  while (normal.length % 4) normal += '=';
  return binaryToBytes(atob(normal));
}

/** UTF-8 without TextEncoder, which JavaScriptCore lacks. */
function utf8(text) {
  return binaryToBytes(unescape(encodeURIComponent(text)));
}

function fromUtf8(bytes) {
  return decodeURIComponent(escape(bytesToBinary(bytes)));
}

/** Ids only, never secrets: JavaScriptCore (iOS plugins) has no crypto, so this can fall back to Math.random. */
function uuid() {
  var bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (var j = 0; j < 16; j++) bytes[j] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  var hex = '';
  for (var i = 0; i < 16; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
}

/** A JWT's claims, or null if it isn't one. */
function jwtClaims(token) {
  var parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(fromUtf8(fromBase64(parts[1])));
  } catch (_) {
    return null;
  }
}

/** Epoch seconds or milliseconds as milliseconds; 0 when missing. */
function toMillis(value) {
  var n = Number(value) || 0;
  return n && n < 1e12 ? Math.round(n * 1000) : n;
}

function form(fields) {
  return Object.keys(fields).map(function (key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(fields[key]);
  }).join('&');
}

/** Case-insensitive pick by id or label substring; throws listing the choices when it can't. */
function pick(items, query, label, noun) {
  if (!items.length) throw PluginError('PLUGIN_UNAVAILABLE', 'No ' + noun + 's found.');
  if (!query) return items[0];
  var wanted = String(query).trim().toLowerCase();
  var exact = items.filter(function (item) { return item.id.toLowerCase() === wanted || label(item).toLowerCase() === wanted; });
  var matches = exact.length ? exact : items.filter(function (item) { return label(item).toLowerCase().indexOf(wanted) >= 0; });
  if (matches.length === 1) return matches[0];
  var names = (matches.length ? matches : items).slice(0, 8).map(function (item) { return '"' + label(item) + '"'; }).join(', ');
  throw PluginError('INVALID_ARGS', (matches.length ? 'More than one ' : 'No ') + noun + ' matches "' + query + '". Choose one of: ' + names + '.');
}

module.exports = {
  PluginError: PluginError, base64: base64, base64url: base64url, fromBase64: fromBase64, utf8: utf8,
  fromUtf8: fromUtf8, uuid: uuid, jwtClaims: jwtClaims, form: form, pick: pick, toMillis: toMillis,
};
