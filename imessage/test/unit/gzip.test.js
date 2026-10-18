'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var zlib = require('node:zlib');
var bytes = require('../../src/runtime/bytes');
var gzipCodec = require('../../src/codecs/gzip');

test('deterministic gzip has fixed metadata and is consumable by a standard inflater', function () {
  var input = bytes.utf8ToBytes('send-only iMessage payload 🪶');
  var first = gzipCodec.gzip(input);
  var second = gzipCodec.gzip(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first.slice(0, 10), new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]));
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(first)), input);
  assert.deepEqual(gzipCodec.ungzip(first), input);
  assert.equal(gzipCodec.crc32(bytes.utf8ToBytes('123456789')), 0xcbf43926);
});

test('ungzip decodes standard dynamic and fixed Huffman streams', function () {
  var input = bytes.utf8ToBytes(('recipient@example.com: hello; ').repeat(200));
  var dynamic = new Uint8Array(zlib.gzipSync(input, { level: 9, mtime: 1700000000 }));
  var fixed = new Uint8Array(zlib.gzipSync(input, { strategy: zlib.constants.Z_FIXED }));

  assert.deepEqual(gzipCodec.ungzip(dynamic), input);
  assert.deepEqual(gzipCodec.ungzip(fixed), input);
});

test('deterministic gzip splits large payloads into valid stored blocks', function () {
  var input = new Uint8Array(140000);
  for (var index = 0; index < input.length; index += 1) input[index] = index & 0xff;
  var encoded = gzipCodec.gzip(input);

  assert.deepEqual(gzipCodec.ungzip(encoded), input);
  assert.deepEqual(new Uint8Array(zlib.gunzipSync(encoded)), input);
});

test('ungzip rejects corrupt headers, reserved DEFLATE blocks, trailers, and truncation', function () {
  var valid = gzipCodec.gzip(bytes.utf8ToBytes('hello'));
  var badHeader = valid.slice();
  badHeader[0] = 0;
  assert.throws(function () { gzipCodec.ungzip(badHeader); }, /header/);

  var reservedBlock = valid.slice();
  reservedBlock[10] = 0x07;
  assert.throws(function () { gzipCodec.ungzip(reservedBlock); }, /reserved block type/);

  var badCrc = valid.slice();
  badCrc[badCrc.length - 8] ^= 1;
  assert.throws(function () { gzipCodec.ungzip(badCrc); }, /CRC/);

  var badSize = valid.slice();
  badSize[badSize.length - 4] ^= 1;
  assert.throws(function () { gzipCodec.ungzip(badSize); }, /size/);
  assert.throws(function () { gzipCodec.ungzip(valid.slice(0, 15)); }, /truncated|header|payload|DEFLATE/);
});

test('gzip and ungzip enforce input and output limits', function () {
  var input = new Uint8Array(1024).fill(65);
  var compressed = new Uint8Array(zlib.gzipSync(input));

  assert.throws(function () { gzipCodec.gzip(input, { maxInputBytes: 1023 }); }, /maxInputBytes/);
  assert.throws(function () { gzipCodec.gzip(input, { maxOutputBytes: 100 }); }, /maxOutputBytes/);
  assert.throws(function () { gzipCodec.ungzip(compressed, { maxInputBytes: compressed.length - 1 }); }, /maxInputBytes/);
  assert.throws(function () { gzipCodec.ungzip(compressed, { maxOutputBytes: 1023 }); }, /maxOutputBytes/);
});
