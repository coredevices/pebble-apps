'use strict';

var bytes = require('../runtime/bytes');
var identityCodec = require('./public-identity');

var IDS_IV = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

function encryptLegacyPayload(crypto, options) {
  if (!crypto || typeof crypto.hmac !== 'function' || typeof crypto.aes !== 'function'
      || typeof crypto.rsaEncrypt !== 'function' || typeof crypto.sign !== 'function') {
    throw new TypeError('Legacy encryption requires generic HMAC, AES, RSA, and signing primitives.');
  }
  if (!options || typeof options !== 'object') throw new TypeError('Legacy encryption options are required.');
  bytes.assertBytes(options.body, 'message body');
  bytes.assertBytes(options.randomKeyBytes, 'message randomness');
  if (options.randomKeyBytes.length !== 11) throw new TypeError('Legacy message randomness must contain 11 bytes.');
  if (!options.localIdentity || typeof options.localIdentity.signingKeyId !== 'string') {
    throw new TypeError('Local signing identity is required.');
  }

  var localHash = identityCodec.hashPublicIdentity(crypto, options.localIdentity);
  var targetHash = identityCodec.hashPublicIdentity(crypto, options.targetIdentity);
  var mac = crypto.hmac('sha256', options.randomKeyBytes, bytes.concatBytes(
    options.body,
    new Uint8Array([2]),
    localHash,
    targetHash
  ));
  var aesKey = bytes.concatBytes(options.randomKeyBytes, mac.slice(0, 5));
  var ciphertext = crypto.aes({
    mode: 'ctr', direction: 'encrypt', key: aesKey, iv: IDS_IV,
    data: options.body, padding: false,
  });
  var prefixLength = Math.min(100, ciphertext.length);
  var rsaPlaintext = bytes.concatBytes(aesKey, ciphertext.slice(0, prefixLength));
  var rsaCiphertext = crypto.rsaEncrypt(options.targetIdentity.encryptionPublicKey, {
    algorithm: 'rsa-oaep', hash: 'sha1', mgf1Hash: 'sha1', label: new Uint8Array(0),
  }, rsaPlaintext);
  var encryptedBody = bytes.concatBytes(rsaCiphertext, ciphertext.slice(prefixLength));
  if (encryptedBody.length > 0xffff) throw new TypeError('Legacy encrypted body exceeds its wire limit.');
  var signature = crypto.sign(options.localIdentity.signingKeyId, {
    algorithm: 'ecdsa', hash: 'sha1', signatureFormat: 'der',
  }, encryptedBody);
  if (signature.length > 255) throw new TypeError('Legacy signature exceeds its wire limit.');
  return bytes.concatBytes(
    new Uint8Array([2]),
    bytes.uint16BE(encryptedBody.length),
    encryptedBody,
    new Uint8Array([signature.length]),
    signature
  );
}

function parseLegacyEnvelope(value) {
  bytes.assertBytes(value, 'legacy payload');
  if (value.length < 4 || value[0] !== 2) throw new TypeError('Legacy payload header is invalid.');
  var bodyLength = bytes.readUint16BE(value, 1);
  var signatureOffset = 3 + bodyLength;
  if (signatureOffset >= value.length) throw new TypeError('Legacy payload body is truncated.');
  var signatureLength = value[signatureOffset];
  if (signatureOffset + 1 + signatureLength !== value.length) throw new TypeError('Legacy payload signature length is invalid.');
  return Object.freeze({
    body: value.slice(3, signatureOffset),
    signature: value.slice(signatureOffset + 1),
  });
}

module.exports = {
  IDS_IV: IDS_IV,
  encryptLegacyPayload: encryptLegacyPayload,
  parseLegacyEnvelope: parseLegacyEnvelope,
};
