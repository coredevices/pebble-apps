'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var bytes = require('../../src/runtime/bytes');
var plist = require('../../src/codecs/xml-plist');
var binaryPlist = require('../../src/codecs/binary-plist');
var gzipCodec = require('../../src/codecs/gzip');
var login = require('../../src/apple-account/login');
var twoFactor = require('../../src/apple-account/two-factor');
var delegates = require('../../src/apple-account/delegates');

function clientInfo() {
  return {
    akContextType: 'messages-fixture',
    clientAppName: 'Fixture Messages',
    clientBundleId: 'test.fixture.messages',
    mmeClientInfo: '<Fixture> <TestOS;1.0;A1> <fixture/account>',
    mmeClientInfoAkd: '<Fixture> <TestOS;1.0;A1> <fixture/authkit>',
    akdUserAgent: 'fixture-authkit/1.0',
    browserUserAgent: 'fixture-browser/1.0',
    hardwareHeaders: [['X-Apple-I-SRL-NO', 'SERIAL-FIXTURE']],
    pushToken: 'push-token-fixture',
  };
}

function anisetteHeaders() {
  return [
    ['X-Apple-I-MD-LU', 'lookup-fixture'],
    ['X-Apple-I-MD-RINFO', '17106176'],
    ['X-Apple-I-MD-M', 'machine-fixture'],
    ['X-Apple-I-MD', 'otp-fixture'],
    ['X-Mme-Device-Id', 'device-fixture'],
    ['X-Apple-I-Client-Time', '2026-08-27T12:00:00Z'],
    ['X-Apple-I-TimeZone', 'UTC'],
    ['Ignored-Anisette-Header', 'not-forwarded-to-gsa'],
  ];
}

function header(headers, name) {
  var match = headers.filter(function (entry) { return entry[0].toLowerCase() === name.toLowerCase(); });
  return match.length === 0 ? null : match[match.length - 1][1];
}

function tokenHeader(value) {
  return bytes.bytesToBase64(bytes.utf8ToBytes(value));
}

function expectCode(callback, code) {
  assert.throws(callback, function (error) { return error && error.code === code; });
}

test('GSA init and complete builders keep the pinned request fields in JavaScript', function () {
  var common = {
    baseHeaders: anisetteHeaders(),
    clientInfo: clientInfo(),
    requestId: '00112233-4455-4677-8899-AABBCCDDEEFF',
    username: 'fixture@example.invalid',
  };
  var init = login.buildGsaInitRequest(Object.assign({}, common, {
    publicEphemeral: new Uint8Array([1, 2, 3]),
  }));
  assert.equal(init.method, 'POST');
  assert.equal(init.url, login.GSA_ENDPOINT);
  assert.equal(init.trustAnchors.length, 2);
  assert.ok(init.trustAnchors[0] instanceof Uint8Array);
  assert.equal(header(init.headers, 'Content-Type'), 'text/x-xml-plist');
  assert.equal(header(init.headers, 'Ignored-Anisette-Header'), null);
  var initBody = plist.decodeXmlPlist(init.body);
  assert.deepEqual(initBody.Header, { Version: '1.0.1' });
  assert.deepEqual(initBody.Request.A2k, new Uint8Array([1, 2, 3]));
  assert.deepEqual(initBody.Request.ps, ['s2k', 's2k_fo']);
  assert.equal(initBody.Request.o, 'init');
  assert.equal(initBody.Request.u, common.username);
  assert.equal(initBody.Request.cpd['X-Apple-I-Request-UUID'], common.requestId);
  assert.equal(initBody.Request.cpd['X-Apple-I-Client-Time'], '2026-08-27T12:00:00Z');
  assert.equal(initBody.Request.cpd['X-Apple-I-SRL-NO'], 'SERIAL-FIXTURE');
  assert.equal(initBody.Request.cpd.ptkn, 'push-token-fixture');

  var proof = new Uint8Array(32).fill(7);
  var complete = login.buildGsaCompleteRequest(Object.assign({}, common, {
    proof: proof,
    challenge: 'challenge-fixture',
  }));
  var completeBody = plist.decodeXmlPlist(complete.body);
  assert.deepEqual(completeBody.Request.M1, proof);
  assert.equal(completeBody.Request.c, 'challenge-fixture');
  assert.equal(completeBody.Request.o, 'complete');
  assert.deepEqual(completeBody.Request.cpd, initBody.Request.cpd);
});

test('GSA response parsers enforce status, selected protocol, and byte bounds', function () {
  var init = login.parseGsaInitResponse(plist.encodeXmlPlist({
    Response: {
      Status: { ec: 0 },
      s: new Uint8Array([1]),
      B: new Uint8Array([2]),
      i: 2048,
      c: 'challenge',
      sp: 's2k_fo',
    },
  }));
  assert.equal(init.protocol, 's2k_fo');
  assert.equal(init.iterations, 2048);

  assert.throws(function () {
    login.parseGsaInitResponse(
      plist.encodeXmlPlist({ Response: { Status: { ec: -22406, em: 'Incorrect password.' } } }),
      { stage: 'init', cookieCount: 2 }
    );
  }, function (error) {
    return error && error.code === 'APPLE_AUTH_ERROR'
      && error.details.serverCode === -22406
      && error.details.serverMessageKind === 'credentials'
      && error.details.stage === 'init'
      && error.details.cookieCount === 2
      && JSON.stringify(error).indexOf('Incorrect password') === -1;
  });
  expectCode(function () {
    login.parseGsaInitResponse(plist.encodeXmlPlist({
      Response: { Status: { ec: 0 }, s: new Uint8Array([1]), B: new Uint8Array([2]), i: 1, c: 'c', sp: 'unknown' },
    }));
  }, 'APPLE_ACCOUNT_PROTOCOL_ERROR');

  var complete = login.parseGsaCompleteResponse(plist.encodeXmlPlist({
    Response: {
      Status: { ec: 0, au: 'secondaryAuth' },
      M2: new Uint8Array(32),
      spd: new Uint8Array([1]),
    },
  }));
  assert.equal(complete.authenticationState, 'secondaryAuth');
});

test('two-factor builders distinguish trusted-device and SMS request shapes', function () {
  var options = {
    baseHeaders: anisetteHeaders(),
    clientInfo: clientInfo(),
    spd: { adsid: 'adsid-fixture', GsIdmsToken: 'identity-fixture' },
    phoneId: 7,
  };
  var trusted = twoFactor.buildTrustedDeviceCodeRequest(options);
  assert.equal(trusted.method, 'GET');
  assert.equal(trusted.url, twoFactor.TRUSTED_DEVICE_CODE_ENDPOINT);
  assert.equal(trusted.trustAnchors.length, 2);
  assert.equal(header(trusted.headers, 'Accept'), 'text/x-xml-plist');
  assert.equal(
    bytes.bytesToUtf8(bytes.base64ToBytes(header(trusted.headers, 'X-Apple-Identity-Token'))),
    'adsid-fixture:identity-fixture'
  );
  assert.deepEqual(
    plist.decodeXmlPlist(bytes.base64ToBytes(header(trusted.headers, 'X-Apple-I-CFU-State'))),
    []
  );

  var sms = twoFactor.buildSmsCodeRequest(options);
  assert.equal(sms.method, 'PUT');
  assert.equal(sms.url, twoFactor.SMS_CODE_ENDPOINT);
  assert.equal(sms.trustAnchors.length, 2);
  assert.deepEqual(JSON.parse(bytes.bytesToUtf8(sms.body)), {
    phoneNumber: { id: 7 },
    mode: 'sms',
  });

  var verify = twoFactor.buildSmsVerifyRequest(Object.assign({}, options, { code: '123456' }));
  assert.equal(verify.url, twoFactor.SMS_VERIFY_ENDPOINT);
  assert.deepEqual(JSON.parse(bytes.bytesToUtf8(verify.body)).securityCode, { code: '123456' });
  expectCode(function () {
    twoFactor.buildTrustedDeviceVerifyRequest(Object.assign({}, options, { code: '12345' }));
  }, 'INVALID_TWO_FACTOR_CODE');
});

test('ordered duplicate token headers are all parsed and the last service value wins', function () {
  var now = Date.UTC(2026, 7, 27);
  var absoluteExpiry = now + 900000;
  var parsed = twoFactor.parseTokenHeaders([
    ['X-Apple-GS-Token', tokenHeader('service.one:first:60')],
    ['X-Apple-HB-Token', tokenHeader('service.two:second:120')],
    ['X-Apple-GS-Token', tokenHeader('service.one:replacement:180')],
    ['X-Apple-PE-Token', tokenHeader('ignored-service:pet-fixture:300')],
    ['X-Apple-HB-Token', tokenHeader('service.epoch:absolute:' + absoluteExpiry)],
  ], { nowMs: now, sms: false });

  assert.deepEqual(parsed.ordered.map(function (token) { return token.service; }), [
    'service.one', 'service.two', 'service.one', twoFactor.PET_SERVICE, 'service.epoch',
  ]);
  assert.equal(parsed.tokens.get('service.one').token, 'replacement');
  assert.equal(parsed.tokens.get('service.one').expiresAtMs, now + 180000);
  assert.equal(parsed.tokens.get('service.epoch').expiresAtMs, absoluteExpiry);
  assert.equal(parsed.tokens.get(twoFactor.PET_SERVICE).token, 'pet-fixture');

  expectCode(function () {
    twoFactor.parseTokenHeaders({ 'X-Apple-GS-Token': 'flattened' }, { nowMs: now });
  }, 'APPLE_ACCOUNT_PROTOCOL_ERROR');
  expectCode(function () {
    twoFactor.parseTokenHeaders([['X-Apple-GS-Token', '%%%']], { nowMs: now });
  }, 'APPLE_ACCOUNT_PROTOCOL_ERROR');
});

test('SMS token headers prefer the absolute fourth field used by the pinned flow', function () {
  var now = Date.UTC(2026, 7, 27);
  var expiry = now + 123456;
  var parsed = twoFactor.parseTokenHeaders([
    ['X-Apple-GS-Token', tokenHeader('service.sms:value:60:' + expiry)],
  ], { nowMs: now, sms: true });
  assert.equal(parsed.tokens.get('service.sms').expiresAtMs, expiry);
});

test('delegate request and response preserve the setup-v2 IDS schema', function () {
  var request = delegates.buildDelegateRequest({
    username: 'fixture@example.invalid',
    pet: 'pet-fixture',
    adsid: 'adsid-fixture',
    baseHeaders: anisetteHeaders().concat([['x-mme-client-info', '<Fixture> <anisette>']]),
    validationData: new Uint8Array([1, 2, 3]),
    userAgent: 'delegate-fixture/1.0',
    mmeClientInfo: '<Fixture> <delegate>',
    clientIdRandom: bytes.hexToBytes('00112233445566778899aabbccddeeff'),
  });
  assert.equal(request.url, delegates.DELEGATE_ENDPOINT);
  assert.equal(request.maxResponseBytes, 4 * 1024 * 1024);
  assert.equal(request.clientId, '00112233-4455-4677-8899-AABBCCDDEEFF');
  assert.equal(
    bytes.bytesToUtf8(bytes.base64ToBytes(header(request.headers, 'Authorization').slice(6))),
    'fixture@example.invalid:pet-fixture'
  );
  assert.equal(header(request.headers, 'X-Mme-Nas-Qualify'), 'AQID');
  assert.deepEqual(request.headers.filter(function (entry) {
    return entry[0].toLowerCase() === 'x-mme-client-info';
  }), [['x-mme-client-info', '<Fixture> <anisette>']]);
  assert.equal(new Set(request.headers.map(function (entry) { return entry[0].toLowerCase(); })).size, request.headers.length);
  var body = plist.decodeXmlPlist(request.body);
  assert.deepEqual(body.delegates['com.apple.private.ids'], { 'protocol-version': '4' });
  assert.equal(body.protocolVersion, '1.0');
  assert.deepEqual(body.userInfo, {
    'client-id': request.clientId,
    language: 'en-US',
    timezone: 'America/New_York',
  });

  var responseValue = {
    status: 0,
    delegates: {
      'com.apple.private.ids': {
        status: 0,
        'service-data': {
          'auth-token': 'auth-token-fixture',
          'profile-id': 'profile-fixture',
        },
      },
    },
  };
  [plist.encodeXmlPlist(responseValue), binaryPlist.encodeBinaryPlist(responseValue)].forEach(function (encoded) {
    assert.deepEqual(delegates.parseDelegateResponse(encoded), {
      authToken: 'auth-token-fixture',
      profileId: 'profile-fixture',
    });
  });
  assert.deepEqual(delegates.parseDelegateResponse(gzipCodec.gzip(plist.encodeXmlPlist(responseValue))), {
    authToken: 'auth-token-fixture',
    profileId: 'profile-fixture',
  });

  expectCode(function () {
    delegates.parseDelegateResponse(plist.encodeXmlPlist({ localizedError: 'UNAUTHORIZED' }));
  }, 'DELEGATE_LOGIN_FAILED');
  expectCode(function () {
    delegates.parseDelegateResponse(plist.encodeXmlPlist({
      status: 0,
      delegates: { 'com.apple.private.ids': { status: 12 } },
    }));
  }, 'DELEGATE_LOGIN_FAILED');
});

test('server error text is never copied into public account errors', function () {
  var marker = 'fixture-sensitive-server-text';
  var error;
  try {
    login.parseGsaInitResponse(plist.encodeXmlPlist({
      Response: { Status: { ec: -1, em: marker } },
    }));
  } catch (caught) {
    error = caught;
  }
  assert.equal(error.code, 'APPLE_AUTH_ERROR');
  assert.equal(JSON.stringify(error).includes(marker), false);
  assert.equal(error.message.includes(marker), false);
});
