'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var apsRaw = require('../../src/codecs/aps-raw');
var encodeRawAps = apsRaw.encodeRawAps;

test('raw APNs encoder preserves ordered and duplicate fields', function () {
  var result = encodeRawAps(0x0b, [
    { id: 1, value: new Uint8Array([0x00, 0xff]) },
    { id: 1, value: new Uint8Array([0, 0, 0, 42]) },
  ]);

  assert.deepEqual(result, new Uint8Array([
    0x0b, 0, 0, 0, 12,
    1, 0, 2, 0x00, 0xff,
    1, 0, 4, 0, 0, 0, 42,
  ]));
});

test('raw APNs encoder emits an empty five-byte frame', function () {
  assert.deepEqual(encodeRawAps(0x0c, []), new Uint8Array([0x0c, 0, 0, 0, 0]));
});

test('raw APNs encoder rejects values that cannot be represented on the wire', function () {
  assert.throws(function () { encodeRawAps(256, []); }, /command/);
  assert.throws(function () {
    encodeRawAps(1, [{ id: 2, value: new Uint8Array(0x10000) }]);
  }, /16-bit wire length/);
  assert.throws(function () {
    encodeRawAps(1, [{ id: 2, value: [1, 2] }]);
  }, /Uint8Array/);
});

test('raw APNs decoder round-trips fields without aliasing input', function () {
  var frame = encodeRawAps(0x0a, [
    { id: 2, value: new Uint8Array([1, 2, 3]) },
    { id: 2, value: new Uint8Array(0) },
  ]);
  var decoded = apsRaw.decodeRawApsFrame(frame);

  assert.equal(decoded.command, 0x0a);
  assert.deepEqual(decoded.fields, [
    { id: 2, value: new Uint8Array([1, 2, 3]) },
    { id: 2, value: new Uint8Array(0) },
  ]);
  frame.fill(0);
  assert.deepEqual(decoded.fields[0].value, new Uint8Array([1, 2, 3]));
});

test('incremental raw APNs decoder accepts every split and multiple frames', function () {
  var first = encodeRawAps(1, [{ id: 3, value: new Uint8Array([4, 5, 6]) }]);
  var second = encodeRawAps(2, []);
  var combined = new Uint8Array(first.length + second.length);
  combined.set(first);
  combined.set(second, first.length);

  for (var split = 0; split <= combined.length; split += 1) {
    var decoder = new apsRaw.RawApsStreamDecoder();
    var decoded = decoder.push(combined.slice(0, split));
    decoded = decoded.concat(decoder.push(combined.slice(split)));
    decoder.finish();
    assert.deepEqual(decoded.map(function (frame) { return frame.command; }), [1, 2], 'split ' + split);
  }
});

test('raw APNs decoder rejects inconsistent, oversized, and truncated frames', function () {
  assert.throws(function () {
    apsRaw.decodeRawApsFrame(new Uint8Array([1, 0, 0, 0, 3, 2, 0, 4]));
  }, /field value is truncated/);

  var oversized = new apsRaw.RawApsStreamDecoder({ maxBodyLength: 2 });
  assert.throws(function () {
    oversized.push(new Uint8Array([1, 0, 0, 0, 3]));
  }, /configured limit/);
  assert.equal(oversized.bufferedLength(), 0);

  var truncated = new apsRaw.RawApsStreamDecoder();
  truncated.push(new Uint8Array([1, 0, 0]));
  assert.throws(function () { truncated.finish(); }, /truncated frame/);
});
