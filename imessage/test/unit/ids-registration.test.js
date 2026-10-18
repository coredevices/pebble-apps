'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var gzip = require('../../src/codecs/gzip');
var plist = require('../../src/codecs/xml-plist');
var bytes = require('../../src/runtime/bytes');
var publicIdentity = require('../../src/ids/public-identity');
var registration = require('../../src/ids/registration');
var stateSchema = require('../../src/state/state-schema');

var CERTIFICATE = bytes.base64ToBytes('MIICCDCCAXGgAwIBAgIUdoC0so+M47owlpzzqWUCG5+jLgIwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLSURTIEZpeHR1cmUwHhcNMjYwODI3MjM0MDA1WhcNMjYwODI4MjM0MDA1WjAWMRQwEgYDVQQDDAtJRFMgRml4dHVyZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwtqyqFw3SD2/lbZoNsScKtWBMuZiUGqUtBoK+M4kw53nooozV0NleHE5vNsxwmVk9+g69rK/hMfd3H9uYGGe7kM1TlWSCXQqFOn1szfRsRkRm0uLOtcXS4HE+0Te3BW1oFw+m3Nno72GeXg1XHPnYITs33t9V0VCc+4u0ABLU4UCAwEAAaNTMFEwHQYDVR0OBBYEFFpzBW36fUrte0S2HF79zDK1VWTYMB8GA1UdIwQYMBaAFFpzBW36fUrte0S2HF79zDK1VWTYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEABm6eAv2OwCgOOVCmldQsJA13bRsLhA4N8OUXsGLTly1rUFi4miXYiH4/zpp+vBv8QOjl6gOFGNI8gY/fgqrq24pR8spW9MvD3e5rbSssLvbKaXzFjR4tmAKWyqdakY6Mtfs3JB9PI9dSzQwLraR/vOPkQHW+RpxGdOt+/2nwvMA=');
var GENERATOR_X = bytes.hexToBytes('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
var GENERATOR_POINT = bytes.hexToBytes('046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');

function fixtureIdentity() {
  return {
    publicIdentity: publicIdentity.encodePublicIdentity({
      signingPublicKey: GENERATOR_POINT,
      encryptionPublicKey: new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x03, 0x02, 0x01, 0x03]),
    }),
    device: { keyId: 'ngm-device-key', compact: GENERATOR_X },
    prekey: { keyId: 'ngm-prekey-key', compact: GENERATOR_X },
  };
}

function fixtureUser() {
  return {
    userId: 'profile-fixture', userType: 'apple', protocolVersion: 1660,
    keyId: 'auth-key', certificate: CERTIFICATE,
  };
}

function fixtureCrypto() {
  var calls = [];
  return {
    calls: calls,
    sign: function (keyId, specification, data) {
      calls.push({ keyId: keyId, specification: specification, data: new Uint8Array(data) });
      return specification.algorithm === 'ecdsa' ? new Uint8Array(64).fill(0x33) : new Uint8Array(128).fill(0x44);
    },
    digest: function (algorithm, data) {
      return new Uint8Array(nodeCrypto.createHash(algorithm).update(data).digest());
    },
  };
}

function registrationResponse() {
  return plist.encodeXmlPlist({
    status: 0,
    services: [{
      service: 'com.apple.madrid',
      users: [{
        status: 0, 'user-id': 'profile-fixture', cert: CERTIFICATE, 'next-hbi': 3600,
        uris: [
          { status: 0, uri: 'mailto:sender@example.test' },
          { status: 0, uri: 'tel:+15555550123' },
        ],
      }],
    }],
  });
}

test('handle profile parsing preserves aliases but rejects duplicates and non-normalized addresses', function () {
  var parsed = registration.parseHandlesResponse(plist.encodeXmlPlist({
    status: 0,
    handles: [{ uri: 'mailto:sender@example.test', aliases: { relay: { featureId: 'fixture' } } }],
  }));
  assert.equal(parsed[0].uri, 'mailto:sender@example.test');
  assert.equal(parsed[0].aliases.relay.featureId, 'fixture');
  assert.throws(function () {
    registration.parseHandlesResponse(plist.encodeXmlPlist({
      status: 0, handles: [{ uri: 'not-normalized' }],
    }));
  }, function (error) { return error.code === 'IDS_PROTOCOL_ERROR'; });
  assert.throws(function () {
    registration.parseHandlesResponse(plist.encodeXmlPlist({
      status: 0, handles: [{ uri: 'tel:+15555550123' }, { uri: 'tel:+15555550123' }],
    }));
  }, /duplicated/);
});

test('registration body contains pinned Madrid identity, prekey, KT, capability, and handle fields', function () {
  var identity = fixtureIdentity();
  var body = registration.buildRegistrationBody({
    users: [{ user: fixtureUser(), handles: [{ uri: 'mailto:sender@example.test' }] }],
    identity: identity,
    prekeyData: new Uint8Array([1, 2, 3]),
    validationData: new Uint8Array([4, 5, 6]),
    metadata: {
      deviceName: 'Mac-SERIAL', hardwareVersion: 'iMac13,1', osVersion: 'macOS,13.6.4,22G513',
      softwareVersion: '22G513', privateDeviceData: { u: 'DEVICE-UUID', pn: 'macOS' },
    },
  });
  var service = body.services[0];
  var user = service.users[0];
  assert.equal(service.service, 'com.apple.madrid');
  assert.deepEqual(service['sub-services'], registration.MADRID_SUB_SERVICES);
  assert.equal(service.capabilities[0].flags, 17);
  assert.equal(user['client-data']['public-message-identity-version'], 2);
  assert.equal(user['client-data']['public-message-identity-ngm-version'], 13);
  assert.deepEqual(user['client-data']['public-message-identity-key'], identity.publicIdentity);
  assert.deepEqual(user['kt-loggable-data'], bytes.concatBytes(
    new Uint8Array([0x0a, 0x22, 0x0a, 0x20]), GENERATOR_X,
    new Uint8Array([0x10, 0x0d, 0x18, 0x05])
  ));
  assert.equal(user.uris[0].uri, 'mailto:sender@example.test');
  var encodedBody = plist.encodeXmlPlist(body);
  var encodedXml = bytes.bytesToUtf8(encodedBody);
  assert.match(encodedXml, /<key>nicknames-version<\/key><real>1<\/real>/);
  assert.match(encodedXml, /<key>ec-version<\/key><real>1<\/real>/);
  assert.match(encodedXml, /<key>public-message-identity-version<\/key><integer>2<\/integer>/);
  assert.deepEqual(plist.decodeXmlPlist(encodedBody).services[0].users[0]['client-data']['public-message-identity-key'], identity.publicIdentity);
});

test('registration request signs one push credential then indexed auth credentials over exact gzip bytes', function () {
  var crypto = fixtureCrypto();
  var value = { services: [], fixture: true };
  var request = registration.buildRegistrationRequest({
    crypto: crypto, endpoint: 'https://identity.example.test/register', value: value,
    users: [fixtureUser()], pushKeyId: 'push-key', pushCertificate: CERTIFICATE,
    pushToken: new Uint8Array(32).fill(7), userAgent: '[fixture]', nowMs: 1700000000123,
    nonces: [new Uint8Array(8).fill(1), new Uint8Array(8).fill(2)],
  });
  assert.deepEqual(plist.decodeXmlPlist(gzip.ungzip(request.body)), value);
  assert.equal(request.trustAnchors.length, 2);
  assert.ok(request.trustAnchors[0] instanceof Uint8Array);
  assert.equal(crypto.calls.length, 2);
  assert.equal(crypto.calls[0].keyId, 'push-key');
  assert.equal(crypto.calls[1].keyId, 'auth-key');
  assert.deepEqual(request.headers.map(function (header) { return header[0]; }), [
    'x-push-token', 'x-protocol-version', 'user-agent', 'content-type', 'content-encoding', 'accept-encoding',
    'x-push-nonce', 'x-push-sig', 'x-push-cert', 'x-auth-user-id-0',
    'x-auth-nonce-0', 'x-auth-sig-0', 'x-auth-cert-0',
  ]);
});

test('fake-peer registration state machine fetches handles, registers, and emits durable artifacts', async function () {
  var crypto = fixtureCrypto();
  var requests = [];
  var randomCall = 0;
  var validationProviderCalls = 0;
  var result = await registration.registerIdentity({
    crypto: crypto,
    effects: {
      clock: { now: function () { return 1770000123456; } },
      random: { bytes: function (length) { randomCall += 1; return new Uint8Array(length).fill(randomCall); } },
      http: { request: async function (request) {
        requests.push(request);
        if (request.url.endsWith('/handles')) {
          return { status: 200, headers: [], body: plist.encodeXmlPlist({
            status: 0, handles: [{ uri: 'mailto:sender@example.test' }, { uri: 'tel:+15555550123' }],
          }) };
        }
        return { status: 200, headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']], body: registrationResponse() };
      } },
    },
    users: [fixtureUser()], identity: fixtureIdentity(),
    handlesEndpoint: 'https://identity.example.test/handles',
    registrationEndpoint: 'https://identity.example.test/register',
    pushKeyId: 'push-key', pushCertificate: CERTIFICATE, pushToken: new Uint8Array(32).fill(7),
    validationDataProvider: async function () {
      validationProviderCalls += 1;
      assert.equal(requests.length, 1);
      assert.equal(requests[0].bagKey, 'id-get-handles');
      assert.equal(randomCall, 4);
      return new Uint8Array([8, 9]);
    },
    userAgent: '[fixture]',
    metadata: {
      deviceName: 'Mac-SERIAL', hardwareVersion: 'iMac13,1', osVersion: 'macOS,13.6.4,22G513',
      softwareVersion: '22G513', privateDeviceData: { u: 'DEVICE-UUID', pn: 'macOS' },
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].trustAnchors.length, 2);
  assert.equal(requests[1].trustAnchors.length, 2);
  assert.equal(requests[0].bagKey, 'id-get-handles');
  assert.equal(requests[1].bagKey, 'id-register');
  assert.equal(validationProviderCalls, 1);
  var sentBody = plist.decodeXmlPlist(gzip.ungzip(requests[1].body));
  assert.deepEqual(sentBody['validation-data'], new Uint8Array([8, 9]));
  assert.deepEqual(sentBody.services[0].users[0].uris, [
    { uri: 'mailto:sender@example.test' }, { uri: 'tel:+15555550123' },
  ]);
  assert.deepEqual(result.handles, ['mailto:sender@example.test', 'tel:+15555550123']);
  assert.equal(result.records[0].keyId, 'auth-key');
  assert.equal(result.records[0].registeredAtSeconds, 1770000123);
  assert.equal(result.records[0].heartbeatIntervalSeconds, 3600);
  assert.equal(result.artifact.version, 3);
  assert.equal(result.artifact.pushToken, bytes.bytesToBase64(new Uint8Array(32).fill(7)));
  assert.equal(result.artifact.serviceDataHash, registration.madridServiceDataHash(crypto));
  assert.equal(JSON.stringify(result.artifact).indexOf('Uint8Array'), -1);
  assert.equal(JSON.stringify(result.artifact).indexOf('validation-data'), -1);
  assert.equal(JSON.parse(JSON.stringify(result.artifact)).registrations[0].certificate, bytes.bytesToBase64(CERTIFICATE));
  var state = stateSchema.createEmptyState();
  state.generation = 1;
  state.phase = 'ready';
  state.account.id = 'profile-fixture';
  state.account.handles = result.handles.slice();
  state.artifacts.registration = JSON.parse(JSON.stringify(result.artifact));
  assert.deepEqual(stateSchema.validateCurrentState(state).account.handles, result.handles);
});

test('registration parser maps nested service and URI failures without accepting partial success', function () {
  assert.throws(function () {
    registration.parseRegistrationResponse(plist.encodeXmlPlist({ status: 6009, services: [] }), [fixtureUser()], 1);
  }, function (error) { return error.code === 'IDS_REGISTRATION_FAILED' && error.details.serverCode === 6009; });
  assert.throws(function () {
    registration.parseRegistrationResponse(plist.encodeXmlPlist({
      status: 0,
      services: [{ service: 'com.apple.madrid', users: [{
        status: 0, 'user-id': 'profile-fixture', cert: CERTIFICATE,
        uris: [{ status: 6004, uri: 'mailto:sender@example.test' }],
      }] }],
    }), [fixtureUser()], 1);
  }, function (error) { return error.code === 'IDS_REGISTRATION_FAILED' && error.details.serverCode === 6004; });
});

test('registration exposes only successful Madrid URIs as send-from addresses', function () {
  var parsed = registration.parseRegistrationResponse(plist.encodeXmlPlist({
    status: 0,
    services: [
      { service: 'com.apple.private.alloy.fixture', users: [{
        status: 0, 'user-id': 'profile-fixture', cert: CERTIFICATE,
        uris: [{ status: 0, uri: 'mailto:not-an-imessage-sender@example.test' }],
      }] },
      { service: 'com.apple.madrid', users: [{
        status: 0, 'user-id': 'profile-fixture', cert: CERTIFICATE,
        uris: [
          { status: 0, uri: 'mailto:sender@example.test' },
          { status: 0, uri: 'tel:+15555550123' },
        ],
      }] },
    ],
  }), [fixtureUser()], 1770000123);

  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.handles, ['mailto:sender@example.test', 'tel:+15555550123']);
  assert.throws(function () {
    registration.parseRegistrationResponse(plist.encodeXmlPlist({
      status: 0,
      services: [{ service: 'com.apple.private.alloy.fixture', users: [{
        status: 0, 'user-id': 'profile-fixture', cert: CERTIFICATE,
        uris: [{ status: 0, uri: 'mailto:not-an-imessage-sender@example.test' }],
      }] }],
    }), [fixtureUser()], 1770000123);
  }, /no Madrid send-from addresses/);
});

test('durable registration catalog ignores legacy non-Madrid union handles', function () {
  var artifact = {
    version: 1,
    registrations: [
      { service: 'com.apple.private.alloy.fixture', handles: ['tel:+15555550999'] },
      { service: 'com.apple.madrid', handles: [
        'mailto:sender@example.test', 'tel:+15555550123',
      ] },
    ],
  };
  assert.deepEqual(registration.registeredMadridHandles(artifact), [
    'mailto:sender@example.test', 'tel:+15555550123',
  ]);
  assert.throws(function () {
    registration.registeredMadridHandles({
      version: 1,
      registrations: [{ service: 'com.apple.private.alloy.fixture', handles: ['tel:+15555550999'] }],
    });
  }, /no Madrid send-from addresses/);
});

test('registration response artifacts bind version two to a push token while preserving version-one captures', function () {
  var legacy = registration.parseRegistrationResponse(registrationResponse(), [fixtureUser()], 1770000123);
  assert.deepEqual(Object.keys(legacy.artifact).sort(), ['registrations', 'version']);
  assert.equal(legacy.artifact.version, 1);

  var pushToken = new Uint8Array(32).fill(0x29);
  var bound = registration.parseRegistrationResponse(
    registrationResponse(),
    [fixtureUser()],
    1770000123,
    pushToken
  );
  assert.deepEqual(Object.keys(bound.artifact).sort(), ['pushToken', 'registrations', 'version']);
  assert.equal(bound.artifact.version, 2);
  assert.equal(bound.artifact.pushToken, bytes.bytesToBase64(pushToken));
  assert.throws(function () {
    registration.parseRegistrationResponse(
      registrationResponse(),
      [fixtureUser()],
      1770000123,
      new Uint8Array(31)
    );
  }, /Push token is malformed/);
});

test('Madrid service metadata hash is deterministic and changes with client data or sub-services', function () {
  var crypto = fixtureCrypto();
  var service = registration.madridService();
  var expected = registration.serviceDataHash(crypto, service);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(registration.madridServiceDataHash(crypto), expected);
  assert.equal(registration.serviceDataHash(crypto, {
    clientData: Object.assign({}, service.clientData, { 'supports-polls': false }),
    subServices: service.subServices,
  }) === expected, false);
  assert.equal(registration.serviceDataHash(crypto, {
    clientData: service.clientData,
    subServices: service.subServices.concat(['com.apple.private.alloy.fixture']),
  }) === expected, false);
});

test('registration freshness matches next-hbi or certificate expiry minus five minutes', function () {
  var crypto = fixtureCrypto();
  var dataHash = registration.madridServiceDataHash(crypto);
  var parsed = require('../../src/codecs/asn1').parseCertificate(CERTIFICATE);
  var base = {
    serviceDataHash: dataHash,
    certificate: CERTIFICATE,
    registeredAtSeconds: 1000,
    heartbeatIntervalSeconds: 3600,
  };
  assert.equal(registration.registrationNeedsRefresh(base, dataHash, 4599999), false);
  assert.equal(registration.registrationNeedsRefresh(base, dataHash, 4600000), true);

  var withoutHeartbeat = Object.assign({}, base, { heartbeatIntervalSeconds: null });
  var boundary = parsed.notAfter.epochMilliseconds - registration.CERTIFICATE_REFRESH_MARGIN_MILLIS;
  assert.equal(registration.registrationNeedsRefresh(withoutHeartbeat, dataHash, boundary - 1), false);
  assert.equal(registration.registrationNeedsRefresh(withoutHeartbeat, dataHash, boundary), true);
  assert.equal(registration.registrationNeedsRefresh(
    Object.assign({}, withoutHeartbeat, { serviceDataHash: null }), dataHash, boundary - 1
  ), true);
});

test('version-three registration artifacts persist the service hash while older captures remain readable', function () {
  var crypto = fixtureCrypto();
  var dataHash = registration.madridServiceDataHash(crypto);
  var pushToken = new Uint8Array(32).fill(0x39);
  var current = registration.parseRegistrationResponse(
    registrationResponse(), [fixtureUser()], 1770000123, pushToken, dataHash
  );
  assert.deepEqual(Object.keys(current.artifact).sort(), [
    'pushToken', 'registrations', 'serviceDataHash', 'version',
  ]);
  assert.equal(current.artifact.version, 3);
  assert.equal(current.artifact.serviceDataHash, dataHash);
});
