'use strict';

var rawCodec = require('../codecs/aps-raw');
var packedCodec = require('../codecs/aps-packed');
var bytes = require('../runtime/bytes');
var bag = require('./bag');
var messages = require('./messages');

function CourierError(code, message, details) {
  Error.call(this, message);
  this.name = 'CourierError';
  this.code = code;
  this.message = message;
  this.details = details || {};
  if (Error.captureStackTrace) Error.captureStackTrace(this, CourierError);
}
CourierError.prototype = Object.create(Error.prototype);
CourierError.prototype.constructor = CourierError;

/**
 * One courier protocol state machine. Framing is derived only from the TLS-selected ALPN: raw for
 * no selection / apns-security-v3, or stateful packed framing for apns-pack-v1:<send>:<receive>.
 *
 * @param {{negotiatedAlpn?: string|null, token?: Uint8Array, maxBodyLength?: number,
 *   maxFrameLength?: number, maxCollectionItems?: number, maxDepth?: number,
 *   correlateIncoming?: function(object): (object|null|undefined)}=} options
 * @constructor
 */
function CourierSession(options) {
  options = options || {};
  if (options.correlateIncoming !== undefined && typeof options.correlateIncoming !== 'function') {
    throw new TypeError('Incoming notification correlator must be a function.');
  }
  var cacheSizes = bag.packedCacheSizes(options.negotiatedAlpn);
  this.mode = cacheSizes === null ? 'raw' : 'packed';
  this.negotiation = Object.freeze({
    alpn: options.negotiatedAlpn || null,
    mode: this.mode,
    encoderCacheSize: cacheSizes && cacheSizes.encoder,
    decoderCacheSize: cacheSizes && cacheSizes.decoder,
  });
  if (this.mode === 'packed') {
    this.encoder = new packedCodec.PackedApsEncoder({
      maxFrameLength: options.maxFrameLength,
      valueCacheSize: cacheSizes.encoder,
    });
    this.decoder = new packedCodec.PackedApsDecoder({
      maxFrameLength: options.maxFrameLength,
      maxCollectionItems: options.maxCollectionItems,
      maxDepth: options.maxDepth,
      valueCacheSize: cacheSizes.decoder,
    });
  } else {
    this.encoder = null;
    this.decoder = new rawCodec.RawApsStreamDecoder({ maxBodyLength: options.maxBodyLength });
  }
  this.state = 'idle';
  this.token = options.token ? requireBytes(options.token, 'push token', 32) : null;
  this.pending = Object.create(null);
  this.topics = [];
  this.correlateIncoming = options.correlateIncoming || null;
}

/** @param {unknown} value @param {string} name @param {number} length @returns {Uint8Array} */
function requireBytes(value, name, length) {
  bytes.assertBytes(value, name);
  if (value.length !== length) throw new TypeError(name + ' must contain ' + length + ' bytes.');
  return new Uint8Array(value);
}

CourierSession.prototype._encode = function (message) {
  if (this.mode === 'packed') return this.encoder.encode(messages.encodeOutgoingPacked(message));
  return messages.encodeOutgoing(message);
};

CourierSession.prototype._parse = function (frame) {
  return this.mode === 'packed' ? messages.parseIncomingPacked(frame) : messages.parseIncoming(frame);
};

CourierSession.prototype._assertReady = function () {
  if (this.state !== 'ready') throw new CourierError('NOT_CONNECTED', 'Courier session is not ready.');
};

CourierSession.prototype._fail = function () {
  this.state = 'failed';
  this.token = null;
  this.pending = Object.create(null);
  this.topics = [];
  this.encoder = null;
  this.decoder = null;
  this.correlateIncoming = null;
};

CourierSession.prototype._close = function () {
  this.state = 'closed';
  this.token = null;
  this.pending = Object.create(null);
  this.topics = [];
  this.encoder = null;
  this.decoder = null;
  this.correlateIncoming = null;
};

CourierSession.prototype.start = function (credentials) {
  if (this.state !== 'idle') throw new CourierError('INVALID_STATE', 'Courier session has already started.');
  credentials = credentials || {};
  var frame = this._encode({
    type: 'connect',
    flags: credentials.flags === undefined ? 0x41 : credentials.flags,
    certificate: credentials.certificate,
    nonce: credentials.nonce,
    signature: credentials.signature,
    token: this.token,
  });
  this.state = 'connecting';
  return frame;
};

CourierSession.prototype.setTopics = function (topicHashes) {
  if (this.state === 'failed' || this.state === 'closed') {
    throw new CourierError('INVALID_STATE', 'Courier session is not active.');
  }
  if (!Array.isArray(topicHashes)) throw new TypeError('Topic hashes must be an array.');
  var topics = topicHashes.map(function (topic) { return requireBytes(topic, 'topic hash', 20); });
  var frame = null;
  if (this.state === 'ready') {
    frame = this._encode({
      type: 'filter', token: this.token, enabled: topics,
      ignored: [], opportunistic: [], paused: [],
    });
  }
  this.topics = topics;
  return frame;
};

CourierSession.prototype.sendNotification = function (message) {
  this._assertReady();
  if (!message || !Number.isInteger(message.id)
      || message.id < -0x80000000 || message.id > 0x7fffffff) {
    throw new TypeError('Notification id must be signed 32-bit.');
  }
  var key = String(message.id);
  if (Object.prototype.hasOwnProperty.call(this.pending, key)) {
    throw new CourierError('DUPLICATE_ID', 'Notification id is already pending.');
  }
  var frame = this._encode({
    type: 'notification',
    id: message.id,
    topicHash: message.topicHash,
    token: this.token,
    payload: message.payload,
  });
  this.pending[key] = true;
  return frame;
};

CourierSession.prototype.ping = function () {
  this._assertReady();
  return this._encode({ type: 'ping' });
};

CourierSession.prototype.push = function (chunk) {
  if (this.state !== 'connecting' && this.state !== 'ready') {
    throw new CourierError('INVALID_STATE', 'Courier session cannot receive data in its current state.');
  }
  try {
    var frames = this.decoder.push(chunk);
    var events = [];
    var writes = [];
    for (var index = 0; index < frames.length; index += 1) {
      var incoming = this._parse(frames[index]);
      if (incoming.type === 'connectResponse') {
        if (this.state !== 'connecting') {
          throw new CourierError('UNEXPECTED_CONNECT', 'Unexpected connect response.');
        }
        if (incoming.status !== 0) {
          throw new CourierError('CONNECT_REJECTED', 'Courier rejected the connection.', {
            status: incoming.status,
          });
        }
        if (incoming.token) this.token = new Uint8Array(incoming.token);
        if (!this.token) {
          throw new CourierError('MISSING_TOKEN', 'Courier connect response did not provide a push token.');
        }
        writes.push(this._encode({ type: 'setState', state: 1 }));
        writes.push(this._encode({
          type: 'filter', token: this.token, enabled: this.topics,
          ignored: [], opportunistic: [], paused: [],
        }));
        this.state = 'ready';
        events.push({ type: 'ready', token: new Uint8Array(this.token) });
      } else {
        if (this.state !== 'ready') {
          throw new CourierError('UNEXPECTED_MESSAGE', 'Courier sent a message before connect completed.');
        }
        if (incoming.type === 'notification') {
          writes.push(this._encode({
            type: 'ack', token: this.token, forId: incoming.id, status: 0,
          }));
          // A caller may inspect the payload transiently to resolve its own request. The courier
          // never stores or returns an unmatched payload, so Release 1 still acknowledges and
          // discards unrelated incoming messages.
          var correlated = this.correlateIncoming && this.correlateIncoming(incoming);
          if (correlated !== undefined && correlated !== null) {
            if (!correlated || typeof correlated !== 'object' || Array.isArray(correlated)) {
              throw new TypeError('Incoming notification correlator returned an invalid event.');
            }
            events.push(correlated);
          } else {
            events.push({
              type: 'notificationDiscarded',
              id: incoming.id,
              topicHash: new Uint8Array(incoming.topicHash),
            });
          }
        } else if (incoming.type === 'ack') {
          var key = String(incoming.forId);
          if (Object.prototype.hasOwnProperty.call(this.pending, key)) {
            delete this.pending[key];
            events.push({ type: 'sendAcknowledged', id: incoming.forId, status: incoming.status });
          } else {
            events.push({ type: 'unmatchedAcknowledgement', id: incoming.forId, status: incoming.status });
          }
        } else {
          events.push(incoming);
        }
      }
    }
    return { writes: writes, events: events };
  } catch (error) {
    this._fail();
    throw error;
  }
};

CourierSession.prototype.finish = function () {
  if (this.state === 'failed' || this.state === 'closed') {
    throw new CourierError('INVALID_STATE', 'Courier session is not active.');
  }
  try {
    this.decoder.finish();
    this._close();
  } catch (error) {
    this._fail();
    throw error;
  }
};

module.exports = {
  CourierError: CourierError,
  CourierSession: CourierSession,
  RawCourierSession: CourierSession,
};
