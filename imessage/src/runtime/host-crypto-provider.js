'use strict';

var bytes = require('./bytes');
var asn1 = require('../codecs/asn1');
var MAX_DIGEST_CHUNK_BYTES = 512 * 1024;

function HostCryptoError(code, message) {
  Error.call(this, message);
  this.name = 'HostCryptoError';
  this.code = code;
  this.message = message;
  if (Error.captureStackTrace) Error.captureStackTrace(this, HostCryptoError);
}
HostCryptoError.prototype = Object.create(Error.prototype);
HostCryptoError.prototype.constructor = HostCryptoError;

function binary(value) {
  if (value instanceof Uint8Array) return bytes.bytesToBase64(value);
  if (value && typeof value === 'object' && typeof value.$bytes === 'string') return value.$bytes;
  throw new TypeError('Host crypto binary input is invalid.');
}

function hashName(value) {
  switch (String(value).toLowerCase()) {
    case 'sha1': return 'SHA-1';
    case 'sha256': return 'SHA-256';
    case 'sha384': return 'SHA-384';
    case 'sha512': return 'SHA-512';
    default: throw new TypeError('Unsupported hash algorithm.');
  }
}

function hmacName(value) {
  return 'HMAC-' + hashName(value);
}

function signatureName(specification) {
  if (!specification || typeof specification !== 'object') throw new TypeError('Signature specification is required.');
  var suffix;
  if (specification.algorithm === 'rsa-pkcs1-v1_5') suffix = 'withRSA';
  else if (specification.algorithm === 'ecdsa') suffix = 'withECDSA';
  else throw new TypeError('Unsupported signature algorithm.');
  if (specification.signatureFormat && specification.signatureFormat !== 'der' && specification.signatureFormat !== 'raw') {
    throw new TypeError('Unsupported signature format.');
  }
  return hashName(specification.hash).replace('-', '') + suffix;
}

function signatureInput(specification, signature) {
  if (specification && specification.algorithm === 'ecdsa'
      && specification.signatureFormat === 'raw') {
    return asn1.ecdsaRawSignatureToDer(bytes.base64ToBytes(binary(signature)));
  }
  return bytes.base64ToBytes(binary(signature));
}

function NativeHostCryptoProvider(nativeInterface) {
  if (!nativeInterface || typeof nativeInterface.request !== 'function') {
    throw new TypeError('Native host crypto interface is unavailable.');
  }
  this.native = nativeInterface;
}

NativeHostCryptoProvider.prototype._call = function (request) {
  var raw = this.native.request(JSON.stringify(request));
  var response;
  try { response = JSON.parse(raw); } catch (_) { throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned invalid JSON.'); }
  if (!response || response.ok !== true) {
    throw new HostCryptoError(response && response.code || 'HOST_CRYPTO_ERROR',
      response && response.message || 'Host crypto operation failed.');
  }
  return response;
};

NativeHostCryptoProvider.prototype.digestBytes = function (algorithm, data) {
  bytes.assertBytes(data, 'digest input');
  var hostAlgorithm = hashName(algorithm);
  if (data.length <= MAX_DIGEST_CHUNK_BYTES) {
    var direct = this._call({ operation: 'digest', algorithm: hostAlgorithm, data: binary(data) });
    if (typeof direct.data !== 'string') {
      throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no binary result.');
    }
    return { $bytes: direct.data };
  }

  var opened = this._call({ operation: 'digest-open', algorithm: hostAlgorithm });
  if (typeof opened.handle !== 'string') {
    throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no digest handle.');
  }
  var handle = opened.handle;
  var finished = false;
  try {
    for (var offset = 0; offset < data.length; offset += MAX_DIGEST_CHUNK_BYTES) {
      this._call({
        operation: 'digest-update',
        handle: handle,
        data: binary(data.subarray(offset, Math.min(offset + MAX_DIGEST_CHUNK_BYTES, data.length))),
      });
    }
    var result = this._call({ operation: 'digest-finish', handle: handle });
    finished = true;
    if (typeof result.data !== 'string') {
      throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no binary result.');
    }
    return { $bytes: result.data };
  } finally {
    if (!finished) {
      try { this._call({ operation: 'digest-abort', handle: handle }); }
      catch (_) { /* preserve the first host failure */ }
    }
  }
};

NativeHostCryptoProvider.prototype.request = function (effect) {
  if (!effect || typeof effect !== 'object' || !effect.parameters) throw new TypeError('Crypto effect is invalid.');
  var p = effect.parameters;
  var request;
  var rawEcdsaOutput = false;
  switch (effect.operation) {
    case 'random': request = { operation: 'random', length: p.length }; break;
    case 'digest': request = { operation: 'digest', algorithm: hashName(p.algorithm), data: binary(p.data) }; break;
    case 'hmac': request = { operation: 'hmac', algorithm: hmacName(p.algorithm), key: binary(p.key), data: binary(p.data) }; break;
    case 'pbkdf2': request = { operation: 'pbkdf2', algorithm: hmacName(p.algorithm), password: binary(p.password), salt: binary(p.salt), iterations: p.iterations, length: p.length }; break;
    case 'hkdf': request = { operation: 'hkdf', algorithm: hmacName(p.algorithm), key: binary(p.key), salt: binary(p.salt), info: binary(p.info), length: p.length }; break;
    case 'aes':
      if (p.mode !== 'cbc' && p.mode !== 'ctr') throw new TypeError('Unsupported AES mode.');
      if (p.direction !== 'encrypt' && p.direction !== 'decrypt') throw new TypeError('Unsupported AES direction.');
      if (p.mode === 'ctr' && p.padding !== false) throw new TypeError('AES-CTR does not support padding.');
      request = {
        operation: p.mode === 'ctr' ? 'aes-ctr' : 'aes-cbc-' + p.direction,
        key: binary(p.key), iv: binary(p.iv), data: binary(p.data),
        padding: p.padding === false ? 'NONE' : 'PKCS7',
      };
      break;
    case 'sign':
      request = { operation: 'sign', handle: p.keyId, algorithm: signatureName(p.specification), data: binary(p.data) };
      rawEcdsaOutput = p.specification && p.specification.algorithm === 'ecdsa'
        && p.specification.signatureFormat === 'raw';
      break;
    case 'generateKey': {
      var keySpec = p.specification || {};
      if (keySpec.persistence !== undefined
          && keySpec.persistence !== 'persistent'
          && keySpec.persistence !== 'session') {
        throw new TypeError('Unsupported key persistence.');
      }
      request = keySpec.algorithm === 'ec'
        ? { operation: 'generate-key', keyType: 'EC', curve: keySpec.namedCurve === 'p-256' ? 'secp256r1' : keySpec.namedCurve,
          persistent: keySpec.persistence !== 'session' }
        : { operation: 'generate-key', keyType: 'RSA', keySize: keySpec.modulusLength,
          persistent: keySpec.persistence !== 'session' };
      var generated = this._call(request);
      if (typeof generated.handle !== 'string') throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no key handle.');
      return generated.handle;
    }
    case 'importPrivateKey': {
      if (p.persistence !== undefined
          && p.persistence !== 'persistent'
          && p.persistence !== 'session') {
        throw new TypeError('Unsupported key persistence.');
      }
      request = {
        operation: 'import-private-key',
        keyType: p.keyType,
        privateKey: binary(p.privateKey),
        publicKey: binary(p.publicKey),
        persistent: p.persistence !== 'session',
      };
      var imported = this._call(request);
      if (typeof imported.handle !== 'string') throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no key handle.');
      return imported.handle;
    }
    case 'exportPublicKey':
      if (p.format !== 'spki') throw new TypeError('Host crypto exports SPKI public keys only.');
      request = { operation: 'export-public-key', handle: p.keyId };
      break;
    case 'verify':
      request = {
        operation: 'verify',
        algorithm: signatureName(p.specification),
        peerPublicKey: binary(p.publicKey),
        data: binary(p.data),
        signature: bytes.bytesToBase64(signatureInput(p.specification, p.signature)),
      };
      return this._call(request).verified;
    case 'derive':
      request = { operation: 'derive', handle: p.keyId, algorithm: 'ECDH', peerPublicKey: binary(p.peerPublicKey) };
      break;
    case 'deleteKey':
      request = { operation: 'delete-key', handle: p.keyId };
      return this._call(request).deleted === true;
    case 'rsaEncrypt':
      if (!p.specification || p.specification.algorithm !== 'rsa-oaep') {
        throw new TypeError('Unsupported RSA encryption algorithm.');
      }
      request = {
        operation: 'rsa-oaep-encrypt',
        algorithm: 'RSA-OAEP-' + hashName(p.specification.hash).replace('-', ''),
        peerPublicKey: binary(p.publicKey),
        data: binary(p.data),
      };
      break;
    default: throw new TypeError('Unsupported crypto effect operation.');
  }
  var response = this._call(request);
  if (typeof response.data !== 'string') throw new HostCryptoError('INVALID_RESPONSE', 'Host crypto returned no binary result.');
  if (rawEcdsaOutput) {
    return { $bytes: bytes.bytesToBase64(asn1.ecdsaDerSignatureToRaw(bytes.base64ToBytes(response.data), 32)) };
  }
  return { $bytes: response.data };
};

module.exports = {
  HostCryptoError: HostCryptoError,
  MAX_DIGEST_CHUNK_BYTES: MAX_DIGEST_CHUNK_BYTES,
  NativeHostCryptoProvider: NativeHostCryptoProvider,
};
