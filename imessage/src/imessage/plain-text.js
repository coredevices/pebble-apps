'use strict';

var bplist = require('../codecs/binary-plist');
var gzipCodec = require('../codecs/gzip');

var UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireHandle(value, name) {
  if (typeof value !== 'string' || !/^(mailto:[^@\s]+@[^@\s]+|tel:\+[1-9][0-9]{6,14})$/.test(value)) {
    throw new TypeError(name + ' must be one normalized IDS handle.');
  }
  return value;
}

function requireUuid(value, name) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(name + ' must be a UUID.');
  return value;
}

function uuidBytes(value) {
  value = requireUuid(value, 'message UUID').replace(/-/g, '');
  var output = new Uint8Array(16);
  for (var index = 0; index < 16; index += 1) output[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return output;
}

function formatUuid(randomBytes, uppercase) {
  if (!(randomBytes instanceof Uint8Array) || randomBytes.length !== 16) {
    throw new TypeError('UUID randomness must contain 16 bytes.');
  }
  var value = new Uint8Array(randomBytes);
  value[6] = (value[6] & 0x0f) | 0x40;
  value[8] = (value[8] & 0x3f) | 0x80;
  var hex = '';
  for (var index = 0; index < value.length; index += 1) hex += value[index].toString(16).padStart(2, '0');
  var uuid = hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
  return uppercase ? uuid.toUpperCase() : uuid;
}

/** Build the exact single-part, one-recipient send-only message body. */
function buildPlainTextMessage(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Plain-text message options are required.');
  var recipient = requireHandle(options.recipient, 'recipient');
  var sender = requireHandle(options.sender, 'sender');
  if (typeof options.text !== 'string' || options.text.length === 0) throw new TypeError('Message text must be non-empty.');
  var messageId = requireUuid(options.messageId, 'message ID').toUpperCase();
  var conversationId = requireUuid(options.conversationId, 'conversation ID').toLowerCase();

  // Object insertion order mirrors the pinned RawIMessage serializer.
  var raw = {
    t: options.text,
    p: [recipient, sender],
    gid: conversationId,
    pv: 0,
    gv: '8',
    v: '1',
  };
  var binary = bplist.encodeBinaryPlist(raw);
  return Object.freeze({
    command: 100,
    id: messageId,
    uuid: uuidBytes(messageId),
    sender: sender,
    recipient: recipient,
    sendDelivered: true,
    body: gzipCodec.gzip(binary),
  });
}

module.exports = {
  buildPlainTextMessage: buildPlainTextMessage,
  formatUuid: formatUuid,
  uuidBytes: uuidBytes,
};
