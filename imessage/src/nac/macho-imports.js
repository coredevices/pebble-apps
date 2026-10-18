'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var LC_SEGMENT_64 = 0x19;
var LC_SYMTAB = 0x2;
var LC_DYSYMTAB = 0xb;
var S_NON_LAZY_SYMBOL_POINTERS = 0x6;
var S_LAZY_SYMBOL_POINTERS = 0x7;
var INDIRECT_SYMBOL_LOCAL = 0x80000000;
var INDIRECT_SYMBOL_ABS = 0x40000000;
var MACH_HEADER_BYTES = 32;
var SEGMENT_COMMAND_64_BYTES = 72;
var SECTION_64_BYTES = 80;
var NLIST_64_BYTES = 16;
var POINTER_BYTES = 8;
var MAX_LOAD_COMMANDS = 4096;
var MAX_SECTIONS = 4096;
var MAX_SYMBOLS = 500000;
var MACHO_64_MAGIC_LE = 0xfeedfacf;
var CPU_TYPE_X86_64 = 0x01000007;

function machoError(message) {
  return new RuntimeError('NAC_MACHO_INVALID', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

function checkedRange(image, offset, length, name) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset > image.length || length > image.length - offset) {
    throw machoError('The NAC Mach-O ' + name + ' is out of bounds.');
  }
}

function readU32(image, offset) {
  checkedRange(image, offset, 4, 'integer');
  return bytes.readUint32LE(image, offset);
}

function readU64(image, offset) {
  var low = readU32(image, offset);
  var high = readU32(image, offset + 4);
  var value = low + high * 0x100000000;
  if (!Number.isSafeInteger(value)) throw machoError('The NAC Mach-O contains an unsafe 64-bit value.');
  return value;
}

function parseCommands(image) {
  if (!(image instanceof Uint8Array) || image.length < MACH_HEADER_BYTES) {
    throw machoError('The NAC Mach-O header is truncated.');
  }
  if (readU32(image, 0) !== MACHO_64_MAGIC_LE || readU32(image, 4) !== CPU_TYPE_X86_64) {
    throw machoError('The NAC Mach-O is not an x86-64 image.');
  }
  var ncmds = readU32(image, 16);
  var sizeofcmds = readU32(image, 20);
  if (ncmds > MAX_LOAD_COMMANDS) throw machoError('The NAC Mach-O has too many load commands.');
  checkedRange(image, MACH_HEADER_BYTES, sizeofcmds, 'load commands');

  var commandOffset = MACH_HEADER_BYTES;
  var commandEnd = MACH_HEADER_BYTES + sizeofcmds;
  var pointerSections = [];
  var symbolTable = null;
  var dynamicSymbols = null;
  var sectionCount = 0;
  for (var index = 0; index < ncmds; index += 1) {
    checkedRange(image, commandOffset, 8, 'load command');
    var command = readU32(image, commandOffset);
    var commandSize = readU32(image, commandOffset + 4);
    if (commandSize < 8 || commandSize % 4 !== 0 || commandSize > commandEnd - commandOffset) {
      throw machoError('The NAC Mach-O contains a malformed load command.');
    }
    if (command === LC_SEGMENT_64) {
      if (commandSize < SEGMENT_COMMAND_64_BYTES) throw machoError('The NAC Mach-O segment command is truncated.');
      var nsects = readU32(image, commandOffset + 64);
      if (nsects > MAX_SECTIONS - sectionCount
          || SEGMENT_COMMAND_64_BYTES + nsects * SECTION_64_BYTES > commandSize) {
        throw machoError('The NAC Mach-O section table is malformed.');
      }
      sectionCount += nsects;
      for (var sectionIndex = 0; sectionIndex < nsects; sectionIndex += 1) {
        var section = commandOffset + SEGMENT_COMMAND_64_BYTES + sectionIndex * SECTION_64_BYTES;
        var size = readU64(image, section + 40);
        var fileOffset = readU32(image, section + 48);
        var flags = readU32(image, section + 64);
        var type = flags & 0xff;
        if (type === S_NON_LAZY_SYMBOL_POINTERS || type === S_LAZY_SYMBOL_POINTERS) {
          if (size % POINTER_BYTES !== 0) throw machoError('The NAC Mach-O pointer section is misaligned.');
          checkedRange(image, fileOffset, size, 'pointer section');
          pointerSections.push(Object.freeze({
            fileOffset: fileOffset,
            count: size / POINTER_BYTES,
            indirectStart: readU32(image, section + 68),
          }));
        }
      }
    } else if (command === LC_SYMTAB) {
      if (commandSize < 24 || symbolTable !== null) throw machoError('The NAC Mach-O symbol table command is malformed.');
      symbolTable = Object.freeze({
        symbolOffset: readU32(image, commandOffset + 8),
        symbolCount: readU32(image, commandOffset + 12),
        stringOffset: readU32(image, commandOffset + 16),
        stringSize: readU32(image, commandOffset + 20),
      });
    } else if (command === LC_DYSYMTAB) {
      if (commandSize < 80 || dynamicSymbols !== null) throw machoError('The NAC Mach-O dynamic symbol command is malformed.');
      dynamicSymbols = Object.freeze({
        indirectOffset: readU32(image, commandOffset + 56),
        indirectCount: readU32(image, commandOffset + 60),
      });
    }
    commandOffset += commandSize;
  }
  if (commandOffset !== commandEnd) throw machoError('The NAC Mach-O load command sizes do not match the header.');
  if (!symbolTable || !dynamicSymbols) throw machoError('The NAC Mach-O import tables are missing.');
  if (symbolTable.symbolCount > MAX_SYMBOLS || dynamicSymbols.indirectCount > MAX_SYMBOLS) {
    throw machoError('The NAC Mach-O import tables are too large.');
  }
  checkedRange(image, symbolTable.symbolOffset, symbolTable.symbolCount * NLIST_64_BYTES, 'symbol table');
  checkedRange(image, symbolTable.stringOffset, symbolTable.stringSize, 'string table');
  checkedRange(image, dynamicSymbols.indirectOffset, dynamicSymbols.indirectCount * 4, 'indirect symbol table');
  return Object.freeze({
    pointerSections: Object.freeze(pointerSections),
    symbolTable: symbolTable,
    dynamicSymbols: dynamicSymbols,
  });
}

function readSymbolName(image, tables, symbolIndex) {
  if (symbolIndex >= tables.symbolTable.symbolCount) throw machoError('The NAC Mach-O import references an invalid symbol.');
  var stringIndex = readU32(image, tables.symbolTable.symbolOffset + symbolIndex * NLIST_64_BYTES);
  if (stringIndex === 0 || stringIndex >= tables.symbolTable.stringSize) {
    throw machoError('The NAC Mach-O import has an invalid symbol name.');
  }
  var start = tables.symbolTable.stringOffset + stringIndex;
  var limit = tables.symbolTable.stringOffset + tables.symbolTable.stringSize;
  var end = start;
  while (end < limit && image[end] !== 0) end += 1;
  if (end === limit || end === start || end - start > 1024) {
    throw machoError('The NAC Mach-O import has an invalid symbol name.');
  }
  var name;
  try { name = bytes.bytesToUtf8(image.slice(start, end)); }
  catch (_) { throw machoError('The NAC Mach-O import name is not UTF-8.'); }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw machoError('The NAC Mach-O import name is malformed.');
  return name;
}

function listImports(image) {
  var tables = parseCommands(image);
  var imports = [];
  var seenOffsets = Object.create(null);
  tables.pointerSections.forEach(function (section) {
    if (section.indirectStart > tables.dynamicSymbols.indirectCount
        || section.count > tables.dynamicSymbols.indirectCount - section.indirectStart) {
      throw machoError('The NAC Mach-O pointer section exceeds the indirect symbol table.');
    }
    for (var index = 0; index < section.count; index += 1) {
      var indirectIndex = section.indirectStart + index;
      var symbolIndex = readU32(image, tables.dynamicSymbols.indirectOffset + indirectIndex * 4);
      if ((symbolIndex & INDIRECT_SYMBOL_LOCAL) !== 0 || (symbolIndex & INDIRECT_SYMBOL_ABS) !== 0) continue;
      var offset = section.fileOffset + index * POINTER_BYTES;
      if (seenOffsets[offset]) throw machoError('The NAC Mach-O imports overlap.');
      seenOffsets[offset] = true;
      imports.push(Object.freeze({ name: readSymbolName(image, tables, symbolIndex), offset: offset }));
    }
  });
  return Object.freeze(imports);
}

function buildImportBindings(image, hookAddresses, unsupportedImportAddress) {
  if (!hookAddresses || typeof hookAddresses !== 'object' || Array.isArray(hookAddresses)) {
    throw new TypeError('NAC hook addresses must be an object.');
  }
  var hookNames = Object.keys(hookAddresses);
  hookNames.forEach(function (name) {
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new TypeError('NAC hook name is invalid.');
    var address = hookAddresses[name];
    if (!Number.isSafeInteger(address) || address < 0) throw new TypeError('NAC hook address is invalid.');
  });
  if (!Number.isSafeInteger(unsupportedImportAddress) || unsupportedImportAddress < 0) {
    throw new TypeError('NAC unsupported-import hook address is invalid.');
  }
  var bindings = [];
  var matched = Object.create(null);
  listImports(image).forEach(function (entry) {
    var supported = Object.prototype.hasOwnProperty.call(hookAddresses, entry.name);
    var address = supported ? hookAddresses[entry.name] : unsupportedImportAddress;
    if (supported) matched[entry.name] = true;
    // The pinned full application contains many imports outside the three NAC entrypoint traces.
    // Bind every such import to a JS-owned trap instead of leaving a callable native address.
    bindings.push(Object.freeze({
      name: entry.name,
      offset: entry.offset,
      address: address,
      supported: supported,
    }));
  });
  hookNames.forEach(function (name) {
    if (!matched[name]) throw machoError('The NAC Mach-O is missing a required host import.');
  });
  return Object.freeze(bindings);
}

module.exports = {
  LC_DYSYMTAB: LC_DYSYMTAB,
  LC_SEGMENT_64: LC_SEGMENT_64,
  LC_SYMTAB: LC_SYMTAB,
  S_LAZY_SYMBOL_POINTERS: S_LAZY_SYMBOL_POINTERS,
  S_NON_LAZY_SYMBOL_POINTERS: S_NON_LAZY_SYMBOL_POINTERS,
  buildImportBindings: buildImportBindings,
  listImports: listImports,
};
