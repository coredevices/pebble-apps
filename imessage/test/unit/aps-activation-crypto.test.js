'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

var asn1 = require('../../src/codecs/asn1');
var bytes = require('../../src/runtime/bytes');
var ApsProvisioner = require('../../src/configuration/coordinator').ApsProvisioner;

var CERTIFICATE = bytes.base64ToBytes('MIICBjCCAW+gAwIBAgIUYEk6LivhRTYlDaf7vNb6TMOEyYgwDQYJKoZIhvcNAQELBQAwFTETMBEGA1UEAwwKQ29kZWMgVGVzdDAeFw0yNjA4MjcyMzA4NDZaFw0yNjA5MjYyMzA4NDZaMBUxEzARBgNVBAMMCkNvZGVjIFRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAMzAvXkenoPYXDVmKBEdUWF/8ExF6SI3X0fUcQP8eIn7HgBOaUJiiS17XiQqteBoBiso+WjjMIxr8w3PmTejnNpeEQFZYchvo8ypeyUp8+JO1kGcJKCmKm3OOw0G+igdxqQvCozdmHELrmvnYKYNrJsjgeFIGaYwvowzlTyVapoTAgMBAAGjUzBRMB0GA1UdDgQWBBST/uscbZjU13mtuT4BkuxY6ZzqTzAfBgNVHSMEGDAWgBST/uscbZjU13mtuT4BkuxY6ZzqTzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4GBAGN8XOZGEeEFpWqPA026kuLBDNeDtocLSD/xuGdba8C6rBilw2I1V9oDRY5nKCdXGNW/PKqeAs6ceY3vdsUzNwvhODNkojAtm6cfG1kPHHFVbnJn3eBXAp3IjkOee3PVO4q6jXn7hlsX4JeuUM45GDXfcjskn5WYbhSnQX1kUNHn');
var VALID_NOW = Date.parse('2026-08-28T12:00:00Z');

function ImportCrypto() {
  this.imports = [];
  this.deleted = [];
  this.failure = null;
}
ImportCrypto.prototype.importPrivateKey = function (type, privateKey, publicKey, options) {
  this.imports.push({
    type: type,
    privateKey: new Uint8Array(privateKey),
    publicKey: new Uint8Array(publicKey),
    options: options,
  });
  if (this.failure) throw this.failure;
  return 'opaque-push-key';
};
ImportCrypto.prototype.deleteKey = function (keyId) {
  this.deleted.push(keyId);
  return true;
};

function bootstrap(overrides) {
  return Object.assign({
    certificateDer: new Uint8Array(CERTIFICATE),
    privateKeyPkcs8: new Uint8Array([0x30, 0x04, 1, 2, 3, 4]),
    token: new Uint8Array(32).fill(0x5a),
  }, overrides || {});
}

function provisioner(crypto, now, lifecycle) {
  return new ApsProvisioner({
    effects: { clock: { now: function () { return now; } } },
    crypto: crypto,
    keyLifecycle: lifecycle,
  });
}

test('APS bootstrap imports PKCS#8 with certificate SPKI and returns a durable opaque artifact', async function () {
  var crypto = new ImportCrypto();
  var lifecycle = [];
  var source = bootstrap();
  var expectedPrivateKey = new Uint8Array(source.privateKeyPkcs8);
  var expectedToken = new Uint8Array(source.token);
  var result = await provisioner(crypto, VALID_NOW, {
    stage: function (record) { lifecycle.push(['staged', record.id, crypto.imports.length]); },
    completeCleanup: function (keyId) { lifecycle.push(['cleaned', keyId]); },
  }).ensureProvisioned(null, { pushBootstrap: source });

  assert.equal(crypto.imports.length, 1);
  assert.equal(crypto.imports[0].type, 'RSA');
  assert.deepEqual(crypto.imports[0].options, { persistence: 'persistent' });
  assert.deepEqual(crypto.imports[0].privateKey, expectedPrivateKey);
  assert.deepEqual(
    crypto.imports[0].publicKey,
    asn1.parseCertificate(CERTIFICATE).subjectPublicKeyInfo
  );
  assert.equal(result.keyId, 'opaque-push-key');
  assert.deepEqual(result.keyRecord, { id: 'opaque-push-key', purpose: 'aps-signing' });
  assert.deepEqual(result.certificate, CERTIFICATE);
  assert.deepEqual(result.token, expectedToken);
  assert.equal(result.artifact.keyId, 'opaque-push-key');
  assert.deepEqual(source.privateKeyPkcs8, new Uint8Array(expectedPrivateKey.length));
  assert.deepEqual(crypto.deleted, []);
  assert.deepEqual(lifecycle, [['staged', 'opaque-push-key', 1]]);
});

test('legacy APS bootstrap deletes and acknowledges an import whose durable staging fails', async function () {
  var crypto = new ImportCrypto();
  var cleaned = [];
  await assert.rejects(provisioner(crypto, VALID_NOW, {
    stage: function () { throw new Error('simulated staging crash'); },
    completeCleanup: function (keyId) { cleaned.push(keyId); },
  }).ensureProvisioned(null, { pushBootstrap: bootstrap() }), /simulated staging crash/);
  assert.deepEqual(crypto.deleted, ['opaque-push-key']);
  assert.deepEqual(cleaned, ['opaque-push-key']);
});

test('legacy APS bootstrap validates token and certificate time before key import', async function () {
  var crypto = new ImportCrypto();
  await assert.rejects(provisioner(crypto, VALID_NOW).ensureProvisioned(null, null), function (error) {
    return error.code === 'INVALID_CONFIGURATION' && error.kind === 'invalid-input';
  });

  var malformedToken = bootstrap({ token: new Uint8Array(31) });
  await assert.rejects(provisioner(crypto, VALID_NOW).ensureProvisioned(null, { pushBootstrap: malformedToken }), function (error) {
    return error.code === 'APS_BOOTSTRAP_INVALID';
  });
  assert.deepEqual(malformedToken.privateKeyPkcs8, new Uint8Array(6));

  var future = bootstrap();
  await assert.rejects(
    provisioner(crypto, Date.parse('2026-08-27T23:00:00Z')).ensureProvisioned(null, { pushBootstrap: future }),
    function (error) { return error.code === 'APS_BOOTSTRAP_NOT_YET_VALID'; }
  );
  assert.deepEqual(future.privateKeyPkcs8, new Uint8Array(6));

  var expired = bootstrap();
  await assert.rejects(
    provisioner(crypto, Date.parse('2026-09-27T00:00:00Z')).ensureProvisioned(null, { pushBootstrap: expired }),
    function (error) { return error.code === 'APS_BOOTSTRAP_EXPIRED'; }
  );
  assert.deepEqual(expired.privateKeyPkcs8, new Uint8Array(6));
  assert.equal(crypto.imports.length, 0);
});

test('APS bootstrap import failures are sanitized and always dispose source private bytes', async function () {
  var crypto = new ImportCrypto();
  crypto.failure = new Error('private fixture details');
  var source = bootstrap();
  await assert.rejects(provisioner(crypto, VALID_NOW).ensureProvisioned(null, { pushBootstrap: source }), function (error) {
    return error.code === 'APS_BOOTSTRAP_INVALID'
      && error.message === 'APS bootstrap private key could not be imported.'
      && JSON.stringify(error).indexOf('private fixture details') === -1;
  });
  assert.deepEqual(source.privateKeyPkcs8, new Uint8Array(6));
});
