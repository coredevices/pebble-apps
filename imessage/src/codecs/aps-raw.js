'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var MAX_FIELD_LENGTH = 0xffff;
var MAX_BODY_LENGTH = 0xffffffff;
var DEFAULT_MAX_BODY_LENGTH = 16 * 1024 * 1024;

/** @param {string} message @returns {RuntimeError} */
function invalidFrame(message) {
  return new RuntimeError('INVALID_APS_FRAME', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

/** @param {unknown} value @param {string} name @param {number} maximum */
function assertWireInteger(value, name, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw invalidFrame(name + ' must be an unsigned integer no greater than ' + maximum + '.');
  }
}

/**
 * Encode the raw APNs courier framing used by the pinned RustPush implementation.
 * Field order and duplicate field IDs are preserved.
 *
 * @param {number} command
 * @param {Array<{id: number, value: Uint8Array}>} fields
 * @returns {Uint8Array}
 */
function encodeRawAps(command, fields) {
  assertWireInteger(command, 'command', 0xff);
  if (!Array.isArray(fields)) throw invalidFrame('fields must be an array.');

  var bodyLength = 0;
  var encodedFields = new Array(fields.length);
  for (var index = 0; index < fields.length; index += 1) {
    var field = fields[index];
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw invalidFrame('field ' + index + ' must be an object.');
    }
    assertWireInteger(field.id, 'field ' + index + ' id', 0xff);
    try {
      bytes.assertBytes(field.value, 'field ' + index + ' value');
    } catch (error) {
      throw invalidFrame('field ' + index + ' value must be a Uint8Array.');
    }
    if (field.value.length > MAX_FIELD_LENGTH) {
      throw invalidFrame('field ' + index + ' exceeds the 16-bit wire length.');
    }

    var encoded = bytes.concatBytes(
      new Uint8Array([field.id]),
      bytes.uint16BE(field.value.length),
      field.value
    );
    bodyLength += encoded.length;
    if (bodyLength > MAX_BODY_LENGTH) {
      throw invalidFrame('APS body exceeds the 32-bit wire length.');
    }
    encodedFields[index] = encoded;
  }

  var frame = new Uint8Array(5 + bodyLength);
  frame[0] = command;
  frame.set(bytes.uint32BE(bodyLength), 1);
  var offset = 5;
  for (var fieldIndex = 0; fieldIndex < encodedFields.length; fieldIndex += 1) {
    frame.set(encodedFields[fieldIndex], offset);
    offset += encodedFields[fieldIndex].length;
  }
  return frame;
}

/**
 * Decode exactly one complete raw APNs courier frame.
 *
 * @param {Uint8Array} frame
 * @param {{maxBodyLength?: number}=} options
 * @returns {{command: number, fields: Array<{id: number, value: Uint8Array}>}}
 */
function decodeRawApsFrame(frame, options) {
  options = options || {};
  bytes.assertBytes(frame, 'frame');
  var maxBodyLength = options.maxBodyLength === undefined
    ? DEFAULT_MAX_BODY_LENGTH
    : options.maxBodyLength;
  if (!Number.isSafeInteger(maxBodyLength) || maxBodyLength < 0 || maxBodyLength > MAX_BODY_LENGTH) {
    throw invalidFrame('maxBodyLength must be a valid 32-bit wire length.');
  }
  if (frame.length < 5) throw invalidFrame('raw APS frame is shorter than its header.');

  var bodyLength = bytes.readUint32BE(frame, 1);
  if (bodyLength > maxBodyLength) throw invalidFrame('raw APS body exceeds the configured limit.');
  if (frame.length !== bodyLength + 5) {
    throw invalidFrame('raw APS frame length does not match its header.');
  }

  var fields = [];
  var offset = 5;
  while (offset < frame.length) {
    if (offset + 3 > frame.length) throw invalidFrame('raw APS field header is truncated.');
    var id = frame[offset];
    var valueLength = bytes.readUint16BE(frame, offset + 1);
    offset += 3;
    if (offset + valueLength > frame.length) throw invalidFrame('raw APS field value is truncated.');
    fields.push({ id: id, value: frame.slice(offset, offset + valueLength) });
    offset += valueLength;
  }
  return { command: frame[0], fields: fields };
}

/** Incremental decoder for arbitrary TLS read boundaries and multiple frames per read. */
function RawApsStreamDecoder(options) {
  options = options || {};
  this.maxBodyLength = options.maxBodyLength === undefined
    ? DEFAULT_MAX_BODY_LENGTH
    : options.maxBodyLength;
  if (!Number.isSafeInteger(this.maxBodyLength)
    || this.maxBodyLength < 0
    || this.maxBodyLength > MAX_BODY_LENGTH) {
    throw invalidFrame('maxBodyLength must be a valid 32-bit wire length.');
  }
  this.buffer = new Uint8Array(0);
}

/**
 * @param {Uint8Array} chunk
 * @returns {Array<{command: number, fields: Array<{id: number, value: Uint8Array}>}>}
 */
RawApsStreamDecoder.prototype.push = function (chunk) {
  bytes.assertBytes(chunk, 'chunk');
  if (chunk.length > 0) this.buffer = bytes.concatBytes(this.buffer, chunk);
  var decoded = [];
  var offset = 0;

  while (this.buffer.length - offset >= 5) {
    var bodyLength = bytes.readUint32BE(this.buffer, offset + 1);
    if (bodyLength > this.maxBodyLength) {
      this.buffer = new Uint8Array(0);
      throw invalidFrame('raw APS body exceeds the configured limit.');
    }
    var frameLength = bodyLength + 5;
    if (this.buffer.length - offset < frameLength) break;
    decoded.push(decodeRawApsFrame(
      this.buffer.slice(offset, offset + frameLength),
      { maxBodyLength: this.maxBodyLength }
    ));
    offset += frameLength;
  }

  if (offset > 0) this.buffer = this.buffer.slice(offset);
  return decoded;
};

/** @returns {number} */
RawApsStreamDecoder.prototype.bufferedLength = function () {
  return this.buffer.length;
};

RawApsStreamDecoder.prototype.finish = function () {
  if (this.buffer.length !== 0) throw invalidFrame('raw APS stream ended with a truncated frame.');
};

module.exports = {
  DEFAULT_MAX_BODY_LENGTH: DEFAULT_MAX_BODY_LENGTH,
  MAX_BODY_LENGTH: MAX_BODY_LENGTH,
  MAX_FIELD_LENGTH: MAX_FIELD_LENGTH,
  RawApsStreamDecoder: RawApsStreamDecoder,
  decodeRawApsFrame: decodeRawApsFrame,
  encodeRawAps: encodeRawAps,
};
