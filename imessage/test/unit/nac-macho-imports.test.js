'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const macho = require('../../src/nac/macho-imports');

function u32(target, offset, value) { target.set(bytes.uint32LE(value), offset); }
function u64(target, offset, value) {
  u32(target, offset, value >>> 0);
  u32(target, offset + 4, Math.floor(value / 0x100000000));
}

function fixture() {
  const result = new Uint8Array(512);
  u32(result, 0, 0xfeedfacf);
  u32(result, 4, 0x01000007);
  u32(result, 16, 3);
  u32(result, 20, 256);

  let command = 32;
  u32(result, command, macho.LC_SEGMENT_64);
  u32(result, command + 4, 152);
  u64(result, command + 40, 0);
  u64(result, command + 48, result.length);
  u32(result, command + 64, 1);
  const section = command + 72;
  u64(result, section + 40, 16);
  u32(result, section + 48, 400);
  u32(result, section + 64, macho.S_NON_LAZY_SYMBOL_POINTERS);
  u32(result, section + 68, 0);

  command += 152;
  u32(result, command, macho.LC_SYMTAB);
  u32(result, command + 4, 24);
  u32(result, command + 8, 320);
  u32(result, command + 12, 2);
  u32(result, command + 16, 352);
  u32(result, command + 20, 32);

  command += 24;
  u32(result, command, macho.LC_DYSYMTAB);
  u32(result, command + 4, 80);
  u32(result, command + 56, 384);
  u32(result, command + 60, 2);

  u32(result, 320, 1);
  u32(result, 336, 9);
  result.set(bytes.utf8ToBytes('\u0000_malloc\u0000_arc4random\u0000'), 352);
  u32(result, 384, 0);
  u32(result, 388, 1);
  return result;
}

test('NAC Mach-O parser resolves lazy-pointer imports to bounded file offsets', function () {
  assert.deepEqual(macho.listImports(fixture()), [
    { name: '_malloc', offset: 400 },
    { name: '_arc4random', offset: 408 },
  ]);
});

test('NAC Mach-O bindings require every JS hook and trap every unrelated image import', function () {
  assert.deepEqual(macho.buildImportBindings(fixture(), {
    _malloc: 0xd00000,
    _arc4random: 0xd00001,
  }, 0xd00fff), [
    { name: '_malloc', offset: 400, address: 0xd00000, supported: true },
    { name: '_arc4random', offset: 408, address: 0xd00001, supported: true },
  ]);
  assert.deepEqual(macho.buildImportBindings(fixture(), {
    _malloc: 0xd00000,
  }, 0xd00fff), [
    { name: '_malloc', offset: 400, address: 0xd00000, supported: true },
    { name: '_arc4random', offset: 408, address: 0xd00fff, supported: false },
  ]);
  assert.throws(() => macho.buildImportBindings(fixture(), {
    _malloc: 0xd00000,
    _arc4random: 0xd00001,
    _unused: 0xd00002,
  }, 0xd00fff), /missing a required host import/);
  assert.throws(() => macho.buildImportBindings(fixture(), {
    _malloc: 0xd00000,
    _arc4random: 0xd00001,
  }), /unsupported-import hook address/);
});

test('NAC Mach-O parser rejects malformed command, table, string, and pointer bounds', function () {
  const header = fixture();
  u32(header, 0, 0);
  assert.throws(() => macho.listImports(header), /not an x86-64/);

  const command = fixture();
  u32(command, 36, 7);
  assert.throws(() => macho.listImports(command), /load command/);

  const indirect = fixture();
  u32(indirect, 384, 99);
  assert.throws(() => macho.listImports(indirect), /invalid symbol/);

  const string = fixture();
  string.fill(65, 352, 384);
  assert.throws(() => macho.listImports(string), /symbol name/);

  const pointers = fixture();
  u32(pointers, 32 + 72 + 48, 510);
  assert.throws(() => macho.listImports(pointers), /pointer section.*out of bounds/);
});
