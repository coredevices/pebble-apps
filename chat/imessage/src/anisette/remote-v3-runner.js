'use strict';

var bytes = require('../runtime/bytes');
var scheduleDeadline = require('../runtime/deadline').scheduleDeadline;
var runtimeErrors = require('../runtime/errors');
var RuntimeError = runtimeErrors.RuntimeError;
var ERROR_KINDS = runtimeErrors.ERROR_KINDS;

var MAX_REMOTE_MESSAGE_BYTES = 1024 * 1024;

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(name + ' is required.');
  return value;
}

function runnerError(code, message, options) {
  return new RuntimeError(code, message, options || { kind: ERROR_KINDS.TRANSPORT, retryable: true });
}

function normalizeFailure(value, code, message) {
  if (value instanceof RuntimeError) return value;
  return runnerError(code, message, {
    kind: ERROR_KINDS.TRANSPORT,
    retryable: true,
    cause: value,
  });
}

function protocolFailure(message) {
  return runnerError('ANISETTE_WEBSOCKET_PROTOCOL_ERROR', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
    retryable: false,
  });
}

function validateHttpResponse(value, operation) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isSafeInteger(value.status) || value.status < 100 || value.status > 599
      || !(value.body instanceof Uint8Array) || !Array.isArray(value.headers || [])) {
    throw runnerError('ANISETTE_HTTP_INVALID_RESPONSE', operation + ' returned a malformed response.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: true,
    });
  }
  if (value.status < 200 || value.status >= 300) {
    throw runnerError('ANISETTE_HTTP_FAILED', operation + ' failed.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: value.status === 429 || value.status >= 500,
      details: { status: value.status },
    });
  }
  return value;
}

/**
 * Reassembles JSON object chunks without interpreting the RemoteV3 protocol. The generic host
 * callback does not expose a final-fragment flag, so object completeness is the only JS-visible
 * boundary. Balanced but malformed JSON is passed to the protocol state machine for strict parse.
 */
function JsonObjectAccumulator() {
  this.reset();
}

JsonObjectAccumulator.prototype.reset = function () {
  this.text = '';
  this.byteLength = 0;
  this.offset = 0;
  this.started = false;
  this.inString = false;
  this.escaped = false;
  this.stack = [];
  this.completeOffset = -1;
};

JsonObjectAccumulator.prototype.hasPartialMessage = function () {
  return this.text.length > 0;
};

JsonObjectAccumulator.prototype.push = function (chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) {
    throw protocolFailure('Anisette WebSocket text fragment is malformed.');
  }
  this.byteLength += bytes.utf8ToBytes(chunk).length;
  if (this.byteLength > MAX_REMOTE_MESSAGE_BYTES) {
    throw protocolFailure('Anisette WebSocket message is too large.');
  }
  this.text += chunk;

  while (this.offset < this.text.length) {
    var character = this.text[this.offset];
    if (this.completeOffset !== -1) {
      if (!/\s/.test(character)) {
        throw protocolFailure('Anisette WebSocket frame contains multiple messages.');
      }
      this.offset += 1;
      continue;
    }

    if (!this.started) {
      if (/\s/.test(character)) {
        this.offset += 1;
        continue;
      }
      if (character !== '{') {
        throw protocolFailure('Anisette WebSocket message must be a JSON object.');
      }
      this.started = true;
      this.stack.push('}');
      this.offset += 1;
      continue;
    }

    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (character === '\\') {
        this.escaped = true;
      } else if (character === '"') {
        this.inString = false;
      } else if (character.charCodeAt(0) < 0x20) {
        throw protocolFailure('Anisette WebSocket JSON contains an invalid control character.');
      }
      this.offset += 1;
      continue;
    }

    if (character === '"') {
      this.inString = true;
    } else if (character === '{') {
      this.stack.push('}');
    } else if (character === '[') {
      this.stack.push(']');
    } else if (character === '}' || character === ']') {
      if (this.stack.length === 0 || this.stack.pop() !== character) {
        throw protocolFailure('Anisette WebSocket JSON delimiters are malformed.');
      }
      if (this.stack.length === 0) this.completeOffset = this.offset + 1;
    }
    this.offset += 1;
  }

  if (this.completeOffset === -1) return null;
  var message = this.text.slice(0, this.completeOffset);
  this.reset();
  return message;
};

/**
 * Runs the existing pure RemoteV3 protocol state machine over generic HTTP and WebSocket effects.
 * Endpoints, JSON messages, Apple requests, ordering, and persistence data all remain in JS.
 *
 * @param {{effects: {http: {request: function(object): Promise<object>},
 *   websocket: {open: function(string, string[], function(object): void): object}}}} options
 * @constructor
 */
function RemoteV3ProvisioningRunner(options) {
  if (!options || typeof options !== 'object' || !options.effects || typeof options.effects !== 'object') {
    throw new TypeError('RemoteV3 runner effects are required.');
  }
  if (!options.effects.http || !options.effects.websocket || !options.effects.timer) {
    throw new TypeError('RemoteV3 HTTP, WebSocket, and timer effects are required.');
  }
  requireFunction(options.effects.http.request, 'RemoteV3 HTTP effect');
  requireFunction(options.effects.websocket.open, 'RemoteV3 WebSocket effect');
  requireFunction(options.effects.timer.after, 'RemoteV3 timer effect');
  requireFunction(options.effects.timer.cancel, 'RemoteV3 timer cancellation effect');
  if (options.provisionTimeoutMillis !== undefined
      && (!Number.isSafeInteger(options.provisionTimeoutMillis)
        || options.provisionTimeoutMillis <= 0)) {
    throw new TypeError('RemoteV3 provisioning timeout must be a positive integer.');
  }
  this.effects = options.effects;
  this.provisionTimeoutMillis = options.provisionTimeoutMillis || 30000;
  this.active = new Set();
  this.closed = false;
}

RemoteV3ProvisioningRunner.prototype.provision = function (session) {
  if (!session || typeof session !== 'object') {
    throw new TypeError('RemoteV3 provisioning session is required.');
  }
  ['lookupRequest', 'acceptLookupResponse', 'acceptRemoteMessage', 'acceptAppleResponse']
    .forEach(function (name) { requireFunction(session[name], 'RemoteV3 session ' + name); });
  if (this.closed) {
    return Promise.reject(runnerError('ANISETTE_PROVISIONING_CANCELLED', 'Anisette runner is closed.', {
      kind: ERROR_KINDS.CANCELLED,
      retryable: false,
    }));
  }

  var run = new ProvisioningRun(this.effects, session, this.provisionTimeoutMillis);
  var active = this.active;
  active.add(run);
  return run.start().then(function (state) {
    active.delete(run);
    return state;
  }, function (error) {
    active.delete(run);
    throw error;
  });
};

RemoteV3ProvisioningRunner.prototype.close = function () {
  if (this.closed) return;
  this.closed = true;
  Array.from(this.active).forEach(function (run) { run.cancel(); });
};

function ProvisioningRun(effects, session, provisionTimeoutMillis) {
  this.effects = effects;
  this.session = session;
  this.state = 'idle';
  this.socket = null;
  this.accumulator = new JsonObjectAccumulator();
  this.settled = false;
  this.resolve = null;
  this.reject = null;
  this.provisionTimeoutMillis = provisionTimeoutMillis;
  this.deadline = null;
}

ProvisioningRun.prototype.start = function () {
  var self = this;
  var result = new Promise(function (resolve, reject) {
    self.resolve = resolve;
    self.reject = reject;
  });
  this.state = 'lookup';
  Promise.resolve().then(function () {
    if (self.settled) return null;
    return self.effects.http.request(self.session.lookupRequest());
  }).then(function (response) {
    if (self.settled) return;
    var action = self.session.acceptLookupResponse(
      validateHttpResponse(response, 'Anisette provisioning lookup').body
    );
    if (!action || action.type !== 'websocket-connect' || typeof action.url !== 'string') {
      throw protocolFailure('Anisette lookup returned an invalid WebSocket action.');
    }
    try {
      self._openWebSocket(action.url);
    } catch (error) {
      self._fail(normalizeFailure(
        error,
        'ANISETTE_WEBSOCKET_FAILED',
        'Anisette provisioning WebSocket could not be opened.'
      ));
    }
  }).catch(function (error) {
    self._fail(normalizeFailure(error, 'ANISETTE_LOOKUP_FAILED', 'Anisette provisioning lookup failed.'));
  });
  return result;
};

ProvisioningRun.prototype._openWebSocket = function (url) {
  if (this.settled || this.state !== 'lookup') {
    throw protocolFailure('Anisette WebSocket opened out of sequence.');
  }
  this.state = 'opening';
  var self = this;
  var queued = [];
  var accepting = false;
  var socket = this.effects.websocket.open(url, [], function (event) {
    if (!accepting) queued.push(event);
    else self._dispatchWebSocketEvent(event);
  });
  if (!socket || typeof socket !== 'object'
      || typeof socket.sendText !== 'function' || typeof socket.close !== 'function') {
    throw new TypeError('RemoteV3 WebSocket effect returned an invalid socket.');
  }
  this.socket = socket;
  this.deadline = scheduleDeadline(
    this.effects.timer,
    this.provisionTimeoutMillis,
    function () {
      self.deadline = null;
      self._fail(runnerError(
        'ANISETTE_WEBSOCKET_TIMEOUT',
        'Anisette provisioning WebSocket timed out.',
        { kind: ERROR_KINDS.TIMEOUT, retryable: true }
      ));
    }
  );
  accepting = true;
  queued.forEach(function (event) { self._dispatchWebSocketEvent(event); });
};

ProvisioningRun.prototype._dispatchWebSocketEvent = function (event) {
  if (this.settled) return;
  try {
    this._handleWebSocketEvent(event);
  } catch (error) {
    this._fail(normalizeFailure(
      error,
      'ANISETTE_WEBSOCKET_FAILED',
      'Anisette provisioning WebSocket failed.'
    ));
  }
};

ProvisioningRun.prototype._handleWebSocketEvent = function (event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
    throw protocolFailure('Anisette WebSocket returned a malformed event.');
  }
  if (event.type === 'open') {
    if (this.state !== 'opening') throw protocolFailure('Anisette WebSocket opened out of sequence.');
    if (event.protocol !== undefined && event.protocol !== null && event.protocol !== '') {
      throw protocolFailure('Anisette WebSocket selected an unexpected subprotocol.');
    }
    this.state = 'open';
    return;
  }
  if (event.type === 'message') {
    if (this.state !== 'open') throw protocolFailure('Anisette WebSocket message arrived out of sequence.');
    if (event.binary === true || typeof event.data !== 'string') {
      throw protocolFailure('Anisette provisioning requires text WebSocket messages.');
    }
    var message = this.accumulator.push(event.data);
    if (message !== null) this._handleAction(this.session.acceptRemoteMessage(message));
    return;
  }
  if (event.type === 'error') {
    throw runnerError('ANISETTE_WEBSOCKET_ERROR', 'Anisette provisioning WebSocket reported an error.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: true,
    });
  }
  if (event.type === 'close') {
    if (this.accumulator.hasPartialMessage()) {
      throw runnerError('ANISETTE_WEBSOCKET_TRUNCATED', 'Anisette WebSocket closed during a message.', {
        kind: ERROR_KINDS.TRANSPORT,
        retryable: true,
      });
    }
    var details = {};
    if (Number.isSafeInteger(event.code)) details.code = event.code;
    if (typeof event.clean === 'boolean') details.clean = event.clean;
    throw runnerError('ANISETTE_WEBSOCKET_CLOSED', 'Anisette WebSocket closed before provisioning completed.', {
      kind: ERROR_KINDS.TRANSPORT,
      retryable: true,
      details: details,
    });
  }
  throw protocolFailure('Anisette WebSocket returned an unknown event.');
};

ProvisioningRun.prototype._handleAction = function (action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw protocolFailure('Anisette session returned a malformed action.');
  }
  if (action.type === 'websocket-send') {
    if (typeof action.text !== 'string' || !this.socket) {
      throw protocolFailure('Anisette session returned an invalid WebSocket send action.');
    }
    this.socket.sendText(action.text);
    return;
  }
  if (action.type === 'http') {
    this._relayAppleRequest(action.request);
    return;
  }
  if (action.type === 'complete') {
    if (!action.state || !(action.state.keychainIdentifier instanceof Uint8Array)
        || !(action.state.adiPb instanceof Uint8Array)) {
      throw protocolFailure('Anisette session returned invalid provisioned state.');
    }
    this._succeed(action.state);
    return;
  }
  throw protocolFailure('Anisette session returned an unknown action.');
};

ProvisioningRun.prototype._relayAppleRequest = function (request) {
  var self = this;
  Promise.resolve().then(function () {
    if (self.settled) return null;
    return self.effects.http.request(request);
  }).then(function (response) {
    if (self.settled) return;
    var action = self.session.acceptAppleResponse(
      validateHttpResponse(response, 'Anisette Apple provisioning relay').body
    );
    self._handleAction(action);
  }).catch(function (error) {
    self._fail(normalizeFailure(
      error,
      'ANISETTE_APPLE_RELAY_FAILED',
      'Anisette Apple provisioning relay failed.'
    ));
  });
};

ProvisioningRun.prototype._succeed = function (state) {
  if (this.settled) return;
  this.settled = true;
  this.state = 'complete';
  this.accumulator.reset();
  if (this.deadline) this.deadline.cancel();
  this.deadline = null;
  var socket = this.socket;
  this.socket = null;
  this.resolve(Object.freeze({
    keychainIdentifier: new Uint8Array(state.keychainIdentifier),
    adiPb: new Uint8Array(state.adiPb),
  }));
  this.resolve = null;
  this.reject = null;
  if (socket) {
    try { socket.close(1000, ''); } catch (_) { /* provisioning is already complete */ }
  }
};

ProvisioningRun.prototype._fail = function (error) {
  if (this.settled) return;
  this.settled = true;
  this.state = 'failed';
  this.accumulator.reset();
  if (this.deadline) this.deadline.cancel();
  this.deadline = null;
  var socket = this.socket;
  this.socket = null;
  if (socket) {
    try { socket.close(1000, ''); } catch (_) { /* preserve the original failure */ }
  }
  this.reject(error);
  this.resolve = null;
  this.reject = null;
};

ProvisioningRun.prototype.cancel = function () {
  this._fail(runnerError('ANISETTE_PROVISIONING_CANCELLED', 'Anisette provisioning was cancelled.', {
    kind: ERROR_KINDS.CANCELLED,
    retryable: false,
  }));
};

module.exports = {
  RemoteV3ProvisioningRunner: RemoteV3ProvisioningRunner,
};
