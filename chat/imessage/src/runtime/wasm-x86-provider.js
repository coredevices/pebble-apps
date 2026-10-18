'use strict';

var createBlink = typeof WebAssembly === 'object' && typeof WebAssembly.Tag === 'function'
  ? require('./generated/blink-wasm')
  : require('./generated/blink-wasm-legacy');
var host = require('./host-x86-provider');
var bytes = require('./bytes');
var NAMES = host.REGISTER_NAMES;
var CHUNK = 1024 * 1024;
var PERMISSIONS = { r: 1, rw: 3, rx: 5, rwx: 7 };

function fail(code) { throw new host.HostX86Error(code, 'Wasm x86 operation failed.'); }
function word(value) { return BigInt('0x' + value); }
function hex(value) { return value.toString(16).padStart(16, '0'); }

function WasmSession(plan, randomBytes) {
  var regions = plan.regions.map(function (r) {
    return { address: word(r.address), size: r.size, permissions: r.permissions };
  }).sort(function (a, b) { return a.address < b.address ? -1 : 1; });
  var total = 0;
  regions.forEach(function (r, i) {
    total += r.size;
    if (r.address % 4096n || r.size % 4096 || r.address + BigInt(r.size) > 0x10000000000000000n
        || (i && regions[i - 1].address + BigInt(regions[i - 1].size) > r.address)) fail('INVALID_REQUEST');
  });
  if (total > 64 * CHUNK) fail('LIMIT_EXCEEDED');
  this.regions = regions;
  this.traps = plan.traps;
  this.state = 'ready';
  this.token = 0;
  this.active = null;
  this.module = createBlink({ randomBytes: randomBytes, print: function () {}, printErr: function () {} });
  this.buffer = this.module._malloc(CHUNK);
  if (!this.buffer) fail('OUT_OF_MEMORY');
  try {
    this.check(this.module._pebble_x86_create(this.buffer));
    this.handle = this.module.HEAPU32[this.buffer / 4];
    var self = this;
    regions.forEach(function (r) { self.check(self.module._pebble_x86_map(self.handle, r.address, BigInt(r.size), PERMISSIONS[r.permissions])); });
    (plan.writes || []).forEach(function (w) { self.write(word(w.address), bytes.base64ToBytes(w.data), true); });
    (plan.fills || []).forEach(function (f) { self.fill(word(f.address), f.length, f.byte, true); });
    this.setRegisters(plan.registers);
    this.traps.forEach(function (t) { self.range(word(t.address), 1, 'x'); });
  } catch (e) { this.close(); throw e; }
}
WasmSession.prototype.check = function (status) {
  if (status) fail(['OK', 'INVALID_REQUEST', 'LIMIT_EXCEEDED', 'OUT_OF_MEMORY', 'BACKEND_FAULT', 'BACKEND_FAULT'][status] || 'BACKEND_FAULT');
};
WasmSession.prototype.view = function () { return new DataView(this.module.HEAPU8.buffer); };
WasmSession.prototype.range = function (address, length, permission) {
  if (length < 1 || !this.regions.some(function (r) {
    return address >= r.address && address + BigInt(length) <= r.address + BigInt(r.size)
      && (!permission || r.permissions.includes(permission));
  })) fail('INVALID_REQUEST');
};
WasmSession.prototype.write = function (address, data, initializing) {
  this.range(address, data.length, initializing ? null : 'w');
  for (var offset = 0; offset < data.length; offset += CHUNK) {
    var part = data.subarray(offset, offset + CHUNK);
    this.module.HEAPU8.set(part, this.buffer);
    this.check(this.module._pebble_x86_write(this.handle, address + BigInt(offset), this.buffer, BigInt(part.length)));
  }
  this.module.HEAPU8.fill(0, this.buffer, this.buffer + CHUNK);
};
WasmSession.prototype.read = function (address, length) {
  this.range(address, length, 'r');
  var result = new Uint8Array(length);
  for (var offset = 0; offset < length; offset += CHUNK) {
    var count = Math.min(CHUNK, length - offset);
    this.check(this.module._pebble_x86_read(this.handle, address + BigInt(offset), this.buffer, BigInt(count)));
    result.set(this.module.HEAPU8.subarray(this.buffer, this.buffer + count), offset);
  }
  this.module.HEAPU8.fill(0, this.buffer, this.buffer + CHUNK);
  return result;
};
WasmSession.prototype.fill = function (address, length, value, initializing) {
  this.range(address, length, initializing ? null : 'w');
  var data = new Uint8Array(Math.min(length, CHUNK)).fill(value);
  for (var offset = 0; offset < length; offset += CHUNK) this.write(address + BigInt(offset), data.subarray(0, Math.min(CHUNK, length - offset)), initializing);
};
WasmSession.prototype.setRegisters = function (registers) {
  var self = this;
  Object.keys(registers).forEach(function (name) {
    var id = NAMES.indexOf(name) + 1;
    if (!id) fail('INVALID_REQUEST');
    var view = self.view();
    view.setUint32(self.buffer, id, true);
    view.setBigUint64(self.buffer + 8, word(registers[name]), true);
    self.check(self.module._pebble_x86_write_registers(self.handle, self.buffer, self.buffer + 8, 1));
  });
};
WasmSession.prototype.registers = function (names) {
  var self = this, result = {};
  names.forEach(function (name) {
    var id = NAMES.indexOf(name) + 1;
    if (!id) fail('INVALID_REQUEST');
    self.view().setUint32(self.buffer, id, true);
    self.check(self.module._pebble_x86_read_registers(self.handle, self.buffer, self.buffer + 8, 1));
    result[name] = hex(self.view().getBigUint64(self.buffer + 8, true));
  });
  return result;
};
WasmSession.prototype.effects = function (effects) {
  var self = this;
  effects.forEach(function (e) {
    if (e.kind === 'set-registers') self.setRegisters(e.values);
    else if (e.kind === 'write') self.write(word(e.address), bytes.base64ToBytes(e.data));
    else if (e.kind === 'fill') self.fill(word(e.address), e.length, e.byte);
    else if (e.kind === 'copy') {
      var data = self.read(word(e.source), e.length);
      try { self.write(word(e.destination), data); } finally { data.fill(0); }
    } else fail('INVALID_REQUEST');
  });
};
WasmSession.prototype.run = function (request) {
  if (request.mode === 'start') {
    if (!(this.state === 'ready' || (this.state === 'paused' && !this.active && request.pauseToken === this.token))) fail('INVALID_STATE');
    this.range(word(request.begin), 1, 'x');
    this.range(word(request.until), 1, 'x');
    this.active = { until: word(request.until), remaining: request.limits.instructionLimit,
      deadline: Date.now() + request.limits.timeoutMillis, traps: 0, trapLimit: request.limits.trapLimit };
  } else if (this.state !== 'paused' || !this.active || request.pauseToken !== this.token) fail('INVALID_STATE');
  var a = this.active;
  if (Date.now() >= a.deadline) return this.stop('budget', 'TIME_LIMIT');
  if (a.remaining <= 0) return this.stop('budget', 'INSTRUCTION_LIMIT');
  this.state = 'running';
  try {
    this.effects(request.effects || []);
    var exits = this.traps.map(function (t) { return word(t.address); }).concat([a.until]);
    var view = this.view(), buffer = this.buffer;
    exits.forEach(function (address, i) { view.setBigUint64(buffer + i * 8, address, true); });
    this.check(this.module._pebble_x86_set_exits(this.handle, buffer, exits.length));
    var begin = request.mode === 'start' ? word(request.begin) : word(this.registers(['rip']).rip);
    var status = this.module._pebble_x86_run(this.handle, begin, 0n,
      BigInt(Math.max(1, a.deadline - Date.now())) * 1000n, BigInt(a.remaining), buffer);
    if (status) return this.stop('fault', 'BACKEND_FAULT');
    view = this.view();
    var reason = view.getUint32(buffer, true), address = view.getBigUint64(buffer + 8, true);
    var count = Number(view.getBigUint64(buffer + 16, true));
    if (!Number.isSafeInteger(count) || count > a.remaining) fail('BACKEND_FAULT');
    a.remaining -= count;
    if (reason === 3) return this.stop('budget', 'TIME_LIMIT');
    if (reason === 4) return this.stop('budget', 'INSTRUCTION_LIMIT');
    if (reason !== 2) return this.stop('fault', 'BACKEND_FAULT');
    var registers = this.registers(NAMES);
    if (address === a.until) {
      this.active = null; this.state = 'paused';
      return { kind: 'until', address: hex(address), registers: registers, pauseToken: ++this.token };
    }
    var trap = this.traps.find(function (t) { return word(t.address) === address; });
    if (!trap) return this.stop('fault', 'UNEXPECTED_EXIT');
    if (++a.traps > a.trapLimit) return this.stop('budget', 'TRAP_LIMIT');
    this.state = 'paused';
    return { kind: 'trap', address: hex(address), trapId: trap.id, registers: registers, pauseToken: ++this.token };
  } catch (e) { this.state = 'faulted'; this.active = null; throw e; }
};
WasmSession.prototype.stop = function (kind, code) {
  this.state = 'faulted'; this.active = null;
  return { kind: kind, code: code };
};
WasmSession.prototype.close = function () {
  if (!this.module) return;
  try { if (this.handle) this.module._pebble_x86_destroy(this.handle); }
  finally {
    this.module.HEAPU8.fill(0);
    this.module = null; this.buffer = 0; this.handle = 0; this.state = 'closed';
  }
};

function WasmHostX86Provider(options) {
  if (!options || typeof options.randomBytes !== 'function') throw new TypeError('Secure randomness is required.');
  var sessions = new Map(), nextId = 0;
  host.NativeHostX86Provider.call(this, { request: function (raw) {
    var r = JSON.parse(raw), s;
    try {
      if (r.operation === 'create') {
        if (sessions.size >= 2) fail('LIMIT_EXCEEDED');
        s = new WasmSession(r, options.randomBytes);
        var id = ++nextId; sessions.set(id, s);
        return JSON.stringify({ ok: true, vm: id, state: 'ready' });
      }
      s = sessions.get(r.vm);
      if (!s) fail('INVALID_HANDLE');
      if (r.operation === 'destroy') {
        s.close(); sessions.delete(r.vm);
        return JSON.stringify({ ok: true, vm: r.vm, state: 'closed' });
      }
      if (r.operation === 'run') {
        var event = s.run(r);
        return JSON.stringify({ ok: true, vm: r.vm, state: s.state, event: event });
      }
      if (r.operation !== 'inspect' || s.state !== 'paused' || r.pauseToken !== s.token) fail('INVALID_STATE');
      var total = 0;
      var reads = r.reads.map(function (read) {
        total += read.length;
        if (total > CHUNK) fail('LIMIT_EXCEEDED');
        var data = s.read(word(read.address), read.length);
        try { return { id: read.id, data: bytes.bytesToBase64(data) }; } finally { data.fill(0); }
      });
      return JSON.stringify({ ok: true, vm: r.vm, state: 'paused', pauseToken: s.token,
        reads: reads, registers: s.registers(r.registers) });
    } catch (e) {
      return JSON.stringify({ ok: false, code: e.code || 'BACKEND_FAULT' });
    }
  }});
  this.close = function () { sessions.forEach(function (session) { session.close(); }); sessions.clear(); };
}
WasmHostX86Provider.prototype = Object.create(host.NativeHostX86Provider.prototype);
WasmHostX86Provider.prototype.constructor = WasmHostX86Provider;
module.exports = { WasmHostX86Provider: WasmHostX86Provider };
