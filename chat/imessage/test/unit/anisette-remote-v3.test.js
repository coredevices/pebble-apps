'use strict';

var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var test = require('node:test');

var bytes = require('../../src/runtime/bytes');
var xmlPlist = require('../../src/codecs/xml-plist');
var binaryPlist = require('../../src/codecs/binary-plist');
var anisette = require('../../src/anisette/remote-v3');

var IDENTIFIER = Uint8Array.from(Array.from({ length: 16 }, function (_, index) { return index; }));
var NOW = Date.parse('2026-08-27T12:34:56.234Z');
var CLIENT = Object.freeze({
  akdUserAgent: 'akd/1.0 Test',
  mmeClientInfo: '<Test1,1> <testOS;1.0;1A1> <com.apple.akd/1.0>',
  hardwareHeaders: [['X-Apple-I-MD-RINFO-Hardware', 'prototype-token']],
});
var CRYPTO = Object.freeze({
  digest: function (algorithm, input) {
    return new Uint8Array(crypto.createHash(algorithm).update(input).digest());
  },
});

function options(state) {
  return { state: state, clientInfo: CLIENT, crypto: CRYPTO, nowMs: NOW };
}

function headerMap(headers) {
  return new Map(headers);
}

test('state metadata and Apple provisioning headers match the pinned RustPush composition', function () {
  var state = anisette.createState(IDENTIFIER);
  var metadata = anisette.deriveStateMetadata(state, CRYPTO);
  assert.deepEqual(metadata, {
    identifierBase64: 'AAECAwQFBgcICQoLDA0ODw==',
    localUserId: 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991',
    deviceId: '00010203-0405-0607-0809-0a0b0c0d0e0f',
  });

  var request = anisette.buildAppleLookupRequest(options(state));
  assert.equal(request.method, 'GET');
  assert.equal(request.url, anisette.APPLE_LOOKUP_URL);
  assert.equal(request.trustAnchors.length, 2);
  assert.ok(request.trustAnchors[0] instanceof Uint8Array);
  var headers = headerMap(request.headers);
  assert.equal(headers.get('X-Apple-I-Client-Time'), '2026-08-27T12:34:56Z');
  assert.equal(headers.get('X-Apple-I-MD-LU'), metadata.localUserId);
  assert.equal(headers.get('X-Mme-Device-Id'), metadata.deviceId);
  assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded');
  assert.equal(headers.get('X-Apple-I-MD-RINFO-Hardware'), 'prototype-token');
});

test('lookup parser accepts XML and binary plists but rejects non-HTTPS endpoints', function () {
  var value = { urls: {
    midStartProvisioning: 'https://gsa.example/start',
    midFinishProvisioning: 'https://gsa.example/finish',
  } };
  assert.deepEqual(anisette.parseLookupResponse(xmlPlist.encodeXmlPlist(value)), {
    startUrl: 'https://gsa.example/start', finishUrl: 'https://gsa.example/finish',
  });
  assert.deepEqual(anisette.parseLookupResponse(binaryPlist.encodeBinaryPlist(value)), {
    startUrl: 'https://gsa.example/start', finishUrl: 'https://gsa.example/finish',
  });
  assert.throws(function () {
    anisette.parseLookupResponse(xmlPlist.encodeXmlPlist({ urls: {
      midStartProvisioning: 'http://gsa.example/start', midFinishProvisioning: 'https://gsa.example/finish',
    } }));
  }, /start-provisioning URL/);
});

test('provisioning session drives the exact remote/Apple relay without exposing native policy', function () {
  var state = anisette.createState(IDENTIFIER);
  var session = new anisette.RemoteV3ProvisioningSession(Object.assign({
    remoteUrl: 'https://ani.example',
  }, options(state)));

  assert.equal(session.lookupRequest().url, anisette.APPLE_LOOKUP_URL);
  assert.deepEqual(session.acceptLookupResponse(xmlPlist.encodeXmlPlist({ urls: {
    midStartProvisioning: 'https://gsa.example/start',
    midFinishProvisioning: 'https://gsa.example/finish',
  } })), { type: 'websocket-connect', url: 'wss://ani.example/v3/provisioning_session' });

  assert.deepEqual(session.acceptRemoteMessage('{"result":"GiveIdentifier"}'), {
    type: 'websocket-send', text: '{"identifier":"AAECAwQFBgcICQoLDA0ODw=="}',
  });
  var start = session.acceptRemoteMessage('{"result":"GiveStartProvisioningData"}');
  assert.equal(start.type, 'http');
  assert.equal(start.request.url, 'https://gsa.example/start');
  assert.equal(start.request.trustAnchors.length, 2);
  assert.deepEqual(xmlPlist.decodeXmlPlist(start.request.body), { Header: {}, Request: {} });
  assert.deepEqual(session.acceptAppleResponse(xmlPlist.encodeXmlPlist({ Response: { spim: 'spim-value' } })), {
    type: 'websocket-send', text: '{"spim":"spim-value"}',
  });

  var finish = session.acceptRemoteMessage('{"result":"GiveEndProvisioningData","cpim":"cpim-value"}');
  assert.equal(finish.request.trustAnchors.length, 2);
  assert.deepEqual(xmlPlist.decodeXmlPlist(finish.request.body), {
    Header: {}, Request: { cpim: 'cpim-value' },
  });
  assert.deepEqual(session.acceptAppleResponse(xmlPlist.encodeXmlPlist({ Response: {
    ptm: 'ptm-value', tk: 'tk-value',
  } })), { type: 'websocket-send', text: '{"ptm":"ptm-value","tk":"tk-value"}' });

  var completed = session.acceptRemoteMessage('{"result":"ProvisioningSuccess","adi_pb":"AQIDBA=="}');
  assert.equal(completed.type, 'complete');
  assert.deepEqual(completed.state.adiPb, Uint8Array.from([1, 2, 3, 4]));
  assert.equal(completed.closeWebSocket, true);
  assert.throws(function () { session.acceptRemoteMessage('{"result":"GiveIdentifier"}'); }, /out of sequence/);
});

test('get-headers request and response keep OTP and machine data in JS', function () {
  var state = anisette.createState(IDENTIFIER, Uint8Array.from([7, 8, 9]));
  var request = anisette.buildGetHeadersRequest('https://ani.example/', state);
  assert.equal(request.url, 'https://ani.example/v3/get_headers');
  assert.deepEqual(JSON.parse(bytes.bytesToUtf8(request.body)), {
    identifier: 'AAECAwQFBgcICQoLDA0ODw==', adi_pb: 'BwgJ',
  });

  var headers = anisette.parseGetHeadersResponse(bytes.utf8ToBytes(JSON.stringify({
    result: 'Headers',
    'X-Apple-I-MD-M': 'machine',
    'X-Apple-I-MD': 'one-time-password',
    'X-Apple-I-MD-RINFO': '17106176',
  })), options(state));
  var mapped = headerMap(headers);
  assert.equal(mapped.get('X-Apple-I-MD-M'), 'machine');
  assert.equal(mapped.get('X-Apple-I-MD'), 'one-time-password');
  assert.equal(mapped.get('X-Apple-I-MD-RINFO'), '17106176');
  assert.equal(mapped.get('X-Apple-I-Client-Time'), '2026-08-27T12:34:56Z');

  assert.throws(function () {
    anisette.parseGetHeadersResponse(bytes.utf8ToBytes(JSON.stringify({
      result: 'GetHeadersError', message: 'remote code -45061',
    })), options(state));
  }, function (error) { return error.code === 'ANISETTE_NOT_PROVISIONED'; });
});

test('provisioning protocol rejects malformed JSON, base64, and concurrent Apple relays', function () {
  assert.throws(function () { anisette.parseRemoteMessage('{'); }, /not valid JSON/);
  assert.throws(function () {
    anisette.parseRemoteMessage('{"result":"ProvisioningSuccess","adi_pb":"***"}');
  }, /not valid base64/);

  var session = new anisette.RemoteV3ProvisioningSession(Object.assign({}, options(anisette.createState(IDENTIFIER))));
  session.acceptLookupResponse(xmlPlist.encodeXmlPlist({ urls: {
    midStartProvisioning: 'https://gsa.example/start',
    midFinishProvisioning: 'https://gsa.example/finish',
  } }));
  session.acceptRemoteMessage('{"result":"GiveStartProvisioningData"}');
  assert.throws(function () {
    session.acceptRemoteMessage('{"result":"GiveIdentifier"}');
  }, /out of sequence/);
  assert.throws(function () {
    session.acceptAppleResponse(xmlPlist.encodeXmlPlist({ Response: {} }));
  }, /SPIM/);
});
