'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 64 * 1024 * 1024,
});

var CRC_TABLE = (function () {
  var table = new Uint32Array(256);
  for (var index = 0; index < 256; index += 1) {
    var value = index;
    for (var bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}());

var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** @param {string} message @returns {RuntimeError} */
function invalidGzip(message) {
  return new RuntimeError('INVALID_GZIP', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

/** @param {Object=} options @returns {Object} */
function limitsFrom(options) {
  options = options || {};
  var result = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (name) {
    var value = options[name] === undefined ? DEFAULT_LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 0) throw invalidGzip(name + ' must be a non-negative safe integer.');
    result[name] = value;
  });
  return result;
}

/** @param {Uint8Array} input @returns {number} */
function crc32(input) {
  var crc = 0xffffffff;
  for (var index = 0; index < input.length; index += 1) crc = CRC_TABLE[(crc ^ input[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @param {number} value @returns {Uint8Array} */
function uint32LE(value) {
  return new Uint8Array([value, value >>> 8, value >>> 16, value >>> 24]);
}

/** @param {Uint8Array} input @param {number} offset @returns {number} */
function readUint16LE(input, offset) {
  return input[offset] + input[offset + 1] * 256;
}

/** @param {Uint8Array} input @param {number} offset @returns {number} */
function readUint32LE(input, offset) {
  return (input[offset] + input[offset + 1] * 256 + input[offset + 2] * 65536 + input[offset + 3] * 16777216) >>> 0;
}

/**
 * Emit a deterministic gzip member using DEFLATE stored blocks. The representation is larger than
 * compressed output but interoperable, reproducible, and does not depend on a platform compressor.
 *
 * @param {Uint8Array} input
 * @param {Object=} options
 * @returns {Uint8Array}
 */
function gzip(input, options) {
  var limits = limitsFrom(options);
  try { bytes.assertBytes(input, 'input'); } catch (error) { throw invalidGzip('Input must be a Uint8Array.'); }
  if (input.length > limits.maxInputBytes) throw invalidGzip('Input exceeds maxInputBytes.');
  var blockCount = Math.max(1, Math.ceil(input.length / 65535));
  var outputLength = 10 + input.length + blockCount * 5 + 8;
  if (!Number.isSafeInteger(outputLength) || outputLength > limits.maxOutputBytes) throw invalidGzip('Encoded gzip exceeds maxOutputBytes.');
  var output = new Uint8Array(outputLength);
  output.set(new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]), 0);

  var inputOffset = 0;
  var outputOffset = 10;
  for (var blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    var length = Math.min(65535, input.length - inputOffset);
    var finalBlock = blockIndex === blockCount - 1;
    output[outputOffset++] = finalBlock ? 0x01 : 0x00;
    output[outputOffset++] = length;
    output[outputOffset++] = length >>> 8;
    var complement = (~length) & 0xffff;
    output[outputOffset++] = complement;
    output[outputOffset++] = complement >>> 8;
    output.set(input.subarray(inputOffset, inputOffset + length), outputOffset);
    inputOffset += length;
    outputOffset += length;
  }
  output.set(uint32LE(crc32(input)), outputOffset);
  output.set(uint32LE(input.length >>> 0), outputOffset + 4);
  return output;
}

/** @constructor @param {Uint8Array} input @param {number} start @param {number} end */
function BitReader(input, start, end) {
  this.input = input;
  this.offset = start;
  this.end = end;
  this.buffer = 0;
  this.bitCount = 0;
}

/** @param {number} count @returns {number} */
BitReader.prototype.readBits = function (count) {
  if (!Number.isInteger(count) || count < 0 || count > 15) throw invalidGzip('Invalid DEFLATE bit count.');
  while (this.bitCount < count) {
    if (this.offset >= this.end) throw invalidGzip('DEFLATE stream is truncated.');
    this.buffer |= this.input[this.offset++] << this.bitCount;
    this.bitCount += 8;
  }
  var mask = count === 0 ? 0 : (1 << count) - 1;
  var value = this.buffer & mask;
  this.buffer >>>= count;
  this.bitCount -= count;
  return value;
};

BitReader.prototype.alignToByte = function () {
  this.buffer = 0;
  this.bitCount = 0;
};

/** @constructor @param {number} maximum */
function ByteSink(maximum) {
  this.maximum = maximum;
  this.length = 0;
  this.buffer = new Uint8Array(Math.min(Math.max(1024, maximum > 0 ? 1 : 0), maximum));
}

/** @param {number} required */
ByteSink.prototype.ensure = function (required) {
  if (!Number.isSafeInteger(required) || required > this.maximum) throw invalidGzip('Inflated data exceeds maxOutputBytes.');
  if (required <= this.buffer.length) return;
  var newLength = this.buffer.length || 1;
  while (newLength < required) newLength = Math.min(this.maximum, newLength * 2);
  var grown = new Uint8Array(newLength);
  grown.set(this.buffer);
  this.buffer = grown;
};

/** @param {number} value */
ByteSink.prototype.push = function (value) {
  this.ensure(this.length + 1);
  this.buffer[this.length++] = value;
};

/** @param {Uint8Array} input @param {number} start @param {number} length */
ByteSink.prototype.append = function (input, start, length) {
  this.ensure(this.length + length);
  this.buffer.set(input.subarray(start, start + length), this.length);
  this.length += length;
};

/** @param {number} distance @param {number} length */
ByteSink.prototype.copy = function (distance, length) {
  if (!Number.isInteger(distance) || distance < 1 || distance > this.length) throw invalidGzip('DEFLATE distance is outside produced output.');
  this.ensure(this.length + length);
  for (var index = 0; index < length; index += 1) {
    this.buffer[this.length] = this.buffer[this.length - distance];
    this.length += 1;
  }
};

ByteSink.prototype.finish = function () { return this.buffer.slice(0, this.length); };

/** @param {number} value @param {number} width @returns {number} */
function reverseBits(value, width) {
  var reversed = 0;
  for (var index = 0; index < width; index += 1) {
    reversed = (reversed << 1) | (value & 1);
    value >>>= 1;
  }
  return reversed;
}

/** @param {Array<number>} lengths @param {string} name @param {boolean=} allowEmpty @param {boolean=} allowSingleIncomplete @returns {Object|null} */
function buildHuffman(lengths, name, allowEmpty, allowSingleIncomplete) {
  var counts = new Array(16).fill(0);
  for (var index = 0; index < lengths.length; index += 1) {
    var length = lengths[index];
    if (!Number.isInteger(length) || length < 0 || length > 15) throw invalidGzip(name + ' contains an invalid code length.');
    if (length !== 0) counts[length] += 1;
  }
  var symbolCount = lengths.length - counts[0];
  if (symbolCount === 0) {
    if (allowEmpty) return null;
    throw invalidGzip(name + ' has no symbols.');
  }
  var remaining = 1;
  for (var codeLength = 1; codeLength <= 15; codeLength += 1) {
    remaining = remaining * 2 - counts[codeLength];
    if (remaining < 0) throw invalidGzip(name + ' is oversubscribed.');
  }
  if (remaining !== 0 && !(allowSingleIncomplete && symbolCount === 1 && counts[1] === 1)) {
    throw invalidGzip(name + ' is incomplete.');
  }

  var nextCode = new Array(16).fill(0);
  var code = 0;
  for (var lengthIndex = 1; lengthIndex <= 15; lengthIndex += 1) {
    code = (code + counts[lengthIndex - 1]) << 1;
    nextCode[lengthIndex] = code;
  }
  var tables = new Array(16);
  for (var tableIndex = 0; tableIndex < tables.length; tableIndex += 1) tables[tableIndex] = Object.create(null);
  var maximumLength = 0;
  for (var symbol = 0; symbol < lengths.length; symbol += 1) {
    var symbolLength = lengths[symbol];
    if (symbolLength === 0) continue;
    var reversed = reverseBits(nextCode[symbolLength]++, symbolLength);
    tables[symbolLength][reversed] = symbol;
    if (symbolLength > maximumLength) maximumLength = symbolLength;
  }
  return { tables: tables, maximumLength: maximumLength };
}

/** @param {BitReader} reader @param {Object|null} tree @param {string} name @returns {number} */
function decodeSymbol(reader, tree, name) {
  if (!tree) throw invalidGzip(name + ' is empty but a symbol was requested.');
  var code = 0;
  for (var length = 1; length <= tree.maximumLength; length += 1) {
    code |= reader.readBits(1) << (length - 1);
    if (Object.prototype.hasOwnProperty.call(tree.tables[length], code)) return tree.tables[length][code];
  }
  throw invalidGzip(name + ' contains an invalid code.');
}

/** @returns {{literal:Object,distance:Object}} */
function fixedTrees() {
  var literalLengths = new Array(288);
  for (var index = 0; index <= 143; index += 1) literalLengths[index] = 8;
  for (; index <= 255; index += 1) literalLengths[index] = 9;
  for (; index <= 279; index += 1) literalLengths[index] = 7;
  for (; index <= 287; index += 1) literalLengths[index] = 8;
  return { literal: buildHuffman(literalLengths, 'fixed literal tree'), distance: buildHuffman(new Array(32).fill(5), 'fixed distance tree') };
}

/** @param {BitReader} reader @returns {{literal:Object,distance:Object|null}} */
function dynamicTrees(reader) {
  var literalCount = reader.readBits(5) + 257;
  var distanceCount = reader.readBits(5) + 1;
  var codeLengthCount = reader.readBits(4) + 4;
  var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  var codeLengths = new Array(19).fill(0);
  for (var index = 0; index < codeLengthCount; index += 1) codeLengths[order[index]] = reader.readBits(3);
  var codeLengthTree = buildHuffman(codeLengths, 'code-length tree');
  var total = literalCount + distanceCount;
  var lengths = [];
  while (lengths.length < total) {
    var symbol = decodeSymbol(reader, codeLengthTree, 'code-length tree');
    if (symbol <= 15) lengths.push(symbol);
    else if (symbol === 16) {
      if (lengths.length === 0) throw invalidGzip('Repeat code has no previous code length.');
      var repeat = reader.readBits(2) + 3;
      var previous = lengths[lengths.length - 1];
      if (lengths.length + repeat > total) throw invalidGzip('Code-length repeat exceeds the declared tree size.');
      while (repeat-- > 0) lengths.push(previous);
    } else if (symbol === 17 || symbol === 18) {
      var zeroRepeat = reader.readBits(symbol === 17 ? 3 : 7) + (symbol === 17 ? 3 : 11);
      if (lengths.length + zeroRepeat > total) throw invalidGzip('Zero repeat exceeds the declared tree size.');
      while (zeroRepeat-- > 0) lengths.push(0);
    } else {
      throw invalidGzip('Code-length tree produced an invalid symbol.');
    }
  }
  var literalLengths = lengths.slice(0, literalCount);
  if (literalLengths[256] === 0) throw invalidGzip('Literal tree does not define an end-of-block symbol.');
  return {
    literal: buildHuffman(literalLengths, 'literal/length tree', false, true),
    distance: buildHuffman(lengths.slice(literalCount), 'distance tree', true, true),
  };
}

/** @param {BitReader} reader @param {ByteSink} sink @param {Object} trees */
function inflateCompressedBlock(reader, sink, trees) {
  for (;;) {
    var symbol = decodeSymbol(reader, trees.literal, 'literal/length tree');
    if (symbol < 256) sink.push(symbol);
    else if (symbol === 256) return;
    else {
      var lengthIndex = symbol - 257;
      if (lengthIndex < 0 || lengthIndex >= LENGTH_BASE.length) throw invalidGzip('Literal tree produced a reserved length symbol.');
      var length = LENGTH_BASE[lengthIndex] + reader.readBits(LENGTH_EXTRA[lengthIndex]);
      var distanceSymbol = decodeSymbol(reader, trees.distance, 'distance tree');
      if (distanceSymbol < 0 || distanceSymbol >= DISTANCE_BASE.length) throw invalidGzip('Distance tree produced a reserved symbol.');
      var distance = DISTANCE_BASE[distanceSymbol] + reader.readBits(DISTANCE_EXTRA[distanceSymbol]);
      sink.copy(distance, length);
    }
  }
}

/** @param {Uint8Array} input @param {number} start @param {number} end @param {number} maximum @returns {Uint8Array} */
function inflate(input, start, end, maximum) {
  var reader = new BitReader(input, start, end);
  var sink = new ByteSink(maximum);
  var finalBlock = false;
  while (!finalBlock) {
    finalBlock = reader.readBits(1) === 1;
    var type = reader.readBits(2);
    if (type === 0) {
      reader.alignToByte();
      if (reader.offset + 4 > end) throw invalidGzip('Stored DEFLATE block header is truncated.');
      var length = readUint16LE(input, reader.offset);
      var complement = readUint16LE(input, reader.offset + 2);
      reader.offset += 4;
      if (((length ^ complement) & 0xffff) !== 0xffff) throw invalidGzip('Stored DEFLATE block length check failed.');
      if (reader.offset + length > end) throw invalidGzip('Stored DEFLATE block is truncated.');
      sink.append(input, reader.offset, length);
      reader.offset += length;
    } else if (type === 1) inflateCompressedBlock(reader, sink, fixedTrees());
    else if (type === 2) inflateCompressedBlock(reader, sink, dynamicTrees(reader));
    else throw invalidGzip('DEFLATE block uses the reserved block type.');
  }
  if (reader.offset !== end) throw invalidGzip('Unexpected bytes remain after the final DEFLATE block.');
  return sink.finish();
}

/**
 * Decode one gzip member with stored, fixed-Huffman, or dynamic-Huffman DEFLATE blocks.
 *
 * @param {Uint8Array} input
 * @param {Object=} options
 * @returns {Uint8Array}
 */
function ungzip(input, options) {
  var limits = limitsFrom(options);
  try { bytes.assertBytes(input, 'input'); } catch (error) { throw invalidGzip('Input must be a Uint8Array.'); }
  if (input.length > limits.maxInputBytes) throw invalidGzip('Input exceeds maxInputBytes.');
  if (input.length < 18 || input[0] !== 0x1f || input[1] !== 0x8b || input[2] !== 8) throw invalidGzip('Gzip header is missing or unsupported.');
  var flags = input[3];
  if ((flags & 0xe0) !== 0) throw invalidGzip('Gzip header uses reserved flags.');
  var trailerOffset = input.length - 8;
  var cursor = 10;
  if (flags & 0x04) {
    if (cursor + 2 > trailerOffset) throw invalidGzip('Gzip extra-field length is truncated.');
    var extraLength = readUint16LE(input, cursor);
    cursor += 2;
    if (cursor + extraLength > trailerOffset) throw invalidGzip('Gzip extra field is truncated.');
    cursor += extraLength;
  }
  function skipZeroTerminated(name) {
    while (cursor < trailerOffset && input[cursor] !== 0) cursor += 1;
    if (cursor >= trailerOffset) throw invalidGzip('Gzip ' + name + ' is unterminated.');
    cursor += 1;
  }
  if (flags & 0x08) skipZeroTerminated('filename');
  if (flags & 0x10) skipZeroTerminated('comment');
  if (flags & 0x02) {
    if (cursor + 2 > trailerOffset) throw invalidGzip('Gzip header CRC is truncated.');
    var expectedHeaderCrc = readUint16LE(input, cursor);
    var actualHeaderCrc = crc32(input.slice(0, cursor)) & 0xffff;
    if (expectedHeaderCrc !== actualHeaderCrc) throw invalidGzip('Gzip header CRC does not match.');
    cursor += 2;
  }
  if (cursor >= trailerOffset) throw invalidGzip('Gzip member has no DEFLATE payload.');
  var output = inflate(input, cursor, trailerOffset, limits.maxOutputBytes);
  if (readUint32LE(input, trailerOffset) !== crc32(output)) throw invalidGzip('Gzip payload CRC does not match.');
  if (readUint32LE(input, trailerOffset + 4) !== (output.length >>> 0)) throw invalidGzip('Gzip uncompressed size does not match.');
  return output;
}

module.exports = {
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  crc32: crc32,
  gzip: gzip,
  ungzip: ungzip,
};
