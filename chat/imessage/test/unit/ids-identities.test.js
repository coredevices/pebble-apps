'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var asn1 = require('../../src/codecs/asn1');
var bytes = require('../../src/runtime/bytes');
var identities = require('../../src/ids/identities');
var ngm = require('../../src/ids/ngm-pair-ec');
var publicIdentity = require('../../src/ids/public-identity');
var stateSchema = require('../../src/state/state-schema');

function NodeCrypto() {
  this.keys = Object.create(null);
  this.deleted = [];
  this.next = 0;
}
NodeCrypto.prototype.generateKey = function (specification) {
  var pair;
  if (specification.algorithm === 'rsa') {
    pair = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: specification.modulusLength });
  } else {
    pair = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  }
  var id = 'identity-' + (++this.next);
  this.keys[id] = pair;
  return id;
};
NodeCrypto.prototype.exportPublicKey = function (id, format) {
  assert.equal(format, 'spki');
  return new Uint8Array(this.keys[id].publicKey.export({ format: 'der', type: 'spki' }));
};
NodeCrypto.prototype.sign = function (id, specification, data) {
  var signature = new Uint8Array(nodeCrypto.sign(specification.hash, data, this.keys[id].privateKey));
  return specification.algorithm === 'ecdsa' && specification.signatureFormat === 'raw'
    ? asn1.ecdsaDerSignatureToRaw(signature, 32) : signature;
};
NodeCrypto.prototype.deleteKey = function (id) {
  this.deleted.push(id);
  delete this.keys[id];
  return true;
};

test('IDS identity generation creates only opaque host keys and round-trippable durable public metadata', function () {
  var crypto = new NodeCrypto();
  var lifecycle = [];
  var generated = identities.createIdentityBundle(crypto, {
    onKeyCreated: function (record) { lifecycle.push(['created', record.id, record.purpose]); },
    onKeyDeleted: function (keyId) { lifecycle.push(['deleted', keyId]); },
  });
  assert.equal(generated.keyRecords.length, 4);
  assert.deepEqual(generated.keyRecords.map(function (item) { return item.purpose; }), [
    'ids-legacy-signing', 'ids-legacy-encryption', 'ids-ngm-device', 'ids-ngm-prekey',
  ]);
  assert.equal(generated.device.compact.length, 32);
  assert.equal(generated.prekey.compact.length, 32);

  var decodedLegacy = publicIdentity.decodePublicIdentity(generated.publicIdentity);
  assert.equal(decodedLegacy.signingPublicKey.length, 65);
  var rsa = asn1.parseDer(decodedLegacy.encryptionPublicKey);
  assert.equal(rsa.tagNumber, asn1.UNIVERSAL_TAGS.SEQUENCE);
  assert.equal(rsa.children.length, 2);

  var serialized = JSON.stringify(generated.artifact);
  assert.equal(serialized.indexOf('private'), -1);
  assert.equal(serialized.indexOf('password'), -1);
  var restored = identities.restoreIdentityArtifact(JSON.parse(serialized));
  assert.deepEqual(restored.device.compact, generated.device.compact);
  assert.deepEqual(restored.prekey.compact, generated.prekey.compact);
  assert.deepEqual(restored.publicIdentity, generated.publicIdentity);
  crypto.deleted.forEach(function (id) {
    assert.equal(Object.prototype.hasOwnProperty.call(crypto.keys, id), false);
  });
  generated.keyRecords.forEach(function (record) {
    assert.equal(Object.prototype.hasOwnProperty.call(crypto.keys, record.id), true);
  });
  generated.keyRecords.forEach(function (record) {
    assert.equal(lifecycle.some(function (event) {
      return event[0] === 'created' && event[1] === record.id && event[2] === record.purpose;
    }), true);
  });
  lifecycle.filter(function (event) { return event[0] === 'deleted'; }).forEach(function (event) {
    assert.equal(generated.keyRecords.some(function (record) { return record.id === event[1]; }), false);
  });
  generated.keyRecords.forEach(function (record) {
    assert.equal(crypto.keys[record.id] !== undefined, true);
  });
  var state = stateSchema.createEmptyState();
  state.generation = 1;
  state.phase = 'configuring';
  state.artifacts.identities.primary = JSON.parse(serialized);
  state.keyInventory.active = generated.keyRecords.map(function (record) {
    return { id: record.id, purpose: record.purpose, createdGeneration: 1 };
  });
  assert.equal(stateSchema.validateCurrentState(state).artifacts.identities.primary.deviceKeyId, generated.device.keyId);
});

test('NGM prekey data signs the pinned RustPush domain and protobuf shape', function () {
  var crypto = new NodeCrypto();
  var generated = identities.createIdentityBundle(crypto);
  var encoded = identities.buildPrekeyData(crypto, generated, 1770000123);
  var decoded = ngm.decodePreKeyData(encoded);
  assert.deepEqual(decoded.key, generated.prekey.compact);
  assert.equal(decoded.timestamp, 1770000123);
  assert.equal(nodeCrypto.verify(
    'sha256',
    ngm.prekeySignaturePayload(decoded.key, decoded),
    crypto.keys[generated.device.keyId].publicKey,
    asn1.ecdsaRawSignatureToDer(decoded.signature)
  ), true);

  var kt = identities.buildKtLoggableData(generated);
  assert.deepEqual(kt, bytes.concatBytes(
    new Uint8Array([0x0a, 0x22, 0x0a, 0x20]), generated.device.compact,
    new Uint8Array([0x10, 0x0d, 0x18, 0x05])
  ));
});

test('partial identity generation is rolled back when a later host operation fails', function () {
  var crypto = new NodeCrypto();
  var lifecycle = [];
  var originalExport = crypto.exportPublicKey;
  crypto.exportPublicKey = function (id, format) {
    if (this.next === 2) throw new Error('synthetic export failure');
    return originalExport.call(this, id, format);
  };
  assert.throws(function () {
    identities.createIdentityBundle(crypto, {
      onKeyCreated: function (record) { lifecycle.push(['created', record.id]); },
      onKeyDeleted: function (keyId) { lifecycle.push(['deleted', keyId]); },
    });
  }, /synthetic export failure/);
  assert.deepEqual(Object.keys(crypto.keys), []);
  assert.deepEqual(crypto.deleted, ['identity-2', 'identity-1']);
  assert.deepEqual(lifecycle, [
    ['created', 'identity-1'], ['created', 'identity-2'],
    ['deleted', 'identity-2'], ['deleted', 'identity-1'],
  ]);
});

test('identity generation stages each persistent key before its first host export', function () {
  var crypto = new NodeCrypto();
  var staged = [];
  var originalExport = crypto.exportPublicKey;
  crypto.exportPublicKey = function (id, format) {
    assert.equal(staged.indexOf(id) !== -1, true);
    return originalExport.call(this, id, format);
  };
  identities.createIdentityBundle(crypto, {
    onKeyCreated: function (record) { staged.push(record.id); },
  });
  assert.equal(staged.length >= 4, true);
});

test('identity artifacts reject missing opaque key handles and malformed compact points', function () {
  assert.throws(function () {
    identities.restoreIdentityArtifact({ version: 1 });
  }, /unexpected fields/);
  var invalid = {
    version: 1,
    legacySigningKeyId: 'a', legacyEncryptionKeyId: 'b', deviceKeyId: 'c', preKeyId: 'd',
    legacySigningPublicKey: 'MAA=', legacyEncryptionPublicKey: 'MAA=',
    devicePublicKey: 'MAA=', preKeyPublicKey: 'MAA=', publicIdentity: 'MAA=',
  };
  assert.throws(function () { identities.restoreIdentityArtifact(invalid); }, /P-256|SPKI|public identity|DER/);
});
