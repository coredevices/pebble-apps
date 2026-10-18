'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { bytesToHex, utf8ToBytes } = require('../../src/runtime/bytes');
const signing = require('../../src/ids/request-signing');

test('HTTP nonce and signature payload exactly length-prefix signed fields', function () {
  const nonce = signing.createNonce('http', 1_700_000_000_987, new Uint8Array([1,2,3,4,5,6,7,8]));
  assert.equal(bytesToHex(nonce), '010000018bcfe568000102030405060708');
  const payload = signing.buildSignaturePayload(
    nonce, 'id-query', utf8ToBytes('body'), new Uint8Array(32).fill(9)
  );
  assert.equal(bytesToHex(payload).startsWith(bytesToHex(nonce) + '0000000869642d71756572790000000000000004626f647900000020'), true);
});

test('request signing wraps generic RSA signature with protocol marker', function () {
  let captured;
  const crypto = { sign(keyId, spec, data) { captured = { keyId, spec, data }; return new Uint8Array([0xaa, 0xbb]); } };
  const result = signing.signRequest({
    crypto, keyId: 'fixture-key', certificate: new Uint8Array([3, 4]), keyType: 'id',
    bagKey: 'id-query', body: new Uint8Array([5]), pushToken: new Uint8Array(32),
    nowMs: 1001, randomBytes: new Uint8Array(8),
  });
  assert.equal(captured.keyId, 'fixture-key');
  assert.deepEqual(captured.spec, { algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw' });
  assert.deepEqual(result.headers.map((header) => header[0]), ['x-id-nonce', 'x-id-sig', 'x-id-cert']);
  assert.equal(result.headers[1][1], 'AQGquw==');
});
