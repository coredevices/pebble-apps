'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const bytes = require('../../src/runtime/bytes');
const foundation = require('../../src/nac/emulated-foundation');
const hardware = require('../../src/nac/hardware-environment');
const macho = require('../../src/nac/macho-imports');
const validation = require('../../src/nac/validation-context');

function u32(target, offset, value) { target.set(bytes.uint32LE(value), offset); }
function u64(target, offset, value) {
  let remaining = BigInt(value);
  for (let index = 0; index < 8; index += 1) {
    target[offset + index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
}

function importedImage() {
  const names = foundation.HOOK_SYMBOLS.concat(['_unrelated_image_import']);
  const result = new Uint8Array(8192);
  const symbolsOffset = 512;
  const stringsOffset = 1280;
  const indirectOffset = 2560;
  const pointersOffset = 3072;
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
  u64(result, section + 40, names.length * 8);
  u32(result, section + 48, pointersOffset);
  u32(result, section + 64, macho.S_NON_LAZY_SYMBOL_POINTERS);
  u32(result, section + 68, 0);

  command += 152;
  u32(result, command, macho.LC_SYMTAB);
  u32(result, command + 4, 24);
  u32(result, command + 8, symbolsOffset);
  u32(result, command + 12, names.length);
  u32(result, command + 16, stringsOffset);

  let stringCursor = 1;
  result[stringsOffset] = 0;
  names.forEach((name, index) => {
    u32(result, symbolsOffset + index * 16, stringCursor);
    const encoded = bytes.utf8ToBytes(name + '\0');
    result.set(encoded, stringsOffset + stringCursor);
    stringCursor += encoded.length;
    u32(result, indirectOffset + index * 4, index);
  });
  u32(result, command + 20, stringCursor);

  command += 24;
  u32(result, command, macho.LC_DYSYMTAB);
  u32(result, command + 4, 80);
  u32(result, command + 56, indirectOffset);
  u32(result, command + 60, names.length);
  return result;
}

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

function ScriptedMachine(plan, behavior) {
  this.plan = plan;
  this.behavior = behavior || {};
  this.memory = new Map();
  this.registers = Object.assign({
    rax: 0n, rbx: 0n, rcx: 0n, rdx: 0n, rsi: 0n, rdi: 0n,
    rbp: 0n, rsp: 0n, r8: 0n, r9: 0n, r10: 0n, r11: 0n,
    r12: 0n, r13: 0n, r14: 0n, r15: 0n, rip: 0n, eflags: 0n,
  }, plan.registers);
  this.nextToken = 1;
  this.destroyCount = 0;
  this.starts = [];
  plan.writes.forEach(write => this.write(write.address, write.data));
  plan.fills.forEach(fill => this.fill(fill.address, fill.length, fill.byte));
}
ScriptedMachine.prototype.write = function (address, data) {
  let cursor = BigInt(address);
  data.forEach(value => { this.memory.set(cursor, value); cursor += 1n; });
};
ScriptedMachine.prototype.read = function (address, length) {
  const result = new Uint8Array(length);
  let cursor = BigInt(address);
  for (let index = 0; index < length; index += 1) {
    result[index] = this.memory.get(cursor) || 0;
    cursor += 1n;
  }
  return result;
};
ScriptedMachine.prototype.fill = function (address, length, byte) {
  this.write(address, new Uint8Array(length).fill(byte));
};
ScriptedMachine.prototype.apply = function (effects) {
  effects.forEach(effect => {
    if (effect.kind === 'write') this.write(effect.address, effect.data);
    else if (effect.kind === 'fill') this.fill(effect.address, effect.length, effect.byte);
    else if (effect.kind === 'set-registers') Object.assign(this.registers, effect.values);
    else throw new Error('unexpected fake effect ' + effect.kind);
  });
};
ScriptedMachine.prototype.event = function (kind, extra) {
  return Object.assign({ kind, registers: Object.assign({}, this.registers) }, extra || {});
};
ScriptedMachine.prototype.complete = function () {
  this.registers.rax = 0n;
  this.registers.rsp = BigInt(validation.STACK_BASE + validation.STACK_SIZE);
  this.registers.rip = BigInt(validation.STOP_ADDRESS);
  return this.event('until', {
    address: BigInt(validation.STOP_ADDRESS), pauseToken: this.nextToken++,
  });
};
ScriptedMachine.prototype.start = function (begin, until, effects, limits) {
  this.apply(effects);
  this.starts.push({ begin, until, effects, limits });
  if (this.behavior.budgetAt === begin) return this.event('budget', { code: 'INSTRUCTION_LIMIT' });
  if (begin === BigInt(validation.NAC_INIT_ADDRESS)) {
    if (this.behavior.unsupportedTrap) {
      return this.event('trap', {
        address: BigInt(foundation.UNSUPPORTED_IMPORT_HOOK_ADDRESS),
        trapId: foundation.HOOK_SYMBOLS.length,
        pauseToken: this.nextToken++,
      });
    }
    const hookStack = this.registers.rsp - 8n;
    this.write(hookStack, wordBytes(0x12345n));
    this.registers.rsp = hookStack;
    return this.event('trap', {
      address: BigInt(foundation.createHookAddresses()._arc4random),
      trapId: foundation.HOOK_SYMBOLS.indexOf('_arc4random'),
      pauseToken: this.nextToken++,
    });
  }
  if (begin === BigInt(validation.NAC_ESTABLISH_ADDRESS)) return this.complete();
  if (begin === BigInt(validation.NAC_SIGN_ADDRESS)) {
    const output = Uint8Array.from([6, 5, 4, 3]);
    const outputAddress = 0x4f0000n;
    this.write(outputAddress, output);
    this.write(this.registers.rcx, wordBytes(outputAddress));
    this.write(this.registers.r8, wordBytes(this.behavior.signLength || BigInt(output.length)));
    return this.complete();
  }
  throw new Error('unexpected fake entrypoint');
};
ScriptedMachine.prototype.resume = function (pauseToken, effects) {
  this.apply(effects);
  assert.ok(pauseToken > 0);
  assert.equal(this.registers.rax, 0x10203040n);
  assert.equal(this.registers.rip, 0x12345n);
  const request = Uint8Array.from([9, 8, 7]);
  const requestAddress = 0x4e0000n;
  this.write(requestAddress, request);
  this.write(this.registers.rdx, wordBytes(0x123456n));
  this.write(this.registers.rcx, wordBytes(requestAddress));
  this.write(this.registers.r8, wordBytes(BigInt(request.length)));
  return this.complete();
};
ScriptedMachine.prototype.inspect = function (pauseToken, reads, registers) {
  return {
    pauseToken,
    reads: reads.map(read => ({ id: read.id, data: this.read(read.address, read.length) })),
    registers: Object.fromEntries(registers.map(name => [name, this.registers[name]])),
  };
};
ScriptedMachine.prototype.destroy = function () { this.destroyCount += 1; };

function wordBytes(value) {
  const result = new Uint8Array(8);
  u64(result, 0, value);
  return result;
}

function createFixture(behavior) {
  let machine;
  const context = validation.createValidationContext({
    machineProvider: { create(plan) { machine = new ScriptedMachine(plan, behavior); return machine; } },
    image: importedImage(),
    certificateChain: Uint8Array.from([1, 2, 3, 4]),
    hardwareEnvironment: fixtureHardware(),
    randomWord: () => 0x10203040,
  });
  return { context, machine };
}

test('NAC validation context owns the complete Corten memory, import, trap, and call plan in JS', function () {
  const { context, machine } = createFixture();
  assert.deepEqual(context.sessionInfoRequest, Uint8Array.from([9, 8, 7]));
  assert.deepEqual(machine.plan.regions, [
    { address: 0n, size: 8192, permissions: 'rwx' },
    { address: 0xd00000n, size: 4096, permissions: 'rwx' },
    { address: 0x300000n, size: 0x100000, permissions: 'rwx' },
    { address: 0x400000n, size: 0x100000, permissions: 'rwx' },
    { address: 0x900000n, size: 4096, permissions: 'rwx' },
  ]);
  assert.equal(machine.plan.traps.length, 38);
  assert.deepEqual(machine.plan.traps.at(-1), { id: 37, address: 0xd00025n });
  assert.equal(machine.plan.fills[0].byte, 0xc3);
  assert.equal(machine.read(0xd00000n, 1)[0], 0xc3);

  const imports = macho.listImports(importedImage());
  imports.forEach(entry => {
    const expected = Object.prototype.hasOwnProperty.call(foundation.createHookAddresses(), entry.name)
      ? foundation.createHookAddresses()[entry.name] : foundation.UNSUPPORTED_IMPORT_HOOK_ADDRESS;
    assert.equal(readWord(machine.read(BigInt(entry.offset), 8)), BigInt(expected));
  });
  assert.deepEqual(machine.starts[0].limits, {
    instructionLimit: 500000000, timeoutMillis: 180000, trapLimit: 4096,
  });

  context.establish(Uint8Array.from([4, 5, 6]));
  assert.equal(machine.starts[1].begin, 0xb1dd0n);
  const signed = context.sign();
  assert.deepEqual(signed, Uint8Array.from([6, 5, 4, 3]));
  assert.equal(machine.starts[2].begin, 0xb1df0n);
  assert.equal(machine.destroyCount, 1);
  assert.throws(() => context.sign(), error => error.code === 'NAC_CONTEXT_STATE');
});

function readWord(value) {
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(value[index]);
  return result;
}

test('NAC validation context destroys the machine on unsupported imports and execution budgets', function () {
  let unsupportedMachine;
  assert.throws(() => validation.createValidationContext({
    machineProvider: { create(plan) {
      unsupportedMachine = new ScriptedMachine(plan, { unsupportedTrap: true });
      return unsupportedMachine;
    } },
    image: importedImage(), certificateChain: Uint8Array.of(1),
    hardwareEnvironment: fixtureHardware(), randomWord: () => 1,
  }), error => error.code === 'NAC_HOOK_UNSUPPORTED');
  assert.equal(unsupportedMachine.destroyCount, 1);

  const { context, machine } = createFixture({ budgetAt: BigInt(validation.NAC_ESTABLISH_ADDRESS) });
  assert.throws(() => context.establish(Uint8Array.of(2)), error => (
    error.code === 'NAC_EXECUTION_LIMIT' && error.kind === 'timeout'
  ));
  assert.equal(machine.destroyCount, 1);
});

test('NAC validation context bounds native output before issuing the backing memory read', function () {
  const { context, machine } = createFixture({ signLength: BigInt(validation.MAX_NATIVE_OUTPUT_BYTES + 1) });
  context.establish(Uint8Array.of(2));
  assert.throws(() => context.sign(), error => error.code === 'NAC_NATIVE_OUTPUT_INVALID');
  assert.equal(machine.destroyCount, 1);
});
