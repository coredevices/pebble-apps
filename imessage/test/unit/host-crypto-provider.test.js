'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CryptoCompositions } = require('../../src/crypto/compositions');
const { NativeHostCryptoProvider } = require('../../src/runtime/host-crypto-provider');
const asn1 = require('../../src/codecs/asn1');

function native(responder) {
  return { request(raw) { return JSON.stringify(responder(JSON.parse(raw))); } };
}

test('native host adapter maps composition names to the generic KMP contract', function () {
  const seen = [];
  const provider = new NativeHostCryptoProvider(native((request) => {
    seen.push(request);
    if (request.operation === 'generate-key') return { ok: true, handle: 'abc', publicKey: 'AA==' };
    if (request.operation === 'import-private-key') return { ok: true, handle: 'imported' };
    if (request.operation === 'verify') return { ok: true, verified: true };
    if (request.operation === 'delete-key') return { ok: true, deleted: true };
    return { ok: true, data: 'AQI=' };
  }));
  const crypto = new CryptoCompositions(provider);
  assert.deepEqual(crypto.digest('sha256', new Uint8Array([3])), new Uint8Array([1, 2]));
  assert.equal(crypto.generateKey({ algorithm: 'ec', namedCurve: 'p-256' }), 'abc');
  assert.equal(crypto.importPrivateKey('RSA', new Uint8Array([1]), new Uint8Array([2])), 'imported');
  assert.equal(crypto.verify(new Uint8Array([1]), { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'der' }, new Uint8Array([2]), new Uint8Array([3])), true);
  assert.equal(crypto.deleteKey('abc'), true);
  assert.equal(seen[0].algorithm, 'SHA-256');
  assert.deepEqual(seen[1], {
    operation: 'generate-key', keyType: 'EC', curve: 'secp256r1', persistent: true,
  });
  assert.deepEqual(seen[2], {
    operation: 'import-private-key', keyType: 'RSA', privateKey: 'AQ==', publicKey: 'Ag==',
    persistent: true,
  });
  assert.equal(seen[3].algorithm, 'SHA256withECDSA');
});

test('native host adapter streams large generic digests below the Android bridge ceiling', function () {
  const seen = [];
  const crypto = new CryptoCompositions(new NativeHostCryptoProvider(native((request) => {
    seen.push(request);
    if (request.operation === 'digest-open') return { ok: true, handle: 'digest-1' };
    if (request.operation === 'digest-update') return { ok: true };
    if (request.operation === 'digest-finish') return { ok: true, data: 'AQI=' };
    if (request.operation === 'digest-abort') return { ok: true, deleted: true };
    throw new Error('unexpected request');
  })));
  const result = crypto.digest('sha1', new Uint8Array(1024 * 1024 + 17));
  assert.deepEqual(result, new Uint8Array([1, 2]));
  assert.deepEqual(seen.map((request) => request.operation), [
    'digest-open', 'digest-update', 'digest-update', 'digest-update', 'digest-finish',
  ]);
  seen.filter((request) => request.operation === 'digest-update').forEach((request) => {
    assert.ok(Buffer.from(request.data, 'base64').length <= 512 * 1024);
  });
});

test('native host adapter aborts an incremental digest after its first failure', function () {
  const operations = [];
  const crypto = new CryptoCompositions(new NativeHostCryptoProvider(native((request) => {
    operations.push(request.operation);
    if (request.operation === 'digest-open') return { ok: true, handle: 'digest-2' };
    if (request.operation === 'digest-update') {
      return { ok: false, code: 'OPERATION_FAILED', message: 'failed' };
    }
    if (request.operation === 'digest-abort') return { ok: true, deleted: true };
    throw new Error('unexpected request');
  })));
  assert.throws(() => crypto.digest('sha256', new Uint8Array(512 * 1024 + 1)),
    error => error.code === 'OPERATION_FAILED');
  assert.deepEqual(operations, ['digest-open', 'digest-update', 'digest-abort']);
});

test('native host adapter makes session key lifetime explicit and rejects unknown lifetimes', function () {
  const seen = [];
  const crypto = new CryptoCompositions(new NativeHostCryptoProvider(native((request) => {
    seen.push(request);
    return { ok: true, handle: 'ephemeral', publicKey: 'AA==' };
  })));
  assert.equal(crypto.generateKey({
    algorithm: 'ec', namedCurve: 'p-256', persistence: 'session',
  }), 'ephemeral');
  assert.equal(seen[0].persistent, false);
  crypto.importPrivateKey('RSA', new Uint8Array([1]), new Uint8Array([2]), {
    persistence: 'session',
  });
  assert.equal(seen[1].persistent, false);
  assert.throws(function () {
    crypto.generateKey({ algorithm: 'ec', namedCurve: 'p-256', persistence: 'forever' });
  }, /persistence/);
  assert.throws(function () {
    crypto.importPrivateKey('RSA', new Uint8Array([1]), new Uint8Array([2]), {
      persistence: 'forever',
    });
  }, /persistence/);
});

test('native host adapter surfaces structured host failures', function () {
  const crypto = new CryptoCompositions(new NativeHostCryptoProvider(native(() => ({
    ok: false, code: 'KEY_NOT_FOUND', message: 'missing',
  }))));
  assert.throws(() => crypto.exportPublicKey('abc', 'spki'), (error) => error.code === 'KEY_NOT_FOUND');
});

test('native host adapter translates raw P-256 ECDSA and selects generic RSA-OAEP hashes', function () {
  const seen = [];
  const der = asn1.ecdsaRawSignatureToDer(new Uint8Array(64).fill(1));
  const provider = new NativeHostCryptoProvider(native((request) => {
    seen.push(request);
    if (request.operation === 'verify') return { ok: true, verified: true };
    if (request.operation === 'sign') return { ok: true, data: Buffer.from(der).toString('base64') };
    return { ok: true, data: 'AQI=' };
  }));
  const compositions = new CryptoCompositions(provider);
  const specification = { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'raw' };
  const raw = new Uint8Array(64).fill(1);
  assert.equal(compositions.verify(new Uint8Array([1]), specification, new Uint8Array([2]), raw), true);
  assert.deepEqual(Buffer.from(seen[0].signature, 'base64'), Buffer.from(der));
  assert.deepEqual(compositions.sign('key', specification, new Uint8Array([2])), raw);
  assert.deepEqual(compositions.rsaEncrypt(new Uint8Array([1]), {
    algorithm: 'rsa-oaep', hash: 'sha1',
  }, new Uint8Array([2])), new Uint8Array([1, 2]));
  assert.equal(seen[2].operation, 'rsa-oaep-encrypt');
  assert.equal(seen[2].algorithm, 'RSA-OAEP-SHA1');
});

test('native host adapter rejects ambiguous AES and leaves RSA signature bytes unchanged', function () {
  const seen = [];
  const provider = new NativeHostCryptoProvider(native((request) => {
    seen.push(request);
    return request.operation === 'verify' ? { ok: true, verified: true } : { ok: true, data: 'AA==' };
  }));
  assert.throws(() => provider.request({ operation: 'aes', parameters: {
    mode: 'gcm', direction: 'encrypt', key: { $bytes: 'AA==' }, iv: { $bytes: 'AA==' },
    data: { $bytes: 'AA==' }, padding: false,
  } }), /AES mode/);
  assert.equal(provider.request({ operation: 'verify', parameters: {
    specification: { algorithm: 'rsa-pkcs1-v1_5', hash: 'sha256', signatureFormat: 'raw' },
    publicKey: { $bytes: 'AA==' }, data: { $bytes: 'AA==' }, signature: { $bytes: 'AA==' },
  } }), true);
  assert.equal(seen[0].signature, 'AA==');
});
