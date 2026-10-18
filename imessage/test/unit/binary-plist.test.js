'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var bytes = require('../../src/runtime/bytes');
var binaryPlist = require('../../src/codecs/binary-plist');

test('binary plist round-trips every required type and safe integer width deterministically', function () {
  var value = {
    nullValue: null,
    booleans: [false, true],
    integers: [-9007199254740991, -2147483649, -32769, -129, -128, 127, 128, 32767, 32768, 2147483647, 2147483648, 9007199254740991],
    ascii: 'Pebble',
    unicode: 'Café 🪶',
    data: new Uint8Array([0, 1, 127, 128, 255]),
    date: new Date('2001-01-01T00:00:00.000Z'),
    dictionary: { first: 1, second: 2 },
  };

  var first = binaryPlist.encodeBinaryPlist(value);
  var second = binaryPlist.encodeBinaryPlist(value);
  assert.deepEqual(first, second);
  assert.equal(bytes.bytesToUtf8(first.slice(0, 8)), 'bplist00');
  assert.deepEqual(binaryPlist.decodeBinaryPlist(first), value);
});

test('binary plist decoder interoperates with a Python plistlib binary fixture', function () {
  var fixture = bytes.hexToBytes(
    '62706c6973743030d401020304050607086100e9516e5464617461516162' +
    'd83edeb613fffffee08e04fb3543616263a2090a0009081114161b1d222b' +
    '2f32330000000000000101000000000000000b0000000000000000000000' +
    '0000000034'
  );

  assert.deepEqual(binaryPlist.decodeBinaryPlist(fixture), {
    'é': '🪶',
    n: -1234567890123,
    data: new Uint8Array([97, 98, 99]),
    a: [null, true],
  });
});

test('binary plist decoder accepts Apple real, UID, UTF-8, and set markers', function () {
  var pythonFixture = bytes.base64ToBytes(
    'YnBsaXN0MDDVAQIDBAUGBwgJDFZyZWFsMzJWcmVhbDY0U3VpZFZzZXRpc2hUdXRmOCM/' +
    '+AAAAAAAACNACSH7VEQtGIEBAaIKC1FhUWJhAOkIExohJSwxOkNGSUtNAAAAAAAAAQEA' +
    'AAAAAAAADQAAAAAAAAAAAAAAAAAAAFA='
  );
  assert.deepEqual(binaryPlist.decodeBinaryPlist(pythonFixture), {
    real32: 1.5,
    real64: Math.PI,
    uid: 257,
    setish: ['a', 'b'],
    utf8: 'é',
  });

  var utf8Fixture = binaryPlist.encodeBinaryPlist('ab');
  utf8Fixture[8] = 0x72;
  utf8Fixture[9] = 0xc3;
  utf8Fixture[10] = 0xa9;
  assert.equal(binaryPlist.decodeBinaryPlist(utf8Fixture), 'é');

  [0xb2, 0xc2].forEach(function (marker) {
    var setFixture = binaryPlist.encodeBinaryPlist([1, 2]);
    setFixture[8] = marker;
    assert.deepEqual(binaryPlist.decodeBinaryPlist(setFixture), [1, 2]);
  });
});

test('binary plist integers match Apple/Rust unsigned-small, signed-64, and u64 widths', function () {
  function rootObject(value) {
    var encoded = binaryPlist.encodeBinaryPlist(value);
    return encoded.slice(8, encoded.length - 33);
  }

  assert.deepEqual(rootObject(255), bytes.hexToBytes('10ff'));
  assert.deepEqual(rootObject(65535), bytes.hexToBytes('11ffff'));
  assert.deepEqual(rootObject(0xffffffff), bytes.hexToBytes('12ffffffff'));
  assert.deepEqual(rootObject(-1), bytes.hexToBytes('13ffffffffffffffff'));
  assert.deepEqual(rootObject(-0x8000000000000000n), bytes.hexToBytes('138000000000000000'));
  assert.deepEqual(rootObject(0x7fffffffffffffffn), bytes.hexToBytes('137fffffffffffffff'));
  assert.deepEqual(rootObject(0xffffffffffffffffn), bytes.hexToBytes(
    '140000000000000000ffffffffffffffff'
  ));

  var values = [
    255, 65535, 0xffffffff, -1,
    -0x8000000000000000n, 0x7fffffffffffffffn, 0xffffffffffffffffn,
  ];
  values.forEach(function (value) {
    assert.equal(binaryPlist.decodeBinaryPlist(binaryPlist.encodeBinaryPlist(value)), value);
  });
});

test('binary plist safely represents dictionary keys named __proto__', function () {
  var input = Object.create(null);
  input.__proto__ = 'not a prototype';
  input.constructor = 42;
  var decoded = binaryPlist.decodeBinaryPlist(binaryPlist.encodeBinaryPlist(input));

  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded, '__proto__'), true);
  assert.equal(decoded.__proto__, 'not a prototype');
  assert.equal(decoded.constructor, 42);
});

test('binary plist rejects cycles and unsupported or unsafe values', function () {
  var cycle = [];
  cycle.push(cycle);
  assert.throws(function () { binaryPlist.encodeBinaryPlist(cycle); }, /cycle/);
  assert.throws(function () { binaryPlist.encodeBinaryPlist(Number.MAX_SAFE_INTEGER + 1); }, /safe integers/);
  assert.throws(function () { binaryPlist.encodeBinaryPlist(1.5); }, /safe integers/);
  assert.throws(function () { binaryPlist.encodeBinaryPlist(-0x8000000000000001n); }, /signed-64/);
  assert.throws(function () { binaryPlist.encodeBinaryPlist(0x10000000000000000n); }, /unsigned-64/);
  assert.throws(function () { binaryPlist.encodeBinaryPlist('\udc00'); }, /unpaired surrogate/);

  var unsupported = binaryPlist.encodeBinaryPlist(null);
  unsupported[8] = 0x90;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(unsupported); }, /Unsupported binary plist object type/);
});

test('binary plist parsing rejects malformed headers, trailers, offsets, references, and cycles', function () {
  var valid = binaryPlist.encodeBinaryPlist([1]);
  var malformedHeader = valid.slice();
  malformedHeader[0] = 0;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(malformedHeader); }, /header/);

  var badOffsetWidth = valid.slice();
  badOffsetWidth[badOffsetWidth.length - 26] = 0;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(badOffsetWidth); }, /widths/);

  var badOffset = valid.slice();
  var trailer = badOffset.length - 32;
  var offsetSize = badOffset[trailer + 6];
  var offsetTable = badOffset.length - 32 - 2 * offsetSize;
  badOffset[offsetTable] = 0;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(badOffset); }, /Object offset/);

  var badReference = valid.slice();
  badReference[9] = 2;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(badReference); }, /reference is outside/);

  var cyclicReference = valid.slice();
  cyclicReference[9] = 0;
  assert.throws(function () { binaryPlist.decodeBinaryPlist(cyclicReference); }, /reference cycle/);
});

test('binary plist parsing enforces configured bounds before recursive allocation', function () {
  var encoded = binaryPlist.encodeBinaryPlist({ value: [['abc'], new Uint8Array([1, 2, 3])] });
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxInputBytes: encoded.length - 1 }); }, /maxInputBytes/);
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxDepth: 1 }); }, /maxDepth/);
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxObjects: 2 }); }, /Object count/);
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxContainerLength: 0 }); }, /maxContainerLength/);
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxStringBytes: 2 }); }, /maxStringBytes|bounds/);
  assert.throws(function () { binaryPlist.decodeBinaryPlist(encoded, { maxDataBytes: 2 }); }, /bounds/);
});
