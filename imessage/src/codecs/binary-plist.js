'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var HEADER = bytes.utf8ToBytes('bplist00');
var APPLE_EPOCH_MILLISECONDS = 978307200000;
var MIN_SIGNED_64 = -0x8000000000000000n;
var MAX_SIGNED_64 = 0x7fffffffffffffffn;
var MAX_UNSIGNED_64 = 0xffffffffffffffffn;
var DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxObjects: 100000,
  maxContainerLength: 100000,
  maxStringBytes: 8 * 1024 * 1024,
  maxDataBytes: 8 * 1024 * 1024,
});

/** @param {string} message @returns {RuntimeError} */
function invalidPlist(message) {
  return new RuntimeError('INVALID_BINARY_PLIST', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

/** @param {Object=} options @returns {Object} */
function limitsFrom(options) {
  options = options || {};
  var result = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (name) {
    var value = options[name] === undefined ? DEFAULT_LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 0) throw invalidPlist(name + ' must be a non-negative safe integer.');
    result[name] = value;
  });
  return result;
}

/** @param {unknown} value @returns {boolean} */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  var prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {number} value @returns {number} */
function widthForUnsigned(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidPlist('Unsigned integer is outside the safe-integer range.');
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xffffffff) return 4;
  return 8;
}

/** @param {number} value @param {number} width @returns {Uint8Array} */
function writeUnsigned(value, width) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidPlist('Unsigned integer is outside the safe-integer range.');
  var result = new Uint8Array(width);
  var remaining = value;
  for (var index = width - 1; index >= 0; index -= 1) {
    result[index] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  if (remaining !== 0) throw invalidPlist('Unsigned integer does not fit its field.');
  return result;
}

/** @param {number|bigint} value @returns {bigint} */
function normalizeInteger(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw invalidPlist('Plist integers must be safe integers or bigint.');
}

/** @param {bigint} value @param {number} width @returns {Uint8Array} */
function writeBigUnsigned(value, width) {
  if (typeof value !== 'bigint' || value < 0n || !Number.isInteger(width) || width < 1) {
    throw invalidPlist('Big integer output is invalid.');
  }
  var result = new Uint8Array(width);
  var remaining = value;
  for (var index = width - 1; index >= 0; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw invalidPlist('Big integer does not fit its field.');
  return result;
}

/**
 * Binary-plist integer objects use unsigned 1/2/4-byte payloads, signed 8-byte payloads, and a
 * signed-positive 16-byte payload for the part of u64 above i64::MAX. This mirrors the `plist`
 * crate used by the pinned RustPush reference instead of treating every width as signed.
 *
 * @param {number|bigint} value
 * @returns {Uint8Array}
 */
function encodeInteger(value) {
  var integer = normalizeInteger(value);
  if (integer < MIN_SIGNED_64 || integer > MAX_UNSIGNED_64) {
    throw invalidPlist('Plist integer is outside the signed-64/unsigned-64 range.');
  }
  if (integer < 0n) {
    return bytes.concatBytes(new Uint8Array([0x13]), writeBigUnsigned((1n << 64n) + integer, 8));
  }
  if (integer <= MAX_SIGNED_64) {
    var width = integer <= 0xffn ? 1 : integer <= 0xffffn ? 2 : integer <= 0xffffffffn ? 4 : 8;
    return bytes.concatBytes(
      new Uint8Array([0x10 | ({ 1: 0, 2: 1, 4: 2, 8: 3 })[width]]),
      writeBigUnsigned(integer, width)
    );
  }
  return bytes.concatBytes(new Uint8Array([0x14]), writeBigUnsigned(integer, 16));
}

/** @param {number} value @returns {Uint8Array} */
function encodeUnsignedIntegerObject(value) {
  var width = widthForUnsigned(value);
  var exponent = width === 1 ? 0 : width === 2 ? 1 : width === 4 ? 2 : 3;
  return bytes.concatBytes(new Uint8Array([0x10 | exponent]), writeUnsigned(value, width));
}

/** @param {number} marker @param {number} length @returns {Uint8Array} */
function encodeMarkerAndLength(marker, length) {
  if (length < 15) return new Uint8Array([marker | length]);
  return bytes.concatBytes(new Uint8Array([marker | 0x0f]), encodeUnsignedIntegerObject(length));
}

/** @param {string} value @returns {Uint8Array} */
function encodeString(value) {
  var ascii = true;
  for (var index = 0; index < value.length; index += 1) {
    var code = value.charCodeAt(index);
    if (code > 0x7f) ascii = false;
    if (code >= 0xd800 && code <= 0xdbff) {
      var low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low < 0xdc00 || low > 0xdfff) throw invalidPlist('String contains an unpaired surrogate.');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw invalidPlist('String contains an unpaired surrogate.');
    }
  }
  if (ascii) return bytes.concatBytes(encodeMarkerAndLength(0x50, value.length), bytes.utf8ToBytes(value));
  var body = new Uint8Array(value.length * 2);
  for (var codeIndex = 0; codeIndex < value.length; codeIndex += 1) {
    var codeUnit = value.charCodeAt(codeIndex);
    body[codeIndex * 2] = codeUnit >>> 8;
    body[codeIndex * 2 + 1] = codeUnit;
  }
  return bytes.concatBytes(encodeMarkerAndLength(0x60, value.length), body);
}

/**
 * Encode a binary plist with deterministic pre-order object numbering and insertion-ordered keys.
 *
 * @param {unknown} rootValue
 * @param {Object=} options
 * @returns {Uint8Array}
 */
function encodeBinaryPlist(rootValue, options) {
  var limits = limitsFrom(options);
  var descriptors = [];
  var active = [];

  /** @param {unknown} value @param {number} depth @returns {number} */
  function addObject(value, depth) {
    if (depth > limits.maxDepth) throw invalidPlist('Plist nesting exceeds maxDepth.');
    if (descriptors.length >= limits.maxObjects) throw invalidPlist('Plist contains too many objects.');
    var objectIndex = descriptors.length;
    descriptors.push(null);

    if (value === null) descriptors[objectIndex] = { type: 'bytes', bytes: new Uint8Array([0x00]) };
    else if (typeof value === 'boolean') descriptors[objectIndex] = { type: 'bytes', bytes: new Uint8Array([value ? 0x09 : 0x08]) };
    else if (typeof value === 'number' || typeof value === 'bigint') {
      descriptors[objectIndex] = { type: 'bytes', bytes: encodeInteger(value) };
    }
    else if (typeof value === 'string') {
      if (bytes.utf8ToBytes(value).length > limits.maxStringBytes) throw invalidPlist('String exceeds maxStringBytes.');
      descriptors[objectIndex] = { type: 'bytes', bytes: encodeString(value) };
    } else if (value instanceof Uint8Array) {
      if (value.length > limits.maxDataBytes) throw invalidPlist('Data exceeds maxDataBytes.');
      descriptors[objectIndex] = { type: 'bytes', bytes: bytes.concatBytes(encodeMarkerAndLength(0x40, value.length), value) };
    } else if (value instanceof Date) {
      if (!Number.isFinite(value.getTime())) throw invalidPlist('Plist date is invalid.');
      var dateBytes = new Uint8Array(9);
      dateBytes[0] = 0x33;
      new DataView(dateBytes.buffer).setFloat64(1, (value.getTime() - APPLE_EPOCH_MILLISECONDS) / 1000, false);
      descriptors[objectIndex] = { type: 'bytes', bytes: dateBytes };
    } else if (Array.isArray(value) || isPlainObject(value)) {
      if (active.indexOf(value) !== -1) throw invalidPlist('Plist contains a cycle.');
      active.push(value);
      if (Array.isArray(value)) {
        if (value.length > limits.maxContainerLength) throw invalidPlist('Array exceeds maxContainerLength.');
        var references = new Array(value.length);
        for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex += 1) references[arrayIndex] = addObject(value[arrayIndex], depth + 1);
        descriptors[objectIndex] = { type: 'array', references: references };
      } else {
        var keys = Object.keys(value);
        if (keys.length > limits.maxContainerLength) throw invalidPlist('Dictionary exceeds maxContainerLength.');
        var keyReferences = new Array(keys.length);
        var valueReferences = new Array(keys.length);
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
          if (bytes.utf8ToBytes(keys[keyIndex]).length > limits.maxStringBytes) throw invalidPlist('Dictionary key exceeds maxStringBytes.');
          keyReferences[keyIndex] = addObject(keys[keyIndex], depth + 1);
          valueReferences[keyIndex] = addObject(value[keys[keyIndex]], depth + 1);
        }
        descriptors[objectIndex] = { type: 'dict', keys: keyReferences, values: valueReferences };
      }
      active.pop();
    } else {
      throw invalidPlist('Unsupported plist value type.');
    }
    return objectIndex;
  }

  var topObject = addObject(rootValue, 0);
  var referenceSize = widthForUnsigned(descriptors.length - 1);
  var encodedObjects = descriptors.map(function (descriptor) {
    if (descriptor.type === 'bytes') return descriptor.bytes;
    if (descriptor.type === 'array') {
      var arrayParts = [encodeMarkerAndLength(0xa0, descriptor.references.length)];
      descriptor.references.forEach(function (reference) { arrayParts.push(writeUnsigned(reference, referenceSize)); });
      return bytes.concatBytes.apply(null, arrayParts);
    }
    var dictionaryParts = [encodeMarkerAndLength(0xd0, descriptor.keys.length)];
    descriptor.keys.forEach(function (reference) { dictionaryParts.push(writeUnsigned(reference, referenceSize)); });
    descriptor.values.forEach(function (reference) { dictionaryParts.push(writeUnsigned(reference, referenceSize)); });
    return bytes.concatBytes.apply(null, dictionaryParts);
  });

  var offsets = new Array(encodedObjects.length);
  var objectTableLength = 0;
  encodedObjects.forEach(function (encoded, index) {
    offsets[index] = HEADER.length + objectTableLength;
    objectTableLength += encoded.length;
    if (!Number.isSafeInteger(objectTableLength)) throw invalidPlist('Object table is too large.');
  });
  var offsetTableOffset = HEADER.length + objectTableLength;
  var offsetSize = widthForUnsigned(offsetTableOffset);
  var totalLength = offsetTableOffset + offsets.length * offsetSize + 32;
  if (!Number.isSafeInteger(totalLength) || totalLength > limits.maxOutputBytes) throw invalidPlist('Encoded plist exceeds maxOutputBytes.');

  var output = new Uint8Array(totalLength);
  output.set(HEADER, 0);
  var outputOffset = HEADER.length;
  encodedObjects.forEach(function (encoded) { output.set(encoded, outputOffset); outputOffset += encoded.length; });
  offsets.forEach(function (objectOffset) { output.set(writeUnsigned(objectOffset, offsetSize), outputOffset); outputOffset += offsetSize; });
  output[outputOffset + 6] = offsetSize;
  output[outputOffset + 7] = referenceSize;
  output.set(writeUnsigned(descriptors.length, 8), outputOffset + 8);
  output.set(writeUnsigned(topObject, 8), outputOffset + 16);
  output.set(writeUnsigned(offsetTableOffset, 8), outputOffset + 24);
  return output;
}

/** @param {Uint8Array} input @param {number} offset @param {number} width @param {number} limit @returns {number} */
function readUnsigned(input, offset, width, limit) {
  if (!Number.isInteger(width) || width < 1 || width > 8 || offset < 0 || offset + width > limit) {
    throw invalidPlist('Integer field is outside the object table.');
  }
  var value = 0;
  for (var index = 0; index < width; index += 1) {
    if (value > Math.floor((Number.MAX_SAFE_INTEGER - input[offset + index]) / 256)) {
      throw invalidPlist('Integer field exceeds JavaScript safe-integer range.');
    }
    value = value * 256 + input[offset + index];
  }
  return value;
}

/** @param {Uint8Array} input @param {number} offset @param {number} width @param {number} limit @returns {bigint} */
function readBigUnsigned(input, offset, width, limit) {
  if (!Number.isInteger(width) || width < 1 || offset < 0 || offset + width > limit) {
    throw invalidPlist('Integer object is truncated.');
  }
  var value = 0n;
  for (var index = 0; index < width; index += 1) value = (value << 8n) | BigInt(input[offset + index]);
  return value;
}

/** @param {bigint} value @returns {number|bigint} */
function integerFromBigInt(value) {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value) : value;
}

/** @param {Uint8Array} input @param {number} offset @param {number} width @param {number} limit @returns {number|bigint} */
function readInteger(input, offset, width, limit) {
  if (width !== 1 && width !== 2 && width !== 4 && width !== 8 && width !== 16) {
    throw invalidPlist('Unsupported integer width.');
  }
  var value = readBigUnsigned(input, offset, width, limit);
  if (width < 8) return Number(value);
  if (width === 8) {
    if ((value & (1n << 63n)) !== 0n) value -= 1n << 64n;
    return integerFromBigInt(value);
  }
  if ((value & (1n << 127n)) !== 0n || value > MAX_UNSIGNED_64) {
    throw invalidPlist('128-bit integer is outside the unsigned-64 range.');
  }
  return integerFromBigInt(value);
}

/**
 * Decode a bounded binary plist object table. Cycles, overlapping objects, duplicate dictionary
 * keys, unsupported markers, out-of-range integers, and references outside the table are rejected.
 *
 * @param {Uint8Array} input
 * @param {Object=} options
 * @returns {unknown}
 */
function decodeBinaryPlist(input, options) {
  var limits = limitsFrom(options);
  try { bytes.assertBytes(input, 'input'); } catch (error) { throw invalidPlist('Input must be a Uint8Array.'); }
  if (input.length > limits.maxInputBytes) throw invalidPlist('Input exceeds maxInputBytes.');
  if (input.length < HEADER.length + 1 + 32) throw invalidPlist('Input is too short to be a binary plist.');
  for (var headerIndex = 0; headerIndex < HEADER.length; headerIndex += 1) {
    if (input[headerIndex] !== HEADER[headerIndex]) throw invalidPlist('Binary plist header is invalid.');
  }

  var trailerOffset = input.length - 32;
  var offsetSize = input[trailerOffset + 6];
  var referenceSize = input[trailerOffset + 7];
  if (offsetSize < 1 || offsetSize > 8 || referenceSize < 1 || referenceSize > 8) throw invalidPlist('Trailer integer widths are invalid.');
  var objectCount = readUnsigned(input, trailerOffset + 8, 8, input.length);
  var topObject = readUnsigned(input, trailerOffset + 16, 8, input.length);
  var offsetTableOffset = readUnsigned(input, trailerOffset + 24, 8, input.length);
  if (objectCount < 1 || objectCount > limits.maxObjects) throw invalidPlist('Object count is outside configured bounds.');
  if (topObject >= objectCount) throw invalidPlist('Top object reference is outside the object table.');
  if (offsetTableOffset < HEADER.length || offsetTableOffset > trailerOffset) throw invalidPlist('Offset table location is invalid.');
  var offsetTableLength = objectCount * offsetSize;
  if (!Number.isSafeInteger(offsetTableLength) || offsetTableOffset + offsetTableLength !== trailerOffset) {
    throw invalidPlist('Offset table length does not match the trailer.');
  }

  var objectOffsets = new Array(objectCount);
  var seenOffsets = Object.create(null);
  for (var offsetIndex = 0; offsetIndex < objectCount; offsetIndex += 1) {
    var objectOffset = readUnsigned(input, offsetTableOffset + offsetIndex * offsetSize, offsetSize, trailerOffset);
    if (objectOffset < HEADER.length || objectOffset >= offsetTableOffset) throw invalidPlist('Object offset is outside the object table.');
    if (seenOffsets[objectOffset]) throw invalidPlist('Object offsets must be unique.');
    seenOffsets[objectOffset] = true;
    objectOffsets[offsetIndex] = objectOffset;
  }
  var sortedOffsets = objectOffsets.slice().sort(function (left, right) { return left - right; });
  var objectLimits = Object.create(null);
  for (var sortedIndex = 0; sortedIndex < sortedOffsets.length; sortedIndex += 1) {
    objectLimits[sortedOffsets[sortedIndex]] = sortedIndex + 1 < sortedOffsets.length ? sortedOffsets[sortedIndex + 1] : offsetTableOffset;
  }

  var states = new Uint8Array(objectCount);
  var cache = new Array(objectCount);

  /** @param {number} offset @param {number} info @param {number} objectLimit @returns {{length:number, offset:number}} */
  function parseLength(offset, info, objectLimit) {
    if (info < 15) return { length: info, offset: offset };
    if (offset >= objectLimit || (input[offset] >>> 4) !== 1) throw invalidPlist('Extended object length is missing its integer marker.');
    var exponent = input[offset] & 0x0f;
    if (exponent > 3) throw invalidPlist('Extended object length uses an unsupported integer width.');
    var width = Math.pow(2, exponent);
    var length = readUnsigned(input, offset + 1, width, objectLimit);
    return { length: length, offset: offset + 1 + width };
  }

  /** @param {number} objectReference @param {number} depth @returns {unknown} */
  function parseObject(objectReference, depth) {
    if (!Number.isSafeInteger(objectReference) || objectReference < 0 || objectReference >= objectCount) throw invalidPlist('Object reference is outside the object table.');
    if (depth > limits.maxDepth) throw invalidPlist('Plist nesting exceeds maxDepth.');
    if (states[objectReference] === 1) throw invalidPlist('Binary plist contains a reference cycle.');
    if (states[objectReference] === 2) return cache[objectReference];
    states[objectReference] = 1;

    var start = objectOffsets[objectReference];
    var objectLimit = objectLimits[start];
    var marker = input[start];
    var type = marker >>> 4;
    var info = marker & 0x0f;
    var cursor = start + 1;
    var value;

    if (type === 0) {
      if (info === 0) value = null;
      else if (info === 8) value = false;
      else if (info === 9) value = true;
      else throw invalidPlist('Unsupported simple object marker.');
    } else if (type === 1) {
      if (info > 4) throw invalidPlist('Unsupported integer width.');
      var integerWidth = Math.pow(2, info);
      value = readInteger(input, cursor, integerWidth, objectLimit);
      cursor += integerWidth;
    } else if (type === 2) {
      if ((info !== 2 && info !== 3) || cursor + Math.pow(2, info) > objectLimit) {
        throw invalidPlist('Real object is malformed.');
      }
      var realWidth = Math.pow(2, info);
      var realView = new DataView(input.buffer, input.byteOffset + cursor, realWidth);
      value = realWidth === 4 ? realView.getFloat32(0, false) : realView.getFloat64(0, false);
      if (!Number.isFinite(value)) throw invalidPlist('Real object is not finite.');
      cursor += realWidth;
    } else if (type === 3) {
      if (info !== 3 || cursor + 8 > objectLimit) throw invalidPlist('Date object is malformed.');
      var seconds = new DataView(input.buffer, input.byteOffset + cursor, 8).getFloat64(0, false);
      if (!Number.isFinite(seconds)) throw invalidPlist('Date object is not finite.');
      value = new Date(APPLE_EPOCH_MILLISECONDS + seconds * 1000);
      if (!Number.isFinite(value.getTime())) throw invalidPlist('Date object is outside the supported range.');
      cursor += 8;
    } else if (type === 8) {
      var uidWidth = info + 1;
      if (uidWidth > 8) throw invalidPlist('UID object exceeds the unsigned-64 range.');
      value = integerFromBigInt(readBigUnsigned(input, cursor, uidWidth, objectLimit));
      cursor += uidWidth;
    } else if (type === 4 || type === 5 || type === 6 || type === 7
        || type === 10 || type === 11 || type === 12 || type === 13) {
      var parsedLength = parseLength(cursor, info, objectLimit);
      var length = parsedLength.length;
      cursor = parsedLength.offset;
      if (type === 4) {
        if (length > limits.maxDataBytes || cursor + length > objectLimit) throw invalidPlist('Data object exceeds its bounds.');
        value = input.slice(cursor, cursor + length);
        cursor += length;
      } else if (type === 5) {
        if (length > limits.maxStringBytes || cursor + length > objectLimit) throw invalidPlist('ASCII string exceeds its bounds.');
        var ascii = '';
        for (var asciiIndex = 0; asciiIndex < length; asciiIndex += 1) {
          if (input[cursor + asciiIndex] > 0x7f) throw invalidPlist('ASCII string contains a non-ASCII byte.');
          ascii += String.fromCharCode(input[cursor + asciiIndex]);
        }
        value = ascii;
        cursor += length;
      } else if (type === 6) {
        var utf16Bytes = length * 2;
        if (!Number.isSafeInteger(utf16Bytes) || utf16Bytes > limits.maxStringBytes || cursor + utf16Bytes > objectLimit) throw invalidPlist('UTF-16 string exceeds its bounds.');
        var unicode = '';
        for (var unicodeIndex = 0; unicodeIndex < length; unicodeIndex += 1) {
          var codeUnit = input[cursor + unicodeIndex * 2] * 256 + input[cursor + unicodeIndex * 2 + 1];
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            if (unicodeIndex + 1 >= length) throw invalidPlist('UTF-16 string contains an unpaired surrogate.');
            var low = input[cursor + (unicodeIndex + 1) * 2] * 256 + input[cursor + (unicodeIndex + 1) * 2 + 1];
            if (low < 0xdc00 || low > 0xdfff) throw invalidPlist('UTF-16 string contains an unpaired surrogate.');
          } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            var prior = unicodeIndex > 0 ? input[cursor + (unicodeIndex - 1) * 2] * 256 + input[cursor + (unicodeIndex - 1) * 2 + 1] : 0;
            if (prior < 0xd800 || prior > 0xdbff) throw invalidPlist('UTF-16 string contains an unpaired surrogate.');
          }
          unicode += String.fromCharCode(codeUnit);
        }
        value = unicode;
        cursor += utf16Bytes;
      } else if (type === 7) {
        if (length > limits.maxStringBytes || cursor + length > objectLimit) throw invalidPlist('UTF-8 string exceeds its bounds.');
        try {
          value = bytes.bytesToUtf8(input.slice(cursor, cursor + length));
        } catch (_) {
          throw invalidPlist('UTF-8 string is malformed.');
        }
        cursor += length;
      } else {
        if (length > limits.maxContainerLength) throw invalidPlist('Container exceeds maxContainerLength.');
        var referencesByteLength = length * referenceSize * (type === 13 ? 2 : 1);
        if (!Number.isSafeInteger(referencesByteLength) || cursor + referencesByteLength > objectLimit) throw invalidPlist('Container references exceed object bounds.');
        if (type === 10 || type === 11 || type === 12) {
          value = new Array(length);
          for (var arrayIndex = 0; arrayIndex < length; arrayIndex += 1) {
            value[arrayIndex] = parseObject(readUnsigned(input, cursor + arrayIndex * referenceSize, referenceSize, objectLimit), depth + 1);
          }
        } else {
          value = {};
          for (var dictionaryIndex = 0; dictionaryIndex < length; dictionaryIndex += 1) {
            var keyReference = readUnsigned(input, cursor + dictionaryIndex * referenceSize, referenceSize, objectLimit);
            var valueReference = readUnsigned(input, cursor + (length + dictionaryIndex) * referenceSize, referenceSize, objectLimit);
            var key = parseObject(keyReference, depth + 1);
            if (typeof key !== 'string') throw invalidPlist('Dictionary key is not a string.');
            if (Object.prototype.hasOwnProperty.call(value, key)) throw invalidPlist('Dictionary contains a duplicate key.');
            Object.defineProperty(value, key, { value: parseObject(valueReference, depth + 1), enumerable: true, writable: true, configurable: true });
          }
        }
        cursor += referencesByteLength;
      }
    } else {
      throw invalidPlist('Unsupported binary plist object type 0x' + type.toString(16) + '.');
    }

    if (cursor > objectLimit) throw invalidPlist('Object overlaps the next object.');
    states[objectReference] = 2;
    cache[objectReference] = value;
    return value;
  }

  return parseObject(topObject, 0);
}

module.exports = {
  APPLE_EPOCH_MILLISECONDS: APPLE_EPOCH_MILLISECONDS,
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  decodeBinaryPlist: decodeBinaryPlist,
  encodeBinaryPlist: encodeBinaryPlist,
};
