'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeRawApsFrame, encodeRawAps } = require('../../src/codecs/aps-raw');
const { encodeBinaryPlist } = require('../../src/codecs/binary-plist');
const messages = require('../../src/aps/messages');
const { RawCourierSession } = require('../../src/aps/raw-courier');

function fragments(bytes) {
  const result = [];
  for (let offset = 0, size = 1; offset < bytes.length; size = (size % 7) + 1) {
    result.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  return result;
}

test('raw courier reaches ready across arbitrary TLS fragmentation', function () {
  const courier = new RawCourierSession();
  const topic = new Uint8Array(20).fill(7);
  courier.setTopics([topic]);
  assert.equal(decodeRawApsFrame(courier.start({
    certificate: new Uint8Array([1]), nonce: new Uint8Array([2]), signature: new Uint8Array([3]),
  })).command, messages.COMMAND.CONNECT);

  const token = new Uint8Array(32).fill(9);
  const response = encodeRawAps(messages.COMMAND.CONNECT_RESPONSE, [
    { id: 1, value: new Uint8Array([0]) }, { id: 3, value: token },
  ]);
  let final;
  for (const chunk of fragments(response)) final = courier.push(chunk);
  assert.equal(courier.state, 'ready');
  assert.deepEqual(final.events, [{ type: 'ready', token }]);
  assert.deepEqual(final.writes.map((frame) => decodeRawApsFrame(frame).command), [
    messages.COMMAND.SET_STATE, messages.COMMAND.FILTER,
  ]);
  assert.deepEqual(decodeRawApsFrame(final.writes[1]).fields[1].value, topic);
});

test('raw courier correlates sends and acknowledges but discards incoming messages', function () {
  const token = new Uint8Array(32).fill(3);
  const courier = new RawCourierSession({ token });
  courier.start({ certificate: new Uint8Array([1]), nonce: new Uint8Array([2]), signature: new Uint8Array([3]) });
  courier.push(encodeRawAps(messages.COMMAND.CONNECT_RESPONSE, [{ id: 1, value: new Uint8Array([0]) }]));
  courier.sendNotification({ id: 22, topicHash: new Uint8Array(20), payload: { text: 'outbound' } });

  const ack = encodeRawAps(messages.COMMAND.ACK, [
    { id: 4, value: new Uint8Array([0, 0, 0, 22]) }, { id: 8, value: new Uint8Array([0]) },
  ]);
  const incoming = encodeRawAps(messages.COMMAND.NOTIFICATION, [
    { id: 1, value: token }, { id: 2, value: new Uint8Array(20).fill(4) },
    { id: 3, value: encodeBinaryPlist({ secretMessage: 'must not surface' }) },
    { id: 4, value: new Uint8Array([0, 0, 0, 23]) },
  ]);
  const result = courier.push(new Uint8Array([...ack, ...incoming]));
  assert.deepEqual(result.events[0], { type: 'sendAcknowledged', id: 22, status: 0 });
  assert.equal(result.events[1].type, 'notificationDiscarded');
  assert.equal(JSON.stringify(result.events).includes('secretMessage'), false);
  assert.equal(decodeRawApsFrame(result.writes[0]).command, messages.COMMAND.ACK);
});

test('raw courier fails closed on rejected connect and duplicate ids', function () {
  const token = new Uint8Array(32);
  const rejected = new RawCourierSession({ token });
  rejected.start({});
  assert.throws(() => rejected.push(encodeRawAps(messages.COMMAND.CONNECT_RESPONSE, [
    { id: 1, value: new Uint8Array([7]) },
  ])), (error) => error.code === 'CONNECT_REJECTED' && error.details.status === 7);

  const ready = new RawCourierSession({ token });
  ready.start({});
  ready.push(encodeRawAps(messages.COMMAND.CONNECT_RESPONSE, [{ id: 1, value: new Uint8Array([0]) }]));
  ready.sendNotification({ id: 5, topicHash: new Uint8Array(20), payload: new Uint8Array([1]) });
  assert.throws(() => ready.sendNotification({ id: 5, topicHash: new Uint8Array(20), payload: new Uint8Array([2]) }), /already pending/);
});
