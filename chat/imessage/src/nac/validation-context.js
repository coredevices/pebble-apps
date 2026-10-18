'use strict';

var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var foundationModule = require('./emulated-foundation');
var machoImports = require('./macho-imports');

var PAGE_SIZE = 0x1000;
var STACK_BASE = 0x300000;
var STACK_SIZE = 0x100000;
var STOP_ADDRESS = 0x900000;
var HOOK_SIZE = 0x1000;
var NAC_INIT_ADDRESS = 0xb1db0;
var NAC_ESTABLISH_ADDRESS = 0xb1dd0;
var NAC_SIGN_ADDRESS = 0xb1df0;
var MAX_CERTIFICATE_CHAIN_BYTES = 1024 * 1024;
var MAX_SESSION_RESPONSE_BYTES = 1024 * 1024;
var MAX_NATIVE_OUTPUT_BYTES = 1024 * 1024;
var EXECUTION_INSTRUCTION_LIMIT = 500000000;
// Older iPhones need more time for the interpreted one-time validation.
var EXECUTION_TIMEOUT_MILLIS = 180000;
var EXECUTION_TRAP_LIMIT = 4096;
var ARGUMENT_REGISTERS = Object.freeze(['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']);

function contextError(code, message, kind, details) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.INTERNAL,
    details: details,
  });
}

function executionError(error) {
  if (error instanceof RuntimeError) return error;
  return contextError('NAC_EXECUTOR_FAILED', 'The bounded x86-64 executor failed.');
}

function requireBytes(value, name, maximum) {
  if (!(value instanceof Uint8Array) || value.length === 0 || value.length > maximum) {
    throw contextError('NAC_INPUT_INVALID', 'The NAC ' + name + ' is invalid.', ERROR_KINDS.INVALID_INPUT);
  }
  return new Uint8Array(value);
}

function requireMachineProvider(provider) {
  if (!provider || typeof provider.create !== 'function') {
    throw new TypeError('NAC x86-64 machine provider is unavailable.');
  }
  return provider;
}

function requireMachine(machine) {
  if (!machine || typeof machine.start !== 'function' || typeof machine.resume !== 'function'
      || typeof machine.inspect !== 'function' || typeof machine.destroy !== 'function') {
    throw new TypeError('NAC x86-64 machine is invalid.');
  }
  return machine;
}

function roundUpPage(length) {
  if (!Number.isSafeInteger(length) || length <= 0 || length > STACK_BASE) {
    throw contextError('NAC_IMAGE_INVALID', 'The NAC x86-64 image size is invalid.', ERROR_KINDS.INVALID_INPUT);
  }
  var rounded = Math.ceil(length / PAGE_SIZE) * PAGE_SIZE;
  if (rounded > STACK_BASE) {
    throw contextError('NAC_IMAGE_INVALID', 'The NAC x86-64 image overlaps reserved memory.', ERROR_KINDS.INVALID_INPUT);
  }
  return rounded;
}

function uint64Bytes(value) {
  if (typeof value === 'number') value = BigInt(value);
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) {
    throw new TypeError('NAC uint64 value is invalid.');
  }
  var result = new Uint8Array(8);
  for (var index = 0; index < result.length; index += 1) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return result;
}

function readUint64(value) {
  if (!(value instanceof Uint8Array) || value.length !== 8) {
    throw contextError('NAC_MEMORY_FAULT', 'The NAC executor returned a malformed word.');
  }
  var result = 0n;
  for (var index = 7; index >= 0; index -= 1) result = (result << 8n) | BigInt(value[index]);
  return result;
}

function requireWord(value, name) {
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned an invalid ' + name + '.');
  }
  return value;
}

function requirePauseToken(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned an invalid pause token.');
  }
  return value;
}

function requireEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)
      || ['trap', 'until', 'budget', 'fault'].indexOf(event.kind) === -1
      || !event.registers || typeof event.registers !== 'object' || Array.isArray(event.registers)) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned an invalid event.');
  }
  return event;
}

function register(event, name) {
  return requireWord(event.registers[name], name + ' register');
}

function makeWrite(address, data) {
  return Object.freeze({
    kind: 'write',
    address: typeof address === 'bigint' ? address : BigInt(address),
    data: new Uint8Array(data),
  });
}

function makeRegisterEffect(values) {
  return Object.freeze({ kind: 'set-registers', values: Object.freeze(values) });
}

function inspect(machine, pauseToken, reads, registers) {
  var result;
  try { result = machine.inspect(pauseToken, reads, registers); }
  catch (error) { throw executionError(error); }
  if (!result || typeof result !== 'object' || result.pauseToken !== pauseToken
      || !Array.isArray(result.reads) || !result.registers || typeof result.registers !== 'object') {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned invalid inspection data.');
  }
  return result;
}

function inspectRead(machine, pauseToken, address, length) {
  if (typeof address !== 'bigint' || address < 0n || address > 0xffffffffffffffffn
      || !Number.isSafeInteger(length) || length < 0 || length > MAX_NATIVE_OUTPUT_BYTES) {
    throw contextError('NAC_MEMORY_FAULT', 'The NAC memory read is invalid.');
  }
  if (length === 0) return new Uint8Array(0);
  var result = inspect(machine, pauseToken, [Object.freeze({
    id: 0,
    address: address,
    length: length,
  })], []);
  if (result.reads.length !== 1 || result.reads[0].id !== 0
      || !(result.reads[0].data instanceof Uint8Array) || result.reads[0].data.length !== length) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned an invalid memory read.');
  }
  return new Uint8Array(result.reads[0].data);
}

function buildMachinePlan(image) {
  var binary = new Uint8Array(image);
  var imageSize = roundUpPage(binary.length);
  var hookAddresses = foundationModule.createHookAddresses();
  var bindings = machoImports.buildImportBindings(
    binary, hookAddresses, foundationModule.UNSUPPORTED_IMPORT_HOOK_ADDRESS
  );
  var writes = [Object.freeze({ address: 0n, data: binary })];
  bindings.forEach(function (binding) {
    writes.push(Object.freeze({
      address: BigInt(binding.offset),
      data: uint64Bytes(binding.address),
    }));
  });
  var traps = foundationModule.HOOK_SYMBOLS.map(function (_, index) {
    return Object.freeze({ id: index, address: BigInt(foundationModule.HOOK_BASE + index) });
  });
  traps.push(Object.freeze({
    id: foundationModule.HOOK_SYMBOLS.length,
    address: BigInt(foundationModule.UNSUPPORTED_IMPORT_HOOK_ADDRESS),
  }));
  return Object.freeze({
    regions: Object.freeze([
      Object.freeze({ address: 0n, size: imageSize, permissions: 'rwx' }),
      Object.freeze({ address: BigInt(foundationModule.HOOK_BASE), size: HOOK_SIZE, permissions: 'rwx' }),
      Object.freeze({ address: BigInt(STACK_BASE), size: STACK_SIZE, permissions: 'rwx' }),
      Object.freeze({ address: BigInt(foundationModule.HEAP_BASE), size: foundationModule.HEAP_SIZE, permissions: 'rwx' }),
      Object.freeze({ address: BigInt(STOP_ADDRESS), size: PAGE_SIZE, permissions: 'rwx' }),
    ]),
    writes: Object.freeze(writes),
    fills: Object.freeze([
      Object.freeze({ address: BigInt(foundationModule.HOOK_BASE), length: HOOK_SIZE, byte: 0xc3 }),
      Object.freeze({ address: BigInt(STOP_ADDRESS), length: PAGE_SIZE, byte: 0xc3 }),
    ]),
    registers: Object.freeze({
      rsp: BigInt(STACK_BASE + STACK_SIZE),
      rbp: BigInt(STACK_BASE + STACK_SIZE),
    }),
    traps: Object.freeze(traps),
  });
}

function ValidationContext(machine, foundation, sessionInfoRequest, validationContextAddress) {
  this.machine = machine;
  this.foundation = foundation;
  this.sessionInfoRequest = new Uint8Array(sessionInfoRequest);
  this.validationContextAddress = validationContextAddress;
  this.stackPointer = BigInt(STACK_BASE + STACK_SIZE);
  this.lastPauseToken = null;
  this.phase = 'initialized';
}

ValidationContext.prototype._destroyAfterFailure = function () {
  if (!this.machine) return;
  var machine = this.machine;
  this.machine = null;
  this.phase = 'destroyed';
  try { machine.destroy(); } catch (_) { /* Preserve the original failure. */ }
};

ValidationContext.prototype.destroy = function () {
  if (!this.machine) return;
  var machine = this.machine;
  try { machine.destroy(); }
  catch (error) { throw executionError(error); }
  this.machine = null;
  this.phase = 'destroyed';
};

ValidationContext.prototype._requirePhase = function (phase) {
  if (!this.machine || this.phase !== phase) {
    throw contextError('NAC_CONTEXT_STATE', 'The NAC validation context is not in the required state.');
  }
};

ValidationContext.prototype._resume = function (event, effects) {
  var resumed;
  try { resumed = this.machine.resume(requirePauseToken(event.pauseToken), effects); }
  catch (error) { throw executionError(error); }
  return requireEvent(resumed);
};

ValidationContext.prototype._serviceTrap = function (event) {
  var trapId = event.trapId;
  if (!Number.isSafeInteger(trapId) || trapId < 0
      || trapId > foundationModule.HOOK_SYMBOLS.length) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned an invalid trap.');
  }
  var expectedAddress = BigInt(foundationModule.HOOK_BASE + trapId);
  if (requireWord(event.address, 'trap address') !== expectedAddress) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor returned a mismatched trap.');
  }
  if (trapId === foundationModule.HOOK_SYMBOLS.length) {
    throw contextError('NAC_HOOK_UNSUPPORTED', 'The NAC image called an unsupported executable import.');
  }

  var pauseToken = requirePauseToken(event.pauseToken);
  var args = ARGUMENT_REGISTERS.map(function (name) { return register(event, name); });
  var stackPointer = register(event, 'rsp');
  if (stackPointer < BigInt(STACK_BASE)
      || stackPointer > BigInt(STACK_BASE + STACK_SIZE - 8)) {
    throw contextError('NAC_MEMORY_FAULT', 'The NAC hook stack pointer is out of bounds.');
  }
  var effects = [];
  var memory = {
    read: function (address, length) {
      if (!Number.isSafeInteger(address) || address < 0) {
        throw contextError('NAC_MEMORY_FAULT', 'The NAC hook memory address is invalid.');
      }
      return inspectRead(this.machine, pauseToken, BigInt(address), length);
    }.bind(this),
    write: function (address, value) {
      if (!Number.isSafeInteger(address) || address < 0 || !(value instanceof Uint8Array)) {
        throw contextError('NAC_MEMORY_FAULT', 'The NAC hook memory write is invalid.');
      }
      if (value.length > 0) effects.push(makeWrite(address, value));
    },
  };
  var returnValue = this.foundation.invoke(foundationModule.HOOK_SYMBOLS[trapId], args, memory);
  var returnAddress = readUint64(inspectRead(this.machine, pauseToken, stackPointer, 8));
  var registerValues = {
    rip: returnAddress,
    rsp: stackPointer + 8n,
  };
  if (returnValue !== undefined) registerValues.rax = requireWord(returnValue, 'hook result');
  effects.push(makeRegisterEffect(registerValues));
  return this._resume(event, effects);
};

ValidationContext.prototype._call = function (entrypoint, args, initialEffects) {
  if (!this.machine) throw contextError('NAC_CONTEXT_STATE', 'The NAC validation context was destroyed.');
  if (!Array.isArray(args) || args.length > ARGUMENT_REGISTERS.length) {
    throw new TypeError('NAC native arguments are invalid.');
  }
  var baseStackPointer = this.stackPointer;
  if (baseStackPointer < BigInt(STACK_BASE + 8)
      || baseStackPointer > BigInt(STACK_BASE + STACK_SIZE)) {
    throw contextError('NAC_MEMORY_FAULT', 'The NAC call stack is out of bounds.');
  }
  var callStackPointer = baseStackPointer - 8n;
  var registers = { rsp: callStackPointer };
  args.forEach(function (value, index) {
    registers[ARGUMENT_REGISTERS[index]] = typeof value === 'bigint' ? value : BigInt(value);
  });
  var effects = (initialEffects || []).slice();
  effects.push(makeWrite(callStackPointer, uint64Bytes(STOP_ADDRESS)));
  effects.push(makeRegisterEffect(registers));

  var event;
  try {
    event = requireEvent(this.machine.start(
      BigInt(entrypoint),
      BigInt(STOP_ADDRESS),
      effects,
      Object.freeze({
        instructionLimit: EXECUTION_INSTRUCTION_LIMIT,
        timeoutMillis: EXECUTION_TIMEOUT_MILLIS,
        trapLimit: EXECUTION_TRAP_LIMIT,
      })
    ));
  } catch (error) {
    throw executionError(error);
  }

  var traps = 0;
  while (event.kind === 'trap') {
    traps += 1;
    if (traps > EXECUTION_TRAP_LIMIT) {
      throw contextError('NAC_EXECUTION_LIMIT', 'The NAC execution trap limit was exceeded.', ERROR_KINDS.TIMEOUT);
    }
    event = this._serviceTrap(event);
  }
  if (event.kind === 'budget') {
    throw contextError('NAC_EXECUTION_LIMIT', 'The NAC execution budget was exhausted.', ERROR_KINDS.TIMEOUT);
  }
  if (event.kind === 'fault') {
    throw contextError('NAC_EXECUTION_FAULT', 'The NAC x86-64 image faulted during execution.');
  }
  if (event.kind !== 'until' || requireWord(event.address, 'stop address') !== BigInt(STOP_ADDRESS)) {
    throw contextError('NAC_EXECUTOR_INVALID', 'The NAC executor stopped at an unexpected address.');
  }
  requirePauseToken(event.pauseToken);
  this.lastPauseToken = event.pauseToken;
  var returnedStackPointer = register(event, 'rsp');
  if (returnedStackPointer !== baseStackPointer) {
    throw contextError('NAC_MEMORY_FAULT', 'The NAC native call did not restore its stack.');
  }
  this.stackPointer = returnedStackPointer;
  var result = register(event, 'rax');
  if (result !== 0n) {
    var low = Number(result & 0xffffffffn);
    var signed = low >= 0x80000000 ? low - 0x100000000 : low;
    throw contextError('NAC_NATIVE_ERROR', 'The NAC image rejected the operation.', ERROR_KINDS.INTERNAL, {
      status: -signed,
    });
  }
  return event;
};

ValidationContext.prototype._readOutput = function (event, pointerAddress, lengthAddress, name) {
  var pauseToken = requirePauseToken(event.pauseToken);
  var pointer = readUint64(inspectRead(this.machine, pauseToken, pointerAddress, 8));
  var rawLength = readUint64(inspectRead(this.machine, pauseToken, lengthAddress, 8));
  if (rawLength === 0n || rawLength > BigInt(MAX_NATIVE_OUTPUT_BYTES)) {
    throw contextError('NAC_NATIVE_OUTPUT_INVALID', 'The NAC ' + name + ' length is invalid.');
  }
  if (pointer === 0n || pointer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw contextError('NAC_NATIVE_OUTPUT_INVALID', 'The NAC ' + name + ' pointer is invalid.');
  }
  return inspectRead(this.machine, pauseToken, pointer, Number(rawLength));
};

ValidationContext.prototype.establish = function (sessionInfoResponse) {
  this._requirePhase('initialized');
  try {
    var response = requireBytes(sessionInfoResponse, 'session-info response', MAX_SESSION_RESPONSE_BYTES);
    var responseAddress = this.foundation.allocate(response.length);
    this._call(NAC_ESTABLISH_ADDRESS, [
      this.validationContextAddress,
      responseAddress,
      BigInt(response.length),
    ], [makeWrite(responseAddress, response)]);
    this.phase = 'established';
  } catch (error) {
    this._destroyAfterFailure();
    throw executionError(error);
  }
};

ValidationContext.prototype.sign = function () {
  this._requirePhase('established');
  try {
    var outputPointerAddress = this.foundation.allocate(8);
    var outputLengthAddress = this.foundation.allocate(8);
    var event = this._call(NAC_SIGN_ADDRESS, [
      this.validationContextAddress,
      0n,
      0n,
      outputPointerAddress,
      outputLengthAddress,
    ], [
      Object.freeze({ kind: 'fill', address: outputPointerAddress, length: 8, byte: 0 }),
      Object.freeze({ kind: 'fill', address: outputLengthAddress, length: 8, byte: 0 }),
    ]);
    var result = this._readOutput(event, outputPointerAddress, outputLengthAddress, 'validation data');
    this.destroy();
    return result;
  } catch (error) {
    this._destroyAfterFailure();
    throw executionError(error);
  }
};

/**
 * Create the single-use JS-owned NAC lifecycle over an injected, protocol-neutral x86-64
 * machine. `options.image` must be the already hash-verified thin slice returned by
 * image.loadPinnedImage(); this layer deliberately does no downloading or trust selection.
 *
 * @param {{machineProvider: object, image: Uint8Array, certificateChain: Uint8Array,
 *   hardwareEnvironment: object, randomWord: function(): (number|bigint)}} options
 * @returns {ValidationContext}
 */
function createValidationContext(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('NAC validation context options are required.');
  }
  var provider = requireMachineProvider(options.machineProvider);
  var image = requireBytes(options.image, 'x86-64 image', STACK_BASE);
  var certificateChain = requireBytes(
    options.certificateChain, 'certificate chain', MAX_CERTIFICATE_CHAIN_BYTES
  );
  var foundation = foundationModule.createFoundationState(
    options.hardwareEnvironment, options.randomWord
  );
  var certificateAddress = foundation.allocate(certificateChain.length);
  var contextPointerAddress = foundation.allocate(8);
  var requestPointerAddress = foundation.allocate(8);
  var requestLengthAddress = foundation.allocate(8);
  var plan = buildMachinePlan(image);
  plan = Object.freeze({
    regions: plan.regions,
    writes: Object.freeze(plan.writes.concat([
      Object.freeze({ address: certificateAddress, data: certificateChain }),
    ])),
    fills: plan.fills,
    registers: plan.registers,
    traps: plan.traps,
  });

  var machine = null;
  var context = null;
  try {
    machine = requireMachine(provider.create(plan));
    context = new ValidationContext(machine, foundation, new Uint8Array(0), 0n);
    var event = context._call(NAC_INIT_ADDRESS, [
      certificateAddress,
      BigInt(certificateChain.length),
      contextPointerAddress,
      requestPointerAddress,
      requestLengthAddress,
    ], [
      Object.freeze({ kind: 'fill', address: contextPointerAddress, length: 8, byte: 0 }),
      Object.freeze({ kind: 'fill', address: requestPointerAddress, length: 8, byte: 0 }),
      Object.freeze({ kind: 'fill', address: requestLengthAddress, length: 8, byte: 0 }),
    ]);
    context.validationContextAddress = readUint64(inspectRead(
      machine, event.pauseToken, contextPointerAddress, 8
    ));
    if (context.validationContextAddress === 0n) {
      throw contextError('NAC_NATIVE_OUTPUT_INVALID', 'The NAC validation context pointer is invalid.');
    }
    context.sessionInfoRequest = context._readOutput(
      event, requestPointerAddress, requestLengthAddress, 'session-info request'
    );
    return context;
  } catch (error) {
    if (context) context._destroyAfterFailure();
    else if (machine) {
      try { machine.destroy(); } catch (_) { /* Preserve the original failure. */ }
    }
    throw executionError(error);
  }
}

module.exports = {
  EXECUTION_INSTRUCTION_LIMIT: EXECUTION_INSTRUCTION_LIMIT,
  EXECUTION_TIMEOUT_MILLIS: EXECUTION_TIMEOUT_MILLIS,
  EXECUTION_TRAP_LIMIT: EXECUTION_TRAP_LIMIT,
  HOOK_SIZE: HOOK_SIZE,
  MAX_NATIVE_OUTPUT_BYTES: MAX_NATIVE_OUTPUT_BYTES,
  NAC_ESTABLISH_ADDRESS: NAC_ESTABLISH_ADDRESS,
  NAC_INIT_ADDRESS: NAC_INIT_ADDRESS,
  NAC_SIGN_ADDRESS: NAC_SIGN_ADDRESS,
  PAGE_SIZE: PAGE_SIZE,
  STACK_BASE: STACK_BASE,
  STACK_SIZE: STACK_SIZE,
  STOP_ADDRESS: STOP_ADDRESS,
  ValidationContext: ValidationContext,
  buildMachinePlan: buildMachinePlan,
  createValidationContext: createValidationContext,
};
