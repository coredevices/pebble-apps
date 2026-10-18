'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var asn1 = require('../../src/codecs/asn1');
var gzip = require('../../src/codecs/gzip');
var plist = require('../../src/codecs/xml-plist');
var bytes = require('../../src/runtime/bytes');
var authentication = require('../../src/ids/authentication');

var CERTIFICATE = bytes.base64ToBytes('MIICCDCCAXGgAwIBAgIUdoC0so+M47owlpzzqWUCG5+jLgIwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLSURTIEZpeHR1cmUwHhcNMjYwODI3MjM0MDA1WhcNMjYwODI4MjM0MDA1WjAWMRQwEgYDVQQDDAtJRFMgRml4dHVyZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwtqyqFw3SD2/lbZoNsScKtWBMuZiUGqUtBoK+M4kw53nooozV0NleHE5vNsxwmVk9+g69rK/hMfd3H9uYGGe7kM1TlWSCXQqFOn1szfRsRkRm0uLOtcXS4HE+0Te3BW1oFw+m3Nno72GeXg1XHPnYITs33t9V0VCc+4u0ABLU4UCAwEAAaNTMFEwHQYDVR0OBBYEFFpzBW36fUrte0S2HF79zDK1VWTYMB8GA1UdIwQYMBaAFFpzBW36fUrte0S2HF79zDK1VWTYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEABm6eAv2OwCgOOVCmldQsJA13bRsLhA4N8OUXsGLTly1rUFi4miXYiH4/zpp+vBv8QOjl6gOFGNI8gY/fgqrq24pR8spW9MvD3e5rbSssLvbKaXzFjR4tmAKWyqdakY6Mtfs3JB9PI9dSzQwLraR/vOPkQHW+RpxGdOt+/2nwvMA=');

function NodeCrypto() {
  this.keys = Object.create(null);
  this.deleted = [];
  this.next = 0;
}
NodeCrypto.prototype.generateKey = function (specification) {
  assert.deepEqual(specification, {
    algorithm: 'rsa', modulusLength: 2048, usages: ['sign'], persistence: 'persistent',
  });
  var id = 'auth-' + (++this.next);
  this.keys[id] = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return id;
};
NodeCrypto.prototype.exportPublicKey = function (id) {
  return new Uint8Array(this.keys[id].publicKey.export({ format: 'der', type: 'spki' }));
};
NodeCrypto.prototype.digest = function (algorithm, data) {
  return new Uint8Array(nodeCrypto.createHash(algorithm).update(data).digest());
};
NodeCrypto.prototype.sign = function (id, specification, data) {
  assert.deepEqual(specification, { algorithm: 'rsa-pkcs1-v1_5', hash: 'sha1', signatureFormat: 'der' });
  return new Uint8Array(nodeCrypto.sign('sha1', data, this.keys[id].privateKey));
};
NodeCrypto.prototype.deleteKey = function (id) { this.deleted.push(id); delete this.keys[id]; return true; };

test('Apple IDS authentication builds the pinned CSR and credential exchange entirely in JS', async function () {
  var crypto = new NodeCrypto();
  var captured;
  var lifecycle = [];
  var result = await authentication.authenticateApple({
    crypto: crypto,
    effects: { http: { request: async function (request) {
      captured = request;
      return { status: 200, headers: [['set-cookie', 'fixture=one'], ['set-cookie', 'fixture=two']], body: plist.encodeXmlPlist({ status: 0, cert: CERTIFICATE }) };
    } } },
    endpoint: 'https://identity.example.test/authenticate',
    profileId: 'profile-fixture',
    authToken: 'ephemeral-delegate-token',
    protocolVersion: 1660,
    userAgent: '[macOS,13.6.4,22G513,iMac13,1]',
    onKeyCreated: function (record) { lifecycle.push(['created', record.id, !!captured]); },
    onKeyDeleted: function (keyId) { lifecycle.push(['deleted', keyId]); },
  });

  assert.equal(captured.method, 'POST');
  assert.equal(captured.url, 'https://identity.example.test/authenticate');
  assert.equal(captured.trustAnchors.length, 2);
  assert.ok(captured.trustAnchors[0] instanceof Uint8Array);
  assert.deepEqual(captured.headers.map(function (header) { return header[0]; }), [
    'user-agent', 'x-protocol-version', 'content-encoding',
  ]);
  var payload = plist.decodeXmlPlist(gzip.ungzip(captured.body));
  assert.equal(payload['realm-user-id'], 'profile-fixture');
  assert.equal(payload['authentication-data']['auth-token'], 'ephemeral-delegate-token');
  var csr = asn1.parseCertificationRequest(payload.csr);
  var expectedCn = nodeCrypto.createHash('sha1').update('profile-fixture').digest('hex').toUpperCase();
  assert.deepEqual(csr.subject, asn1.derName([[
    { oid: '2.5.4.3', value: expectedCn, type: 'utf8' },
  ]]));
  assert.equal(nodeCrypto.verify('sha1', csr.certificationRequestInfo, {
    key: csr.subjectPublicKeyInfo, format: 'der', type: 'spki',
  }, csr.signature), true);

  assert.deepEqual(result.certificate, CERTIFICATE);
  assert.equal(result.keyRecord.purpose, 'ids-authentication');
  assert.equal(JSON.stringify(result.artifact).indexOf('ephemeral-delegate-token'), -1);
  assert.equal(JSON.stringify(result).indexOf('authToken'), -1);
  var restored = authentication.restoreAuthenticationArtifact(JSON.parse(JSON.stringify(result.artifact)));
  assert.deepEqual(restored.certificate, CERTIFICATE);
  assert.deepEqual(crypto.deleted, []);
  assert.deepEqual(lifecycle, [['created', 'auth-1', false]]);
});

test('authentication rejects server failures and deletes the newly generated opaque key', async function () {
  var crypto = new NodeCrypto();
  var lifecycle = [];
  await assert.rejects(authentication.authenticateApple({
    crypto: crypto,
    effects: { http: { request: async function () {
      return { status: 200, headers: [], body: plist.encodeXmlPlist({ status: 6005, cert: new Uint8Array([1]) }) };
    } } },
    endpoint: 'https://identity.example.test/authenticate', profileId: 'profile-fixture',
    authToken: 'ephemeral-token', protocolVersion: 1660, userAgent: '[fixture]',
    onKeyCreated: function (record) { lifecycle.push(['created', record.id]); },
    onKeyDeleted: function (keyId) { lifecycle.push(['deleted', keyId]); },
  }), function (error) {
    return error.code === 'IDS_AUTHENTICATION_FAILED' && error.details.serverCode === 6005;
  });
  assert.deepEqual(crypto.deleted, ['auth-1']);
  assert.deepEqual(Object.keys(crypto.keys), []);
  assert.deepEqual(lifecycle, [['created', 'auth-1'], ['deleted', 'auth-1']]);
});

test('authentication stages its persistent key before CSR work and cleans it if staging fails', async function () {
  var crypto = new NodeCrypto();
  var deleted = [];
  await assert.rejects(authentication.authenticateApple({
    crypto: crypto,
    effects: { http: { request: async function () { throw new Error('HTTP must not start'); } } },
    endpoint: 'https://identity.example.test/authenticate', profileId: 'profile-fixture',
    authToken: 'ephemeral-token', protocolVersion: 1660, userAgent: '[fixture]',
    onKeyCreated: function () { throw new Error('simulated crash during durable staging'); },
    onKeyDeleted: function (keyId) { deleted.push(keyId); },
  }), /simulated crash during durable staging/);
  assert.deepEqual(crypto.deleted, ['auth-1']);
  assert.deepEqual(deleted, ['auth-1']);
});

test('authentication response parser requires a successful status and a real DER certificate', function () {
  assert.throws(function () {
    authentication.parseAuthenticationResponse(plist.encodeXmlPlist({ status: 0, cert: new Uint8Array([0x30, 0]) }));
  }, function (error) { return error.code === 'IDS_PROTOCOL_ERROR'; });
  assert.throws(function () {
    authentication.restoreAuthenticationArtifact({ version: 1, userType: 'phone' });
  }, /unsupported/);
});
