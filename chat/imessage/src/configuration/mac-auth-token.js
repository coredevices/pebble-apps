'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var DEFAULT_VERSION = '13.6.4';
var DEFAULT_PROTOCOL_VERSION = 1660;
var DEFAULT_ICLOUD_UA = 'com.apple.iCloudHelper/282 CFNetwork/1408.0.4 Darwin/22.5.0';
var DEFAULT_AOSKIT_VERSION = 'com.apple.AOSKit/282 (com.apple.accountsd/113)';
var DEFAULT_AKD_UA = 'akd/1.0 CFNetwork/1494.0.7 Darwin/23.4.0';
var DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
var MAX_TOKEN_BYTES = 4 * 1024 * 1024;
var MAX_BINARY_BYTES = 1024 * 1024;
var MAX_PUSH_CERTIFICATE_BYTES = 256 * 1024;
var MAX_PUSH_PRIVATE_KEY_BYTES = 256 * 1024;

function tokenError(message) {
  return new RuntimeError('INVALID_MAC_TOKEN', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

function own(value, name) { return Object.prototype.hasOwnProperty.call(value, name); }

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw tokenError(name + ' is malformed.');
  }
  return value;
}

function aliased(object, camel, snake) {
  return own(object, camel) ? object[camel] : own(object, snake) ? object[snake] : undefined;
}

function strictAliased(object, camel, snake, name) {
  if (camel !== snake && own(object, camel) && own(object, snake)) {
    throw tokenError('Mac authentication token has ambiguous ' + name + '.');
  }
  return aliased(object, camel, snake);
}

function assertAllowedFields(object, allowed, name) {
  var unexpected = Object.keys(object).some(function (field) { return allowed.indexOf(field) === -1; });
  if (unexpected) throw tokenError('Mac authentication token has unexpected ' + name + ' fields.');
}

function tokenString(value, name, required) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384 || /[\u0000\r\n]/.test(value)) {
    throw tokenError('Mac authentication token has invalid ' + name + '.');
  }
  return value;
}

function tokenBytes(value, name, required, exactLength) {
  if (value === undefined && !required) return new Uint8Array(0);
  var decoded;
  if (typeof value === 'string') {
    try { decoded = bytes.base64ToBytes(value); }
    catch (_) { throw tokenError('Mac authentication token has invalid ' + name + '.'); }
  } else if (Array.isArray(value)) {
    if (value.length > MAX_BINARY_BYTES || value.some(function (item) {
      return !Number.isInteger(item) || item < 0 || item > 255;
    })) throw tokenError('Mac authentication token has invalid ' + name + '.');
    decoded = new Uint8Array(value);
  } else {
    throw tokenError('Mac authentication token has invalid ' + name + '.');
  }
  if (decoded.length > MAX_BINARY_BYTES || (exactLength !== undefined && decoded.length !== exactLength)) {
    decoded.fill(0);
    throw tokenError('Mac authentication token has invalid ' + name + '.');
  }
  return decoded;
}

function decodeTokenText(input) {
  if (typeof input !== 'string') throw tokenError('Mac authentication token must be text.');
  var trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_TOKEN_BYTES * 2) throw tokenError('Mac authentication token is empty or too large.');
  if (trimmed[0] === '{') return trimmed;
  var compact = trimmed.replace(/[\t\n\r ]/g, '');
  var decoded;
  try { decoded = bytes.base64ToBytes(compact); }
  catch (_) { throw tokenError('Mac authentication token is not valid base64 JSON.'); }
  if (decoded.length > MAX_TOKEN_BYTES) throw tokenError('Mac authentication token is too large.');
  try { return bytes.bytesToUtf8(decoded); }
  catch (_) { throw tokenError('Mac authentication token JSON is not valid UTF-8.'); }
}

function parsePushBootstrap(root) {
  var value = strictAliased(root, 'pushBootstrap', 'push_bootstrap', 'pushBootstrap');
  if (value === undefined) return null;
  var bootstrap = requireObject(value, 'Mac authentication token pushBootstrap');
  assertAllowedFields(bootstrap, [
    'certificateDer', 'certificate_der', 'privateKeyPkcs8', 'private_key_pkcs8', 'token',
  ], 'pushBootstrap');

  var certificateDer = tokenBytes(
    strictAliased(bootstrap, 'certificateDer', 'certificate_der', 'pushBootstrap certificateDer'),
    'pushBootstrap certificateDer', true
  );
  var privateKeyPkcs8 = tokenBytes(
    strictAliased(bootstrap, 'privateKeyPkcs8', 'private_key_pkcs8', 'pushBootstrap privateKeyPkcs8'),
    'pushBootstrap privateKeyPkcs8', true
  );
  var token;
  try {
    token = tokenBytes(bootstrap.token, 'pushBootstrap token', true, 32);
  } catch (error) {
    privateKeyPkcs8.fill(0);
    throw error;
  }
  if (certificateDer.length === 0 || certificateDer.length > MAX_PUSH_CERTIFICATE_BYTES) {
    certificateDer.fill(0);
    privateKeyPkcs8.fill(0);
    token.fill(0);
    throw tokenError('Mac authentication token has invalid pushBootstrap certificateDer.');
  }
  if (privateKeyPkcs8.length === 0 || privateKeyPkcs8.length > MAX_PUSH_PRIVATE_KEY_BYTES) {
    certificateDer.fill(0);
    privateKeyPkcs8.fill(0);
    token.fill(0);
    throw tokenError('Mac authentication token has invalid pushBootstrap privateKeyPkcs8.');
  }
  return Object.freeze({
    certificateDer: certificateDer,
    privateKeyPkcs8: privateKeyPkcs8,
    token: token,
  });
}

/**
 * Zero the owned transient APS private-key bytes after a bootstrap consumer imports them.
 * Safe to call more than once and with a missing bootstrap.
 *
 * @param {{privateKeyPkcs8?: Uint8Array}|null|undefined} bootstrap
 */
function disposePushBootstrap(bootstrap) {
  if (bootstrap && bootstrap.privateKeyPkcs8 instanceof Uint8Array) {
    bootstrap.privateKeyPkcs8.fill(0);
  }
}

/**
 * Remove imported legacy validation bytes from a parsed token while retaining the hardware and
 * optional one-shot APS bootstrap needed by the current configuration attempt.
 *
 * @param {object} token
 * @returns {object}
 */
function stripLegacyValidationData(token) {
  if (!token || typeof token !== 'object') throw new TypeError('Mac authentication token is required.');
  if (token.validationData instanceof Uint8Array) token.validationData.fill(0);
  return Object.freeze({
    hardware: token.hardware,
    validationData: null,
    version: token.version,
    protocolVersion: token.protocolVersion,
    deviceId: token.deviceId,
    icloudUa: token.icloudUa,
    aoskitVersion: token.aoskitVersion,
    udid: token.udid,
    pushBootstrap: token.pushBootstrap,
  });
}

/** Zero every transient secret owned by a parsed Mac authentication token. */
function disposeMacAuthToken(token) {
  if (!token || typeof token !== 'object') return;
  if (token.validationData instanceof Uint8Array) token.validationData.fill(0);
  disposePushBootstrap(token.pushBootstrap);
}

function parseMacAuthToken(input) {
  var parsed;
  try { parsed = JSON.parse(decodeTokenText(input)); }
  catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw tokenError('Mac authentication token is not valid JSON.');
  }
  var root = requireObject(parsed, 'Mac authentication token');
  var hardware = requireObject(own(root, 'inner') ? root.inner : root.hardware, 'Mac authentication token hardware');
  function requiredString(camel, snake) { return tokenString(aliased(hardware, camel, snake), camel, true); }
  function optionalBytes(camel, snake) { return tokenBytes(aliased(hardware, camel, snake), camel, false); }
  var validationValue = strictAliased(root, 'validationData', 'validation_data', 'validationData');
  var validationData = validationValue === undefined
    ? null
    : tokenBytes(validationValue, 'validationData', true);
  if (validationData !== null && validationData.length <= 100) {
    throw tokenError('Mac validationData is unexpectedly short.');
  }
  var protocolValue = aliased(root, 'protocolVersion', 'protocol_version');
  if (protocolValue !== undefined && (!Number.isSafeInteger(protocolValue) || protocolValue < 1 || protocolValue > 0xffffffff)) {
    throw tokenError('Mac authentication token has invalid protocolVersion.');
  }
  var platformUuid = requiredString('platformUuid', 'platform_uuid');
  var normalizedDeviceId = platformUuid.toUpperCase();
  var normalizedHardware = Object.freeze({
    productName: requiredString('productName', 'product_name'),
    ioMacAddress: tokenBytes(aliased(hardware, 'ioMacAddress', 'io_mac_address'), 'ioMacAddress', true, 6),
    platformSerialNumber: requiredString('platformSerialNumber', 'platform_serial_number'),
    platformUuid: platformUuid,
    rootDiskUuid: requiredString('rootDiskUuid', 'root_disk_uuid'),
    boardId: requiredString('boardId', 'board_id'),
    osBuildNum: requiredString('osBuildNum', 'os_build_num'),
    platformSerialNumberEnc: optionalBytes('platformSerialNumberEnc', 'platform_serial_number_enc'),
    platformUuidEnc: optionalBytes('platformUuidEnc', 'platform_uuid_enc'),
    rootDiskUuidEnc: optionalBytes('rootDiskUuidEnc', 'root_disk_uuid_enc'),
    rom: tokenBytes(aliased(hardware, 'rom', 'rom'), 'rom', true),
    romEnc: optionalBytes('romEnc', 'rom_enc'),
    mlb: requiredString('mlb', 'mlb'),
    mlbEnc: optionalBytes('mlbEnc', 'mlb_enc'),
  });
  if (normalizedHardware.rom.length === 0) throw tokenError('Mac authentication token has invalid rom.');
  var pushBootstrap = parsePushBootstrap(root);
  return Object.freeze({
    hardware: normalizedHardware,
    validationData: validationData,
    version: tokenString(aliased(root, 'version', 'version'), 'version', false) || DEFAULT_VERSION,
    protocolVersion: protocolValue === undefined ? DEFAULT_PROTOCOL_VERSION : protocolValue,
    // ExtractKey's root device_id is informational. Corten deliberately keys both AuthKit
    // identifiers from the exported platform UUID, so do the same even when an older export
    // carries a different root value.
    deviceId: normalizedDeviceId,
    icloudUa: tokenString(aliased(root, 'icloudUa', 'icloud_ua'), 'icloudUa', false) || DEFAULT_ICLOUD_UA,
    aoskitVersion: tokenString(aliased(root, 'aoskitVersion', 'aoskit_version'), 'aoskitVersion', false) || DEFAULT_AOSKIT_VERSION,
    udid: normalizedDeviceId,
    pushBootstrap: pushBootstrap,
  });
}

/**
 * Fail before Apple sign-in if an Intel ExtractKey export cannot drive the portable NAC image.
 * Some ExtractKey builds can emit a plaintext-only variant; Corten can use that only while
 * running on the source Mac, whereas the mobile interpreter requires all five encrypted values.
 */
function assertPortableNacCompatible(token) {
  if (!token || typeof token !== 'object' || !token.hardware) {
    throw tokenError('Mac authentication token hardware is missing.');
  }
  var encryptedFields = [
    ['platformSerialNumberEnc', 'encrypted serial number'],
    ['platformUuidEnc', 'encrypted platform UUID'],
    ['rootDiskUuidEnc', 'encrypted root disk UUID'],
    ['romEnc', 'encrypted ROM'],
    ['mlbEnc', 'encrypted MLB'],
  ];
  var missing = encryptedFields.filter(function (entry) {
    return !(token.hardware[entry[0]] instanceof Uint8Array) || token.hardware[entry[0]].length !== 17;
  }).map(function (entry) { return entry[1]; });
  if (missing.length !== 0) {
    throw new RuntimeError(
      'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED',
      'This ExtractKey activation cannot run on mobile because it is missing the complete encrypted Mac hardware export.',
      { kind: ERROR_KINDS.INVALID_INPUT, details: { missingFields: missing } }
    );
  }
  return token;
}

function encodedHardware(hardware) {
  return Object.freeze({
    productName: hardware.productName,
    ioMacAddress: bytes.bytesToBase64(hardware.ioMacAddress),
    platformSerialNumber: hardware.platformSerialNumber,
    platformUuid: hardware.platformUuid,
    rootDiskUuid: hardware.rootDiskUuid,
    boardId: hardware.boardId,
    osBuildNum: hardware.osBuildNum,
    platformSerialNumberEnc: bytes.bytesToBase64(hardware.platformSerialNumberEnc),
    platformUuidEnc: bytes.bytesToBase64(hardware.platformUuidEnc),
    rootDiskUuidEnc: bytes.bytesToBase64(hardware.rootDiskUuidEnc),
    rom: bytes.bytesToBase64(hardware.rom),
    romEnc: bytes.bytesToBase64(hardware.romEnc),
    mlb: hardware.mlb,
    mlbEnc: bytes.bytesToBase64(hardware.mlbEnc),
  });
}

function macAuthArtifact(token) {
  return Object.freeze({
    version: 1,
    hardware: encodedHardware(token.hardware),
    // The legacy token field is accepted for import compatibility only. Fresh validation data is
    // generated per request and must never enter durable configuration state.
    validationData: null,
    productVersion: token.version,
    protocolVersion: token.protocolVersion,
    deviceId: token.deviceId,
    icloudUa: token.icloudUa,
    aoskitVersion: token.aoskitVersion,
    udid: token.udid,
  });
}

function restoreMacAuthArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1) {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization state is malformed.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
  var expected = ['version', 'hardware', 'validationData', 'productVersion', 'protocolVersion', 'deviceId', 'icloudUa', 'aoskitVersion', 'udid'].sort();
  var actual = Object.keys(artifact).sort();
  if (actual.length !== expected.length || actual.some(function (key, index) { return key !== expected[index]; })) {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization state has unexpected fields.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
  var expectedHardware = [
    'productName', 'ioMacAddress', 'platformSerialNumber', 'platformUuid', 'rootDiskUuid',
    'boardId', 'osBuildNum', 'platformSerialNumberEnc', 'platformUuidEnc',
    'rootDiskUuidEnc', 'rom', 'romEnc', 'mlb', 'mlbEnc',
  ].sort();
  if (!artifact.hardware || typeof artifact.hardware !== 'object' || Array.isArray(artifact.hardware)) {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization hardware is malformed.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
  var actualHardware = Object.keys(artifact.hardware).sort();
  if (actualHardware.length !== expectedHardware.length || actualHardware.some(function (key, index) {
    return key !== expectedHardware[index];
  })) {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization hardware has unexpected fields.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
  if (artifact.validationData !== null && typeof artifact.validationData !== 'string') {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization state is malformed.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
  var source = {
    inner: artifact.hardware,
    version: artifact.productVersion,
    protocolVersion: artifact.protocolVersion,
    deviceId: artifact.deviceId,
    icloudUa: artifact.icloudUa,
    aoskitVersion: artifact.aoskitVersion,
    udid: artifact.udid,
  };
  try { return parseMacAuthToken(JSON.stringify(source)); }
  catch (_) {
    throw new RuntimeError('INVALID_CONFIGURATION_STATE', 'Persisted Mac authorization state is malformed.', {
      kind: ERROR_KINDS.STORAGE,
    });
  }
}

function lowercaseHex(value) { return bytes.bytesToHex(value); }

function mmeClientInfo(token, item) {
  return '<' + token.hardware.productName + '> <macOS;' + token.version + ';' + token.hardware.osBuildNum + '> <' + item + '>';
}

function normalUserAgent(token, item) {
  return item + ' ' + token.icloudUa.split(/\s/)[0];
}

function versionUserAgent(token) {
  return '[macOS,' + token.version + ',' + token.hardware.osBuildNum + ',' + token.hardware.productName + ']';
}

function privateDeviceData(token, nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 978307200000) {
    throw tokenError('Mac authorization clock is invalid.');
  }
  return Object.freeze({
    ap: '0',
    d: ((nowMs / 1000) - 978307200).toFixed(6),
    dt: 1,
    gt: '0',
    h: '1',
    m: '0',
    p: '0',
    pb: token.hardware.osBuildNum,
    pn: 'macOS',
    pv: token.version,
    s: '0',
    t: '0',
    u: token.deviceId.toUpperCase(),
    v: '1',
  });
}

function deriveMacConfiguration(token, nowMs, pushToken) {
  var hardwareHeaders = Object.freeze([
    Object.freeze(['X-Apple-I-MLB', token.hardware.mlb]),
    Object.freeze(['X-Apple-I-ROM', lowercaseHex(token.hardware.rom)]),
    Object.freeze(['X-Apple-I-SRL-NO', token.hardware.platformSerialNumber]),
  ]);
  var accountClientInfo = {
    akContextType: 'imessage',
    clientAppName: 'Messages',
    clientBundleId: 'com.apple.MobileSMS',
    mmeClientInfoAkd: mmeClientInfo(token, 'com.apple.AuthKit/1 (com.apple.akd/1.0)'),
    mmeClientInfo: mmeClientInfo(token, 'com.apple.AuthKit/1 (com.apple.MobileSMS/1262.500.151.1.2)'),
    akdUserAgent: DEFAULT_AKD_UA,
    browserUserAgent: DEFAULT_BROWSER_UA,
    hardwareHeaders: hardwareHeaders,
  };
  if (pushToken !== undefined) {
    bytes.assertBytes(pushToken, 'push token');
    if (pushToken.length !== 32) throw tokenError('Push token is malformed.');
    accountClientInfo.pushToken = bytes.bytesToHex(pushToken).toUpperCase();
  }
  return Object.freeze({
    anisetteClientInfo: Object.freeze({
      akdUserAgent: DEFAULT_AKD_UA,
      mmeClientInfo: mmeClientInfo(token, 'com.apple.AuthKit/1 (com.apple.akd/1.0)'),
      hardwareHeaders: hardwareHeaders,
    }),
    accountClientInfo: Object.freeze(accountClientInfo),
    delegateConfig: Object.freeze({
      userAgent: normalUserAgent(token, 'com.apple.iCloudHelper/282'),
      mmeClientInfo: mmeClientInfo(token, token.aoskitVersion),
      timezone: 'America/New_York',
    }),
    ids: Object.freeze({
      protocolVersion: token.protocolVersion,
      userAgent: versionUserAgent(token),
      registrationMetadata: Object.freeze({
        deviceName: 'Mac-' + token.hardware.platformSerialNumber,
        hardwareVersion: token.hardware.productName,
        osVersion: 'macOS,' + token.version + ',' + token.hardware.osBuildNum,
        softwareVersion: token.hardware.osBuildNum,
        privateDeviceData: privateDeviceData(token, nowMs),
      }),
    }),
  });
}

module.exports = {
  DEFAULT_AOSKIT_VERSION: DEFAULT_AOSKIT_VERSION,
  DEFAULT_ICLOUD_UA: DEFAULT_ICLOUD_UA,
  DEFAULT_PROTOCOL_VERSION: DEFAULT_PROTOCOL_VERSION,
  DEFAULT_VERSION: DEFAULT_VERSION,
  assertPortableNacCompatible: assertPortableNacCompatible,
  deriveMacConfiguration: deriveMacConfiguration,
  disposeMacAuthToken: disposeMacAuthToken,
  disposePushBootstrap: disposePushBootstrap,
  macAuthArtifact: macAuthArtifact,
  parseMacAuthToken: parseMacAuthToken,
  restoreMacAuthArtifact: restoreMacAuthArtifact,
  stripLegacyValidationData: stripLegacyValidationData,
};
