'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');

var bytes = require('../../src/runtime/bytes');
var plist = require('../../src/codecs/xml-plist');
var binaryPlist = require('../../src/codecs/binary-plist');
var srp = require('../../src/apple-account/srp');
var login = require('../../src/apple-account/login');
var twoFactor = require('../../src/apple-account/two-factor');
var delegates = require('../../src/apple-account/delegates');
var createEffects = require('../../src/runtime/effects').createEffects;
var CryptoCompositions = require('../../src/crypto/compositions').CryptoCompositions;
var DeterministicSoftwareCrypto = require('../../harness/deterministic-software-crypto').DeterministicSoftwareCrypto;

var USERNAME = 'fixture@example.invalid';
var PASSWORD = 'fixture password - never valid';
var TRUSTED_CODE = '654321';
var SMS_CODE = '123456';
var NOW_MS = Date.UTC(2026, 7, 27, 12, 0, 0);
var PRIVATE_EPHEMERAL = bytes.hexToBytes(
  '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
);
var SERVER_PUBLIC = bytes.hexToBytes(
  '7656b6ff367e7473370c2e4f2ed11f9fdd066349ac915488963b25b0478f55b8' +
  '8c4a58501928ad2cddcfb6ed20551a0a48d63c96eca394c9c707acfddb54a0d2'
);

function cryptoProvider() {
  return new CryptoCompositions(new DeterministicSoftwareCrypto());
}

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

function anisetteHeaderFixture() {
  return [
    ['X-Apple-I-MD-LU', 'lookup-fixture'],
    ['X-Apple-I-MD-RINFO', '17106176'],
    ['X-Apple-I-MD-M', 'machine-fixture'],
    ['X-Apple-I-MD', 'otp-fixture'],
    ['X-Mme-Device-Id', 'device-fixture'],
    ['X-Apple-I-Client-Time', '2026-08-27T12:00:00Z'],
    ['X-Apple-I-TimeZone', 'UTC'],
  ];
}

function headerValues(headers, name) {
  return headers.filter(function (header) {
    return header[0].toLowerCase() === name.toLowerCase();
  }).map(function (header) { return header[1]; });
}

function lastHeader(headers, name) {
  var values = headerValues(headers, name);
  return values.length === 0 ? null : values[values.length - 1];
}

function response(status, body, headers) {
  return {
    status: status,
    headers: headers || [],
    body: body instanceof Uint8Array ? body : body === undefined ? new Uint8Array(0) : plist.encodeXmlPlist(body),
  };
}

function tokenHeader(value) {
  return bytes.bytesToBase64(bytes.utf8ToBytes(value));
}

function RandomQueue(values) {
  this.values = values.map(function (value) { return new Uint8Array(value); });
}

RandomQueue.prototype.bytes = function (length) {
  assert.ok(this.values.length > 0, 'unexpected random-byte request');
  var value = this.values.shift();
  assert.equal(value.length, length);
  return value;
};

RandomQueue.prototype.assertExhausted = function () {
  assert.equal(this.values.length, 0);
};

function FakeAccountPeer(script) {
  this.script = script.slice();
  this.requests = [];
}

FakeAccountPeer.prototype.request = async function (requestValue) {
  assert.ok(this.script.length > 0, 'unexpected HTTP request');
  var headers = requestValue.headers.map(function (entry) { return entry.slice(); });
  var effective = {
    method: requestValue.method,
    url: requestValue.url,
    headers: headers,
    body: new Uint8Array(requestValue.body),
    trustAnchors: (requestValue.trustAnchors || []).map(function (anchor) {
      return new Uint8Array(anchor);
    }),
  };
  this.requests.push(effective);
  var result = await this.script.shift()(effective);
  return {
    status: result.status,
    headers: (result.headers || []).map(function (entry) { return entry.slice(); }),
    body: new Uint8Array(result.body || 0),
  };
};

FakeAccountPeer.prototype.assertExhausted = function () {
  assert.equal(this.script.length, 0);
};

function srpExchange(crypto, options) {
  var salt = bytes.hexToBytes(options.saltHex || '00112233445566778899aabbccddeeff');
  var passwordHash = srp.derivePasswordHash(crypto, PASSWORD);
  var result = srp.completeChallenge(crypto, {
    username: USERNAME,
    passwordHash: passwordHash,
    protocol: 's2k_fo',
    salt: salt,
    iterations: 2048,
    privateEphemeral: PRIVATE_EPHEMERAL,
    serverPublic: SERVER_PUBLIC,
  });
  passwordHash.fill(0);
  var tokenDictionary = {};
  if (options.pet) {
    tokenDictionary[twoFactor.PET_SERVICE] = { token: options.pet, duration: 600 };
  }
  var spd = {
    acname: USERNAME,
    adsid: 'adsid-fixture',
    GsIdmsToken: 'identity-token-fixture',
    t: tokenDictionary,
  };
  var encryptedSpd = crypto.aes({
    mode: 'cbc',
    direction: 'encrypt',
    key: srp.deriveExtraDataKeys(crypto, result.sessionKey).key,
    iv: srp.deriveExtraDataKeys(crypto, result.sessionKey).iv,
    data: options.binarySpd ? binaryPlist.encodeBinaryPlist(spd) : plist.encodeXmlPlist(spd),
    padding: true,
  });
  var status = { ec: 0 };
  if (options.authenticationState) status.au = options.authenticationState;
  return {
    challenge: options.challenge,
    publicEphemeral: srp.createPublicEphemeral(crypto, PRIVATE_EPHEMERAL),
    proof: new Uint8Array(result.proof),
    initResponse: {
      Response: {
        Status: { ec: 0 },
        s: salt,
        B: SERVER_PUBLIC,
        i: 2048,
        c: options.challenge,
        sp: 's2k_fo',
      },
    },
    completeResponse: {
      Response: {
        Status: status,
        M2: new Uint8Array(result.expectedServerProof),
        spd: encryptedSpd,
      },
    },
  };
}

function gsaSteps(exchange, requestId, setCookies) {
  return [
    function expectInit(requestValue) {
      assert.equal(requestValue.method, 'POST');
      assert.equal(requestValue.url, login.GSA_ENDPOINT);
      assert.equal(requestValue.trustAnchors.length, 2);
      var body = plist.decodeXmlPlist(requestValue.body);
      assert.equal(body.Request.o, 'init');
      assert.equal(body.Request.u, USERNAME);
      assert.deepEqual(body.Request.A2k, exchange.publicEphemeral);
      assert.equal(body.Request.cpd['X-Apple-I-Request-UUID'], requestId);
      assert.equal(
        lastHeader(requestValue.headers, 'Cookie'),
        setCookies ? null : 'session=fixture-session; route=fixture-route'
      );
      return response(200, exchange.initResponse, setCookies ? [
        ['Set-Cookie', 'session=fixture-session; Path=/; Secure'],
        ['Set-Cookie', 'route=fixture-route; Path=/; Secure'],
      ] : []);
    },
    function expectComplete(requestValue) {
      assert.equal(requestValue.trustAnchors.length, 2);
      assert.equal(lastHeader(requestValue.headers, 'Cookie'), 'session=fixture-session; route=fixture-route');
      var body = plist.decodeXmlPlist(requestValue.body);
      assert.equal(body.Request.o, 'complete');
      assert.equal(body.Request.c, exchange.challenge);
      assert.equal(body.Request.cpd['X-Apple-I-Request-UUID'], requestId);
      assert.deepEqual(body.Request.M1, exchange.proof);
      return response(200, exchange.completeResponse);
    },
  ];
}

function delegateStep(expectedPet) {
  return function expectDelegate(requestValue) {
    assert.equal(requestValue.method, 'POST');
    assert.equal(requestValue.url, delegates.DELEGATE_ENDPOINT);
    assert.equal(lastHeader(requestValue.headers, 'Cookie'), null);
    assert.equal(
      bytes.bytesToUtf8(bytes.base64ToBytes(lastHeader(requestValue.headers, 'Authorization').slice(6))),
      USERNAME + ':' + expectedPet
    );
    assert.equal(lastHeader(requestValue.headers, 'X-Mme-Nas-Qualify'), 'AQIDBA==');
    var body = plist.decodeXmlPlist(requestValue.body);
    assert.deepEqual(body.delegates['com.apple.private.ids'], { 'protocol-version': '4' });
    assert.equal(body.protocolVersion, '1.0');
    assert.equal(body.userInfo.language, 'en-US');
    return response(200, {
      status: 0,
      delegates: {
        'com.apple.private.ids': {
          status: 0,
          'service-data': {
            'auth-token': 'ids-auth-token-fixture',
            'profile-id': 'ids-profile-fixture',
          },
        },
      },
    });
  };
}

test('account cookie jar scopes domain and path and honors deletion without cross-origin leakage', function () {
  var jar = new Map();
  login.rememberSessionCookies(jar, login.GSA_ENDPOINT, [
    ['Set-Cookie', 'host=one; Path=/grandslam; Secure'],
    ['Set-Cookie', 'parent=two; Domain=.apple.com; Path=/; Secure'],
    ['Set-Cookie', 'narrow=three; Path=/auth; Secure'],
    ['Set-Cookie', 'foreign=ignored; Domain=icloud.com; Path=/; Secure'],
    ['Set-Cookie', 'suffix=ignored; Domain=com; Path=/; Secure'],
    ['Set-Cookie', 'empty=; Path=/; Secure'],
  ], 1000);

  var gsaRequest = login.withSessionCookies({ url: login.GSA_ENDPOINT, headers: [] }, jar);
  assert.equal(lastHeader(gsaRequest.headers, 'Cookie'), 'host=one; parent=two; empty=');
  var authRequest = login.withSessionCookies({
    url: twoFactor.TRUSTED_DEVICE_CODE_ENDPOINT,
    headers: [],
  }, jar);
  assert.equal(lastHeader(authRequest.headers, 'Cookie'), 'narrow=three; parent=two; empty=');
  var delegateRequest = login.withSessionCookies({ url: delegates.DELEGATE_ENDPOINT, headers: [] }, jar);
  assert.equal(lastHeader(delegateRequest.headers, 'Cookie'), null);

  login.rememberSessionCookies(jar, login.GSA_ENDPOINT, [
    ['Set-Cookie', 'parent=gone; Domain=.apple.com; Path=/; Max-Age=0'],
    ['Set-Cookie', 'empty=gone; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
  ], 1000);
  assert.equal(lastHeader(login.withSessionCookies({
    url: login.GSA_ENDPOINT,
    headers: [],
  }, jar).headers, 'Cookie'), 'host=one');
});

function random16(hex) {
  return bytes.hexToBytes(hex);
}

function requestId(random) {
  return delegates.uuidString(random);
}

function createSession(script, randomValues, validationData) {
  if (arguments.length < 3) validationData = new Uint8Array([1, 2, 3, 4]);
  var peer = new FakeAccountPeer(script);
  var random = new RandomQueue(randomValues);
  var traces = [];
  var generatedValidationData = [];
  var generationRequestCounts = [];
  var validationDataGenerator = validationData === null ? null : {
    generate: async function (hardware) {
      assert.deepEqual(hardware, { fixture: 'Mac hardware' });
      generationRequestCounts.push(peer.requests.length);
      var fresh = new Uint8Array(validationData);
      generatedValidationData.push(fresh);
      return fresh;
    },
  };
  var anisette = {
    calls: 0,
    getHeaders: async function () {
      this.calls += 1;
      return anisetteHeaderFixture();
    },
  };
  var effects = createEffects({
    http: peer,
    random: random,
    clock: { now: function () { return NOW_MS; } },
    trace: { emit: function (event) { traces.push(event); } },
  });
  var session = new login.AccountLoginSession({
    effects: effects,
    crypto: cryptoProvider(),
    anisette: anisette,
    clientInfo: clientInfo(),
    delegateConfig: {
      userAgent: 'delegate-fixture/1.0',
      mmeClientInfo: '<Fixture> <delegate>',
    },
    validationDataGenerator: validationDataGenerator,
    hardware: { fixture: 'Mac hardware' },
  });
  return {
    session: session, peer: peer, random: random, traces: traces, anisette: anisette,
    generatedValidationData: generatedValidationData,
    generationRequestCounts: generationRequestCounts,
  };
}

function assertSafeState(fixture, forbidden) {
  var serialized = JSON.stringify({
    session: fixture.session,
    snapshot: fixture.session.snapshot(),
    traces: fixture.traces,
  });
  forbidden.forEach(function (value) {
    assert.equal(serialized.includes(value), false, 'state or trace contained ' + value);
  });
  assert.deepEqual(Object.keys(fixture.session).sort(), ['busy', 'status', 'verification']);
}

test('deferred Mac validation permits SRP and trusted-device two-factor setup', async function () {
  var crypto = cryptoProvider();
  var exchange = srpExchange(crypto, {
    challenge: 'deferred-validation-two-factor',
    authenticationState: 'trustedDeviceSecondaryAuth',
    binarySpd: true,
  });
  var requestRandom = random16('808182838485868788898a8b8c8d8e8f');
  var script = gsaSteps(exchange, requestId(requestRandom), true).concat([
    function sendTrustedCode(requestValue) {
      assert.equal(requestValue.url, twoFactor.TRUSTED_DEVICE_CODE_ENDPOINT);
      return response(200);
    },
  ]);
  var fixture = createSession(script, [PRIVATE_EPHEMERAL, requestRandom], null);

  assert.deepEqual(await fixture.session.start({ username: USERNAME, password: PASSWORD }), {
    status: 'needs-two-factor', verification: 'trusted-device', authenticated: false,
  });
  assertSafeState(fixture, [PASSWORD]);
  fixture.peer.assertExhausted();
  fixture.random.assertExhausted();
  assert.equal(fixture.anisette.calls, 2);
  assert.deepEqual(fixture.traces.map(function (event) { return event.to; }), [
    'signing-in', 'needs-two-factor',
  ]);

  await assert.rejects(fixture.session.submitTwoFactorCode('123456'), function (error) {
    return error && error.code === 'MAC_VALIDATION_REQUIRED';
  });
  assert.deepEqual(fixture.session.snapshot(), {
    status: 'needs-two-factor', verification: 'trusted-device', authenticated: false,
  });
  assert.equal(fixture.anisette.calls, 2);
  fixture.peer.assertExhausted();
});

test('deferred Mac validation fails precisely at the delegate boundary without delegate effects', async function () {
  var crypto = cryptoProvider();
  var pet = 'deferred-validation-pet';
  var exchange = srpExchange(crypto, {
    challenge: 'deferred-validation-delegate',
    pet: pet,
  });
  var requestRandom = random16('909192939495969798999a9b9c9d9e9f');
  var fixture = createSession(
    gsaSteps(exchange, requestId(requestRandom), true),
    [PRIVATE_EPHEMERAL, requestRandom],
    null
  );

  await assert.rejects(
    fixture.session.start({ username: USERNAME, password: PASSWORD }),
    function (error) {
      return error && error.code === 'MAC_VALIDATION_REQUIRED'
        && error.kind === 'invalid-input'
        && error.message === 'Fresh Mac validation data is required to finish account login.';
    }
  );
  assert.equal(fixture.session.snapshot().status, 'failed');
  assertSafeState(fixture, [PASSWORD, pet]);
  fixture.peer.assertExhausted();
  fixture.random.assertExhausted();
  assert.equal(fixture.anisette.calls, 1);
  assert.equal(fixture.peer.requests.some(function (requestValue) {
    return requestValue.url === delegates.DELEGATE_ENDPOINT;
  }), false);
  assert.deepEqual(fixture.traces.map(function (event) { return event.to; }), [
    'signing-in', 'failed',
  ]);
});

test('trusted-device flow retries SRP when verification returns no PET, then logs in the IDS delegate', async function () {
  var crypto = cryptoProvider();
  var first = srpExchange(crypto, {
    challenge: 'trusted-challenge-one',
    authenticationState: 'trustedDeviceSecondaryAuth',
  });
  var pet = 'trusted-pet-fixture';
  var second = srpExchange(crypto, {
    challenge: 'trusted-challenge-two',
    saltHex: 'ffeeddccbbaa99887766554433221100',
    pet: pet,
  });
  var requestRandom1 = random16('000102030405060708090a0b0c0d0e0f');
  var requestRandom2 = random16('101112131415161718191a1b1c1d1e1f');
  var delegateRandom = random16('202122232425262728292a2b2c2d2e2f');
  var script = gsaSteps(first, requestId(requestRandom1), true).concat([
    function expectTrustedCodeRequest(requestValue) {
      assert.equal(requestValue.method, 'GET');
      assert.equal(requestValue.url, twoFactor.TRUSTED_DEVICE_CODE_ENDPOINT);
      assert.equal(lastHeader(requestValue.headers, 'Cookie'), 'session=fixture-session; route=fixture-route');
      return response(200);
    },
    function expectTrustedVerification(requestValue) {
      assert.equal(requestValue.url, twoFactor.TRUSTED_DEVICE_VERIFY_ENDPOINT);
      assert.equal(lastHeader(requestValue.headers, 'security-code'), TRUSTED_CODE);
      return response(200, { Status: { ec: 0 } }, [
        ['X-Apple-GS-Token', tokenHeader('service.one:first:60')],
        ['X-Apple-GS-Token', tokenHeader('service.one:replacement:120')],
        ['X-Apple-HB-Token', tokenHeader('service.two:second:180')],
      ]);
    },
  ], gsaSteps(second, requestId(requestRandom2), false), [delegateStep(pet)]);
  var fixture = createSession(script, [
    PRIVATE_EPHEMERAL, requestRandom1, PRIVATE_EPHEMERAL, requestRandom2, delegateRandom,
  ]);

  assert.deepEqual(await fixture.session.start({ username: USERNAME, password: PASSWORD }), {
    status: 'needs-two-factor', verification: 'trusted-device', authenticated: false,
  });
  assertSafeState(fixture, [PASSWORD, TRUSTED_CODE, pet]);
  assert.deepEqual(await fixture.session.submitTwoFactorCode(TRUSTED_CODE), {
    status: 'authenticated', verification: null, authenticated: true,
  });
  assert.deepEqual(fixture.session.getResult(), {
    ids: { authToken: 'ids-auth-token-fixture', profileId: 'ids-profile-fixture' },
  });
  assertSafeState(fixture, [PASSWORD, TRUSTED_CODE, pet, 'ids-auth-token-fixture']);
  fixture.peer.assertExhausted();
  fixture.random.assertExhausted();
  assert.equal(JSON.stringify(fixture.peer.requests).includes(PASSWORD), false);
  assert.equal(fixture.anisette.calls, 5);
  assert.deepEqual(fixture.generationRequestCounts, [fixture.peer.requests.length - 1]);
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(4)]);
  assert.deepEqual(fixture.traces.map(function (event) { return event.to; }), [
    'signing-in', 'needs-two-factor', 'fetching-delegate', 'authenticated',
  ]);
});

test('delegate transport failure still zeroes its one-use generated validation blob', async function () {
  var crypto = cryptoProvider();
  var pet = 'failed-delegate-pet';
  var exchange = srpExchange(crypto, { challenge: 'failed-delegate-challenge', pet: pet });
  var requestRandom = random16('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
  var delegateRandom = random16('b0b1b2b3b4b5b6b7b8b9babbbcbdbebf');
  var fixture = createSession(
    gsaSteps(exchange, requestId(requestRandom), true).concat([function failDelegate(requestValue) {
      assert.equal(requestValue.url, delegates.DELEGATE_ENDPOINT);
      throw new Error('private delegate transport detail');
    }]),
    [PRIVATE_EPHEMERAL, requestRandom, delegateRandom]
  );

  await assert.rejects(
    fixture.session.start({ username: USERNAME, password: PASSWORD }),
    function (error) { return error && error.code === 'APPLE_NETWORK_ERROR'; }
  );
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(4)]);
  assert.deepEqual(fixture.generationRequestCounts, [fixture.peer.requests.length - 1]);
  assert.equal(fixture.session.snapshot().status, 'failed');
  fixture.peer.assertExhausted();
});

test('SMS flow accepts ordered duplicate token headers and proceeds directly with the PET', async function () {
  var crypto = cryptoProvider();
  var first = srpExchange(crypto, {
    challenge: 'sms-challenge',
    authenticationState: 'secondaryAuth',
  });
  var pet = 'sms-pet-fixture';
  var requestRandom = random16('303132333435363738393a3b3c3d3e3f');
  var delegateRandom = random16('404142434445464748494a4b4c4d4e4f');
  var script = gsaSteps(first, requestId(requestRandom), true).concat([
    function expectSmsCodeRequest(requestValue) {
      assert.equal(requestValue.method, 'PUT');
      assert.equal(requestValue.url, twoFactor.SMS_CODE_ENDPOINT);
      assert.deepEqual(JSON.parse(bytes.bytesToUtf8(requestValue.body)), {
        phoneNumber: { id: 1 }, mode: 'sms',
      });
      return response(200);
    },
    function expectSmsVerification(requestValue) {
      assert.equal(requestValue.method, 'POST');
      assert.equal(requestValue.url, twoFactor.SMS_VERIFY_ENDPOINT);
      assert.deepEqual(JSON.parse(bytes.bytesToUtf8(requestValue.body)), {
        phoneNumber: { id: 1 }, mode: 'sms', securityCode: { code: SMS_CODE },
      });
      return response(200, undefined, [
        ['X-Apple-GS-Token', tokenHeader('service.one:first:60:' + (NOW_MS + 60000))],
        ['X-Apple-HB-Token', tokenHeader('service.two:second:60:' + (NOW_MS + 60000))],
        ['X-Apple-GS-Token', tokenHeader('service.one:replacement:120:' + (NOW_MS + 120000))],
        ['X-Apple-PE-Token', tokenHeader('ignored:' + pet + ':300')],
      ]);
    },
    delegateStep(pet),
  ]);
  var fixture = createSession(script, [PRIVATE_EPHEMERAL, requestRandom, delegateRandom]);

  var pending = await fixture.session.start({ username: USERNAME, password: PASSWORD });
  assert.equal(pending.verification, 'sms');
  assertSafeState(fixture, [PASSWORD, SMS_CODE, pet]);
  var complete = await fixture.session.submitTwoFactorCode(SMS_CODE);
  assert.equal(complete.authenticated, true);
  assert.deepEqual(fixture.session.getResult().ids, {
    authToken: 'ids-auth-token-fixture', profileId: 'ids-profile-fixture',
  });
  assertSafeState(fixture, [PASSWORD, SMS_CODE, pet, 'ids-auth-token-fixture']);
  fixture.peer.assertExhausted();
  fixture.random.assertExhausted();
  assert.equal(fixture.anisette.calls, 4);
});

test('a rejected SMS code leaves only the verification mode available for retry', async function () {
  var crypto = cryptoProvider();
  var first = srpExchange(crypto, {
    challenge: 'sms-rejection-challenge',
    authenticationState: 'secondaryAuth',
  });
  var requestRandom = random16('505152535455565758595a5b5c5d5e5f');
  var script = gsaSteps(first, requestId(requestRandom), true).concat([
    function sendSms(requestValue) {
      assert.equal(requestValue.url, twoFactor.SMS_CODE_ENDPOINT);
      return response(200);
    },
    function rejectSms(requestValue) {
      assert.equal(requestValue.url, twoFactor.SMS_VERIFY_ENDPOINT);
      return response(401);
    },
  ]);
  var fixture = createSession(script, [PRIVATE_EPHEMERAL, requestRandom]);
  await fixture.session.start({ username: USERNAME, password: PASSWORD });
  await assert.rejects(fixture.session.submitTwoFactorCode(SMS_CODE), function (error) {
    return error && error.code === 'INVALID_TWO_FACTOR_CODE';
  });
  assert.deepEqual(fixture.session.snapshot(), {
    status: 'needs-two-factor', verification: 'sms', authenticated: false,
  });
  assertSafeState(fixture, [PASSWORD, SMS_CODE]);
  fixture.peer.assertExhausted();
  fixture.session.dispose();
  assert.equal(fixture.session.snapshot().status, 'disposed');
});

test('invalid 2FA input is rejected before any network request or state mutation', async function () {
  var crypto = cryptoProvider();
  var first = srpExchange(crypto, {
    challenge: 'validation-challenge',
    authenticationState: 'secondaryAuth',
  });
  var requestRandom = random16('606162636465466768696a6b6c6d6e6f');
  var script = gsaSteps(first, requestId(requestRandom), true).concat([
    function sendSms() { return response(200); },
  ]);
  var fixture = createSession(script, [PRIVATE_EPHEMERAL, requestRandom]);
  await fixture.session.start({ username: USERNAME, password: PASSWORD });
  var requestCount = fixture.peer.requests.length;
  await assert.rejects(fixture.session.submitTwoFactorCode('12345'), function (error) {
    return error && error.code === 'INVALID_TWO_FACTOR_CODE';
  });
  assert.equal(fixture.peer.requests.length, requestCount);
  assert.equal(fixture.session.snapshot().verification, 'sms');
});

test('a mismatched authenticated server proof fails closed and clears pending credentials', async function () {
  var crypto = cryptoProvider();
  var exchange = srpExchange(crypto, {
    challenge: 'mismatched-proof-challenge',
    pet: 'unreachable-pet-fixture',
  });
  exchange.completeResponse.Response.M2 = new Uint8Array(32);
  var requestRandom = random16('707172737475767778797a7b7c7d7e7f');
  var fixture = createSession(
    gsaSteps(exchange, requestId(requestRandom), true),
    [PRIVATE_EPHEMERAL, requestRandom]
  );
  await assert.rejects(
    fixture.session.start({ username: USERNAME, password: PASSWORD }),
    function (error) { return error && error.code === 'APPLE_ACCOUNT_PROTOCOL_ERROR'; }
  );
  assert.equal(fixture.session.snapshot().status, 'failed');
  assert.equal(fixture.session.passwordHash, null);
  assert.equal(fixture.session.username, null);
  assertSafeState(fixture, [PASSWORD, 'unreachable-pet-fixture']);
  fixture.peer.assertExhausted();
});
