'use strict';

/**
 * Versioned, JSON-only schema shared by every differential-harness adapter.
 *
 * Binary values are deliberately explicit rather than plain base64 strings so
 * comparators can report the first differing byte rather than a character in
 * the encoded representation.
 */

const SCHEMA_VERSION = 1;
const BYTE_KEY = '$bytes';
const MAX_BINARY_BYTES = 16 * 1024 * 1024;
const MAX_RANDOM_BYTES = 1024 * 1024;

const EFFECT_FIELDS = Object.freeze({
  'random.request': { required: ['requestId', 'length'] },
  'clock.read': { required: ['requestId'] },
  'timer.schedule': { required: ['requestId', 'deadlineMs'], optional: ['label'] },
  'crypto.request': { required: ['requestId', 'operation', 'parameters'] },
  'http.request': {
    required: ['requestId', 'method', 'url', 'headers'],
    optional: ['body', 'timeoutMs', 'cookieJarId'],
  },
  'websocket.open': {
    required: ['requestId', 'socketId', 'url'],
    optional: ['protocols', 'headers', 'timeoutMs'],
  },
  'websocket.send': {
    required: ['requestId', 'socketId', 'frameType'],
    optional: ['text', 'data'],
  },
  'websocket.receive': {
    required: ['requestId', 'socketId'],
    optional: ['timeoutMs'],
  },
  'websocket.close': {
    required: ['requestId', 'socketId'],
    optional: ['code', 'reason'],
  },
  'tls.open': {
    required: ['requestId', 'streamId', 'host', 'port'],
    optional: ['sni', 'alpn', 'trustAnchors', 'timeoutMs'],
  },
  'tls.write': {
    required: ['requestId', 'streamId', 'data'],
    optional: ['timeoutMs'],
  },
  'tls.read': {
    required: ['requestId', 'streamId'],
    optional: ['minimumBytes', 'maximumBytes', 'timeoutMs'],
  },
  'tls.close': { required: ['requestId', 'streamId'] },
  'storage.read': { required: ['requestId', 'key'] },
  'storage.write': { required: ['requestId', 'key', 'value'] },
  'storage.delete': { required: ['requestId', 'key'] },
  'state.transition': {
    required: ['from', 'to'],
    optional: ['reason', 'metadata'],
  },
  'terminal.result': { required: ['result'] },
  'terminal.error': { required: ['error'] },
});

const EVENT_FIELDS = Object.freeze({
  'random.result': { required: ['requestId', 'data'] },
  'clock.result': { required: ['requestId', 'nowMs'] },
  'timer.fired': { required: ['requestId', 'nowMs'] },
  'crypto.result': { required: ['requestId', 'result'] },
  'http.response': {
    required: ['requestId', 'status', 'headers', 'body'],
    optional: ['url'],
  },
  'websocket.opened': {
    required: ['requestId', 'socketId'],
    optional: ['protocol'],
  },
  'websocket.frame': {
    required: ['requestId', 'socketId', 'frameType'],
    optional: ['text', 'data'],
  },
  'websocket.sent': { required: ['requestId', 'socketId'] },
  'websocket.closed': {
    required: ['requestId', 'socketId'],
    optional: ['code', 'reason'],
  },
  'websocket.error': { required: ['requestId', 'socketId', 'error'] },
  'tls.opened': {
    required: ['requestId', 'streamId'],
    optional: ['negotiatedAlpn'],
  },
  'tls.data': { required: ['requestId', 'streamId', 'data'] },
  'tls.written': { required: ['requestId', 'streamId', 'length'] },
  'tls.closed': { required: ['requestId', 'streamId'] },
  'tls.error': { required: ['requestId', 'streamId', 'error'] },
  'storage.result': {
    required: ['requestId'],
    optional: ['found', 'value'],
  },
  'storage.error': { required: ['requestId', 'error'] },
  'effect.error': { required: ['requestId', 'error'] },
});

const BLOCKING_EFFECT_KINDS = Object.freeze(new Set([
  'random.request',
  'clock.read',
  'timer.schedule',
  'crypto.request',
  'http.request',
  'websocket.open',
  'websocket.send',
  'websocket.receive',
  'websocket.close',
  'tls.open',
  'tls.write',
  'tls.read',
  'tls.close',
  'storage.read',
  'storage.write',
  'storage.delete',
]));

const TERMINAL_EFFECT_KINDS = Object.freeze(new Set([
  'terminal.result',
  'terminal.error',
]));

const RESPONSE_KINDS = Object.freeze({
  'random.request': new Set(['random.result', 'effect.error']),
  'clock.read': new Set(['clock.result', 'effect.error']),
  'timer.schedule': new Set(['timer.fired', 'effect.error']),
  'crypto.request': new Set(['crypto.result', 'effect.error']),
  'http.request': new Set(['http.response', 'effect.error']),
  'websocket.open': new Set(['websocket.opened', 'websocket.error', 'effect.error']),
  'websocket.send': new Set(['websocket.sent', 'websocket.error', 'effect.error']),
  'websocket.receive': new Set([
    'websocket.frame',
    'websocket.closed',
    'websocket.error',
    'effect.error',
  ]),
  'websocket.close': new Set(['websocket.closed', 'websocket.error', 'effect.error']),
  'tls.open': new Set(['tls.opened', 'tls.error', 'effect.error']),
  'tls.write': new Set(['tls.written', 'tls.error', 'effect.error']),
  'tls.read': new Set(['tls.data', 'tls.closed', 'tls.error', 'effect.error']),
  'tls.close': new Set(['tls.closed', 'tls.error', 'effect.error']),
  'storage.read': new Set(['storage.result', 'storage.error', 'effect.error']),
  'storage.write': new Set(['storage.result', 'storage.error', 'effect.error']),
  'storage.delete': new Set(['storage.result', 'storage.error', 'effect.error']),
});

class SchemaValidationError extends Error {
  constructor(path, message) {
    super(`Invalid harness value at ${path}: ${message}`);
    this.name = 'SchemaValidationError';
    this.path = path;
  }
}

function fail(path, message) {
  throw new SchemaValidationError(path, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  // Objects crossing a Node vm / JavaScriptCore adapter have a different
  // realm's Object.prototype but are still plain JSON records.
  return Object.prototype.toString.call(value) === '[object Object]'
    && prototype.constructor
    && prototype.constructor.name === 'Object';
}

function isByteString(value) {
  return isPlainObject(value)
    && Object.keys(value).length === 1
    && typeof value[BYTE_KEY] === 'string';
}

function validateBase64(value, path) {
  if (value.length % 4 !== 0) fail(path, 'base64 must use canonical padding');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(path, 'expected canonical base64');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const length = (value.length / 4) * 3 - padding;
  if (length > MAX_BINARY_BYTES) fail(path, `binary value exceeds ${MAX_BINARY_BYTES} bytes`);
  return length;
}

function validateByteString(value, path = '$') {
  if (!isByteString(value)) fail(path, `expected {"${BYTE_KEY}": "<base64>"}`);
  validateBase64(value[BYTE_KEY], `${path}.${BYTE_KEY}`);
  return value;
}

function encodeBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;
    const second = hasSecond ? bytes[offset + 1] : 0;
    const third = hasThird ? bytes[offset + 2] : 0;
    output += alphabet[first >>> 2];
    output += alphabet[((first & 3) << 4) | (second >>> 4)];
    output += hasSecond ? alphabet[((second & 15) << 2) | (third >>> 6)] : '=';
    output += hasThird ? alphabet[third & 63] : '=';
  }
  return output;
}

function byteString(bytes) {
  if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) {
    throw new TypeError('byteString expects Uint8Array or an array of bytes');
  }
  const normalized = Uint8Array.from(bytes);
  return { [BYTE_KEY]: encodeBase64(normalized) };
}

function decodeByteString(value) {
  validateByteString(value);
  const input = value[BYTE_KEY];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const outputLength = validateBase64(input, `$.${BYTE_KEY}`);
  const output = new Uint8Array(outputLength);
  let outputOffset = 0;
  for (let offset = 0; offset < input.length; offset += 4) {
    const first = alphabet.indexOf(input[offset]);
    const second = alphabet.indexOf(input[offset + 1]);
    const third = input[offset + 2] === '=' ? 0 : alphabet.indexOf(input[offset + 2]);
    const fourth = input[offset + 3] === '=' ? 0 : alphabet.indexOf(input[offset + 3]);
    if (outputOffset < outputLength) output[outputOffset++] = (first << 2) | (second >>> 4);
    if (outputOffset < outputLength) output[outputOffset++] = ((second & 15) << 4) | (third >>> 2);
    if (outputOffset < outputLength) output[outputOffset++] = ((third & 3) << 6) | fourth;
  }
  return output;
}

function validateJson(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') fail(path, `expected JSON value, got ${typeof value}`);
  if (seen.has(value)) fail(path, 'cyclic values are not supported');
  seen.add(value);
  if (isByteString(value)) {
    validateByteString(value, path);
  } else if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      validateJson(value[index], `${path}[${index}]`, seen);
    }
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      validateJson(value[key], appendPath(path, key), seen);
    }
  } else {
    fail(path, 'expected a plain JSON object');
  }
  seen.delete(value);
  return value;
}

function appendPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

function requireString(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail(path, allowEmpty ? 'expected string' : 'expected non-empty string');
  }
}

function requireInteger(value, path, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `expected integer in [${minimum}, ${maximum}]`);
  }
}

function validateHeaders(headers, path) {
  if (!Array.isArray(headers)) fail(path, 'expected ordered [name, value] header tuples');
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!Array.isArray(header) || header.length !== 2) fail(`${path}[${index}]`, 'expected [name, value]');
    requireString(header[0], `${path}[${index}][0]`);
    requireString(header[1], `${path}[${index}][1]`, { allowEmpty: true });
  }
}

function validateError(error, path) {
  if (!isPlainObject(error)) fail(path, 'expected error object');
  const allowed = new Set(['code', 'message', 'retryable', 'metadata']);
  for (const key of Object.keys(error)) {
    if (!allowed.has(key)) fail(appendPath(path, key), 'unknown error field');
  }
  requireString(error.code, `${path}.code`);
  if (error.message !== undefined) requireString(error.message, `${path}.message`, { allowEmpty: true });
  if (error.retryable !== undefined && typeof error.retryable !== 'boolean') {
    fail(`${path}.retryable`, 'expected boolean');
  }
  if (error.metadata !== undefined) validateJson(error.metadata, `${path}.metadata`);
}

function validateKnownFields(value, definition, path) {
  const required = definition.required || [];
  const optional = definition.optional || [];
  const allowed = new Set(['version', 'kind', ...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(appendPath(path, key), 'required field is missing');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(appendPath(path, key), 'unknown field');
  }
}

function validateCommon(value, definitions, noun, path) {
  if (!isPlainObject(value)) fail(path, `expected ${noun} object`);
  if (value.version !== SCHEMA_VERSION) fail(`${path}.version`, `expected ${SCHEMA_VERSION}`);
  requireString(value.kind, `${path}.kind`);
  const definition = definitions[value.kind];
  if (!definition) fail(`${path}.kind`, `unknown ${noun} kind ${JSON.stringify(value.kind)}`);
  validateKnownFields(value, definition, path);
  return value;
}

function validateFrame(value, path) {
  if (value.frameType !== 'text' && value.frameType !== 'binary') {
    fail(`${path}.frameType`, 'expected text or binary');
  }
  if (value.frameType === 'text') {
    requireString(value.text, `${path}.text`, { allowEmpty: true });
    if (value.data !== undefined) fail(`${path}.data`, 'binary data is invalid for a text frame');
  } else {
    validateByteString(value.data, `${path}.data`);
    if (value.text !== undefined) fail(`${path}.text`, 'text is invalid for a binary frame');
  }
}

function validateEffect(value, path = '$') {
  validateCommon(value, EFFECT_FIELDS, 'effect', path);
  const requestKinds = BLOCKING_EFFECT_KINDS;
  if (requestKinds.has(value.kind)) requireString(value.requestId, `${path}.requestId`);

  switch (value.kind) {
    case 'random.request':
      requireInteger(value.length, `${path}.length`, 0, MAX_RANDOM_BYTES);
      break;
    case 'timer.schedule':
      requireInteger(value.deadlineMs, `${path}.deadlineMs`);
      if (value.label !== undefined) requireString(value.label, `${path}.label`, { allowEmpty: true });
      break;
    case 'crypto.request':
      requireString(value.operation, `${path}.operation`);
      validateJson(value.parameters, `${path}.parameters`);
      break;
    case 'http.request':
      requireString(value.method, `${path}.method`);
      requireString(value.url, `${path}.url`);
      validateHeaders(value.headers, `${path}.headers`);
      if (value.body !== undefined) validateByteString(value.body, `${path}.body`);
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      if (value.cookieJarId !== undefined) requireString(value.cookieJarId, `${path}.cookieJarId`);
      break;
    case 'websocket.open':
      requireString(value.socketId, `${path}.socketId`);
      requireString(value.url, `${path}.url`);
      if (value.protocols !== undefined) {
        if (!Array.isArray(value.protocols)) fail(`${path}.protocols`, 'expected array');
        value.protocols.forEach((protocol, index) => requireString(protocol, `${path}.protocols[${index}]`));
      }
      if (value.headers !== undefined) validateHeaders(value.headers, `${path}.headers`);
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      break;
    case 'websocket.send':
    case 'websocket.frame':
      requireString(value.socketId, `${path}.socketId`);
      validateFrame(value, path);
      break;
    case 'websocket.receive':
      requireString(value.socketId, `${path}.socketId`);
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      break;
    case 'websocket.close':
      requireString(value.socketId, `${path}.socketId`);
      if (value.code !== undefined) requireInteger(value.code, `${path}.code`, 1000, 4999);
      if (value.reason !== undefined) requireString(value.reason, `${path}.reason`, { allowEmpty: true });
      break;
    case 'tls.open':
      requireString(value.streamId, `${path}.streamId`);
      requireString(value.host, `${path}.host`);
      requireInteger(value.port, `${path}.port`, 1, 65535);
      if (value.sni !== undefined) requireString(value.sni, `${path}.sni`);
      for (const field of ['alpn', 'trustAnchors']) {
        if (value[field] !== undefined) {
          if (!Array.isArray(value[field])) fail(`${path}.${field}`, 'expected array');
          value[field].forEach((item, index) => {
            if (field === 'alpn') requireString(item, `${path}.${field}[${index}]`);
            else validateByteString(item, `${path}.${field}[${index}]`);
          });
        }
      }
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      break;
    case 'tls.write':
      requireString(value.streamId, `${path}.streamId`);
      validateByteString(value.data, `${path}.data`);
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      break;
    case 'tls.read':
      requireString(value.streamId, `${path}.streamId`);
      if (value.minimumBytes !== undefined) requireInteger(value.minimumBytes, `${path}.minimumBytes`, 0);
      if (value.maximumBytes !== undefined) requireInteger(value.maximumBytes, `${path}.maximumBytes`, 1);
      if (value.minimumBytes !== undefined && value.maximumBytes !== undefined
        && value.minimumBytes > value.maximumBytes) {
        fail(`${path}.minimumBytes`, 'cannot exceed maximumBytes');
      }
      if (value.timeoutMs !== undefined) requireInteger(value.timeoutMs, `${path}.timeoutMs`);
      break;
    case 'tls.close':
      requireString(value.streamId, `${path}.streamId`);
      break;
    case 'storage.read':
    case 'storage.delete':
      requireString(value.key, `${path}.key`);
      break;
    case 'storage.write':
      requireString(value.key, `${path}.key`);
      validateJson(value.value, `${path}.value`);
      break;
    case 'state.transition':
      requireString(value.from, `${path}.from`, { allowEmpty: true });
      requireString(value.to, `${path}.to`);
      if (value.reason !== undefined) requireString(value.reason, `${path}.reason`, { allowEmpty: true });
      if (value.metadata !== undefined) validateJson(value.metadata, `${path}.metadata`);
      break;
    case 'terminal.result':
      validateJson(value.result, `${path}.result`);
      break;
    case 'terminal.error':
      validateError(value.error, `${path}.error`);
      break;
    default:
      break;
  }
  return value;
}

function validateEvent(value, path = '$') {
  validateCommon(value, EVENT_FIELDS, 'event', path);
  requireString(value.requestId, `${path}.requestId`);

  switch (value.kind) {
    case 'random.result':
      validateByteString(value.data, `${path}.data`);
      break;
    case 'clock.result':
    case 'timer.fired':
      requireInteger(value.nowMs, `${path}.nowMs`);
      break;
    case 'crypto.result':
      validateJson(value.result, `${path}.result`);
      break;
    case 'http.response':
      requireInteger(value.status, `${path}.status`, 100, 599);
      validateHeaders(value.headers, `${path}.headers`);
      validateByteString(value.body, `${path}.body`);
      if (value.url !== undefined) requireString(value.url, `${path}.url`);
      break;
    case 'websocket.opened':
      requireString(value.socketId, `${path}.socketId`);
      if (value.protocol !== undefined) requireString(value.protocol, `${path}.protocol`, { allowEmpty: true });
      break;
    case 'websocket.frame':
      requireString(value.socketId, `${path}.socketId`);
      validateFrame(value, path);
      break;
    case 'websocket.sent':
      requireString(value.socketId, `${path}.socketId`);
      break;
    case 'websocket.closed':
      requireString(value.socketId, `${path}.socketId`);
      if (value.code !== undefined) requireInteger(value.code, `${path}.code`, 0, 4999);
      if (value.reason !== undefined) requireString(value.reason, `${path}.reason`, { allowEmpty: true });
      break;
    case 'websocket.error':
      requireString(value.socketId, `${path}.socketId`);
      validateError(value.error, `${path}.error`);
      break;
    case 'tls.opened':
      requireString(value.streamId, `${path}.streamId`);
      if (value.negotiatedAlpn !== undefined) {
        requireString(value.negotiatedAlpn, `${path}.negotiatedAlpn`, { allowEmpty: true });
      }
      break;
    case 'tls.data':
      requireString(value.streamId, `${path}.streamId`);
      validateByteString(value.data, `${path}.data`);
      break;
    case 'tls.written':
      requireString(value.streamId, `${path}.streamId`);
      requireInteger(value.length, `${path}.length`, 0);
      break;
    case 'tls.closed':
      requireString(value.streamId, `${path}.streamId`);
      break;
    case 'tls.error':
      requireString(value.streamId, `${path}.streamId`);
      validateError(value.error, `${path}.error`);
      break;
    case 'storage.result':
      if (value.found !== undefined && typeof value.found !== 'boolean') {
        fail(`${path}.found`, 'expected boolean');
      }
      if (value.value !== undefined) validateJson(value.value, `${path}.value`);
      if (value.found === false && value.value !== undefined) {
        fail(`${path}.value`, 'value cannot be present when found is false');
      }
      break;
    case 'storage.error':
    case 'effect.error':
      validateError(value.error, `${path}.error`);
      break;
    default:
      break;
  }
  return value;
}

function createEffect(kind, fields = {}) {
  const value = { version: SCHEMA_VERSION, kind, ...fields };
  validateEffect(value);
  return value;
}

function createEvent(kind, fields = {}) {
  const value = { version: SCHEMA_VERSION, kind, ...fields };
  validateEvent(value);
  return value;
}

function cloneJson(value) {
  validateJson(value);
  return JSON.parse(JSON.stringify(value));
}

function isBlockingEffect(effect) {
  return BLOCKING_EFFECT_KINDS.has(effect.kind);
}

function isTerminalEffect(effect) {
  return TERMINAL_EFFECT_KINDS.has(effect.kind);
}

function assertEventRespondsTo(effect, event, path = '$') {
  validateEffect(effect, `${path}.effect`);
  validateEvent(event, `${path}.event`);
  if (!isBlockingEffect(effect)) fail(`${path}.effect.kind`, 'effect does not accept an input event');
  if (event.requestId !== effect.requestId) {
    fail(`${path}.event.requestId`, `expected ${JSON.stringify(effect.requestId)}`);
  }
  const allowed = RESPONSE_KINDS[effect.kind];
  if (!allowed.has(event.kind)) {
    fail(`${path}.event.kind`, `${event.kind} cannot answer ${effect.kind}`);
  }
}

module.exports = {
  BLOCKING_EFFECT_KINDS,
  BYTE_KEY,
  EFFECT_FIELDS,
  EVENT_FIELDS,
  MAX_BINARY_BYTES,
  MAX_RANDOM_BYTES,
  RESPONSE_KINDS,
  SCHEMA_VERSION,
  SchemaValidationError,
  appendPath,
  assertEventRespondsTo,
  byteString,
  cloneJson,
  createEffect,
  createEvent,
  decodeByteString,
  isBlockingEffect,
  isByteString,
  isTerminalEffect,
  validateByteString,
  validateEffect,
  validateEvent,
  validateJson,
};
