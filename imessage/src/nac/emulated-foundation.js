'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var HOOK_BASE = 0xd00000;
var HEAP_BASE = 0x400000;
var HEAP_SIZE = 0x100000;
var DICTIONARY_UUID_SENTINEL = 0xc3c3c3c3c3c3c3c3n;

var HOOK_SYMBOLS = Object.freeze([
  '_malloc', '_free', '___stack_chk_guard', '___memset_chk', '_memcpy', '___bzero',
  '_sysctlbyname', '_statfs$INODE64', '_arc4random',
  '_kIOMasterPortDefault', '_IORegistryEntryFromPath', '_IORegistryEntryCreateCFProperty',
  '_IOServiceMatching', '_IOServiceGetMatchingService', '_IOServiceGetMatchingServices',
  '_IOIteratorNext', '_IORegistryEntryGetParentEntry', '_IOObjectRelease',
  '_DASessionCreate', '_DADiskCreateFromBSDName', '_DADiskCopyDescription',
  '_kDADiskDescriptionVolumeUUIDKey', '_kCFAllocatorDefault', '_kCFBooleanTrue',
  '_CFGetTypeID', '_CFStringGetTypeID', '_CFDataGetTypeID', '_CFDataGetLength',
  '_CFDataGetBytes', '_CFStringGetLength', '_CFStringGetMaximumSizeForEncoding',
  '_CFStringGetCString', '_CFUUIDCreateString', '_CFDictionaryCreateMutable',
  '_CFDictionarySetValue', '_CFDictionaryGetValue', '_CFRelease',
]);
var UNSUPPORTED_IMPORT_HOOK_ADDRESS = HOOK_BASE + HOOK_SYMBOLS.length;

function hookError(code, message) {
  return new RuntimeError(code, message, { kind: ERROR_KINDS.INTERNAL });
}

function word(value, name) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n && value <= 0xffffffffffffffffn) return value;
  throw new TypeError((name || 'NAC word') + ' is invalid.');
}

function address(value) {
  var normalized = word(value, 'NAC address');
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) throw hookError('NAC_MEMORY_FAULT', 'The NAC address is out of range.');
  return Number(normalized);
}

function boundedLength(value, name) {
  var normalized = word(value, name || 'NAC length');
  if (normalized > BigInt(HEAP_SIZE)) {
    throw hookError('NAC_MEMORY_FAULT', 'The NAC memory operation is too large.');
  }
  return Number(normalized);
}

function argument(args, index) {
  return index < args.length ? word(args[index], 'NAC hook argument') : 0n;
}

function requireMemory(memory) {
  if (!memory || typeof memory.read !== 'function' || typeof memory.write !== 'function') {
    throw new TypeError('NAC hook memory is unavailable.');
  }
  return memory;
}

function readU64(memory, pointer) {
  var input = memory.read(address(pointer), 8);
  if (!(input instanceof Uint8Array) || input.length !== 8) throw hookError('NAC_MEMORY_FAULT', 'The NAC memory read failed.');
  var value = 0n;
  for (var index = 7; index >= 0; index -= 1) value = (value << 8n) | BigInt(input[index]);
  return value;
}

function writeBytes(memory, pointer, value) {
  memory.write(address(pointer), new Uint8Array(value));
}

function readCString(memory, pointer, maximum) {
  var input = memory.read(address(pointer), maximum);
  if (!(input instanceof Uint8Array)) throw hookError('NAC_MEMORY_FAULT', 'The NAC memory read failed.');
  var end = input.indexOf(0);
  if (end < 0) end = input.length;
  try { return bytes.bytesToUtf8(input.slice(0, end)); }
  catch (_) { throw hookError('NAC_HOOK_INVALID', 'The NAC C string is malformed.'); }
}

function readBuiltinCfString(memory, pointer) {
  var struct = memory.read(address(pointer), 32);
  if (!(struct instanceof Uint8Array) || struct.length !== 32) throw hookError('NAC_MEMORY_FAULT', 'The NAC CFString is truncated.');
  var stringPointer = readU64({ read: function (offset, length) {
    return struct.slice(offset - address(pointer), offset - address(pointer) + length);
  } }, address(pointer) + 16);
  var length = readU64({ read: function (offset, count) {
    return struct.slice(offset - address(pointer), offset - address(pointer) + count);
  } }, address(pointer) + 24);
  if (length > 1024n) throw hookError('NAC_HOOK_INVALID', 'The NAC CFString is too long.');
  var input = memory.read(address(stringPointer), Number(length));
  try { return bytes.bytesToUtf8(input); }
  catch (_) { throw hookError('NAC_HOOK_INVALID', 'The NAC CFString is malformed.'); }
}

function createHookAddresses() {
  var result = {};
  HOOK_SYMBOLS.forEach(function (name, index) { result[name] = HOOK_BASE + index; });
  return Object.freeze(result);
}

function createFoundationState(hardwareEnvironment, randomWord) {
  if (!hardwareEnvironment || typeof hardwareEnvironment.readProperty !== 'function'
      || typeof hardwareEnvironment.rootDiskUuid !== 'string') {
    throw new TypeError('NAC hardware environment is unavailable.');
  }
  if (typeof randomWord !== 'function') throw new TypeError('NAC random-word provider is unavailable.');

  var cfObjects = [];
  var heapUse = 0;
  var ethernetIteratorPending = false;

  function cfAdd(object) {
    cfObjects.push(object);
    return BigInt(cfObjects.length);
  }

  function cfGet(identifier) {
    var id = word(identifier);
    if (id === 0n || id > BigInt(cfObjects.length)) return null;
    return cfObjects[Number(id) - 1];
  }

  function data(value) { return { type: 'data', value: new Uint8Array(value) }; }
  function string(value) { return { type: 'string', value: value }; }
  function dictionary(value) { return { type: 'dictionary', value: value }; }

  function resolveCfOrRaw(value) {
    var object = cfGet(value);
    if (object && object.type === 'string') return object.value;
    if (object && object.type === 'data') {
      var end = object.value.indexOf(0);
      if (end < 0) end = object.value.length;
      try { return bytes.bytesToUtf8(object.value.slice(0, end)); } catch (_) { return '0x' + word(value).toString(16); }
    }
    return '0x' + word(value).toString(16);
  }

  function allocate(size) {
    var requested = word(size);
    if (requested > BigInt(HEAP_SIZE)) throw hookError('NAC_HEAP_EXHAUSTED', 'The NAC heap is exhausted.');
    var count = Number(requested === 0n ? 1n : requested);
    var aligned = (count + 15) & ~15;
    if (aligned > HEAP_SIZE - heapUse) throw hookError('NAC_HEAP_EXHAUSTED', 'The NAC heap is exhausted.');
    var result = HEAP_BASE + heapUse;
    heapUse += aligned;
    return BigInt(result);
  }

  function invoke(name, args, memory) {
    if (typeof name !== 'string' || HOOK_SYMBOLS.indexOf(name) === -1) {
      throw hookError('NAC_HOOK_UNSUPPORTED', 'The NAC image called an unsupported host symbol.');
    }
    if (!Array.isArray(args)) throw new TypeError('NAC hook arguments must be an array.');
    memory = requireMemory(memory);

    if (name === '_malloc') return allocate(argument(args, 0));
    if (name === '_free' || name === '___stack_chk_guard' || name === '_sysctlbyname'
        || name === '_statfs$INODE64' || name === '_kIOMasterPortDefault'
        || name === '_IOObjectRelease' || name === '_kDADiskDescriptionVolumeUUIDKey'
        || name === '_kCFAllocatorDefault' || name === '_kCFBooleanTrue' || name === '_CFRelease') return 0n;
    if (name === '___memset_chk') {
      var memsetLength = boundedLength(argument(args, 2));
      writeBytes(memory, argument(args, 0), new Uint8Array(memsetLength).fill(Number(argument(args, 1) & 0xffn)));
      return 0n;
    }
    if (name === '_memcpy') {
      var copyLength = boundedLength(argument(args, 2));
      writeBytes(memory, argument(args, 0), memory.read(address(argument(args, 1)), copyLength));
      return 0n;
    }
    if (name === '___bzero') {
      writeBytes(memory, argument(args, 0), new Uint8Array(boundedLength(argument(args, 1))));
      return 0n;
    }
    if (name === '_arc4random') {
      var random = word(randomWord(), 'NAC random word');
      if (random > 0xffffffffn) throw new TypeError('NAC random word exceeds uint32.');
      return random;
    }
    if (name === '_IORegistryEntryFromPath') return 1n;
    if (name === '_IORegistryEntryCreateCFProperty') {
      var propertyName = readBuiltinCfString(memory, argument(args, 1));
      var property = hardwareEnvironment.readProperty(propertyName);
      if (!property) return 0n;
      return cfAdd(property.type === 'data' ? data(property.value) : string(property.value));
    }
    if (name === '_IOServiceMatching') {
      var service = cfAdd(string(readCString(memory, argument(args, 0), 256)));
      var matching = Object.create(null);
      matching.IOProviderClass = service;
      return cfAdd(dictionary(matching));
    }
    if (name === '_IOServiceGetMatchingService') return 92n;
    if (name === '_IOServiceGetMatchingServices') {
      ethernetIteratorPending = true;
      writeBytes(memory, argument(args, 2), new Uint8Array([93]));
      return 0n;
    }
    if (name === '_IOIteratorNext') {
      if (!ethernetIteratorPending) return 0n;
      ethernetIteratorPending = false;
      return 94n;
    }
    if (name === '_IORegistryEntryGetParentEntry') {
      writeBytes(memory, argument(args, 2), new Uint8Array([Number((argument(args, 0) + 100n) & 0xffn)]));
      return 0n;
    }
    if (name === '_DASessionCreate') return 201n;
    if (name === '_DADiskCreateFromBSDName') return 202n;
    if (name === '_DADiskCopyDescription') {
      var volumeUuid = cfAdd(string(hardwareEnvironment.rootDiskUuid));
      var description = Object.create(null);
      description.DADiskDescriptionVolumeUUIDKey = volumeUuid;
      return cfAdd(dictionary(description));
    }
    if (name === '_CFGetTypeID') {
      var typed = cfGet(argument(args, 0));
      return typed && typed.type === 'data' ? 1n : typed && typed.type === 'string' ? 2n : 0n;
    }
    if (name === '_CFStringGetTypeID') return 2n;
    if (name === '_CFDataGetTypeID') return 1n;
    if (name === '_CFDataGetLength') {
      var dataObject = cfGet(argument(args, 0));
      return dataObject && dataObject.type === 'data' ? BigInt(dataObject.value.length) : 0n;
    }
    if (name === '_CFDataGetBytes') {
      var bytesObject = cfGet(argument(args, 0));
      if (!bytesObject || bytesObject.type !== 'data') return 0n;
      var start = Number(argument(args, 1));
      var end = Math.min(Number(argument(args, 2)), bytesObject.value.length);
      if (start > end) throw hookError('NAC_HOOK_INVALID', 'The NAC CFData range is invalid.');
      var selection = bytesObject.value.slice(start, end);
      writeBytes(memory, argument(args, 3), selection);
      return BigInt(selection.length);
    }
    if (name === '_CFStringGetLength') {
      var stringObject = cfGet(argument(args, 0));
      return stringObject && stringObject.type === 'string' ? BigInt(stringObject.value.length) : 0n;
    }
    if (name === '_CFStringGetMaximumSizeForEncoding') return argument(args, 0);
    if (name === '_CFStringGetCString') {
      var cStringObject = cfGet(argument(args, 0));
      if (!cStringObject || cStringObject.type !== 'string') return 0n;
      var encoded = bytes.utf8ToBytes(cStringObject.value);
      writeBytes(memory, argument(args, 1), encoded);
      return BigInt(encoded.length);
    }
    if (name === '_CFUUIDCreateString') return argument(args, 1);
    if (name === '_CFDictionaryCreateMutable') return cfAdd(dictionary(Object.create(null)));
    if (name === '_CFDictionarySetValue') {
      var mutable = cfGet(argument(args, 0));
      if (mutable && mutable.type === 'dictionary') {
        mutable.value[resolveCfOrRaw(argument(args, 1))] = argument(args, 2);
      }
      return undefined;
    }
    if (name === '_CFDictionaryGetValue') {
      var source = cfGet(argument(args, 0));
      if (!source || source.type !== 'dictionary') return 0n;
      var rawKey = argument(args, 1);
      var key = rawKey === DICTIONARY_UUID_SENTINEL
        ? 'DADiskDescriptionVolumeUUIDKey' : resolveCfOrRaw(rawKey);
      if (!Object.prototype.hasOwnProperty.call(source.value, key)) return 0n;
      var referenced = cfGet(source.value[key]);
      return referenced ? cfAdd(referenced.type === 'data'
        ? data(referenced.value) : referenced.type === 'string'
          ? string(referenced.value) : dictionary(referenced.value)) : word(source.value[key]);
    }
    throw hookError('NAC_HOOK_UNSUPPORTED', 'The NAC host symbol has no implementation.');
  }

  // The validation orchestrator and the emulated _malloc hook must share one bump allocator.
  // Keeping that allocator in this JS-owned state prevents native code from learning any NAC
  // layout or lifecycle policy beyond the generic memory map supplied by the caller.
  return Object.freeze({
    allocate: allocate,
    invoke: invoke,
  });
}

module.exports = {
  DICTIONARY_UUID_SENTINEL: DICTIONARY_UUID_SENTINEL,
  HEAP_BASE: HEAP_BASE,
  HEAP_SIZE: HEAP_SIZE,
  HOOK_BASE: HOOK_BASE,
  HOOK_SYMBOLS: HOOK_SYMBOLS,
  UNSUPPORTED_IMPORT_HOOK_ADDRESS: UNSUPPORTED_IMPORT_HOOK_ADDRESS,
  createFoundationState: createFoundationState,
  createHookAddresses: createHookAddresses,
};
