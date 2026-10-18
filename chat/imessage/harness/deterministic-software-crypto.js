'use strict';

const crypto = require('node:crypto');
const { byteString, decodeByteString, validateByteString } = require('./schema');

const HASHES = Object.freeze(new Set(['sha1', 'sha256']));
const AES_MODES = Object.freeze(new Set(['cbc', 'ctr']));

class SoftwareCryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SoftwareCryptoError';
    this.code = code;
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SoftwareCryptoError('INVALID_REQUEST', `${name} must be an object`);
  }
  return value;
}

function requireHash(value) {
  if (!HASHES.has(value)) throw new SoftwareCryptoError('UNSUPPORTED_ALGORITHM', `Unsupported hash ${value}`);
  return value;
}

function requireInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SoftwareCryptoError('INVALID_REQUEST', `${name} is outside its supported range`);
  }
  return value;
}

/** Credential-free, deterministic Node provider for harness known-answer tests. */
class DeterministicSoftwareCrypto {
  constructor() {
    this.keys = new Map();
    this.request = this.request.bind(this);
  }

  importSecret(keyId, value) {
    if (typeof keyId !== 'string' || keyId.length === 0) {
      throw new SoftwareCryptoError('INVALID_KEY_ID', 'keyId must be a non-empty string');
    }
    const bytes = value instanceof Uint8Array
      ? new Uint8Array(value)
      : decodeByteString(validateByteString(value));
    this.keys.set(keyId, bytes);
  }

  deleteKey(keyId) {
    return this.keys.delete(keyId);
  }

  resolveKey(value) {
    if (value && typeof value === 'object' && typeof value.keyId === 'string') {
      const key = this.keys.get(value.keyId);
      if (!key) throw new SoftwareCryptoError('KEY_NOT_FOUND', `Unknown software key ${value.keyId}`);
      return new Uint8Array(key);
    }
    return decodeByteString(validateByteString(value, '$.key'));
  }

  request(request) {
    requireObject(request, 'request');
    const parameters = requireObject(request.parameters || {}, 'parameters');
    switch (request.operation) {
      case 'digest': {
        const data = decodeByteString(validateByteString(parameters.data, '$.parameters.data'));
        return byteString(crypto.createHash(requireHash(parameters.algorithm)).update(data).digest());
      }
      case 'hmac': {
        const data = decodeByteString(validateByteString(parameters.data, '$.parameters.data'));
        return byteString(crypto.createHmac(
          requireHash(parameters.algorithm),
          this.resolveKey(parameters.key)
        ).update(data).digest());
      }
      case 'hkdf': {
        const length = requireInteger(parameters.length, 'length', 0, 65536);
        const output = crypto.hkdfSync(
          requireHash(parameters.algorithm),
          this.resolveKey(parameters.key),
          decodeByteString(validateByteString(parameters.salt, '$.parameters.salt')),
          decodeByteString(validateByteString(parameters.info, '$.parameters.info')),
          length
        );
        return byteString(new Uint8Array(output));
      }
      case 'pbkdf2': {
        const iterations = requireInteger(parameters.iterations, 'iterations', 1, 10000000);
        const length = requireInteger(parameters.length, 'length', 0, 65536);
        return byteString(crypto.pbkdf2Sync(
          this.resolveKey(parameters.password),
          decodeByteString(validateByteString(parameters.salt, '$.parameters.salt')),
          iterations,
          length,
          requireHash(parameters.algorithm)
        ));
      }
      case 'aes':
        return this.aes(parameters);
      default:
        throw new SoftwareCryptoError('UNSUPPORTED_OPERATION', `Unsupported operation ${request.operation}`);
    }
  }

  aes(parameters) {
    const key = this.resolveKey(parameters.key);
    if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
      throw new SoftwareCryptoError('INVALID_KEY', 'AES key must be 16, 24, or 32 bytes');
    }
    if (!AES_MODES.has(parameters.mode)) {
      throw new SoftwareCryptoError('UNSUPPORTED_ALGORITHM', `Unsupported AES mode ${parameters.mode}`);
    }
    if (parameters.direction !== 'encrypt' && parameters.direction !== 'decrypt') {
      throw new SoftwareCryptoError('INVALID_REQUEST', 'AES direction must be encrypt or decrypt');
    }
    const iv = decodeByteString(validateByteString(parameters.iv, '$.parameters.iv'));
    if (iv.length !== 16) throw new SoftwareCryptoError('INVALID_IV', 'AES IV must be 16 bytes');
    const data = decodeByteString(validateByteString(parameters.data, '$.parameters.data'));
    const algorithm = `aes-${key.length * 8}-${parameters.mode}`;
    const transform = parameters.direction === 'encrypt'
      ? crypto.createCipheriv(algorithm, key, iv)
      : crypto.createDecipheriv(algorithm, key, iv);
    transform.setAutoPadding(parameters.padding !== false);
    return byteString(Buffer.concat([transform.update(data), transform.final()]));
  }
}

module.exports = {
  DeterministicSoftwareCrypto,
  SoftwareCryptoError,
};
