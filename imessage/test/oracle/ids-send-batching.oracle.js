'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var path = require('node:path');
var test = require('node:test');
var binaryPlist = require('../../src/codecs/binary-plist');
var sendEnvelope = require('../../src/ids/send-envelope');

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

function target(payloadLength, index) {
  return {
    participant: 'mailto:recipient@example.invalid',
    sessionToken: new Uint8Array([index + 1]),
    payload: new Uint8Array(payloadLength),
    pushToken: new Uint8Array(32).fill(index + 1),
    encryption: 'pair',
  };
}

test('JS IDS envelope batching matches the pinned RustPush source model', function () {
  var payloadLengths = [2500, 2500, 1, 6000, 1];
  var response = runOracle({
    schema_version: 1,
    request_id: 'ids-send-batching',
    operation: 'group_ids_send_payloads',
    payload_lengths: payloadLengths,
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
  assert.equal(response.result.group_max_size, sendEnvelope.GROUP_MAX_SIZE);

  var envelopes = sendEnvelope.buildSendEnvelopes({
    sender: 'mailto:sender@example.invalid', userAgent: '[synthetic]', apsId: 42,
    uuid: new Uint8Array(16).fill(7),
    targets: payloadLengths.map(target),
  }).map(function (built) { return binaryPlist.decodeBinaryPlist(built.body); });
  var javascriptBatches = envelopes.map(function (envelope) {
    return {
      fcn: envelope.fcn,
      target_indexes: envelope.dtl.map(function (bundle) { return bundle.t[0] - 1; }),
      payload_bytes: envelope.dtl.reduce(function (total, bundle) {
        return total + bundle.P.length;
      }, 0),
    };
  });
  assert.deepEqual(javascriptBatches, response.result.batches);
});
