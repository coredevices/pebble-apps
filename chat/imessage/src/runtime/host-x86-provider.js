'use strict';

var bytes = require('./bytes');

var MAX_UINT64 = 0xffffffffffffffffn;
var MAX_INT = 0x7fffffff;
var MAX_RESPONSE_CHARS = 3 * 1024 * 1024;
var MAX_REQUEST_CHARS = 12 * 1024 * 1024;
var REGISTER_NAMES = Object.freeze([
  'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15', 'rip', 'eflags',
]);
var REGISTER_SET = Object.freeze(REGISTER_NAMES.reduce(function (result, name) {
  result[name] = true;
  return result;
}, Object.create(null)));

function HostX86Error(code, message) {
  Error.call(this, message);
  this.name = 'HostX86Error';
  this.code = code;
  this.message = message;
  if (Error.captureStackTrace) Error.captureStackTrace(this, HostX86Error);
}
HostX86Error.prototype = Object.create(Error.prototype);
HostX86Error.prototype.constructor = HostX86Error;

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(name + ' must be an object.');
  }
  return value;
}

function safeInt(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(name + ' is invalid.');
  }
  return value;
}

function responseInt(value, name, minimum, maximum) {
  try { return safeInt(value, name, minimum, maximum); }
  catch (_) { throw new HostX86Error('INVALID_RESPONSE', name + ' was invalid.'); }
}

function word(value, name) {
  var result;
  if (typeof value === 'bigint') result = value;
  else if (Number.isSafeInteger(value)) result = BigInt(value);
  else throw new TypeError(name + ' is not an exact integer.');
  if (result < 0n || result > MAX_UINT64) throw new TypeError(name + ' is outside uint64.');
  return result;
}

function encodeWord(value, name) {
  return word(value, name).toString(16).padStart(16, '0');
}

function decodeWord(value, name) {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) {
    throw new HostX86Error('INVALID_RESPONSE', name + ' was not canonical uint64 hex.');
  }
  return BigInt('0x' + value);
}

function registerName(value) {
  if (typeof value !== 'string' || !REGISTER_SET[value]) {
    throw new TypeError('Host x86 register name is unsupported.');
  }
  return value;
}

function encodeRegisters(value) {
  plainObject(value, 'Host x86 registers');
  var result = {};
  Object.keys(value).forEach(function (name) {
    result[registerName(name)] = encodeWord(value[name], 'Host x86 register value');
  });
  return result;
}

function decodeRegisters(value) {
  plainObject(value, 'Host x86 response registers');
  var result = {};
  Object.keys(value).forEach(function (name) {
    if (!REGISTER_SET[name]) throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned an unknown register.');
    result[name] = decodeWord(value[name], 'Host x86 register');
  });
  return Object.freeze(result);
}

function encodeData(value, name) {
  if (!(value instanceof Uint8Array)) throw new TypeError(name + ' must be bytes.');
  return bytes.bytesToBase64(value);
}

function decodeData(value, name) {
  if (typeof value !== 'string') throw new HostX86Error('INVALID_RESPONSE', name + ' was not base64.');
  try {
    var result = bytes.base64ToBytes(value);
    if (bytes.bytesToBase64(result) !== value) throw new Error('noncanonical');
    return result;
  } catch (_) {
    throw new HostX86Error('INVALID_RESPONSE', name + ' was not canonical base64.');
  }
}

function encodeRegions(regions) {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 32) {
    throw new TypeError('Host x86 regions are invalid.');
  }
  return regions.map(function (region) {
    plainObject(region, 'Host x86 region');
    if (!/^(r|rw|rx|rwx)$/.test(region.permissions)) {
      throw new TypeError('Host x86 region permissions are invalid.');
    }
    return {
      address: encodeWord(region.address, 'Host x86 region address'),
      size: safeInt(region.size, 'Host x86 region size', 1, 16 * 1024 * 1024),
      permissions: region.permissions,
    };
  });
}

function encodeWrites(writes, maximumBytes) {
  if (!Array.isArray(writes) || writes.length > 256) throw new TypeError('Host x86 writes are invalid.');
  var total = 0;
  return writes.map(function (write) {
    plainObject(write, 'Host x86 write');
    if (!(write.data instanceof Uint8Array)) throw new TypeError('Host x86 write data must be bytes.');
    total += write.data.length;
    if (total > maximumBytes) throw new TypeError('Host x86 writes exceed their byte limit.');
    return {
      address: encodeWord(write.address, 'Host x86 write address'),
      data: encodeData(write.data, 'Host x86 write data'),
    };
  });
}

function encodeFills(fills) {
  if (!Array.isArray(fills) || fills.length > 256) throw new TypeError('Host x86 fills are invalid.');
  return fills.map(function (fill) {
    plainObject(fill, 'Host x86 fill');
    return {
      address: encodeWord(fill.address, 'Host x86 fill address'),
      length: safeInt(fill.length, 'Host x86 fill length', 1, 16 * 1024 * 1024),
      byte: safeInt(fill.byte, 'Host x86 fill byte', 0, 255),
    };
  });
}

function encodeTraps(traps) {
  if (!Array.isArray(traps) || traps.length > 256) throw new TypeError('Host x86 traps are invalid.');
  var ids = Object.create(null);
  return traps.map(function (trap) {
    plainObject(trap, 'Host x86 trap');
    var id = safeInt(trap.id, 'Host x86 trap id', 0, MAX_INT);
    if (ids[id]) throw new TypeError('Host x86 trap ids must be unique.');
    ids[id] = true;
    return { id: id, address: encodeWord(trap.address, 'Host x86 trap address') };
  });
}

function encodeEffects(effects) {
  if (effects === undefined) return [];
  if (!Array.isArray(effects) || effects.length > 256) throw new TypeError('Host x86 effects are invalid.');
  var mutationBytes = 0;
  return effects.map(function (effect) {
    plainObject(effect, 'Host x86 effect');
    if (effect.kind === 'set-registers') {
      return { kind: effect.kind, values: encodeRegisters(effect.values) };
    }
    if (effect.kind === 'write') {
      if (!(effect.data instanceof Uint8Array)) throw new TypeError('Host x86 effect data must be bytes.');
      mutationBytes += effect.data.length;
      if (mutationBytes > 4 * 1024 * 1024) throw new TypeError('Host x86 effects exceed their byte limit.');
      return {
        kind: effect.kind,
        address: encodeWord(effect.address, 'Host x86 effect address'),
        data: encodeData(effect.data, 'Host x86 effect data'),
      };
    }
    if (effect.kind === 'fill') {
      var length = safeInt(effect.length, 'Host x86 fill length', 1, 4 * 1024 * 1024);
      mutationBytes += length;
      if (mutationBytes > 4 * 1024 * 1024) throw new TypeError('Host x86 effects exceed their byte limit.');
      return {
        kind: effect.kind,
        address: encodeWord(effect.address, 'Host x86 fill address'),
        length: length,
        byte: safeInt(effect.byte, 'Host x86 fill byte', 0, 255),
      };
    }
    if (effect.kind === 'copy') {
      var count = safeInt(effect.length, 'Host x86 copy length', 1, 4 * 1024 * 1024);
      mutationBytes += count;
      if (mutationBytes > 4 * 1024 * 1024) throw new TypeError('Host x86 effects exceed their byte limit.');
      return {
        kind: effect.kind,
        source: encodeWord(effect.source, 'Host x86 copy source'),
        destination: encodeWord(effect.destination, 'Host x86 copy destination'),
        length: count,
      };
    }
    throw new TypeError('Host x86 effect kind is unsupported.');
  });
}

function NativeHostX86Provider(nativeInterface) {
  if (!nativeInterface || typeof nativeInterface.request !== 'function') {
    throw new TypeError('Native host x86 interface is unavailable.');
  }
  this.native = nativeInterface;
}

NativeHostX86Provider.prototype._call = function (request) {
  request.version = 1;
  var rawRequest = JSON.stringify(request);
  if (rawRequest.length > MAX_REQUEST_CHARS) throw new TypeError('Host x86 request is too large.');
  var raw;
  try { raw = this.native.request(rawRequest); }
  catch (_) { throw new HostX86Error('HOST_X86_UNAVAILABLE', 'Host x86 operation failed.'); }
  if (typeof raw !== 'string' || raw.length > MAX_RESPONSE_CHARS) {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned an invalid response.');
  }
  var response;
  try { response = JSON.parse(raw); }
  catch (_) { throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned invalid JSON.'); }
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned an invalid response.');
  }
  if (response.ok !== true) {
    var code = typeof response.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(response.code)
      ? response.code : 'HOST_X86_ERROR';
    throw new HostX86Error(code, 'Host x86 operation failed.');
  }
  return response;
};

NativeHostX86Provider.prototype.create = function (plan) {
  plan = plainObject(plan, 'Host x86 creation plan');
  var request = {
    operation: 'create',
    regions: encodeRegions(plan.regions),
    writes: encodeWrites(plan.writes || [], 8 * 1024 * 1024),
    fills: encodeFills(plan.fills || []),
    registers: encodeRegisters(plan.registers || {}),
    traps: encodeTraps(plan.traps || []),
  };
  var response = this._call(request);
  var vm = responseInt(response.vm, 'Host x86 VM handle', 1, MAX_INT);
  if (response.state !== 'ready') throw new HostX86Error('INVALID_RESPONSE', 'Host x86 VM was not ready.');
  return new HostX86Machine(this, vm);
};

function HostX86Machine(provider, vm) {
  this.provider = provider;
  this.vm = vm;
  this.closed = false;
  this.state = 'ready';
  this.pauseToken = null;
  this.pauseKind = null;
}

HostX86Machine.prototype._requireOpen = function () {
  if (this.closed) throw new HostX86Error('CLOSED', 'Host x86 VM is closed.');
};

HostX86Machine.prototype.inspect = function (pauseToken, reads, registers) {
  this._requireOpen();
  if (this.state !== 'paused' || pauseToken !== this.pauseToken) {
    throw new HostX86Error('INVALID_STATE', 'Host x86 VM is not paused with that token.');
  }
  safeInt(pauseToken, 'Host x86 pause token', 1, MAX_INT);
  if (!Array.isArray(reads) || reads.length > 64) throw new TypeError('Host x86 reads are invalid.');
  if (!Array.isArray(registers) || registers.length > REGISTER_NAMES.length) {
    throw new TypeError('Host x86 register reads are invalid.');
  }
  var seen = Object.create(null);
  var encodedReads = reads.map(function (read) {
    plainObject(read, 'Host x86 read');
    var id = safeInt(read.id, 'Host x86 read id', 0, MAX_INT);
    if (seen[id]) throw new TypeError('Host x86 read ids must be unique.');
    seen[id] = true;
    return {
      id: id,
      address: encodeWord(read.address, 'Host x86 read address'),
      length: safeInt(read.length, 'Host x86 read length', 1, 1024 * 1024),
    };
  });
  var response = this.provider._call({
    operation: 'inspect', vm: this.vm, pauseToken: pauseToken,
    reads: encodedReads, registers: registers.map(registerName),
  });
  if (response.vm !== this.vm || response.state !== 'paused' || response.pauseToken !== pauseToken
      || !Array.isArray(response.reads) || response.reads.length !== encodedReads.length) {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 inspection did not match its request.');
  }
  var decodedReads = response.reads.map(function (read, index) {
    if (!read || read.id !== encodedReads[index].id) {
      throw new HostX86Error('INVALID_RESPONSE', 'Host x86 read response was not correlated.');
    }
    var data = decodeData(read.data, 'Host x86 read data');
    if (data.length !== encodedReads[index].length) {
      throw new HostX86Error('INVALID_RESPONSE', 'Host x86 read response had the wrong length.');
    }
    return Object.freeze({ id: read.id, data: data });
  });
  return Object.freeze({
    pauseToken: pauseToken,
    reads: Object.freeze(decodedReads),
    registers: decodeRegisters(response.registers),
  });
};

HostX86Machine.prototype._decodeRun = function (response) {
  if (response.vm !== this.vm || !response.event || typeof response.event !== 'object') {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 run response was not correlated.');
  }
  var event = response.event;
  if (['trap', 'until', 'budget', 'fault'].indexOf(event.kind) === -1) {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned an unknown event.');
  }
  var expectedState = event.kind === 'trap' || event.kind === 'until' ? 'paused' : 'faulted';
  if (response.state !== expectedState) {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 returned an inconsistent state.');
  }
  var result = { kind: event.kind, registers: decodeRegisters(event.registers || {}) };
  if (event.address !== undefined) result.address = decodeWord(event.address, 'Host x86 event address');
  if (event.kind === 'trap') {
    result.trapId = responseInt(event.trapId, 'Host x86 event trap id', 0, MAX_INT);
  }
  if (event.kind === 'trap' || event.kind === 'until') {
    result.pauseToken = responseInt(event.pauseToken, 'Host x86 event pause token', 1, MAX_INT);
    this.state = 'paused';
    this.pauseToken = result.pauseToken;
    this.pauseKind = event.kind;
  }
  if (event.kind === 'budget' || event.kind === 'fault') {
    result.code = typeof event.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(event.code)
      ? event.code : 'EXECUTION_FAILED';
    this.state = 'faulted';
    this.pauseToken = null;
    this.pauseKind = null;
  }
  return Object.freeze(result);
};

HostX86Machine.prototype.start = function (begin, until, effects, limits) {
  this._requireOpen();
  if (this.state !== 'ready' && !(this.state === 'paused' && this.pauseKind === 'until')) {
    throw new HostX86Error('INVALID_STATE', 'Host x86 VM cannot start a new entrypoint.');
  }
  limits = plainObject(limits, 'Host x86 execution limits');
  var request = {
    operation: 'run', vm: this.vm, mode: 'start',
    begin: encodeWord(begin, 'Host x86 start address'),
    until: encodeWord(until, 'Host x86 stop address'),
    effects: encodeEffects(effects),
    limits: {
      instructionLimit: safeInt(limits.instructionLimit, 'Host x86 instruction limit', 1, 500000000),
      timeoutMillis: safeInt(limits.timeoutMillis, 'Host x86 timeout', 1, 180000),
      trapLimit: safeInt(limits.trapLimit, 'Host x86 trap limit', 1, 4096),
    },
  };
  if (this.pauseToken !== null) request.pauseToken = this.pauseToken;
  var response = this.provider._call(request);
  return this._decodeRun(response);
};

HostX86Machine.prototype.resume = function (pauseToken, effects) {
  this._requireOpen();
  if (this.state !== 'paused' || this.pauseKind !== 'trap' || pauseToken !== this.pauseToken) {
    throw new HostX86Error('INVALID_STATE', 'Host x86 VM cannot resume with that token.');
  }
  safeInt(pauseToken, 'Host x86 pause token', 1, MAX_INT);
  var response = this.provider._call({
    operation: 'run', vm: this.vm, mode: 'resume', pauseToken: pauseToken,
    effects: encodeEffects(effects),
  });
  return this._decodeRun(response);
};

HostX86Machine.prototype.destroy = function () {
  if (this.closed) return false;
  var response = this.provider._call({ operation: 'destroy', vm: this.vm });
  if (response.vm !== this.vm || response.state !== 'closed') {
    throw new HostX86Error('INVALID_RESPONSE', 'Host x86 did not close the requested VM.');
  }
  this.closed = true;
  this.state = 'closed';
  this.pauseToken = null;
  this.pauseKind = null;
  return true;
};

module.exports = {
  HostX86Error: HostX86Error,
  HostX86Machine: HostX86Machine,
  NativeHostX86Provider: NativeHostX86Provider,
  REGISTER_NAMES: REGISTER_NAMES,
  decodeWord: decodeWord,
  encodeWord: encodeWord,
};
