'use strict';
// Pure-JS stand-in for the native _HostCrypto bridge (libpebble3 HostCryptoBridge.kt): same JSON
// request/response contract, error codes and key encodings. Only randomness comes from the host.
var sha1 = require('@noble/hashes/legacy.js').sha1;
var sha2 = require('@noble/hashes/sha2.js');
var hmac = require('@noble/hashes/hmac.js').hmac;
var pbkdf2 = require('@noble/hashes/pbkdf2.js').pbkdf2;
var hkdf = require('@noble/hashes/hkdf.js').hkdf;
var aes = require('@noble/ciphers/aes.js');
var p256 = require('@noble/curves/nist.js').p256;
var asn1 = require('../../../chat/imessage/src/codecs/asn1');
var bytes = require('../../../chat/imessage/src/runtime/bytes');

var HASHES = { 'SHA-1': sha1, 'SHA-256': sha2.sha256, 'SHA-384': sha2.sha384, 'SHA-512': sha2.sha512 };
var SIGNATURE_HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' };
var DIGEST_INFO = {
  'SHA-1': '3021300906052b0e03021a05000414',
  'SHA-256': '3031300d060960864801650304020105000420',
  'SHA-384': '3041300d060960864801650304020205000430',
  'SHA-512': '3051300d060960864801650304020305000440',
};
var RSA_OID = '1.2.840.113549.1.1.1';
var EC_OID = '1.2.840.10045.2.1';
var P256_OID = '1.2.840.10045.3.1.7';
var RSA_E = 65537n;
var KEY_PREFIX = 'js-host-crypto:opaque-key-v1:';
var HANDLE_PATTERN = /^[0-9a-f]{32}$/;
var REQUEST_FIELDS = ['operation', 'algorithm', 'data', 'key', 'password', 'salt', 'info', 'iv', 'iterations',
  'length', 'padding', 'handle', 'keyType', 'keySize', 'curve', 'persistent', 'privateKey', 'publicKey',
  'peerPublicKey', 'signature'];
var MAX_INPUT_BYTES = 16 * 1024 * 1024;
var MAX_RANDOM_BYTES = 1024 * 1024;
var MAX_DERIVED_BYTES = 1024 * 1024;
var MAX_PBKDF2_ITERATIONS = 10000000;
var MAX_PBKDF2_WORK = 20000000;
var MAX_DIGEST_CHUNK_BYTES = 1024 * 1024;
var MAX_DIGEST_SESSIONS = 8;
var SMALL_PRIMES = (function () {
  var primes = [];
  for (var candidate = 3; candidate < 2048; candidate += 2) {
    if (primes.every(function (prime) { return candidate % prime !== 0; })) primes.push(candidate);
  }
  return primes;
})();

function Failure(code, message) { this.code = code; this.message = message; }
function fail(code, message) { throw new Failure(code, message); }
function invalid(message) { fail('INVALID_REQUEST', message); }
function unsupported(message) { fail('UNSUPPORTED_ALGORITHM', message); }

function toBig(value) { return value.length === 0 ? 0n : BigInt('0x' + bytes.bytesToHex(value)); }
function toBytes(value, length) {
  var hex = value.toString(16);
  if (hex.length > length * 2) throw new RangeError('Integer is too large.');
  return bytes.hexToBytes(hex.padStart(length * 2, '0'));
}
function bitLength(value) { return value === 0n ? 0 : value.toString(2).length; }
function modPow(base, exponent, modulus) {
  var result = 1n;
  base %= modulus;
  var bits = exponent.toString(2);
  for (var index = 0; index < bits.length; index += 1) {
    result = result * result % modulus;
    if (bits[index] === '1') result = result * base % modulus;
  }
  return result;
}
function modInverse(value, modulus) {
  var oldR = value % modulus, r = modulus, oldS = 1n, s = 0n;
  while (r !== 0n) {
    var quotient = oldR / r;
    var nextR = oldR - quotient * r; oldR = r; r = nextR;
    var nextS = oldS - quotient * s; oldS = s; s = nextS;
  }
  if (oldR !== 1n) throw new RangeError('Value is not invertible.');
  return (oldS % modulus + modulus) % modulus;
}
function gcd(a, b) { while (b !== 0n) { var t = a % b; a = b; b = t; } return a; }
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

function hashFor(name, message) {
  var hash = HASHES[String(name).toUpperCase()];
  if (!hash) unsupported(message);
  return hash;
}
function hmacHash(name) {
  var upper = String(name).toUpperCase();
  if (upper.indexOf('HMAC-') !== 0 || !HASHES[upper.slice(5)]) unsupported('Unsupported HMAC algorithm');
  return HASHES[upper.slice(5)];
}
function signatureSpec(algorithm) {
  var match = /^SHA(1|256|384|512)WITH(RSA|ECDSA)$/.exec(String(algorithm).toUpperCase());
  if (!match) unsupported('Unsupported signature algorithm');
  return { hash: SIGNATURE_HASHES['SHA' + match[1]], keyType: match[2] === 'RSA' ? 'RSA' : 'EC' };
}

function isSequence(element, minimumChildren) {
  if (!element || element.tagClass !== 0 || element.tagNumber !== 16 || !element.constructed
      || element.children.length < minimumChildren) throw new RangeError('Expected a DER sequence.');
  return element.children;
}
function octets(element) {
  if (element.tagClass !== 0 || element.tagNumber !== 4 || element.constructed) throw new RangeError('Expected octets.');
  return element.value.slice();
}
function checkRsaSize(n) {
  var bits = bitLength(n);
  if (bits < 1024 || bits > 4096 || bits % 128 !== 0) throw new RangeError('RSA key size is unsupported.');
}
function rsaAlgorithm() { return asn1.derAlgorithmIdentifier(RSA_OID, asn1.derNull()); }
function ecAlgorithm() { return asn1.derAlgorithmIdentifier(EC_OID, asn1.derObjectIdentifier(P256_OID)); }
function sameAlgorithm(element, expected) { return equalBytes(element.raw, expected); }

function rsaKey(n, e, d, p, q) {
  return { type: 'RSA', n: n, e: e, d: d, p: p, q: q, dp: d % (p - 1n), dq: d % (q - 1n), qi: modInverse(q, p),
    k: Math.ceil(bitLength(n) / 8) };
}
function spkiFor(key) {
  return key.type === 'RSA'
    ? asn1.derSequence([rsaAlgorithm(), asn1.derBitString(asn1.derSequence([asn1.derInteger(key.n), asn1.derInteger(key.e)]))])
    : asn1.derSequence([ecAlgorithm(), asn1.derBitString(key.publicKey)]);
}
function pkcs8For(key) {
  var inner = key.type === 'RSA'
    ? asn1.derSequence([0n, key.n, key.e, key.d, key.p, key.q, key.dp, key.dq, key.qi].map(asn1.derInteger))
    : asn1.derSequence([asn1.derInteger(1), asn1.derOctetString(key.secretKey),
      asn1.derContext(1, true, asn1.derBitString(key.publicKey))]);
  return asn1.derSequence([asn1.derInteger(0), key.type === 'RSA' ? rsaAlgorithm() : ecAlgorithm(),
    asn1.derOctetString(inner)]);
}

function parsePublicKey(type, der) {
  try {
    var fields = isSequence(asn1.parseDer(der), 2);
    if (fields.length !== 2) throw new RangeError('SPKI has extra fields.');
    var bitString = asn1.decodeBitString(fields[1]);
    if (bitString.unusedBits !== 0) throw new RangeError('SPKI key has unused bits.');
    if (type === 'RSA') {
      var algorithm = asn1.parseAlgorithmIdentifier(fields[0]);
      if (algorithm.oid !== RSA_OID || (algorithm.parameters && !equalBytes(algorithm.parameters, asn1.derNull()))) {
        throw new RangeError('SPKI is not RSA.');
      }
      var numbers = isSequence(asn1.parseDer(bitString.bytes), 2);
      var n = asn1.decodeInteger(numbers[0]), e = asn1.decodeInteger(numbers[1]);
      if (numbers.length !== 2 || e < 3n || e % 2n === 0n || e >= n) throw new RangeError('RSA public key is invalid.');
      checkRsaSize(n);
      return { type: 'RSA', n: n, e: e, k: Math.ceil(bitLength(n) / 8) };
    }
    if (!sameAlgorithm(fields[0], ecAlgorithm()) || bitString.bytes.length !== 65 || bitString.bytes[0] !== 4) {
      throw new RangeError('SPKI is not uncompressed P-256.');
    }
    p256.Point.fromBytes(bitString.bytes).assertValidity();
    return { type: 'EC', publicKey: bitString.bytes };
  } catch (_) {
    return invalid('Peer public key is invalid');
  }
}

// Throws plain errors; callers choose the failure code (import vs. corrupt storage).
function parsePrivateKey(type, der) {
  var fields = isSequence(asn1.parseDer(der), 3);
  if (asn1.decodeInteger(fields[0]) !== 0n) throw new RangeError('PKCS#8 version is unsupported.');
  if (!sameAlgorithm(fields[1], type === 'RSA' ? rsaAlgorithm() : ecAlgorithm())) {
    invalid('Imported key type does not match keyType');
  }
  var inner = isSequence(asn1.parseDer(octets(fields[2])), type === 'RSA' ? 9 : 2);
  if (type === 'RSA') {
    var values = inner.slice(0, 9).map(asn1.decodeInteger);
    if (values[0] !== 0n || inner.length !== 9) throw new RangeError('Only two-prime RSA keys are supported.');
    checkRsaSize(values[1]);
    var key = rsaKey(values[1], values[2], values[3], values[4], values[5]);
    if (key.p * key.q !== key.n) throw new RangeError('RSA primes do not match the modulus.');
    return key;
  }
  if (asn1.decodeInteger(inner[0]) !== 1n) throw new RangeError('ECPrivateKey version is unsupported.');
  var secretKey = octets(inner[1]);
  if (secretKey.length !== 32 || !p256.utils.isValidSecretKey(secretKey)) throw new RangeError('EC scalar is invalid.');
  return { type: 'EC', secretKey: secretKey, publicKey: p256.getPublicKey(secretKey, false) };
}

function rsaPrivate(key, message) {
  var m1 = modPow(message % key.p, key.dp, key.p);
  var m2 = modPow(message % key.q, key.dq, key.q);
  var h = key.qi * (m1 - m2) % key.p;
  if (h < 0n) h += key.p;
  return m2 + h * key.q;
}
function emsaPkcs1(hashName, data, k) {
  var t = bytes.concatBytes(bytes.hexToBytes(DIGEST_INFO[hashName]), HASHES[hashName](data));
  if (k < t.length + 11) throw new RangeError('RSA key is too short for this digest.');
  var em = new Uint8Array(k).fill(0xff);
  em[0] = 0; em[1] = 1; em[k - t.length - 1] = 0;
  em.set(t, k - t.length);
  return em;
}
function mgf1(hash, seed, length) {
  var output = new Uint8Array(length);
  for (var counter = 0, offset = 0; offset < length; counter += 1) {
    var block = hash(bytes.concatBytes(seed, bytes.uint32BE(counter)));
    output.set(block.subarray(0, Math.min(block.length, length - offset)), offset);
    offset += block.length;
  }
  return output;
}
function xorInto(target, mask) { for (var index = 0; index < target.length; index += 1) target[index] ^= mask[index]; }

function JsHostCrypto(hostCrypto, storage) {
  if (!hostCrypto || typeof hostCrypto.request !== 'function') throw new TypeError('Host random source is unavailable.');
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function'
      || typeof storage.removeItem !== 'function') throw new TypeError('Key storage is unavailable.');
  this.host = hostCrypto;
  this.storage = storage;
  this.sessionKeys = Object.create(null);
  this.digests = Object.create(null);
  this.digestCount = 0;
  this.nextDigestId = 1;
}

JsHostCrypto.prototype.request = function (json) {
  try {
    if (typeof json !== 'string') invalid('Request must be a JSON string');
    var request;
    try { request = JSON.parse(json); } catch (_) { invalid('Host crypto request is invalid'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some(function (name) { return REQUEST_FIELDS.indexOf(name) === -1; })
        || typeof request.operation !== 'string') invalid('Host crypto request is invalid');
    return JSON.stringify(Object.assign({ ok: true }, this._execute(request)));
  } catch (error) {
    var failure = error instanceof Failure ? error : new Failure('OPERATION_FAILED', 'Host crypto operation failed');
    return JSON.stringify({ ok: false, code: failure.code, message: failure.message });
  }
};

// The host rejects 0 and serves at most HOST_RANDOM_CHUNK bytes per request.
var HOST_RANDOM_CHUNK = 65536;

JsHostCrypto.prototype.random = function (length) {
  var out = new Uint8Array(length);
  for (var offset = 0; offset < length; offset += HOST_RANDOM_CHUNK) {
    var size = Math.min(HOST_RANDOM_CHUNK, length - offset);
    var response = JSON.parse(this.host.request(JSON.stringify({ operation: 'random', length: size })));
    if (!response || response.ok !== true) fail(response && response.code || 'OPERATION_FAILED', response && response.message || 'Host random failed');
    var data = bytes.base64ToBytes(response.data);
    if (data.length !== size) fail('OPERATION_FAILED', 'Host random returned the wrong length');
    out.set(data, offset);
  }
  return out;
};

JsHostCrypto.prototype._execute = function (r) {
  function data(value) { return { data: bytes.bytesToBase64(value) }; }
  switch (r.operation) {
    case 'random': return data(this.random(requireLength(r, MAX_RANDOM_BYTES)));
    case 'digest': {
      var input = binary(r, 'data');
      return data(hashFor(requireString(r, 'algorithm'), 'Unsupported digest algorithm')(input));
    }
    case 'digest-open': {
      var algorithm = requireString(r, 'algorithm');
      if (algorithm.length < 1 || algorithm.length > 64) invalid('algorithm is invalid');
      if (this.digestCount >= MAX_DIGEST_SESSIONS) fail('LIMIT_EXCEEDED', 'Too many digest sessions are open');
      var handle = 'digest-' + this.nextDigestId++;
      this.digests[handle] = hashFor(algorithm, 'Unsupported digest algorithm').create();
      this.digestCount += 1;
      return { handle: handle };
    }
    case 'digest-update': {
      var session = this._digest(requireString(r, 'handle'));
      var chunk = binary(r, 'data');
      if (chunk.length > MAX_DIGEST_CHUNK_BYTES) invalid('Digest chunk is too large');
      session.update(chunk);
      return {};
    }
    case 'digest-finish': {
      var finishHandle = requireString(r, 'handle');
      var finished = this._digest(finishHandle);
      this._dropDigest(finishHandle);
      return data(finished.digest());
    }
    case 'digest-abort': return { deleted: this._dropDigest(requireString(r, 'handle')) };
    case 'hmac': {
      var hmacKey = binary(r, 'key'), hmacData = binary(r, 'data');
      return data(hmac(hmacHash(requireString(r, 'algorithm')), hmacKey, hmacData));
    }
    case 'pbkdf2': {
      var password = binary(r, 'password'), salt = binary(r, 'salt');
      if (!Number.isInteger(r.iterations) || r.iterations < 1 || r.iterations > MAX_PBKDF2_ITERATIONS) {
        invalid('iterations is outside configured bounds');
      }
      var length = requireLength(r, MAX_DERIVED_BYTES);
      var hash = hmacHash(requireString(r, 'algorithm'));
      if (Math.ceil(length / hash.outputLen) * r.iterations > MAX_PBKDF2_WORK) invalid('PBKDF2 work exceeds supported bounds');
      return data(length === 0 ? new Uint8Array(0) : pbkdf2(hash, password, salt, { c: r.iterations, dkLen: length }));
    }
    case 'hkdf': {
      var ikm = binary(r, 'key'), hkdfSalt = binary(r, 'salt'), info = binary(r, 'info');
      var hkdfLength = requireLength(r, MAX_DERIVED_BYTES);
      var hkdfHash = hmacHash(requireString(r, 'algorithm'));
      if (hkdfLength > 255 * hkdfHash.outputLen) invalid('HKDF output is too long');
      return data(hkdfLength === 0 ? new Uint8Array(0) : hkdf(hkdfHash, ikm, hkdfSalt, info, hkdfLength));
    }
    case 'aes-cbc-encrypt':
    case 'aes-cbc-decrypt': {
      var cbcKey = binary(r, 'key'), cbcIv = binary(r, 'iv'), cbcData = binary(r, 'data');
      validateAes(cbcKey, cbcIv);
      var padding = r.padding === undefined || r.padding === null ? 'NONE' : requireString(r, 'padding');
      if (padding !== 'NONE' && padding !== 'PKCS7') unsupported('Unsupported AES-CBC padding');
      if (padding === 'NONE' && cbcData.length % 16 !== 0) invalid('AES-CBC input must contain whole blocks when padding is NONE');
      var cipher = aes.cbc(cbcKey, cbcIv, { disablePadding: padding === 'NONE' });
      return data(r.operation === 'aes-cbc-encrypt' ? cipher.encrypt(cbcData) : cipher.decrypt(cbcData));
    }
    case 'aes-ctr': {
      var ctrKey = binary(r, 'key'), ctrIv = binary(r, 'iv'), ctrData = binary(r, 'data');
      validateAes(ctrKey, ctrIv);
      return data(aes.ctr(ctrKey, ctrIv).encrypt(ctrData));
    }
    case 'generate-key': {
      var generated = this._generate(requireString(r, 'keyType').toUpperCase(), r.keySize, r.curve);
      var spki = spkiFor(generated);
      return { handle: this._store(generated.type, pkcs8For(generated), spki, persistent(r)), publicKey: bytes.bytesToBase64(spki) };
    }
    case 'import-private-key': {
      var privateDer = binary(r, 'privateKey'), publicDer = binary(r, 'publicKey');
      var type = requireString(r, 'keyType').toUpperCase();
      if (type !== 'RSA' && type !== 'EC') unsupported('Unsupported asymmetric key type');
      var peer;
      try { peer = parsePublicKey(type, publicDer); } catch (_) { invalid('Imported key encoding is invalid'); }
      var imported;
      try { imported = parsePrivateKey(type, privateDer); } catch (error) {
        if (error instanceof Failure) throw error;
        invalid('Imported key encoding is invalid');
      }
      if (!this._matches(imported, peer)) invalid('Imported private and public keys do not match');
      return { handle: this._store(type, privateDer, publicDer, persistent(r)) };
    }
    case 'sign': {
      var signData = binary(r, 'data');
      var signer = this._load(requireString(r, 'handle'));
      var spec = signatureSpec(requireString(r, 'algorithm'));
      if (spec.keyType !== signer.type) unsupported('Unsupported signature algorithm for key type');
      return data(sign(signer, spec.hash, signData));
    }
    case 'verify': {
      var verifyKey = binary(r, 'peerPublicKey'), verifyData = binary(r, 'data'), signature = binary(r, 'signature');
      var verifySpec = signatureSpec(requireString(r, 'algorithm'));
      return { verified: verify(parsePublicKey(verifySpec.keyType, verifyKey), verifySpec.hash, verifyData, signature) };
    }
    case 'rsa-oaep-encrypt': {
      var oaepKey = binary(r, 'peerPublicKey'), plaintext = binary(r, 'data');
      var oaepHash = { 'RSA-OAEP-SHA1': 'SHA-1', 'RSA-OAEP-SHA256': 'SHA-256' }[requireString(r, 'algorithm').toUpperCase()];
      if (!oaepHash) unsupported('Unsupported RSA-OAEP algorithm');
      return data(this._oaepEncrypt(parsePublicKey('RSA', oaepKey), HASHES[oaepHash], plaintext));
    }
    case 'derive': {
      var peerKey = binary(r, 'peerPublicKey');
      if (requireString(r, 'algorithm') !== 'ECDH') unsupported('Unsupported key agreement algorithm');
      var local = this._load(requireString(r, 'handle'));
      if (local.type !== 'EC') invalid('Key type does not support ECDH');
      return data(p256.getSharedSecret(local.secretKey, parsePublicKey('EC', peerKey).publicKey, true).slice(1));
    }
    case 'export-public-key': return data(this._record(requireString(r, 'handle')).spki);
    case 'delete-key': {
      var deleteHandle = validHandle(requireString(r, 'handle'));
      if (this.sessionKeys[deleteHandle]) {
        delete this.sessionKeys[deleteHandle];
        return { deleted: true };
      }
      var existed = this.storage.getItem(KEY_PREFIX + deleteHandle) !== null;
      this.storage.removeItem(KEY_PREFIX + deleteHandle);
      return { deleted: existed };
    }
    default: return invalid('Unknown host crypto operation');
  }
};

JsHostCrypto.prototype._digest = function (handle) {
  var session = this.digests[handle];
  if (!session) fail('SESSION_NOT_FOUND', 'Digest session does not exist');
  return session;
};
JsHostCrypto.prototype._dropDigest = function (handle) {
  if (!this.digests[handle]) return false;
  delete this.digests[handle];
  this.digestCount -= 1;
  return true;
};

JsHostCrypto.prototype._generate = function (type, keySize, curve) {
  if (type === 'RSA') {
    if (keySize === undefined || keySize === null) invalid('RSA keySize is required');
    if (!Number.isInteger(keySize) || keySize < 1024 || keySize > 4096 || keySize % 128 !== 0) {
      invalid('RSA keySize is outside supported bounds');
    }
    var half = keySize / 2;
    for (;;) {
      var p = this._prime(half), q = this._prime(half);
      var distance = p > q ? p - q : q - p;
      if (distance >> BigInt(half - 100) === 0n) continue;
      if (p < q) { var swap = p; p = q; q = swap; }
      var lambda = (p - 1n) * (q - 1n) / gcd(p - 1n, q - 1n);
      return rsaKey(p * q, RSA_E, modInverse(RSA_E, lambda), p, q);
    }
  }
  if (type === 'EC') {
    if (keySize !== undefined && keySize !== null) invalid('EC keys use curve instead of keySize');
    if (curve === undefined || curve === null) invalid('EC curve is required');
    if (curve !== 'secp256r1') unsupported('Unsupported EC curve');
    var secretKey = p256.utils.randomSecretKey(this.random(48));
    return { type: 'EC', secretKey: secretKey, publicKey: p256.getPublicKey(secretKey, false) };
  }
  return unsupported('Unsupported asymmetric key type');
};

// ponytail: incremental small-prime sieve + Miller-Rabin; no BigInt Montgomery tricks, so 2048-bit
// generation takes seconds on slow engines.
JsHostCrypto.prototype._prime = function (bits) {
  var rounds = bits >= 1024 ? 5 : 8;
  for (;;) {
    var seed = this.random(bits / 8);
    seed[0] |= 0xc0;
    seed[seed.length - 1] |= 1;
    var start = toBig(seed);
    var residues = SMALL_PRIMES.map(function (prime) { return Number(start % BigInt(prime)); });
    var exponentResidue = Number(start % RSA_E);
    for (var delta = 0; delta < 1 << 16; delta += 2) {
      var sieved = true;
      for (var index = 0; index < SMALL_PRIMES.length; index += 1) {
        if ((residues[index] + delta) % SMALL_PRIMES[index] === 0) { sieved = false; break; }
      }
      if (!sieved || (exponentResidue + delta) % 65537 === 1) continue;
      var candidate = start + BigInt(delta);
      if (bitLength(candidate) !== bits) break;
      if (this._probablePrime(candidate, rounds)) return candidate;
    }
  }
};

JsHostCrypto.prototype._probablePrime = function (n, rounds) {
  var d = n - 1n, s = 0;
  while ((d & 1n) === 0n) { d >>= 1n; s += 1; }
  var width = Math.ceil(bitLength(n) / 8);
  for (var round = 0; round < rounds; round += 1) {
    var x = modPow(toBig(this.random(width)) % (n - 3n) + 2n, d, n);
    if (x === 1n || x === n - 1n) continue;
    for (var step = 1; step < s && x !== n - 1n; step += 1) x = x * x % n;
    if (x !== n - 1n) return false;
  }
  return true;
};

JsHostCrypto.prototype._matches = function (key, peer) {
  if (key.type === 'EC') return equalBytes(key.publicKey, peer.publicKey);
  if (key.n !== peer.n || key.e !== peer.e) return false;
  var proof = toBig(this.random(key.k - 1));
  return modPow(rsaPrivate(key, proof), key.e, key.n) === proof;
};

JsHostCrypto.prototype._oaepEncrypt = function (key, hash, message) {
  var hLen = hash.outputLen;
  if (message.length > key.k - 2 * hLen - 2) throw new RangeError('RSA-OAEP message is too long.');
  var db = new Uint8Array(key.k - hLen - 1);
  db.set(hash(new Uint8Array(0)));
  db[db.length - message.length - 1] = 1;
  db.set(message, db.length - message.length);
  var seed = this.random(hLen);
  xorInto(db, mgf1(hash, seed, db.length));
  xorInto(seed, mgf1(hash, db, hLen));
  var em = bytes.concatBytes(new Uint8Array([0]), seed, db);
  return toBytes(modPow(toBig(em), key.e, key.n), key.k);
};

JsHostCrypto.prototype._store = function (type, pkcs8, spki, persistent) {
  for (var attempt = 0; attempt < 16; attempt += 1) {
    var handle = bytes.bytesToHex(this.random(16));
    if (this.sessionKeys[handle] || this.storage.getItem(KEY_PREFIX + handle) !== null) continue;
    var record = { type: type, pkcs8: new Uint8Array(pkcs8), spki: new Uint8Array(spki) };
    if (persistent) {
      this.storage.setItem(KEY_PREFIX + handle,
        [type, bytes.bytesToBase64(record.pkcs8), bytes.bytesToBase64(record.spki)].join('\n'));
    } else {
      this.sessionKeys[handle] = record;
    }
    return handle;
  }
  return fail('OPERATION_FAILED', 'Could not allocate an opaque key handle');
};

JsHostCrypto.prototype._record = function (handle) {
  validHandle(handle);
  if (this.sessionKeys[handle]) return this.sessionKeys[handle];
  var stored = this.storage.getItem(KEY_PREFIX + handle);
  if (stored === null || stored === undefined) fail('KEY_NOT_FOUND', 'Key handle does not exist');
  var parts = String(stored).split('\n');
  try {
    if (parts.length !== 3 || (parts[0] !== 'RSA' && parts[0] !== 'EC')) throw new RangeError('corrupt');
    return { type: parts[0], pkcs8: bytes.base64ToBytes(parts[1]), spki: bytes.base64ToBytes(parts[2]) };
  } catch (_) {
    return fail('KEY_NOT_FOUND', 'Key handle is corrupt');
  }
};

JsHostCrypto.prototype._load = function (handle) {
  var record = this._record(handle);
  try {
    return parsePrivateKey(record.type, record.pkcs8);
  } catch (_) {
    return fail('KEY_NOT_FOUND', 'Key handle is corrupt');
  }
};

function sign(key, hashName, message) {
  if (key.type === 'EC') return p256.sign(HASHES[hashName](message), key.secretKey, { prehash: false, format: 'der' });
  return toBytes(rsaPrivate(key, toBig(emsaPkcs1(hashName, message, key.k))), key.k);
}
function verify(key, hashName, message, signature) {
  if (key.type === 'EC') {
    try {
      return p256.verify(signature, HASHES[hashName](message), key.publicKey, { prehash: false, lowS: false, format: 'der' });
    } catch (_) {
      return false;
    }
  }
  var s = toBig(signature);
  if (signature.length !== key.k || s >= key.n) return false;
  return equalBytes(toBytes(modPow(s, key.e, key.n), key.k), emsaPkcs1(hashName, message, key.k));
}

function requireString(request, name) {
  var value = request[name];
  if (value === undefined || value === null) invalid(name + ' is required');
  if (typeof value !== 'string') invalid('Host crypto request is invalid');
  return value;
}
function requireLength(request, maximum) {
  if (!Number.isInteger(request.length) || request.length < 0 || request.length > maximum) {
    invalid('length is outside configured bounds');
  }
  return request.length;
}
function binary(request, name) {
  var encoded = requireString(request, name);
  var decoded;
  try { decoded = bytes.base64ToBytes(encoded); } catch (_) { invalid('Byte input must use canonical base64'); }
  if (decoded.length > MAX_INPUT_BYTES || (encoded.length > 0 && bytes.bytesToBase64(decoded) !== encoded)) {
    invalid('Byte input is non-canonical or too large');
  }
  return decoded;
}
function persistent(request) {
  if (request.persistent === undefined || request.persistent === null) return true;
  if (typeof request.persistent !== 'boolean') invalid('Host crypto request is invalid');
  return request.persistent;
}
function validHandle(handle) {
  if (!HANDLE_PATTERN.test(handle)) invalid('Key handle is malformed');
  return handle;
}
function validateAes(key, iv) {
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) invalid('AES key length is invalid');
  if (iv.length !== 16) invalid('AES IV length is invalid');
}

module.exports = { JsHostCrypto: JsHostCrypto, KEY_PREFIX: KEY_PREFIX };
