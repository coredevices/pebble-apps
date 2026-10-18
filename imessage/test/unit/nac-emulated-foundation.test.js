'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const foundation = require('../../src/nac/emulated-foundation');
const hardware = require('../../src/nac/hardware-environment');

function fixtureHardware() {
  return hardware.createHardwareEnvironment({
    productName: 'Mac17,3', ioMacAddress: Uint8Array.from([1, 2, 3, 4, 5, 6]),
    platformSerialNumber: 'SERIAL123', platformUuid: '3BA98E0D-BAA9-5F97-BDFD-32F127F62874',
    rootDiskUuid: 'B73F8357-5211-4526-9232-ADB6AC714D82', boardId: 'Mac-24000000',
    platformSerialNumberEnc: new Uint8Array(17).fill(1), platformUuidEnc: new Uint8Array(17).fill(2),
    rootDiskUuidEnc: new Uint8Array(17).fill(3), rom: Uint8Array.from([7, 8, 9, 10, 11, 12]),
    romEnc: new Uint8Array(17).fill(4), mlb: 'MLB123456789', mlbEnc: new Uint8Array(17).fill(5),
  });
}

function memoryFixture() {
  const data = new Uint8Array(4096);
  return {
    data,
    read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > data.length) throw new Error('memory read');
      return data.slice(offset, offset + length);
    },
    write(offset, value) {
      if (offset < 0 || offset + value.length > data.length) throw new Error('memory write');
      data.set(value, offset);
    },
  };
}

function writeU64(memory, offset, value) {
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    memory.data[offset + index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
}

function writeBuiltinCfString(memory, structOffset, textOffset, text) {
  const encoded = bytes.utf8ToBytes(text);
  memory.write(textOffset, encoded);
  writeU64(memory, structOffset + 16, textOffset);
  writeU64(memory, structOffset + 24, encoded.length);
}

test('NAC hook table exactly preserves Corten symbol ordering and addresses', function () {
  const addresses = foundation.createHookAddresses();
  assert.equal(foundation.HOOK_SYMBOLS.length, 37);
  foundation.HOOK_SYMBOLS.forEach((name, index) => {
    assert.equal(addresses[name], foundation.HOOK_BASE + index);
  });
  assert.equal(addresses._malloc, 0xd00000);
  assert.equal(addresses._CFRelease, 0xd00024);
  assert.equal(foundation.UNSUPPORTED_IMPORT_HOOK_ADDRESS, 0xd00025);
});

test('NAC foundation exposes ExtractKey data and strings through the emulated CF ABI', function () {
  const memory = memoryFixture();
  const state = foundation.createFoundationState(fixtureHardware(), () => 0x10203040);
  writeBuiltinCfString(memory, 64, 128, hardware.PROPERTY_NAMES.ioMacAddress);
  const dataId = state.invoke('_IORegistryEntryCreateCFProperty', [1, 64, 0, 0], memory);
  assert.equal(state.invoke('_CFGetTypeID', [dataId], memory), 1n);
  assert.equal(state.invoke('_CFDataGetLength', [dataId], memory), 6n);
  assert.equal(state.invoke('_CFDataGetBytes', [dataId, 0, 6, 256], memory), 6n);
  assert.deepEqual(memory.read(256, 6), Uint8Array.from([1, 2, 3, 4, 5, 6]));

  writeBuiltinCfString(memory, 64, 128, hardware.PROPERTY_NAMES.platformSerialNumber);
  const stringId = state.invoke('_IORegistryEntryCreateCFProperty', [1, 64, 0, 0], memory);
  assert.equal(state.invoke('_CFGetTypeID', [stringId], memory), 2n);
  assert.equal(state.invoke('_CFStringGetCString', [stringId, 300, 64, 0], memory), 9n);
  assert.equal(bytes.bytesToUtf8(memory.read(300, 9)), 'SERIAL123');
});

test('NAC foundation reproduces iterator, DiskArbitration dictionary, heap, and RNG behavior', function () {
  const memory = memoryFixture();
  const words = [0x89abcdef, 0x01234567];
  const state = foundation.createFoundationState(fixtureHardware(), () => words.shift());
  assert.equal(state.invoke('_malloc', [1], memory), BigInt(foundation.HEAP_BASE));
  assert.equal(state.invoke('_malloc', [17], memory), BigInt(foundation.HEAP_BASE + 16));
  assert.equal(state.invoke('_arc4random', [], memory), 0x89abcdefn);
  assert.equal(state.invoke('_arc4random', [], memory), 0x01234567n);

  assert.equal(state.invoke('_IOServiceGetMatchingServices', [0, 0, 100], memory), 0n);
  assert.equal(memory.data[100], 93);
  assert.equal(state.invoke('_IOIteratorNext', [93], memory), 94n);
  assert.equal(state.invoke('_IOIteratorNext', [93], memory), 0n);

  const description = state.invoke('_DADiskCopyDescription', [202], memory);
  const uuid = state.invoke('_CFDictionaryGetValue', [description, foundation.DICTIONARY_UUID_SENTINEL], memory);
  assert.equal(state.invoke('_CFStringGetCString', [uuid, 400, 64, 0], memory), 36n);
  assert.equal(bytes.bytesToUtf8(memory.read(400, 36)), fixtureHardware().rootDiskUuid);
});

test('NAC foundation fails closed on unknown hooks, invalid random words, and exhausted heap', function () {
  const memory = memoryFixture();
  const state = foundation.createFoundationState(fixtureHardware(), () => 0x100000000);
  assert.throws(() => state.invoke('_objc_msgSend', [], memory), error => error.code === 'NAC_HOOK_UNSUPPORTED');
  assert.throws(() => state.invoke('_arc4random', [], memory), /exceeds uint32/);
  assert.throws(() => state.invoke('_malloc', [foundation.HEAP_SIZE + 1], memory), error => error.code === 'NAC_HEAP_EXHAUSTED');
  assert.throws(() => state.invoke('___bzero', [0, BigInt(foundation.HEAP_SIZE) + 1n], memory), error => (
    error.code === 'NAC_MEMORY_FAULT'
  ));
});
