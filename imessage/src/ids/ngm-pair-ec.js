'use strict';

var bytes = require('../runtime/bytes');
var asn1 = require('../codecs/asn1');
var protobuf = require('../codecs/protobuf');

var EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
var P256_OID = '1.2.840.10045.3.1.7';
var P256_PARAMETERS = asn1.derObjectIdentifier(P256_OID);
var P256_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
var P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
var PREKEY_SIGNATURE_DOMAIN = bytes.utf8ToBytes('NGMPrekeySignature');
var MESSAGE_KEYS_SALT = bytes.utf8ToBytes('LastPawn-MessageKeys');
var PAIR_EC_SUFFIX = 0x0c;
var MAX_WIRE_COUNTER = 0xffffffff;
var MAX_KEY_GENERATION_ATTEMPTS = 128;
var UINT64_MASK = 0xffffffffffffffffn;

/** @param {unknown} value @param {string} name @param {number=} length @returns {Uint8Array} */
function requireBytes(value, name, length) {
  bytes.assertBytes(value, name);
  if (length !== undefined && value.length !== length) {
    throw new TypeError(name + ' must contain ' + length + ' bytes.');
  }
  return new Uint8Array(value);
}

/** @param {bigint} value @param {bigint} modulus @returns {bigint} */
function modulo(value, modulus) {
  var result = value % modulus;
  return result < 0n ? result + modulus : result;
}

/** @param {bigint} base @param {bigint} exponent @param {bigint} modulus @returns {bigint} */
function modularPower(base, exponent, modulus) {
  var result = 1n;
  var factor = modulo(base, modulus);
  while (exponent > 0n) {
    if ((exponent & 1n) !== 0n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
    exponent >>= 1n;
  }
  return result;
}

/** @param {Uint8Array} value @returns {bigint} */
function bytesToBigInt(value) {
  var result = 0n;
  for (var index = 0; index < value.length; index += 1) {
    result = (result << 8n) | BigInt(value[index]);
  }
  return result;
}

/** @param {bigint} value @param {number} length @returns {Uint8Array} */
function bigIntToBytes(value, length) {
  var result = new Uint8Array(length);
  for (var index = length - 1; index >= 0; index -= 1) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  if (value !== 0n) throw new TypeError('Integer does not fit the requested byte length.');
  return result;
}

/** @param {bigint} value @param {number} count @returns {bigint} */
function rotateLeft64(value, count) {
  var shift = BigInt(count);
  return ((value << shift) | (value >> (64n - shift))) & UINT64_MASK;
}

/** @param {Array<bigint>} state */
function sipRound(state) {
  state[0] = (state[0] + state[1]) & UINT64_MASK;
  state[1] = rotateLeft64(state[1], 13) ^ state[0];
  state[0] = rotateLeft64(state[0], 32);
  state[2] = (state[2] + state[3]) & UINT64_MASK;
  state[3] = rotateLeft64(state[3], 16) ^ state[2];
  state[0] = (state[0] + state[3]) & UINT64_MASK;
  state[3] = rotateLeft64(state[3], 21) ^ state[0];
  state[2] = (state[2] + state[1]) & UINT64_MASK;
  state[1] = rotateLeft64(state[1], 17) ^ state[2];
  state[2] = rotateLeft64(state[2], 32);
}

/** @param {Uint8Array} input @param {number} offset @param {number} count @returns {bigint} */
function littleEndianBigInt(input, offset, count) {
  var value = 0n;
  for (var index = 0; index < count; index += 1) {
    value |= BigInt(input[offset + index]) << BigInt(index * 8);
  }
  return value;
}

/** Rust std::hash::SipHasher13 with DefaultHasher's zero keys. @param {Uint8Array} input @returns {bigint} */
function sipHash13(input) {
  var state = [
    0x736f6d6570736575n,
    0x646f72616e646f6dn,
    0x6c7967656e657261n,
    0x7465646279746573n,
  ];
  var fullLength = input.length - input.length % 8;
  for (var offset = 0; offset < fullLength; offset += 8) {
    var word = littleEndianBigInt(input, offset, 8);
    state[3] ^= word;
    sipRound(state);
    state[0] ^= word;
  }
  var last = BigInt(input.length & 0xff) << 56n;
  last |= littleEndianBigInt(input, fullLength, input.length - fullLength);
  state[3] ^= last;
  sipRound(state);
  state[0] ^= last;
  state[2] ^= 0xffn;
  sipRound(state);
  sipRound(state);
  sipRound(state);
  return (state[0] ^ state[1] ^ state[2] ^ state[3]) & UINT64_MASK;
}

/** @param {Uint8Array} value @returns {Uint8Array} */
function rustHashByteArray(value) {
  return bytes.concatBytes(new Uint8Array([32, 0, 0, 0, 0, 0, 0, 0]), value);
}

/**
 * Expand RustPush's x-only compact key to the unique lower-half P-256 point.
 * CompactECKey::decompress chooses this point independent of SEC1 parity.
 *
 * @param {Uint8Array} compact
 * @returns {Uint8Array}
 */
function compactP256ToUncompressed(compact) {
  compact = requireBytes(compact, 'compact P-256 key', 32);
  var x = bytesToBigInt(compact);
  if (x >= P256_PRIME) throw new TypeError('Compact P-256 key x-coordinate is out of range.');
  var rhs = modulo(x * x % P256_PRIME * x - 3n * x + P256_B, P256_PRIME);
  var y = modularPower(rhs, (P256_PRIME + 1n) >> 2n, P256_PRIME);
  if (y * y % P256_PRIME !== rhs) throw new TypeError('Compact P-256 key is not on the curve.');
  if (y > P256_PRIME - y) y = P256_PRIME - y;
  return bytes.concatBytes(new Uint8Array([0x04]), compact, bigIntToBytes(y, 32));
}

/** @param {Uint8Array} compact @returns {Uint8Array} */
function compactP256ToSpki(compact) {
  return asn1.derSubjectPublicKeyInfo({
    algorithmOid: EC_PUBLIC_KEY_OID,
    algorithmParameters: P256_PARAMETERS,
    publicKey: compactP256ToUncompressed(compact),
  });
}

/**
 * Read a host-exported P-256 SPKI and enforce RustPush's lower-half key invariant.
 *
 * @param {Uint8Array} spki
 * @returns {{compact: Uint8Array, uncompressed: Uint8Array}}
 */
function parseCompactP256Spki(spki) {
  spki = requireBytes(spki, 'P-256 public key');
  var root = asn1.parseDer(spki);
  if (root.tagClass !== asn1.TAG_CLASSES.UNIVERSAL ||
      root.tagNumber !== asn1.UNIVERSAL_TAGS.SEQUENCE || !root.constructed ||
      root.children.length !== 2) {
    throw new TypeError('P-256 public key SPKI is malformed.');
  }
  var algorithm = asn1.parseAlgorithmIdentifier(root.children[0]);
  if (algorithm.oid !== EC_PUBLIC_KEY_OID || algorithm.parameters === null ||
      !bytes.bytesEqual(algorithm.parameters, P256_PARAMETERS)) {
    throw new TypeError('Public key is not a P-256 EC key.');
  }
  var bitString = asn1.decodeBitString(root.children[1]);
  if (bitString.unusedBits !== 0 || bitString.bytes.length !== 65 || bitString.bytes[0] !== 0x04) {
    throw new TypeError('P-256 public key must be an uncompressed point.');
  }
  var compact = bitString.bytes.slice(1, 33);
  var canonical = compactP256ToUncompressed(compact);
  if (!bytes.bytesEqual(canonical, bitString.bytes)) {
    throw new TypeError('P-256 public key does not use the lower-half compact point.');
  }
  return { compact: compact, uncompressed: canonical };
}

/** @param {number} timestamp @returns {Uint8Array} */
function timestampLittleEndian(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) {
    throw new TypeError('NGM prekey timestamp must be a finite non-negative number.');
  }
  var result = new Uint8Array(8);
  new DataView(result.buffer).setFloat64(0, timestamp, true);
  return result;
}

/**
 * Encode ids.PreKeyData using the field order emitted by prost.
 *
 * @param {{key: Uint8Array, signature: Uint8Array, timestamp: number}} value
 * @returns {Uint8Array}
 */
function encodePreKeyData(value) {
  if (!value || typeof value !== 'object') throw new TypeError('NGM prekey data is required.');
  var key = requireBytes(value.key, 'NGM prekey', 32);
  var signature = requireBytes(value.signature, 'NGM prekey signature', 64);
  timestampLittleEndian(value.timestamp);
  var writer = new protobuf.ProtobufWriter()
    .bytes(1, key)
    .bytes(2, signature);
  if (value.timestamp !== 0) writer.double(3, value.timestamp);
  return writer.finish();
}

/** @param {Uint8Array} encoded @returns {{key: Uint8Array, signature: Uint8Array, timestamp: number}} */
function decodePreKeyData(encoded) {
  var reader = new protobuf.ProtobufReader(requireBytes(encoded, 'encoded NGM prekey'), {
    maxMessageLength: 4096,
    // Prost ignores unknown fields. Current Apple lookup records append a bounded key-transparency
    // field that can exceed 1 KiB, so keep the per-field bound aligned with the whole-message cap.
    maxFieldLength: 4096,
    maxFields: 32,
  });
  var result = { key: null, signature: null, timestamp: null };
  for (var field = reader.nextField(); field !== null; field = reader.nextField()) {
    var name = field.number === 1 ? 'key' : field.number === 2 ? 'signature' : field.number === 3 ? 'timestamp' : null;
    if (name === null) {
      reader.skipField(field);
    } else {
      if (result[name] !== null) throw new TypeError('NGM prekey data contains duplicate field ' + field.number + '.');
      result[name] = field.number === 3 ? reader.readDouble(field) : reader.readBytes(field);
    }
  }
  reader.finish();
  if (result.key === null || result.signature === null) {
    throw new TypeError('NGM prekey data is missing a required field.');
  }
  if (result.timestamp === null) result.timestamp = 0;
  timestampLittleEndian(result.timestamp);
  return {
    key: requireBytes(result.key, 'NGM prekey', 32),
    signature: requireBytes(result.signature, 'NGM prekey signature', 64),
    timestamp: result.timestamp,
  };
}

/** @param {Uint8Array} message @param {number} counter @returns {Uint8Array} */
function encodeInnerMessage(message, counter) {
  message = requireBytes(message, 'NGM message');
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_WIRE_COUNTER) {
    throw new TypeError('NGM message counter is outside the uint32 range.');
  }
  var writer = new protobuf.ProtobufWriter();
  if (message.length !== 0) writer.bytes(1, message);
  writer.uint32(2, counter);
  return writer.finish();
}

/** @param {Uint8Array} encoded @returns {{message: Uint8Array, counter: number}} */
function decodeInnerMessage(encoded) {
  var reader = new protobuf.ProtobufReader(requireBytes(encoded, 'encoded NGM inner message'));
  var message = null;
  var counter = null;
  for (var field = reader.nextField(); field !== null; field = reader.nextField()) {
    if (field.number === 1) {
      if (message !== null) throw new TypeError('NGM inner message contains duplicate payload fields.');
      message = reader.readBytes(field);
    } else if (field.number === 2) {
      if (counter !== null) throw new TypeError('NGM inner message contains duplicate counter fields.');
      counter = reader.readUint32(field);
    } else {
      reader.skipField(field);
    }
  }
  reader.finish();
  if (counter === null) throw new TypeError('NGM inner message is missing its counter.');
  return { message: message === null ? new Uint8Array(0) : message, counter: counter };
}

/**
 * @param {{payload: Uint8Array, key: Uint8Array, signature: Uint8Array, validator: Uint8Array}} value
 * @returns {Uint8Array}
 */
function encodeOuterMessage(value) {
  if (!value || typeof value !== 'object') throw new TypeError('NGM outer message is required.');
  return new protobuf.ProtobufWriter()
    .bytes(1, requireBytes(value.payload, 'NGM encrypted payload'))
    .bytes(2, requireBytes(value.key, 'NGM ephemeral key', 32))
    .bytes(3, requireBytes(value.signature, 'NGM payload signature', 64))
    .bytes(99, requireBytes(value.validator, 'NGM validator', 7))
    .finish();
}

/**
 * Strictly decode ids.OuterMessage for validation and test harnesses. This is not an incoming-message decryptor.
 *
 * @param {Uint8Array} encoded
 * @returns {{payload: Uint8Array, key: Uint8Array, signature: Uint8Array, validator: Uint8Array}}
 */
function decodeOuterMessage(encoded) {
  var reader = new protobuf.ProtobufReader(requireBytes(encoded, 'encoded NGM outer message'));
  var result = { payload: null, key: null, signature: null, validator: null };
  for (var field = reader.nextField(); field !== null; field = reader.nextField()) {
    var name = field.number === 1 ? 'payload' : field.number === 2 ? 'key' :
      field.number === 3 ? 'signature' : field.number === 99 ? 'validator' : null;
    if (name === null) {
      reader.skipField(field);
    } else {
      if (result[name] !== null) throw new TypeError('NGM outer message contains duplicate field ' + field.number + '.');
      result[name] = reader.readBytes(field);
    }
  }
  reader.finish();
  if (result.payload === null || result.key === null || result.signature === null || result.validator === null) {
    throw new TypeError('NGM outer message is missing a required field.');
  }
  if (result.payload.length < 4) throw new TypeError('NGM encrypted payload is too short.');
  return {
    payload: result.payload,
    key: requireBytes(result.key, 'NGM ephemeral key', 32),
    signature: requireBytes(result.signature, 'NGM payload signature', 64),
    validator: requireBytes(result.validator, 'NGM validator', 7),
  };
}

/** @param {Uint8Array} compactKey @param {{key: Uint8Array, signature: Uint8Array, timestamp: number}} prekey @returns {Uint8Array} */
function prekeySignaturePayload(compactKey, prekey) {
  return bytes.concatBytes(
    PREKEY_SIGNATURE_DOMAIN,
    requireBytes(compactKey, 'NGM prekey', 32),
    timestampLittleEndian(prekey.timestamp)
  );
}

/** @param {Uint8Array} sender @param {Uint8Array} device @param {Uint8Array} prekey @returns {Uint8Array} */
function buildValidator(sender, device, prekey) {
  return bytes.concatBytes(sender.slice(0, 2), device.slice(0, 2), prekey.slice(0, 2), new Uint8Array([PAIR_EC_SUFFIX]));
}

/** Match pinned RustPush's DefaultHasher over its three [u8; 32] compact keys. @returns {string} */
function buildCounterScope(sender, device, prekey) {
  sender = requireBytes(sender, 'sender device key', 32);
  device = requireBytes(device, 'target device key', 32);
  prekey = requireBytes(prekey, 'target prekey', 32);
  return sipHash13(bytes.concatBytes(
    rustHashByteArray(sender), rustHashByteArray(device), rustHashByteArray(prekey)
  )).toString();
}

/** @param {Object} crypto @returns {{keyId: string, compact: Uint8Array, spki: Uint8Array}} */
function generateCompactEphemeral(crypto) {
  for (var attempt = 0; attempt < MAX_KEY_GENERATION_ATTEMPTS; attempt += 1) {
    var keyId = crypto.generateKey({
      algorithm: 'ec', namedCurve: 'p-256', usages: ['derive'], persistence: 'session',
    });
    if (typeof keyId !== 'string' || keyId.length === 0) throw new TypeError('Generated EC key ID is invalid.');
    var spki;
    try {
      spki = requireBytes(crypto.exportPublicKey(keyId, 'spki'), 'generated EC public key');
      var parsed = parseCompactP256Spki(spki);
      return { keyId: keyId, compact: parsed.compact, spki: spki };
    } catch (error) {
      crypto.deleteKey(keyId);
      if (error instanceof TypeError && error.message.indexOf('lower-half compact point') !== -1) continue;
      throw error;
    }
  }
  throw new TypeError('Host did not generate a compact-compatible P-256 key.');
}

/** @param {Object} crypto */
function requireCrypto(crypto) {
  var methods = ['aes', 'deleteKey', 'derive', 'exportPublicKey', 'generateKey', 'hkdf', 'random', 'sign', 'verify'];
  if (!crypto || typeof crypto !== 'object') throw new TypeError('NGM crypto compositions are required.');
  methods.forEach(function (method) {
    if (typeof crypto[method] !== 'function') throw new TypeError('NGM crypto is missing ' + method + '().');
  });
}

/**
 * Compose RustPush's send-only NGM pair-ec envelope. `reserveCounter` must durably persist and then
 * return a positive reservation. Reservation 1 maps to RustPush's first wire counter, 0; values are
 * intentionally burned if any later crypto operation fails.
 *
 * @param {{
 *   crypto: Object,
 *   sender: {deviceKeyId: string, devicePublicKey: Uint8Array},
 *   target: {deviceKey: Uint8Array, preKeyData: Uint8Array},
 *   message: Uint8Array,
 *   reserveCounter: function(string): number
 * }} options
 * @returns {{payload: Uint8Array, format: string, counter: number, counterScope: string}}
 */
function encryptPairEc(options) {
  if (!options || typeof options !== 'object') throw new TypeError('NGM pair-ec options are required.');
  requireCrypto(options.crypto);
  if (!options.sender || typeof options.sender !== 'object') throw new TypeError('NGM sender identity is required.');
  if (typeof options.sender.deviceKeyId !== 'string' || options.sender.deviceKeyId.length === 0) {
    throw new TypeError('NGM sender device key ID is required.');
  }
  if (!options.target || typeof options.target !== 'object') throw new TypeError('NGM delivery target is required.');
  if (typeof options.reserveCounter !== 'function') throw new TypeError('NGM counter reservation callback is required.');

  var message = requireBytes(options.message, 'NGM message');
  var sender = parseCompactP256Spki(requireBytes(options.sender.devicePublicKey, 'sender device public key'));
  var targetDevice = requireBytes(options.target.deviceKey, 'target device key', 32);
  compactP256ToUncompressed(targetDevice);
  var targetPrekey = decodePreKeyData(requireBytes(options.target.preKeyData, 'target prekey data'));
  var targetPrekeySpki = compactP256ToSpki(targetPrekey.key);
  var targetDeviceSpki = compactP256ToSpki(targetDevice);

  var prekeyValid = options.crypto.verify(
    targetDeviceSpki,
    { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'raw' },
    prekeySignaturePayload(targetPrekey.key, targetPrekey),
    targetPrekey.signature
  );
  if (prekeyValid !== true) throw new TypeError('Target NGM prekey signature is invalid.');

  var counterScope = buildCounterScope(sender.compact, targetDevice, targetPrekey.key);
  var reservation = options.reserveCounter(counterScope);
  if (!Number.isSafeInteger(reservation) || reservation < 1 || reservation > MAX_WIRE_COUNTER + 1) {
    throw new TypeError('Reserved NGM counter is outside the supported range.');
  }
  var counter = reservation - 1;
  var inner = encodeInnerMessage(message, counter);
  var paddingLength = (16 - inner.length % 16) % 16;
  var padding = paddingLength === 0
    ? new Uint8Array(0)
    : requireBytes(options.crypto.random(paddingLength), 'NGM random padding', paddingLength);
  var cleartext = bytes.concatBytes(inner, padding, bytes.uint32LE(paddingLength));

  var ephemeral = generateCompactEphemeral(options.crypto);
  try {
    var secret = requireBytes(options.crypto.derive(
      ephemeral.keyId,
      { algorithm: 'ecdh', namedCurve: 'p-256' },
      targetPrekeySpki
    ), 'NGM ECDH secret', 32);
    var material = requireBytes(options.crypto.hkdf(
      'sha256', secret, MESSAGE_KEYS_SALT, new Uint8Array(0), 48
    ), 'NGM message key material', 48);
    var encrypted = requireBytes(options.crypto.aes({
      mode: 'ctr',
      direction: 'encrypt',
      key: material.slice(0, 32),
      iv: material.slice(32),
      data: cleartext,
      padding: false,
    }), 'NGM encrypted payload', cleartext.length);
    var signatureData = bytes.concatBytes(
      secret,
      targetPrekey.key,
      ephemeral.compact,
      targetDevice,
      encrypted
    );
    var signatureDer = requireBytes(options.crypto.sign(
      options.sender.deviceKeyId,
      { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'der' },
      signatureData
    ), 'NGM DER signature');
    var signature = asn1.ecdsaDerSignatureToRaw(signatureDer, 32);
    var validator = buildValidator(sender.compact, targetDevice, targetPrekey.key);
    return Object.freeze({
      payload: encodeOuterMessage({
        payload: encrypted,
        key: ephemeral.compact,
        signature: signature,
        validator: validator,
      }),
      format: 'pair-ec',
      counter: counter,
      counterScope: counterScope,
    });
  } finally {
    options.crypto.deleteKey(ephemeral.keyId);
  }
}

module.exports = {
  MESSAGE_KEYS_SALT: MESSAGE_KEYS_SALT,
  PAIR_EC_SUFFIX: PAIR_EC_SUFFIX,
  buildCounterScope: buildCounterScope,
  buildValidator: buildValidator,
  compactP256ToSpki: compactP256ToSpki,
  compactP256ToUncompressed: compactP256ToUncompressed,
  decodeInnerMessage: decodeInnerMessage,
  decodeOuterMessage: decodeOuterMessage,
  decodePreKeyData: decodePreKeyData,
  encodeInnerMessage: encodeInnerMessage,
  encodeOuterMessage: encodeOuterMessage,
  encodePreKeyData: encodePreKeyData,
  encryptPairEc: encryptPairEc,
  parseCompactP256Spki: parseCompactP256Spki,
  prekeySignaturePayload: prekeySignaturePayload,
};
