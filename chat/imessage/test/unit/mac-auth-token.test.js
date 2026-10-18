'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var test = require('node:test');

var bytes = require('../../src/runtime/bytes');
var macAuth = require('../../src/configuration/mac-auth-token');

function tokenValue() {
  return {
    inner: {
      productName: 'Mac15,3',
      ioMacAddress: [0, 17, 34, 51, 68, 85],
      platformSerialNumber: 'SERIAL-FIXTURE',
      platformUuid: '11111111-2222-3333-4444-555555555555',
      rootDiskUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      boardId: 'Mac-FAKEBOARD',
      osBuildNum: '23E224',
      platformSerialNumberEnc: [1, 2],
      platformUuidEnc: [3, 4],
      rootDiskUuidEnc: [5, 6],
      rom: [0, 17, 34, 51, 68, 85],
      romEnc: [7, 8],
      mlb: 'MLB-FIXTURE-0000001',
      mlbEnc: [9, 10],
    },
    validationData: Array.from(new Uint8Array(128).fill(42)),
    version: '14.4.1',
    protocolVersion: 1701,
    deviceId: 'device-fixture',
    icloudUa: 'com.apple.iCloudHelper/999 CFNetwork/fixture Darwin/fixture',
    aoskitVersion: 'com.apple.AOSKit/999 (com.apple.accountsd/999)',
    udid: 'udid-fixture',
  };
}

function extractKeyValue() {
  return {
    inner: {
      product_name: 'FixtureModel1,1',
      io_mac_address: [2, 0, 0, 0, 0, 1],
      platform_serial_number: 'SYNTHETIC-SERIAL',
      platform_uuid: '00000000-0000-4000-8000-000000000001',
      root_disk_uuid: '00000000-0000-4000-8000-000000000002',
      board_id: 'Synthetic-Board',
      os_build_num: '99A999',
      platform_serial_number_enc: [1, 2],
      platform_uuid_enc: [3, 4],
      root_disk_uuid_enc: [5, 6],
      rom: [2, 0, 0, 0, 0, 1],
      rom_enc: [7, 8],
      mlb: 'SYNTHETIC-MLB',
      mlb_enc: [9, 10],
    },
    version: '99.1',
    protocol_version: 1640,
    device_id: '00000000-0000-4000-8000-000000000003',
    icloud_ua: 'fixture.iCloudHelper/1 CFNetwork/1 Darwin/1',
    aoskit_version: 'fixture.AOSKit/1 (fixture.accountsd/1)',
  };
}

function text(value) { return JSON.stringify(value || tokenValue()); }

test('Mac authorization accepts JSON and whitespace-wrapped base64 JSON with identical normalization', function () {
  var jsonToken = macAuth.parseMacAuthToken(text());
  var encoded = bytes.bytesToBase64(bytes.utf8ToBytes(text()));
  var wrapped = encoded.replace(/(.{19})/g, '$1 \n');
  var base64Token = macAuth.parseMacAuthToken(wrapped);

  assert.deepEqual(base64Token, jsonToken);
  assert.equal(jsonToken.hardware.productName, 'Mac15,3');
  assert.deepEqual(jsonToken.hardware.ioMacAddress, new Uint8Array([0, 17, 34, 51, 68, 85]));
  assert.equal(jsonToken.validationData.length, 128);
});

test('Mac authorization accepts Rust-style snake_case and base64 binary fields with safe defaults', function () {
  var source = tokenValue();
  var hardware = source.inner;
  var snake = {
    hardware: {
      product_name: hardware.productName,
      io_mac_address: bytes.bytesToBase64(new Uint8Array(hardware.ioMacAddress)),
      platform_serial_number: hardware.platformSerialNumber,
      platform_uuid: hardware.platformUuid,
      root_disk_uuid: hardware.rootDiskUuid,
      board_id: hardware.boardId,
      os_build_num: hardware.osBuildNum,
      rom: bytes.bytesToBase64(new Uint8Array(hardware.rom)),
      mlb: hardware.mlb,
    },
    validation_data: bytes.bytesToBase64(new Uint8Array(source.validationData)),
  };
  var parsed = macAuth.parseMacAuthToken(text(snake));
  assert.equal(parsed.version, macAuth.DEFAULT_VERSION);
  assert.equal(parsed.protocolVersion, macAuth.DEFAULT_PROTOCOL_VERSION);
  assert.equal(parsed.deviceId, hardware.platformUuid);
  assert.equal(parsed.udid, hardware.platformUuid);
  assert.equal(parsed.icloudUa, macAuth.DEFAULT_ICLOUD_UA);
  assert.equal(parsed.aoskitVersion, macAuth.DEFAULT_AOSKIT_VERSION);
  assert.deepEqual(parsed.hardware.platformUuidEnc, new Uint8Array(0));
});

test('Mac authorization accepts hardware-only ExtractKey data without creating reusable validation state', function () {
  var source = extractKeyValue();
  var encoded = bytes.bytesToBase64(bytes.utf8ToBytes(JSON.stringify(source)));
  var parsed = macAuth.parseMacAuthToken(encoded);

  assert.equal(parsed.validationData, null);
  assert.equal(parsed.pushBootstrap, null);
  assert.equal(parsed.hardware.productName, 'FixtureModel1,1');
  assert.equal(parsed.protocolVersion, 1640);
  assert.equal(parsed.deviceId, source.inner.platform_uuid);
  assert.equal(parsed.udid, source.inner.platform_uuid);

  var artifact = macAuth.macAuthArtifact(parsed);
  assert.equal(artifact.validationData, null);
  assert.equal(Object.prototype.hasOwnProperty.call(artifact, 'validationData'), true);
  assert.deepEqual(macAuth.restoreMacAuthArtifact(JSON.parse(JSON.stringify(artifact))), parsed);

  var derived = macAuth.deriveMacConfiguration(parsed, Date.parse('2026-08-27T12:34:56Z'));
  assert.equal(Object.prototype.hasOwnProperty.call(derived.delegateConfig, 'validationData'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(derived.ids, 'validationData'), false);
});

test('Mac authorization preserves ExtractKey hardware casing but uppercases both Corten device identifiers', function () {
  var source = extractKeyValue();
  source.inner.platform_uuid = source.inner.platform_uuid.toLowerCase();
  source.device_id = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  source.udid = 'FFFFFFFF-1111-4222-8333-444444444444';

  var parsed = macAuth.parseMacAuthToken(text(source));
  assert.equal(parsed.hardware.platformUuid, '00000000-0000-4000-8000-000000000001'.toLowerCase());
  assert.equal(parsed.deviceId, parsed.hardware.platformUuid.toUpperCase());
  assert.equal(parsed.udid, parsed.hardware.platformUuid.toUpperCase());
});

test('portable NAC preflight accepts complete ExtractKey exports and rejects plaintext-only exports', function () {
  var source = extractKeyValue();
  ['platform_serial_number_enc', 'platform_uuid_enc', 'root_disk_uuid_enc', 'rom_enc', 'mlb_enc']
    .forEach(function (name, index) { source.inner[name] = new Array(17).fill(index + 1); });
  var complete = macAuth.parseMacAuthToken(text(source));
  assert.equal(macAuth.assertPortableNacCompatible(complete), complete);

  delete source.inner.rom_enc;
  var incomplete = macAuth.parseMacAuthToken(text(source));
  assert.throws(function () { macAuth.assertPortableNacCompatible(incomplete); }, function (error) {
    return error && error.code === 'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED'
      && error.details.missingFields.indexOf('encrypted ROM') !== -1;
  });
});

test('Mac authorization rejects explicitly supplied empty, malformed, short, or ambiguous validation data', function () {
  [null, '', [], new Array(100).fill(1)].forEach(function (validationData) {
    var source = extractKeyValue();
    source.validation_data = validationData;
    assert.throws(function () { macAuth.parseMacAuthToken(text(source)); }, function (error) {
      return error && error.code === 'INVALID_MAC_TOKEN';
    });
  });

  var ambiguous = tokenValue();
  ambiguous.validation_data = ambiguous.validationData.slice();
  assert.throws(function () { macAuth.parseMacAuthToken(text(ambiguous)); }, /ambiguous validationData/);
});

test('Mac authorization normalizes optional camel- and snake-case APS bootstrap byte fields', function () {
  var snakeSource = tokenValue();
  var snakeToken = new Array(32).fill(7);
  var snakePrivate = [4, 5, 6];
  snakeSource.push_bootstrap = {
    certificate_der: bytes.bytesToBase64(new Uint8Array([1, 2, 3])),
    private_key_pkcs8: snakePrivate,
    token: snakeToken,
  };
  var snake = macAuth.parseMacAuthToken(text(snakeSource));
  assert.deepEqual(snake.pushBootstrap, {
    certificateDer: new Uint8Array([1, 2, 3]),
    privateKeyPkcs8: new Uint8Array([4, 5, 6]),
    token: new Uint8Array(32).fill(7),
  });

  snakePrivate[0] = 99;
  snakeToken[0] = 99;
  assert.equal(snake.pushBootstrap.privateKeyPkcs8[0], 4);
  assert.equal(snake.pushBootstrap.token[0], 7);

  var camelSource = tokenValue();
  camelSource.pushBootstrap = {
    certificateDer: [8, 9],
    privateKeyPkcs8: bytes.bytesToBase64(new Uint8Array([10, 11])),
    token: bytes.bytesToBase64(new Uint8Array(32).fill(12)),
  };
  var camel = macAuth.parseMacAuthToken(text(camelSource));
  assert.deepEqual(camel.pushBootstrap.certificateDer, new Uint8Array([8, 9]));
  assert.deepEqual(camel.pushBootstrap.privateKeyPkcs8, new Uint8Array([10, 11]));
  assert.deepEqual(camel.pushBootstrap.token, new Uint8Array(32).fill(12));
});

test('APS bootstrap rejects unknown, ambiguous, missing, empty, oversized, and malformed fields', function () {
  var valid = {
    certificateDer: [1],
    privateKeyPkcs8: [2],
    token: new Array(32).fill(3),
  };
  var cases = [
    Object.assign({}, valid, { unexpected: true }),
    Object.assign({}, valid, { certificate_der: [1] }),
    Object.assign({}, valid, { private_key_pkcs8: [2] }),
    { privateKeyPkcs8: [2], token: new Array(32).fill(3) },
    { certificateDer: [1], token: new Array(32).fill(3) },
    { certificateDer: [], privateKeyPkcs8: [2], token: new Array(32).fill(3) },
    { certificateDer: [1], privateKeyPkcs8: [], token: new Array(32).fill(3) },
    { certificateDer: [1], privateKeyPkcs8: [2], token: new Array(31).fill(3) },
    { certificateDer: [1], privateKeyPkcs8: [2], token: new Array(33).fill(3) },
    { certificateDer: 'not base64!', privateKeyPkcs8: [2], token: new Array(32).fill(3) },
    { certificateDer: new Array(256 * 1024 + 1).fill(1), privateKeyPkcs8: [2], token: new Array(32).fill(3) },
    { certificateDer: [1], privateKeyPkcs8: new Array(256 * 1024 + 1).fill(2), token: new Array(32).fill(3) },
  ];
  cases.forEach(function (pushBootstrap) {
    var source = tokenValue();
    source.pushBootstrap = pushBootstrap;
    assert.throws(function () { macAuth.parseMacAuthToken(text(source)); }, function (error) {
      return error.code === 'INVALID_MAC_TOKEN';
    });
  });

  var duplicateRoot = tokenValue();
  duplicateRoot.pushBootstrap = valid;
  duplicateRoot.push_bootstrap = valid;
  assert.throws(function () { macAuth.parseMacAuthToken(text(duplicateRoot)); }, /ambiguous pushBootstrap/);
});

test('APS bootstrap is transient: artifacts strip it and disposal zeroes only its private key', function () {
  var source = tokenValue();
  source.pushBootstrap = {
    certificateDer: [21, 22],
    privateKeyPkcs8: [23, 24, 25],
    token: new Array(32).fill(26),
  };
  var parsed = macAuth.parseMacAuthToken(text(source));
  var certificateBefore = new Uint8Array(parsed.pushBootstrap.certificateDer);
  var tokenBefore = new Uint8Array(parsed.pushBootstrap.token);
  var artifact = macAuth.macAuthArtifact(parsed);

  assert.equal(Object.prototype.hasOwnProperty.call(artifact, 'pushBootstrap'), false);
  assert.equal(JSON.stringify(artifact).indexOf('privateKeyPkcs8'), -1);
  assert.equal(JSON.stringify(artifact).indexOf('pushBootstrap'), -1);
  assert.equal(macAuth.restoreMacAuthArtifact(JSON.parse(JSON.stringify(artifact))).pushBootstrap, null);

  macAuth.disposePushBootstrap(parsed.pushBootstrap);
  assert.deepEqual(parsed.pushBootstrap.privateKeyPkcs8, new Uint8Array(3));
  assert.deepEqual(parsed.pushBootstrap.certificateDer, certificateBefore);
  assert.deepEqual(parsed.pushBootstrap.token, tokenBefore);
  macAuth.disposePushBootstrap(parsed.pushBootstrap);
  assert.deepEqual(parsed.pushBootstrap.privateKeyPkcs8, new Uint8Array(3));
  macAuth.disposePushBootstrap(null);
});

test('canonical Mac artifact round-trips hardware metadata but strips legacy validation data', function () {
  var parsed = macAuth.parseMacAuthToken(text());
  var artifact = macAuth.macAuthArtifact(parsed);
  var restored = macAuth.restoreMacAuthArtifact(JSON.parse(JSON.stringify(artifact)));
  assert.deepEqual(restored, Object.assign({}, parsed, { validationData: null }));
  assert.equal(artifact.validationData, null);
  assert.equal(artifact.hardware.ioMacAddress, 'ABEiM0RV');

  assert.throws(function () {
    macAuth.restoreMacAuthArtifact(Object.assign({}, artifact, { password: 'must-not-persist' }));
  }, /unexpected fields/);
  var extraHardware = Object.assign({}, artifact.hardware, { secret: 'must-not-persist' });
  assert.throws(function () {
    macAuth.restoreMacAuthArtifact(Object.assign({}, artifact, { hardware: extraHardware }));
  }, /unexpected fields/);
});

test('legacy validation bytes are stripped from live tokens and transient token secrets are disposable', function () {
  var source = tokenValue();
  source.pushBootstrap = {
    certificateDer: [1, 2],
    privateKeyPkcs8: [3, 4, 5],
    token: new Array(32).fill(6),
  };
  var parsed = macAuth.parseMacAuthToken(text(source));
  var legacyValidation = parsed.validationData;
  var normalized = macAuth.stripLegacyValidationData(parsed);

  assert.equal(normalized.validationData, null);
  assert.deepEqual(legacyValidation, new Uint8Array(128));
  assert.equal(normalized.pushBootstrap, parsed.pushBootstrap);

  macAuth.disposeMacAuthToken(normalized);
  assert.deepEqual(normalized.pushBootstrap.privateKeyPkcs8, new Uint8Array(3));
  macAuth.disposeMacAuthToken(normalized);
  macAuth.disposeMacAuthToken(null);
});

test('derived Mac configuration drives account, Anisette, APS, and IDS metadata', function () {
  var parsed = macAuth.parseMacAuthToken(text());
  var pushToken = new Uint8Array(32);
  for (var index = 0; index < pushToken.length; index += 1) pushToken[index] = index;
  var nowMs = Date.parse('2026-08-27T12:34:56Z');
  var derived = macAuth.deriveMacConfiguration(parsed, nowMs, pushToken);

  assert.equal(derived.accountClientInfo.pushToken, bytes.bytesToHex(pushToken).toUpperCase());
  assert.equal(derived.accountClientInfo.clientBundleId, 'com.apple.MobileSMS');
  assert.deepEqual(derived.anisetteClientInfo.hardwareHeaders, [
    ['X-Apple-I-MLB', 'MLB-FIXTURE-0000001'],
    ['X-Apple-I-ROM', '001122334455'],
    ['X-Apple-I-SRL-NO', 'SERIAL-FIXTURE'],
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(derived.delegateConfig, 'validationData'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(derived.ids, 'validationData'), false);
  assert.equal(derived.ids.protocolVersion, 1701);
  assert.equal(derived.ids.userAgent, '[macOS,14.4.1,23E224,Mac15,3]');
  assert.equal(derived.ids.registrationMetadata.deviceName, 'Mac-SERIAL-FIXTURE');
  assert.equal(derived.ids.registrationMetadata.privateDeviceData.u, '11111111-2222-3333-4444-555555555555');
  assert.equal(
    derived.ids.registrationMetadata.privateDeviceData.d,
    ((nowMs / 1000) - 978307200).toFixed(6)
  );
});

test('malformed Mac tokens fail closed without echoing token contents', function () {
  var cases = [
    '',
    'not base64!',
    bytes.bytesToBase64(new Uint8Array([0xff, 0xfe])),
    '{}',
    text(Object.assign({}, tokenValue(), { validationData: new Array(100).fill(1) })),
    text(Object.assign({}, tokenValue(), { protocolVersion: '1701' })),
    text(Object.assign({}, tokenValue(), { inner: Object.assign({}, tokenValue().inner, { ioMacAddress: [1, 2] }) })),
    text(Object.assign({}, tokenValue(), { inner: Object.assign({}, tokenValue().inner, { rom: [] }) })),
  ];
  cases.forEach(function (value) {
    assert.throws(function () { macAuth.parseMacAuthToken(value); }, function (error) {
      return error.code === 'INVALID_MAC_TOKEN' && (value.length < 20 || error.message.indexOf(value) === -1);
    });
  });

  var secret = tokenValue();
  secret.version = 'never-echo-this-secret\n';
  assert.throws(function () { macAuth.parseMacAuthToken(text(secret)); }, function (error) {
    return error.code === 'INVALID_MAC_TOKEN' && error.message.indexOf('never-echo-this-secret') === -1;
  });
  assert.throws(function () {
    macAuth.deriveMacConfiguration(macAuth.parseMacAuthToken(text()), 0, new Uint8Array(32));
  }, /clock is invalid/);
  assert.throws(function () {
    macAuth.deriveMacConfiguration(macAuth.parseMacAuthToken(text()), Date.now(), new Uint8Array(31));
  }, /Push token is malformed/);
});

test('Mac authorization implementation has no ambient browser or Node runtime dependency', function () {
  var source = fs.readFileSync(require.resolve('../../src/configuration/mac-auth-token'), 'utf8');
  ['Buffer', 'window', 'document', 'localStorage', 'process.', 'require(\'node:'].forEach(function (ambient) {
    assert.equal(source.indexOf(ambient), -1, ambient);
  });
});
