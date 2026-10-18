'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var PROPERTY_NAMES = Object.freeze({
  mlb: '4D1EDE05-38C7-4A6A-9CC6-4BCCA8B38C14:MLB',
  rom: '4D1EDE05-38C7-4A6A-9CC6-4BCCA8B38C14:ROM',
  platformUuidEnc: 'Fyp98tpgj',
  platformSerialNumberEnc: 'Gq3489ugfi',
  ioMacAddress: 'IOMACAddress',
  mlbEnc: 'abKPld1EcMni',
  rootDiskUuidEnc: 'kbjfrfpoJU',
  romEnc: 'oycqAZloTNDm',
  platformSerialNumber: 'IOPlatformSerialNumber',
  platformUuid: 'IOPlatformUUID',
  productName: 'product-name',
  boardId: 'board-id',
});

var UUID_PATTERN = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function hardwareError(message) {
  return new RuntimeError('NAC_HARDWARE_INVALID', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || /[\u0000\r\n]/.test(value)) {
    throw hardwareError('The Mac hardware ' + name + ' is invalid.');
  }
  return value;
}

function requireUuid(value, name) {
  requireString(value, name);
  if (!UUID_PATTERN.test(value)) throw hardwareError('The Mac hardware ' + name + ' is invalid.');
  return value;
}

function requireBytes(value, name, length) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw hardwareError('The Mac hardware ' + name + ' must contain exactly ' + length + ' bytes.');
  }
  return new Uint8Array(value);
}

function nulTerminated(value) {
  return bytes.concatBytes(bytes.utf8ToBytes(value), new Uint8Array([0]));
}

function dataProperty(value) {
  return Object.freeze({ type: 'data', value: new Uint8Array(value) });
}

function stringProperty(value) {
  return Object.freeze({ type: 'string', value: value });
}

function cloneProperty(property) {
  if (!property) return null;
  return property.type === 'data' ? dataProperty(property.value) : stringProperty(property.value);
}

/**
 * Build the exact IOKit/DiskArbitration view consumed by Corten's portable NAC emulator. No
 * hardware lookup is delegated to the host; every Apple property name and mapping remains in JS.
 * The first prototype requires ExtractKey's complete encrypted-property set instead of deriving
 * XNU-specific values from plaintext.
 */
function createHardwareEnvironment(hardware) {
  if (!hardware || typeof hardware !== 'object' || Array.isArray(hardware)) {
    throw hardwareError('The Mac hardware configuration is missing.');
  }
  var productName = requireString(hardware.productName, 'product name');
  var serial = requireString(hardware.platformSerialNumber, 'serial number');
  var platformUuid = requireUuid(hardware.platformUuid, 'platform UUID');
  var rootDiskUuid = requireUuid(hardware.rootDiskUuid, 'root disk UUID');
  var boardId = requireString(hardware.boardId, 'board ID');
  var mlb = requireString(hardware.mlb, 'MLB');
  var ioMacAddress = requireBytes(hardware.ioMacAddress, 'MAC address', 6);
  var rom = requireBytes(hardware.rom, 'ROM', 6);
  var platformSerialNumberEnc = requireBytes(hardware.platformSerialNumberEnc, 'encrypted serial number', 17);
  var platformUuidEnc = requireBytes(hardware.platformUuidEnc, 'encrypted platform UUID', 17);
  var rootDiskUuidEnc = requireBytes(hardware.rootDiskUuidEnc, 'encrypted root disk UUID', 17);
  var romEnc = requireBytes(hardware.romEnc, 'encrypted ROM', 17);
  var mlbEnc = requireBytes(hardware.mlbEnc, 'encrypted MLB', 17);

  var properties = Object.create(null);
  properties[PROPERTY_NAMES.mlb] = dataProperty(bytes.utf8ToBytes(mlb));
  properties[PROPERTY_NAMES.rom] = dataProperty(rom);
  properties[PROPERTY_NAMES.platformUuidEnc] = dataProperty(platformUuidEnc);
  properties[PROPERTY_NAMES.platformSerialNumberEnc] = dataProperty(platformSerialNumberEnc);
  properties[PROPERTY_NAMES.ioMacAddress] = dataProperty(ioMacAddress);
  properties[PROPERTY_NAMES.mlbEnc] = dataProperty(mlbEnc);
  properties[PROPERTY_NAMES.rootDiskUuidEnc] = dataProperty(rootDiskUuidEnc);
  properties[PROPERTY_NAMES.romEnc] = dataProperty(romEnc);
  properties[PROPERTY_NAMES.platformSerialNumber] = stringProperty(serial);
  properties[PROPERTY_NAMES.platformUuid] = stringProperty(platformUuid);
  properties[PROPERTY_NAMES.productName] = dataProperty(nulTerminated(productName));
  properties[PROPERTY_NAMES.boardId] = dataProperty(nulTerminated(boardId));
  var names = Object.freeze(Object.keys(properties).sort());

  return Object.freeze({
    rootDiskUuid: rootDiskUuid,
    propertyNames: function () { return names.slice(); },
    readProperty: function (name) {
      if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(properties, name)) return null;
      return cloneProperty(properties[name]);
    },
  });
}

module.exports = {
  PROPERTY_NAMES: PROPERTY_NAMES,
  createHardwareEnvironment: createHardwareEnvironment,
};
