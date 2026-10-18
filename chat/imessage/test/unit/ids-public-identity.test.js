'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CryptoCompositions } = require('../../src/crypto/compositions');
const { DeterministicSoftwareCrypto } = require('../../harness/deterministic-software-crypto');
const identity = require('../../src/ids/public-identity');

test('legacy public identity DER round-trips odd-width RSA material', function () {
  const value = {
    signingPublicKey: new Uint8Array([4, ...new Uint8Array(64).fill(1)]),
    encryptionPublicKey: new Uint8Array(164).fill(2),
  };
  const encoded = identity.encodePublicIdentity(value);
  assert.deepEqual(identity.decodePublicIdentity(encoded), value);
  const crypto = new CryptoCompositions(new DeterministicSoftwareCrypto());
  assert.equal(identity.hashPublicIdentity(crypto, value).length, 32);
});

test('legacy public identity rejects malformed key tags and P-256 points', function () {
  assert.throws(() => identity.encodePublicIdentity({
    signingPublicKey: new Uint8Array(65), encryptionPublicKey: new Uint8Array([1]),
  }), /uncompressed/);
  assert.throws(() => identity.decodePublicIdentity(new Uint8Array([0x30, 0])), /wrong number|malformed/);
});
