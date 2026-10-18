'use strict';

var bplist = require('../codecs/binary-plist');
var GROUP_MAX_SIZE = 5000;
var MAX_BATCH_COUNT = 255;

function requireBytes(value, name, length) {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new TypeError(name + ' has an invalid byte length.');
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(name + ' must be non-empty.');
  return value;
}

function requireUint64(value, name) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + ' must be unsigned 64-bit.');
    value = BigInt(value);
  }
  if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) {
    throw new TypeError(name + ' must be unsigned 64-bit.');
  }
  return value;
}

function buildTargetBundle(target, sender) {
  if (!target || typeof target !== 'object') throw new TypeError('Delivery target is required.');
  var encryption = target.encryption;
  if (encryption !== 'pair' && encryption !== 'pair-ec') throw new TypeError('Unsupported delivery encryption.');
  var bundle = {
    tP: requireString(target.participant, 'target participant'),
    D: target.participant !== sender,
    sT: requireBytes(target.sessionToken, 'session token'),
    P: requireBytes(target.payload, 'encrypted payload'),
    t: requireBytes(target.pushToken, 'push token', 32),
  };
  if (encryption !== 'pair') bundle.E = encryption;
  if (bundle.D && target.supportsCertifiedDeliveryV1) bundle.cdv = 1;
  return bundle;
}

function requireBatch(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BATCH_COUNT) {
    throw new TypeError('Send envelope batch must be an unsigned non-zero byte.');
  }
  return value;
}

/** Match RustPush's post-encryption, cross-then-flush grouping by encrypted payload byte length. */
function groupTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError('At least one delivery target is required.');
  }
  var groups = [];
  var group = [];
  var groupSize = 0;
  targets.forEach(function (target) {
    if (!target || typeof target !== 'object') throw new TypeError('Delivery target is required.');
    var payload = requireBytes(target.payload, 'encrypted payload');
    groupSize += payload.length;
    group.push(target);
    if (groupSize > GROUP_MAX_SIZE) {
      groups.push(group);
      group = [];
      groupSize = 0;
    }
  });
  if (group.length > 0) groups.push(group);
  if (groups.length > MAX_BATCH_COUNT) {
    throw new TypeError('Send envelope needs more than 255 batches.');
  }
  return groups;
}

/** Build the APNs command-100 body after per-device encryption has completed. */
function buildSendEnvelope(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Send envelope options are required.');
  var sender = requireString(options.sender, 'sender');
  if (!Array.isArray(options.targets) || options.targets.length === 0) throw new TypeError('At least one delivery target is required.');
  if (!Number.isInteger(options.apsId) || options.apsId < -0x80000000 || options.apsId > 0x7fffffff) {
    throw new TypeError('APS message ID must be signed 32-bit.');
  }
  var uuid = requireBytes(options.uuid, 'message UUID', 16);
  var envelope = {
    fcn: requireBatch(options.batch === undefined ? 1 : options.batch),
    c: 100,
    E: 'pair',
    ua: requireString(options.userAgent, 'user agent'),
    v: 8,
    i: options.apsId,
    U: uuid,
    dtl: options.targets.map(function (target) { return buildTargetBundle(target, sender); }),
    sP: sender,
  };
  if (options.retryCount) {
    if (!Number.isInteger(options.retryCount) || options.retryCount < 1 || options.retryCount > 5) {
      throw new TypeError('Retry count is invalid.');
    }
    envelope.rc = options.retryCount;
    envelope.oe = requireUint64(options.originalEpochNanos, 'Retry epoch');
  }
  return Object.freeze({ value: envelope, body: bplist.encodeBinaryPlist(envelope) });
}

/** Build every command-100 envelope while preserving one APS id and UUID across `fcn` batches. */
function buildSendEnvelopes(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Send envelope options are required.');
  return Object.freeze(groupTargets(options.targets).map(function (targets, index) {
    var groupOptions = {};
    Object.keys(options).forEach(function (key) { groupOptions[key] = options[key]; });
    groupOptions.targets = targets;
    groupOptions.batch = index + 1;
    return buildSendEnvelope(groupOptions);
  }));
}

function parseSendResult(value, expectedUuid) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.c !== 255) return null;
  if (!(value.U instanceof Uint8Array) || !equal(value.U, expectedUuid)) return null;
  if (!(value.t instanceof Uint8Array) || !Number.isSafeInteger(value.s)) {
    throw new TypeError('Correlated send result is malformed.');
  }
  return Object.freeze({ pushToken: new Uint8Array(value.t), status: value.s });
}

function equal(left, right) {
  if (!(right instanceof Uint8Array) || left.length !== right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

module.exports = {
  GROUP_MAX_SIZE: GROUP_MAX_SIZE,
  MAX_BATCH_COUNT: MAX_BATCH_COUNT,
  buildSendEnvelope: buildSendEnvelope,
  buildSendEnvelopes: buildSendEnvelopes,
  buildTargetBundle: buildTargetBundle,
  parseSendResult: parseSendResult,
};
