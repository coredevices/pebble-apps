'use strict';

const assert = require('node:assert/strict');
const cryptoNode = require('node:crypto');
const test = require('node:test');
const { CryptoCompositions } = require('../../src/crypto/compositions');
const { DeterministicSoftwareCrypto } = require('../../harness/deterministic-software-crypto');
const { utf8ToBytes } = require('../../src/runtime/bytes');
const legacy = require('../../src/ids/legacy-encryption');

test('legacy pair composition encrypts a body recoverable by the target RSA key', function () {
  const primitives = new CryptoCompositions(new DeterministicSoftwareCrypto());
  const rsa = cryptoNode.generateKeyPairSync('rsa', { modulusLength: 1280, publicExponent: 65537 });
  const ec = cryptoNode.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const targetRsaDer = new Uint8Array(rsa.publicKey.export({ type: 'pkcs1', format: 'der' }));
  const target = {
    signingPublicKey: new Uint8Array([4, ...new Uint8Array(64).fill(2)]),
    encryptionPublicKey: targetRsaDer,
  };
  const local = {
    signingKeyId: 'local-signing',
    signingPublicKey: new Uint8Array([4, ...new Uint8Array(64).fill(3)]),
    encryptionPublicKey: new Uint8Array(164).fill(4),
  };
  const composed = Object.assign(Object.create(primitives), {
    rsaEncrypt(publicKey, spec, data) {
      assert.equal(spec.hash, 'sha1');
      return new Uint8Array(cryptoNode.publicEncrypt({
        key: Buffer.from(publicKey), format: 'der', type: 'pkcs1',
        padding: cryptoNode.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1',
      }, Buffer.from(data)));
    },
    sign(keyId, spec, data) {
      assert.equal(keyId, 'local-signing');
      assert.equal(spec.hash, 'sha1');
      return new Uint8Array(cryptoNode.sign('sha1', Buffer.from(data), ec.privateKey));
    },
  });
  const plaintext = utf8ToBytes('synthetic legacy plaintext '.repeat(8));
  const payload = legacy.encryptLegacyPayload(composed, {
    localIdentity: local, targetIdentity: target, body: plaintext,
    randomKeyBytes: new Uint8Array([1,2,3,4,5,6,7,8,9,10,11]),
  });
  const parsed = legacy.parseLegacyEnvelope(payload);
  assert.equal(cryptoNode.verify('sha1', parsed.body, ec.publicKey, parsed.signature), true);
  const rsaSize = 160;
  const opened = cryptoNode.privateDecrypt({
    key: rsa.privateKey, padding: cryptoNode.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1',
  }, parsed.body.slice(0, rsaSize));
  const key = opened.subarray(0, 16);
  const encrypted = Buffer.concat([opened.subarray(16), parsed.body.slice(rsaSize)]);
  const decipher = cryptoNode.createDecipheriv('aes-128-ctr', key, legacy.IDS_IV);
  const recovered = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  assert.deepEqual(new Uint8Array(recovered), plaintext);
});

test('legacy pair rejects truncated envelopes and wrong random length', function () {
  assert.throws(() => legacy.parseLegacyEnvelope(new Uint8Array([2, 0, 1, 0])), /truncated/);
  assert.throws(() => legacy.encryptLegacyPayload({}, { body: new Uint8Array(0) }), /requires generic/);
});
