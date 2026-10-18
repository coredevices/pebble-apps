'use strict';

var asn1 = require('../codecs/asn1');
var protobuf = require('../codecs/protobuf');
var bytes = require('../runtime/bytes');
var publicIdentity = require('./public-identity');
var ngm = require('./ngm-pair-ec');

var RSA_ENCRYPTION_OID = '1.2.840.113549.1.1.1';
var MAX_COMPACT_KEY_ATTEMPTS = 128;

function requireCrypto(crypto) {
  var methods = ['deleteKey', 'exportPublicKey', 'generateKey', 'sign'];
  if (!crypto || typeof crypto !== 'object') throw new TypeError('Identity crypto compositions are required.');
  methods.forEach(function (method) {
    if (typeof crypto[method] !== 'function') throw new TypeError('Identity crypto is missing ' + method + '().');
  });
}

function parseEcSpki(spki) {
  var root = asn1.parseDer(spki);
  if (root.tagClass !== asn1.TAG_CLASSES.UNIVERSAL || root.tagNumber !== asn1.UNIVERSAL_TAGS.SEQUENCE
      || !root.constructed || root.children.length !== 2) throw new TypeError('EC public key SPKI is malformed.');
  var point = asn1.decodeBitString(root.children[1]);
  if (point.unusedBits !== 0 || point.bytes.length !== 65 || point.bytes[0] !== 4) {
    throw new TypeError('EC public key is not an uncompressed P-256 point.');
  }
  return point.bytes;
}

function rsaPkcs1FromSpki(spki) {
  var root = asn1.parseDer(spki);
  if (root.tagClass !== asn1.TAG_CLASSES.UNIVERSAL || root.tagNumber !== asn1.UNIVERSAL_TAGS.SEQUENCE
      || !root.constructed || root.children.length !== 2) throw new TypeError('RSA public key SPKI is malformed.');
  var algorithm = asn1.parseAlgorithmIdentifier(root.children[0]);
  if (algorithm.oid !== RSA_ENCRYPTION_OID) throw new TypeError('Public key is not RSA.');
  var key = asn1.decodeBitString(root.children[1]);
  if (key.unusedBits !== 0) throw new TypeError('RSA public key BIT STRING is malformed.');
  var parsedKey = asn1.parseDer(key.bytes);
  if (parsedKey.tagClass !== asn1.TAG_CLASSES.UNIVERSAL
      || parsedKey.tagNumber !== asn1.UNIVERSAL_TAGS.SEQUENCE || !parsedKey.constructed
      || parsedKey.children.length !== 2) throw new TypeError('RSA PKCS#1 public key is malformed.');
  return key.bytes;
}

function requireKeyLifecycle(lifecycle) {
  lifecycle = lifecycle || {};
  if (lifecycle.onKeyCreated !== undefined && typeof lifecycle.onKeyCreated !== 'function') {
    throw new TypeError('Identity key-created callback is invalid.');
  }
  if (lifecycle.onKeyDeleted !== undefined && typeof lifecycle.onKeyDeleted !== 'function') {
    throw new TypeError('Identity key-deleted callback is invalid.');
  }
  return lifecycle;
}

function createTrackedKey(crypto, specification, purpose, created, lifecycle) {
  var keyId = crypto.generateKey(Object.assign({}, specification, { persistence: 'persistent' }));
  var record = Object.freeze({ id: keyId, purpose: purpose });
  created.push(record);
  if (lifecycle.onKeyCreated) lifecycle.onKeyCreated(record);
  return keyId;
}

function deleteTrackedKey(crypto, record, lifecycle) {
  crypto.deleteKey(record.id);
  if (lifecycle.onKeyDeleted) lifecycle.onKeyDeleted(record.id);
}

function generateCompactKey(crypto, usages, purpose, created, lifecycle) {
  for (var attempt = 0; attempt < MAX_COMPACT_KEY_ATTEMPTS; attempt += 1) {
    var keyId = createTrackedKey(crypto, {
      algorithm: 'ec', namedCurve: 'p-256', usages: usages,
    }, purpose, created, lifecycle);
    var spki = crypto.exportPublicKey(keyId, 'spki');
    try {
      var parsed = ngm.parseCompactP256Spki(spki);
      return { keyId: keyId, publicKeySpki: spki, compact: parsed.compact };
    } catch (error) {
      deleteTrackedKey(crypto, created[created.length - 1], lifecycle);
      created.pop();
      if (error instanceof TypeError && /lower-half compact point/.test(error.message)) continue;
      throw error;
    }
  }
  throw new TypeError('Host did not generate a compact-compatible P-256 identity key.');
}

function artifactRecord(bundle) {
  return Object.freeze({
    version: 1,
    legacySigningKeyId: bundle.legacySigning.keyId,
    legacyEncryptionKeyId: bundle.legacyEncryption.keyId,
    deviceKeyId: bundle.device.keyId,
    preKeyId: bundle.prekey.keyId,
    legacySigningPublicKey: bytes.bytesToBase64(bundle.legacySigning.publicKeySpki),
    legacyEncryptionPublicKey: bytes.bytesToBase64(bundle.legacyEncryption.publicKeySpki),
    devicePublicKey: bytes.bytesToBase64(bundle.device.publicKeySpki),
    preKeyPublicKey: bytes.bytesToBase64(bundle.prekey.publicKeySpki),
    publicIdentity: bytes.bytesToBase64(bundle.publicIdentity),
  });
}

/** Generate the long-lived send identity. Private key material remains in the generic host vault. */
function createIdentityBundle(crypto, lifecycle) {
  requireCrypto(crypto);
  lifecycle = requireKeyLifecycle(lifecycle);
  var created = [];
  try {
    var signingId = createTrackedKey(crypto, {
      algorithm: 'ec', namedCurve: 'p-256', usages: ['sign'],
    }, 'ids-legacy-signing', created, lifecycle);
    var signingSpki = crypto.exportPublicKey(signingId, 'spki');
    var encryptionId = createTrackedKey(crypto, {
      algorithm: 'rsa', modulusLength: 1280, usages: ['decrypt'],
    }, 'ids-legacy-encryption', created, lifecycle);
    var encryptionSpki = crypto.exportPublicKey(encryptionId, 'spki');
    var device = generateCompactKey(crypto, ['sign'], 'ids-ngm-device', created, lifecycle);
    var prekey = generateCompactKey(crypto, ['derive'], 'ids-ngm-prekey', created, lifecycle);
    var bundle = {
      legacySigning: { keyId: signingId, publicKeySpki: signingSpki },
      legacyEncryption: { keyId: encryptionId, publicKeySpki: encryptionSpki },
      device: device,
      prekey: prekey,
      publicIdentity: publicIdentity.encodePublicIdentity({
        signingPublicKey: parseEcSpki(signingSpki),
        encryptionPublicKey: rsaPkcs1FromSpki(encryptionSpki),
      }),
    };
    bundle.artifact = artifactRecord(bundle);
    bundle.keyRecords = Object.freeze([
      Object.freeze({ id: signingId, purpose: 'ids-legacy-signing' }),
      Object.freeze({ id: encryptionId, purpose: 'ids-legacy-encryption' }),
      Object.freeze({ id: device.keyId, purpose: 'ids-ngm-device' }),
      Object.freeze({ id: prekey.keyId, purpose: 'ids-ngm-prekey' }),
    ]);
    return Object.freeze(bundle);
  } catch (error) {
    for (var index = created.length - 1; index >= 0; index -= 1) {
      try { deleteTrackedKey(crypto, created[index], lifecycle); }
      catch (_) { /* preserve generation failure; durable cleanup remains discoverable */ }
    }
    throw error;
  }
}

function restoreIdentityArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1) {
    throw new TypeError('Persisted IDS identity artifact is unsupported.');
  }
  var expectedKeys = [
    'version', 'legacySigningKeyId', 'legacyEncryptionKeyId', 'deviceKeyId', 'preKeyId',
    'legacySigningPublicKey', 'legacyEncryptionPublicKey', 'devicePublicKey',
    'preKeyPublicKey', 'publicIdentity',
  ].sort();
  var actualKeys = Object.keys(artifact).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some(function (key, index) { return key !== expectedKeys[index]; })) {
    throw new TypeError('Persisted IDS identity artifact contains unexpected fields.');
  }
  ['legacySigningKeyId', 'legacyEncryptionKeyId', 'deviceKeyId', 'preKeyId'].forEach(function (name) {
    if (typeof artifact[name] !== 'string' || artifact[name].length === 0) {
      throw new TypeError('Persisted IDS identity key ID is malformed.');
    }
  });
  function decode(name) {
    if (typeof artifact[name] !== 'string') throw new TypeError('Persisted IDS identity public key is malformed.');
    return bytes.base64ToBytes(artifact[name]);
  }
  var deviceSpki = decode('devicePublicKey');
  var prekeySpki = decode('preKeyPublicKey');
  var signingSpki = decode('legacySigningPublicKey');
  var encryptionSpki = decode('legacyEncryptionPublicKey');
  var encodedIdentity = decode('publicIdentity');
  var decodedIdentity = publicIdentity.decodePublicIdentity(encodedIdentity);
  if (!bytes.bytesEqual(decodedIdentity.signingPublicKey, parseEcSpki(signingSpki))
      || !bytes.bytesEqual(decodedIdentity.encryptionPublicKey, rsaPkcs1FromSpki(encryptionSpki))) {
    throw new TypeError('Persisted IDS public identity does not match its opaque keys.');
  }
  return Object.freeze({
    legacySigning: Object.freeze({ keyId: artifact.legacySigningKeyId, publicKeySpki: signingSpki }),
    legacyEncryption: Object.freeze({ keyId: artifact.legacyEncryptionKeyId, publicKeySpki: encryptionSpki }),
    device: Object.freeze({ keyId: artifact.deviceKeyId, publicKeySpki: deviceSpki, compact: ngm.parseCompactP256Spki(deviceSpki).compact }),
    prekey: Object.freeze({ keyId: artifact.preKeyId, publicKeySpki: prekeySpki, compact: ngm.parseCompactP256Spki(prekeySpki).compact }),
    publicIdentity: encodedIdentity,
    artifact: Object.freeze(Object.assign({}, artifact)),
  });
}

function buildPrekeyData(crypto, identity, timestampSeconds) {
  if (!crypto || typeof crypto.sign !== 'function') throw new TypeError('Identity signing crypto is required.');
  if (!identity || !identity.device || !identity.prekey) throw new TypeError('IDS identity is required.');
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    throw new TypeError('IDS prekey timestamp is invalid.');
  }
  var unsigned = { key: identity.prekey.compact, timestamp: timestampSeconds };
  var signature = crypto.sign(identity.device.keyId, {
    algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'raw',
  }, ngm.prekeySignaturePayload(identity.prekey.compact, unsigned));
  return ngm.encodePreKeyData({ key: identity.prekey.compact, signature: signature, timestamp: timestampSeconds });
}

function buildKtLoggableData(identity) {
  if (!identity || !identity.device) throw new TypeError('IDS identity is required.');
  var nested = new protobuf.ProtobufWriter().bytes(1, identity.device.compact).finish();
  return new protobuf.ProtobufWriter().bytes(1, nested).uint32(2, 13).uint32(3, 5).finish();
}

module.exports = {
  buildKtLoggableData: buildKtLoggableData,
  buildPrekeyData: buildPrekeyData,
  createIdentityBundle: createIdentityBundle,
  restoreIdentityArtifact: restoreIdentityArtifact,
  rsaPkcs1FromSpki: rsaPkcs1FromSpki,
};
