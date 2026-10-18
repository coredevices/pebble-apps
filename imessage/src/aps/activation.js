'use strict';

var asn1 = require('../codecs/asn1');
var plist = require('../codecs/xml-plist');
var bytes = require('../runtime/bytes');
var runtimeErrors = require('../runtime/errors');
var fairPlayMaterial = require('./legacy-fairplay-material');

var RuntimeError = runtimeErrors.RuntimeError;
var ERROR_KINDS = runtimeErrors.ERROR_KINDS;
var RSA_SHA1_OID = '1.2.840.113549.1.1.5';
var ALBERT_URL = 'https://albert.apple.com/deviceservices/deviceActivation?device=MacOS';
var MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
var MAX_CERTIFICATE_BYTES = 256 * 1024;

function activationError(code, message, kind, retryable, details, cause) {
  return new RuntimeError(code, message, {
    kind: kind,
    retryable: retryable === true,
    details: details,
    cause: cause,
  });
}

function trace(effects, kind) {
  if (!effects || !effects.trace || typeof effects.trace.emit !== 'function') return;
  try { effects.trace.emit(Object.freeze({ kind: kind })); }
  catch (_) { /* diagnostics must never change activation or key cleanup behavior */ }
}

function invalidInput(message, cause) {
  return activationError('APS_ACTIVATION_INVALID_INPUT', message, ERROR_KINDS.INVALID_INPUT, false, undefined, cause);
}

function cryptoError(cause) {
  return activationError('APS_ACTIVATION_CRYPTO_ERROR', 'APS activation cryptography failed.', ERROR_KINDS.CRYPTO, false, undefined, cause);
}

function responseError(message, cause) {
  return activationError('APS_ACTIVATION_RESPONSE_INVALID', message, ERROR_KINDS.TRANSPORT, false, undefined, cause);
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384 || /[\u0000\r\n]/.test(value)) {
    throw invalidInput(name + ' is malformed.');
  }
  return value;
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw invalidInput('APS activation options are missing.');
  var effects = options.effects;
  if (!effects || !effects.http || typeof effects.http.request !== 'function'
      || !effects.clock || typeof effects.clock.now !== 'function') {
    throw invalidInput('APS activation effects are missing.');
  }
  var crypto = options.crypto;
  var methods = ['deleteKey', 'exportPublicKey', 'generateKey', 'importPrivateKey', 'random', 'sign', 'verify'];
  if (!crypto || typeof crypto !== 'object' || methods.some(function (name) { return typeof crypto[name] !== 'function'; })) {
    throw invalidInput('APS activation crypto capability is missing.');
  }
  var mac = options.mac;
  if (!mac || typeof mac !== 'object' || !mac.hardware || typeof mac.hardware !== 'object') {
    throw invalidInput('Normalized Mac configuration is missing.');
  }
  var firstUaPart = requireString(mac.icloudUa, 'Mac iCloud user agent').split(/[\t ]/)[0];
  if (options.onKeyCreated !== undefined && typeof options.onKeyCreated !== 'function') {
    throw invalidInput('APS activation key lifecycle callback is malformed.');
  }
  return Object.freeze({
    effects: effects,
    crypto: crypto,
    onKeyCreated: options.onKeyCreated || null,
    mac: Object.freeze({
      buildVersion: requireString(mac.hardware.osBuildNum, 'Mac build version'),
      productType: requireString(mac.hardware.productName, 'Mac product type'),
      productVersion: requireString(mac.version, 'Mac product version'),
      serialNumber: requireString(mac.hardware.platformSerialNumber, 'Mac serial number'),
      deviceId: requireString(mac.deviceId, 'Mac device ID'),
      userAgent: 'ApplePushService/4.0 ' + firstUaPart,
    }),
  });
}

function uuidV4(randomBytes) {
  bytes.assertBytes(randomBytes, 'activation randomness');
  if (randomBytes.length !== 16) throw cryptoError(new TypeError('Random provider returned the wrong byte length.'));
  var value = new Uint8Array(randomBytes);
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  var hex = bytes.bytesToHex(value).toUpperCase();
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20);
}

function createPushCsr(crypto, keyId) {
  var publicKey = crypto.exportPublicKey(keyId, 'spki');
  var info = asn1.derCertificationRequestInfo({
    subject: [[{ oid: '2.5.4.3', value: 'Client Push Certificate', type: 'utf8' }]],
    subjectPublicKeyInfo: publicKey,
    attributes: [],
  });
  var signature = crypto.sign(keyId, {
    algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw',
  }, info);
  var csr = asn1.derCertificationRequest({
    info: info,
    signatureAlgorithmOid: RSA_SHA1_OID,
    signatureAlgorithmParameters: asn1.derNull(),
    signature: signature,
  });
  return Object.freeze({
    publicKey: new Uint8Array(publicKey),
    pem: bytes.utf8ToBytes(asn1.derToPem('CERTIFICATE REQUEST', csr)),
  });
}

function buildActivationInfo(mac, csrPem, randomness) {
  return plist.encodeXmlPlist({
    ActivationRandomness: randomness,
    ActivationState: 'Unactivated',
    BuildVersion: mac.buildVersion,
    DeviceCertRequest: csrPem,
    DeviceClass: 'MacOS',
    ProductType: mac.productType,
    ProductVersion: mac.productVersion,
    SerialNumber: mac.serialNumber,
    UniqueDeviceID: mac.deviceId.toUpperCase(),
  });
}

function derElementLength(input, offset) {
  if (offset >= input.length || input[offset] !== 0x30 || offset + 2 > input.length) {
    throw new TypeError('FairPlay certificate chain is malformed.');
  }
  var first = input[offset + 1];
  if (first < 0x80) return 2 + first;
  var count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 2 + count > input.length || input[offset + 2] === 0) {
    throw new TypeError('FairPlay certificate chain uses an invalid DER length.');
  }
  var contentLength = 0;
  for (var index = 0; index < count; index += 1) contentLength = contentLength * 256 + input[offset + 2 + index];
  if (contentLength < 128) throw new TypeError('FairPlay certificate chain uses a non-canonical DER length.');
  return 2 + count + contentLength;
}

function parseFairPlayChain(chain) {
  bytes.assertBytes(chain, 'FairPlay certificate chain');
  var certificates = [];
  var offset = 0;
  while (offset < chain.length) {
    if (certificates.length >= 16) throw new TypeError('FairPlay certificate chain is too long.');
    var length = derElementLength(chain, offset);
    if (length > MAX_CERTIFICATE_BYTES || offset + length > chain.length) {
      throw new TypeError('FairPlay certificate chain is truncated.');
    }
    var certificateBytes = chain.slice(offset, offset + length);
    certificates.push(Object.freeze({ bytes: certificateBytes, parsed: asn1.parseCertificate(certificateBytes) }));
    offset += length;
  }
  if (certificates.length < 2) throw new TypeError('FairPlay certificate chain has no issuer.');
  return certificates;
}

function rsaCertificateSpecification(parsed) {
  var oid = parsed.signatureAlgorithm.oid;
  var hash;
  if (oid === '1.2.840.113549.1.1.5') hash = 'sha1';
  else if (oid === '1.2.840.113549.1.1.11') hash = 'sha256';
  else if (oid === '1.2.840.113549.1.1.12') hash = 'sha384';
  else if (oid === '1.2.840.113549.1.1.13') hash = 'sha512';
  else throw new TypeError('Certificate signature algorithm is unsupported.');
  return Object.freeze({ algorithm: 'rsa-pkcs1-v1_5', hash: hash, signatureFormat: 'raw' });
}

function signFairPlay(crypto, activationInfoXml) {
  var material = fairPlayMaterial.loadLegacyFairPlayMaterial();
  var privateKey = material.privateKeyPkcs8;
  var importedKeyId = null;
  var primaryError = null;
  var deleteError = null;
  var result;
  try {
    var chain = parseFairPlayChain(material.certificateChain);
    if (!crypto.verify(
      chain[1].parsed.subjectPublicKeyInfo,
      rsaCertificateSpecification(chain[0].parsed),
      chain[0].parsed.tbsCertificate,
      chain[0].parsed.signature
    )) throw new TypeError('FairPlay leaf certificate signature is invalid.');
    importedKeyId = crypto.importPrivateKey('RSA', privateKey, chain[0].parsed.subjectPublicKeyInfo, {
      persistence: 'session',
    });
    var signature = crypto.sign(importedKeyId, {
      algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw',
    }, activationInfoXml);
    if (!crypto.verify(chain[0].parsed.subjectPublicKeyInfo, {
      algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'raw',
    }, activationInfoXml, signature)) throw new TypeError('FairPlay private key does not match its certificate.');
    result = Object.freeze({
      certificateChain: new Uint8Array(material.certificateChain),
      signature: new Uint8Array(signature),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    privateKey.fill(0);
    if (importedKeyId !== null) {
      try { crypto.deleteKey(importedKeyId); } catch (error) { deleteError = error; }
    }
  }
  if (primaryError) throw primaryError;
  if (deleteError) throw deleteError;
  return result;
}

function formEncode(value) {
  var input = bytes.utf8ToBytes(value);
  var output = '';
  var hex = '0123456789ABCDEF';
  for (var index = 0; index < input.length; index += 1) {
    var octet = input[index];
    if ((octet >= 0x41 && octet <= 0x5a) || (octet >= 0x61 && octet <= 0x7a)
        || (octet >= 0x30 && octet <= 0x39) || octet === 0x2a || octet === 0x2d
        || octet === 0x2e || octet === 0x5f) output += String.fromCharCode(octet);
    else if (octet === 0x20) output += '+';
    else output += '%' + hex[octet >>> 4] + hex[octet & 0x0f];
  }
  return output;
}

function buildAlbertRequest(mac, activationInfoXml, fairPlay) {
  var outer = plist.encodeXmlPlist({
    ActivationInfoComplete: true,
    ActivationInfoXML: activationInfoXml,
    FairPlayCertChain: fairPlay.certificateChain,
    FairPlaySignature: fairPlay.signature,
  });
  var body = bytes.utf8ToBytes('activation-info=' + formEncode(bytes.bytesToUtf8(outer)));
  return Object.freeze({
    method: 'POST',
    url: ALBERT_URL,
    headers: Object.freeze([
      Object.freeze(['user-agent', mac.userAgent]),
      Object.freeze(['content-type', 'application/x-www-form-urlencoded']),
    ]),
    body: body,
  });
}

function validateHttpResponse(response) {
  if (!response || typeof response !== 'object' || !Number.isSafeInteger(response.status)
      || response.status < 100 || response.status > 599 || !(response.body instanceof Uint8Array)
      || response.body.length > MAX_HTTP_BODY_BYTES) {
    throw activationError('APS_ACTIVATION_NETWORK_ERROR', 'APS activation transport returned a malformed response.',
      ERROR_KINDS.TRANSPORT, true);
  }
  if (response.status < 200 || response.status >= 300) {
    throw activationError('APS_ACTIVATION_REJECTED', 'Apple rejected APS activation.', ERROR_KINDS.TRANSPORT,
      response.status >= 500, { httpStatus: response.status });
  }
  return response;
}

function parseAlbertResponse(body, hostPublicKey, nowMs, effects) {
  var text;
  try { text = bytes.bytesToUtf8(body); }
  catch (error) { throw responseError('APS activation response is not valid UTF-8.', error); }
  trace(effects, 'configuration.aps-activation-response-utf8');
  var opening = text.indexOf('<Protocol>');
  var closing = opening === -1 ? -1 : text.indexOf('</Protocol>', opening + 10);
  if (opening === -1 || closing === -1 || text.indexOf('<Protocol>', opening + 10) !== -1) {
    throw responseError('APS activation response has no unambiguous Protocol payload.');
  }
  trace(effects, 'configuration.aps-activation-protocol-found');
  var decoded;
  try {
    decoded = plist.decodeXmlPlist(text.slice(opening + 10, closing), { maxInputBytes: MAX_HTTP_BODY_BYTES });
  } catch (error) {
    throw responseError('APS activation Protocol payload is malformed.', error);
  }
  trace(effects, 'configuration.aps-activation-protocol-decoded');
  var deviceActivation = decoded && decoded['device-activation'];
  if (deviceActivation && typeof deviceActivation === 'object') {
    trace(effects, 'configuration.aps-activation-device-activation-found');
  }
  var activationRecord = deviceActivation && deviceActivation['activation-record'];
  if (activationRecord && typeof activationRecord === 'object') {
    trace(effects, 'configuration.aps-activation-record-found');
  }
  [
    'activation-error', 'error', 'errors', 'message', 'status', 'status-code', 'activation-state',
  ].forEach(function (key) {
    if (decoded && typeof decoded === 'object'
        && Object.prototype.hasOwnProperty.call(decoded, key)) {
      trace(effects, 'configuration.aps-activation-response-field-' + key);
    }
    if (deviceActivation && typeof deviceActivation === 'object'
        && Object.prototype.hasOwnProperty.call(deviceActivation, key)) {
      trace(effects, 'configuration.aps-activation-device-field-' + key);
    }
  });
  var certificatePem = activationRecord && activationRecord.DeviceCertificate;
  if (typeof certificatePem === 'string') {
    trace(effects, 'configuration.aps-activation-certificate-string');
  } else if (certificatePem !== undefined && !(certificatePem instanceof Uint8Array)) {
    trace(effects, 'configuration.aps-activation-certificate-other');
  }
  if (!(certificatePem instanceof Uint8Array) || certificatePem.length === 0
      || certificatePem.length > MAX_CERTIFICATE_BYTES) {
    throw responseError('APS activation response has no valid device certificate.');
  }
  trace(effects, 'configuration.aps-activation-certificate-found');
  var certificate;
  var parsed;
  try {
    certificate = asn1.pemToDer(bytes.bytesToUtf8(certificatePem), 'CERTIFICATE').der;
    parsed = asn1.parseCertificate(certificate, { maxInputBytes: MAX_CERTIFICATE_BYTES });
  } catch (error) {
    throw responseError('APS activation device certificate is malformed.', error);
  }
  trace(effects, 'configuration.aps-activation-certificate-parsed');
  if (!bytes.bytesEqual(parsed.subjectPublicKeyInfo, hostPublicKey)) {
    throw responseError('APS activation certificate does not match the generated host key.');
  }
  trace(effects, 'configuration.aps-activation-certificate-key-matched');
  if (!Number.isSafeInteger(nowMs) || nowMs < parsed.notBefore.epochMilliseconds
      || nowMs > parsed.notAfter.epochMilliseconds) {
    throw responseError('APS activation certificate is outside its validity period.');
  }
  trace(effects, 'configuration.aps-activation-certificate-valid');
  // Albert is reached through the host's authenticated HTTPS transport. RustPush accepts the
  // returned certificate without assuming that its issuer is the FairPlay attestation issuer.
  // Bind it to our newly generated key and enforce its validity window here; courier TLS then
  // proves possession of that private key.
  return new Uint8Array(certificate);
}

/**
 * Create and activate a persistent APNs host identity from a normalized Mac configuration.
 * The returned certificate is DER and the private key remains behind the opaque generic key ID.
 *
 * @param {{effects: object, crypto: object, mac: object}} options
 * @returns {Promise<{keyId: string, certificate: Uint8Array, keyRecord: {id: string, purpose: string}}>}
 */
async function activatePushIdentity(options) {
  var validated = validateOptions(options);
  trace(validated.effects, 'configuration.aps-activation-start');
  var keyId;
  try {
    keyId = validated.crypto.generateKey({
      algorithm: 'rsa', modulusLength: 1024, usages: ['sign'], persistence: 'persistent',
    });
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw new TypeError('Key generation returned no opaque key ID.');
    }
  } catch (error) {
    throw cryptoError(error);
  }
  trace(validated.effects, 'configuration.aps-activation-key-generated');
  var completed = false;
  try {
    var keyRecord = Object.freeze({ id: keyId, purpose: 'aps-signing' });
    // Persistent host keys must become durably discoverable before CSR construction or the first
    // network await. The coordinator stages this record as a cleanup obligation and only promotes
    // it when the certificate and initial courier token are committed atomically.
    if (validated.onKeyCreated) validated.onKeyCreated(keyRecord);
    var csr;
    var randomness;
    var fairPlay;
    try {
      csr = createPushCsr(validated.crypto, keyId);
      trace(validated.effects, 'configuration.aps-activation-csr-created');
      randomness = uuidV4(validated.crypto.random(16));
      var activationInfoXml = buildActivationInfo(validated.mac, csr.pem, randomness);
      fairPlay = signFairPlay(validated.crypto, activationInfoXml);
      trace(validated.effects, 'configuration.aps-activation-attestation-created');
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw cryptoError(error);
    }
    var request = buildAlbertRequest(validated.mac, activationInfoXml, fairPlay);
    var response;
    try { response = validateHttpResponse(await validated.effects.http.request(request)); }
    catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw activationError('APS_ACTIVATION_NETWORK_ERROR', 'APS activation request failed.',
        ERROR_KINDS.TRANSPORT, true, undefined, error);
    }
    trace(validated.effects, 'configuration.aps-activation-http-' + response.status + '-' + response.body.length);
    var nowMs;
    try { nowMs = validated.effects.clock.now(); }
    catch (error) { throw invalidInput('APS activation clock failed.', error); }
    var certificate = parseAlbertResponse(response.body, csr.publicKey, nowMs, validated.effects);
    completed = true;
    trace(validated.effects, 'configuration.aps-activation-complete');
    return Object.freeze({
      keyId: keyId,
      certificate: certificate,
      keyRecord: keyRecord,
    });
  } finally {
    if (!completed) {
      try { validated.crypto.deleteKey(keyId); } catch (_) { /* Preserve the activation failure. */ }
    }
  }
}

module.exports = {
  ALBERT_URL: ALBERT_URL,
  activatePushIdentity: activatePushIdentity,
};
