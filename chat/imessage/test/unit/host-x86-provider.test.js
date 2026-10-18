'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  HostX86Error,
  NativeHostX86Provider,
  decodeWord,
  encodeWord,
} = require('../../src/runtime/host-x86-provider');

function native(responder) {
  return { request(raw) { return JSON.stringify(responder(JSON.parse(raw))); } };
}

test('host x86 adapter preserves exact uint64, bytes, maps, registers, and traps', function () {
  const seen = [];
  const provider = new NativeHostX86Provider(native((request) => {
    seen.push(request);
    return { ok: true, vm: 7, state: 'ready' };
  }));
  const machine = provider.create({
    regions: [{ address: 0x1000n, size: 0x2000, permissions: 'rwx' }],
    writes: [{ address: 0x1000n, data: Uint8Array.from([0, 128, 255]) }],
    fills: [{ address: 0x2000n, length: 16, byte: 0xc3 }],
    registers: { rax: 0x1122334455667788n, rsp: 0x3000n },
    traps: [{ id: 12, address: 0xd0000cn }],
  });
  assert.equal(machine.vm, 7);
  assert.deepEqual(seen[0], {
    operation: 'create',
    regions: [{ address: '0000000000001000', size: 8192, permissions: 'rwx' }],
    writes: [{ address: '0000000000001000', data: 'AID/' }],
    fills: [{ address: '0000000000002000', length: 16, byte: 195 }],
    registers: { rax: '1122334455667788', rsp: '0000000000003000' },
    traps: [{ id: 12, address: '0000000000d0000c' }],
    version: 1,
  });
  assert.equal(encodeWord(0xffffffffffffffffn, 'word'), 'ffffffffffffffff');
  assert.equal(decodeWord('1122334455667788', 'word'), 0x1122334455667788n);
  assert.throws(() => encodeWord(Number.MAX_SAFE_INTEGER + 1, 'word'), /exact integer/);
  assert.throws(() => decodeWord('0x00000000000001', 'word'), HostX86Error);
});

test('host x86 adapter correlates inspection bytes and run trap/resume events', function () {
  const seen = [];
  let phase = 0;
  const machine = new NativeHostX86Provider(native((request) => {
    seen.push(request);
    if (request.operation === 'create') return { ok: true, vm: 1, state: 'ready' };
    if (request.operation === 'inspect') return {
      ok: true, vm: 1, state: 'paused', pauseToken: request.pauseToken,
      reads: [{ id: 4, data: 'AQID' }],
      registers: { rsp: '000000000030fff8' },
    };
    if (request.operation === 'run' && phase++ === 0) return {
      ok: true, vm: 1, state: 'paused', event: {
        kind: 'trap', trapId: 3, address: '0000000000d00003', pauseToken: 9,
        registers: { rax: '0000000000000000', rsp: '000000000030fff8' },
      },
    };
    return {
      ok: true, vm: 1, state: 'paused', event: {
        kind: 'until', address: '0000000000900000', pauseToken: 10,
        registers: { rax: '1122334455667788', rip: '0000000000900000' },
      },
    };
  })).create({ regions: [{ address: 0, size: 4096, permissions: 'rwx' }] });

  const trap = machine.start(0x1000n, 0x900000n, [], {
    instructionLimit: 500000000, timeoutMillis: 60000, trapLimit: 4096,
  });
  assert.equal(trap.kind, 'trap');
  assert.equal(trap.address, 0xd00003n);
  assert.equal(trap.registers.rsp, 0x30fff8n);

  const inspected = machine.inspect(9, [{ id: 4, address: 0x30fff8n, length: 3 }], ['rsp']);
  assert.deepEqual(inspected.reads[0].data, Uint8Array.from([1, 2, 3]));
  assert.equal(inspected.registers.rsp, 0x30fff8n);

  const complete = machine.resume(9, [
    { kind: 'set-registers', values: { rax: 0x1122334455667788n, rip: 0x1234n } },
    { kind: 'write', address: 0x2000n, data: Uint8Array.from([4, 5]) },
    { kind: 'copy', source: 0x2000n, destination: 0x3000n, length: 2 },
  ]);
  assert.equal(complete.kind, 'until');
  assert.equal(complete.pauseToken, 10);
  assert.equal(complete.registers.rax, 0x1122334455667788n);
  assert.deepEqual(seen.at(-1).effects, [
    { kind: 'set-registers', values: { rax: '1122334455667788', rip: '0000000000001234' } },
    { kind: 'write', address: '0000000000002000', data: 'BAU=' },
    { kind: 'copy', source: '0000000000002000', destination: '0000000000003000', length: 2 },
  ]);
  assert.equal(machine.inspect(10, [{ id: 4, address: 0x30fff8n, length: 3 }], ['rsp']).pauseToken, 10);

  const next = machine.start(0x2000n, 0x900000n, [], {
    instructionLimit: 1, timeoutMillis: 1, trapLimit: 1,
  });
  assert.equal(next.kind, 'until');
  assert.equal(seen.at(-1).pauseToken, 10);
});

test('host x86 adapter rejects malformed, uncorrelated, failed, and post-close operations', function () {
  assert.throws(() => new NativeHostX86Provider({}), /unavailable/);
  const throwing = new NativeHostX86Provider({ request() { throw new Error('native private detail'); } });
  assert.throws(() => throwing.create({
    regions: [{ address: 0, size: 4096, permissions: 'rw' }],
  }), error => error.code === 'HOST_X86_UNAVAILABLE' && !error.message.includes('private detail'));
  const invalid = new NativeHostX86Provider({ request() { return '{'; } });
  assert.throws(() => invalid.create({
    regions: [{ address: 0, size: 4096, permissions: 'rw' }],
  }), error => error.code === 'INVALID_RESPONSE');

  const failed = new NativeHostX86Provider(native(() => ({
    ok: false, code: 'RESOURCE_LIMIT', message: 'native detail',
  })));
  assert.throws(() => failed.create({
    regions: [{ address: 0, size: 4096, permissions: 'rw' }],
  }), error => error.code === 'RESOURCE_LIMIT' && !error.message.includes('native detail'));

  const machine = new NativeHostX86Provider(native((request) => (
    request.operation === 'create'
      ? { ok: true, vm: 2, state: 'ready' }
      : { ok: true, vm: 2, state: 'closed' }
  ))).create({ regions: [{ address: 0, size: 4096, permissions: 'rw' }] });
  assert.equal(machine.destroy(), true);
  assert.equal(machine.destroy(), false);
  assert.throws(() => machine.start(0, 1, [], {
    instructionLimit: 1, timeoutMillis: 1, trapLimit: 1,
  }), error => error.code === 'CLOSED');

  assert.throws(() => new NativeHostX86Provider(native(() => ({ ok: true, vm: 1, state: 'ready' }))).create({
    regions: [{ address: 0, size: 4096, permissions: 'write-only' }],
  }), /permissions/);
});

test('host x86 run faults and budgets remain structured without native detail leakage', function () {
  let run = 0;
  const machine = new NativeHostX86Provider(native((request) => {
    if (request.operation === 'create') return { ok: true, vm: 4, state: 'ready' };
    run += 1;
    return {
      ok: true, vm: 4, state: 'faulted', event: {
        kind: run === 1 ? 'budget' : 'fault', code: run === 1 ? 'INSTRUCTION_LIMIT' : 'MEMORY_FAULT',
        registers: { rip: '0000000000001000' },
      },
    };
  })).create({ regions: [{ address: 0x1000, size: 4096, permissions: 'rx' }] });
  const budget = machine.start(0x1000, 0x2000, [], {
    instructionLimit: 10, timeoutMillis: 10, trapLimit: 2,
  });
  assert.deepEqual({ kind: budget.kind, code: budget.code }, {
    kind: 'budget', code: 'INSTRUCTION_LIMIT',
  });
  assert.throws(() => machine.resume(1, []), error => error.code === 'INVALID_STATE');
});
