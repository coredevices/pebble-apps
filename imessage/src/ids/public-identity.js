'use strict';

var asn1 = require('../codecs/asn1');
var bytes = require('../runtime/bytes');

function keyPart(value, name) {
  bytes.assertBytes(value, name);
  if (value.length === 0 || value.length > 0xffff) throw new TypeError(name + ' has an invalid length.');
  return bytes.concatBytes(bytes.uint16BE(value.length), value);
}

function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new TypeError('Public identity is required.');
  bytes.assertBytes(identity.signingPublicKey, 'signing public key');
  bytes.assertBytes(identity.encryptionPublicKey, 'encryption public key');
  if (identity.signingPublicKey.length !== 65 || identity.signingPublicKey[0] !== 4) {
    throw new TypeError('Signing public key must be an uncompressed P-256 point.');
  }
  return identity;
}

function encodePublicIdentity(identity) {
  identity = normalizeIdentity(identity);
  var signing = keyPart(identity.signingPublicKey, 'signing public key');
  var encryption = keyPart(identity.encryptionPublicKey, 'encryption public key');
  return asn1.derSequence([
    asn1.derContext(1, false, signing),
    asn1.derContext(2, false, encryption),
  ]);
}

function decodeKeyPart(value, name) {
  if (value.length < 2) throw new TypeError(name + ' is truncated.');
  var length = bytes.readUint16BE(value);
  if (length === 0 || length !== value.length - 2) throw new TypeError(name + ' length is invalid.');
  return value.slice(2);
}

function decodePublicIdentity(encoded) {
  var root = asn1.parseDer(encoded);
  if (root.tagClass !== asn1.TAG_CLASSES.UNIVERSAL || root.tagNumber !== asn1.UNIVERSAL_TAGS.SEQUENCE
      || !root.constructed || root.children.length !== 2) throw new TypeError('Public identity DER is malformed.');
  var signing = root.children[0];
  var encryption = root.children[1];
  if (signing.tagClass !== asn1.TAG_CLASSES.CONTEXT || signing.tagNumber !== 1 || signing.constructed
      || encryption.tagClass !== asn1.TAG_CLASSES.CONTEXT || encryption.tagNumber !== 2 || encryption.constructed) {
    throw new TypeError('Public identity key tags are malformed.');
  }
  return normalizeIdentity({
    signingPublicKey: decodeKeyPart(signing.value, 'signing key'),
    encryptionPublicKey: decodeKeyPart(encryption.value, 'encryption key'),
  });
}

function hashPublicIdentity(crypto, identity) {
  if (!crypto || typeof crypto.digest !== 'function') throw new TypeError('Digest primitive is required.');
  identity = normalizeIdentity(identity);
  return crypto.digest('sha256', bytes.concatBytes(
    keyPart(identity.signingPublicKey, 'signing public key'),
    keyPart(identity.encryptionPublicKey, 'encryption public key')
  ));
}

module.exports = {
  decodePublicIdentity: decodePublicIdentity,
  encodePublicIdentity: encodePublicIdentity,
  hashPublicIdentity: hashPublicIdentity,
};
