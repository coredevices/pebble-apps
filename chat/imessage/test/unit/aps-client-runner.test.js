'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

var ApsClientRunner = require('../../src/aps/client-runner').ApsClientRunner;
var bag = require('../../src/aps/bag');
var messages = require('../../src/aps/messages');
var bytes = require('../../src/runtime/bytes');
var createEffects = require('../../src/runtime/effects').createEffects;
var raw = require('../../src/codecs/aps-raw');
var packed = require('../../src/codecs/aps-packed');
var bplist = require('../../src/codecs/binary-plist');
var xmlPlist = require('../../src/codecs/xml-plist');
var gzip = require('../../src/codecs/gzip');

function bagBody(hostCount) {
  var inner = bplist.encodeBinaryPlist({
    APNSCourierHostname: 'courier.push.example.invalid',
    APNSCourierHostcount: hostCount,
  });
  return bplist.encodeBinaryPlist({ bag: inner });
}

function HttpScript(responses) {
  this.responses = responses.slice();
  this.requests = [];
}
HttpScript.prototype.request = async function (request) {
  this.requests.push(request);
  if (this.responses.length === 0) throw new Error('Unexpected HTTP request.');
  return this.responses.shift();
};

function FakeTls() {
  this.opens = [];
  this.writes = [];
  this.closed = 0;
  this.callback = null;
  this.writeError = null;
}
FakeTls.prototype.open = function (options, callback) {
  var self = this;
  this.opens.push(options);
  this.callback = callback;
  return {
    write: function (data) {
      if (self.writeError) throw self.writeError;
      self.writes.push(new Uint8Array(data));
    },
    close: function () { self.closed += 1; },
  };
};
FakeTls.prototype.emit = function (event) {
  if (!this.callback) throw new Error('TLS stream is not open.');
  this.callback(event);
};

function RestoredCrypto() {
  this.signatures = [];
}
RestoredCrypto.prototype.sign = function (keyId, specification, data) {
  this.signatures.push({ keyId: keyId, specification: specification, data: new Uint8Array(data) });
  return new Uint8Array([0xaa, 0xbb]);
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

function makeEffects(http, tls, timer) {
  return createEffects({
    http: http,
    tls: tls,
    timer: timer || new ManualTimer(),
    clock: { now: function () { return 1700000000123; } },
    random: {
      bytes: function (length) {
        if (length === 4) return new Uint8Array([0, 0, 0, 5]);
        if (length === 8) return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        throw new Error('Unexpected random byte count.');
      },
    },
  });
}

async function waitFor(predicate) {
  for (var attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  throw new Error('Timed out waiting for the fake peer.');
}

function rawConnectResponse(token) {
  return raw.encodeRawAps(messages.COMMAND.CONNECT_RESPONSE, [
    { id: 1, value: new Uint8Array([0]) },
    { id: 3, value: token },
  ]);
}

function rawNotification(id, topic, token, value) {
  return raw.encodeRawAps(messages.COMMAND.NOTIFICATION, [
    { id: 1, value: token },
    { id: 2, value: topic },
    { id: 3, value: bplist.encodeBinaryPlist(value) },
    { id: 4, value: bytes.uint32BE(id >>> 0) },
  ]);
}

function rawAcknowledgement(id, status) {
  return raw.encodeRawAps(messages.COMMAND.ACK, [
    { id: 4, value: bytes.uint32BE(id >>> 0) },
    { id: 8, value: new Uint8Array([status]) },
  ]);
}

test('APS client fetches its bag, signs a raw courier connect, and correlates lookup/send results', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(4) }]);
  var tls = new FakeTls();
  var crypto = new RestoredCrypto();
  var events = [];
  var topic = new Uint8Array(20).fill(0x44);
  var certificate = new Uint8Array([0x30, 1, 2, 3]);
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: crypto,
    push: { keyId: 'push-key', certificate: certificate },
    topics: [topic],
    onEvent: function (event) { events.push(event); },
  });

  var connected = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  assert.equal(http.requests[0].url, bag.APNS_BAG_URL);
  assert.equal(tls.opens[0].host, '2-courier.push.example.invalid');
  assert.equal(tls.opens[0].serverName, 'courier.push.example.invalid');
  assert.deepEqual(tls.opens[0].alpn, ['apns-security-v3']);
  assert.equal(tls.opens[0].trustAnchors.length, 2);

  tls.emit({ type: 'open', protocol: 'apns-security-v3' });
  var connect = raw.decodeRawApsFrame(tls.writes[0]);
  assert.equal(connect.command, messages.COMMAND.CONNECT);
  assert.deepEqual(connect.fields.find(function (field) { return field.id === 12; }).value, certificate);
  assert.deepEqual(connect.fields.find(function (field) { return field.id === 13; }).value, crypto.signatures[0].data);
  assert.deepEqual(connect.fields.find(function (field) { return field.id === 14; }).value.slice(0, 2), new Uint8Array([1, 1]));
  assert.equal(crypto.signatures[0].data[0], 0);
  assert.equal(crypto.signatures[0].data.length, 17);

  var token = new Uint8Array(32).fill(0x33);
  var response = rawConnectResponse(token);
  for (var offset = 0; offset < response.length; offset += 3) {
    tls.emit({ type: 'data', data: response.slice(offset, offset + 3) });
  }
  var state = await connected;
  assert.deepEqual(state.token, token);
  assert.deepEqual(tls.writes.slice(1, 3).map(function (frame) {
    return raw.decodeRawApsFrame(frame).command;
  }), [messages.COMMAND.SET_STATE, messages.COMMAND.FILTER]);
  assert.deepEqual(raw.decodeRawApsFrame(tls.writes[2]).fields[1].value, topic);

  var tunnelId = new Uint8Array(16).fill(0x51);
  var lookupPayload = bplist.encodeBinaryPlist({ c: 96, U: tunnelId, b: new Uint8Array([1]) });
  runner.sendLookupTunnel({
    id: 21,
    topicHash: topic,
    tunnel: { tunnelId: tunnelId, apsPayload: lookupPayload },
  });
  var lookupWrite = raw.decodeRawApsFrame(tls.writes[3]);
  assert.equal(lookupWrite.command, messages.COMMAND.NOTIFICATION);
  assert.deepEqual(lookupWrite.fields.find(function (field) { return field.id === 3; }).value, lookupPayload);

  var lookupBody = gzip.gzip(xmlPlist.encodeXmlPlist({
    status: 0,
    results: { 'mailto:recipient@example.invalid': { identities: [] } },
  }));
  tls.emit({ type: 'data', data: rawAcknowledgement(21, 0) });
  tls.emit({
    type: 'data',
    data: rawNotification(91, topic, token, { U: tunnelId, b: lookupBody }),
  });
  assert.equal(events.some(function (event) { return event.type === 'sendAcknowledged' && event.id === 21; }), true);
  var lookupEvent = events.find(function (event) { return event.type === 'lookupResult'; });
  assert.equal(lookupEvent.apsId, 21);
  assert.deepEqual(lookupEvent.results, {
    'mailto:recipient@example.invalid': { identities: [] },
  });
  assert.equal(raw.decodeRawApsFrame(tls.writes[tls.writes.length - 1]).command, messages.COMMAND.ACK);

  var uuid = new Uint8Array(16).fill(0x62);
  runner.sendEnvelope({
    id: 22,
    topicHash: topic,
    uuid: uuid,
    envelope: { body: bplist.encodeBinaryPlist({ c: 100, U: uuid }) },
    expectedPushTokens: [token],
  });
  tls.emit({
    type: 'data',
    data: rawNotification(92, topic, token, { c: 255, U: uuid, t: token, s: 0 }),
  });
  assert.equal(runner.snapshot().pendingCorrelations, 1);
  tls.emit({ type: 'data', data: rawAcknowledgement(22, 0) });
  runner.sendEnvelopeContinuation({
    id: 22,
    topicHash: topic,
    uuid: uuid,
    envelope: { body: bplist.encodeBinaryPlist({ c: 100, U: uuid, fcn: 2 }) },
  });
  tls.emit({ type: 'data', data: rawAcknowledgement(22, 0) });
  runner.completeEnvelopeSequence({ id: 22, uuid: uuid });
  assert.equal(runner.snapshot().pendingCorrelations, 0);
  var sentNotifications = tls.writes.map(raw.decodeRawApsFrame).filter(function (frame) {
    return frame.command === messages.COMMAND.NOTIFICATION;
  });
  assert.equal(sentNotifications.filter(function (frame) {
    return bytes.readUint32BE(frame.fields.find(function (field) { return field.id === 4; }).value) === 22;
  }).length, 2);
  var sendEvent = events.find(function (event) { return event.type === 'sendResult'; });
  assert.equal(sendEvent.apsId, 22);
  assert.deepEqual(sendEvent.pushToken, token);
  assert.equal(sendEvent.status, 0);

  tls.emit({
    type: 'data',
    data: rawNotification(93, topic, token, { privateIncomingContent: 'discard me' }),
  });
  var discarded = events.find(function (event) { return event.type === 'notificationDiscarded'; });
  assert.equal(discarded.id, 93);
  assert.equal(JSON.stringify(events).includes('privateIncomingContent'), false);
  assert.equal(runner.snapshot().pendingCorrelations, 0);
});

function packedAttribute(id, value, cached) {
  return { id: new Uint8Array([id]), value: value, cached: cached === true };
}

test('APS client selects packed framing solely from negotiated ALPN cache sizes', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(2) }]);
  var tls = new FakeTls();
  var token = new Uint8Array(32).fill(7);
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: new RestoredCrypto(),
    push: { keyId: 'push-key', certificate: new Uint8Array([1]), token: token },
  });
  var connected = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  tls.emit({ type: 'open', protocol: 'apns-pack-v1:1024:512' });

  var serverDecoder = new packed.PackedApsDecoder({ valueCacheSize: 1024 });
  var serverEncoder = new packed.PackedApsEncoder({ valueCacheSize: 512 });
  assert.equal(serverDecoder.decode(tls.writes[0]).command, messages.COMMAND.CONNECT);
  var response = serverEncoder.encode({
    command: messages.COMMAND.CONNECT_RESPONSE,
    attributes: [packedAttribute(1, { type: 'int', value: 0 }, false)],
  });
  for (var offset = 0; offset < response.length; offset += 2) {
    tls.emit({ type: 'data', data: response.slice(offset, offset + 2) });
  }
  await connected;
  assert.deepEqual(runner.snapshot().negotiation, {
    alpn: 'apns-pack-v1:1024:512',
    mode: 'packed',
    encoderCacheSize: 1024,
    decoderCacheSize: 512,
  });
  assert.equal(serverDecoder.decode(tls.writes[1]).command, messages.COMMAND.SET_STATE);
  assert.equal(serverDecoder.decode(tls.writes[2]).command, messages.COMMAND.FILTER);
});

test('APS client rejects missing provisioned push state before any network request', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(3) }]);
  var tls = new FakeTls();
  var events = [];
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: new RestoredCrypto(),
    onEvent: function (event) { events.push(event); },
  });
  await assert.rejects(runner.connect(), function (error) {
    return error.code === 'APS_BOOTSTRAP_REQUIRED' && error.kind === 'invalid-input';
  });
  assert.equal(http.requests.length, 0);
  assert.equal(tls.opens.length, 0);
  assert.equal(runner.snapshot().state, 'failed');
  assert.equal(events[0].type, 'error');
  assert.equal(events[0].error.code, 'APS_BOOTSTRAP_REQUIRED');
});

test('APS courier authentication timeout closes the stream and ignores late responses', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(3) }]);
  var tls = new FakeTls();
  var timer = new ManualTimer();
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls, timer),
    crypto: new RestoredCrypto(),
    push: { keyId: 'push-key', certificate: new Uint8Array([1]) },
    connectTimeoutMillis: 15000,
  });
  var connecting = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  tls.emit({ type: 'open', protocol: 'apns-security-v3' });
  assert.equal(timer.pending.size, 1);
  timer.fireNext();

  await assert.rejects(connecting, function (error) {
    return error.code === 'APS_CONNECT_TIMEOUT'
      && error.kind === 'timeout' && error.retryable === true;
  });
  assert.equal(tls.closed, 1);
  assert.equal(runner.snapshot().state, 'failed');
  assert.equal(runner.snapshot().pendingCorrelations, 0);
  tls.emit({ type: 'data', data: rawConnectResponse(new Uint8Array(32).fill(4)) });
  assert.equal(runner.snapshot().state, 'failed');
});

test('protocol failures close the TLS stream', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(3) }]);
  var tls = new FakeTls();
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: new RestoredCrypto(),
    push: { keyId: 'push-key', certificate: new Uint8Array([1]) },
  });
  var connected = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  tls.emit({ type: 'open', protocol: 'apns-pack-v1:not-a-cache' });
  await assert.rejects(connected, function (error) { return error.code === 'APS_PROTOCOL_FAILED'; });
  assert.equal(tls.closed, 1);
  assert.equal(runner.snapshot().state, 'failed');
  assert.equal(runner.snapshot().pendingCorrelations, 0);
});

test('cancellation and TLS write failures reject pending work and fail closed', async function () {
  var http = new HttpScript([{ status: 200, headers: [], body: bagBody(3) }]);
  var tls = new FakeTls();
  var runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: new RestoredCrypto(),
    push: { keyId: 'push-key', certificate: new Uint8Array([1]) },
  });
  var connecting = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  tls.emit({ type: 'open', protocol: 'apns-security-v3' });
  var session = runner.session;
  runner.close();
  await assert.rejects(connecting, function (error) { return error.code === 'APS_CANCELLED'; });
  assert.equal(session.state, 'closed');
  assert.equal(tls.closed, 1);
  tls.emit({ type: 'close' });
  assert.equal(runner.snapshot().state, 'closed');

  http = new HttpScript([{ status: 200, headers: [], body: bagBody(3) }]);
  tls = new FakeTls();
  runner = new ApsClientRunner({
    effects: makeEffects(http, tls),
    crypto: new RestoredCrypto(),
    push: { keyId: 'push-key', certificate: new Uint8Array([1]) },
  });
  connecting = runner.connect();
  await waitFor(function () { return tls.opens.length === 1; });
  tls.emit({ type: 'open', protocol: 'apns-security-v3' });
  tls.emit({ type: 'data', data: rawConnectResponse(new Uint8Array(32).fill(4)) });
  await connecting;
  session = runner.session;
  tls.writeError = new Error('synthetic write failure');
  assert.throws(function () {
    runner.sendNotification({ id: 8, topicHash: new Uint8Array(20), payload: { c: 100 } });
  }, function (error) { return error.code === 'APS_TLS_WRITE_FAILED'; });
  assert.equal(runner.snapshot().state, 'failed');
  assert.equal(runner.snapshot().pendingCorrelations, 0);
  assert.equal(session.state, 'failed');
  assert.equal(session.token, null);
  assert.equal(tls.closed, 1);
});
