'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var bytes = require('../../src/runtime/bytes');
var asn1 = require('../../src/codecs/asn1');
var protobuf = require('../../src/codecs/protobuf');
var ngm = require('../../src/ids/ngm-pair-ec');

var GENERATOR_X = bytes.hexToBytes('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
var GENERATOR_POINT = bytes.hexToBytes(
  '04' +
  '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
  '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'
);
var GENERATOR_SPKI = ngm.compactP256ToSpki(GENERATOR_X);

function rawSignature(rLast, sLast) {
  var raw = new Uint8Array(64);
  raw[31] = rLast;
  raw[63] = sLast;
  return raw;
}

function katCrypto(overrides) {
  var deleted = [];
  var base = {
    aes: function (options) { return new Uint8Array(options.data); },
    deleteKey: function (keyId) { deleted.push(keyId); },
    derive: function () { return new Uint8Array(32).fill(0x11); },
    digest: function () { return new Uint8Array(32).map(function (_, index) { return index; }); },
    exportPublicKey: function () { return GENERATOR_SPKI; },
    generateKey: function () { return 'ephemeral-kat'; },
    hkdf: function () { return new Uint8Array(48).map(function (_, index) { return index + 1; }); },
    random: function (length) {
      return new Uint8Array(length).map(function (_, index) { return 0xa0 + index; });
    },
    sign: function () { return asn1.ecdsaRawSignatureToDer(rawSignature(1, 2)); },
    verify: function () { return true; },
  };
  Object.keys(overrides || {}).forEach(function (name) { base[name] = overrides[name]; });
  base.deleted = deleted;
  return base;
}

function prekeyData(key, signature, timestamp) {
  return ngm.encodePreKeyData({ key: key, signature: signature, timestamp: timestamp });
}

test('P-256 compact expansion matches the lower-half standard generator point', function () {
  assert.deepEqual(ngm.compactP256ToUncompressed(GENERATOR_X), GENERATOR_POINT);
  assert.deepEqual(ngm.parseCompactP256Spki(GENERATOR_SPKI).compact, GENERATOR_X);
  assert.throws(function () {
    ngm.compactP256ToUncompressed(new Uint8Array(32).fill(0xff));
  }, /out of range/);
});

test('prekey protobuf follows prost default elision for a zero timestamp', function () {
  var encoded = ngm.encodePreKeyData({
    key: GENERATOR_X,
    signature: new Uint8Array(64),
    timestamp: 0,
  });
  assert.equal(encoded.length, 100);
  assert.equal(ngm.decodePreKeyData(encoded).timestamp, 0);
});

test('prekey protobuf matches prost by skipping bounded multi-kilobyte unknown fields', function () {
  var key = new Uint8Array(GENERATOR_X);
  var signature = new Uint8Array(64).fill(0x5a);
  var encoded = bytes.concatBytes(
    ngm.encodePreKeyData({ key: key, signature: signature, timestamp: 1234.5 }),
    new protobuf.ProtobufWriter().bytes(99, new Uint8Array(1600).fill(0xa5)).finish()
  );

  assert.deepEqual(ngm.decodePreKeyData(encoded), {
    key: key,
    signature: signature,
    timestamp: 1234.5,
  });
});

test('counter scope matches Rust DefaultHasher over three compact byte arrays', function () {
  assert.equal(ngm.buildCounterScope(
    new Uint8Array(32), new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)
  ), '2299965744193442279');
});

test('pair-ec synthetic known-answer transcript matches prost fields, padding, and validator', function () {
  var crypto = katCrypto();
  var reservedScope;
  var result = ngm.encryptPairEc({
    crypto: crypto,
    sender: { deviceKeyId: 'sender-device', devicePublicKey: GENERATOR_SPKI },
    target: {
      deviceKey: GENERATOR_X,
      preKeyData: prekeyData(GENERATOR_X, new Uint8Array(64), 1234.5),
    },
    message: bytes.hexToBytes('dead'),
    reserveCounter: function (scope) { reservedScope = scope; return 1; },
  });

  var expected = bytes.concatBytes(
    bytes.hexToBytes('0a14'),
    bytes.hexToBytes('0a02dead1000a0a1a2a3a4a5a6a7a8a90a000000'),
    bytes.hexToBytes('1220'), GENERATOR_X,
    bytes.hexToBytes('1a40'), rawSignature(1, 2),
    bytes.hexToBytes('9a0607'), bytes.hexToBytes('6b176b176b170c')
  );
  assert.deepEqual(result.payload, expected);
  assert.equal(result.format, 'pair-ec');
  assert.equal(result.counter, 0);
  assert.equal(result.counterScope, reservedScope);
  assert.match(reservedScope, /^[0-9]+$/);
  assert.deepEqual(crypto.deleted, ['ephemeral-kat']);
});

function generateCompactKeyPair() {
  for (;;) {
    var pair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    var spki = new Uint8Array(pair.publicKey.export({ format: 'der', type: 'spki' }));
    try {
      var compact = ngm.parseCompactP256Spki(spki).compact;
      return { privateKey: pair.privateKey, publicKey: pair.publicKey, spki: spki, compact: compact };
    } catch (error) {
      if (!(error instanceof TypeError) || !/lower-half compact point/.test(error.message)) throw error;
    }
  }
}

function nodeProvider(ephemeralPairs) {
  var keyPairs = {};
  var nextId = 1;
  var deleted = [];
  return {
    addKey: function (id, pair) { keyPairs[id] = pair; },
    deleted: deleted,
    aes: function (options) {
      var cipher = nodeCrypto.createCipheriv('aes-256-ctr', Buffer.from(options.key), Buffer.from(options.iv));
      return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(options.data)), cipher.final()]));
    },
    deleteKey: function (id) { deleted.push(id); delete keyPairs[id]; },
    derive: function (id, specification, peerSpki) {
      assert.deepEqual(specification, { algorithm: 'ecdh', namedCurve: 'p-256' });
      return new Uint8Array(nodeCrypto.diffieHellman({
        privateKey: keyPairs[id].privateKey,
        publicKey: nodeCrypto.createPublicKey({ key: Buffer.from(peerSpki), format: 'der', type: 'spki' }),
      }));
    },
    digest: function (algorithm, data) {
      return new Uint8Array(nodeCrypto.createHash(algorithm).update(Buffer.from(data)).digest());
    },
    exportPublicKey: function (id, format) {
      assert.equal(format, 'spki');
      return keyPairs[id].spki;
    },
    generateKey: function (specification) {
      assert.deepEqual(specification, {
        algorithm: 'ec', namedCurve: 'p-256', usages: ['derive'], persistence: 'session',
      });
      var id = 'ephemeral-' + nextId++;
      keyPairs[id] = ephemeralPairs.shift();
      return id;
    },
    hkdf: function (algorithm, key, salt, info, length) {
      return new Uint8Array(nodeCrypto.hkdfSync(algorithm, Buffer.from(key), Buffer.from(salt), Buffer.from(info), length));
    },
    random: function (length) { return new Uint8Array(nodeCrypto.randomBytes(length)); },
    sign: function (id, specification, data) {
      assert.deepEqual(specification, { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'der' });
      return new Uint8Array(nodeCrypto.sign('sha256', Buffer.from(data), keyPairs[id].privateKey));
    },
    verify: function (publicSpki, specification, data, signature) {
      assert.deepEqual(specification, { algorithm: 'ecdsa', hash: 'sha256', signatureFormat: 'raw' });
      return nodeCrypto.verify(
        'sha256', Buffer.from(data),
        nodeCrypto.createPublicKey({ key: Buffer.from(publicSpki), format: 'der', type: 'spki' }),
        Buffer.from(asn1.ecdsaRawSignatureToDer(signature))
      );
    },
  };
}

function aesCtr(key, iv, data) {
  var cipher = nodeCrypto.createDecipheriv('aes-256-ctr', Buffer.from(key), Buffer.from(iv));
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
}

test('pair-ec real primitives decrypt and authenticate through an independent Node path', function () {
  var sender = generateCompactKeyPair();
  var targetDevice = generateCompactKeyPair();
  var targetPrekey = generateCompactKeyPair();
  var ephemeral = generateCompactKeyPair();
  var provider = nodeProvider([ephemeral]);
  provider.addKey('sender-device', sender);
  var timestamp = 1770000123;
  var prekeySignatureDer = nodeCrypto.sign(
    'sha256',
    Buffer.from(ngm.prekeySignaturePayload(targetPrekey.compact, { timestamp: timestamp })),
    targetDevice.privateKey
  );
  var prekeySignature = asn1.ecdsaDerSignatureToRaw(new Uint8Array(prekeySignatureDer), 32);
  var reserveCalls = 0;
  var message = bytes.utf8ToBytes('synthetic iMessage body');

  var result = ngm.encryptPairEc({
    crypto: provider,
    sender: { deviceKeyId: 'sender-device', devicePublicKey: sender.spki },
    target: {
      deviceKey: targetDevice.compact,
      preKeyData: prekeyData(targetPrekey.compact, prekeySignature, timestamp),
    },
    message: message,
    reserveCounter: function () { reserveCalls += 1; return 43; },
  });
  var outer = ngm.decodeOuterMessage(result.payload);
  var ephemeralPublic = nodeCrypto.createPublicKey({
    key: Buffer.from(ngm.compactP256ToSpki(outer.key)), format: 'der', type: 'spki',
  });
  var secret = new Uint8Array(nodeCrypto.diffieHellman({
    privateKey: targetPrekey.privateKey, publicKey: ephemeralPublic,
  }));
  var keyMaterial = new Uint8Array(nodeCrypto.hkdfSync(
    'sha256', Buffer.from(secret), Buffer.from(ngm.MESSAGE_KEYS_SALT), Buffer.alloc(0), 48
  ));
  var signatureData = bytes.concatBytes(
    secret, targetPrekey.compact, outer.key, targetDevice.compact, outer.payload
  );
  assert.equal(nodeCrypto.verify(
    'sha256', Buffer.from(signatureData), sender.publicKey,
    Buffer.from(asn1.ecdsaRawSignatureToDer(outer.signature))
  ), true);
  assert.deepEqual(outer.validator, ngm.buildValidator(sender.compact, targetDevice.compact, targetPrekey.compact));

  var cleartext = aesCtr(keyMaterial.slice(0, 32), keyMaterial.slice(32), outer.payload);
  var paddingLength = bytes.readUint32LE(cleartext, cleartext.length - 4);
  assert.ok(paddingLength < 16);
  var inner = ngm.decodeInnerMessage(cleartext.slice(0, cleartext.length - paddingLength - 4));
  assert.deepEqual(inner.message, message);
  assert.equal(inner.counter, 42);
  assert.equal(result.counter, 42);
  assert.equal(reserveCalls, 1);
  assert.deepEqual(provider.deleted, ['ephemeral-1']);
});

test('invalid target prekey is rejected before reserving or generating', function () {
  var calls = { reserve: 0, generate: 0 };
  var crypto = katCrypto({
    generateKey: function () { calls.generate += 1; return 'unreachable'; },
    verify: function () { return false; },
  });
  assert.throws(function () {
    ngm.encryptPairEc({
      crypto: crypto,
      sender: { deviceKeyId: 'sender', devicePublicKey: GENERATOR_SPKI },
      target: { deviceKey: GENERATOR_X, preKeyData: prekeyData(GENERATOR_X, new Uint8Array(64), 1) },
      message: new Uint8Array([1]),
      reserveCounter: function () { calls.reserve += 1; return 1; },
    });
  }, /signature is invalid/);
  assert.deepEqual(calls, { reserve: 0, generate: 0 });
});

test('counter is reserved before use and burned across post-reservation failures', function () {
  var nextReservation = 0;
  var crypto = katCrypto({ derive: function () { throw new Error('synthetic derive failure'); } });
  function attempt() {
    return ngm.encryptPairEc({
      crypto: crypto,
      sender: { deviceKeyId: 'sender', devicePublicKey: GENERATOR_SPKI },
      target: { deviceKey: GENERATOR_X, preKeyData: prekeyData(GENERATOR_X, new Uint8Array(64), 1) },
      message: new Uint8Array([1]),
      reserveCounter: function () { nextReservation += 1; return nextReservation; },
    });
  }
  assert.throws(attempt, /synthetic derive failure/);
  assert.throws(attempt, /synthetic derive failure/);
  assert.equal(nextReservation, 2);
  assert.deepEqual(crypto.deleted, ['ephemeral-kat', 'ephemeral-kat']);
});

test('ephemeral generation deletes upper-half points and retries compact-compatible P-256 keys', function () {
  var upperPoint = bytes.hexToBytes(
    '04' + bytes.bytesToHex(GENERATOR_X) +
    'b01cbd1c01e58065711814b583f061e9d431cca994cea1313449bf97c840ae0a'
  );
  var upperSpki = asn1.derSubjectPublicKeyInfo({
    algorithmOid: '1.2.840.10045.2.1',
    algorithmParameters: asn1.derObjectIdentifier('1.2.840.10045.3.1.7'),
    publicKey: upperPoint,
  });
  var generated = 0;
  var crypto = katCrypto({
    generateKey: function () { generated += 1; return generated === 1 ? 'upper' : 'lower'; },
    exportPublicKey: function (keyId) { return keyId === 'upper' ? upperSpki : GENERATOR_SPKI; },
  });
  ngm.encryptPairEc({
    crypto: crypto,
    sender: { deviceKeyId: 'sender', devicePublicKey: GENERATOR_SPKI },
    target: { deviceKey: GENERATOR_X, preKeyData: prekeyData(GENERATOR_X, new Uint8Array(64), 1) },
    message: new Uint8Array([1]),
    reserveCounter: function () { return 1; },
  });
  assert.equal(generated, 2);
  assert.deepEqual(crypto.deleted, ['upper', 'lower']);
});

test('wire schemas and reserved counter enforce strict malformed-input bounds', function () {
  assert.throws(function () { ngm.decodePreKeyData(new Uint8Array([0x0a, 0x01, 0x00])); }, /missing/);
  assert.throws(function () {
    ngm.decodeOuterMessage(ngm.encodeOuterMessage({
      payload: new Uint8Array(3), key: new Uint8Array(32),
      signature: new Uint8Array(64), validator: new Uint8Array(7),
    }));
  }, /too short/);
  var crypto = katCrypto();
  assert.throws(function () {
    ngm.encryptPairEc({
      crypto: crypto,
      sender: { deviceKeyId: 'sender', devicePublicKey: GENERATOR_SPKI },
      target: { deviceKey: GENERATOR_X, preKeyData: prekeyData(GENERATOR_X, new Uint8Array(64), 1) },
      message: new Uint8Array([1]),
      reserveCounter: function () { return 0; },
    });
  }, /Reserved NGM counter/);
  assert.deepEqual(crypto.deleted, []);
});
