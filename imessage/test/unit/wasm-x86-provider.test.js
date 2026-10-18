'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { WasmHostX86Provider } = require('../../src/runtime/wasm-x86-provider');
const limits = { instructionLimit: 1000, timeoutMillis: 1000, trapLimit: 10 };
const CODE = 0x10000n, DATA = 0x20000n;
function machine(t, code, extra = {}) {
  const p = new WasmHostX86Provider({ randomBytes: n => new Uint8Array(randomBytes(n)) });
  t.after(() => p.close());
  return p.create({ regions: [{ address: CODE, size: 4096, permissions: 'rx' }, { address: DATA, size: 4096, permissions: 'rw' }],
    writes: [{ address: CODE, data: Uint8Array.from(code) }], ...extra });
}
test('Wasm arithmetic preserves 64-bit registers and closes idempotently', t => {
  const m = machine(t, [0x48,0xc7,0xc0,20,0,0,0,0x48,0x83,0xc0,22]);
  const r = m.start(CODE, CODE+11n, [], limits);
  assert.equal(r.kind, 'until'); assert.equal(r.registers.rax, 42n);
  assert.equal(m.inspect(r.pauseToken, [], ['rax']).registers.rax, 42n);
  assert.equal(m.destroy(), true); assert.equal(m.destroy(), false);
});
test('Wasm stops before a trap and resumes after JS register effects', t => {
  const m = machine(t, [0x90,0x48,0x83,0xc0,1,0x90], { traps: [{ id: 7, address: CODE }] });
  const r = m.start(CODE, CODE+5n, [], limits);
  assert.equal(r.kind, 'trap'); assert.equal(r.trapId, 7);
  assert.throws(() => m.resume(r.pauseToken+1, []));
  const done = m.resume(r.pauseToken, [{ kind: 'set-registers', values: { rip: CODE+1n, rax: 41n } }]);
  assert.equal(done.kind,'until'); assert.equal(done.registers.rax,42n);
});
test('Wasm enforces instruction budgets and invalidates faulted machines', t => {
  const m=machine(t,[0xeb,0xfe]);
  const r=m.start(CODE,CODE+2n,[],{...limits,instructionLimit:10});
  assert.equal(r.kind,'budget'); assert.equal(r.code,'INSTRUCTION_LIMIT');
  assert.throws(()=>m.start(CODE,CODE+2n,[],limits));
});
test('Wasm applies write, overlapping copy and fill effects', t => {
  const m=machine(t,[0x90]);
  const r=m.start(CODE,CODE+1n,[{kind:'write',address:DATA,data:Uint8Array.from([1,2,3,4])},
    {kind:'copy',source:DATA,destination:DATA+1n,length:4},{kind:'fill',address:DATA+5n,length:2,byte:9}],limits);
  assert.deepEqual(Array.from(m.inspect(r.pauseToken,[{id:0,address:DATA,length:7}],[]).reads[0].data),[1,1,2,3,4,9,9]);
});
test('Wasm denies host writes to executable read-only regions', t => {
  const m=machine(t,[0x90]);
  assert.throws(()=>m.start(CODE,CODE+1n,[{kind:'write',address:CODE,data:Uint8Array.of(0x90)}],limits));
});
test('Wasm contains invalid guest instructions and guest writes to code', t => {
  for(const code of [[0x0f,0x0b],[0xc6,0x05,0xf9,0xff,0xff,0xff,0x90]]) {
    const m=machine(t,code);
    assert.equal(m.start(CODE,CODE+BigInt(code.length),[],limits).kind,'fault');
  }
});
test('Wasm contains guest syscalls', t => {
  const m=machine(t,[0x0f,0x05]);
  assert.equal(m.start(CODE,CODE+2n,[],limits).kind,'fault');
});
test('Wasm rejects overlapping regions', t => {
  assert.throws(()=>machine(t,[0x90],{regions:[{address:CODE,size:4096,permissions:'rx'},{address:CODE,size:4096,permissions:'rw'}]}));
});
test('Wasm tracks instruction budgets across trap resumes', t => {
  const m=machine(t,[0x90,0xeb,0xfd],{traps:[{id:0,address:CODE+1n}]});
  const r=m.start(CODE,CODE+3n,[],{...limits,instructionLimit:1});
  assert.equal(r.kind,'trap');
  const done=m.resume(r.pauseToken,[]);assert.equal(done.kind,'budget');assert.equal(done.code,'INSTRUCTION_LIMIT');
});
test('Wasm tracks trap counts across resumes', t => {
  const m=machine(t,[0x90],{traps:[{id:0,address:CODE}]});
  const r=m.start(CODE,CODE+1n,[],{...limits,trapLimit:1});
  const done=m.resume(r.pauseToken,[]);assert.equal(done.kind,'budget');assert.equal(done.code,'TRAP_LIMIT');
});
test('Wasm finds unsorted exits and skips addresses between them', t => {
  const m = machine(t, [0x90,0x90,0x90,0x90,0x90], {
    traps: [{id: 9, address: CODE+4n}, {id: 2, address: CODE+1n}],
  });
  const first = m.start(CODE, CODE+5n, [], limits);
  assert.equal(first.trapId, 2);
  const second = m.resume(first.pauseToken, [{kind:'set-registers',values:{rip:CODE+2n}}]);
  assert.equal(second.trapId, 9);
  const done = m.resume(second.pauseToken, [{kind:'set-registers',values:{rip:CODE+5n}}]);
  assert.equal(done.kind, 'until');
});
test('Wasm limits live instances and releases a slot on destruction', t => {
  const p = new WasmHostX86Provider({randomBytes: n => new Uint8Array(randomBytes(n))});
  t.after(() => p.close());
  const plan = {regions:[{address:CODE,size:4096,permissions:'rx'}]};
  const first = p.create(plan);
  p.create(plan);
  assert.throws(() => p.create(plan), e => e.code === 'LIMIT_EXCEEDED');
  first.destroy();
  assert.doesNotThrow(() => p.create(plan));
});
