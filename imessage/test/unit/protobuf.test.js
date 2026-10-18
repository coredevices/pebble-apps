'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var bytes = require('../../src/runtime/bytes');
var protobuf = require('../../src/codecs/protobuf');

function hex(value) {
  return bytes.bytesToHex(value);
}

function fromHex(value) {
  return bytes.hexToBytes(value);
}

function expectInvalid(callback, pattern) {
  assert.throws(callback, function (error) {
    return error && error.code === 'INVALID_PROTOBUF' && (!pattern || pattern.test(error.message));
  });
}

test('varints match the protobuf wire-format examples and uint64 limits', function () {
  assert.equal(hex(protobuf.encodeVarint(150)), '9601');
  assert.deepEqual(protobuf.decodeVarint(fromHex('9601')), {
    value: 150n,
    nextOffset: 2,
    bytesRead: 2,
  });
  assert.equal(hex(protobuf.encodeTag(1, protobuf.WIRE_TYPES.VARINT)), '08');
  assert.equal(hex(protobuf.encodeVarint((1n << 64n) - 1n)), 'ffffffffffffffffff01');
  assert.equal(protobuf.decodeVarint(fromHex('ffffffffffffffffff01')).value, (1n << 64n) - 1n);

  expectInvalid(function () { protobuf.encodeVarint(-1); }, /uint64 range/);
  expectInvalid(function () { protobuf.encodeVarint(1n << 64n); }, /uint64 range/);
  expectInvalid(function () { protobuf.encodeTag(0, 0); }, /Field number/);
  expectInvalid(function () { protobuf.encodeTag(protobuf.MAX_FIELD_NUMBER + 1, 0); }, /Field number/);
});

test('writer and reader round-trip the send-only primitive set', function () {
  var sourceBytes = fromHex('00ff80');
  var writer = new protobuf.ProtobufWriter()
    .uint32(1, 150)
    .uint64(2, (1n << 64n) - 1n)
    .fixed32(3, 0x89abcdef)
    .fixed64(4, 0x0123456789abcdefn)
    .double(5, -123.25)
    .bool(6, true)
    .string(7, 'snowman: \u2603')
    .bytes(8, sourceBytes);
  sourceBytes.fill(0);

  var encoded = writer.finish();
  assert.equal(
    hex(encoded),
    '08960110ffffffffffffffffff011defcdab8921efcdab8967452301290000000000d05ec0' +
      '30013a0c736e6f776d616e3a20e29883420300ff80'
  );
  var reader = new protobuf.ProtobufReader(encoded);
  assert.equal(reader.readUint32(reader.nextField()), 150);
  assert.equal(reader.readUint64(reader.nextField()), (1n << 64n) - 1n);
  assert.equal(reader.readFixed32(reader.nextField()), 0x89abcdef);
  assert.equal(reader.readFixed64(reader.nextField()), 0x0123456789abcdefn);
  assert.equal(reader.readDouble(reader.nextField()), -123.25);
  assert.equal(reader.readBool(reader.nextField()), true);
  assert.equal(reader.readString(reader.nextField()), 'snowman: \u2603');
  assert.equal(hex(reader.readBytes(reader.nextField())), '00ff80');
  assert.equal(reader.nextField(), null);
  reader.finish();
});

test('reader and writer own their binary inputs', function () {
  var input = fromHex('0801');
  var reader = new protobuf.ProtobufReader(input);
  input.fill(0xff);
  assert.equal(reader.readUint32(reader.nextField()), 1);
  reader.finish();

  var writer = new protobuf.ProtobufWriter();
  var payload = fromHex('010203');
  writer.bytes(1, payload);
  payload.fill(0);
  assert.equal(hex(writer.finish()), '0a03010203');
});

test('bool follows protobuf semantics for any non-zero varint', function () {
  var trueReader = new protobuf.ProtobufReader(fromHex('0802'));
  assert.equal(trueReader.readBool(trueReader.nextField()), true);
  trueReader.finish();

  var falseReader = new protobuf.ProtobufReader(fromHex('0800'));
  assert.equal(falseReader.readBool(falseReader.nextField()), false);
  falseReader.finish();
});

test('double preserves all IEEE-754 values', function () {
  [Infinity, -Infinity, NaN].forEach(function (value) {
    var decoded = protobuf.decodeDouble(protobuf.encodeDouble(value));
    if (Number.isNaN(value)) assert.equal(Number.isNaN(decoded), true);
    else assert.equal(decoded, value);
  });
});

test('unknown fields of every wire type can be skipped, including groups', function () {
  var encoded = fromHex(
    '089601' +
    '110102030405060708' +
    '1a03aabbcc' +
    '23280124' +
    '35090a0b0c' +
    '3a04646f6e65'
  );
  var reader = new protobuf.ProtobufReader(encoded);
  var known;
  for (var field = reader.nextField(); field !== null; field = reader.nextField()) {
    if (field.number === 7) known = reader.readString(field);
    else reader.skipField(field);
  }
  reader.finish();
  assert.equal(known, 'done');
});

test('length, message, field-count, and group-depth limits are enforced', function () {
  expectInvalid(function () {
    var reader = new protobuf.ProtobufReader(fromHex('0a03010203'), { maxFieldLength: 2 });
    return reader.readBytes(reader.nextField());
  }, /maxFieldLength/);
  expectInvalid(function () {
    return new protobuf.ProtobufReader(fromHex('0801'), { maxMessageLength: 1 });
  }, /maxMessageLength/);

  var fields = new protobuf.ProtobufReader(fromHex('08011002'), { maxFields: 1 });
  fields.skipField(fields.nextField());
  expectInvalid(function () { fields.nextField(); }, /too many fields/);

  var groups = new protobuf.ProtobufReader(fromHex('0b10010c'), { maxGroupDepth: 0 });
  expectInvalid(function () { groups.skipField(groups.nextField()); }, /Group nesting/);
  expectInvalid(function () { return new protobuf.ProtobufReader(new Uint8Array(0), { maxFields: -1 }); });
});

test('malformed varints and tags fail closed', function () {
  [
    '80',
    '80808080808080808002',
    '80808080808080808080',
  ].forEach(function (encoded) {
    expectInvalid(function () { protobuf.decodeVarint(fromHex(encoded)); });
  });

  ['00', '0e', '8080808010'].forEach(function (encoded) {
    var reader = new protobuf.ProtobufReader(fromHex(encoded));
    expectInvalid(function () { reader.nextField(); });
  });
});

test('truncated, wrong-wire, unread, and malformed string fields fail closed', function () {
  [
    '0d01',
    '09010203',
    '0a0301',
  ].forEach(function (encoded) {
    var reader = new protobuf.ProtobufReader(fromHex(encoded));
    var field = reader.nextField();
    expectInvalid(function () { reader.skipField(field); }, /truncated/);
  });

  var wrongWire = new protobuf.ProtobufReader(fromHex('0d01020304'));
  var fixedField = wrongWire.nextField();
  expectInvalid(function () { wrongWire.readUint32(fixedField); }, /wrong wire/);

  var unconsumed = new protobuf.ProtobufReader(fromHex('0801'));
  unconsumed.nextField();
  expectInvalid(function () { unconsumed.nextField(); }, /not been consumed/);
  expectInvalid(function () { unconsumed.finish(); }, /not been consumed/);

  var malformedString = new protobuf.ProtobufReader(fromHex('0a02c0af'));
  expectInvalid(function () { malformedString.readString(malformedString.nextField()); }, /UTF-8/);
});

test('malformed and mismatched groups fail closed', function () {
  ['0b1001', '0b100114', '0c'].forEach(function (encoded) {
    var reader = new protobuf.ProtobufReader(fromHex(encoded));
    var field = reader.nextField();
    expectInvalid(function () { reader.skipField(field); });
  });
});

test('range validation applies to primitive readers and writers', function () {
  expectInvalid(function () { new protobuf.ProtobufWriter().uint32(1, 0x100000000); });
  expectInvalid(function () { new protobuf.ProtobufWriter().fixed32(1, -1); });
  expectInvalid(function () { new protobuf.ProtobufWriter().double(1, '1'); });

  var reader = new protobuf.ProtobufReader(fromHex('088080808010'));
  expectInvalid(function () { reader.readUint32(reader.nextField()); }, /uint32/);
});

test('bounded deterministic malformed-input sweep always terminates cleanly', function () {
  var state = 0x51a7f00d;
  function nextByte() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state & 0xff;
  }

  for (var sample = 0; sample < 512; sample += 1) {
    var input = new Uint8Array(nextByte() % 65);
    for (var index = 0; index < input.length; index += 1) input[index] = nextByte();
    try {
      var reader = new protobuf.ProtobufReader(input, {
        maxMessageLength: 64,
        maxFieldLength: 64,
        maxFields: 64,
        maxGroupDepth: 4,
      });
      for (var field = reader.nextField(); field !== null; field = reader.nextField()) reader.skipField(field);
      reader.finish();
    } catch (error) {
      assert.equal(error && error.code, 'INVALID_PROTOBUF');
    }
  }
});
