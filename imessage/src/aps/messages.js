'use strict';

var rawCodec = require('../codecs/aps-raw');
var bplist = require('../codecs/binary-plist');
var bytes = require('../runtime/bytes');

var COMMAND = Object.freeze({
  CONNECT: 0x07,
  CONNECT_RESPONSE: 0x08,
  FILTER: 0x09,
  NOTIFICATION: 0x0a,
  ACK: 0x0b,
  PING: 0x0c,
  PONG: 0x0d,
  NO_STORAGE: 0x0e,
  SET_STATE: 0x14,
});

function field(id, value) {
  bytes.assertBytes(value, 'field value');
  return { id: id, value: value };
}

function optionalField(id, value) {
  return value === undefined || value === null ? [] : [field(id, value)];
}

function exactLength(value, length, name) {
  bytes.assertBytes(value, name);
  if (value.length !== length) throw new TypeError(name + ' must contain ' + length + ' bytes.');
  return value;
}

function oneByte(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new TypeError(name + ' must be an unsigned byte.');
  }
  return new Uint8Array([value]);
}

function int32Bytes(value, name) {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new TypeError(name + ' must be a signed 32-bit integer.');
  }
  return bytes.uint32BE(value >>> 0);
}

function readInt32(value, name) {
  exactLength(value, 4, name);
  var unsigned = bytes.readUint32BE(value);
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function encodeConnect(message) {
  var fields = [];
  if (message.token !== undefined && message.token !== null) {
    fields.push(field(1, exactLength(message.token, 32, 'push token')));
  }
  fields.push(field(2, new Uint8Array([1])));
  fields.push(field(5, bytes.uint32BE(message.flags === undefined ? 0x41 : message.flags)));
  fields = fields.concat(optionalField(0x0c, message.certificate));
  fields = fields.concat(optionalField(0x0d, message.nonce));
  fields = fields.concat(optionalField(0x0e, message.signature));
  fields.push(field(0x10, bytes.uint16BE(9)));
  return rawCodec.encodeRawAps(COMMAND.CONNECT, fields);
}

function encodeSetState(state) {
  return rawCodec.encodeRawAps(COMMAND.SET_STATE, [
    field(1, oneByte(state, 'state')),
    field(2, bytes.uint32BE(0x7fffffff)),
  ]);
}

function encodeFilter(message) {
  var token = exactLength(message.token, 32, 'push token');
  var fields = [field(1, token)];
  [[2, message.enabled], [3, message.ignored], [4, message.opportunistic], [5, message.paused]]
    .forEach(function (entry) {
      var topics = entry[1] || [];
      if (!Array.isArray(topics)) throw new TypeError('Filter topics must be arrays.');
      topics.forEach(function (topic) {
        fields.push(field(entry[0], exactLength(topic, 20, 'topic hash')));
      });
    });
  return rawCodec.encodeRawAps(COMMAND.FILTER, fields);
}

function encodeAck(message) {
  var fields = [];
  if (message.token !== undefined && message.token !== null) {
    fields.push(field(1, exactLength(message.token, 32, 'push token')));
  }
  fields.push(field(4, int32Bytes(message.forId, 'acknowledgement id')));
  fields.push(field(8, oneByte(message.status, 'acknowledgement status')));
  return rawCodec.encodeRawAps(COMMAND.ACK, fields);
}

function encodeNotification(message) {
  var topic = exactLength(message.topicHash, 20, 'topic hash');
  var token = exactLength(message.token, 32, 'push token');
  var payload = message.payload instanceof Uint8Array
    ? message.payload
    : bplist.encodeBinaryPlist(message.payload);
  return rawCodec.encodeRawAps(COMMAND.NOTIFICATION, [
    field(1, topic),
    field(2, token),
    field(3, payload),
    field(4, int32Bytes(message.id, 'notification id')),
  ]);
}

function encodeOutgoing(message) {
  if (!message || typeof message !== 'object') throw new TypeError('APS message is required.');
  switch (message.type) {
    case 'connect': return encodeConnect(message);
    case 'setState': return encodeSetState(message.state);
    case 'filter': return encodeFilter(message);
    case 'ack': return encodeAck(message);
    case 'notification': return encodeNotification(message);
    case 'ping': return rawCodec.encodeRawAps(COMMAND.PING, []);
    default: throw new TypeError('Unsupported outbound APS message type.');
  }
}

function packedAttribute(id, value, cached) {
  return { id: new Uint8Array([id]), value: value, cached: cached === true };
}

function packedData(value) {
  bytes.assertBytes(value, 'packed APS data');
  return { type: 'data', value: new Uint8Array(value) };
}

function packedInt(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(name + ' is outside its integer range.');
  }
  return { type: 'int', value: value };
}

/** Convert the plist-compatible subset RustPush accepts in APSPackedValue::from. */
function packedValueFromJs(value, depth) {
  depth = depth === undefined ? 0 : depth;
  if (depth > 32) throw new TypeError('Packed APS payload nesting is too deep.');
  if (value instanceof Uint8Array) return packedData(value);
  if (typeof value === 'string') return { type: 'string', value: value };
  if (typeof value === 'boolean') return { type: 'bool', value: value };
  if (typeof value === 'number' && Number.isSafeInteger(value)) return { type: 'int', value: value };
  if (typeof value === 'bigint') {
    if (value < -0x8000000000000000n || value > 0x7fffffffffffffffn) {
      throw new TypeError('Packed APS payload integer exceeds signed 64-bit.');
    }
    return { type: 'int', value: value.toString() };
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      value: value.map(function (item) { return packedValueFromJs(item, depth + 1); }),
    };
  }
  if (value && typeof value === 'object'
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return {
      type: 'dictionary',
      value: Object.keys(value).map(function (key) {
        if (key.length === 0) throw new TypeError('Packed APS dictionary key cannot be empty.');
        return {
          id: bytes.utf8ToBytes(key),
          value: packedValueFromJs(value[key], depth + 1),
          cached: false,
        };
      }),
    };
  }
  throw new TypeError('Packed APS payload contains an unsupported plist value.');
}

/** @param {Object} value @param {number=} depth @returns {unknown} */
function jsValueFromPacked(value, depth) {
  depth = depth === undefined ? 0 : depth;
  if (depth > 32 || !value || typeof value !== 'object') {
    throw new TypeError('Packed APS value is malformed.');
  }
  if (value.type === 'data') {
    bytes.assertBytes(value.value, 'packed APS data');
    return new Uint8Array(value.value);
  }
  if (value.type === 'string') {
    if (typeof value.value !== 'string') throw new TypeError('Packed APS string is malformed.');
    return value.value;
  }
  if (value.type === 'bool') {
    if (typeof value.value !== 'boolean') throw new TypeError('Packed APS boolean is malformed.');
    return value.value;
  }
  if (value.type === 'int') {
    if (!(Number.isSafeInteger(value.value)
        || (typeof value.value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value.value)))) {
      throw new TypeError('Packed APS integer is malformed.');
    }
    return value.value;
  }
  if (value.type === 'array') {
    if (!Array.isArray(value.value)) throw new TypeError('Packed APS array is malformed.');
    return value.value.map(function (item) { return jsValueFromPacked(item, depth + 1); });
  }
  if (value.type === 'dictionary') {
    if (!Array.isArray(value.value)) throw new TypeError('Packed APS dictionary is malformed.');
    var dictionary = {};
    value.value.forEach(function (entry) {
      if (!entry || !(entry.id instanceof Uint8Array)) throw new TypeError('Packed APS dictionary key is malformed.');
      var key = bytes.bytesToUtf8(entry.id);
      if (key.length === 0 || Object.prototype.hasOwnProperty.call(dictionary, key)) {
        throw new TypeError('Packed APS dictionary contains an invalid or duplicate key.');
      }
      Object.defineProperty(dictionary, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: jsValueFromPacked(entry.value, depth + 1),
      });
    });
    return dictionary;
  }
  throw new TypeError('Packed APS value type is unsupported.');
}

function optionalPackedData(id, value, cached) {
  return value === undefined || value === null ? [] : [packedAttribute(id, packedData(value), cached)];
}

function packedConnect(message) {
  var attributes = [];
  if (message.token !== undefined && message.token !== null) {
    attributes.push(packedAttribute(1, packedData(exactLength(message.token, 32, 'push token')), true));
  }
  attributes.push(packedAttribute(2, packedInt(1, 'connect state', 0, 255), false));
  attributes.push(packedAttribute(5, packedInt(
    message.flags === undefined ? 0x41 : message.flags,
    'connect flags', 0, 0xffffffff
  ), false));
  attributes = attributes.concat(optionalPackedData(0x0c, message.certificate, false));
  attributes = attributes.concat(optionalPackedData(0x0d, message.nonce, false));
  attributes = attributes.concat(optionalPackedData(0x0e, message.signature, false));
  attributes.push(packedAttribute(0x10, packedInt(9, 'connect version', 0, 0xffff), false));
  return { command: COMMAND.CONNECT, attributes: attributes };
}

function packedSetState(state) {
  return {
    command: COMMAND.SET_STATE,
    attributes: [
      packedAttribute(1, packedInt(state, 'state', 0, 255), false),
      packedAttribute(2, packedInt(0x7fffffff, 'state interval', 0, 0x7fffffff), false),
    ],
  };
}

function packedFilter(message) {
  var attributes = [packedAttribute(1, packedData(exactLength(message.token, 32, 'push token')), true)];
  [[2, message.enabled], [3, message.ignored], [4, message.opportunistic], [5, message.paused]]
    .forEach(function (entry) {
      var topics = entry[1] || [];
      if (!Array.isArray(topics)) throw new TypeError('Filter topics must be arrays.');
      topics.forEach(function (topic) {
        attributes.push(packedAttribute(entry[0], packedData(exactLength(topic, 20, 'topic hash')), true));
      });
    });
  return { command: COMMAND.FILTER, attributes: attributes };
}

function packedAck(message) {
  return {
    command: COMMAND.ACK,
    attributes: optionalPackedData(1, message.token, true).concat([
      packedAttribute(4, packedInt(message.forId, 'acknowledgement id', -0x80000000, 0x7fffffff), false),
      packedAttribute(8, packedInt(message.status, 'acknowledgement status', 0, 255), false),
    ]),
  };
}

function packedNotification(message) {
  var payload = message.payload;
  if (payload instanceof Uint8Array) {
    try {
      payload = bplist.decodeBinaryPlist(payload);
    } catch (_) {
      throw new TypeError('Packed APS pre-encoded payload must be a binary property list.');
    }
  }
  return {
    command: COMMAND.NOTIFICATION,
    attributes: [
      packedAttribute(1, packedData(exactLength(message.topicHash, 20, 'topic hash')), true),
      packedAttribute(2, packedData(exactLength(message.token, 32, 'push token')), true),
      packedAttribute(3, packedValueFromJs(payload), false),
      packedAttribute(4, packedInt(message.id, 'notification id', -0x80000000, 0x7fffffff), false),
    ],
  };
}

/** Build the semantic packed message; the negotiated session owns the stateful encoder. */
function encodeOutgoingPacked(message) {
  if (!message || typeof message !== 'object') throw new TypeError('APS message is required.');
  switch (message.type) {
    case 'connect': return packedConnect(message);
    case 'setState': return packedSetState(message.state);
    case 'filter': return packedFilter(message);
    case 'ack': return packedAck(message);
    case 'notification': return packedNotification(message);
    case 'ping': return { command: COMMAND.PING, attributes: [] };
    default: throw new TypeError('Unsupported outbound APS message type.');
  }
}

function findField(frame, id, required) {
  var match = frame.fields.find(function (candidate) { return candidate.id === id; });
  if (!match && required) throw new TypeError('APS command is missing field ' + id + '.');
  return match && match.value;
}

function parseIncoming(frame) {
  if (!frame || typeof frame !== 'object' || !Array.isArray(frame.fields)) {
    throw new TypeError('Decoded APS frame is required.');
  }
  switch (frame.command) {
    case COMMAND.CONNECT_RESPONSE: {
      var responseToken = findField(frame, 3, false);
      if (responseToken) exactLength(responseToken, 32, 'push token');
      return { type: 'connectResponse', status: oneByteValue(findField(frame, 1, true), 'connect status'), token: responseToken };
    }
    case COMMAND.NOTIFICATION: {
      var token = findField(frame, 1, false);
      if (token) exactLength(token, 32, 'push token');
      var topic = exactLength(findField(frame, 2, true), 20, 'topic hash');
      var rawPayload = findField(frame, 3, true);
      var payload;
      try { payload = bplist.decodeBinaryPlist(rawPayload); } catch (_) { payload = rawPayload; }
      return {
        type: 'notification',
        id: readInt32(findField(frame, 4, true), 'notification id'),
        topicHash: topic,
        token: token,
        payload: payload,
        rawPayload: rawPayload,
      };
    }
    case COMMAND.ACK:
      return {
        type: 'ack',
        forId: readInt32(findField(frame, 4, true), 'acknowledgement id'),
        status: oneByteValue(findField(frame, 8, true), 'acknowledgement status'),
        token: findField(frame, 1, false),
      };
    case COMMAND.PING: return { type: 'ping' };
    case COMMAND.PONG: return { type: 'pong' };
    case COMMAND.NO_STORAGE: return { type: 'noStorage' };
    default: return { type: 'unknown', command: frame.command, fields: frame.fields };
  }
}

function packedField(frame, id, required) {
  if (!frame || typeof frame !== 'object' || !Array.isArray(frame.attributes)) {
    throw new TypeError('Decoded packed APS frame is required.');
  }
  var matches = frame.attributes.filter(function (candidate) {
    return candidate.id instanceof Uint8Array && candidate.id.length === 1 && candidate.id[0] === id;
  });
  if (matches.length > 1) throw new TypeError('Packed APS command contains duplicate field ' + id + '.');
  if (matches.length === 0 && required) throw new TypeError('Packed APS command is missing field ' + id + '.');
  return matches.length === 0 ? null : matches[0].value;
}

function packedDataField(frame, id, required, length, name) {
  var value = packedField(frame, id, required);
  if (value === null) return null;
  if (!value || value.type !== 'data' || !(value.value instanceof Uint8Array)) {
    throw new TypeError(name + ' must be packed data.');
  }
  return exactLength(value.value, length, name).slice();
}

function packedIntField(frame, id, required, minimum, maximum, name) {
  var value = packedField(frame, id, required);
  if (value === null) return null;
  if (!value || value.type !== 'int' || !Number.isSafeInteger(value.value)
      || value.value < minimum || value.value > maximum) {
    throw new TypeError(name + ' is outside its packed integer range.');
  }
  return value.value;
}

function parseIncomingPacked(frame) {
  switch (frame.command) {
    case COMMAND.CONNECT_RESPONSE:
      return {
        type: 'connectResponse',
        status: packedIntField(frame, 1, true, 0, 255, 'connect status'),
        token: packedDataField(frame, 3, false, 32, 'push token'),
      };
    case COMMAND.NOTIFICATION: {
      var packedPayload = packedField(frame, 3, true);
      return {
        type: 'notification',
        id: packedIntField(frame, 4, true, -0x80000000, 0x7fffffff, 'notification id'),
        topicHash: packedDataField(frame, 2, true, 20, 'topic hash'),
        token: packedDataField(frame, 1, false, 32, 'push token'),
        payload: jsValueFromPacked(packedPayload),
      };
    }
    case COMMAND.ACK:
      return {
        type: 'ack',
        forId: packedIntField(frame, 4, true, -0x80000000, 0x7fffffff, 'acknowledgement id'),
        status: packedIntField(frame, 8, true, 0, 255, 'acknowledgement status'),
        token: packedDataField(frame, 1, false, 32, 'push token'),
      };
    case COMMAND.PING: return { type: 'ping' };
    case COMMAND.PONG: return { type: 'pong' };
    case COMMAND.NO_STORAGE: return { type: 'noStorage' };
    default: return { type: 'unknown', command: frame.command, attributes: frame.attributes };
  }
}

function oneByteValue(value, name) {
  return exactLength(value, 1, name)[0];
}

function hashTopic(crypto, topic) {
  if (!crypto || typeof crypto.digest !== 'function') throw new TypeError('Crypto digest is required.');
  if (typeof topic !== 'string' || topic.length === 0) throw new TypeError('Topic must be non-empty.');
  return crypto.digest('sha1', bytes.utf8ToBytes(topic));
}

module.exports = {
  COMMAND: COMMAND,
  encodeOutgoing: encodeOutgoing,
  encodeOutgoingPacked: encodeOutgoingPacked,
  hashTopic: hashTopic,
  jsValueFromPacked: jsValueFromPacked,
  packedValueFromJs: packedValueFromJs,
  parseIncoming: parseIncoming,
  parseIncomingPacked: parseIncomingPacked,
};
