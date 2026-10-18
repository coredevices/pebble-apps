'use strict';

var RuntimeError = require('./errors').RuntimeError;
var ERROR_KINDS = require('./errors').ERROR_KINDS;

var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var HEX_ALPHABET = '0123456789abcdef';

/**
 * @param {unknown} value
 * @param {string=} name
 * @returns {asserts value is Uint8Array}
 */
function assertBytes(value, name) {
  if (!(value instanceof Uint8Array)) {
    throw invalidInput((name || 'value') + ' must be a Uint8Array.');
  }
}

/** @param {string} message @returns {RuntimeError} */
function invalidInput(message) {
  return new RuntimeError('INVALID_INPUT', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function copyBytes(bytes) {
  assertBytes(bytes, 'bytes');
  return new Uint8Array(bytes);
}

/**
 * @param {...Uint8Array} chunks
 * @returns {Uint8Array}
 */
function concatBytes() {
  var chunks = Array.prototype.slice.call(arguments);
  var totalLength = 0;
  for (var index = 0; index < chunks.length; index += 1) {
    assertBytes(chunks[index], 'chunk ' + index);
    totalLength += chunks[index].length;
    if (!Number.isSafeInteger(totalLength)) {
      throw invalidInput('Combined byte length is too large.');
    }
  }

  var result = new Uint8Array(totalLength);
  var offset = 0;
  for (var chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    result.set(chunks[chunkIndex], offset);
    offset += chunks[chunkIndex].length;
  }
  return result;
}

/**
 * @param {Uint8Array} left
 * @param {Uint8Array} right
 * @returns {boolean}
 */
function bytesEqual(left, right) {
  assertBytes(left, 'left');
  assertBytes(right, 'right');
  if (left.length !== right.length) return false;

  var difference = 0;
  for (var index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  assertBytes(bytes, 'bytes');
  var result = '';
  for (var index = 0; index < bytes.length; index += 1) {
    var value = bytes[index];
    result += HEX_ALPHABET[value >>> 4] + HEX_ALPHABET[value & 0x0f];
  }
  return result;
}

/**
 * @param {string} value
 * @returns {Uint8Array}
 */
function hexToBytes(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw invalidInput('Hex input must contain an even number of hexadecimal characters.');
  }

  var result = new Uint8Array(value.length / 2);
  for (var index = 0; index < result.length; index += 1) {
    result[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  assertBytes(bytes, 'bytes');
  var result = '';
  for (var index = 0; index < bytes.length; index += 3) {
    var remaining = bytes.length - index;
    var first = bytes[index];
    var second = remaining > 1 ? bytes[index + 1] : 0;
    var third = remaining > 2 ? bytes[index + 2] : 0;
    var packed = first * 0x10000 + second * 0x100 + third;

    result += BASE64_ALPHABET[(packed >>> 18) & 0x3f];
    result += BASE64_ALPHABET[(packed >>> 12) & 0x3f];
    result += remaining > 1 ? BASE64_ALPHABET[(packed >>> 6) & 0x3f] : '=';
    result += remaining > 2 ? BASE64_ALPHABET[packed & 0x3f] : '=';
  }
  return result;
}

/**
 * Decode standard padded or unpadded base64. Whitespace and URL-safe characters are rejected.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
function base64ToBytes(value) {
  if (typeof value !== 'string' || /\s/.test(value)) {
    throw invalidInput('Base64 input must be a string without whitespace.');
  }
  if (value.length === 0) return new Uint8Array(0);

  var firstPadding = value.indexOf('=');
  if (firstPadding !== -1) {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={1,2}$/.test(value) || value.length - firstPadding > 2) {
      throw invalidInput('Base64 input has invalid padding.');
    }
  } else if (!/^[A-Za-z0-9+/]+$/.test(value) || value.length % 4 === 1) {
    throw invalidInput('Base64 input contains invalid characters or length.');
  }

  var normalized = value;
  while (normalized.length % 4 !== 0) normalized += '=';

  var padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  var result = new Uint8Array((normalized.length / 4) * 3 - padding);
  var outputOffset = 0;

  for (var index = 0; index < normalized.length; index += 4) {
    var a = base64Value(normalized[index]);
    var b = base64Value(normalized[index + 1]);
    var c = normalized[index + 2] === '=' ? 0 : base64Value(normalized[index + 2]);
    var d = normalized[index + 3] === '=' ? 0 : base64Value(normalized[index + 3]);

    if (normalized[index + 2] === '=' && (b & 0x0f) !== 0) {
      throw invalidInput('Base64 input has non-zero trailing bits.');
    }
    if (normalized[index + 3] === '=' && normalized[index + 2] !== '=' && (c & 0x03) !== 0) {
      throw invalidInput('Base64 input has non-zero trailing bits.');
    }

    var packed = a * 0x40000 + b * 0x1000 + c * 0x40 + d;
    if (outputOffset < result.length) result[outputOffset++] = (packed >>> 16) & 0xff;
    if (outputOffset < result.length) result[outputOffset++] = (packed >>> 8) & 0xff;
    if (outputOffset < result.length) result[outputOffset++] = packed & 0xff;
  }
  return result;
}

/** @param {string} character @returns {number} */
function base64Value(character) {
  var value = BASE64_ALPHABET.indexOf(character);
  if (value === -1) throw invalidInput('Base64 input contains an invalid character.');
  return value;
}

/**
 * Encode a JavaScript string as UTF-8. Unpaired UTF-16 surrogates encode as U+FFFD.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
function utf8ToBytes(value) {
  if (typeof value !== 'string') throw invalidInput('UTF-8 input must be a string.');

  var output = [];
  for (var index = 0; index < value.length; index += 1) {
    var codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      var low = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      output.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      output.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      output.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    } else {
      output.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return new Uint8Array(output);
}

/**
 * Decode well-formed UTF-8. Malformed and overlong sequences are rejected.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToUtf8(bytes) {
  assertBytes(bytes, 'bytes');
  var result = '';

  for (var index = 0; index < bytes.length;) {
    var first = bytes[index];
    var codePoint;
    var length;
    var minimum;

    if (first <= 0x7f) {
      codePoint = first;
      length = 1;
      minimum = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      length = 2;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      length = 3;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      length = 4;
      minimum = 0x10000;
    } else {
      throw invalidInput('UTF-8 input contains an invalid leading byte at offset ' + index + '.');
    }

    if (index + length > bytes.length) {
      throw invalidInput('UTF-8 input ends in a truncated sequence at offset ' + index + '.');
    }
    for (var continuationIndex = 1; continuationIndex < length; continuationIndex += 1) {
      var continuation = bytes[index + continuationIndex];
      if ((continuation & 0xc0) !== 0x80) {
        throw invalidInput('UTF-8 input contains an invalid continuation byte at offset ' + (index + continuationIndex) + '.');
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw invalidInput('UTF-8 input contains an invalid code point at offset ' + index + '.');
    }

    if (codePoint <= 0xffff) {
      result += String.fromCharCode(codePoint);
    } else {
      codePoint -= 0x10000;
      result += String.fromCharCode(0xd800 + (codePoint >>> 10), 0xdc00 + (codePoint & 0x3ff));
    }
    index += length;
  }
  return result;
}

/** @param {Uint8Array} bytes @param {number} offset @param {number} width */
function assertRead(bytes, offset, width) {
  assertBytes(bytes, 'bytes');
  if (!Number.isInteger(offset) || offset < 0 || offset + width > bytes.length) {
    throw invalidInput('Byte offset is outside the input.');
  }
}

/** @param {number} value @param {number} maximum */
function assertUnsignedInteger(value, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw invalidInput('Value must be an unsigned integer no greater than ' + maximum + '.');
  }
}

/** @param {Uint8Array} bytes @param {number=} offset @returns {number} */
function readUint16BE(bytes, offset) {
  offset = offset === undefined ? 0 : offset;
  assertRead(bytes, offset, 2);
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

/** @param {Uint8Array} bytes @param {number=} offset @returns {number} */
function readUint16LE(bytes, offset) {
  offset = offset === undefined ? 0 : offset;
  assertRead(bytes, offset, 2);
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

/** @param {Uint8Array} bytes @param {number=} offset @returns {number} */
function readUint32BE(bytes, offset) {
  offset = offset === undefined ? 0 : offset;
  assertRead(bytes, offset, 4);
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

/** @param {Uint8Array} bytes @param {number=} offset @returns {number} */
function readUint32LE(bytes, offset) {
  offset = offset === undefined ? 0 : offset;
  assertRead(bytes, offset, 4);
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 +
    bytes[offset + 3] * 0x1000000
  );
}

/** @param {number} value @returns {Uint8Array} */
function uint16BE(value) {
  assertUnsignedInteger(value, 0xffff);
  return new Uint8Array([value >>> 8, value]);
}

/** @param {number} value @returns {Uint8Array} */
function uint16LE(value) {
  assertUnsignedInteger(value, 0xffff);
  return new Uint8Array([value, value >>> 8]);
}

/** @param {number} value @returns {Uint8Array} */
function uint32BE(value) {
  assertUnsignedInteger(value, 0xffffffff);
  return new Uint8Array([value / 0x1000000, value >>> 16, value >>> 8, value]);
}

/** @param {number} value @returns {Uint8Array} */
function uint32LE(value) {
  assertUnsignedInteger(value, 0xffffffff);
  return new Uint8Array([value, value >>> 8, value >>> 16, value / 0x1000000]);
}

module.exports = {
  assertBytes: assertBytes,
  base64ToBytes: base64ToBytes,
  bytesEqual: bytesEqual,
  bytesToBase64: bytesToBase64,
  bytesToHex: bytesToHex,
  bytesToUtf8: bytesToUtf8,
  concatBytes: concatBytes,
  copyBytes: copyBytes,
  hexToBytes: hexToBytes,
  readUint16BE: readUint16BE,
  readUint16LE: readUint16LE,
  readUint32BE: readUint32BE,
  readUint32LE: readUint32LE,
  uint16BE: uint16BE,
  uint16LE: uint16LE,
  uint32BE: uint32BE,
  uint32LE: uint32LE,
  utf8ToBytes: utf8ToBytes,
};
