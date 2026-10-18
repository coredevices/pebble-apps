'use strict';

var assert = require('node:assert/strict');
var nodeCrypto = require('node:crypto');
var test = require('node:test');

var configuration = require('../../src/configuration/coordinator');
var macAuth = require('../../src/configuration/mac-auth-token');
var SendCoordinator = require('../../src/imessage/send-coordinator').SendCoordinator;
var DurableStateRepository = require('../../src/state/durable-state-repository').DurableStateRepository;
var createEffects = require('../../src/runtime/effects').createEffects;
var bytes = require('../../src/runtime/bytes');
var raw = require('../../src/codecs/aps-raw');
var bplist = require('../../src/codecs/binary-plist');
var xmlPlist = require('../../src/codecs/xml-plist');
var gzip = require('../../src/codecs/gzip');
var apsBag = require('../../src/aps/bag');
var apsMessages = require('../../src/aps/messages');
var identities = require('../../src/ids/identities');
var registration = require('../../src/ids/registration');
var ngm = require('../../src/ids/ngm-pair-ec');
var publicIdentity = require('../../src/ids/public-identity');
var sendRetry = require('../../src/ids/send-retry');

var SENDER = 'mailto:sender@example.invalid';
var PHONE_SENDER = 'tel:+15555550123';
var RECIPIENT = 'mailto:recipient@example.invalid';
var CERTIFICATE = bytes.base64ToBytes('MIICCDCCAXGgAwIBAgIUdoC0so+M47owlpzzqWUCG5+jLgIwDQYJKoZIhvcNAQELBQAwFjEUMBIGA1UEAwwLSURTIEZpeHR1cmUwHhcNMjYwODI3MjM0MDA1WhcNMjYwODI4MjM0MDA1WjAWMRQwEgYDVQQDDAtJRFMgRml4dHVyZTCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwtqyqFw3SD2/lbZoNsScKtWBMuZiUGqUtBoK+M4kw53nooozV0NleHE5vNsxwmVk9+g69rK/hMfd3H9uYGGe7kM1TlWSCXQqFOn1szfRsRkRm0uLOtcXS4HE+0Te3BW1oFw+m3Nno72GeXg1XHPnYITs33t9V0VCc+4u0ABLU4UCAwEAAaNTMFEwHQYDVR0OBBYEFFpzBW36fUrte0S2HF79zDK1VWTYMB8GA1UdIwQYMBaAFFpzBW36fUrte0S2HF79zDK1VWTYMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADgYEABm6eAv2OwCgOOVCmldQsJA13bRsLhA4N8OUXsGLTly1rUFi4miXYiH4/zpp+vBv8QOjl6gOFGNI8gY/fgqrq24pR8spW9MvD3e5rbSssLvbKaXzFjR4tmAKWyqdakY6Mtfs3JB9PI9dSzQwLraR/vOPkQHW+RpxGdOt+/2nwvMA=');
var GENERATOR_X = bytes.hexToBytes('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
var GENERATOR_POINT = bytes.hexToBytes(
  '046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
  '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'
);

function MemoryStorage() { this.values = Object.create(null); }
MemoryStorage.prototype.get = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};
MemoryStorage.prototype.set = function (key, value) { this.values[key] = value; };
MemoryStorage.prototype.delete = function (key) { delete this.values[key]; };

function ManualTimer() {
  this.nextHandle = 1;
  this.pending = new Map();
}
ManualTimer.prototype.after = function (delayMillis, callback) {
  var handle = this.nextHandle;
  this.nextHandle += 1;
  this.pending.set(handle, { delayMillis: delayMillis, callback: callback });
  return handle;
};
ManualTimer.prototype.cancel = function (handle) { this.pending.delete(handle); };
ManualTimer.prototype.fireDelay = function (delayMillis) {
  var match = Array.from(this.pending.entries()).find(function (entry) {
    return entry[1].delayMillis === delayMillis;
  });
  if (!match) return false;
  this.pending.delete(match[0]);
  match[1].callback();
  return true;
};

async function waitForTimer(timer, delayMillis) {
  for (var attempt = 0; attempt < 50; attempt += 1) {
    if (Array.from(timer.pending.values()).some(function (entry) {
      return entry.delayMillis === delayMillis;
    })) return;
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  throw new Error('Timed out waiting for manual deadline ' + delayMillis + '.');
}

async function waitForCondition(predicate, message) {
  for (var attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise(function (resolve) { setImmediate(resolve); });
  }
  throw new Error(message);
}

function nestedBag(value) {
  return bplist.encodeBinaryPlist({ bag: bplist.encodeBinaryPlist(value) });
}

function fixtureMac() {
  return macAuth.parseMacAuthToken(JSON.stringify({
    inner: {
      productName: 'iMac13,1',
      ioMacAddress: bytes.bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6])),
      platformSerialNumber: 'SERIAL123',
      platformUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      rootDiskUuid: '11111111-2222-3333-4444-555555555555',
      boardId: 'Mac-BOARD',
      osBuildNum: '22G513',
      rom: bytes.bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6])),
      mlb: 'MLB-FIXTURE',
    },
    validationData: bytes.bytesToBase64(new Uint8Array(128).fill(7)),
    version: '13.6.4',
    protocolVersion: 1660,
  }));
}

function fixtureIdentityArtifact() {
  var rsa = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 1280 });
  var signingSpki = ngm.compactP256ToSpki(GENERATOR_X);
  var encryptionSpki = new Uint8Array(rsa.publicKey.export({ format: 'der', type: 'spki' }));
  var encodedIdentity = publicIdentity.encodePublicIdentity({
    signingPublicKey: GENERATOR_POINT,
    encryptionPublicKey: identities.rsaPkcs1FromSpki(encryptionSpki),
  });
  return {
    version: 1,
    legacySigningKeyId: 'legacy-signing',
    legacyEncryptionKeyId: 'legacy-encryption',
    deviceKeyId: 'ngm-device',
    preKeyId: 'ngm-prekey',
    legacySigningPublicKey: bytes.bytesToBase64(signingSpki),
    legacyEncryptionPublicKey: bytes.bytesToBase64(encryptionSpki),
    devicePublicKey: bytes.bytesToBase64(signingSpki),
    preKeyPublicKey: bytes.bytesToBase64(signingSpki),
    publicIdentity: bytes.bytesToBase64(encodedIdentity),
  };
}

function installReadyState(repository, pushToken, encodedIdentity, registrationVersion, serviceDataHash) {
  repository.update(function (draft) {
    draft.phase = 'ready';
    draft.account = { id: 'profile-fixture', handles: [SENDER] };
    draft.artifacts.provisioning = configuration.provisioningArtifact(fixtureMac(), null);
    draft.artifacts.push = configuration.pushArtifact({
      keyId: 'push-key', certificate: new Uint8Array([1, 2, 3]), token: pushToken,
    });
    draft.artifacts.authentication = {
      version: 1,
      userId: 'profile-fixture',
      userType: 'apple',
      protocolVersion: 1660,
      keyId: 'auth-key',
      certificate: bytes.bytesToBase64(CERTIFICATE),
    };
    draft.artifacts.registration = {
      version: registrationVersion === 1 ? 1 : registrationVersion === 2 ? 2 : 3,
      registrations: [{
        service: 'com.apple.madrid',
        userId: 'profile-fixture',
        keyId: 'ids-key',
        certificate: bytes.bytesToBase64(new Uint8Array([4, 5, 6])),
        handles: [SENDER],
        registeredAtSeconds: 1770000000,
        heartbeatIntervalSeconds: 3600,
      }],
    };
    if (draft.artifacts.registration.version === 2) {
      draft.artifacts.registration.pushToken = bytes.bytesToBase64(pushToken);
    } else if (draft.artifacts.registration.version === 3) {
      draft.artifacts.registration.pushToken = bytes.bytesToBase64(pushToken);
      draft.artifacts.registration.serviceDataHash = serviceDataHash;
    }
    draft.artifacts.identities.primary = encodedIdentity;
  });
}

function fixtureDelivery(participant, token, encodedIdentity, pairEc, certified) {
  var clientData = {
    'public-message-identity-key': encodedIdentity,
    'supports-certified-delivery-v1': certified === true,
  };
  var delivery = {
    'client-data': clientData,
    'push-token': token,
    'session-token': new Uint8Array([token[0], 0xaa, 0xbb]),
    'session-token-expires-seconds': 1700003600,
    'session-token-refresh-seconds': 1700001800,
  };
  if (pairEc) {
    clientData['public-message-ngm-device-prekey-data-key'] = new Uint8Array([0x0a, 0x01, 0x01]);
    delivery['kt-loggable-data'] = identities.buildKtLoggableData({ device: { compact: GENERATOR_X } });
  }
  return delivery;
}

function rawAck(id, status) {
  return raw.encodeRawAps(apsMessages.COMMAND.ACK, [
    { id: 4, value: bytes.uint32BE(id >>> 0) },
    { id: 8, value: new Uint8Array([status]) },
  ]);
}

function rawIncoming(id, topic, pushToken, value) {
  return raw.encodeRawAps(apsMessages.COMMAND.NOTIFICATION, [
    { id: 1, value: pushToken },
    { id: 2, value: topic },
    { id: 3, value: bplist.encodeBinaryPlist(value) },
    { id: 4, value: bytes.uint32BE(id >>> 0) },
  ]);
}

function int32Field(frame, id) {
  var value = frame.fields.find(function (field) { return field.id === id; }).value;
  var unsigned = bytes.readUint32BE(value);
  return unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
}

function FakeCourier(options) {
  this.pushToken = options.pushToken;
  this.lookupResults = options.lookupResults;
  this.callback = null;
  this.closed = 0;
  this.lookupTunnel = null;
  this.lookupTunnels = [];
  this.envelope = null;
  this.envelopes = [];
  this.envelopeApsIds = [];
  this.outgoingTopic = null;
  this.nextIncomingId = 1000;
  this.connectTokens = [];
  this.suppressLookupResult = options.suppressLookupResult === true;
  this.suppressLookupAfter = options.suppressLookupAfter === undefined
    ? null : options.suppressLookupAfter;
  this.suppressSendResults = options.suppressSendResults === true;
  this.suppressSendAcknowledgements = options.suppressSendAcknowledgements === true;
  this.sendAcknowledgementStatus = options.sendAcknowledgementStatus === undefined
    ? 0 : options.sendAcknowledgementStatus;
  this.sendStatusRounds = options.sendStatusRounds || null;
  this.sendRound = 0;
  this.sendResultCount = 0;
}
FakeCourier.prototype.open = function (_, callback) {
  var self = this;
  this.callback = callback;
  setImmediate(function () { callback({ type: 'open', protocol: 'apns-security-v3' }); });
  return {
    write: function (data) { self._write(data); },
    close: function () {
      self.closed += 1;
      setImmediate(function () { callback({ type: 'close' }); });
    },
  };
};
FakeCourier.prototype._emit = function (data) {
  this.callback({ type: 'data', data: data });
};
FakeCourier.prototype._write = function (data) {
  var self = this;
  var frame = raw.decodeRawApsFrame(data);
  if (frame.command === apsMessages.COMMAND.CONNECT) {
    var connectToken = frame.fields.find(function (field) { return field.id === 1; });
    this.connectTokens.push(connectToken ? new Uint8Array(connectToken.value) : null);
    setImmediate(function () {
      self._emit(raw.encodeRawAps(apsMessages.COMMAND.CONNECT_RESPONSE, [
        { id: 1, value: new Uint8Array([0]) },
        { id: 3, value: self.pushToken },
      ]));
    });
    return;
  }
  if (frame.command !== apsMessages.COMMAND.NOTIFICATION) return;
  var apsId = int32Field(frame, 4);
  var topic = frame.fields.find(function (field) { return field.id === 1; }).value;
  var payload = bplist.decodeBinaryPlist(
    frame.fields.find(function (field) { return field.id === 3; }).value
  );
  this.outgoingTopic = topic;
  if (payload.c === 96) {
    this.lookupTunnel = payload;
    this.lookupTunnels.push(payload);
    setImmediate(function () {
      self._emit(rawAck(apsId, 0));
      if (self.suppressLookupResult
          || (self.suppressLookupAfter !== null
            && self.lookupTunnels.length > self.suppressLookupAfter)) return;
      self._emit(rawIncoming(++self.nextIncomingId, topic, self.pushToken, {
        U: payload.U,
        b: gzip.gzip(xmlPlist.encodeXmlPlist({ status: 0, results: self.lookupResults })),
      }));
    });
    return;
  }
  if (payload.c === 100) {
    this.envelope = payload;
    this.envelopes.push(payload);
    this.envelopeApsIds.push(apsId);
    var statuses = Object.create(null);
    statuses[bytes.bytesToHex(new Uint8Array(32).fill(0x21))] = 7001;
    statuses[bytes.bytesToHex(new Uint8Array(32).fill(0x31))] = 0;
    statuses[bytes.bytesToHex(new Uint8Array(32).fill(0x22))] = 5008;
    if (this.sendStatusRounds) {
      statuses = this.sendStatusRounds[Math.min(this.sendRound, this.sendStatusRounds.length - 1)];
    }
    this.sendRound += 1;
    setImmediate(function () {
      if (!self.suppressSendAcknowledgements) self._emit(rawAck(apsId, self.sendAcknowledgementStatus));
      if (self.suppressSendResults) return;
      payload.dtl.forEach(function (target) {
        var status = statuses[bytes.bytesToHex(target.t)];
        if (status === undefined) return;
        self.sendResultCount += 1;
        self._emit(rawIncoming(++self.nextIncomingId, topic, self.pushToken, {
          c: 255,
          U: payload.U,
          t: target.t,
          s: status,
        }));
      });
    });
  }
};

function FixtureCrypto() {
  this.randomCalls = [];
  this.signCalls = [];
}
FixtureCrypto.prototype.digest = function (algorithm, data) {
  return new Uint8Array(nodeCrypto.createHash(algorithm).update(data).digest());
};
FixtureCrypto.prototype.sign = function (keyId, specification, data) {
  this.signCalls.push({ keyId: keyId, specification: specification, data: new Uint8Array(data) });
  if (specification.algorithm === 'ecdsa') return new Uint8Array(64).fill(0x33);
  return new Uint8Array([0x44, 0x55]);
};
FixtureCrypto.prototype.random = function (length) {
  this.randomCalls.push(length);
  return new Uint8Array(length).fill(0x71);
};

function buildFixture(options) {
  options = options || {};
  var storage = new MemoryStorage();
  var pushToken = options.pushToken || new Uint8Array(32).fill(0x11);
  var connectedPushToken = options.connectedPushToken || pushToken;
  var identityArtifact = fixtureIdentityArtifact();
  var encodedIdentity = bytes.base64ToBytes(identityArtifact.publicIdentity);
  var lookupResults = {};
  lookupResults[RECIPIENT] = {
    identities: [
      fixtureDelivery(RECIPIENT, new Uint8Array(32).fill(0x21), encodedIdentity, true, true),
      fixtureDelivery(RECIPIENT, new Uint8Array(32).fill(0x22), encodedIdentity, false, false),
      fixtureDelivery(RECIPIENT, connectedPushToken, encodedIdentity, false, false),
    ],
  };
  lookupResults[SENDER] = {
    identities: [fixtureDelivery(SENDER, new Uint8Array(32).fill(0x31), encodedIdentity, false, false)],
  };
  var refreshHandles = options.refreshHandles || [SENDER];
  refreshHandles.forEach(function (handle) {
    if (!lookupResults[handle]) {
      lookupResults[handle] = {
        identities: [fixtureDelivery(handle, new Uint8Array(32).fill(0x31), encodedIdentity, false, false)],
      };
    }
  });
  var courier = new FakeCourier({
    pushToken: connectedPushToken,
    lookupResults: lookupResults,
    suppressLookupResult: options.suppressLookupResult,
    suppressLookupAfter: options.suppressLookupAfter,
    suppressSendResults: options.suppressSendResults,
    suppressSendAcknowledgements: options.suppressSendAcknowledgements,
    sendAcknowledgementStatus: options.sendAcknowledgementStatus,
    sendStatusRounds: options.sendStatusRounds,
  });
  var randomCounter = 0;
  var registrationRequests = [];
  var control = { registrationFailure: options.registrationFailure === true };
  var validationFactoryCalls = [];
  var validationCalls = [];
  var validationRequestCounts = [];
  var generatedValidationData = [];
  var validationDataGeneratorFactory = function (endpoints) {
    validationFactoryCalls.push(endpoints);
    return {
      generate: async function (hardware) {
        validationCalls.push(hardware);
        validationRequestCounts.push(registrationRequests.length);
        var fresh = new Uint8Array([0xb0 + validationCalls.length, 0x66]);
        generatedValidationData.push(fresh);
        return fresh;
      },
    };
  };
  var timer = new ManualTimer();
  var effects = createEffects({
    clock: { now: function () { return 1770000123456; } },
    timer: timer,
    random: {
      bytes: function (length) {
        randomCounter += 1;
        return new Uint8Array(length).fill(randomCounter & 0xff);
      },
    },
    storage: storage,
    http: {
      request: async function (request) {
        if (request.url === apsBag.IDS_BAG_URL) {
          return {
            status: 200,
            headers: [],
            body: nestedBag({
              'id-authenticate-ds-id': 'https://identity.apple.com/authenticate',
              'id-get-handles': 'https://identity.apple.com/handles',
              'id-register': 'https://identity.apple.com/register',
              'id-query': 'https://identity.apple.com/id-query',
              'id-validation-cert': 'https://identity.apple.com/validation/cert',
              'id-initialize-validation': 'https://identity.apple.com/validation/initialize',
            }),
          };
        }
        if (request.url === apsBag.APNS_BAG_URL) {
          return {
            status: 200,
            headers: [],
            body: nestedBag({
              APNSCourierHostname: 'courier.push.example.invalid',
              APNSCourierHostcount: 3,
            }),
          };
        }
        if (request.url === 'https://identity.apple.com/handles') {
          registrationRequests.push(request);
          return {
            status: 200,
            headers: [],
            body: xmlPlist.encodeXmlPlist({
              status: 0,
              handles: refreshHandles.map(function (handle) { return { uri: handle }; }),
            }),
          };
        }
        if (request.url === 'https://identity.apple.com/register') {
          registrationRequests.push(request);
          if (control.registrationFailure) throw new Error('synthetic IDS refresh failure');
          return {
            status: 200,
            headers: [],
            body: xmlPlist.encodeXmlPlist({
              status: 0,
              services: [{
                service: 'com.apple.madrid',
                users: [{
                  status: 0,
                  'user-id': 'profile-fixture',
                  cert: CERTIFICATE,
                  'next-hbi': 3600,
                  uris: refreshHandles.map(function (handle) { return { status: 0, uri: handle }; }),
                }],
              }],
            }),
          };
        }
        throw new Error('Unexpected HTTP URL.');
      },
    },
    tls: courier,
  });
  var repository = new DurableStateRepository(effects, { storagePrefix: 'send.e2e' });
  installReadyState(
    repository,
    pushToken,
    identityArtifact,
    options.registrationVersion,
    registration.madridServiceDataHash(new FixtureCrypto())
  );
  return {
    storage: storage,
    timer: timer,
    effects: effects,
    repository: repository,
    courier: courier,
    crypto: new FixtureCrypto(),
    registrationRequests: registrationRequests,
    control: control,
    pushToken: pushToken,
    connectedPushToken: connectedPushToken,
    validationDataGeneratorFactory: validationDataGeneratorFactory,
    validationFactoryCalls: validationFactoryCalls,
    validationCalls: validationCalls,
    validationRequestCounts: validationRequestCounts,
    generatedValidationData: generatedValidationData,
  };
}

function fixtureEncryptionDependencies() {
  return {
    encryptPairEc: function () {
      return { payload: new Uint8Array([0xec, 1]), format: 'pair-ec' };
    },
    encryptLegacyPayload: function () { return new Uint8Array([0x02, 0x71]); },
  };
}

function statusRound(entries) {
  var result = Object.create(null);
  entries.forEach(function (entry) {
    result[bytes.bytesToHex(new Uint8Array(32).fill(entry[0]))] = entry[1];
  });
  return result;
}

test('cold-start send restores durable artifacts and completes mixed pair-ec/legacy delivery through fake APS', async function () {
  var fixture = buildFixture();
  fixture.repository.update(function (draft) {
    draft.artifacts.provisioning.mac = Object.assign({}, draft.artifacts.provisioning.mac, {
      validationData: bytes.bytesToBase64(new Uint8Array(128).fill(7)),
    });
  });
  var encrypted = [];
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: {
      encryptPairEc: function (options) {
        encrypted.push({ format: 'pair-ec', body: new Uint8Array(options.message) });
        assert.equal(fixture.repository.load().counters['fixture-counter'], undefined);
        var reserved = options.reserveCounter('fixture-counter');
        assert.equal(fixture.repository.load().counters['fixture-counter'], reserved);
        return { payload: new Uint8Array([0xec, reserved]), format: 'pair-ec' };
      },
      encryptLegacyPayload: function (_, options) {
        encrypted.push({ format: 'pair', body: new Uint8Array(options.body) });
        assert.deepEqual(options.randomKeyBytes, new Uint8Array(11).fill(0x71));
        return new Uint8Array([0x02, options.randomKeyBytes[0]]);
      },
    },
  });

  var result = await subject.send({ recipient: RECIPIENT, text: 'exact offline send text 🪶' });
  assert.equal(result.recipient, RECIPIENT);
  assert.match(result.messageId, /^[0-9A-F-]{36}$/);
  assert.equal(fixture.courier.closed, 1);
  assert.equal(fixture.repository.load().artifacts.provisioning.mac.validationData, null);
  assert.equal(fixture.repository.load().counters['fixture-counter'], 1);
  assert.deepEqual(encrypted.map(function (item) { return item.format; }), ['pair-ec', 'pair', 'pair']);
  assert.deepEqual(encrypted[0].body, encrypted[1].body);
  var plaintext = bplist.decodeBinaryPlist(gzip.ungzip(encrypted[0].body));
  assert.equal(plaintext.t, 'exact offline send text 🪶');
  assert.deepEqual(plaintext.p, [RECIPIENT, SENDER]);

  var lookupRequest = xmlPlist.decodeXmlPlist(gzip.ungzip(fixture.courier.lookupTunnel.b));
  assert.deepEqual(lookupRequest.uris, [RECIPIENT, SENDER]);
  assert.equal(fixture.courier.lookupTunnel.u, 'https://identity.apple.com/id-query');
  assert.equal(fixture.courier.lookupTunnel.h['x-id-self-uri'], SENDER);

  var bundles = fixture.courier.envelope.dtl;
  assert.equal(bundles.length, 3);
  assert.equal(bundles[0].tP, RECIPIENT);
  assert.equal(bundles[0].E, 'pair-ec');
  assert.equal(bundles[0].cdv, 1);
  assert.equal(bundles[0].D, true);
  assert.equal(bundles[1].tP, RECIPIENT);
  assert.equal(Object.prototype.hasOwnProperty.call(bundles[1], 'E'), false);
  assert.equal(bundles[2].tP, SENDER);
  assert.equal(bundles[2].D, false);
  assert.equal(bundles.some(function (bundle) { return bytes.bytesEqual(bundle.t, new Uint8Array(32).fill(0x11)); }), false);
  assert.deepEqual(fixture.courier.outgoingTopic, new Uint8Array(nodeCrypto.createHash('sha1').update('com.apple.madrid').digest()));
  assert.equal(fixture.crypto.signCalls.some(function (call) { return call.keyId === 'ids-key'; }), true);
  assert.equal(fixture.crypto.signCalls.some(function (call) { return call.keyId === 'push-key'; }), true);
  assert.equal(fixture.crypto.randomCalls.includes(11), true);
  assert.equal(JSON.stringify(fixture.storage.values).includes('exact offline send text'), false);
});

test('explicit registered send-from selection drives IDS lookup and outgoing plaintext metadata', async function () {
  var fixture = buildFixture();
  fixture.repository.update(function (draft) {
    draft.account.handles.push(PHONE_SENDER);
    draft.artifacts.registration.registrations[0].handles.push(PHONE_SENDER);
  });
  fixture.courier.lookupResults[PHONE_SENDER] = fixture.courier.lookupResults[SENDER];
  var encryptedBodies = [];
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    sender: PHONE_SENDER,
    dependencies: {
      encryptPairEc: function (options) {
        encryptedBodies.push(new Uint8Array(options.message));
        return { payload: new Uint8Array([0xec, 1]), format: 'pair-ec' };
      },
      encryptLegacyPayload: function (_, options) {
        encryptedBodies.push(new Uint8Array(options.body));
        return new Uint8Array([0x02, 0x71]);
      },
    },
  });

  await subject.send({ recipient: RECIPIENT, text: 'phone sender fixture' });

  var lookupRequest = xmlPlist.decodeXmlPlist(gzip.ungzip(fixture.courier.lookupTunnel.b));
  assert.equal(fixture.courier.lookupTunnel.h['x-id-self-uri'], PHONE_SENDER);
  assert.deepEqual(lookupRequest.uris, [RECIPIENT, PHONE_SENDER]);
  var plaintext = bplist.decodeBinaryPlist(gzip.ungzip(encryptedBodies[0]));
  assert.deepEqual(plaintext.p, [RECIPIENT, PHONE_SENDER]);
  var pairEcTarget = fixture.courier.envelope.dtl.find(function (target) { return target.E === 'pair-ec'; });
  assert.equal(pairEcTarget.tP, RECIPIENT);
  assert.equal(fixture.courier.envelope.dtl.some(function (target) {
    return target.tP === PHONE_SENDER;
  }), true);
});

test('large encrypted device payloads use sequential RustPush-compatible fcn envelopes', async function () {
  var fixture = buildFixture();
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: {
      encryptPairEc: function () {
        return { payload: new Uint8Array(5001).fill(0xec), format: 'pair-ec' };
      },
      encryptLegacyPayload: function () { return new Uint8Array(5001).fill(0x71); },
    },
  });

  var result = await subject.send({ recipient: RECIPIENT, text: 'batched send text' });

  assert.equal(result.recipient, RECIPIENT);
  assert.equal(fixture.courier.envelopes.length, 3);
  assert.deepEqual(fixture.courier.envelopes.map(function (envelope) { return envelope.fcn; }), [1, 2, 3]);
  assert.deepEqual(fixture.courier.envelopes.map(function (envelope) { return envelope.dtl.length; }), [1, 1, 1]);
  assert.equal(new Set(fixture.courier.envelopeApsIds).size, 1);
  assert.equal(new Set(fixture.courier.envelopes.map(function (envelope) { return envelope.i; })).size, 1);
  fixture.courier.envelopes.slice(1).forEach(function (envelope) {
    assert.deepEqual(envelope.U, fixture.courier.envelopes[0].U);
  });
});

test('send refuses non-ready state before network or plaintext composition', async function () {
  var storage = new MemoryStorage();
  var requests = 0;
  var effects = createEffects({
    storage: storage,
    clock: { now: function () { return 1770000123456; } },
    random: { bytes: function (length) { return new Uint8Array(length); } },
    http: { request: async function () { requests += 1; throw new Error('must not request'); } },
  });
  var subject = new SendCoordinator({
    effects: effects,
    crypto: new FixtureCrypto(),
    repository: new DurableStateRepository(effects, { storagePrefix: 'send.not-ready' }),
  });
  await assert.rejects(subject.send({ recipient: RECIPIENT, text: 'not sent' }), function (error) {
    return error.code === 'AUTH_REQUIRED';
  });
  assert.equal(requests, 0);
});

test('silent IDS lookup has one bounded deadline, closes APS, and ignores late work', async function () {
  var fixture = buildFixture({ suppressLookupResult: true });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
    lookupTimeoutMillis: 1234,
  });

  var pending = subject.send({ recipient: RECIPIENT, text: 'lookup timeout text' });
  await waitForTimer(fixture.timer, 1234);
  assert.equal(fixture.timer.fireDelay(1234), true);
  await assert.rejects(pending, function (error) {
    return error.code === 'IDS_LOOKUP_TIMEOUT'
      && error.kind === 'timeout'
      && error.retryable === true
      && error.details.timeoutMillis === 1234;
  });
  assert.equal(fixture.courier.closed, 1);
  assert.notEqual(fixture.courier.lookupTunnel, null);
  assert.equal(fixture.courier.envelope, null);
  assert.equal(fixture.timer.pending.size, 0);
  assert.equal(JSON.stringify(fixture.storage.values).includes('lookup timeout text'), false);
});

test('lookup completion consumes its successful APS acknowledgement after an early result', async function () {
  var fixture = buildFixture();
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
  });
  var expected = { recipient: { identities: [] } };
  var queued = [
    { type: 'lookupResult', apsId: 42, results: expected },
    { type: 'sendAcknowledged', id: 42, status: 0 },
  ];
  var events = {
    next: async function (predicate) {
      var index = queued.findIndex(predicate);
      assert.notEqual(index, -1);
      return queued.splice(index, 1)[0];
    },
    fail: function (error) { throw error; },
  };

  assert.equal(await subject._waitForLookup(events, 42), expected);
  assert.equal(queued.length, 0);
});

test('silent per-device send results have one whole-phase deadline and never report success', async function () {
  var fixture = buildFixture({ suppressSendResults: true });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
    sendResultTimeoutMillis: 2345,
  });

  var pending = subject.send({ recipient: RECIPIENT, text: 'send timeout text' });
  await waitForTimer(fixture.timer, 2345);
  assert.equal(fixture.timer.fireDelay(2345), true);
  await assert.rejects(pending, function (error) {
    return error.code === 'IMESSAGE_SEND_TIMEOUT'
      && error.kind === 'timeout'
      && error.retryable === true
      && error.details.timeoutMillis === 2345
      && error.details.expectedTargets === 3;
  });
  assert.equal(fixture.courier.closed, 1);
  assert.notEqual(fixture.courier.envelope, null);
  assert.equal(fixture.timer.pending.size, 0);
  assert.equal(JSON.stringify(fixture.storage.values).includes('send timeout text'), false);
});

test('delivery results cannot bypass the bounded APS acknowledgement required before the next batch', async function () {
  var fixture = buildFixture({
    suppressSendAcknowledgements: true,
    sendStatusRounds: [statusRound([[0x21, 0], [0x22, 5008], [0x31, 0]])],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: {
      encryptPairEc: function () {
        return { payload: new Uint8Array(5001).fill(0xec), format: 'pair-ec' };
      },
      encryptLegacyPayload: function () { return new Uint8Array(5001).fill(0x71); },
    },
    sendAckTimeoutMillis: 1234,
  });

  var pending = subject.send({ recipient: RECIPIENT, text: 'missing APS acknowledgement' });
  await waitForTimer(fixture.timer, 1234);
  await waitForCondition(function () { return fixture.courier.sendResultCount === 1; }, 'Expected early delivery result.');
  assert.equal(fixture.timer.fireDelay(1234), true);
  await assert.rejects(pending, function (error) {
    return error.code === 'IMESSAGE_SEND_ACK_TIMEOUT'
      && error.kind === 'timeout'
      && error.retryable === true
      && error.details.timeoutMillis === 1234
      && error.details.batch === 1
      && error.details.batchCount === 3;
  });
  assert.equal(fixture.courier.envelopes.length, 1);
  assert.equal(fixture.courier.sendResultCount, 1);
  assert.equal(fixture.courier.closed, 1);
});

test('non-zero APS acknowledgement rejects the send before delivery results can report success', async function () {
  var fixture = buildFixture({ sendAcknowledgementStatus: 7 });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
  });

  await assert.rejects(subject.send({ recipient: RECIPIENT, text: 'rejected APS acknowledgement' }), function (error) {
    return error.code === 'IMESSAGE_SEND_REJECTED'
      && error.kind === 'transport'
      && error.details.status === 7
      && error.details.batch === 1
      && error.details.batchCount === 1;
  });
  assert.equal(fixture.courier.envelopes.length, 1);
  assert.equal(fixture.courier.closed, 1);
});

test('APS acknowledgement waits drain supported large-fanout delivery bursts', async function () {
  var fixture = buildFixture();
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
  });
  var targets = Array.from({ length: 300 }, function (_, index) {
    var token = new Uint8Array(32);
    token[0] = (index >>> 8) & 0xff;
    token[1] = index & 0xff;
    return { participant: RECIPIENT, pushToken: token };
  });
  var tracker = new sendRetry.SendResultTracker(SENDER, targets);
  var queued = targets.map(function (target) {
    return { type: 'sendResult', apsId: 42, pushToken: target.pushToken, status: 0 };
  });
  queued.push({ type: 'sendAcknowledged', id: 42, status: 0 });
  var events = {
    next: async function (predicate) {
      var index = queued.findIndex(predicate);
      assert.notEqual(index, -1);
      return queued.splice(index, 1)[0];
    },
    fail: function (error) { throw error; },
  };

  var outcome = await subject._waitForSendAcknowledgement(events, 42, 1, 2, tracker);
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.remaining, 0);
  assert.equal(queued.length, 0);
});

test('5032 refreshes only stale device keys and retries the same UUID with exact epoch nanos', async function () {
  var fixture = buildFixture({
    sendStatusRounds: [
      statusRound([[0x21, 5032], [0x22, 7001], [0x31, 0]]),
      statusRound([[0x21, 0]]),
    ],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
  });

  var result = await subject.send({ recipient: RECIPIENT, text: 'stale key retry text' });
  assert.equal(result.recipient, RECIPIENT);
  assert.equal(fixture.courier.lookupTunnels.length, 2);
  assert.equal(fixture.courier.envelopes.length, 2);
  var refreshLookup = xmlPlist.decodeXmlPlist(gzip.ungzip(fixture.courier.lookupTunnels[1].b));
  assert.deepEqual(refreshLookup.uris, [RECIPIENT]);
  assert.deepEqual(fixture.courier.envelopes[1].U, fixture.courier.envelopes[0].U);
  assert.equal(Object.prototype.hasOwnProperty.call(fixture.courier.envelopes[0], 'rc'), false);
  assert.equal(fixture.courier.envelopes[1].rc, 1);
  assert.equal(fixture.courier.envelopes[1].oe, 1770000123456000000n);
  assert.equal(fixture.courier.envelopes[1].dtl.length, 1);
  assert.deepEqual(fixture.courier.envelopes[1].dtl[0].t, new Uint8Array(32).fill(0x21));
  assert.equal(JSON.stringify(fixture.storage.values).includes('stale key retry text'), false);
});

test('a confirmed recipient remains successful if best-effort stale-device refresh times out', async function () {
  var fixture = buildFixture({
    suppressLookupAfter: 1,
    sendStatusRounds: [statusRound([[0x21, 0], [0x22, 5032], [0x31, 0]])],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
    lookupTimeoutMillis: 3456,
  });

  var pending = subject.send({ recipient: RECIPIENT, text: 'partial success refresh text' });
  await waitForCondition(function () {
    return fixture.courier.lookupTunnels.length === 2;
  }, 'Timed out waiting for the stale-device refresh lookup.');
  await waitForTimer(fixture.timer, 3456);
  assert.equal(fixture.timer.fireDelay(3456), true);
  var result = await pending;
  assert.equal(result.recipient, RECIPIENT);
  assert.equal(fixture.courier.envelopes.length, 1);
  assert.equal(fixture.courier.lookupTunnels.length, 2);
  assert.equal(fixture.courier.closed, 1);
});

test('a confirmed recipient remains successful when another device never returns a result', async function () {
  var fixture = buildFixture({
    sendStatusRounds: [statusRound([[0x21, 0]])],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
    sendResultTimeoutMillis: 4567,
  });

  var pending = subject.send({ recipient: RECIPIENT, text: 'partial result timeout text' });
  await waitForCondition(function () {
    return fixture.courier.nextIncomingId === 1001;
  }, 'Timed out waiting for the successful recipient result.');
  await new Promise(function (resolve) { setImmediate(resolve); });
  await waitForTimer(fixture.timer, 4567);
  assert.equal(fixture.timer.fireDelay(4567), true);
  var result = await pending;
  assert.equal(result.recipient, RECIPIENT);
  assert.equal(fixture.courier.envelopes.length, 1);
  assert.equal(fixture.courier.closed, 1);
});

test('repeated 5032 retries stop after the RustPush-compatible bound', async function () {
  var staleRound = statusRound([[0x21, 5032], [0x22, 5032], [0x31, 5032]]);
  var fixture = buildFixture({
    sendStatusRounds: [staleRound, staleRound, staleRound, staleRound, staleRound, staleRound],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: fixtureEncryptionDependencies(),
  });

  await assert.rejects(
    subject.send({ recipient: RECIPIENT, text: 'bounded stale retry text' }),
    function (error) {
      return error.code === 'IMESSAGE_SEND_RETRY_EXHAUSTED'
        && error.retryable === true
        && error.details.retryCount === 5;
    }
  );
  assert.equal(fixture.courier.envelopes.length, 6);
  assert.equal(fixture.courier.lookupTunnels.length, 6);
  assert.deepEqual(
    fixture.courier.envelopes.map(function (envelope) { return envelope.rc || 0; }),
    [0, 1, 2, 3, 4, 5]
  );
  assert.equal(fixture.timer.pending.size, 0);
  assert.equal(JSON.stringify(fixture.storage.values).includes('bounded stale retry text'), false);
});

test('replacement APNs token is re-registered and durable before send, then reused after cold restart', async function () {
  var replacement = new Uint8Array(32).fill(0x12);
  var fixture = buildFixture({ connectedPushToken: replacement });
  var dependencies = fixtureEncryptionDependencies();

  var first = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });
  await first.send({ recipient: RECIPIENT, text: 'rotation one' });

  var rotated = fixture.repository.load();
  assert.equal(rotated.artifacts.registration.version, 3);
  assert.deepEqual(bytes.base64ToBytes(rotated.artifacts.push.token), replacement);
  assert.deepEqual(bytes.base64ToBytes(rotated.artifacts.registration.pushToken), replacement);
  assert.equal(fixture.registrationRequests.length, 2);
  fixture.registrationRequests.forEach(function (request) {
    var header = request.headers.find(function (entry) { return entry[0] === 'x-push-token'; });
    assert.equal(header[1], bytes.bytesToBase64(replacement));
  });
  var registrationRequest = fixture.registrationRequests.find(function (request) {
    return request.url === 'https://identity.apple.com/register';
  });
  assert.deepEqual(
    xmlPlist.decodeXmlPlist(gzip.ungzip(registrationRequest.body))['validation-data'],
    new Uint8Array([0xb1, 0x66])
  );
  assert.equal(fixture.validationFactoryCalls.length, 1);
  assert.deepEqual(fixture.validationRequestCounts, [1]);
  assert.equal(fixture.validationCalls[0].platformSerialNumber, 'SERIAL123');
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(2)]);
  assert.deepEqual(fixture.courier.connectTokens[0], fixture.pushToken);

  var cold = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: new DurableStateRepository(fixture.effects, { storagePrefix: 'send.e2e' }),
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });
  await cold.send({ recipient: RECIPIENT, text: 'rotation two' });
  assert.deepEqual(fixture.courier.connectTokens[1], replacement);
  assert.equal(fixture.registrationRequests.length, 2);
});

test('lazy registration falls back and persists when the selected sender is no longer registered', async function () {
  var replacement = new Uint8Array(32).fill(0x14);
  var fixture = buildFixture({
    connectedPushToken: replacement,
    refreshHandles: [PHONE_SENDER],
  });
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    sender: SENDER,
    dependencies: fixtureEncryptionDependencies(),
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });

  await subject.send({ recipient: RECIPIENT, text: 'sender fallback' });

  assert.deepEqual(fixture.repository.load().account.handles, [PHONE_SENDER]);
  assert.equal(fixture.courier.lookupTunnel.h['x-id-self-uri'], PHONE_SENDER);
  assert.deepEqual(
    xmlPlist.decodeXmlPlist(gzip.ungzip(fixture.courier.lookupTunnel.b)).uris,
    [RECIPIENT, PHONE_SENDER]
  );

  await subject.send({ recipient: RECIPIENT, text: 'sender fallback reused' });
  assert.equal(fixture.registrationRequests.length, 2);
  assert.equal(fixture.courier.lookupTunnel.h['x-id-self-uri'], PHONE_SENDER);
});

test('expired registration heartbeat is renewed lazily before send and reused after cold restart', async function () {
  var fixture = buildFixture();
  fixture.repository.update(function (draft) {
    draft.artifacts.registration.registrations[0].registeredAtSeconds = 1770000123 - 3600;
  });
  var dependencies = fixtureEncryptionDependencies();

  var first = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });
  await first.send({ recipient: RECIPIENT, text: 'heartbeat refresh' });

  assert.equal(fixture.registrationRequests.length, 2);
  assert.equal(
    fixture.repository.load().artifacts.registration.registrations[0].registeredAtSeconds,
    1770000123
  );
  assert.equal(fixture.validationFactoryCalls.length, 1);

  var cold = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: new DurableStateRepository(fixture.effects, { storagePrefix: 'send.e2e' }),
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });
  await cold.send({ recipient: RECIPIENT, text: 'heartbeat still current' });
  assert.equal(fixture.registrationRequests.length, 2);
  assert.equal(fixture.validationFactoryCalls.length, 1);
});

test('replacement-token registration failure persists recovery state and cannot send an envelope', async function () {
  var replacement = new Uint8Array(32).fill(0x13);
  var fixture = buildFixture({
    connectedPushToken: replacement,
    registrationFailure: true,
    registrationVersion: 1,
  });
  var dependencies = fixtureEncryptionDependencies();
  var subject = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });

  await assert.rejects(
    subject.send({ recipient: RECIPIENT, text: 'must not report sent' }),
    function (error) { return error.code === 'IMESSAGE_SEND_FAILED'; }
  );
  var interrupted = fixture.repository.load();
  assert.deepEqual(bytes.base64ToBytes(interrupted.artifacts.push.token), replacement);
  assert.equal(interrupted.artifacts.registration.version, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(interrupted.artifacts.registration, 'pushToken'), false);
  assert.equal(fixture.courier.lookupTunnel, null);
  assert.equal(fixture.courier.envelope, null);
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(2)]);

  fixture.control.registrationFailure = false;
  var recovered = new SendCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: new DurableStateRepository(fixture.effects, { storagePrefix: 'send.e2e' }),
    dependencies: dependencies,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory,
  });
  await recovered.send({ recipient: RECIPIENT, text: 'recovered after restart' });
  assert.deepEqual(fixture.courier.connectTokens[1], replacement);
  assert.deepEqual(
    bytes.base64ToBytes(fixture.repository.load().artifacts.registration.pushToken),
    replacement
  );
  assert.equal(fixture.validationFactoryCalls.length, 2);
  assert.equal(fixture.generatedValidationData[0] === fixture.generatedValidationData[1], false);
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(2), new Uint8Array(2)]);
  var registrationBodies = fixture.registrationRequests.filter(function (request) {
    return request.url === 'https://identity.apple.com/register';
  }).map(function (request) {
    return xmlPlist.decodeXmlPlist(gzip.ungzip(request.body))['validation-data'];
  });
  assert.deepEqual(registrationBodies, [
    new Uint8Array([0xb1, 0x66]), new Uint8Array([0xb2, 0x66]),
  ]);
});

test('connection refresh opens and closes APS without looking up a recipient or sending a message', async function () {
  var fixture = buildFixture();
  var subject = new SendCoordinator({ effects: fixture.effects, crypto: fixture.crypto, repository: fixture.repository,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory });
  assert.deepEqual(await subject.refresh(), { ready: true });
  assert.equal(fixture.courier.connectTokens.length, 1);
  assert.equal(fixture.courier.closed, 1);
  assert.equal(fixture.courier.lookupTunnels.length, 0);
  assert.equal(fixture.courier.envelopes.length, 0);
  assert.equal(subject.busy, false);
});

test('connection refresh renews an expired registration without accessing other chats', async function () {
  var fixture = buildFixture();
  fixture.repository.update(function (draft) { draft.artifacts.registration.registrations[0].registeredAtSeconds = 1770000123 - 3600; });
  var subject = new SendCoordinator({ effects: fixture.effects, crypto: fixture.crypto, repository: fixture.repository,
    validationDataGeneratorFactory: fixture.validationDataGeneratorFactory });
  await subject.refresh();
  assert.equal(fixture.registrationRequests.length, 2);
  assert.equal(fixture.courier.lookupTunnels.length, 0);
  assert.equal(fixture.courier.envelopes.length, 0);
  assert.equal(fixture.courier.closed, 1);
});
