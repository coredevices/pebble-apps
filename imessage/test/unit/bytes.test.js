'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var bytes = require('../../src/runtime/bytes');
var RuntimeError = require('../../src/runtime/errors').RuntimeError;

test('hex and base64 codecs round-trip binary data without platform globals', function () {
  var input = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);

  assert.equal(bytes.bytesToHex(input), '00017f80feff');
  assert.deepEqual(bytes.hexToBytes('00017F80FEFF'), input);
  assert.equal(bytes.bytesToBase64(input), 'AAF/gP7/');
  assert.deepEqual(bytes.base64ToBytes('AAF/gP7/'), input);
  assert.deepEqual(bytes.base64ToBytes('Zg'), new Uint8Array([0x66]));
  assert.deepEqual(bytes.base64ToBytes('Zm8'), new Uint8Array([0x66, 0x6f]));
});

test('base64 decoder rejects malformed, non-canonical input', function () {
  ['A', 'A===', 'Zh==', 'Zm9=', 'Z m8=', 'Zm8_'].forEach(function (input) {
    assert.throws(function () { bytes.base64ToBytes(input); }, RuntimeError, input);
  });
});

test('UTF-8 codecs preserve Unicode text and reject malformed byte sequences', function () {
  var text = ' leading\nCafe\u0301 \ud83e\udeb6 trailing ';
  var encoded = bytes.utf8ToBytes(text);

  assert.equal(bytes.bytesToUtf8(encoded), text);
  assert.deepEqual(bytes.utf8ToBytes('\ud800'), new Uint8Array([0xef, 0xbf, 0xbd]));
  assert.throws(function () {
    bytes.bytesToUtf8(new Uint8Array([0xe0, 0x80, 0x80]));
  }, /invalid code point/);
  assert.throws(function () {
    bytes.bytesToUtf8(new Uint8Array([0xf0, 0x9f, 0xa6]));
  }, /truncated sequence/);
});

test('concatenation and copying return independent Uint8Array instances', function () {
  var first = new Uint8Array([1, 2]);
  var second = new Uint8Array([3]);
  var combined = bytes.concatBytes(first, new Uint8Array(0), second);
  var copied = bytes.copyBytes(first);

  assert.deepEqual(combined, new Uint8Array([1, 2, 3]));
  assert.equal(bytes.bytesEqual(combined, new Uint8Array([1, 2, 3])), true);
  assert.equal(bytes.bytesEqual(combined, new Uint8Array([1, 2, 4])), false);
  first[0] = 9;
  assert.deepEqual(combined, new Uint8Array([1, 2, 3]));
  assert.deepEqual(copied, new Uint8Array([1, 2]));
});

test('endian helpers encode and decode unsigned boundaries', function () {
  assert.deepEqual(bytes.uint16BE(0xabcd), new Uint8Array([0xab, 0xcd]));
  assert.deepEqual(bytes.uint16LE(0xabcd), new Uint8Array([0xcd, 0xab]));
  assert.equal(bytes.readUint16BE(new Uint8Array([0, 0xab, 0xcd]), 1), 0xabcd);
  assert.equal(bytes.readUint16LE(new Uint8Array([0, 0xcd, 0xab]), 1), 0xabcd);

  assert.deepEqual(bytes.uint32BE(0xfedcba98), new Uint8Array([0xfe, 0xdc, 0xba, 0x98]));
  assert.deepEqual(bytes.uint32LE(0xfedcba98), new Uint8Array([0x98, 0xba, 0xdc, 0xfe]));
  assert.equal(bytes.readUint32BE(new Uint8Array([0xfe, 0xdc, 0xba, 0x98])), 0xfedcba98);
  assert.equal(bytes.readUint32LE(new Uint8Array([0x98, 0xba, 0xdc, 0xfe])), 0xfedcba98);

  assert.throws(function () { bytes.uint16BE(-1); }, /unsigned integer/);
  assert.throws(function () { bytes.uint32LE(0x100000000); }, /unsigned integer/);
  assert.throws(function () { bytes.readUint32BE(new Uint8Array(3)); }, /outside the input/);
});

test('base64 decoder handles a multi-megabyte pinned-image-sized input', function () {
  const input = new Uint8Array(2 * 1024 * 1024 + 1).fill(173);
  assert.deepEqual(bytes.base64ToBytes(Buffer.from(input).toString('base64')), input);
});
