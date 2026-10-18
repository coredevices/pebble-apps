'use strict';

var SCHEMA_VERSION = 1;
var MAX_IMAGE_BYTES = 8 * 1024 * 1024;
var MAX_PROTOCOL_BYTES = 1024 * 1024;
var MAX_RANDOM_WORDS = 4096;
var CORTEN_COMMIT = '501403fcbe8802cc427e9ccab3573c5367508fdf';
var IMAGE_SHA1 = 'e1181ccad82e6629d52c6a006645ad87ee59bd13';
var IMAGE_SHA256 = '74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9';
var SLICE_SHA256 = '7f225430438171b2d460cd953fe1110a2d6699e6d0d944780471ef58fd075d9f';
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
var SHA256_PATTERN = /^[0-9a-f]{64}$/;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

var SYNTHETIC_HARDWARE = Object.freeze({
  productName: 'SyntheticMac1,1',
  ioMacAddress: Object.freeze([2, 0, 0, 0, 0, 1]),
  platformSerialNumber: 'SYNTHETIC0001',
  platformUuid: '00000000-0000-4000-8000-000000000001',
  rootDiskUuid: '00000000-0000-4000-8000-000000000002',
  boardId: 'Synthetic-Board',
  osBuildNum: '00A000',
  platformSerialNumberEnc: Object.freeze(new Array(17).fill(0)),
  platformUuidEnc: Object.freeze(new Array(17).fill(0)),
  rootDiskUuidEnc: Object.freeze(new Array(17).fill(0)),
  rom: Object.freeze([2, 0, 0, 0, 0, 1]),
  romEnc: Object.freeze(new Array(17).fill(0)),
  mlb: 'SYNTHETICMLB00001',
  mlbEnc: Object.freeze(new Array(17).fill(0)),
});

function fail(path, message) {
  var error = new Error('Invalid Android NAC parity input at ' + path + ': ' + message);
  error.code = 'NAC_PARITY_INPUT_INVALID';
  throw error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) fail(path, 'expected object');
  var actual = Object.keys(value).sort();
  expected = expected.slice().sort();
  if (actual.length !== expected.length || actual.some(function (key, index) {
    return key !== expected[index];
  })) fail(path, 'unexpected or missing field');
}

function requireString(value, pattern, path) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, 'invalid string');
}

function base64Length(value, path, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
      || !BASE64_PATTERN.test(value)) fail(path, 'expected non-empty canonical padded base64');
  var padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  var length = (value.length / 4) * 3 - padding;
  if (length < 1 || length > maximum) fail(path, 'decoded byte length is outside bounds');
  return length;
}

function hardwareString(value, path, uuid) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
      || /[\u0000-\u001f\u007f]/.test(value) || (uuid && !UUID_PATTERN.test(value))) {
    fail(path, uuid ? 'expected canonical UUID' : 'expected bounded hardware string');
  }
}

function hardwareBytes(value, length, path) {
  if (!Array.isArray(value) || value.length !== length || value.some(function (byte) {
    return !Number.isInteger(byte) || byte < 0 || byte > 255;
  })) fail(path, 'expected exactly ' + length + ' bytes');
}

function validateHardware(hardware) {
  exactKeys(hardware, Object.keys(SYNTHETIC_HARDWARE), '$.vector.hardware');
  ['productName', 'platformSerialNumber', 'boardId', 'osBuildNum', 'mlb'].forEach(function (name) {
    hardwareString(hardware[name], '$.vector.hardware.' + name, false);
  });
  ['platformUuid', 'rootDiskUuid'].forEach(function (name) {
    hardwareString(hardware[name], '$.vector.hardware.' + name, true);
  });
  hardwareBytes(hardware.ioMacAddress, 6, '$.vector.hardware.ioMacAddress');
  hardwareBytes(hardware.rom, 6, '$.vector.hardware.rom');
  ['platformSerialNumberEnc', 'platformUuidEnc', 'rootDiskUuidEnc', 'romEnc', 'mlbEnc']
    .forEach(function (name) {
      hardwareBytes(hardware[name], 17, '$.vector.hardware.' + name);
    });
}

function validateExpected(value, path) {
  exactKeys(value, ['base64', 'length', 'sha256'], path);
  var length = base64Length(value.base64, path + '.base64', MAX_PROTOCOL_BYTES);
  if (!Number.isSafeInteger(value.length) || value.length !== length) {
    fail(path + '.length', 'does not match decoded base64 length');
  }
  requireString(value.sha256, SHA256_PATTERN, path + '.sha256');
}

function validateOracle(oracle) {
  exactKeys(oracle, [
    'cortenCommit', 'nacBinarySha1', 'nacBinarySha256', 'nacX86_64SliceSha256',
  ], '$.vector.oracle');
  if (oracle.cortenCommit !== CORTEN_COMMIT
      || oracle.nacBinarySha1 !== IMAGE_SHA1
      || oracle.nacBinarySha256 !== IMAGE_SHA256
      || oracle.nacX86_64SliceSha256 !== SLICE_SHA256) {
    fail('$.vector.oracle', 'oracle provenance or image pins do not match this harness');
  }
}

function validateVector(vector) {
  exactKeys(vector, [
    'schemaVersion', 'id', 'oracle', 'hardware', 'arc4randomWords',
    'certificateChainBase64', 'sessionInfoBase64', 'expected',
  ], '$.vector');
  if (vector.schemaVersion !== SCHEMA_VERSION) fail('$.vector.schemaVersion', 'unsupported version');
  requireString(vector.id, /^[a-z0-9][a-z0-9._-]{0,127}$/, '$.vector.id');
  validateOracle(vector.oracle);
  validateHardware(vector.hardware);
  if (!Array.isArray(vector.arc4randomWords)
      || vector.arc4randomWords.length < 1
      || vector.arc4randomWords.length > MAX_RANDOM_WORDS) {
    fail('$.vector.arc4randomWords', 'expected an exact non-empty list of at most 4096 words');
  }
  vector.arc4randomWords.forEach(function (word, index) {
    if (!Number.isSafeInteger(word) || word < 0 || word > 0xffffffff) {
      fail('$.vector.arc4randomWords[' + index + ']', 'expected unsigned 32-bit integer');
    }
  });
  base64Length(
    vector.certificateChainBase64, '$.vector.certificateChainBase64', MAX_PROTOCOL_BYTES
  );
  base64Length(vector.sessionInfoBase64, '$.vector.sessionInfoBase64', MAX_PROTOCOL_BYTES);
  exactKeys(vector.expected, ['sessionInfoRequest', 'validationData'], '$.vector.expected');
  validateExpected(vector.expected.sessionInfoRequest, '$.vector.expected.sessionInfoRequest');
  validateExpected(vector.expected.validationData, '$.vector.expected.validationData');
  return vector;
}

function validateLocalInput(input) {
  exactKeys(input, ['schemaVersion', 'imageBase64', 'vector'], '$');
  if (input.schemaVersion !== SCHEMA_VERSION) fail('$.schemaVersion', 'unsupported version');
  base64Length(input.imageBase64, '$.imageBase64', MAX_IMAGE_BYTES);
  validateVector(input.vector);
  return input;
}

module.exports = {
  CORTEN_COMMIT: CORTEN_COMMIT,
  IMAGE_SHA1: IMAGE_SHA1,
  IMAGE_SHA256: IMAGE_SHA256,
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  MAX_PROTOCOL_BYTES: MAX_PROTOCOL_BYTES,
  SCHEMA_VERSION: SCHEMA_VERSION,
  SLICE_SHA256: SLICE_SHA256,
  SYNTHETIC_HARDWARE: SYNTHETIC_HARDWARE,
  base64Length: base64Length,
  validateHardware: validateHardware,
  validateLocalInput: validateLocalInput,
  validateVector: validateVector,
};
