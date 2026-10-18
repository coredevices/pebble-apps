'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var DEFAULT_MAX_FRAME_LENGTH = 16 * 1024 * 1024;
var DEFAULT_MAX_COLLECTION_ITEMS = 65535;
var DEFAULT_MAX_DEPTH = 32;
var DEFAULT_VALUE_CACHE_SIZE = 0x1000;
var MAX_KEY_CACHE_ITEMS = 0x20;
var MAX_SIGNED_I64 = '9223372036854775807';
var MAX_NEGATIVE_I64_MAGNITUDE = '9223372036854775808';
var AUTO_CACHE_KEYS = Object.freeze(['sT', 'tP', 'ua', 't', 'sP', 'E', 'H', 'cT', 'sI']);

/** @param {string} message @returns {RuntimeError} */
function invalidFrame(message) {
  return new RuntimeError('INVALID_PACKED_APS_FRAME', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

/** @param {number=} value @param {string} name @param {number} defaultValue @returns {number} */
function boundedOption(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidFrame(name + ' must be a non-negative safe integer.');
  }
  return value;
}

/** @param {unknown} value @param {string} name */
function assertByte(value, name) {
  if (!Number.isInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > 0xff) {
    throw invalidFrame(name + ' must be an unsigned byte.');
  }
}

/** @param {unknown} value @param {ReadonlyArray<string>} keys @param {string} name */
function assertExactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidFrame(name + ' must be an object.');
  }
  var actual = Object.keys(value).sort();
  var expected = keys.slice().sort();
  if (actual.length !== expected.length) throw invalidFrame(name + ' has invalid fields.');
  for (var index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) throw invalidFrame(name + ' has invalid fields.');
  }
}

/** @param {Uint8Array} left @param {Uint8Array} right @returns {boolean} */
function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  for (var index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** @param {number} maxItems @param {number=} maxSize */
function ItemCache(maxItems, maxSize) {
  this.items = [];
  this.maxItems = maxItems;
  this.maxSize = maxSize;
  this.totalSize = 0;
}

/** @returns {ItemCache} */
ItemCache.prototype.clone = function () {
  var copy = new ItemCache(this.maxItems, this.maxSize);
  copy.items = this.items.map(function (item) { return item.slice(); });
  copy.totalSize = this.totalSize;
  return copy;
};

/** @param {Uint8Array} item */
ItemCache.prototype.add = function (item) {
  if (this.maxSize === undefined) {
    if (this.items.length >= this.maxItems) this.items.shift();
    this.items.push(item.slice());
    return;
  }

  if (item.length + 0x20 <= this.maxSize) {
    this.totalSize += item.length + 0x20;
    while (this.totalSize > this.maxSize) {
      var removed = this.items.shift();
      if (!removed) throw invalidFrame('Packed APS value cache accounting is inconsistent.');
      this.totalSize -= removed.length + 0x20;
    }
  }
  this.items.push(item.slice());
};

/** @param {Uint8Array} item @returns {number} */
ItemCache.prototype.reverseIndexOf = function (item) {
  for (var index = this.items.length - 1; index >= 0; index -= 1) {
    if (equalBytes(this.items[index], item)) return this.items.length - index - 1;
  }
  return -1;
};

/** @param {number} reverseIndex @returns {Uint8Array} */
ItemCache.prototype.get = function (reverseIndex) {
  var index = this.items.length - reverseIndex - 1;
  if (index < 0 || index >= this.items.length) throw invalidFrame('Packed APS cache reference is missing.');
  return this.items[index].slice();
};

function Writer() {
  this.output = [];
}

/** @param {number} value */
Writer.prototype.byte = function (value) { this.output.push(value & 0xff); };

/** @param {Uint8Array} value */
Writer.prototype.bytes = function (value) {
  for (var index = 0; index < value.length; index += 1) this.output.push(value[index]);
};

/** @returns {Uint8Array} */
Writer.prototype.finish = function () { return new Uint8Array(this.output); };

/** @param {Uint8Array} input */
function Reader(input) {
  this.input = input;
  this.offset = 0;
}

/** @returns {number} */
Reader.prototype.remaining = function () { return this.input.length - this.offset; };

/** @returns {number} */
Reader.prototype.byte = function () {
  if (this.offset >= this.input.length) throw invalidFrame('Packed APS input is truncated.');
  return this.input[this.offset++];
};

/** @param {number} length @returns {Uint8Array} */
Reader.prototype.bytes = function (length) {
  if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
    throw invalidFrame('Packed APS value is truncated or exceeds its frame.');
  }
  var result = this.input.slice(this.offset, this.offset + length);
  this.offset += length;
  return result;
};

/** @param {number} valueBits @param {number} value @param {number} mask @param {Writer} writer */
function writeTaggedValue(valueBits, value, mask, writer) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidFrame('Packed APS tagged value is out of range.');
  var valueMask = Math.pow(2, valueBits) - 1;
  if (value < valueMask) {
    writer.byte(value | mask);
    return;
  }
  writer.byte(valueMask | mask);
  var remaining = value - valueMask;
  if (remaining === 0) writer.byte(0);
  while (remaining !== 0) {
    var byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining !== 0) byte |= 0x80;
    writer.byte(byte);
  }
}

/** @param {number} valueBits @param {number} tag @param {Reader} reader @returns {number} */
function readTaggedValue(valueBits, tag, reader) {
  var valueMask = Math.pow(2, valueBits) - 1;
  if ((tag & valueMask) !== valueMask) return tag & valueMask;

  var number = 0;
  var multiplier = 1;
  var count = 0;
  var byte;
  do {
    byte = reader.byte();
    count += 1;
    if (count > 8 || (byte & 0x7f) * multiplier > Number.MAX_SAFE_INTEGER - number) {
      throw invalidFrame('Packed APS tagged value exceeds the safe wire limit.');
    }
    number += (byte & 0x7f) * multiplier;
    multiplier *= 128;
  } while ((byte & 0x80) !== 0);
  if (count > 1 && (byte & 0x7f) === 0) throw invalidFrame('Packed APS tagged value is not canonical.');
  if (number > Number.MAX_SAFE_INTEGER - valueMask) {
    throw invalidFrame('Packed APS tagged value exceeds the safe wire limit.');
  }
  return number + valueMask;
}

/**
 * Stateful encoder for `apns-pack-v1` courier messages.
 *
 * @param {{maxFrameLength?: number, valueCacheSize?: number}=} options
 * @constructor
 */
function PackedApsEncoder(options) {
  options = options || {};
  this.maxFrameLength = boundedOption(
    options.maxFrameLength,
    'maxFrameLength',
    DEFAULT_MAX_FRAME_LENGTH
  );
  this.valueCacheSize = boundedOption(
    options.valueCacheSize,
    'valueCacheSize',
    DEFAULT_VALUE_CACHE_SIZE
  );
  this.keyCache = new ItemCache(MAX_KEY_CACHE_ITEMS);
  this.valueCache = new ItemCache(Number.MAX_SAFE_INTEGER, this.valueCacheSize);
}

/**
 * @param {{command: number, attributes: Array<PackedApsAttribute>}} message
 * @returns {Uint8Array}
 */
PackedApsEncoder.prototype.encode = function (message) {
  var oldKeyCache = this.keyCache.clone();
  var oldValueCache = this.valueCache.clone();
  try {
    assertExactObject(message, ['command', 'attributes'], 'Packed APS message');
    assertByte(message.command, 'Packed APS command');
    if (!Array.isArray(message.attributes)) throw invalidFrame('Packed APS attributes must be an array.');

    var bodyWriter = new Writer();
    for (var index = 0; index < message.attributes.length; index += 1) {
      this._writeAttribute(message.attributes[index], bodyWriter, 0, false);
    }
    var body = bodyWriter.finish();
    var frameWriter = new Writer();
    frameWriter.byte(message.command);
    writeTaggedValue(8, body.length, 0, frameWriter);
    frameWriter.bytes(body);
    var frame = frameWriter.finish();
    if (frame.length > this.maxFrameLength) throw invalidFrame('Packed APS frame exceeds the configured limit.');
    return frame;
  } catch (error) {
    this.keyCache = oldKeyCache;
    this.valueCache = oldValueCache;
    throw error;
  }
};

/** @param {PackedApsAttribute} attribute @param {Writer} writer @param {number} depth @param {boolean} autoCache */
PackedApsEncoder.prototype._writeAttribute = function (attribute, writer, depth, autoCache) {
  assertExactObject(attribute, ['id', 'value', 'cached'], 'Packed APS attribute');
  try {
    bytes.assertBytes(attribute.id, 'attribute id');
  } catch (_) {
    throw invalidFrame('Packed APS attribute id must be a Uint8Array.');
  }
  if (attribute.id.length === 0) throw invalidFrame('Packed APS attribute id cannot be empty.');
  if (attribute.id.length > this.maxFrameLength) throw invalidFrame('Packed APS attribute id is too large.');
  if (typeof attribute.cached !== 'boolean') throw invalidFrame('Packed APS cached flag must be boolean.');

  var shouldCache = autoCache ? shouldAutoCache(attribute) : attribute.cached;
  var flags = 0;
  var cachedEncoding = null;
  var existingValue = -1;
  if (shouldCache) {
    var cacheWriter = new Writer();
    this._writeValue(attribute.value, cacheWriter, depth + 1);
    cachedEncoding = cacheWriter.finish();
    existingValue = this.valueCache.reverseIndexOf(cachedEncoding);
    if (existingValue === -1) {
      this.valueCache.add(cachedEncoding);
      flags = 0x40;
    } else {
      flags = 0x80;
    }
  }

  if (attribute.id.length === 1 && (attribute.id[0] & 0x0f) === attribute.id[0]) {
    writer.byte(attribute.id[0] | flags);
  } else {
    var existingKey = this.keyCache.reverseIndexOf(attribute.id);
    if (existingKey !== -1) {
      writeTaggedValue(5, existingKey, 0x20 | flags, writer);
    } else {
      writeTaggedValue(4, attribute.id.length - 1, 0x10 | flags, writer);
      this.keyCache.add(attribute.id);
      writer.bytes(attribute.id);
    }
  }

  if (existingValue !== -1) {
    writeTaggedValue(8, existingValue, 0, writer);
  } else if (cachedEncoding !== null) {
    writer.bytes(cachedEncoding);
  } else {
    this._writeValue(attribute.value, writer, depth + 1);
  }
};

/** @param {PackedApsValue} value @param {Writer} writer @param {number} depth */
PackedApsEncoder.prototype._writeValue = function (value, writer, depth) {
  if (depth > DEFAULT_MAX_DEPTH) throw invalidFrame('Packed APS value nesting is too deep.');
  assertExactObject(value, ['type', 'value'], 'Packed APS value');
  if (typeof value.type !== 'string') throw invalidFrame('Packed APS value type must be a string.');

  if (value.type === 'data') {
    try { bytes.assertBytes(value.value, 'packed data'); } catch (_) {
      throw invalidFrame('Packed APS data value must be a Uint8Array.');
    }
    if (value.value.length > this.maxFrameLength) throw invalidFrame('Packed APS data is too large.');
    writeTaggedValue(6, value.value.length, 0, writer);
    writer.bytes(value.value);
    return;
  }
  if (value.type === 'string') {
    if (typeof value.value !== 'string') throw invalidFrame('Packed APS string value must be a string.');
    var encodedString = bytes.utf8ToBytes(value.value);
    if (encodedString.length > this.maxFrameLength) throw invalidFrame('Packed APS string is too large.');
    writeTaggedValue(5, encodedString.length, 0x40, writer);
    writer.bytes(encodedString);
    return;
  }
  if (value.type === 'int') {
    writePackedInteger(value.value, writer);
    return;
  }
  if (value.type === 'dictionary') {
    if (!Array.isArray(value.value)) throw invalidFrame('Packed APS dictionary must contain attributes.');
    if (value.value.length > DEFAULT_MAX_COLLECTION_ITEMS) throw invalidFrame('Packed APS dictionary is too large.');
    writeTaggedValue(4, value.value.length, 0xc0, writer);
    for (var dictionaryIndex = 0; dictionaryIndex < value.value.length; dictionaryIndex += 1) {
      this._writeAttribute(value.value[dictionaryIndex], writer, depth, true);
    }
    return;
  }
  if (value.type === 'array') {
    if (!Array.isArray(value.value)) throw invalidFrame('Packed APS array must contain values.');
    if (value.value.length > DEFAULT_MAX_COLLECTION_ITEMS) throw invalidFrame('Packed APS array is too large.');
    writeTaggedValue(4, value.value.length, 0xd0, writer);
    for (var arrayIndex = 0; arrayIndex < value.value.length; arrayIndex += 1) {
      this._writeValue(value.value[arrayIndex], writer, depth + 1);
    }
    return;
  }
  if (value.type === 'bool') {
    if (typeof value.value !== 'boolean') throw invalidFrame('Packed APS boolean value must be boolean.');
    writeTaggedValue(4, value.value ? 1 : 0, 0xe0, writer);
    return;
  }
  throw invalidFrame('Packed APS value has an unknown type.');
};

/** @param {PackedApsAttribute} attribute @returns {boolean} */
function shouldAutoCache(attribute) {
  if (attribute.value.type === 'array' || attribute.value.type === 'dictionary') return false;
  try {
    return AUTO_CACHE_KEYS.indexOf(bytes.bytesToUtf8(attribute.id)) !== -1;
  } catch (_) {
    return false;
  }
}

/**
 * Stateful decoder for `apns-pack-v1` courier messages.
 *
 * @param {{maxFrameLength?: number, maxCollectionItems?: number, maxDepth?: number, valueCacheSize?: number}=} options
 * @constructor
 */
function PackedApsDecoder(options) {
  options = options || {};
  this.maxFrameLength = boundedOption(options.maxFrameLength, 'maxFrameLength', DEFAULT_MAX_FRAME_LENGTH);
  this.maxCollectionItems = boundedOption(
    options.maxCollectionItems,
    'maxCollectionItems',
    DEFAULT_MAX_COLLECTION_ITEMS
  );
  this.maxDepth = boundedOption(options.maxDepth, 'maxDepth', DEFAULT_MAX_DEPTH);
  this.valueCacheSize = boundedOption(
    options.valueCacheSize,
    'valueCacheSize',
    DEFAULT_VALUE_CACHE_SIZE
  );
  this.keyCache = new ItemCache(MAX_KEY_CACHE_ITEMS);
  this.valueCache = new ItemCache(Number.MAX_SAFE_INTEGER, this.valueCacheSize);
  this.buffer = new Uint8Array(0);
}

/** @param {Uint8Array} frame @returns {{command: number, attributes: Array<PackedApsAttribute>}} */
PackedApsDecoder.prototype.decode = function (frame) {
  bytes.assertBytes(frame, 'frame');
  var oldKeyCache = this.keyCache.clone();
  var oldValueCache = this.valueCache.clone();
  try {
    if (frame.length > this.maxFrameLength) throw invalidFrame('Packed APS frame exceeds the configured limit.');
    var expectedLength = packedFrameLength(frame, this.maxFrameLength);
    if (expectedLength === null || expectedLength !== frame.length) {
      throw invalidFrame('Packed APS frame length does not match its header.');
    }

    var reader = new Reader(frame);
    var command = reader.byte();
    var lengthTag = reader.byte();
    var bodyLength = readTaggedValue(8, lengthTag, reader);
    var body = new Reader(reader.bytes(bodyLength));
    if (reader.remaining() !== 0) throw invalidFrame('Packed APS frame has trailing bytes.');

    var attributes = [];
    while (body.remaining() > 0) {
      if (attributes.length >= this.maxCollectionItems) throw invalidFrame('Packed APS has too many attributes.');
      attributes.push(this._readAttribute(body, 0));
    }
    return { command: command, attributes: attributes };
  } catch (error) {
    this.keyCache = oldKeyCache;
    this.valueCache = oldValueCache;
    throw error;
  }
};

/** @param {Reader} reader @param {number} depth @returns {PackedApsAttribute} */
PackedApsDecoder.prototype._readAttribute = function (reader, depth) {
  var tag = reader.byte();
  var id;
  if ((tag & 0x20) !== 0) {
    id = this.keyCache.get(tag & 0x1f);
  } else if ((tag & 0x10) !== 0) {
    var idLength = readTaggedValue(4, tag, reader) + 1;
    if (idLength > this.maxFrameLength) throw invalidFrame('Packed APS attribute id is too large.');
    id = reader.bytes(idLength);
    this.keyCache.add(id);
  } else {
    id = new Uint8Array([tag & 0x0f]);
  }

  var cached = false;
  var value;
  if ((tag & 0x80) !== 0) {
    var referenceTag = reader.byte();
    var reference = readTaggedValue(8, referenceTag, reader);
    var cachedReader = new Reader(this.valueCache.get(reference));
    value = this._readValue(cachedReader, depth + 1);
    if (cachedReader.remaining() !== 0) throw invalidFrame('Packed APS cached value has trailing bytes.');
    cached = true;
  } else if ((tag & 0x40) !== 0) {
    var start = reader.offset;
    value = this._readValue(reader, depth + 1);
    this.valueCache.add(reader.input.slice(start, reader.offset));
    cached = true;
  } else {
    value = this._readValue(reader, depth + 1);
  }
  return { id: id, value: value, cached: cached };
};

/** @param {Reader} reader @param {number} depth @returns {PackedApsValue} */
PackedApsDecoder.prototype._readValue = function (reader, depth) {
  if (depth > this.maxDepth) throw invalidFrame('Packed APS value nesting is too deep.');
  var tag = reader.byte();
  var type = tag >>> 6;
  if (type === 0) {
    var dataLength = readTaggedValue(6, tag, reader);
    return { type: 'data', value: reader.bytes(dataLength) };
  }
  if (type === 1) {
    var stringLength = readTaggedValue(5, tag, reader);
    var stringBytes = reader.bytes(stringLength);
    try {
      return { type: 'string', value: bytes.bytesToUtf8(stringBytes) };
    } catch (_) {
      throw invalidFrame('Packed APS string contains invalid UTF-8.');
    }
  }
  if (type === 2) return readPackedInteger(tag, reader);

  var count = readTaggedValue(4, tag, reader);
  if ((tag & 0x20) !== 0) return { type: 'bool', value: count !== 0 };
  if (count > this.maxCollectionItems) throw invalidFrame('Packed APS collection exceeds the configured limit.');
  if ((tag & 0x10) !== 0) {
    var values = [];
    for (var arrayIndex = 0; arrayIndex < count; arrayIndex += 1) {
      values.push(this._readValue(reader, depth + 1));
    }
    return { type: 'array', value: values };
  }

  var attributes = [];
  for (var dictionaryIndex = 0; dictionaryIndex < count; dictionaryIndex += 1) {
    attributes.push(this._readAttribute(reader, depth));
  }
  return { type: 'dictionary', value: attributes };
};

/**
 * Incrementally decode complete messages while preserving negotiated caches across TLS reads.
 *
 * @param {Uint8Array} chunk
 * @returns {Array<{command: number, attributes: Array<PackedApsAttribute>}>}
 */
PackedApsDecoder.prototype.push = function (chunk) {
  bytes.assertBytes(chunk, 'chunk');
  if (chunk.length > 0) this.buffer = bytes.concatBytes(this.buffer, chunk);
  var messages = [];
  var offset = 0;
  try {
    while (offset < this.buffer.length) {
      var length = packedFrameLength(this.buffer.slice(offset), this.maxFrameLength);
      if (length === null || this.buffer.length - offset < length) break;
      messages.push(this.decode(this.buffer.slice(offset, offset + length)));
      offset += length;
    }
    if (offset > 0) this.buffer = this.buffer.slice(offset);
    if (this.buffer.length > this.maxFrameLength) {
      throw invalidFrame('Packed APS buffered frame exceeds the configured limit.');
    }
    return messages;
  } catch (error) {
    this.buffer = new Uint8Array(0);
    throw error;
  }
};

/** @returns {number} */
PackedApsDecoder.prototype.bufferedLength = function () { return this.buffer.length; };

PackedApsDecoder.prototype.finish = function () {
  if (this.buffer.length !== 0) throw invalidFrame('Packed APS stream ended with a truncated frame.');
};

/** @param {Uint8Array} input @param {number} maximum @returns {number|null} */
function packedFrameLength(input, maximum) {
  if (input.length < 2) return null;
  var tag = input[1];
  var bodyLength;
  var headerLength = 2;
  if (tag !== 0xff) {
    bodyLength = tag;
  } else {
    var number = 0;
    var multiplier = 1;
    var terminal = false;
    for (var index = 2; index < input.length && index < 10; index += 1) {
      var byte = input[index];
      if ((byte & 0x7f) * multiplier > Number.MAX_SAFE_INTEGER - number) {
        throw invalidFrame('Packed APS frame length exceeds the safe wire limit.');
      }
      number += (byte & 0x7f) * multiplier;
      headerLength += 1;
      if ((byte & 0x80) === 0) {
        if (headerLength > 3 && (byte & 0x7f) === 0) {
          throw invalidFrame('Packed APS frame length is not canonical.');
        }
        terminal = true;
        break;
      }
      multiplier *= 128;
    }
    if (!terminal) {
      if (input.length < 10) return null;
      throw invalidFrame('Packed APS frame length prefix is invalid.');
    }
    bodyLength = number + 0xff;
  }
  if (!Number.isSafeInteger(bodyLength) || bodyLength > maximum || headerLength + bodyLength > maximum) {
    throw invalidFrame('Packed APS frame exceeds the configured limit.');
  }
  return headerLength + bodyLength;
}

/** @param {number|string} value @param {Writer} writer */
function writePackedInteger(value, writer) {
  var normalized = normalizeI64(value);
  if (!normalized.negative && compareDecimal(normalized.magnitude, '31') <= 0) {
    writer.byte(0x80 | Number(normalized.magnitude));
    return;
  }
  var magnitude = decimalToBytes(normalized.magnitude);
  var tag = 0xa0 | (magnitude.length - 1);
  if (normalized.negative) tag |= 0x08;
  writer.byte(tag);
  writer.bytes(magnitude);
}

/** @param {number} tag @param {Reader} reader @returns {PackedApsValue} */
function readPackedInteger(tag, reader) {
  if ((tag & 0x20) === 0) return { type: 'int', value: tag & 0x1f };
  var length = (tag & 0x07) + 1;
  var negative = (tag & 0x08) !== 0;
  var magnitudeBytes = reader.bytes(length);
  if (magnitudeBytes[0] === 0) throw invalidFrame('Packed APS integer has a non-canonical magnitude.');
  var magnitude = bytesToDecimal(magnitudeBytes);
  var maximum = negative ? MAX_NEGATIVE_I64_MAGNITUDE : MAX_SIGNED_I64;
  if (compareDecimal(magnitude, maximum) > 0) throw invalidFrame('Packed APS integer exceeds signed 64-bit range.');
  var signed = negative ? '-' + magnitude : magnitude;
  var numeric = Number(signed);
  return { type: 'int', value: Number.isSafeInteger(numeric) ? numeric : signed };
}

/** @param {number|string} value @returns {{negative: boolean, magnitude: string}} */
function normalizeI64(value) {
  var string;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalidFrame('Packed APS integer number must be a safe integer.');
    string = String(value);
  } else if (typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) {
    string = value;
  } else {
    throw invalidFrame('Packed APS integer must be a safe integer or canonical decimal string.');
  }
  var negative = string[0] === '-';
  var magnitude = negative ? string.slice(1) : string;
  if (negative && magnitude === '0') throw invalidFrame('Packed APS integer cannot be negative zero.');
  var maximum = negative ? MAX_NEGATIVE_I64_MAGNITUDE : MAX_SIGNED_I64;
  if (compareDecimal(magnitude, maximum) > 0) throw invalidFrame('Packed APS integer exceeds signed 64-bit range.');
  return { negative: negative, magnitude: magnitude };
}

/** @param {string} left @param {string} right @returns {number} */
function compareDecimal(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** @param {string} decimal @returns {Uint8Array} */
function decimalToBytes(decimal) {
  if (decimal === '0') return new Uint8Array([0]);
  var digits = decimal.split('').map(Number);
  var output = [];
  while (digits.length > 0) {
    var quotient = [];
    var remainder = 0;
    for (var index = 0; index < digits.length; index += 1) {
      var current = remainder * 10 + digits[index];
      var digit = Math.floor(current / 256);
      remainder = current % 256;
      if (quotient.length > 0 || digit !== 0) quotient.push(digit);
    }
    output.unshift(remainder);
    digits = quotient;
  }
  return new Uint8Array(output);
}

/** @param {Uint8Array} magnitude @returns {string} */
function bytesToDecimal(magnitude) {
  var digits = [0];
  for (var byteIndex = 0; byteIndex < magnitude.length; byteIndex += 1) {
    var carry = magnitude[byteIndex];
    for (var digitIndex = digits.length - 1; digitIndex >= 0; digitIndex -= 1) {
      var value = digits[digitIndex] * 256 + carry;
      digits[digitIndex] = value % 10;
      carry = Math.floor(value / 10);
    }
    while (carry > 0) {
      digits.unshift(carry % 10);
      carry = Math.floor(carry / 10);
    }
  }
  return digits.join('');
}

/**
 * @typedef {object} PackedApsAttribute
 * @property {Uint8Array} id
 * @property {PackedApsValue} value
 * @property {boolean} cached
 */

/**
 * @typedef {object} PackedApsValue
 * @property {'data'|'string'|'int'|'dictionary'|'array'|'bool'} type
 * @property {Uint8Array|string|number|Array<PackedApsAttribute>|Array<PackedApsValue>|boolean} value
 */

module.exports = {
  AUTO_CACHE_KEYS: AUTO_CACHE_KEYS,
  DEFAULT_MAX_COLLECTION_ITEMS: DEFAULT_MAX_COLLECTION_ITEMS,
  DEFAULT_MAX_DEPTH: DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FRAME_LENGTH: DEFAULT_MAX_FRAME_LENGTH,
  DEFAULT_VALUE_CACHE_SIZE: DEFAULT_VALUE_CACHE_SIZE,
  PackedApsDecoder: PackedApsDecoder,
  PackedApsEncoder: PackedApsEncoder,
};
