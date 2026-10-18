'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CryptoCompositions } = require('../../src/crypto/compositions');
const { bytesToHex, utf8ToBytes } = require('../../src/runtime/bytes');
const { DeterministicSoftwareCrypto } = require('../../harness/deterministic-software-crypto');

test('crypto composition adapter passes binary values without Node globals', function () {
  const crypto = new CryptoCompositions(new DeterministicSoftwareCrypto());
  assert.equal(
    bytesToHex(crypto.digest('sha256', utf8ToBytes('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  assert.equal(
    bytesToHex(crypto.hmac('sha256', utf8ToBytes('key'), utf8ToBytes('data'))),
    '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0'
  );
});

test('crypto composition adapter round-trips AES data', function () {
  const crypto = new CryptoCompositions(new DeterministicSoftwareCrypto());
  const key = new Uint8Array(32).fill(7);
  const iv = new Uint8Array(16).fill(9);
  const plaintext = utf8ToBytes('composition boundary');
  const ciphertext = crypto.aes({ mode: 'cbc', direction: 'encrypt', key, iv, data: plaintext });
  assert.deepEqual(
    crypto.aes({ mode: 'cbc', direction: 'decrypt', key, iv, data: ciphertext }),
    plaintext
  );
});
