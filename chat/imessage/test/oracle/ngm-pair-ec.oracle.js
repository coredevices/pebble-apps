'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var nodeCrypto = require('node:crypto');
var path = require('node:path');
var test = require('node:test');

var asn1 = require('../../src/codecs/asn1');
var bytes = require('../../src/runtime/bytes');
var ngm = require('../../src/ids/ngm-pair-ec');

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');
var compact = bytes.hexToBytes('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
var spki = ngm.compactP256ToSpki(compact);

function runOracle(request) {
  childProcess.execFileSync(
    'cargo', ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return JSON.parse(childProcess.execFileSync(executable, [], {
    encoding: 'utf8', input: JSON.stringify(request) + '\n',
  }).trim());
}

function b64(value) { return bytes.bytesToBase64(value); }

function fixture() {
  var secret = new Uint8Array(32).map(function (_, index) { return 0x80 + index; });
  var rawSignature = new Uint8Array(64).map(function (_, index) { return index + 1; });
  var padding;
  var signatureData;
  var provider = {
    aes: function (options) {
      var cipher = nodeCrypto.createCipheriv('aes-256-ctr', Buffer.from(options.key), Buffer.from(options.iv));
      return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(options.data)), cipher.final()]));
    },
    deleteKey: function () {},
    derive: function () { return secret; },
    digest: function () { return new Uint8Array(32); },
    exportPublicKey: function () { return spki; },
    generateKey: function () { return 'oracle-ephemeral'; },
    hkdf: function (algorithm, key, salt, info, length) {
      return new Uint8Array(nodeCrypto.hkdfSync(algorithm, Buffer.from(key), Buffer.from(salt), Buffer.from(info), length));
    },
    random: function (length) {
      padding = new Uint8Array(length).map(function (_, index) { return 0x30 + index; });
      return padding;
    },
    sign: function (_, __, data) {
      signatureData = new Uint8Array(data);
      return asn1.ecdsaRawSignatureToDer(rawSignature);
    },
    verify: function () { return true; },
  };
  var body = bytes.utf8ToBytes('RustPush pair-ec differential fixture');
  var result = ngm.encryptPairEc({
    crypto: provider,
    sender: { deviceKeyId: 'sender', devicePublicKey: spki },
    target: {
      deviceKey: compact,
      preKeyData: ngm.encodePreKeyData({ key: compact, signature: new Uint8Array(64), timestamp: 1 }),
    },
    message: body,
    reserveCounter: function () { return 8; },
  });
  return {
    body: body,
    secret: secret,
    signature: rawSignature,
    padding: padding || new Uint8Array(0),
    signatureData: signatureData,
    result: result,
  };
}

test('JavaScript pair-ec composition exactly matches pinned RustPush', function () {
  var value = fixture();
  var response = runOracle({
    schema_version: 1,
    request_id: 'ngm-pair-ec',
    operation: 'compose_ngm_pair_ec',
    body_base64: b64(value.body),
    counter: 7,
    padding_base64: b64(value.padding),
    secret_base64: b64(value.secret),
    sender_device_base64: b64(compact),
    target_device_base64: b64(compact),
    target_prekey_base64: b64(compact),
    ephemeral_base64: b64(compact),
    signature_base64: b64(value.signature),
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
  assert.deepEqual(value.result.payload, bytes.base64ToBytes(response.result.outer_base64));
  assert.deepEqual(value.signatureData, bytes.base64ToBytes(response.result.signature_data_base64));

  var outer = ngm.decodeOuterMessage(value.result.payload);
  assert.deepEqual(outer.payload, bytes.base64ToBytes(response.result.ciphertext_base64));
  assert.deepEqual(outer.validator, bytes.base64ToBytes(response.result.validator_base64));
  assert.deepEqual(
    ngm.decodeInnerMessage(bytes.base64ToBytes(response.result.inner_base64)),
    { message: value.body, counter: 7 }
  );
});

test('pinned RustPush rejects a differential request with the wrong padding length', function () {
  var value = fixture();
  var response = runOracle({
    schema_version: 1,
    request_id: 'ngm-bad-padding',
    operation: 'compose_ngm_pair_ec',
    body_base64: b64(value.body),
    counter: 7,
    padding_base64: b64(bytes.concatBytes(value.padding, new Uint8Array([0]))),
    secret_base64: b64(value.secret),
    sender_device_base64: b64(compact),
    target_device_base64: b64(compact),
    target_prekey_base64: b64(compact),
    ephemeral_base64: b64(compact),
    signature_base64: b64(value.signature),
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'compose_failed');
});
