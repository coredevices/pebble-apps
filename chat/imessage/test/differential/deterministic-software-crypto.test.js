'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DeterministicSoftwareCrypto } = require('../../harness/deterministic-software-crypto');
const { byteString, decodeByteString } = require('../../harness/schema');

function hex(value) {
  return Buffer.from(decodeByteString(value)).toString('hex');
}

test('software crypto provider passes digest, HMAC, HKDF, and PBKDF2 known answers', function () {
  const provider = new DeterministicSoftwareCrypto();
  const ascii = function (value) { return byteString(Buffer.from(value, 'ascii')); };

  assert.equal(hex(provider.request({
    operation: 'digest',
    parameters: { algorithm: 'sha256', data: ascii('abc') },
  })), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

  assert.equal(hex(provider.request({
    operation: 'hmac',
    parameters: { algorithm: 'sha256', key: ascii('key'), data: ascii('data') },
  })), '5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0');

  provider.importSecret('ikm', byteString(new Uint8Array(22).fill(0x0b)));
  assert.equal(hex(provider.request({
    operation: 'hkdf',
    parameters: {
      algorithm: 'sha256',
      key: { keyId: 'ikm' },
      salt: byteString([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
      info: byteString([240, 241, 242, 243, 244, 245, 246, 247, 248, 249]),
      length: 42,
    },
  })), '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865');

  assert.equal(hex(provider.request({
    operation: 'pbkdf2',
    parameters: {
      algorithm: 'sha256',
      password: ascii('password'),
      salt: ascii('salt'),
      iterations: 1,
      length: 32,
    },
  })), '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b');
});

test('software crypto provider round-trips deterministic AES-CBC and AES-CTR', function () {
  const provider = new DeterministicSoftwareCrypto();
  provider.importSecret('aes-key', byteString(new Uint8Array(32).fill(7)));
  const plaintext = byteString(Buffer.from('deterministic test payload'));
  const iv = byteString(new Uint8Array(16).fill(9));

  for (const mode of ['cbc', 'ctr']) {
    const encrypted = provider.request({
      operation: 'aes',
      parameters: { direction: 'encrypt', mode, key: { keyId: 'aes-key' }, iv, data: plaintext },
    });
    const decrypted = provider.request({
      operation: 'aes',
      parameters: { direction: 'decrypt', mode, key: { keyId: 'aes-key' }, iv, data: encrypted },
    });
    assert.deepEqual(decrypted, plaintext);
  }
});

test('software keys are copied and missing keys fail deterministically', function () {
  const provider = new DeterministicSoftwareCrypto();
  const source = new Uint8Array(32).fill(1);
  provider.importSecret('copy', source);
  source.fill(2);

  assert.doesNotThrow(function () {
    provider.request({
      operation: 'hmac',
      parameters: { algorithm: 'sha256', key: { keyId: 'copy' }, data: byteString([]) },
    });
  });
  provider.deleteKey('copy');
  assert.throws(function () {
    provider.request({
      operation: 'hmac',
      parameters: { algorithm: 'sha256', key: { keyId: 'copy' }, data: byteString([]) },
    });
  }, function (error) { return error.code === 'KEY_NOT_FOUND'; });
});
