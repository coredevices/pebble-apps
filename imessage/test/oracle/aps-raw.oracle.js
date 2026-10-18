'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var path = require('node:path');
var test = require('node:test');
var bytes = require('../../src/runtime/bytes');
var encodeRawAps = require('../../src/codecs/aps-raw').encodeRawAps;

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');

function oracleFrames(fixtures) {
  childProcess.execFileSync(
    'cargo',
    ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  var input = fixtures.map(function (fixture, index) {
    return JSON.stringify({
      schema_version: 1,
      request_id: index,
      operation: 'encode_raw_aps',
      command: fixture.command,
      fields: fixture.fields.map(function (field) {
        return { id: field.id, value_base64: bytes.bytesToBase64(field.value) };
      }),
    });
  }).join('\n') + '\n';
  return childProcess.execFileSync(executable, [], { encoding: 'utf8', input: input })
    .trim()
    .split('\n')
    .map(JSON.parse);
}

test('JavaScript raw APNs frames exactly match pinned RustPush', function () {
  var fixtures = [
    { command: 0x0c, fields: [] },
    {
      command: 0x0b,
      fields: [
        { id: 1, value: new Uint8Array([0x00, 0xff]) },
        { id: 4, value: new Uint8Array([0, 0, 0, 42]) },
      ],
    },
    {
      command: 0xff,
      fields: [
        { id: 0, value: new Uint8Array(255).map(function (_, index) { return index; }) },
        { id: 0, value: new Uint8Array(0) },
      ],
    },
  ];
  var responses = oracleFrames(fixtures);

  fixtures.forEach(function (fixture, index) {
    assert.equal(responses[index].ok, true);
    assert.equal(responses[index].result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
    assert.deepEqual(
      encodeRawAps(fixture.command, fixture.fields),
      bytes.base64ToBytes(responses[index].result.frame_base64)
    );
  });
});
