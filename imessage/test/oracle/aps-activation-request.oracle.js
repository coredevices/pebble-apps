'use strict';

var assert = require('node:assert/strict');
var childProcess = require('node:child_process');
var nodeCrypto = require('node:crypto');
var path = require('node:path');
var test = require('node:test');

var activation = require('../../src/aps/activation');
var bytes = require('../../src/runtime/bytes');
var plist = require('../../src/codecs/xml-plist');

var pluginDirectory = path.resolve(__dirname, '..', '..');
var manifest = path.join(pluginDirectory, 'harness', 'rust-oracle', 'Cargo.toml');
var executable = path.join(pluginDirectory, 'harness', 'rust-oracle', 'target', 'debug', 'imessage-rust-oracle');

function runOracle(request) {
  childProcess.execFileSync(
    'cargo', ['build', '--quiet', '--locked', '--manifest-path', manifest],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  return JSON.parse(childProcess.execFileSync(executable, [], {
    encoding: 'utf8', input: JSON.stringify(request) + '\n',
  }).trim());
}

function NodeActivationCrypto() {
  this.keys = Object.create(null);
  this.nextKey = 0;
}

NodeActivationCrypto.prototype.generateKey = function () {
  var keyId = 'generated-' + String(this.nextKey++);
  this.keys[keyId] = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  return keyId;
};

NodeActivationCrypto.prototype.exportPublicKey = function (keyId, format) {
  assert.equal(format, 'spki');
  return new Uint8Array(nodeCrypto.createPublicKey(this.keys[keyId]).export({ format: 'der', type: 'spki' }));
};

NodeActivationCrypto.prototype.random = function (length) {
  assert.equal(length, 16);
  return Uint8Array.from({ length: length }, function (_, index) { return index; });
};

NodeActivationCrypto.prototype.importPrivateKey = function (type, privateKey) {
  assert.equal(type, 'RSA');
  var keyId = 'imported-' + String(this.nextKey++);
  this.keys[keyId] = nodeCrypto.createPrivateKey({
    key: Buffer.from(privateKey), format: 'der', type: 'pkcs8',
  });
  return keyId;
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
  delete this.keys[keyId];
  return true;
};

async function captureJavascriptRequest() {
  var requestSeen = null;
  await assert.rejects(activation.activatePushIdentity({
    crypto: new NodeActivationCrypto(),
    mac: {
      hardware: {
        osBuildNum: '22G513',
        productName: 'MacBookPro18,3',
        platformSerialNumber: 'SYNTHETIC-SERIAL',
      },
      version: '13.6.4',
      deviceId: '12345678-abcd-4def-8123-1234567890ab',
      icloudUa: 'com.apple.iCloudHelper/282 CFNetwork/1408.0.4',
    },
    effects: {
      clock: { now: function () { return 0; } },
      http: { request: async function (request) {
        requestSeen = request;
        throw new Error('offline capture complete');
      } },
    },
  }), function (error) { return error.code === 'APS_ACTIVATION_NETWORK_ERROR'; });
  assert.ok(requestSeen);
  return requestSeen;
}

test('JavaScript Albert form key and activation semantics match pinned RustPush', async function () {
  var javascriptRequest = await captureJavascriptRequest();
  var javascriptForm = new URLSearchParams(bytes.bytesToUtf8(javascriptRequest.body));
  var javascriptOuter = plist.decodeXmlPlist(javascriptForm.get('activation-info'));
  var javascriptInfo = plist.decodeXmlPlist(javascriptOuter.ActivationInfoXML);

  var response = runOracle({
    schema_version: 1,
    request_id: 'aps-activation-request',
    operation: 'serialize_aps_activation_request',
    activation_randomness: javascriptInfo.ActivationRandomness,
    build_version: javascriptInfo.BuildVersion,
    device_cert_request_base64: bytes.bytesToBase64(javascriptInfo.DeviceCertRequest),
    device_class: javascriptInfo.DeviceClass,
    product_type: javascriptInfo.ProductType,
    product_version: javascriptInfo.ProductVersion,
    serial_number: javascriptInfo.SerialNumber,
    unique_device_id: javascriptInfo.UniqueDeviceID,
    fair_play_cert_chain_base64: bytes.bytesToBase64(javascriptOuter.FairPlayCertChain),
    fair_play_signature_base64: bytes.bytesToBase64(javascriptOuter.FairPlaySignature),
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.rustpush_commit, 'a7fab473e7a33325a760635285db2860de8e1cb0');
  var rustForm = new URLSearchParams(bytes.bytesToUtf8(
    bytes.base64ToBytes(response.result.form_body_base64)
  ));
  assert.deepEqual(Array.from(javascriptForm.keys()), Array.from(rustForm.keys()));
  assert.deepEqual(Array.from(rustForm.keys()), ['activation-info']);

  var rustInfo = plist.decodeXmlPlist(bytes.base64ToBytes(
    response.result.activation_info_xml_base64
  ));
  assert.deepEqual(rustInfo, javascriptInfo);
});
