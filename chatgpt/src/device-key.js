'use strict';

var p256 = require('@noble/curves/nist.js').p256;
var sha256 = require('@noble/hashes/sha2.js').sha256;
var util = require('./util');
var PluginError = util.PluginError;

var SIGNING_DOMAIN = 'codex-device-key-sign-payload/v1';
var ALGORITHM = 'ecdsa_p256_sha256';
var PROTECTION_CLASS = 'os_protected_nonextractable';
// DER SubjectPublicKeyInfo header for an uncompressed P-256 point.
var SPKI_PREFIX = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08,
  0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00];

function toHex(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) hex += ('0' + bytes[i].toString(16)).slice(-2);
  return hex;
}

function fromHex(hex) {
  var bytes = new Uint8Array(hex.length / 2);
  for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/** A new key bound to the enrollment's account and client, from [seed]: 48 random bytes from the settings page. */
function generate(accountUserId, clientId, seed) {
  var secret = p256.utils.randomSecretKey(seed);
  var point = p256.getPublicKey(secret, false);
  var spki = new Uint8Array(SPKI_PREFIX.length + point.length);
  spki.set(SPKI_PREFIX);
  spki.set(point, SPKI_PREFIX.length);
  return {
    accountUserId: accountUserId,
    clientId: clientId,
    keyId: 'dk_' + util.uuid().replace(/-/g, ''),
    publicKeySpkiDerBase64: util.base64(spki),
    secretHex: toHex(secret),
  };
}

function identity(key) {
  return {
    key_id: key.keyId,
    public_key_spki_der_base64: key.publicKeySpkiDerBase64,
    algorithm: ALGORITHM,
    protection_class: PROTECTION_CLASS,
  };
}

function identityHash(key) {
  var json = JSON.stringify({
    algorithm: ALGORITHM,
    keyId: key.keyId,
    protectionClass: PROTECTION_CLASS,
    publicKeySpkiDerBase64: key.publicKeySpkiDerBase64,
  });
  return util.base64url(sha256(util.utf8(json)));
}

function sign(key, payload) {
  var signed = util.utf8(JSON.stringify({ domain: SIGNING_DOMAIN, payload: payload }));
  var signature = p256.sign(signed, fromHex(key.secretHex), { format: 'der' });
  return { signature_der_base64: util.base64(signature), signed_payload_base64: util.base64(signed), algorithm: ALGORITHM };
}

/** A challenge field by its camelCase name, or its snake_case alias. */
function field(challenge, name) {
  if (challenge[name] !== undefined) return challenge[name];
  return challenge[name.replace(/[A-Z]/g, function (c) { return '_' + c.toLowerCase(); })];
}

function mismatch() {
  return PluginError('PLUGIN_UNAVAILABLE', 'Codex remote control sent an unexpected challenge. Connect your computers again.');
}

/** Proof for an enroll or refresh challenge; the challenge must target [origin][path] for this key. */
function signEnrollment(key, challenge, origin, path, requireIdentityHash) {
  var hash = identityHash(key);
  var remoteHash = challenge && field(challenge, 'deviceIdentityHash');
  if (!challenge || field(challenge, 'accountUserId') !== key.accountUserId || field(challenge, 'clientId') !== key.clientId ||
      field(challenge, 'targetOrigin') !== origin || field(challenge, 'targetPath') !== path ||
      (remoteHash ? remoteHash !== hash : requireIdentityHash)) {
    throw mismatch();
  }
  var proof = sign(key, {
    accountUserId: field(challenge, 'accountUserId'),
    audience: field(challenge, 'audience'),
    challengeExpiresAt: field(challenge, 'challengeExpiresAt'),
    challengeId: field(challenge, 'challengeId'),
    clientId: field(challenge, 'clientId'),
    deviceIdentitySha256Base64url: hash,
    nonce: field(challenge, 'nonce'),
    targetOrigin: field(challenge, 'targetOrigin'),
    targetPath: field(challenge, 'targetPath'),
    type: 'remoteControlClientEnrollment',
  });
  return {
    challenge_token: field(challenge, 'challengeToken'),
    key_id: key.keyId,
    signature_der_base64: proof.signature_der_base64,
    signed_payload_base64: proof.signed_payload_base64,
    algorithm: proof.algorithm,
  };
}

/** Proof for the challenge the relay sends when a socket opens. */
function signConnection(key, challenge) {
  if (field(challenge, 'accountUserId') !== key.accountUserId || field(challenge, 'clientId') !== key.clientId) throw mismatch();
  var proof = sign(key, {
    accountUserId: field(challenge, 'accountUserId'),
    audience: field(challenge, 'audience'),
    clientId: field(challenge, 'clientId'),
    nonce: field(challenge, 'nonce'),
    scopes: field(challenge, 'scopes') || [],
    sessionId: field(challenge, 'sessionId'),
    targetOrigin: field(challenge, 'targetOrigin'),
    targetPath: field(challenge, 'targetPath'),
    tokenExpiresAt: field(challenge, 'tokenExpiresAt'),
    tokenSha256Base64url: field(challenge, 'tokenSha256Base64url'),
    type: 'remoteControlClientConnection',
  });
  return {
    type: 'device_key_proof',
    keyId: key.keyId,
    signatureDerBase64: proof.signature_der_base64,
    signedPayloadBase64: proof.signed_payload_base64,
    algorithm: proof.algorithm,
  };
}

module.exports = {
  generate: generate, identity: identity, identityHash: identityHash,
  signEnrollment: signEnrollment, signConnection: signConnection,
};
