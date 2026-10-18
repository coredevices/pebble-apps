'use strict';

var asn1 = require('../codecs/asn1');
var gzipCodec = require('../codecs/gzip');
var plist = require('../codecs/xml-plist');
var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var appleTrust = require('../apple/server-trust');

var APPLE_AUTH_BAG_KEY = 'id-authenticate-ds-id';
var RSA_SHA1_OID = '1.2.840.113549.1.1.5';

function idsError(code, message, kind, details) {
  return new RuntimeError(code, message, { kind: kind || ERROR_KINDS.INVALID_INPUT, details: details });
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384 || /[\u0000\r\n]/.test(value)) {
    throw idsError('IDS_PROTOCOL_ERROR', name + ' is malformed.');
  }
  return value;
}

function requireCrypto(crypto) {
  var methods = ['deleteKey', 'digest', 'exportPublicKey', 'generateKey', 'sign'];
  if (!crypto || typeof crypto !== 'object') throw new TypeError('IDS authentication crypto is required.');
  methods.forEach(function (method) {
    if (typeof crypto[method] !== 'function') throw new TypeError('IDS authentication crypto is missing ' + method + '().');
  });
}

function createAuthenticationCsr(crypto, keyId, userId) {
  requireCrypto(crypto);
  requireString(keyId, 'Authentication key ID');
  userId = requireString(userId, 'IDS user ID');
  var commonName = bytes.bytesToHex(crypto.digest('sha1', bytes.utf8ToBytes(userId))).toUpperCase();
  var publicKey = crypto.exportPublicKey(keyId, 'spki');
  var info = asn1.derCertificationRequestInfo({
    subject: [[{ oid: '2.5.4.3', value: commonName, type: 'utf8' }]],
    subjectPublicKeyInfo: publicKey,
    attributes: [],
  });
  var signature = crypto.sign(keyId, {
    algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'der',
  }, info);
  return asn1.derCertificationRequest({
    info: info,
    signatureAlgorithmOid: RSA_SHA1_OID,
    signatureAlgorithmParameters: asn1.derNull(),
    signature: signature,
  });
}

function buildAuthenticationRequest(options) {
  if (!options || typeof options !== 'object') throw idsError('IDS_PROTOCOL_ERROR', 'Authentication options are missing.');
  var endpoint = requireString(options.endpoint, 'IDS authentication endpoint');
  var userId = requireString(options.userId, 'IDS user ID');
  var authToken = requireString(options.authToken, 'IDS authentication token');
  var protocolVersion = options.protocolVersion;
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw idsError('IDS_PROTOCOL_ERROR', 'IDS protocol version is malformed.');
  }
  bytes.assertBytes(options.csr, 'IDS authentication CSR');
  var body = gzipCodec.gzip(plist.encodeXmlPlist({
    'authentication-data': { 'auth-token': authToken },
    csr: options.csr,
    'realm-user-id': userId,
  }));
  return Object.freeze({
    method: 'POST',
    url: endpoint,
    headers: Object.freeze([
      Object.freeze(['user-agent', 'com.apple.invitation-registration ' + requireString(options.userAgent, 'IDS user agent')]),
      Object.freeze(['x-protocol-version', String(protocolVersion)]),
      Object.freeze(['content-encoding', 'gzip']),
    ]),
    body: body,
    bagKey: APPLE_AUTH_BAG_KEY,
    trustAnchors: Object.freeze(appleTrust.appleServerTrustAnchors()),
  });
}

function parseAuthenticationResponse(body) {
  bytes.assertBytes(body, 'IDS authentication response');
  var response;
  try { response = plist.decodeXmlPlist(body, { maxInputBytes: 4 * 1024 * 1024 }); }
  catch (_) { throw idsError('IDS_PROTOCOL_ERROR', 'IDS authentication response is not a valid property list.'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)
      || !Number.isSafeInteger(response.status)) {
    throw idsError('IDS_PROTOCOL_ERROR', 'IDS authentication response is malformed.');
  }
  if (response.status !== 0) {
    throw idsError('IDS_AUTHENTICATION_FAILED', 'IDS authentication was rejected.', ERROR_KINDS.INVALID_INPUT, {
      serverCode: response.status,
    });
  }
  if (!(response.cert instanceof Uint8Array) || response.cert.length === 0 || response.cert.length > 1024 * 1024) {
    throw idsError('IDS_PROTOCOL_ERROR', 'IDS authentication certificate is malformed.');
  }
  try { asn1.parseCertificate(response.cert, { maxInputBytes: 1024 * 1024 }); }
  catch (_) { throw idsError('IDS_PROTOCOL_ERROR', 'IDS authentication certificate is not valid DER.'); }
  return Object.freeze({ certificate: new Uint8Array(response.cert) });
}

function validateHttpResponse(response) {
  if (!response || typeof response !== 'object' || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array)) {
    throw idsError('IDS_NETWORK_ERROR', 'IDS authentication transport returned a malformed response.', ERROR_KINDS.TRANSPORT);
  }
  if (response.status < 200 || response.status >= 300) {
    throw idsError('IDS_AUTHENTICATION_FAILED', 'IDS authentication request failed.', ERROR_KINDS.TRANSPORT, {
      httpStatus: response.status,
    });
  }
  return response;
}

/** Exchange the Apple account delegate token for an IDS authentication certificate. */
async function authenticateApple(options) {
  if (!options || !options.effects || !options.effects.http || typeof options.effects.http.request !== 'function') {
    throw idsError('IDS_PROTOCOL_ERROR', 'IDS HTTP effects are missing.');
  }
  requireCrypto(options.crypto);
  if (options.onKeyCreated !== undefined && typeof options.onKeyCreated !== 'function') {
    throw new TypeError('IDS authentication key-created callback is invalid.');
  }
  if (options.onKeyDeleted !== undefined && typeof options.onKeyDeleted !== 'function') {
    throw new TypeError('IDS authentication key-deleted callback is invalid.');
  }
  var userId = requireString(options.profileId, 'IDS profile identifier');
  var keyId = options.crypto.generateKey({
    algorithm: 'rsa', modulusLength: 2048, usages: ['sign'], persistence: 'persistent',
  });
  var keyRecord = Object.freeze({ id: keyId, purpose: 'ids-authentication' });
  var completed = false;
  try {
    // The opaque persistent key must be recoverable before CSR construction or the first HTTP
    // await. The coordinator promotes this cleanup obligation with the certificate artifact.
    if (options.onKeyCreated) options.onKeyCreated(keyRecord);
    var csr = createAuthenticationCsr(options.crypto, keyId, userId);
    var request = buildAuthenticationRequest({
      endpoint: options.endpoint,
      userId: userId,
      authToken: options.authToken,
      protocolVersion: options.protocolVersion,
      userAgent: options.userAgent,
      csr: csr,
    });
    var response;
    try { response = validateHttpResponse(await options.effects.http.request(request)); }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw idsError('IDS_NETWORK_ERROR', 'IDS authentication request failed.', ERROR_KINDS.TRANSPORT);
    }
    var parsed = parseAuthenticationResponse(response.body);
    var artifact = Object.freeze({
      version: 1,
      userId: userId,
      userType: 'apple',
      protocolVersion: options.protocolVersion,
      keyId: keyId,
      certificate: bytes.bytesToBase64(parsed.certificate),
    });
    completed = true;
    return Object.freeze({
      userId: userId,
      userType: 'apple',
      protocolVersion: options.protocolVersion,
      keyId: keyId,
      certificate: parsed.certificate,
      artifact: artifact,
      keyRecord: keyRecord,
    });
  } finally {
    if (!completed) {
      var deleted = false;
      try {
        options.crypto.deleteKey(keyId);
        deleted = true;
      } catch (_) { /* preserve the protocol or network failure */ }
      if (deleted && options.onKeyDeleted) {
        try { options.onKeyDeleted(keyId); }
        catch (_) { /* a later session can repeat idempotent deletion and acknowledgement */ }
      }
    }
  }
}

function restoreAuthenticationArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1 || artifact.userType !== 'apple') {
    throw new TypeError('Persisted IDS authentication artifact is unsupported.');
  }
  var expected = ['version', 'userId', 'userType', 'protocolVersion', 'keyId', 'certificate'].sort();
  var actual = Object.keys(artifact).sort();
  if (actual.length !== expected.length || actual.some(function (key, index) { return key !== expected[index]; })) {
    throw new TypeError('Persisted IDS authentication artifact contains unexpected fields.');
  }
  var certificate = bytes.base64ToBytes(requireString(artifact.certificate, 'Persisted authentication certificate'));
  try { asn1.parseCertificate(certificate); }
  catch (_) { throw new TypeError('Persisted IDS authentication certificate is not valid DER.'); }
  if (!Number.isSafeInteger(artifact.protocolVersion) || artifact.protocolVersion < 1) {
    throw new TypeError('Persisted IDS protocol version is malformed.');
  }
  return Object.freeze({
    userId: requireString(artifact.userId, 'Persisted IDS user ID'),
    userType: 'apple',
    protocolVersion: artifact.protocolVersion,
    keyId: requireString(artifact.keyId, 'Persisted IDS authentication key ID'),
    certificate: certificate,
    artifact: Object.freeze(Object.assign({}, artifact)),
  });
}

module.exports = {
  APPLE_AUTH_BAG_KEY: APPLE_AUTH_BAG_KEY,
  authenticateApple: authenticateApple,
  buildAuthenticationRequest: buildAuthenticationRequest,
  createAuthenticationCsr: createAuthenticationCsr,
  parseAuthenticationResponse: parseAuthenticationResponse,
  restoreAuthenticationArtifact: restoreAuthenticationArtifact,
};
