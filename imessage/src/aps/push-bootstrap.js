'use strict';

var asn1 = require('../codecs/asn1');
var runtimeErrors = require('../runtime/errors');

var RuntimeError = runtimeErrors.RuntimeError;
var ERROR_KINDS = runtimeErrors.ERROR_KINDS;

function bootstrapError(code, message, cause) {
  return new RuntimeError(code, message, {
    kind: ERROR_KINDS.INVALID_INPUT,
    retryable: false,
    cause: cause,
  });
}

/**
 * Import an externally provisioned APS signing key into the generic host vault. The input remains
 * owned by the caller. This function wipes its private working copy; callers must also dispose
 * their source bootstrap in a finally block.
 */
function importPushBootstrap(crypto, bootstrap, nowMs, lifecycle) {
  if (!crypto || typeof crypto.importPrivateKey !== 'function') {
    throw new TypeError('APS bootstrap crypto capability is required.');
  }
  if (!bootstrap || typeof bootstrap !== 'object' || Array.isArray(bootstrap)) {
    throw bootstrapError('APS_BOOTSTRAP_REQUIRED', 'APS bootstrap credentials are required.');
  }
  if (!(bootstrap.certificateDer instanceof Uint8Array) || bootstrap.certificateDer.length === 0
      || !(bootstrap.privateKeyPkcs8 instanceof Uint8Array) || bootstrap.privateKeyPkcs8.length === 0
      || !(bootstrap.token instanceof Uint8Array) || bootstrap.token.length !== 32) {
    throw bootstrapError('APS_BOOTSTRAP_INVALID', 'APS bootstrap credentials are malformed.');
  }
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(nowMs)) {
    throw new TypeError('APS bootstrap clock must return epoch milliseconds.');
  }
  lifecycle = lifecycle || {};
  if (lifecycle.onKeyCreated !== undefined && typeof lifecycle.onKeyCreated !== 'function') {
    throw new TypeError('APS bootstrap key-created callback is invalid.');
  }
  if (lifecycle.onKeyDeleted !== undefined && typeof lifecycle.onKeyDeleted !== 'function') {
    throw new TypeError('APS bootstrap key-deleted callback is invalid.');
  }

  var certificate = new Uint8Array(bootstrap.certificateDer);
  var token = new Uint8Array(bootstrap.token);
  var privateKey = new Uint8Array(bootstrap.privateKeyPkcs8);
  var parsed;
  try {
    try {
      parsed = asn1.parseCertificate(certificate);
    } catch (error) {
      throw bootstrapError('APS_BOOTSTRAP_INVALID', 'APS bootstrap certificate is malformed.', error);
    }
    if (nowMs < parsed.notBefore.epochMilliseconds) {
      throw bootstrapError('APS_BOOTSTRAP_NOT_YET_VALID', 'APS bootstrap certificate is not yet valid.');
    }
    if (nowMs > parsed.notAfter.epochMilliseconds) {
      throw bootstrapError('APS_BOOTSTRAP_EXPIRED', 'APS bootstrap certificate has expired.');
    }
    var keyId;
    try {
      keyId = crypto.importPrivateKey('RSA', privateKey, parsed.subjectPublicKeyInfo, {
        persistence: 'persistent',
      });
    } catch (error) {
      throw bootstrapError('APS_BOOTSTRAP_INVALID', 'APS bootstrap private key could not be imported.', error);
    }
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw bootstrapError('APS_BOOTSTRAP_INVALID', 'APS bootstrap private key could not be imported.');
    }
    var keyRecord = Object.freeze({ id: keyId, purpose: 'aps-signing' });
    try {
      // Stage in the same synchronous call stack as the host import. No HTTP/courier await or
      // artifact publication is allowed to observe an untracked persistent key.
      if (lifecycle.onKeyCreated) lifecycle.onKeyCreated(keyRecord);
    } catch (error) {
      var deleted = false;
      try {
        crypto.deleteKey(keyId);
        deleted = true;
      } catch (_) { /* retain a durable cleanup record when deletion cannot be confirmed */ }
      if (deleted && lifecycle.onKeyDeleted) {
        try { lifecycle.onKeyDeleted(keyId); }
        catch (_) { /* a later session can repeat idempotent deletion and acknowledgement */ }
      }
      throw error;
    }
    return Object.freeze({
      keyId: keyId,
      certificate: certificate,
      token: token,
      keyRecord: keyRecord,
    });
  } finally {
    privateKey.fill(0);
  }
}

module.exports = { importPushBootstrap: importPushBootstrap };
