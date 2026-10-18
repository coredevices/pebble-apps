'use strict';

var bagLogic = require('./bag');
var courierTrust = require('./courier-trust');
var CourierSession = require('./courier-session').CourierSession;
var lookup = require('../ids/lookup');
var sendEnvelope = require('../ids/send-envelope');
var signing = require('../ids/request-signing');
var bytes = require('../runtime/bytes');
var scheduleDeadline = require('../runtime/deadline').scheduleDeadline;
var runtimeErrors = require('../runtime/errors');

var RuntimeError = runtimeErrors.RuntimeError;
var ERROR_KINDS = runtimeErrors.ERROR_KINDS;

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(name + ' is required.');
  return value;
}

function copyBytes(value, name, length) {
  bytes.assertBytes(value, name);
  if (length !== undefined && value.length !== length) {
    throw new TypeError(name + ' must contain ' + length + ' bytes.');
  }
  return new Uint8Array(value);
}

function copyPushState(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Push state must be an object.');
  }
  if (typeof value.keyId !== 'string' || value.keyId.length === 0) {
    throw new TypeError('Push key ID is required.');
  }
  return {
    keyId: value.keyId,
    certificate: copyBytes(value.certificate, 'push certificate'),
    token: value.token === undefined || value.token === null
      ? null
      : copyBytes(value.token, 'push token', 32),
  };
}

function copyTopics(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('APS topics must be an array.');
  return value.map(function (topic) { return copyBytes(topic, 'topic hash', 20); });
}

function validateHttpResponse(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599
      || !(value.body instanceof Uint8Array)) {
    throw new RuntimeError('APS_HTTP_INVALID', operation + ' returned a malformed response.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: true,
    });
  }
  if (value.status < 200 || value.status >= 300) {
    throw new RuntimeError('APS_HTTP_FAILED', operation + ' failed.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: value.status >= 500,
      details: { status: value.status },
    });
  }
  return value;
}

function normalizeFailure(value, fallbackCode, fallbackMessage) {
  if (value instanceof RuntimeError) return value;
  return new RuntimeError(fallbackCode, fallbackMessage, {
    kind: ERROR_KINDS.TRANSPORT,
    retryable: true,
    cause: value,
  });
}

/**
 * Transient send-only APS client. Every endpoint, trust decision, protocol frame, nonce, and
 * correlation rule remains in JavaScript. The injected effects supply only generic HTTP, random,
 * clock, crypto, and duplex TLS capabilities.
 *
 * @param {{effects: object, crypto: object, push?: object|null, topics?: Uint8Array[],
 *   onEvent?: function(object): void, connectTimeoutMillis?: number}} options
 * @constructor
 */
function ApsClientRunner(options) {
  if (!options || typeof options !== 'object') throw new TypeError('APS client options are required.');
  if (!options.effects || typeof options.effects !== 'object') throw new TypeError('APS effects are required.');
  if (!options.effects.http || !options.effects.random || !options.effects.clock
      || !options.effects.tls || !options.effects.timer) {
    throw new TypeError('APS HTTP, random, clock, TLS, and timer effects are required.');
  }
  requireFunction(options.effects.http.request, 'APS HTTP effect');
  requireFunction(options.effects.random.bytes, 'APS random effect');
  requireFunction(options.effects.clock.now, 'APS clock effect');
  requireFunction(options.effects.tls.open, 'APS TLS effect');
  requireFunction(options.effects.timer.after, 'APS timer effect');
  requireFunction(options.effects.timer.cancel, 'APS timer cancellation effect');
  if (!options.crypto || typeof options.crypto !== 'object') throw new TypeError('APS crypto is required.');
  requireFunction(options.crypto.sign, 'APS signing primitive');
  if (options.onEvent !== undefined) requireFunction(options.onEvent, 'APS event handler');
  if (options.connectTimeoutMillis !== undefined
      && (!Number.isSafeInteger(options.connectTimeoutMillis) || options.connectTimeoutMillis <= 0)) {
    throw new TypeError('APS connect timeout must be a positive integer.');
  }

  this.effects = options.effects;
  this.crypto = options.crypto;
  this.pushState = copyPushState(options.push);
  this.topics = copyTopics(options.topics);
  this.onEvent = options.onEvent || function () {};
  this.connectTimeoutMillis = options.connectTimeoutMillis || 20000;
  this.state = 'idle';
  this.target = null;
  this.session = null;
  this.socket = null;
  this.negotiation = null;
  this.correlations = Object.create(null);
  this.connectPromise = null;
  this.resolveConnect = null;
  this.rejectConnect = null;
  this.connectDeadline = null;
}

ApsClientRunner.prototype.snapshot = function () {
  return Object.freeze({
    state: this.state,
    activated: this.pushState !== null,
    hasToken: !!(this.pushState && this.pushState.token),
    target: this.target && Object.freeze({ host: this.target.host, port: this.target.port }),
    negotiation: this.negotiation,
    pendingCorrelations: Object.keys(this.correlations).length,
  });
};

ApsClientRunner.prototype.getPushState = function () {
  if (!this.pushState) return null;
  return Object.freeze({
    keyId: this.pushState.keyId,
    certificate: new Uint8Array(this.pushState.certificate),
    token: this.pushState.token ? new Uint8Array(this.pushState.token) : null,
  });
};

ApsClientRunner.prototype._emit = function (event) {
  this.onEvent(Object.freeze(event));
};

ApsClientRunner.prototype._prepare = async function () {
  if (!this.pushState) {
    throw new RuntimeError('APS_BOOTSTRAP_REQUIRED', 'APS push credentials must be configured before connecting.', {
      kind: ERROR_KINDS.INVALID_INPUT,
      retryable: false,
    });
  }
  var response = validateHttpResponse(
    await this.effects.http.request(bagLogic.buildBagRequest(bagLogic.APNS_BAG_URL)),
    'APS bag request'
  );
  if (this.state !== 'preparing') return;
  var decodedBag = bagLogic.parseBagResponse(response.body);
  this.target = bagLogic.chooseCourierTarget(decodedBag, this.effects.random.bytes(4));
  this._openTransport();
};

ApsClientRunner.prototype.connect = function () {
  if (this.state !== 'idle') throw new RuntimeError('APS_INVALID_STATE', 'APS client has already started.', {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
  this.state = 'preparing';
  var self = this;
  this.connectPromise = new Promise(function (resolve, reject) {
    self.resolveConnect = resolve;
    self.rejectConnect = reject;
  });
  this._prepare().catch(function (error) {
    self._fail(normalizeFailure(error, 'APS_CONNECT_FAILED', 'APS client preparation failed.'));
  });
  return this.connectPromise;
};

ApsClientRunner.prototype._openTransport = function () {
  var self = this;
  var queued = [];
  var accepting = false;
  this.state = 'opening';
  this.connectDeadline = scheduleDeadline(
    this.effects.timer,
    this.connectTimeoutMillis,
    function () {
      self.connectDeadline = null;
      self._fail(new RuntimeError('APS_CONNECT_TIMEOUT', 'APS courier authentication timed out.', {
        kind: ERROR_KINDS.TIMEOUT,
        retryable: true,
      }));
    }
  );
  var socket = this.effects.tls.open({
    host: this.target.host,
    port: this.target.port,
    serverName: this.target.sni,
    alpn: this.target.alpn.slice(),
    trustAnchors: courierTrust.courierTrustAnchors(),
    connectTimeoutMillis: this.connectTimeoutMillis,
  }, function (event) {
    if (!accepting) queued.push(event);
    else self._handleTransportEvent(event);
  });
  if (!socket || typeof socket !== 'object'
      || typeof socket.write !== 'function' || typeof socket.close !== 'function') {
    throw new TypeError('TLS effect returned an invalid duplex stream.');
  }
  this.socket = socket;
  accepting = true;
  queued.forEach(function (event) { self._handleTransportEvent(event); });
};

ApsClientRunner.prototype._selectedAlpn = function (event) {
  var protocol = event.protocol;
  if (event.negotiatedAlpn !== undefined) {
    if (protocol !== undefined && protocol !== event.negotiatedAlpn) {
      throw new TypeError('TLS effect returned conflicting ALPN selections.');
    }
    protocol = event.negotiatedAlpn;
  }
  if (protocol !== undefined && protocol !== null && typeof protocol !== 'string') {
    throw new TypeError('TLS effect returned an invalid ALPN selection.');
  }
  // Validation and cache-size bounds are centralized in the negotiated courier parser.
  bagLogic.packedCacheSizes(protocol);
  return protocol || null;
};

ApsClientRunner.prototype._startCourier = function (event) {
  if (this.state !== 'opening') throw new TypeError('TLS stream opened in an invalid state.');
  var selectedAlpn = this._selectedAlpn(event);
  var self = this;
  this.session = new CourierSession({
    negotiatedAlpn: selectedAlpn,
    token: this.pushState.token,
    correlateIncoming: function (incoming) { return self._correlateIncoming(incoming); },
  });
  this.negotiation = this.session.negotiation;
  this.session.setTopics(this.topics);
  var nonce = signing.createNonce(
    'apns',
    this.effects.clock.now(),
    this.effects.random.bytes(8)
  );
  var rawSignature = this.crypto.sign(this.pushState.keyId, {
    algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw',
  }, nonce);
  bytes.assertBytes(rawSignature, 'APS signature');
  var frame = this.session.start({
    certificate: this.pushState.certificate,
    nonce: nonce,
    signature: bytes.concatBytes(new Uint8Array([1, 1]), rawSignature),
  });
  this.state = 'authenticating';
  this._write(frame);
  this._emit({ type: 'transportOpen', negotiation: this.negotiation });
};

ApsClientRunner.prototype._write = function (frame) {
  if (!this.socket) {
    throw new RuntimeError('APS_TLS_WRITE_FAILED', 'APS TLS stream is unavailable.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: true,
    });
  }
  try {
    this.socket.write(frame);
  } catch (error) {
    var normalized = normalizeFailure(error, 'APS_TLS_WRITE_FAILED', 'APS TLS write failed.');
    this._fail(normalized);
    throw normalized;
  }
};

ApsClientRunner.prototype._handleData = function (data) {
  if (!this.session || (this.state !== 'authenticating' && this.state !== 'ready')) {
    throw new TypeError('TLS data arrived before the courier started.');
  }
  copyBytes(data, 'TLS data');
  var result = this.session.push(data);
  for (var index = 0; index < result.writes.length; index += 1) {
    this._write(result.writes[index]);
  }
  for (index = 0; index < result.events.length; index += 1) {
    this._handleSessionEvent(result.events[index]);
  }
};

ApsClientRunner.prototype._handleSessionEvent = function (event) {
  if (event.type === 'ready') {
    this.pushState.token = copyBytes(event.token, 'push token', 32);
    this.state = 'ready';
    if (this.connectDeadline) this.connectDeadline.cancel();
    this.connectDeadline = null;
    var result = this.getPushState();
    this._emit({ type: 'ready', token: new Uint8Array(this.pushState.token) });
    if (this.resolveConnect) this.resolveConnect(result);
    this.resolveConnect = null;
    this.rejectConnect = null;
    return;
  }
  if (event.type === 'sendAcknowledged' && event.status !== 0) {
    this._dropCorrelationsForApsId(event.id);
  }
  this._emit(event);
};

ApsClientRunner.prototype._handleTransportEvent = function (event) {
  if (this.state === 'failed' || this.state === 'closed') return;
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('TLS effect returned a malformed event.');
    }
    if (event.type === 'open' || event.type === 'opened') {
      this._startCourier(event);
    } else if (event.type === 'data') {
      this._handleData(event.data);
    } else if (event.type === 'error') {
      throw new RuntimeError('APS_TLS_ERROR', 'APS TLS transport failed.', {
        kind: ERROR_KINDS.TRANSPORT,
        retryable: true,
      });
    } else if (event.type === 'close' || event.type === 'closed') {
      if (this.state === 'closing') {
        this.state = 'closed';
        this.socket = null;
        this._emit({ type: 'closed' });
      } else {
        throw new RuntimeError('APS_TLS_CLOSED', 'APS TLS transport closed unexpectedly.', {
          kind: ERROR_KINDS.TRANSPORT,
          retryable: true,
        });
      }
    } else {
      throw new TypeError('TLS effect returned an unknown event.');
    }
  } catch (error) {
    this._fail(normalizeFailure(error, 'APS_PROTOCOL_FAILED', 'APS courier protocol failed.'));
  }
};

ApsClientRunner.prototype._correlationKey = function (identifier) {
  return bytes.bytesToHex(copyBytes(identifier, 'correlation identifier', 16));
};

ApsClientRunner.prototype._registerCorrelation = function (kind, apsId, identifier, expectedPushTokens) {
  var key = this._correlationKey(identifier);
  if (Object.prototype.hasOwnProperty.call(this.correlations, key)) {
    throw new RuntimeError('APS_DUPLICATE_CORRELATION', 'APS correlation identifier is already pending.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  var remainingTokens = null;
  if (expectedPushTokens !== undefined) {
    if (!Array.isArray(expectedPushTokens) || expectedPushTokens.length === 0) {
      throw new TypeError('Expected send-result tokens must be a non-empty array.');
    }
    remainingTokens = Object.create(null);
    expectedPushTokens.forEach(function (token) {
      token = copyBytes(token, 'expected send-result token', 32);
      remainingTokens[bytes.bytesToHex(token)] = true;
    });
  }
  var correlation = {
    kind: kind,
    apsId: apsId,
    identifier: new Uint8Array(identifier),
    remainingTokens: remainingTokens,
  };
  if (kind === 'send') {
    correlation.sequenceComplete = false;
    correlation.resultsComplete = false;
  }
  this.correlations[key] = correlation;
  return key;
};

ApsClientRunner.prototype._dropCorrelationsForApsId = function (apsId) {
  var correlations = this.correlations;
  Object.keys(correlations).forEach(function (key) {
    if (correlations[key].apsId === apsId) delete correlations[key];
  });
};

ApsClientRunner.prototype._correlateIncoming = function (incoming) {
  var value = incoming.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !(value.U instanceof Uint8Array) || value.U.length !== 16) return null;
  var key = bytes.bytesToHex(value.U);
  var pending = this.correlations[key];
  if (!pending) return null;

  if (pending.kind === 'lookup') {
    var results = lookup.parseLookupTunnelResponse(value, pending.identifier);
    if (results === null) return null;
    delete this.correlations[key];
    return Object.freeze({
      type: 'lookupResult',
      apsId: pending.apsId,
      notificationId: incoming.id,
      tunnelId: new Uint8Array(pending.identifier),
      results: results,
    });
  }
  if (pending.kind === 'send') {
    var result = sendEnvelope.parseSendResult(value, pending.identifier);
    if (result === null) return null;
    if (pending.remainingTokens) {
      var tokenKey = bytes.bytesToHex(result.pushToken);
      if (!Object.prototype.hasOwnProperty.call(pending.remainingTokens, tokenKey)) return null;
      delete pending.remainingTokens[tokenKey];
      if (Object.keys(pending.remainingTokens).length === 0) pending.resultsComplete = true;
    } else {
      pending.resultsComplete = true;
    }
    if (pending.resultsComplete && pending.sequenceComplete) delete this.correlations[key];
    return Object.freeze({
      type: 'sendResult',
      apsId: pending.apsId,
      notificationId: incoming.id,
      uuid: new Uint8Array(pending.identifier),
      pushToken: new Uint8Array(result.pushToken),
      status: result.status,
    });
  }
  throw new TypeError('APS correlation kind is invalid.');
};

ApsClientRunner.prototype._sendFrame = function (message) {
  if (this.state !== 'ready' || !this.session || !this.socket) {
    throw new RuntimeError('APS_NOT_READY', 'APS client is not ready.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  var frame = this.session.sendNotification(message);
  this._write(frame);
};

ApsClientRunner.prototype.sendNotification = function (message) {
  this._sendFrame(message);
};

ApsClientRunner.prototype.sendLookupTunnel = function (options) {
  if (!options || typeof options !== 'object' || !options.tunnel || typeof options.tunnel !== 'object') {
    throw new TypeError('Lookup tunnel send options are required.');
  }
  var tunnelId = copyBytes(options.tunnel.tunnelId, 'tunnel request ID', 16);
  var payload = copyBytes(options.tunnel.apsPayload, 'lookup APS payload');
  var key = this._registerCorrelation('lookup', options.id, tunnelId);
  try {
    this._sendFrame({ id: options.id, topicHash: options.topicHash, payload: payload });
  } catch (error) {
    delete this.correlations[key];
    throw error;
  }
};

ApsClientRunner.prototype.sendEnvelope = function (options) {
  if (!options || typeof options !== 'object' || !options.envelope || typeof options.envelope !== 'object') {
    throw new TypeError('Send envelope options are required.');
  }
  var uuid = copyBytes(options.uuid, 'message UUID', 16);
  var body = copyBytes(options.envelope.body, 'send envelope body');
  var key = this._registerCorrelation('send', options.id, uuid, options.expectedPushTokens);
  try {
    this._sendFrame({ id: options.id, topicHash: options.topicHash, payload: body });
  } catch (error) {
    delete this.correlations[key];
    throw error;
  }
};

ApsClientRunner.prototype.sendEnvelopeContinuation = function (options) {
  if (!options || typeof options !== 'object' || !options.envelope || typeof options.envelope !== 'object') {
    throw new TypeError('Send envelope continuation options are required.');
  }
  var uuid = copyBytes(options.uuid, 'message UUID', 16);
  var body = copyBytes(options.envelope.body, 'send envelope body');
  var key = this._correlationKey(uuid);
  var pending = this.correlations[key];
  if (!pending || pending.kind !== 'send' || pending.apsId !== options.id) {
    throw new RuntimeError('APS_MISSING_CORRELATION', 'APS send continuation has no matching pending correlation.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  try {
    this._sendFrame({ id: options.id, topicHash: options.topicHash, payload: body });
  } catch (error) {
    delete this.correlations[key];
    throw error;
  }
};

ApsClientRunner.prototype.completeEnvelopeSequence = function (options) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Send envelope completion options are required.');
  }
  var uuid = copyBytes(options.uuid, 'message UUID', 16);
  var key = this._correlationKey(uuid);
  var pending = this.correlations[key];
  if (!pending || pending.kind !== 'send' || pending.apsId !== options.id) {
    throw new RuntimeError('APS_MISSING_CORRELATION', 'APS send completion has no matching pending correlation.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  pending.sequenceComplete = true;
  if (pending.resultsComplete) delete this.correlations[key];
};

ApsClientRunner.prototype.setTopics = function (topics) {
  this.topics = copyTopics(topics);
  if (this.session) {
    var frame = this.session.setTopics(this.topics);
    if (frame) this._write(frame);
  }
};

ApsClientRunner.prototype.ping = function () {
  if (this.state !== 'ready' || !this.session || !this.socket) {
    throw new RuntimeError('APS_NOT_READY', 'APS client is not ready.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  this._write(this.session.ping());
};

ApsClientRunner.prototype._fail = function (error) {
  if (this.state === 'failed' || this.state === 'closed') return;
  this.state = 'failed';
  if (this.connectDeadline) this.connectDeadline.cancel();
  this.connectDeadline = null;
  this.correlations = Object.create(null);
  if (this.session && this.session.state !== 'failed' && this.session.state !== 'closed') {
    this.session._fail();
  }
  this.session = null;
  var socket = this.socket;
  this.socket = null;
  if (socket) {
    try { socket.close(); } catch (_) { /* the original failure remains authoritative */ }
  }
  if (this.rejectConnect) this.rejectConnect(error);
  this.resolveConnect = null;
  this.rejectConnect = null;
  this._emit({ type: 'error', error: error.toJSON() });
};

ApsClientRunner.prototype.close = function () {
  if (this.state === 'closed' || this.state === 'failed' || this.state === 'closing') return;
  if (this.state === 'idle' || this.state === 'preparing') {
    var cancelled = new RuntimeError('APS_CANCELLED', 'APS client was closed.', {
      kind: ERROR_KINDS.CANCELLED,
    });
    this.state = 'closed';
    if (this.rejectConnect) this.rejectConnect(cancelled);
    this.resolveConnect = null;
    this.rejectConnect = null;
    this._emit({ type: 'closed' });
    return;
  }
  if (this.connectDeadline) this.connectDeadline.cancel();
  this.connectDeadline = null;
  try {
    if (this.session) this.session.finish();
  } catch (error) {
    this._fail(normalizeFailure(error, 'APS_PROTOCOL_FAILED', 'APS courier protocol failed.'));
    return;
  }
  this.session = null;
  this.correlations = Object.create(null);
  this.state = 'closing';
  if (this.rejectConnect) {
    this.rejectConnect(new RuntimeError('APS_CANCELLED', 'APS client was closed.', {
      kind: ERROR_KINDS.CANCELLED,
    }));
    this.resolveConnect = null;
    this.rejectConnect = null;
  }
  try {
    this.socket.close();
  } catch (error) {
    this._fail(normalizeFailure(error, 'APS_TLS_CLOSE_FAILED', 'APS TLS close failed.'));
  }
};

module.exports = {
  ApsClientRunner: ApsClientRunner,
};
