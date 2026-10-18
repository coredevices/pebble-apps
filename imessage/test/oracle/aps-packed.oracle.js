'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var path = require('node:path');
var test = require('node:test');
var bytes = require('../../src/runtime/bytes');
var packed = require('../../src/codecs/aps-packed');

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');

function data(value) { return { type: 'data', value: new Uint8Array(value) }; }
function attribute(id, value, cached) {
  return { id: new Uint8Array(id), value: value, cached: cached === true };
}

function runOracle(request) {
  childProcess.execFileSync(
    'cargo',
    ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  var output = childProcess.execFileSync(executable, [], {
    encoding: 'utf8',
    input: JSON.stringify(request) + '\n',
  });
  return JSON.parse(output.trim());
}

function requestValue(value) {
  if (value.type === 'data') {
    return { type: 'data', value_base64: bytes.bytesToBase64(value.value) };
  }
  if (value.type === 'dictionary') {
    return { type: 'dictionary', value: value.value.map(requestAttribute) };
  }
  if (value.type === 'array') {
    return { type: 'array', value: value.value.map(requestValue) };
  }
  return { type: value.type, value: value.value };
}

function requestAttribute(value) {
  return {
    id_base64: bytes.bytesToBase64(value.id),
    value: requestValue(value.value),
    cached: value.cached,
  };
}

function requestMessage(value) {
  return { command: value.command, attributes: value.attributes.map(requestAttribute) };
}

function responseValue(value) {
  if (value.type === 'data') {
    return { type: 'data', value: bytes.base64ToBytes(value.value_base64) };
  }
  if (value.type === 'dictionary') {
    return { type: 'dictionary', value: value.value.map(responseAttribute) };
  }
  if (value.type === 'array') {
    return { type: 'array', value: value.value.map(responseValue) };
  }
  if (value.type === 'int') {
    var numeric = Number(value.value);
    return { type: 'int', value: Number.isSafeInteger(numeric) ? numeric : value.value };
  }
  return { type: value.type, value: value.value };
}

function responseAttribute(value) {
  return {
    id: bytes.base64ToBytes(value.id_base64),
    value: responseValue(value.value),
    cached: value.cached,
  };
}

function responseMessage(value) {
  return { command: value.command, attributes: value.attributes.map(responseAttribute) };
}

function fixtures() {
  var repeated = {
    command: 0x0a,
    attributes: [
      attribute([0x74], data([1, 2, 3]), true),
      attribute([0xde, 0xad], {
        type: 'dictionary',
        value: [
          attribute([0x45], { type: 'string', value: 'cache me' }, false),
          attribute([0x01], {
            type: 'array',
            value: [
              { type: 'bool', value: true },
              { type: 'int', value: -123456789 },
              data([0, 255]),
            ],
          }, false),
        ],
      }, false),
    ],
  };
  return [
    { command: 0x0c, attributes: [] },
    repeated,
    repeated,
    {
      command: 0xfe,
      attributes: [
        attribute([0x01], { type: 'string', value: 'Unicode 🌍' }, false),
        attribute([0x02], data(new Uint8Array(300).map(function (_, index) { return index; })), false),
        attribute([0x03], { type: 'int', value: '9223372036854775807' }, false),
      ],
    },
  ];
}

test('JavaScript packed APS sequence exactly matches pinned RustPush including caches', function () {
  var messages = fixtures();
  var response = runOracle({
    schema_version: 1,
    request_id: 'packed-encode',
    operation: 'encode_packed_aps',
    value_cache_size: 0x1000,
    messages: messages.map(requestMessage),
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');

  var encoder = new packed.PackedApsEncoder();
  var javascriptFrames = messages.map(function (message) { return encoder.encode(message); });
  var rustFrames = response.result.frames_base64.map(bytes.base64ToBytes);
  assert.deepEqual(javascriptFrames, rustFrames);
});

test('pinned RustPush decodes JavaScript packed frames without losing unknown attributes', function () {
  var messages = fixtures();
  var encoder = new packed.PackedApsEncoder();
  var frames = messages.map(function (message) { return encoder.encode(message); });
  var decoder = new packed.PackedApsDecoder();
  var javascriptDecoded = frames.map(function (frame) { return decoder.decode(frame); });
  var response = runOracle({
    schema_version: 1,
    request_id: 'packed-decode',
    operation: 'decode_packed_aps',
    value_cache_size: 0x1000,
    frames_base64: frames.map(bytes.bytesToBase64),
  });

  assert.equal(response.ok, true);
  assert.deepEqual(response.result.messages.map(responseMessage), javascriptDecoded);
});
