'use strict';

var bytes = require('../runtime/bytes');

function uint64BE(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Unsigned 64-bit value must be safe.');
  var result = new Uint8Array(8);
  for (var index = 7; index >= 0; index -= 1) {
    result[index] = value % 256;
    value = Math.floor(value / 256);
  }
  return result;
}

function createNonce(type, nowMs, randomBytes) {
  if (type !== 'http' && type !== 'apns') throw new TypeError('Nonce type is unsupported.');
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError('Nonce clock must be non-negative.');
  }
  bytes.assertBytes(randomBytes, 'nonce randomness');
  if (randomBytes.length !== 8) throw new TypeError('Nonce randomness must contain eight bytes.');
  var truncatedMs = Math.floor(nowMs / 1000) * 1000;
  return bytes.concatBytes(new Uint8Array([type === 'http' ? 1 : 0]), uint64BE(truncatedMs), randomBytes);
}

function lengthPrefixed(value) {
  bytes.assertBytes(value, 'signed field');
  if (value.length > 0xffffffff) throw new TypeError('Signed field is too large.');
  return bytes.concatBytes(bytes.uint32BE(value.length), value);
}

function buildSignaturePayload(nonce, bagKey, body, pushToken) {
  bytes.assertBytes(nonce, 'nonce');
  if (typeof bagKey !== 'string' || bagKey.length === 0) throw new TypeError('Bag key is required.');
  bytes.assertBytes(body, 'request body');
  bytes.assertBytes(pushToken, 'push token');
  if (pushToken.length !== 32) throw new TypeError('Push token must contain 32 bytes.');
  return bytes.concatBytes(
    nonce,
    lengthPrefixed(bytes.utf8ToBytes(bagKey)),
    lengthPrefixed(new Uint8Array(0)),
    lengthPrefixed(body),
    lengthPrefixed(pushToken)
  );
}

function signRequest(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Signed request options are required.');
  if (!options.crypto || typeof options.crypto.sign !== 'function') throw new TypeError('Signing primitive is required.');
  if (options.keyType !== 'push' && options.keyType !== 'auth' && options.keyType !== 'id') {
    throw new TypeError('Signing key type is unsupported.');
  }
  bytes.assertBytes(options.certificate, 'signing certificate');
  var nonce = createNonce('http', options.nowMs, options.randomBytes);
  var payload = buildSignaturePayload(nonce, options.bagKey, options.body, options.pushToken);
  var signature = options.crypto.sign(options.keyId, {
    algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw',
  }, payload);
  var suffix = options.index === undefined || options.index === null ? '' : '-' + String(options.index);
  if (suffix && (!Number.isSafeInteger(options.index) || options.index < 0)) throw new TypeError('Signature index is invalid.');
  var prefix = 'x-' + options.keyType;
  return Object.freeze({
    nonce: nonce,
    payload: payload,
    headers: Object.freeze([
      Object.freeze([prefix + '-nonce' + suffix, bytes.bytesToBase64(nonce)]),
      Object.freeze([prefix + '-sig' + suffix, bytes.bytesToBase64(bytes.concatBytes(new Uint8Array([1, 1]), signature))]),
      Object.freeze([prefix + '-cert' + suffix, bytes.bytesToBase64(options.certificate)]),
    ]),
  });
}

module.exports = {
  buildSignaturePayload: buildSignaturePayload,
  createNonce: createNonce,
  signRequest: signRequest,
  uint64BE: uint64BE,
};
