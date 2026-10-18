'use strict';

const { compareExact } = require('./comparator');
const {
  byteString,
  createEvent,
  decodeByteString,
  validateByteString,
} = require('./schema');

class FakePeerMismatchError extends Error {
  constructor(kind, path, reason) {
    super(`Fake peer expected ${kind} at ${path}: ${reason}`);
    this.name = 'FakePeerMismatchError';
    this.kind = kind;
    this.path = path;
  }
}

function normalizeBytes(value, name) {
  if (value instanceof Uint8Array || Array.isArray(value)) return byteString(value);
  try {
    return validateByteString(value, name);
  } catch (error) {
    throw new TypeError(`${name} must be Uint8Array, byte array, or a $bytes envelope`);
  }
}

function expectKind(effect, kind) {
  if (!effect || effect.kind !== kind) {
    throw new FakePeerMismatchError(kind, '$.kind', `received ${effect && effect.kind}`);
  }
}

function expectField(effect, name, expected) {
  const comparison = compareExact(effect[name], expected, `$.${name}`);
  if (!comparison.equal) {
    throw new FakePeerMismatchError(effect.kind, comparison.path, comparison.reason);
  }
}

function responseBytes(value) {
  return value === undefined ? byteString([]) : normalizeBytes(value, 'body');
}

/**
 * Return one deterministic resolver entry for a generic HTTP exchange.
 */
function httpExchange(expected, response) {
  if (!expected || typeof expected !== 'object') throw new TypeError('expected HTTP request is required');
  if (!response || typeof response !== 'object') throw new TypeError('HTTP response is required');
  return function resolveHttp(effect) {
    expectKind(effect, 'http.request');
    for (const key of ['method', 'url', 'headers']) {
      if (expected[key] !== undefined) expectField(effect, key, expected[key]);
    }
    if (expected.body !== undefined) expectField(effect, 'body', normalizeBytes(expected.body, 'expected.body'));
    return createEvent('http.response', {
      requestId: effect.requestId,
      status: response.status,
      headers: response.headers || [],
      body: responseBytes(response.body),
      ...(response.url === undefined ? {} : { url: response.url }),
    });
  };
}

function tlsScript(actions) {
  if (!Array.isArray(actions)) throw new TypeError('TLS actions must be an array');
  return actions.map(function (action, index) {
    if (!action || typeof action !== 'object') throw new TypeError(`TLS action ${index} must be an object`);
    return function resolveTls(effect) {
      switch (action.type) {
        case 'open':
          expectKind(effect, 'tls.open');
          for (const key of ['host', 'port', 'sni', 'alpn']) {
            if (action[key] !== undefined) expectField(effect, key, action[key]);
          }
          return createEvent('tls.opened', {
            requestId: effect.requestId,
            streamId: effect.streamId,
            ...(action.negotiatedAlpn === undefined ? {} : { negotiatedAlpn: action.negotiatedAlpn }),
          });
        case 'expectWrite': {
          expectKind(effect, 'tls.write');
          const expectedData = normalizeBytes(action.data, `actions[${index}].data`);
          expectField(effect, 'data', expectedData);
          return createEvent('tls.written', {
            requestId: effect.requestId,
            streamId: effect.streamId,
            length: decodeByteString(expectedData).length,
          });
        }
        case 'sendFragment':
          expectKind(effect, 'tls.read');
          return createEvent('tls.data', {
            requestId: effect.requestId,
            streamId: effect.streamId,
            data: normalizeBytes(action.data, `actions[${index}].data`),
          });
        case 'close':
          if (effect.kind !== 'tls.read' && effect.kind !== 'tls.close') {
            throw new FakePeerMismatchError('tls.read or tls.close', '$.kind', `received ${effect.kind}`);
          }
          return createEvent('tls.closed', {
            requestId: effect.requestId,
            streamId: effect.streamId,
          });
        default:
          throw new TypeError(`Unknown TLS action type ${action.type}`);
      }
    };
  });
}

function websocketScript(actions) {
  if (!Array.isArray(actions)) throw new TypeError('WebSocket actions must be an array');
  return actions.map(function (action, index) {
    if (!action || typeof action !== 'object') throw new TypeError(`WebSocket action ${index} must be an object`);
    return function resolveWebSocket(effect) {
      switch (action.type) {
        case 'open':
          expectKind(effect, 'websocket.open');
          for (const key of ['url', 'protocols', 'headers']) {
            if (action[key] !== undefined) expectField(effect, key, action[key]);
          }
          return createEvent('websocket.opened', {
            requestId: effect.requestId,
            socketId: effect.socketId,
            ...(action.protocol === undefined ? {} : { protocol: action.protocol }),
          });
        case 'expectText':
          expectKind(effect, 'websocket.send');
          expectField(effect, 'frameType', 'text');
          expectField(effect, 'text', action.text);
          return createEvent('websocket.sent', {
            requestId: effect.requestId,
            socketId: effect.socketId,
          });
        case 'sendText':
          expectKind(effect, 'websocket.receive');
          return createEvent('websocket.frame', {
            requestId: effect.requestId,
            socketId: effect.socketId,
            frameType: 'text',
            text: action.text,
          });
        case 'sendBinary':
          expectKind(effect, 'websocket.receive');
          return createEvent('websocket.frame', {
            requestId: effect.requestId,
            socketId: effect.socketId,
            frameType: 'binary',
            data: normalizeBytes(action.data, `actions[${index}].data`),
          });
        case 'close':
          if (effect.kind !== 'websocket.receive' && effect.kind !== 'websocket.close') {
            throw new FakePeerMismatchError('websocket.receive or websocket.close', '$.kind', `received ${effect.kind}`);
          }
          return createEvent('websocket.closed', {
            requestId: effect.requestId,
            socketId: effect.socketId,
            ...(action.code === undefined ? {} : { code: action.code }),
            ...(action.reason === undefined ? {} : { reason: action.reason }),
          });
        default:
          throw new TypeError(`Unknown WebSocket action type ${action.type}`);
      }
    };
  });
}

module.exports = {
  FakePeerMismatchError,
  httpExchange,
  tlsScript,
  websocketScript,
};
