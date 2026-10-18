'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var test = require('node:test');

var anisette = require('../../src/anisette/remote-v3');
var RemoteV3ProvisioningRunner = require('../../src/anisette/remote-v3-runner')
  .RemoteV3ProvisioningRunner;
var xmlPlist = require('../../src/codecs/xml-plist');

var IDENTIFIER = Uint8Array.from(Array.from({ length: 16 }, function (_, index) { return index; }));
var LOOKUP_BODY = xmlPlist.encodeXmlPlist({ urls: {
  midStartProvisioning: 'https://gsa.example/start',
  midFinishProvisioning: 'https://gsa.example/finish',
} });
var START_BODY = xmlPlist.encodeXmlPlist({ Response: { spim: 'spim-value' } });
var FINISH_BODY = xmlPlist.encodeXmlPlist({ Response: { ptm: 'ptm-value', tk: 'tk-value' } });
var REMOTE_MESSAGES = [
  JSON.stringify({ result: 'GiveIdentifier' }),
  JSON.stringify({ result: 'GiveStartProvisioningData' }),
  JSON.stringify({ result: 'GiveEndProvisioningData', cpim: 'cpim-{value}-"quoted"' }),
  JSON.stringify({ result: 'ProvisioningSuccess', adi_pb: 'AQIDBA==' }),
];

function response(body, status) {
  return { status: status === undefined ? 200 : status, headers: [], body: body };
}

function deferred() {
  var resolve;
  var reject;
  var promise = new Promise(function (resolveValue, rejectValue) {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise: promise, resolve: resolve, reject: reject };
}

function HttpScript(options) {
  this.options = options || {};
  this.requests = [];
}

HttpScript.prototype.request = function (request) {
  this.requests.push(request);
  if (request.url === anisette.APPLE_LOOKUP_URL) {
    return this.options.lookup || Promise.resolve(response(LOOKUP_BODY));
  }
  if (request.url === 'https://gsa.example/start') {
    return this.options.start || Promise.resolve(response(START_BODY));
  }
  if (request.url === 'https://gsa.example/finish') {
    return this.options.finish || Promise.resolve(response(FINISH_BODY));
  }
  return Promise.reject(new Error('Unexpected HTTP request.'));
};

function FakeWebSocket(options) {
  this.options = options || {};
  this.opens = [];
  this.sent = [];
  this.closes = [];
  this.callback = null;
}

FakeWebSocket.prototype.open = function (url, protocols, callback) {
  this.opens.push({ url: url, protocols: protocols.slice() });
  this.callback = callback;
  if (this.options.openError) throw this.options.openError;
  (this.options.synchronousEvents || []).forEach(function (event) { callback(event); });
  if (this.options.invalidSocket) return {};
  var self = this;
  return {
    sendText: function (text) {
      if (self.options.sendError) throw self.options.sendError;
      self.sent.push(text);
    },
    close: function (code, reason) {
      self.closes.push({ code: code, reason: reason });
      if (self.options.closeEvent) callback(self.options.closeEvent);
    },
  };
};

FakeWebSocket.prototype.emit = function (event) {
  if (!this.callback) throw new Error('WebSocket has not opened.');
  this.callback(event);
};

function ManualTimer() {
  this.nextHandle = 1;
  this.pending = new Map();
}
ManualTimer.prototype.after = function (delayMillis, callback) {
  var handle = this.nextHandle;
  this.nextHandle += 1;
  this.pending.set(handle, { delayMillis: delayMillis, callback: callback });
  return handle;
};
ManualTimer.prototype.cancel = function (handle) { this.pending.delete(handle); };
ManualTimer.prototype.fireNext = function () {
  var entry = this.pending.entries().next();
  if (entry.done) throw new Error('No timer is pending.');
  this.pending.delete(entry.value[0]);
  entry.value[1].callback();
};

function session() {
  return new anisette.RemoteV3ProvisioningSession({
    remoteUrl: 'https://ani.example',
    state: anisette.createState(IDENTIFIER),
    clientInfo: {
      akdUserAgent: 'akd/test',
      mmeClientInfo: '<test-client>',
      hardwareHeaders: [],
    },
    crypto: {
      digest: function (algorithm, data) {
        return new Uint8Array(crypto.createHash(algorithm).update(data).digest());
      },
    },
    nowMs: Date.parse('2026-08-27T12:34:56Z'),
  });
}

function fixture(options) {
  options = options || {};
  var http = options.http || new HttpScript(options.httpOptions);
  var websocket = options.websocket || new FakeWebSocket(options.websocketOptions);
  var timer = options.timer || new ManualTimer();
  var runner = new RemoteV3ProvisioningRunner({
    effects: { http: http, websocket: websocket, timer: timer },
    provisionTimeoutMillis: options.provisionTimeoutMillis,
  });
  return {
    http: http,
    websocket: websocket,
    runner: runner,
    timer: timer,
    result: runner.provision(session()),
  };
}

async function waitFor(predicate) {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  throw new Error('Timed out waiting for deterministic RemoteV3 activity.');
}

function emitChunks(websocket, chunks) {
  chunks.forEach(function (chunk) {
    websocket.emit({ type: 'message', binary: false, data: chunk });
  });
}

async function runProtocol(fragmenter, websocketOptions) {
  var subject = fixture({ websocketOptions: websocketOptions });
  await waitFor(function () { return subject.websocket.opens.length === 1; });
  if (!websocketOptions || !(websocketOptions.synchronousEvents || []).length) {
    subject.websocket.emit({ type: 'open', protocol: '' });
  }

  emitChunks(subject.websocket, fragmenter(REMOTE_MESSAGES[0], 0));
  assert.equal(subject.websocket.sent[0], '{"identifier":"AAECAwQFBgcICQoLDA0ODw=="}');

  emitChunks(subject.websocket, fragmenter(REMOTE_MESSAGES[1], 1));
  await waitFor(function () { return subject.websocket.sent.length === 2; });
  assert.equal(subject.websocket.sent[1], '{"spim":"spim-value"}');

  emitChunks(subject.websocket, fragmenter(REMOTE_MESSAGES[2], 2));
  await waitFor(function () { return subject.websocket.sent.length === 3; });
  assert.equal(subject.websocket.sent[2], '{"ptm":"ptm-value","tk":"tk-value"}');

  emitChunks(subject.websocket, fragmenter(REMOTE_MESSAGES[3], 3));
  var result = await subject.result;
  assert.deepEqual(result.keychainIdentifier, IDENTIFIER);
  assert.deepEqual(result.adiPb, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(subject.websocket.opens[0], {
    url: 'wss://ani.example/v3/provisioning_session', protocols: [],
  });
  assert.deepEqual(subject.websocket.closes, [{ code: 1000, reason: '' }]);
  return subject;
}

test('runner completes when every RemoteV3 message is delivered one character at a time', async function () {
  await runProtocol(function (message) { return message.split(''); });
});

test('runner accepts every possible two-fragment boundary for every RemoteV3 message', async function () {
  for (var target = 0; target < REMOTE_MESSAGES.length; target += 1) {
    for (var split = 1; split < REMOTE_MESSAGES[target].length; split += 1) {
      await runProtocol(function (message, index) {
        return index === target ? [message.slice(0, split), message.slice(split)] : [message];
      });
    }
  }
});

test('synchronous open callbacks are queued until the generic socket handle exists', async function () {
  await runProtocol(function (message) { return [message]; }, {
    synchronousEvents: [{ type: 'open', protocol: '' }],
    closeEvent: { type: 'close', code: 1000, clean: true },
  });
});

test('out-of-order, binary, subprotocol, and unknown events fail closed', async function () {
  var cases = [
    function (subject) {
      subject.websocket.emit({ type: 'message', binary: false, data: REMOTE_MESSAGES[0] });
    },
    function (subject) {
      subject.websocket.emit({ type: 'open', protocol: '' });
      subject.websocket.emit({ type: 'open', protocol: '' });
    },
    function (subject) {
      subject.websocket.emit({ type: 'open', protocol: 'unexpected' });
    },
    function (subject) {
      subject.websocket.emit({ type: 'open', protocol: '' });
      subject.websocket.emit({ type: 'message', binary: true, data: new Uint8Array([1]) });
    },
    function (subject) {
      subject.websocket.emit({ type: 'open', protocol: '' });
      subject.websocket.emit({ type: 'mystery' });
    },
  ];

  for (var index = 0; index < cases.length; index += 1) {
    var subject = fixture();
    await waitFor(function () { return subject.websocket.opens.length === 1; });
    cases[index](subject);
    await assert.rejects(subject.result, function (error) {
      return error.code === 'ANISETTE_WEBSOCKET_PROTOCOL_ERROR' && error.retryable === false;
    });
    assert.deepEqual(subject.websocket.closes, [{ code: 1000, reason: '' }]);
  }
});

test('remote messages cannot overtake an in-flight Apple relay response', async function () {
  var start = deferred();
  var subject = fixture({ httpOptions: { start: start.promise } });
  await waitFor(function () { return subject.websocket.opens.length === 1; });
  subject.websocket.emit({ type: 'open', protocol: '' });
  subject.websocket.emit({ type: 'message', binary: false, data: REMOTE_MESSAGES[1] });
  await waitFor(function () { return subject.http.requests.length === 2; });
  subject.websocket.emit({ type: 'message', binary: false, data: REMOTE_MESSAGES[0] });

  await assert.rejects(subject.result, function (error) {
    return error.code === 'ANISETTE_PROTOCOL_ERROR' && /out of sequence/.test(error.message);
  });
  start.resolve(response(START_BODY));
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepEqual(subject.websocket.sent, []);
  assert.equal(subject.websocket.closes.length, 1);
});

test('error, clean close, and close during a fragmented message reject exactly once', async function () {
  var errorSubject = fixture();
  await waitFor(function () { return errorSubject.websocket.opens.length === 1; });
  errorSubject.websocket.emit({ type: 'error' });
  errorSubject.websocket.emit({ type: 'close', code: 1006, clean: false });
  await assert.rejects(errorSubject.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_ERROR' && error.retryable === true;
  });

  var closeSubject = fixture();
  await waitFor(function () { return closeSubject.websocket.opens.length === 1; });
  closeSubject.websocket.emit({ type: 'open', protocol: '' });
  closeSubject.websocket.emit({ type: 'close', code: 1001, reason: 'server detail', clean: true });
  await assert.rejects(closeSubject.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_CLOSED'
      && error.details.code === 1001 && error.details.clean === true
      && JSON.stringify(error).indexOf('server detail') === -1;
  });

  var partialSubject = fixture();
  await waitFor(function () { return partialSubject.websocket.opens.length === 1; });
  partialSubject.websocket.emit({ type: 'open', protocol: '' });
  partialSubject.websocket.emit({ type: 'message', binary: false, data: '{"result":' });
  partialSubject.websocket.emit({ type: 'close', code: 1006, clean: false });
  await assert.rejects(partialSubject.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_TRUNCATED';
  });
});

test('malformed balanced JSON, multiple objects, and socket send failures are terminal', async function () {
  var messages = ['{"result" 1}', '{"result":"GiveIdentifier"}{"result":"GiveIdentifier"}'];
  for (var index = 0; index < messages.length; index += 1) {
    var subject = fixture();
    await waitFor(function () { return subject.websocket.opens.length === 1; });
    subject.websocket.emit({ type: 'open', protocol: '' });
    subject.websocket.emit({ type: 'message', binary: false, data: messages[index] });
    await assert.rejects(subject.result, function (error) {
      return error.code === 'ANISETTE_PROTOCOL_ERROR'
        || error.code === 'ANISETTE_WEBSOCKET_PROTOCOL_ERROR';
    });
  }

  var sendSubject = fixture({ websocketOptions: { sendError: new Error('synthetic send failure') } });
  await waitFor(function () { return sendSubject.websocket.opens.length === 1; });
  sendSubject.websocket.emit({ type: 'open', protocol: '' });
  sendSubject.websocket.emit({ type: 'message', binary: false, data: REMOTE_MESSAGES[0] });
  await assert.rejects(sendSubject.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_FAILED' && error.retryable === true;
  });
});

test('HTTP status failures, invalid sockets, and runner cancellation remain structured', async function () {
  var failedLookup = fixture({
    httpOptions: { lookup: Promise.resolve(response(new Uint8Array(0), 503)) },
  });
  await assert.rejects(failedLookup.result, function (error) {
    return error.code === 'ANISETTE_HTTP_FAILED' && error.retryable === true
      && error.details.status === 503;
  });
  assert.equal(failedLookup.websocket.opens.length, 0);

  var invalidSocket = fixture({ websocketOptions: { invalidSocket: true } });
  await assert.rejects(invalidSocket.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_FAILED';
  });

  var pendingLookup = deferred();
  var cancelled = fixture({ httpOptions: { lookup: pendingLookup.promise } });
  cancelled.runner.close();
  await assert.rejects(cancelled.result, function (error) {
    return error.code === 'ANISETTE_PROVISIONING_CANCELLED'
      && error.kind === 'cancelled' && error.retryable === false;
  });
  pendingLookup.resolve(response(LOOKUP_BODY));
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.equal(cancelled.http.requests.length, 0);
  assert.equal(cancelled.websocket.opens.length, 0);
});

test('silent RemoteV3 provisioning times out, closes the socket, and ignores late events', async function () {
  var subject = fixture({ provisionTimeoutMillis: 30000 });
  await waitFor(function () { return subject.websocket.opens.length === 1; });
  assert.equal(subject.timer.pending.size, 1);
  subject.timer.fireNext();

  await assert.rejects(subject.result, function (error) {
    return error.code === 'ANISETTE_WEBSOCKET_TIMEOUT'
      && error.kind === 'timeout' && error.retryable === true;
  });
  assert.deepEqual(subject.websocket.closes, [{ code: 1000, reason: '' }]);
  subject.websocket.emit({ type: 'open', protocol: '' });
  subject.websocket.emit({ type: 'message', binary: false, data: REMOTE_MESSAGES[0] });
  assert.deepEqual(subject.websocket.sent, []);
});
