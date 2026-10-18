'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { CryptoCompositions } = require('../../src/crypto/compositions');
const { DeterministicSoftwareCrypto } = require('../../harness/deterministic-software-crypto');
const { bytesToHex, hexToBytes, utf8ToBytes } = require('../../src/runtime/bytes');
const srp = require('../../src/apple-account/srp');

function provider() {
  return new CryptoCompositions(new DeterministicSoftwareCrypto());
}

test('account SRP produces a stable pinned-oracle transcript', function () {
  const crypto = provider();
  const passwordHash = srp.derivePasswordHash(crypto, 'correct horse battery staple');
  const result = srp.completeChallenge(crypto, {
    username: 'fixture@example.invalid',
    passwordHash,
    protocol: 's2k_fo',
    salt: hexToBytes('00112233445566778899aabbccddeeff'),
    iterations: 2048,
    privateEphemeral: hexToBytes('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'),
    serverPublic: hexToBytes(
      '7656b6ff367e7473370c2e4f2ed11f9fdd066349ac915488963b25b0478f55b8' +
      '8c4a58501928ad2cddcfb6ed20551a0a48d63c96eca394c9c707acfddb54a0d2'
    ),
  });

  assert.equal(bytesToHex(result.publicEphemeral),
    '630acdff5d334462d92a29e0b7fa6e20020f3333292f6d3a640f1c7a76ad9d31' +
    '7531c57979952e5736c88db118d060dc0539a812b9b0af3b4002380a9f28ae4a' +
    '7c45a896542de05fbcf76a4e7e0739b9a55d5d6c7aba4f1e1b58729a79bc084d' +
    '5ff513eaec33ce978f5bad87e579b5a95fc773198e22697b2eadab9eb94f84cdc' +
    'f1fe94ff09f88d4ca46e968bba443ff71167571f19feb052869bd28d7dabf963' +
    'b7fe399a1f70e7e08d00e1a3778ed1dddc3325dd09e05d31e774d1fd295c4ab' +
    'fbc613446232004d67cb03d6a034d2ce6ca0a544a0ff5b434b4b4267fa6c6d72' +
    'acbbda2efc1ef1d1fe36d35382b089abe556862aec35b29d3d0cdf359a9cfed3');
  assert.equal(bytesToHex(result.proof).length, 64);
  assert.equal(bytesToHex(result.expectedServerProof).length, 64);
  assert.equal(bytesToHex(result.sessionKey).length, 64);
  assert.equal(srp.verifyServerProof(result, result.expectedServerProof), true);
  assert.equal(srp.verifyServerProof(result, new Uint8Array(32)), false);
});

test('s2k and s2k_fo intentionally derive different proofs', function () {
  const crypto = provider();
  const base = {
    username: 'fixture@example.invalid',
    passwordHash: srp.derivePasswordHash(crypto, 'password'),
    salt: hexToBytes('aabbccdd'),
    iterations: 2,
    privateEphemeral: new Uint8Array([3]),
    serverPublic: srp.createPublicEphemeral(crypto, new Uint8Array([11])),
  };
  const s2k = srp.completeChallenge(crypto, { ...base, protocol: 's2k' });
  const s2kFo = srp.completeChallenge(crypto, { ...base, protocol: 's2k_fo' });
  assert.notDeepEqual(s2k.proof, s2kFo.proof);
});

test('SRP canonicalizes a leading-zero server public value like RustPush', function () {
  const crypto = provider();
  const serverPublic = srp.createPublicEphemeral(crypto, new Uint8Array([11]));
  const base = {
    username: 'fixture@example.invalid',
    passwordHash: srp.derivePasswordHash(crypto, 'password'),
    protocol: 's2k_fo',
    salt: hexToBytes('aabbccdd'),
    iterations: 2,
    privateEphemeral: new Uint8Array([3]),
  };
  const canonical = srp.completeChallenge(crypto, { ...base, serverPublic });
  const leadingZero = srp.completeChallenge(crypto, {
    ...base,
    serverPublic: new Uint8Array([0, ...serverPublic]),
  });

  assert.deepEqual(leadingZero.proof, canonical.proof);
  assert.deepEqual(leadingZero.sessionKey, canonical.sessionKey);
});

test('SRP rejects invalid public values and iteration counts', function () {
  const crypto = provider();
  const base = {
    username: 'fixture@example.invalid',
    passwordHash: new Uint8Array(32),
    protocol: 's2k',
    salt: new Uint8Array([1]),
    iterations: 1,
    privateEphemeral: new Uint8Array([1]),
    serverPublic: new Uint8Array([0]),
  };
  assert.throws(() => srp.completeChallenge(crypto, base), /Server public value/);
  assert.throws(() => srp.completeChallenge(crypto, { ...base, iterations: 0 }), /iteration count/);
  assert.throws(() => srp.createPublicEphemeral(crypto, new Uint8Array([0])), /non-zero/);
});

test('extra-data key derivation decrypts the paired CBC composition', function () {
  const crypto = provider();
  const sessionKey = new Uint8Array(32).fill(0x42);
  const keys = srp.deriveExtraDataKeys(crypto, sessionKey);
  const plaintext = utf8ToBytes('synthetic plist bytes');
  const ciphertext = crypto.aes({
    mode: 'cbc', direction: 'encrypt', key: keys.key, iv: keys.iv, data: plaintext,
  });
  assert.deepEqual(srp.decryptExtraData(crypto, sessionKey, ciphertext), plaintext);
});
