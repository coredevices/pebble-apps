'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

var bytes = require('../../src/runtime/bytes');
var raw = require('../../src/codecs/aps-raw');
var packed = require('../../src/codecs/aps-packed');
var messages = require('../../src/aps/messages');
var CourierSession = require('../../src/aps/courier-session').CourierSession;

function attribute(id, value, cached) {
  return { id: new Uint8Array([id]), value: value, cached: cached === true };
}

function data(value) { return { type: 'data', value: new Uint8Array(value) }; }
function integer(value) { return { type: 'int', value: value }; }

function findAttribute(message, id) {
  var matches = message.attributes.filter(function (entry) {
    return entry.id.length === 1 && entry.id[0] === id;
  });
  assert.equal(matches.length, 1);
  return matches[0];
}

function fragments(value) {
  var output = [];
  var offset = 0;
  var size = 1;
  while (offset < value.length) {
    output.push(value.slice(offset, offset + size));
    offset += size;
    size = size % 11 + 1;
  }
  return output;
}

function feed(session, value) {
  var aggregate = { writes: [], events: [] };
  fragments(value).forEach(function (fragment) {
    var result = session.push(fragment);
    aggregate.writes = aggregate.writes.concat(result.writes);
    aggregate.events = aggregate.events.concat(result.events);
  });
  return aggregate;
}

function connectPacked(session, serverEncoder, serverDecoder, token, topics) {
  session.setTopics(topics || []);
  var connect = serverDecoder.decode(session.start({
    certificate: new Uint8Array([1]),
    nonce: new Uint8Array([2]),
    signature: new Uint8Array([3]),
  }));
  assert.equal(connect.command, messages.COMMAND.CONNECT);
  assert.equal(findAttribute(connect, 2).value.value, 1);
  assert.equal(findAttribute(connect, 5).value.value, 0x41);
  assert.equal(findAttribute(connect, 0x10).value.value, 9);

  var response = serverEncoder.encode({
    command: messages.COMMAND.CONNECT_RESPONSE,
    attributes: [
      attribute(1, integer(0), false),
      attribute(3, data(token), true),
    ],
  });
  var ready = feed(session, response);
  assert.deepEqual(ready.events, [{ type: 'ready', token: token }]);
  assert.equal(ready.writes.length, 2);
  var setState = serverDecoder.decode(ready.writes[0]);
  var filter = serverDecoder.decode(ready.writes[1]);
  assert.equal(setState.command, messages.COMMAND.SET_STATE);
  assert.equal(findAttribute(setState, 1).value.value, 1);
  assert.equal(filter.command, messages.COMMAND.FILTER);
  return { connect: connect, ready: ready, filter: filter };
}

test('courier framing is selected only by negotiated ALPN and its directional cache sizes', function () {
  var rawSession = new CourierSession({ negotiatedAlpn: 'apns-security-v3', packed: true });
  assert.equal(rawSession.mode, 'raw');
  assert.equal(raw.decodeRawApsFrame(rawSession.start({})).command, messages.COMMAND.CONNECT);

  var packedSession = new CourierSession({ negotiatedAlpn: 'apns-pack-v1:4096:2048' });
  assert.deepEqual(packedSession.negotiation, {
    alpn: 'apns-pack-v1:4096:2048', mode: 'packed',
    encoderCacheSize: 4096, decoderCacheSize: 2048,
  });
  assert.equal(packedSession.encoder.valueCacheSize, 4096);
  assert.equal(packedSession.decoder.valueCacheSize, 2048);
  assert.notEqual(packedSession.encoder.valueCache, packedSession.decoder.valueCache);
  assert.throws(function () {
    return new CourierSession({ negotiatedAlpn: 'apns-pack-v1:4096' });
  }, /ALPN is malformed/);
});

test('packed courier connects, filters, sends, acknowledges, and discards incoming payloads', function () {
  var encoderCacheSize = 4096;
  var decoderCacheSize = 2048;
  var session = new CourierSession({
    negotiatedAlpn: 'apns-pack-v1:' + encoderCacheSize + ':' + decoderCacheSize,
  });
  var serverDecoder = new packed.PackedApsDecoder({ valueCacheSize: encoderCacheSize });
  var serverEncoder = new packed.PackedApsEncoder({ valueCacheSize: decoderCacheSize });
  var token = new Uint8Array(32).fill(0x33);
  var topic = new Uint8Array(20).fill(0x44);
  var handshake = connectPacked(session, serverEncoder, serverDecoder, token, [topic]);
  assert.deepEqual(findAttribute(handshake.filter, 1).value.value, token);
  assert.deepEqual(findAttribute(handshake.filter, 2).value.value, topic);

  var outbound = session.sendNotification({
    id: 22,
    topicHash: topic,
    payload: { c: 100, sP: 'mailto:sender@example.invalid', b: new Uint8Array([1, 2, 3]) },
  });
  var decodedOutbound = serverDecoder.decode(outbound);
  assert.equal(decodedOutbound.command, messages.COMMAND.NOTIFICATION);
  assert.deepEqual(findAttribute(decodedOutbound, 1).value.value, topic);
  assert.deepEqual(findAttribute(decodedOutbound, 2).value.value, token);
  assert.deepEqual(messages.jsValueFromPacked(findAttribute(decodedOutbound, 3).value), {
    c: 100,
    sP: 'mailto:sender@example.invalid',
    b: new Uint8Array([1, 2, 3]),
  });

  var acknowledgement = serverEncoder.encode({
    command: messages.COMMAND.ACK,
    attributes: [attribute(4, integer(22), false), attribute(8, integer(0), false)],
  });
  var incoming = serverEncoder.encode({
    command: messages.COMMAND.NOTIFICATION,
    attributes: [
      attribute(1, data(token), true),
      attribute(2, data(topic), true),
      attribute(3, {
        type: 'dictionary',
        value: [{ id: bytes.utf8ToBytes('secretMessage'), value: data([9]), cached: false }],
      }, false),
      attribute(4, integer(23), false),
    ],
  });
  var result = feed(session, bytes.concatBytes(acknowledgement, incoming));
  assert.deepEqual(result.events[0], { type: 'sendAcknowledged', id: 22, status: 0 });
  assert.deepEqual(result.events[1], { type: 'notificationDiscarded', id: 23, topicHash: topic });
  assert.equal(JSON.stringify(result.events).includes('secretMessage'), false);
  assert.equal(result.writes.length, 1);
  var outgoingAck = serverDecoder.decode(result.writes[0]);
  assert.equal(outgoingAck.command, messages.COMMAND.ACK);
  assert.equal(findAttribute(outgoingAck, 4).value.value, 23);
  assert.equal(findAttribute(outgoingAck, 8).value.value, 0);

  var continuation = serverDecoder.decode(session.sendNotification({
    id: 22,
    topicHash: topic,
    payload: { c: 100, fcn: 2, b: new Uint8Array([4]) },
  }));
  assert.equal(findAttribute(continuation, 4).value.value, 22);
  assert.equal(messages.jsValueFromPacked(findAttribute(continuation, 3).value).fcn, 2);
});

test('packed caches remain stateful but independent across fragmented directions', function () {
  var session = new CourierSession({ negotiatedAlpn: 'apns-pack-v1:1024:512' });
  var serverDecoder = new packed.PackedApsDecoder({ valueCacheSize: 1024 });
  var serverEncoder = new packed.PackedApsEncoder({ valueCacheSize: 512 });
  var token = new Uint8Array(32).fill(7);
  var topic = new Uint8Array(20).fill(8);
  var handshake = connectPacked(session, serverEncoder, serverDecoder, token, [topic]);

  // The token arrived through the receive cache, but the first outbound filter still encoded a
  // new value that the independently stateful peer decoder could consume.
  assert.equal(findAttribute(handshake.filter, 1).cached, true);
  var replacement = session.setTopics([topic]);
  var decodedReplacement = serverDecoder.decode(replacement);
  assert.deepEqual(findAttribute(decodedReplacement, 1).value.value, token);
  assert.deepEqual(findAttribute(decodedReplacement, 2).value.value, topic);

  var firstPong = serverEncoder.encode({ command: messages.COMMAND.PONG, attributes: [] });
  var secondPong = serverEncoder.encode({ command: messages.COMMAND.PONG, attributes: [] });
  var events = feed(session, bytes.concatBytes(firstPong, secondPong)).events;
  assert.deepEqual(events, [{ type: 'pong' }, { type: 'pong' }]);
});

test('caller encoding failure rolls back packed caches and never creates a pending send', function () {
  var session = new CourierSession({ negotiatedAlpn: 'apns-pack-v1:4096:4096', maxFrameLength: 256 });
  var serverDecoder = new packed.PackedApsDecoder({ valueCacheSize: 4096, maxFrameLength: 256 });
  var serverEncoder = new packed.PackedApsEncoder({ valueCacheSize: 4096, maxFrameLength: 256 });
  var token = new Uint8Array(32).fill(3);
  var topic = new Uint8Array(20).fill(4);
  connectPacked(session, serverEncoder, serverDecoder, token, [topic]);

  assert.throws(function () {
    session.sendNotification({ id: 9, topicHash: topic, payload: { b: new Uint8Array(400) } });
  }, /too large|frame exceeds/);
  assert.equal(Object.prototype.hasOwnProperty.call(session.pending, '9'), false);
  assert.equal(session.state, 'ready');

  var valid = session.sendNotification({ id: 9, topicHash: topic, payload: { b: new Uint8Array([1]) } });
  assert.equal(serverDecoder.decode(valid).command, messages.COMMAND.NOTIFICATION);
  assert.equal(Object.prototype.hasOwnProperty.call(session.pending, '9'), true);
});

test('packed protocol and truncated-stream failures clear tokens, pending work, caches, and topics', function () {
  var session = new CourierSession({ negotiatedAlpn: 'apns-pack-v1:1024:1024' });
  var serverDecoder = new packed.PackedApsDecoder({ valueCacheSize: 1024 });
  var serverEncoder = new packed.PackedApsEncoder({ valueCacheSize: 1024 });
  var token = new Uint8Array(32).fill(5);
  var topic = new Uint8Array(20).fill(6);
  connectPacked(session, serverEncoder, serverDecoder, token, [topic]);
  session.sendNotification({ id: 77, topicHash: topic, payload: { b: new Uint8Array([1]) } });

  assert.throws(function () {
    session.push(new Uint8Array([messages.COMMAND.PONG, 1, 0x3f]));
  }, /cache reference is missing/);
  assert.equal(session.state, 'failed');
  assert.equal(session.token, null);
  assert.equal(session.encoder, null);
  assert.equal(session.decoder, null);
  assert.deepEqual(Object.keys(session.pending), []);
  assert.deepEqual(session.topics, []);
  assert.throws(function () { session.sendNotification({ id: 78 }); }, /not ready/);

  var truncated = new CourierSession({ negotiatedAlpn: 'apns-pack-v1:64:64' });
  truncated.start({});
  truncated.push(new Uint8Array([messages.COMMAND.CONNECT_RESPONSE]));
  assert.throws(function () { truncated.finish(); }, /truncated frame/);
  assert.equal(truncated.state, 'failed');
  assert.equal(truncated.decoder, null);
});
