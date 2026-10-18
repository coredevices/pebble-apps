'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const hardwareEnvironment = require('../../src/nac/hardware-environment');

function hardware() {
  return {
    productName: 'Mac17,3',
    ioMacAddress: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    platformSerialNumber: 'SERIAL123',
    platformUuid: '3BA98E0D-BAA9-5F97-BDFD-32F127F62874',
    rootDiskUuid: 'B73F8357-5211-4526-9232-ADB6AC714D82',
    boardId: 'Mac-24000000',
    platformSerialNumberEnc: new Uint8Array(17).fill(1),
    platformUuidEnc: new Uint8Array(17).fill(2),
    rootDiskUuidEnc: new Uint8Array(17).fill(3),
    rom: Uint8Array.from([7, 8, 9, 10, 11, 12]),
    romEnc: new Uint8Array(17).fill(4),
    mlb: 'MLB123456789',
    mlbEnc: new Uint8Array(17).fill(5),
  };
}

test('NAC hardware environment reproduces Corten IOKit and DiskArbitration mappings', function () {
  const source = hardware();
  const env = hardwareEnvironment.createHardwareEnvironment(source);
  const names = hardwareEnvironment.PROPERTY_NAMES;
  assert.equal(env.rootDiskUuid, source.rootDiskUuid);
  assert.equal(env.propertyNames().length, 12);
  assert.deepEqual(env.readProperty(names.ioMacAddress), { type: 'data', value: source.ioMacAddress });
  assert.deepEqual(env.readProperty(names.platformSerialNumber), { type: 'string', value: source.platformSerialNumber });
  assert.deepEqual(env.readProperty(names.platformUuid), { type: 'string', value: source.platformUuid });
  assert.equal(bytes.bytesToUtf8(env.readProperty(names.mlb).value), source.mlb);
  assert.deepEqual(env.readProperty(names.platformUuidEnc).value, source.platformUuidEnc);
  assert.deepEqual(env.readProperty(names.platformSerialNumberEnc).value, source.platformSerialNumberEnc);
  assert.deepEqual(env.readProperty(names.rootDiskUuidEnc).value, source.rootDiskUuidEnc);
  assert.deepEqual(env.readProperty(names.romEnc).value, source.romEnc);
  assert.deepEqual(env.readProperty(names.mlbEnc).value, source.mlbEnc);
  assert.deepEqual(env.readProperty(names.productName).value.slice(-1), new Uint8Array([0]));
  assert.deepEqual(env.readProperty(names.boardId).value.slice(-1), new Uint8Array([0]));
});

test('NAC hardware environment owns its bytes and never exposes mutable backing storage', function () {
  const source = hardware();
  const env = hardwareEnvironment.createHardwareEnvironment(source);
  source.ioMacAddress[0] = 99;
  const first = env.readProperty(hardwareEnvironment.PROPERTY_NAMES.ioMacAddress);
  assert.equal(first.value[0], 1);
  first.value[0] = 88;
  assert.equal(env.readProperty(hardwareEnvironment.PROPERTY_NAMES.ioMacAddress).value[0], 1);
  assert.equal(env.readProperty('unknown'), null);
});

test('NAC hardware environment requires canonical UUIDs and ExtractKey encrypted fields', function () {
  const invalidUuid = hardware();
  invalidUuid.platformUuid = 'not-a-uuid';
  assert.throws(() => hardwareEnvironment.createHardwareEnvironment(invalidUuid), /platform UUID/);

  const missingEnc = hardware();
  missingEnc.mlbEnc = new Uint8Array(0);
  assert.throws(() => hardwareEnvironment.createHardwareEnvironment(missingEnc), /encrypted MLB.*17 bytes/);

  const wrongRom = hardware();
  wrongRom.rom = new Uint8Array(5);
  assert.throws(() => hardwareEnvironment.createHardwareEnvironment(wrongRom), /ROM.*6 bytes/);
});
