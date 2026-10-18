'use strict';

var bytes = require('../runtime/bytes');

/** @param {unknown} value @param {string} name @returns {Uint8Array} */
function decodeCryptoBytes(value, name) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (typeof value === 'string') return bytes.base64ToBytes(value);
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && typeof value.$bytes === 'string') {
    return bytes.base64ToBytes(value.$bytes);
  }
  throw new TypeError((name || 'crypto result') + ' must be binary data.');
}

/** @param {Uint8Array} value @returns {{$bytes: string}} */
function cryptoBytes(value) {
  bytes.assertBytes(value, 'crypto input');
  return { $bytes: bytes.bytesToBase64(value) };
}

/**
 * Thin binary adapter over the generic host crypto effect. The host performs primitives only;
 * callers retain ownership of every protocol-specific composition and algorithm choice.
 *
 * @param {{request: function(object): unknown}} provider
 */
function CryptoCompositions(provider) {
  if (!provider || typeof provider.request !== 'function') {
    throw new TypeError('Crypto provider must expose request().');
  }
  this.provider = provider;
}

CryptoCompositions.prototype._requestBytes = function (operation, parameters) {
  return decodeCryptoBytes(this.provider.request({
    operation: operation,
    parameters: parameters,
  }), 'crypto result');
};

CryptoCompositions.prototype._request = function (operation, parameters) {
  return this.provider.request({ operation: operation, parameters: parameters });
};

CryptoCompositions.prototype.digest = function (algorithm, data) {
  bytes.assertBytes(data, 'crypto input');
  if (typeof this.provider.digestBytes === 'function') {
    return decodeCryptoBytes(this.provider.digestBytes(algorithm, data), 'crypto result');
  }
  return this._requestBytes('digest', { algorithm: algorithm, data: cryptoBytes(data) });
};

CryptoCompositions.prototype.hmac = function (algorithm, key, data) {
  return this._requestBytes('hmac', {
    algorithm: algorithm,
    key: key instanceof Uint8Array ? cryptoBytes(key) : key,
    data: cryptoBytes(data),
  });
};

CryptoCompositions.prototype.hkdf = function (algorithm, key, salt, info, length) {
  return this._requestBytes('hkdf', {
    algorithm: algorithm,
    key: key instanceof Uint8Array ? cryptoBytes(key) : key,
    salt: cryptoBytes(salt),
    info: cryptoBytes(info),
    length: length,
  });
};

CryptoCompositions.prototype.pbkdf2 = function (algorithm, password, salt, iterations, length) {
  return this._requestBytes('pbkdf2', {
    algorithm: algorithm,
    password: password instanceof Uint8Array ? cryptoBytes(password) : password,
    salt: cryptoBytes(salt),
    iterations: iterations,
    length: length,
  });
};

CryptoCompositions.prototype.aes = function (options) {
  if (!options || typeof options !== 'object') throw new TypeError('AES options are required.');
  return this._requestBytes('aes', {
    mode: options.mode,
    direction: options.direction,
    key: options.key instanceof Uint8Array ? cryptoBytes(options.key) : options.key,
    iv: cryptoBytes(options.iv),
    data: cryptoBytes(options.data),
    padding: options.padding !== false,
  });
};

CryptoCompositions.prototype.sign = function (keyId, specification, data) {
  if (typeof keyId !== 'string' || keyId.length === 0) throw new TypeError('Signing key ID is required.');
  return this._requestBytes('sign', {
    keyId: keyId,
    specification: specification,
    data: cryptoBytes(data),
  });
};

CryptoCompositions.prototype.random = function (length) {
  return this._requestBytes('random', { length: length });
};

CryptoCompositions.prototype.generateKey = function (specification) {
  var result = this._request('generateKey', { specification: specification });
  if (typeof result !== 'string' || result.length === 0) throw new TypeError('Crypto key generation returned no key ID.');
  return result;
};

CryptoCompositions.prototype.importPrivateKey = function (keyType, privateKey, publicKey, options) {
  options = options || {};
  if (options.persistence !== undefined
      && options.persistence !== 'persistent'
      && options.persistence !== 'session') {
    throw new TypeError('Unsupported key persistence.');
  }
  var result = this._request('importPrivateKey', {
    keyType: keyType,
    privateKey: cryptoBytes(privateKey),
    publicKey: cryptoBytes(publicKey),
    persistence: options.persistence || 'persistent',
  });
  if (typeof result !== 'string' || result.length === 0) throw new TypeError('Crypto key import returned no key ID.');
  return result;
};

CryptoCompositions.prototype.exportPublicKey = function (keyId, format) {
  return this._requestBytes('exportPublicKey', { keyId: keyId, format: format });
};

CryptoCompositions.prototype.verify = function (publicKey, specification, data, signature) {
  var result = this._request('verify', {
    publicKey: cryptoBytes(publicKey),
    specification: specification,
    data: cryptoBytes(data),
    signature: cryptoBytes(signature),
  });
  if (typeof result !== 'boolean') throw new TypeError('Crypto verification returned a non-boolean value.');
  return result;
};

CryptoCompositions.prototype.derive = function (keyId, specification, peerPublicKey) {
  return this._requestBytes('derive', {
    keyId: keyId,
    specification: specification,
    peerPublicKey: cryptoBytes(peerPublicKey),
  });
};

CryptoCompositions.prototype.rsaEncrypt = function (publicKey, specification, data) {
  return this._requestBytes('rsaEncrypt', {
    publicKey: cryptoBytes(publicKey),
    specification: specification,
    data: cryptoBytes(data),
  });
};

CryptoCompositions.prototype.deleteKey = function (keyId) {
  var result = this._request('deleteKey', { keyId: keyId });
  if (typeof result !== 'boolean') throw new TypeError('Crypto key deletion returned a non-boolean value.');
  return result;
};

module.exports = {
  CryptoCompositions: CryptoCompositions,
  cryptoBytes: cryptoBytes,
  decodeCryptoBytes: decodeCryptoBytes,
};
