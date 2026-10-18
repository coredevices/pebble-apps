'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var activation = require('../../src/aps/activation');
var asn1 = require('../../src/codecs/asn1');
var plist = require('../../src/codecs/xml-plist');
var bytes = require('../../src/runtime/bytes');

var HOST_PRIVATE_PKCS8 = bytes.base64ToBytes('MIICdwIBADANBgkqhkiG9w0BAQEFAASCAmEwggJdAgEAAoGBAMTM6MNYQx0zPpkTe4o7F1tE+aiOPUje+jPHUu3ZHRBH5uNjghpzamkTrLQESd6I9X9FIaliN15gX6wwVF6FarJezgAXOPXMWU+VItAqQjp1iXRzvunl/FkA00bFvA+EkejGzUr1nqANsa+m7OWEnxUdIgGByF+hSegS/HjWQSWzAgMBAAECgYBx0xZZTaZbsDTncoZEmBLVPhqr68D0ccsCwalsWePec8fOAtLQG6sTJUcBQ226ITrkpoZmoqDlnBYZ0EYr+TyQ9GlJvN8EK4F9MnV8EohY8Ynym7UXnujw4XyEvgvtdJ05BRzg1gKDuqaJ/RGy31cHijjwdGRdVMHLYwnjAH2fSQJBAOP8XM6d461MJWzRJjl6hwA8bfPb+RoScWEY3966k+JvlT9pIHlFOtIhN59Lg6BhF63KWMR144ZiBrETQ/yE0a8CQQDc+5BfQmhXtDhY8PQhTz0DGlS3f6pVu7J7lFmUiBFcG1vhhvYlJkPGCno1B/Od0KCw6T6hJ1SRZikda2lIroE9AkEA1s4L01DIF5vLFz/oN/fOAtbs8fqsNXhzAv0g0QYSGCLyCBDQ2/HyfdF2SswndJCGcuRXxqMcgJ0TmPuB7wZlWQJBAMnx7z7OnjJAFRpaoI9sLVKPlonW1l/g1rwOl0qgilTE/9N7FahfbqIl4wZhjOVUyfTCQqTdH3B8jug+x4lPR/UCQBTqwkDuxJjnmIunpwyIDgmdDrpFTGMojr/pP7iqiRlkidNTLzHC8o/zzzAChBs07v84pxJZUIYEBdlAL5ETq+s=');
var HOST_CERTIFICATE = bytes.base64ToBytes('MIICJDCCAY2gAwIBAgIUXtJ5kFKg1Edd4DbxDWmQpLSvnzowDQYJKoZIhvcNAQELBQAwJDEiMCAGA1UEAwwZQ29kZXggQVBTIEFjdGl2YXRpb24gVGVzdDAeFw0yNjA4MjgwNjE3MTZaFw0zNjA4MjUwNjE3MTZaMCQxIjAgBgNVBAMMGUNvZGV4IEFQUyBBY3RpdmF0aW9uIFRlc3QwgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGBAMTM6MNYQx0zPpkTe4o7F1tE+aiOPUje+jPHUu3ZHRBH5uNjghpzamkTrLQESd6I9X9FIaliN15gX6wwVF6FarJezgAXOPXMWU+VItAqQjp1iXRzvunl/FkA00bFvA+EkejGzUr1nqANsa+m7OWEnxUdIgGByF+hSegS/HjWQSWzAgMBAAGjUzBRMB0GA1UdDgQWBBSLfgyDfyftBNATR2eCS2MdkA0f0zAfBgNVHSMEGDAWgBSLfgyDfyftBNATR2eCS2MdkA0f0zAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4GBAFXUaQfiag0EzQrm3FbR05p4xo9bZ+MJkqlEx6AnCnpSlwxpTWpXJTSEqlQm+0WLSGhAFHmwcOYtotv6lHqHtQiEEChFCWh6pD5tJXwmBQWXzG7+CyOfgJRT7jjTI78zzN1DkZihAuTh68IlKi+Ks+pF6yk9V3d7xmVYzEQadkgR');
var HOST_PARSED = asn1.parseCertificate(HOST_CERTIFICATE);
var VALID_NOW = Math.floor((HOST_PARSED.notBefore.epochMilliseconds + HOST_PARSED.notAfter.epochMilliseconds) / 2);

function firstDerElement(value) {
  var count = value[1] & 0x7f;
  var header = value[1] < 0x80 ? 2 : 2 + count;
  var length = value[1] < 0x80 ? value[1] : 0;
  for (var index = 0; value[1] >= 0x80 && index < count; index += 1) length = length * 256 + value[2 + index];
  return value.slice(0, header + length);
}

function NodeActivationCrypto() {
  this.hostPrivate = nodeCrypto.createPrivateKey({ key: Buffer.from(HOST_PRIVATE_PKCS8), format: 'der', type: 'pkcs8' });
  this.hostPublic = nodeCrypto.createPublicKey(this.hostPrivate);
  this.keys = Object.create(null);
  this.generated = [];
  this.imported = [];
  this.deleted = [];
}
NodeActivationCrypto.prototype.generateKey = function (specification) {
  this.generated.push(specification);
  this.keys['persistent-aps-key'] = this.hostPrivate;
  return 'persistent-aps-key';
};
NodeActivationCrypto.prototype.exportPublicKey = function (keyId, format) {
  assert.equal(format, 'spki');
  return new Uint8Array(nodeCrypto.createPublicKey(this.keys[keyId]).export({ format: 'der', type: 'spki' }));
};
NodeActivationCrypto.prototype.random = function (length) {
  assert.equal(length, 16);
  return Uint8Array.from({ length: 16 }, function (_, index) { return index; });
};
NodeActivationCrypto.prototype.importPrivateKey = function (type, privateKey, publicKey, options) {
  assert.equal(type, 'RSA');
  this.imported.push({ privateKey: privateKey, publicKey: new Uint8Array(publicKey), options: options });
  this.keys['session-fairplay-key'] = nodeCrypto.createPrivateKey({
    key: Buffer.from(privateKey), format: 'der', type: 'pkcs8',
  });
  return 'session-fairplay-key';
};
NodeActivationCrypto.prototype.sign = function (keyId, specification, data) {
  assert.equal(specification.algorithm, 'rsa-pkcs1-v1_5');
  return new Uint8Array(nodeCrypto.sign(specification.hash, Buffer.from(data), this.keys[keyId]));
};
NodeActivationCrypto.prototype.verify = function (publicKey, specification, data, signature) {
  assert.equal(specification.algorithm, 'rsa-pkcs1-v1_5');
  return nodeCrypto.verify(
    specification.hash,
    Buffer.from(data),
    { key: Buffer.from(publicKey), format: 'der', type: 'spki' },
    Buffer.from(signature)
  );
};
NodeActivationCrypto.prototype.deleteKey = function (keyId) {
  this.deleted.push(keyId);
  delete this.keys[keyId];
  return true;
};

function macConfiguration() {
  return Object.freeze({
    hardware: Object.freeze({
      osBuildNum: '22G513',
      productName: 'MacBookPro18,3',
      platformSerialNumber: 'SYNTHETIC-SERIAL',
    }),
    version: '13.6.4',
    deviceId: '12345678-abcd-4def-8123-1234567890ab',
    icloudUa: 'com.apple.iCloudHelper/282 CFNetwork/1408.0.4 Darwin/22.5.0',
  });
}

function albertResponse(certificate) {
  var protocol = plist.encodeXmlPlist({
    'device-activation': {
      'activation-record': {
        DeviceCertificate: bytes.utf8ToBytes(asn1.derToPem('CERTIFICATE', certificate)),
      },
    },
  });
  return bytes.utf8ToBytes('<activation-response><Protocol>' + bytes.bytesToUtf8(protocol)
    + '</Protocol></activation-response>');
}

function fixture(options) {
  options = options || {};
  var crypto = new NodeActivationCrypto();
  var requestSeen = null;
  var effects = {
    clock: { now: function () { return options.now === undefined ? VALID_NOW : options.now; } },
    http: {
      request: async function (request) {
        requestSeen = request;
        if (options.onRequest) options.onRequest(request);
        if (options.httpError) throw options.httpError;
        if (options.status) return { status: options.status, headers: [], body: new Uint8Array(0) };
        return {
          status: 200,
          headers: [],
          body: options.body || albertResponse(options.certificate || HOST_CERTIFICATE),
        };
      },
    },
  };
  if (options.trace) effects.trace = options.trace;
  return { crypto: crypto, effects: effects, request: function () { return requestSeen; } };
}

function inspectAlbertRequest(request, hostPublicKey) {
  assert.equal(request.method, 'POST');
  assert.equal(request.url, activation.ALBERT_URL);
  assert.deepEqual(request.headers, [
    ['user-agent', 'ApplePushService/4.0 com.apple.iCloudHelper/282'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ]);
  var form = new URLSearchParams(bytes.bytesToUtf8(request.body));
  assert.deepEqual(Array.from(form.keys()), ['activation-info']);
  var outer = plist.decodeXmlPlist(form.get('activation-info'));
  assert.equal(outer.ActivationInfoComplete, true);
  assert.ok(outer.FairPlayCertChain instanceof Uint8Array);
  assert.ok(outer.FairPlaySignature instanceof Uint8Array);
  assert.equal(
    nodeCrypto.verify(
      'sha1',
      Buffer.from(outer.ActivationInfoXML),
      new nodeCrypto.X509Certificate(Buffer.from(firstDerElement(outer.FairPlayCertChain))).publicKey,
      Buffer.from(outer.FairPlaySignature)
    ),
    true
  );

  var info = plist.decodeXmlPlist(outer.ActivationInfoXML);
  assert.deepEqual(Object.assign({}, info, { DeviceCertRequest: undefined }), {
    ActivationRandomness: '00010203-0405-4607-8809-0A0B0C0D0E0F',
    ActivationState: 'Unactivated',
    BuildVersion: '22G513',
    DeviceCertRequest: undefined,
    DeviceClass: 'MacOS',
    ProductType: 'MacBookPro18,3',
    ProductVersion: '13.6.4',
    SerialNumber: 'SYNTHETIC-SERIAL',
    UniqueDeviceID: '12345678-ABCD-4DEF-8123-1234567890AB',
  });
  var csrPem = bytes.bytesToUtf8(info.DeviceCertRequest);
  var csr = asn1.parseCertificationRequest(asn1.pemToDer(csrPem, 'CERTIFICATE REQUEST').der);
  assert.deepEqual(csr.subject, asn1.derName([[
    { oid: '2.5.4.3', value: 'Client Push Certificate', type: 'utf8' },
  ]]));
  assert.deepEqual(csr.subjectPublicKeyInfo, hostPublicKey);
  assert.equal(csr.signatureAlgorithm.oid, '1.2.840.113549.1.1.5');
  assert.equal(nodeCrypto.verify(
    'sha1', Buffer.from(csr.certificationRequestInfo),
    { key: Buffer.from(hostPublicKey), format: 'der', type: 'spki' }, Buffer.from(csr.signature)
  ), true);
}

test('pure JS APS activation creates the RustPush request and returns a verified durable identity', async function () {
  var value = fixture();
  var result = await activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  });

  assert.deepEqual(value.crypto.generated, [{
    algorithm: 'rsa', modulusLength: 1024, usages: ['sign'], persistence: 'persistent',
  }]);
  assert.equal(value.crypto.imported.length, 1);
  assert.deepEqual(value.crypto.imported[0].options, { persistence: 'session' });
  assert.deepEqual(value.crypto.imported[0].privateKey,
    new Uint8Array(value.crypto.imported[0].privateKey.length));
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key']);
  assert.equal(result.keyId, 'persistent-aps-key');
  assert.deepEqual(result.certificate, HOST_CERTIFICATE);
  assert.deepEqual(result.keyRecord, { id: 'persistent-aps-key', purpose: 'aps-signing' });
  inspectAlbertRequest(value.request(), asn1.parseCertificate(HOST_CERTIFICATE).subjectPublicKeyInfo);
});

test('APS activation publishes its opaque persistent key before the first network await', async function () {
  var staged = false;
  var value = fixture({
    onRequest: function () { assert.equal(staged, true); },
  });
  var result = await activation.activatePushIdentity({
    effects: value.effects,
    crypto: value.crypto,
    mac: macConfiguration(),
    onKeyCreated: function (record) {
      assert.equal(value.request(), null);
      assert.deepEqual(record, { id: 'persistent-aps-key', purpose: 'aps-signing' });
      staged = true;
    },
  });

  assert.equal(staged, true);
  assert.equal(result.keyId, 'persistent-aps-key');
});

test('APS activation treats diagnostic trace failures as non-fatal across the key lifecycle', async function () {
  var value = fixture({
    trace: { emit: function () { throw new Error('synthetic trace failure'); } },
  });
  var result = await activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  });

  assert.equal(result.keyId, 'persistent-aps-key');
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key']);
});

test('APS activation deletes both transient and persistent keys when Albert transport fails', async function () {
  var value = fixture({ httpError: new Error('sensitive network detail') });
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  }), function (error) {
    return error.code === 'APS_ACTIVATION_NETWORK_ERROR'
      && error.message === 'APS activation request failed.'
      && JSON.stringify(error).indexOf('sensitive network detail') === -1;
  });
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key', 'persistent-aps-key']);
});

test('APS activation rejects a returned certificate outside its validity window and cleans up the host key', async function () {
  var value = fixture({ now: HOST_PARSED.notBefore.epochMilliseconds - 1 });
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  }), function (error) {
    return error.code === 'APS_ACTIVATION_RESPONSE_INVALID'
      && error.message === 'APS activation certificate is outside its validity period.';
  });
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key', 'persistent-aps-key']);
});

test('APS activation rejects a certificate for a different generated host key', async function () {
  var value = fixture();
  value.crypto.hostPrivate = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  value.crypto.hostPublic = nodeCrypto.createPublicKey(value.crypto.hostPrivate);
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  }), function (error) {
    return error.code === 'APS_ACTIVATION_RESPONSE_INVALID'
      && error.message === 'APS activation certificate does not match the generated host key.';
  });
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key', 'persistent-aps-key']);
});

test('APS activation classifies Albert rejection without including response data', async function () {
  var value = fixture({ status: 503 });
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  }), function (error) {
    return error.code === 'APS_ACTIVATION_REJECTED' && error.retryable === true
      && error.details.httpStatus === 503;
  });
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key', 'persistent-aps-key']);
});

test('APS activation marks deterministic Albert rejection as non-retryable', async function () {
  var value = fixture({ status: 403 });
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: macConfiguration(),
  }), function (error) {
    return error.code === 'APS_ACTIVATION_REJECTED' && error.retryable === false
      && error.details.httpStatus === 403;
  });
  assert.deepEqual(value.crypto.deleted, ['session-fairplay-key', 'persistent-aps-key']);
});

test('APS activation rejects malformed input before allocating any key', async function () {
  var value = fixture();
  await assert.rejects(activation.activatePushIdentity({
    effects: value.effects, crypto: value.crypto, mac: { hardware: {} },
  }), function (error) { return error.code === 'APS_ACTIVATION_INVALID_INPUT'; });
  assert.deepEqual(value.crypto.generated, []);
  assert.deepEqual(value.crypto.deleted, []);
});
