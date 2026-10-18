'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var packed = require('../../src/codecs/aps-packed');

function data(value) { return { type: 'data', value: new Uint8Array(value) }; }
function integer(value) { return { type: 'int', value: value }; }
function attribute(id, value, cached) {
  return { id: new Uint8Array(id), value: value, cached: cached === true };
}
function message(command, attributes) { return { command: command, attributes: attributes || [] }; }

test('packed APS encodes the pinned wire tags for empty and scalar messages', function () {
  var encoder = new packed.PackedApsEncoder();

  assert.deepEqual(encoder.encode(message(0x0c)), new Uint8Array([0x0c, 0x00]));
  assert.deepEqual(
    encoder.encode(message(0x0b, [
      attribute([1], data([0xaa]), false),
      attribute([4], integer(42), false),
    ])),
    new Uint8Array([0x0b, 0x06, 0x01, 0x01, 0xaa, 0x04, 0xa0, 0x2a])
  );
});

test('packed APS round-trips all value types, duplicate ids, and unknown byte ids', function () {
  var original = message(0xfe, [
    attribute([0x01], { type: 'string', value: 'hello 🌍' }, false),
    attribute([0x01], integer(-9007199254740991), false),
    attribute([0xde, 0xad, 0xbe, 0xef], {
      type: 'dictionary',
      value: [
        attribute([0x00], { type: 'bool', value: true }, false),
        attribute([0x74], data([0, 1, 2, 255]), false),
      ],
    }, false),
    attribute([0x0f], {
      type: 'array',
      value: [
        { type: 'bool', value: false },
        { type: 'string', value: '' },
        integer('9223372036854775807'),
        integer('-9223372036854775808'),
      ],
    }, false),
  ]);
  var frame = new packed.PackedApsEncoder().encode(original);
  var decoded = new packed.PackedApsDecoder().decode(frame);

  assert.equal(decoded.command, original.command);
  assert.deepEqual(decoded.attributes[0], original.attributes[0]);
  assert.deepEqual(decoded.attributes[1], original.attributes[1]);
  assert.deepEqual(decoded.attributes[2].id, original.attributes[2].id);
  assert.deepEqual(decoded.attributes[2].value.value[0], original.attributes[2].value.value[0]);
  assert.equal(decoded.attributes[2].value.value[1].cached, true);
  assert.deepEqual(decoded.attributes[2].value.value[1].value, data([0, 1, 2, 255]));
  assert.equal(decoded.attributes[3].value.value[2].value, '9223372036854775807');
  assert.equal(decoded.attributes[3].value.value[3].value, '-9223372036854775808');
  assert.deepEqual(new packed.PackedApsEncoder().encode(decoded), frame);
});

test('stateful value and key caches match reverse-index reference behavior', function () {
  var first = message(0x0a, [attribute([0x74], data([1, 2]), true)]);
  var encoder = new packed.PackedApsEncoder();
  var firstFrame = encoder.encode(first);
  var secondFrame = encoder.encode(first);

  assert.deepEqual(firstFrame, new Uint8Array([0x0a, 0x05, 0x50, 0x74, 0x02, 0x01, 0x02]));
  assert.deepEqual(secondFrame, new Uint8Array([0x0a, 0x02, 0xa0, 0x00]));

  var decoder = new packed.PackedApsDecoder();
  assert.deepEqual(decoder.decode(firstFrame), first);
  assert.deepEqual(decoder.decode(secondFrame), first);
});

test('nested dictionaries apply RustPush automatic cache keys and preserve cached metadata', function () {
  var original = message(1, [attribute([1], {
    type: 'dictionary',
    value: [
      attribute([0x74], data([4, 5]), false),
      attribute([0x78], data([6]), true),
    ],
  }, false)]);
  var encoder = new packed.PackedApsEncoder();
  var decoded = new packed.PackedApsDecoder().decode(encoder.encode(original));

  assert.equal(decoded.attributes[0].value.value[0].cached, true);
  assert.equal(decoded.attributes[0].value.value[1].cached, false);
});

test('incremental decoder accepts every TLS split and multiple cached frames per chunk', function () {
  var encoder = new packed.PackedApsEncoder();
  var expected = message(0x0a, [attribute([0x74], data([1, 2, 3]), true)]);
  var first = encoder.encode(expected);
  var second = encoder.encode(expected);
  var combined = new Uint8Array(first.length + second.length);
  combined.set(first, 0);
  combined.set(second, first.length);

  for (var split = 0; split <= combined.length; split += 1) {
    var decoder = new packed.PackedApsDecoder();
    var results = decoder.push(combined.slice(0, split)).concat(decoder.push(combined.slice(split)));
    assert.deepEqual(results, [expected, expected]);
    assert.equal(decoder.bufferedLength(), 0);
    assert.doesNotThrow(function () { decoder.finish(); });
  }
});

test('decoder enforces frame, collection, nesting, UTF-8, cache, and canonical bounds', function () {
  assert.throws(function () { new packed.PackedApsDecoder().decode(new Uint8Array([1])); }, /length/);
  assert.throws(function () {
    new packed.PackedApsDecoder().decode(new Uint8Array([1, 1]));
  }, /length/);
  assert.throws(function () {
    new packed.PackedApsDecoder({ maxFrameLength: 3 }).decode(new Uint8Array([1, 2, 1, 0]));
  }, /limit/);
  assert.throws(function () {
    new packed.PackedApsDecoder().decode(new Uint8Array([1, 2, 0x20, 0x80]));
  }, /cache reference/);
  assert.throws(function () {
    new packed.PackedApsDecoder().decode(new Uint8Array([1, 3, 1, 0x41, 0xff]));
  }, /UTF-8/);
  assert.throws(function () {
    new packed.PackedApsDecoder({ maxCollectionItems: 1 }).decode(
      new Uint8Array([1, 4, 1, 0xd2, 0x80, 0x80])
    );
  }, /collection/);
  assert.throws(function () {
    new packed.PackedApsDecoder({ maxDepth: 1 }).decode(
      new packed.PackedApsEncoder().encode(message(1, [attribute([1], {
        type: 'array', value: [{ type: 'array', value: [] }],
      }, false)]))
    );
  }, /nesting/);
  assert.throws(function () {
    new packed.PackedApsDecoder().decode(new Uint8Array([1, 0xff, 0x80, 0x00]));
  }, /canonical/);
});

test('failed encode and decode attempts roll cache mutations back', function () {
  var valid = message(1, [attribute([0x74], data([1]), true)]);
  var encoder = new packed.PackedApsEncoder();
  assert.throws(function () {
    encoder.encode(message(1, [
      attribute([0x74], data([1]), true),
      attribute([], data([]), false),
    ]));
  }, /cannot be empty/);
  assert.deepEqual(encoder.encode(valid), new packed.PackedApsEncoder().encode(valid));

  var populatedEncoder = new packed.PackedApsEncoder();
  var first = populatedEncoder.encode(valid);
  var reference = populatedEncoder.encode(valid);
  var decoder = new packed.PackedApsDecoder();
  decoder.decode(first);
  assert.throws(function () {
    decoder.decode(new Uint8Array([2, 3, 0x50, 0x78, 0xff]));
  });
  assert.deepEqual(decoder.decode(reference), valid);
});

test('encoder rejects unsafe integers, invalid attributes, oversized output, and truncated streams', function () {
  assert.throws(function () {
    new packed.PackedApsEncoder().encode(message(1, [attribute([1], integer(1.5), false)]));
  }, /safe integer/);
  assert.throws(function () {
    new packed.PackedApsEncoder().encode(message(1, [attribute([1], integer('9223372036854775808'), false)]));
  }, /64-bit/);
  assert.throws(function () {
    new packed.PackedApsEncoder().encode(message(1, [{ id: new Uint8Array([1]), value: data([]) }]));
  }, /invalid fields/);
  assert.throws(function () {
    new packed.PackedApsEncoder({ maxFrameLength: 3 }).encode(message(1, [attribute([1], data([1]), false)]));
  }, /limit/);

  var decoder = new packed.PackedApsDecoder();
  decoder.push(new Uint8Array([1]));
  assert.throws(function () { decoder.finish(); }, /truncated/);
});
