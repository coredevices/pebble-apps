'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeBinaryPlist } = require('../../src/codecs/binary-plist');
const send = require('../../src/ids/send-envelope');

function target(index, payloadLength) {
  return {
    participant: 'mailto:recipient@example.invalid',
    sessionToken: new Uint8Array([index]),
    payload: new Uint8Array(payloadLength).fill(index),
    pushToken: new Uint8Array(32).fill(index),
    encryption: 'pair',
  };
}

test('command-100 envelope distinguishes pair and pair-ec targets', function () {
  const uuid = new Uint8Array(16).fill(7);
  const built = send.buildSendEnvelope({
    sender: 'mailto:sender@example.invalid', userAgent: '[synthetic,1,2,3]', apsId: 42, uuid,
    targets: [
      { participant: 'mailto:recipient@example.invalid', sessionToken: new Uint8Array([1]),
        payload: new Uint8Array([2]), pushToken: new Uint8Array(32).fill(3), encryption: 'pair-ec',
        supportsCertifiedDeliveryV1: true },
      { participant: 'mailto:sender@example.invalid', sessionToken: new Uint8Array([4]),
        payload: new Uint8Array([5]), pushToken: new Uint8Array(32).fill(6), encryption: 'pair' },
    ],
  });
  const decoded = decodeBinaryPlist(built.body);
  assert.equal(decoded.c, 100);
  assert.equal(decoded.E, 'pair');
  assert.equal(decoded.dtl[0].E, 'pair-ec');
  assert.equal(decoded.dtl[0].D, true);
  assert.equal(decoded.dtl[0].cdv, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded.dtl[1], 'E'), false);
  assert.equal(decoded.dtl[1].D, false);
});

test('command-100 retry envelope preserves RustPush signed ID and unsigned nanosecond epoch', function () {
  const originalEpochNanos = 1735689600123000000n;
  const built = send.buildSendEnvelope({
    sender: 'mailto:sender@example.invalid', userAgent: '[synthetic,1,2,3]', apsId: -1,
    uuid: new Uint8Array(16).fill(7), retryCount: 1, originalEpochNanos,
    targets: [{
      participant: 'mailto:recipient@example.invalid', sessionToken: new Uint8Array([1]),
      payload: new Uint8Array([2]), pushToken: new Uint8Array(32).fill(3), encryption: 'pair',
    }],
  });
  const decoded = decodeBinaryPlist(built.body);
  assert.equal(decoded.i, -1);
  assert.equal(decoded.rc, 1);
  assert.equal(decoded.oe, originalEpochNanos);
  assert.equal(built.value.oe, originalEpochNanos);

  assert.throws(() => send.buildSendEnvelope({
    sender: 'mailto:sender@example.invalid', userAgent: '[synthetic]', apsId: 1,
    uuid: new Uint8Array(16), retryCount: 1, originalEpochNanos: 0x10000000000000000n,
    targets: [{
      participant: 'mailto:recipient@example.invalid', sessionToken: new Uint8Array([1]),
      payload: new Uint8Array([2]), pushToken: new Uint8Array(32), encryption: 'pair',
    }],
  }), /unsigned 64-bit/);
});

test('command-100 batching matches RustPush encrypted-size cross-then-flush and one-based fcn', function () {
  const uuid = new Uint8Array(16).fill(7);
  const built = send.buildSendEnvelopes({
    sender: 'mailto:sender@example.invalid', userAgent: '[synthetic]', apsId: -42, uuid,
    targets: [target(1, 2500), target(2, 2500), target(3, 1), target(4, 6000), target(5, 1)],
  });
  const decoded = built.map(function (envelope) { return decodeBinaryPlist(envelope.body); });

  assert.equal(send.GROUP_MAX_SIZE, 5000);
  assert.deepEqual(decoded.map(function (envelope) { return envelope.fcn; }), [1, 2, 3]);
  assert.deepEqual(decoded.map(function (envelope) { return envelope.dtl.length; }), [3, 1, 1]);
  assert.deepEqual(decoded.map(function (envelope) {
    return envelope.dtl.map(function (bundle) { return bundle.t[0]; });
  }), [[1, 2, 3], [4], [5]]);
  decoded.forEach(function (envelope) {
    assert.equal(envelope.i, -42);
    assert.deepEqual(envelope.U, uuid);
  });
});

test('command-100 batching rejects an unrepresentable fcn count', function () {
  assert.throws(function () {
    send.buildSendEnvelopes({
      sender: 'mailto:sender@example.invalid', userAgent: '[synthetic]', apsId: 1,
      uuid: new Uint8Array(16),
      targets: Array.from({ length: 256 }, function (_, index) {
        return target((index % 254) + 1, 5001);
      }),
    });
  }, /more than 255 batches/);
});

test('command-255 result correlation ignores other UUIDs and validates status', function () {
  const uuid = new Uint8Array(16).fill(1);
  assert.equal(send.parseSendResult({ c: 255, U: new Uint8Array(16).fill(2) }, uuid), null);
  assert.deepEqual(send.parseSendResult({ c: 255, U: uuid, t: new Uint8Array(32), s: 0 }, uuid), {
    pushToken: new Uint8Array(32), status: 0,
  });
  assert.throws(() => send.parseSendResult({ c: 255, U: uuid, t: 'bad', s: 0 }, uuid), /malformed/);
});
