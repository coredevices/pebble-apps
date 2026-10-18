'use strict';

var byteRuntime = require('../runtime/bytes');

// RFC 5054 2048-bit group used by the pinned account-authentication implementation.
var GROUP_N_HEX =
  'ac6bdb41324a9a9bf166de5e1389582faf72b6651987ee07fc3192943db56050' +
  'a37329cbb4a099ed8193e0757767a13dd52312ab4b03310dcd7f48a9da04fd50' +
  'e8083969edb767b0cf6095179a163ab3661a05fbd5faaae82918a9962f0b93b8' +
  '55f97993ec975eeaa80d740adbf4ff747359d041d5c33ea71d281e446b14773bc' +
  'a97b43a23fb801676bd207a436c6481f1d2b9078717461a5b9d32e688f877485' +
  '44523b524b0d57d5ea77a2775d2ecfa032cfbdbf52fb3786160279004e57ae6a' +
  'f874e7303ce53299ccc041c7bc308d82a5698f3a8d0c38271ae35f8e9dbfbb69' +
  '4b5c803d89f7ae435de236d525f54759b65e372fcd68ef20fa7111f9e4aff73';
var GROUP_N_BYTES = byteRuntime.hexToBytes(GROUP_N_HEX);
var GROUP_N = BigInt('0x' + GROUP_N_HEX);
var GROUP_G = 2n;

function requireCrypto(crypto) {
  if (!crypto || typeof crypto.digest !== 'function' || typeof crypto.hmac !== 'function'
      || typeof crypto.pbkdf2 !== 'function' || typeof crypto.aes !== 'function') {
    throw new TypeError('SRP requires digest, HMAC, PBKDF2, and AES primitives.');
  }
  return crypto;
}

function fromBytes(bytes) {
  byteRuntime.assertBytes(bytes, 'integer');
  var value = 0n;
  for (var index = 0; index < bytes.length; index += 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

function toBytes(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Integer must be unsigned.');
  if (value === 0n) return new Uint8Array(0);
  var output = [];
  while (value > 0n) {
    output.push(Number(value & 255n));
    value >>= 8n;
  }
  output.reverse();
  return new Uint8Array(output);
}

function padTo(bytes, length) {
  byteRuntime.assertBytes(bytes, 'integer');
  if (!Number.isSafeInteger(length) || length < bytes.length) {
    throw new TypeError('Invalid padded integer length.');
  }
  var output = new Uint8Array(length);
  output.set(bytes, length - bytes.length);
  return output;
}

function modPow(base, exponent, modulus) {
  if (modulus <= 0n || exponent < 0n) throw new TypeError('Invalid modular exponentiation input.');
  var result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if ((exponent & 1n) === 1n) result = (result * base) % modulus;
    exponent >>= 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function xor(left, right) {
  if (left.length !== right.length) throw new TypeError('XOR inputs must have equal length.');
  var output = new Uint8Array(left.length);
  for (var index = 0; index < left.length; index += 1) output[index] = left[index] ^ right[index];
  return output;
}

function assertChallenge(options) {
  if (!options || typeof options !== 'object') throw new TypeError('SRP challenge is required.');
  if (typeof options.username !== 'string' || options.username.length === 0) {
    throw new TypeError('SRP username must be non-empty.');
  }
  if (options.protocol !== 's2k' && options.protocol !== 's2k_fo') {
    throw new TypeError('Unsupported SRP password protocol.');
  }
  byteRuntime.assertBytes(options.passwordHash, 'password hash');
  byteRuntime.assertBytes(options.salt, 'salt');
  byteRuntime.assertBytes(options.serverPublic, 'server public value');
  byteRuntime.assertBytes(options.privateEphemeral, 'private ephemeral');
  if (options.passwordHash.length !== 32 || options.privateEphemeral.length === 0
      || options.serverPublic.length === 0) {
    throw new TypeError('Invalid SRP challenge byte length.');
  }
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1
      || options.iterations > 10000000) {
    throw new TypeError('Invalid SRP iteration count.');
  }
}

/** @param {{digest:function(string,Uint8Array):Uint8Array}} crypto @param {Uint8Array} privateEphemeral */
function createPublicEphemeral(crypto, privateEphemeral) {
  requireCrypto(crypto);
  byteRuntime.assertBytes(privateEphemeral, 'private ephemeral');
  if (privateEphemeral.length === 0 || fromBytes(privateEphemeral) === 0n) {
    throw new TypeError('Private ephemeral must be non-zero.');
  }
  return toBytes(modPow(GROUP_G, fromBytes(privateEphemeral), GROUP_N));
}

/**
 * Complete the account service's SRP-6a challenge exactly as the pinned oracle does.
 * All inputs and outputs are byte arrays; password material stays caller-owned and ephemeral.
 */
function completeChallenge(crypto, options) {
  crypto = requireCrypto(crypto);
  assertChallenge(options);

  var a = fromBytes(options.privateEphemeral);
  if (a === 0n) throw new TypeError('Private ephemeral must be non-zero.');
  var aPublic = toBytes(modPow(GROUP_G, a, GROUP_N));
  var b = fromBytes(options.serverPublic);
  if (b % GROUP_N === 0n) throw new TypeError('Server public value is invalid.');
  // RustPush parses B as an integer and serializes it back to minimal big-endian bytes before
  // hashing it into u and M1. Apple may encode a positive plist integer with a leading zero, so
  // hashing the wire representation here would produce a different proof from RustPush.
  var bPublic = toBytes(b);

  var passwordInput = options.protocol === 's2k_fo'
    ? byteRuntime.utf8ToBytes(byteRuntime.bytesToHex(options.passwordHash))
    : new Uint8Array(options.passwordHash);
  var password = crypto.pbkdf2('sha256', passwordInput, options.salt, options.iterations, 32);
  var identityHash = crypto.digest('sha256', byteRuntime.concatBytes(
    byteRuntime.utf8ToBytes(':'),
    password
  ));
  var x = fromBytes(crypto.digest('sha256', byteRuntime.concatBytes(options.salt, identityHash)));
  var k = fromBytes(crypto.digest('sha256', byteRuntime.concatBytes(
    GROUP_N_BYTES,
    padTo(toBytes(GROUP_G), GROUP_N_BYTES.length)
  )));
  var u = fromBytes(crypto.digest('sha256', byteRuntime.concatBytes(aPublic, bPublic)));
  if (u === 0n) throw new TypeError('SRP scrambling parameter is invalid.');

  var subtract = (k * modPow(GROUP_G, x, GROUP_N)) % GROUP_N;
  var base = (GROUP_N + b - subtract) % GROUP_N;
  var premaster = modPow(base, a + (u * x), GROUP_N);
  var sessionKey = crypto.digest('sha256', toBytes(premaster));

  var groupHash = crypto.digest('sha256', padTo(toBytes(GROUP_G), GROUP_N_BYTES.length));
  var userHash = crypto.digest('sha256', byteRuntime.utf8ToBytes(options.username));
  var proof = crypto.digest('sha256', byteRuntime.concatBytes(
    xor(groupHash, crypto.digest('sha256', GROUP_N_BYTES)),
    userHash,
    options.salt,
    aPublic,
    bPublic,
    sessionKey
  ));
  var serverProof = crypto.digest('sha256', byteRuntime.concatBytes(aPublic, proof, sessionKey));

  passwordInput.fill(0);
  password.fill(0);
  identityHash.fill(0);

  return Object.freeze({
    publicEphemeral: aPublic,
    proof: proof,
    expectedServerProof: serverProof,
    sessionKey: sessionKey,
  });
}

function verifyServerProof(result, receivedProof) {
  if (!result || !(result.expectedServerProof instanceof Uint8Array)) {
    throw new TypeError('SRP result is invalid.');
  }
  byteRuntime.assertBytes(receivedProof, 'server proof');
  return byteRuntime.bytesEqual(result.expectedServerProof, receivedProof);
}

function derivePasswordHash(crypto, password) {
  crypto = requireCrypto(crypto);
  if (typeof password !== 'string') throw new TypeError('Password must be a string.');
  var passwordBytes = byteRuntime.utf8ToBytes(password);
  try {
    return crypto.digest('sha256', passwordBytes);
  } finally {
    passwordBytes.fill(0);
  }
}

function deriveExtraDataKeys(crypto, sessionKey) {
  crypto = requireCrypto(crypto);
  byteRuntime.assertBytes(sessionKey, 'session key');
  return Object.freeze({
    key: crypto.hmac('sha256', sessionKey, byteRuntime.utf8ToBytes('extra data key:')),
    iv: crypto.hmac('sha256', sessionKey, byteRuntime.utf8ToBytes('extra data iv:')).slice(0, 16),
  });
}

function decryptExtraData(crypto, sessionKey, ciphertext) {
  byteRuntime.assertBytes(ciphertext, 'encrypted extra data');
  var keys = deriveExtraDataKeys(crypto, sessionKey);
  return crypto.aes({
    mode: 'cbc',
    direction: 'decrypt',
    key: keys.key,
    iv: keys.iv,
    data: ciphertext,
    padding: true,
  });
}

module.exports = {
  GROUP_N_HEX: GROUP_N_HEX,
  completeChallenge: completeChallenge,
  createPublicEphemeral: createPublicEphemeral,
  decryptExtraData: decryptExtraData,
  deriveExtraDataKeys: deriveExtraDataKeys,
  derivePasswordHash: derivePasswordHash,
  modPow: modPow,
  verifyServerProof: verifyServerProof,
};
