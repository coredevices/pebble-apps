'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var WIRE_TYPES = Object.freeze({
  VARINT: 0,
  FIXED64: 1,
  LENGTH_DELIMITED: 2,
  START_GROUP: 3,
  END_GROUP: 4,
  FIXED32: 5,
});
var MAX_FIELD_NUMBER = 0x1fffffff;
var MAX_UINT32 = 0xffffffff;
var MAX_UINT64 = (1n << 64n) - 1n;
var DEFAULT_LIMITS = Object.freeze({
  maxMessageLength: 16 * 1024 * 1024,
  maxFieldLength: 8 * 1024 * 1024,
  maxFields: 100000,
  maxGroupDepth: 32,
});

/** @param {string} message @returns {RuntimeError} */
function invalidProtobuf(message) {
  return new RuntimeError('INVALID_PROTOBUF', message, { kind: ERROR_KINDS.INVALID_INPUT });
}

/** @param {Object=} options @returns {{maxMessageLength: number, maxFieldLength: number, maxFields: number, maxGroupDepth: number}} */
function limitsFrom(options) {
  options = options || {};
  var result = {};
  Object.keys(DEFAULT_LIMITS).forEach(function (name) {
    var value = options[name] === undefined ? DEFAULT_LIMITS[name] : options[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw invalidProtobuf(name + ' must be a non-negative safe integer.');
    }
    result[name] = value;
  });
  return result;
}

/** @param {number|bigint} value @param {string=} name @returns {bigint} */
function unsigned64(value, name) {
  var result;
  if (typeof value === 'bigint') {
    result = value;
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    result = BigInt(value);
  } else {
    throw invalidProtobuf((name || 'value') + ' must be an unsigned integer.');
  }
  if (result < 0n || result > MAX_UINT64) {
    throw invalidProtobuf((name || 'value') + ' exceeds the uint64 range.');
  }
  return result;
}

/**
 * @param {number|bigint} value
 * @returns {Uint8Array}
 */
function encodeVarint(value) {
  var remaining = unsigned64(value, 'varint');
  var output = [];
  do {
    var octet = Number(remaining & 0x7fn);
    remaining >>= 7n;
    output.push(remaining === 0n ? octet : octet | 0x80);
  } while (remaining !== 0n);
  return new Uint8Array(output);
}

/**
 * @param {Uint8Array} input
 * @param {number=} offset
 * @returns {{value: bigint, nextOffset: number, bytesRead: number}}
 */
function decodeVarint(input, offset) {
  bytes.assertBytes(input, 'input');
  offset = offset === undefined ? 0 : offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > input.length) {
    throw invalidProtobuf('Varint offset is outside the input.');
  }

  var value = 0n;
  for (var index = 0; index < 10; index += 1) {
    var position = offset + index;
    if (position >= input.length) throw invalidProtobuf('Varint is truncated.');
    var octet = input[position];
    if (index === 9 && octet > 1) throw invalidProtobuf('Varint exceeds the uint64 range.');
    value |= BigInt(octet & 0x7f) << BigInt(index * 7);
    if ((octet & 0x80) === 0) {
      return { value: value, nextOffset: position + 1, bytesRead: index + 1 };
    }
  }
  throw invalidProtobuf('Varint exceeds ten bytes.');
}

/** @param {number} fieldNumber @param {number} wireType */
function assertTag(fieldNumber, wireType) {
  if (!Number.isInteger(fieldNumber) || fieldNumber < 1 || fieldNumber > MAX_FIELD_NUMBER) {
    throw invalidProtobuf('Field number is outside the protobuf range.');
  }
  if (!Number.isInteger(wireType) || wireType < 0 || wireType > 5) {
    throw invalidProtobuf('Wire type is not recognized.');
  }
}

/** @param {number} fieldNumber @param {number} wireType @returns {Uint8Array} */
function encodeTag(fieldNumber, wireType) {
  assertTag(fieldNumber, wireType);
  return encodeVarint(BigInt(fieldNumber) * 8n + BigInt(wireType));
}

/** @param {number|bigint} value @returns {Uint8Array} */
function encodeFixed64(value) {
  var remaining = unsigned64(value, 'fixed64');
  var result = new Uint8Array(8);
  for (var index = 0; index < result.length; index += 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

/** @param {Uint8Array} input @param {number=} offset @returns {bigint} */
function decodeFixed64(input, offset) {
  bytes.assertBytes(input, 'input');
  offset = offset === undefined ? 0 : offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > input.length) {
    throw invalidProtobuf('fixed64 value is truncated.');
  }
  var value = 0n;
  for (var index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(input[offset + index]);
  }
  return value;
}

/** @param {number} value @returns {Uint8Array} */
function encodeFixed32(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw invalidProtobuf('fixed32 value is outside the uint32 range.');
  }
  return bytes.uint32LE(value);
}

/** @param {Uint8Array} input @param {number=} offset @returns {number} */
function decodeFixed32(input, offset) {
  try {
    return bytes.readUint32LE(input, offset);
  } catch (error) {
    throw invalidProtobuf('fixed32 value is truncated.');
  }
}

/** @param {number} value @returns {Uint8Array} */
function encodeDouble(value) {
  if (typeof value !== 'number') {
    throw invalidProtobuf('double value must be a number.');
  }
  var result = new Uint8Array(8);
  new DataView(result.buffer).setFloat64(0, value, true);
  return result;
}

/** @param {Uint8Array} input @param {number=} offset @returns {number} */
function decodeDouble(input, offset) {
  bytes.assertBytes(input, 'input');
  offset = offset === undefined ? 0 : offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > input.length) {
    throw invalidProtobuf('double value is truncated.');
  }
  return new DataView(input.buffer, input.byteOffset + offset, 8).getFloat64(0, true);
}

function ProtobufWriter() {
  this.chunks = [];
}

/** @param {number} fieldNumber @param {number|bigint} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.uint64 = function (fieldNumber, value) {
  this.chunks.push(encodeTag(fieldNumber, WIRE_TYPES.VARINT), encodeVarint(value));
  return this;
};

/** @param {number} fieldNumber @param {number} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.uint32 = function (fieldNumber, value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_UINT32) {
    throw invalidProtobuf('uint32 value is outside the uint32 range.');
  }
  return this.uint64(fieldNumber, value);
};

/** @param {number} fieldNumber @param {boolean} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.bool = function (fieldNumber, value) {
  if (typeof value !== 'boolean') throw invalidProtobuf('bool value must be boolean.');
  return this.uint64(fieldNumber, value ? 1 : 0);
};

/** @param {number} fieldNumber @param {number} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.fixed32 = function (fieldNumber, value) {
  this.chunks.push(encodeTag(fieldNumber, WIRE_TYPES.FIXED32), encodeFixed32(value));
  return this;
};

/** @param {number} fieldNumber @param {number|bigint} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.fixed64 = function (fieldNumber, value) {
  this.chunks.push(encodeTag(fieldNumber, WIRE_TYPES.FIXED64), encodeFixed64(value));
  return this;
};

/** @param {number} fieldNumber @param {number} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.double = function (fieldNumber, value) {
  this.chunks.push(encodeTag(fieldNumber, WIRE_TYPES.FIXED64), encodeDouble(value));
  return this;
};

/** @param {number} fieldNumber @param {Uint8Array} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.bytes = function (fieldNumber, value) {
  bytes.assertBytes(value, 'value');
  this.chunks.push(
    encodeTag(fieldNumber, WIRE_TYPES.LENGTH_DELIMITED),
    encodeVarint(value.length),
    new Uint8Array(value)
  );
  return this;
};

/** @param {number} fieldNumber @param {string} value @returns {ProtobufWriter} */
ProtobufWriter.prototype.string = function (fieldNumber, value) {
  if (typeof value !== 'string') throw invalidProtobuf('string value must be a string.');
  return this.bytes(fieldNumber, bytes.utf8ToBytes(value));
};

/** @returns {Uint8Array} */
ProtobufWriter.prototype.finish = function () {
  return bytes.concatBytes.apply(null, this.chunks);
};

/**
 * @param {Uint8Array} input
 * @param {Object=} options
 */
function ProtobufReader(input, options) {
  bytes.assertBytes(input, 'input');
  this.limits = limitsFrom(options);
  if (input.length > this.limits.maxMessageLength) {
    throw invalidProtobuf('Message exceeds maxMessageLength.');
  }
  this.input = new Uint8Array(input);
  this.offset = 0;
  this.fieldCount = 0;
  this.currentField = null;
}

/** @returns {{number: number, wireType: number}|null} */
ProtobufReader.prototype.nextField = function () {
  if (this.currentField !== null) {
    throw invalidProtobuf('Previous field has not been consumed.');
  }
  if (this.offset === this.input.length) return null;

  this.fieldCount += 1;
  if (this.fieldCount > this.limits.maxFields) throw invalidProtobuf('Message contains too many fields.');
  var decoded = decodeVarint(this.input, this.offset);
  this.offset = decoded.nextOffset;
  if (decoded.value > 0xffffffffn) throw invalidProtobuf('Encoded field tag exceeds 32 bits.');
  var tag = Number(decoded.value);
  var field = { number: Math.floor(tag / 8), wireType: tag & 7 };
  assertTag(field.number, field.wireType);
  this.currentField = field;
  return field;
};

/** @param {{number: number, wireType: number}} field @param {number} expected */
ProtobufReader.prototype._consume = function (field, expected) {
  if (field !== this.currentField) throw invalidProtobuf('Field is not the current reader field.');
  if (field.wireType !== expected) throw invalidProtobuf('Field has the wrong wire type.');
  this.currentField = null;
};

/** @param {number} width @returns {number} */
ProtobufReader.prototype._take = function (width) {
  if (this.offset + width > this.input.length) throw invalidProtobuf('Field value is truncated.');
  var start = this.offset;
  this.offset += width;
  return start;
};

/** @param {{number: number, wireType: number}} field @returns {bigint} */
ProtobufReader.prototype.readUint64 = function (field) {
  this._consume(field, WIRE_TYPES.VARINT);
  var decoded = decodeVarint(this.input, this.offset);
  this.offset = decoded.nextOffset;
  return decoded.value;
};

/** @param {{number: number, wireType: number}} field @returns {number} */
ProtobufReader.prototype.readUint32 = function (field) {
  var value = this.readUint64(field);
  if (value > BigInt(MAX_UINT32)) throw invalidProtobuf('uint32 field exceeds the uint32 range.');
  return Number(value);
};

/** @param {{number: number, wireType: number}} field @returns {boolean} */
ProtobufReader.prototype.readBool = function (field) {
  var value = this.readUint64(field);
  return value !== 0n;
};

/** @param {{number: number, wireType: number}} field @returns {number} */
ProtobufReader.prototype.readFixed32 = function (field) {
  this._consume(field, WIRE_TYPES.FIXED32);
  return decodeFixed32(this.input, this._take(4));
};

/** @param {{number: number, wireType: number}} field @returns {bigint} */
ProtobufReader.prototype.readFixed64 = function (field) {
  this._consume(field, WIRE_TYPES.FIXED64);
  return decodeFixed64(this.input, this._take(8));
};

/** @param {{number: number, wireType: number}} field @returns {number} */
ProtobufReader.prototype.readDouble = function (field) {
  this._consume(field, WIRE_TYPES.FIXED64);
  return decodeDouble(this.input, this._take(8));
};

/** @returns {number} */
ProtobufReader.prototype._readLength = function () {
  var decoded = decodeVarint(this.input, this.offset);
  this.offset = decoded.nextOffset;
  if (decoded.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidProtobuf('Length-delimited field length is too large.');
  }
  var length = Number(decoded.value);
  if (length > this.limits.maxFieldLength) {
    throw invalidProtobuf('Length-delimited field exceeds maxFieldLength.');
  }
  return length;
};

/** @param {{number: number, wireType: number}} field @returns {Uint8Array} */
ProtobufReader.prototype.readBytes = function (field) {
  this._consume(field, WIRE_TYPES.LENGTH_DELIMITED);
  var length = this._readLength();
  var start = this._take(length);
  return this.input.slice(start, start + length);
};

/** @param {{number: number, wireType: number}} field @returns {string} */
ProtobufReader.prototype.readString = function (field) {
  try {
    return bytes.bytesToUtf8(this.readBytes(field));
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'INVALID_PROTOBUF') throw error;
    throw invalidProtobuf('String field is not well-formed UTF-8.');
  }
};

/** @param {{number: number, wireType: number}} field @param {number=} depth */
ProtobufReader.prototype.skipField = function (field, depth) {
  depth = depth === undefined ? 0 : depth;
  if (field !== this.currentField) throw invalidProtobuf('Field is not the current reader field.');

  if (field.wireType === WIRE_TYPES.VARINT) {
    this.readUint64(field);
  } else if (field.wireType === WIRE_TYPES.FIXED64) {
    this._consume(field, WIRE_TYPES.FIXED64);
    this._take(8);
  } else if (field.wireType === WIRE_TYPES.LENGTH_DELIMITED) {
    this._consume(field, WIRE_TYPES.LENGTH_DELIMITED);
    this._take(this._readLength());
  } else if (field.wireType === WIRE_TYPES.FIXED32) {
    this._consume(field, WIRE_TYPES.FIXED32);
    this._take(4);
  } else if (field.wireType === WIRE_TYPES.START_GROUP) {
    if (depth >= this.limits.maxGroupDepth) throw invalidProtobuf('Group nesting exceeds maxGroupDepth.');
    this._consume(field, WIRE_TYPES.START_GROUP);
    for (;;) {
      var nested = this.nextField();
      if (nested === null) throw invalidProtobuf('Group is unterminated.');
      if (nested.wireType === WIRE_TYPES.END_GROUP) {
        if (nested.number !== field.number) throw invalidProtobuf('Group end tag does not match its start tag.');
        this._consume(nested, WIRE_TYPES.END_GROUP);
        break;
      }
      this.skipField(nested, depth + 1);
    }
  } else {
    throw invalidProtobuf('Unexpected end-group field.');
  }
};

ProtobufReader.prototype.finish = function () {
  if (this.currentField !== null) throw invalidProtobuf('Final field has not been consumed.');
  if (this.offset !== this.input.length) throw invalidProtobuf('Message has unread bytes.');
};

module.exports = {
  DEFAULT_LIMITS: DEFAULT_LIMITS,
  MAX_FIELD_NUMBER: MAX_FIELD_NUMBER,
  ProtobufReader: ProtobufReader,
  ProtobufWriter: ProtobufWriter,
  WIRE_TYPES: WIRE_TYPES,
  decodeDouble: decodeDouble,
  decodeFixed32: decodeFixed32,
  decodeFixed64: decodeFixed64,
  decodeVarint: decodeVarint,
  encodeDouble: encodeDouble,
  encodeFixed32: encodeFixed32,
  encodeFixed64: encodeFixed64,
  encodeTag: encodeTag,
  encodeVarint: encodeVarint,
};
