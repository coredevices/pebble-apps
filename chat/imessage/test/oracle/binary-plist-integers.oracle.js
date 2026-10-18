'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var path = require('node:path');
var test = require('node:test');
var binaryPlist = require('../../src/codecs/binary-plist');
var bytes = require('../../src/runtime/bytes');

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');

function runOracle(request) {
  childProcess.execFileSync(
    'cargo', ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  var output = childProcess.execFileSync(executable, [], {
    encoding: 'utf8', input: JSON.stringify(request) + '\n',
  });
  return JSON.parse(output.trim());
}

test('binary plist IDS integers exactly match the pinned RustPush plist serializer', function () {
  var fixture = {
    c: 255,
    i: -1,
    oe: 0xffffffffffffffffn,
    s: 5032,
  };
  var response = runOracle({
    schema_version: 1,
    request_id: 'ids-plist-integers',
    operation: 'encode_ids_plist_integers',
    command: fixture.c,
    message_id: fixture.i,
    original_epoch_nanos: fixture.oe.toString(),
    status: fixture.s,
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
  var rustBytes = bytes.base64ToBytes(response.result.plist_base64);
  assert.equal(response.result.byte_length, rustBytes.length);
  assert.deepEqual(binaryPlist.decodeBinaryPlist(rustBytes), fixture);

  [
    ['command_plist_base64', fixture.c],
    ['message_id_plist_base64', fixture.i],
    ['original_epoch_nanos_plist_base64', fixture.oe],
    ['status_plist_base64', fixture.s],
  ].forEach(function (entry) {
    assert.deepEqual(
      binaryPlist.encodeBinaryPlist(entry[1]),
      bytes.base64ToBytes(response.result[entry[0]])
    );
  });
});
