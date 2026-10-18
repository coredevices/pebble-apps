'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var path = require('node:path');
var test = require('node:test');

var CryptoCompositions = require('../../src/crypto/compositions').CryptoCompositions;
var bytes = require('../../src/runtime/bytes');
var DeterministicSoftwareCrypto = require('../../harness/deterministic-software-crypto').DeterministicSoftwareCrypto;
var srp = require('../../src/apple-account/srp');

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');

function runOracle(request) {
  childProcess.execFileSync(
    'cargo', ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return JSON.parse(childProcess.execFileSync(executable, [], {
    encoding: 'utf8', input: JSON.stringify(request) + '\n',
  }).trim());
}

function fixture(protocol) {
  var crypto = new CryptoCompositions(new DeterministicSoftwareCrypto());
  var passwordHash = srp.derivePasswordHash(crypto, 'credential-free differential fixture');
  var options = {
    username: 'fixture@example.invalid',
    passwordHash: passwordHash,
    protocol: protocol,
    salt: bytes.hexToBytes('00112233445566778899aabbccddeeff'),
    iterations: 2048,
    privateEphemeral: bytes.hexToBytes(
      '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
    ),
    serverPublic: bytes.hexToBytes(
      '7656b6ff367e7473370c2e4f2ed11f9fdd066349ac915488963b25b0478f55b8' +
      '8c4a58501928ad2cddcfb6ed20551a0a48d63c96eca394c9c707acfddb54a0d2'
    ),
  };
  return { crypto: crypto, options: options };
}

test('JavaScript GrandSlam SRP exactly matches pinned RustPush for both password protocols', function () {
  ['s2k', 's2k_fo'].forEach(function (protocol) {
    [false, true].forEach(function (leadingZero) {
      var value = fixture(protocol);
      if (leadingZero) {
        value.options.serverPublic = bytes.concatBytes(new Uint8Array([0]), value.options.serverPublic);
      }
      var javascript = srp.completeChallenge(value.crypto, value.options);
      var response = runOracle({
        schema_version: 1,
        request_id: protocol + (leadingZero ? '-leading-zero' : '-canonical'),
        operation: 'complete_apple_srp',
        username: value.options.username,
        password_hash_base64: bytes.bytesToBase64(value.options.passwordHash),
        protocol: value.options.protocol,
        salt_base64: bytes.bytesToBase64(value.options.salt),
        iterations: value.options.iterations,
        private_ephemeral_base64: bytes.bytesToBase64(value.options.privateEphemeral),
        server_public_base64: bytes.bytesToBase64(value.options.serverPublic),
      });

      assert.equal(response.ok, true);
      assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
      assert.deepEqual(javascript.publicEphemeral, bytes.base64ToBytes(response.result.public_ephemeral_base64));
      assert.deepEqual(javascript.proof, bytes.base64ToBytes(response.result.proof_base64));
      assert.deepEqual(
        javascript.expectedServerProof,
        bytes.base64ToBytes(response.result.expected_server_proof_base64)
      );
      assert.deepEqual(javascript.sessionKey, bytes.base64ToBytes(response.result.session_key_base64));
    });
  });
});
