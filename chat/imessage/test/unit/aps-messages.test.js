'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeRawApsFrame, encodeRawAps } = require('../../src/codecs/aps-raw');
const { encodeBinaryPlist } = require('../../src/codecs/binary-plist');
const messages = require('../../src/aps/messages');

test('raw courier message builders preserve protocol field order and duplicates', function () {
  const token = new Uint8Array(32).fill(1);
  const topicA = new Uint8Array(20).fill(2);
  const topicB = new Uint8Array(20).fill(3);
  const decoded = decodeRawApsFrame(messages.encodeOutgoing({
    type: 'filter', token, enabled: [topicA, topicB], ignored: [], opportunistic: [], paused: [],
  }));
  assert.equal(decoded.command, messages.COMMAND.FILTER);
  assert.deepEqual(decoded.fields.map((item) => item.id), [1, 2, 2]);
  assert.deepEqual(decoded.fields[2].value, topicB);
});

test('incoming notification uses server field direction and decodes binary plist', function () {
  const token = new Uint8Array(32).fill(4);
  const topic = new Uint8Array(20).fill(5);
  const frame = decodeRawApsFrame(encodeRawAps(messages.COMMAND.NOTIFICATION, [
    { id: 1, value: token },
    { id: 2, value: topic },
    { id: 3, value: encodeBinaryPlist({ synthetic: true }) },
    { id: 4, value: new Uint8Array([0xff, 0xff, 0xff, 0xfe]) },
  ]));
  const parsed = messages.parseIncoming(frame);
  assert.equal(parsed.id, -2);
  assert.deepEqual(parsed.token, token);
  assert.deepEqual(parsed.topicHash, topic);
  assert.deepEqual(parsed.payload, { synthetic: true });
});

test('outgoing notification accepts a value or pre-encoded payload', function () {
  const options = {
    type: 'notification', id: 42,
    topicHash: new Uint8Array(20), token: new Uint8Array(32), payload: { value: 'hello' },
  };
  const first = decodeRawApsFrame(messages.encodeOutgoing(options));
  options.payload = first.fields[2].value;
  const second = decodeRawApsFrame(messages.encodeOutgoing(options));
  assert.deepEqual(second, first);
});

test('packed outgoing mapping matches RustPush field direction, types, and cache policy', function () {
  const token = new Uint8Array(32).fill(6);
  const topic = new Uint8Array(20).fill(7);
  const payload = { c: 100, sP: 'mailto:sender@example.invalid', body: new Uint8Array([1, 2]) };
  const packed = messages.encodeOutgoingPacked({
    type: 'notification', id: -4, topicHash: topic, token, payload,
  });
  assert.equal(packed.command, messages.COMMAND.NOTIFICATION);
  assert.deepEqual(packed.attributes.map((entry) => entry.id[0]), [1, 2, 3, 4]);
  assert.deepEqual(packed.attributes.map((entry) => entry.cached), [true, true, false, false]);
  assert.deepEqual(packed.attributes.map((entry) => entry.value.type), ['data', 'data', 'dictionary', 'int']);
  assert.deepEqual(messages.jsValueFromPacked(packed.attributes[2].value), payload);
  assert.equal(packed.attributes[3].value.value, -4);
});

test('packed notifications normalize the raw mode pre-encoded binary plist contract', function () {
  const value = { c: 100, nested: ['hello', true, new Uint8Array([9])] };
  const common = {
    type: 'notification', id: 1,
    topicHash: new Uint8Array(20), token: new Uint8Array(32),
  };
  const fromValue = messages.encodeOutgoingPacked({ ...common, payload: value });
  const fromBytes = messages.encodeOutgoingPacked({ ...common, payload: encodeBinaryPlist(value) });
  assert.deepEqual(fromBytes, fromValue);
  assert.throws(() => messages.encodeOutgoingPacked({
    ...common, payload: new Uint8Array([1, 2, 3]),
  }), /binary property list/);
});

test('packed notifications preserve retry epoch bigint from a pre-encoded binary plist', function () {
  const originalEpochNanos = 1735689600123000000n;
  const common = {
    type: 'notification', id: -1,
    topicHash: new Uint8Array(20), token: new Uint8Array(32),
  };
  const packed = messages.encodeOutgoingPacked({
    ...common,
    payload: encodeBinaryPlist({ c: 100, i: -1, oe: originalEpochNanos }),
  });
  const payload = messages.jsValueFromPacked(packed.attributes[2].value);

  assert.equal(payload.c, 100);
  assert.equal(payload.i, -1);
  assert.equal(payload.oe, originalEpochNanos.toString());
  assert.throws(() => messages.packedValueFromJs(0x8000000000000000n), /signed 64-bit/);
});
