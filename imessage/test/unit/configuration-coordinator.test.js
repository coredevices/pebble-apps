'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

var anisetteRemote = require('../../src/anisette/remote-v3');
var bytes = require('../../src/runtime/bytes');
var createEffects = require('../../src/runtime/effects').createEffects;
var RuntimeError = require('../../src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../src/runtime/errors').ERROR_KINDS;
var coordinatorModule = require('../../src/configuration/coordinator');
var macAuthorization = require('../../src/configuration/mac-auth-token');
var ApsProvisioner = coordinatorModule.ApsProvisioner;
var ConfigurationCoordinator = coordinatorModule.ConfigurationCoordinator;
var RemoteV3AnisetteClient = coordinatorModule.RemoteV3AnisetteClient;
var DurableStateRepository = require('../../src/state/durable-state-repository').DurableStateRepository;

function macTokenValue() {
  return {
    inner: {
      productName: 'Mac15,3',
      ioMacAddress: [0, 17, 34, 51, 68, 85],
      platformSerialNumber: 'SERIAL-FIXTURE',
      platformUuid: '11111111-2222-3333-4444-555555555555',
      rootDiskUuid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
      boardId: 'Mac-FAKEBOARD',
      osBuildNum: '23E224',
      platformSerialNumberEnc: new Array(17).fill(1),
      platformUuidEnc: new Array(17).fill(2),
      rootDiskUuidEnc: new Array(17).fill(3),
      rom: [0, 17, 34, 51, 68, 85],
      romEnc: new Array(17).fill(4),
      mlb: 'MLB-FIXTURE-0000001',
      mlbEnc: new Array(17).fill(5),
    },
    validationData: Array.from(new Uint8Array(128).fill(9)),
    version: '14.4.1',
    protocolVersion: 1701,
    deviceId: 'DEVICE-ID-FIXTURE',
    pushBootstrap: {
      certificateDer: [0x30, 1, 2, 3],
      privateKeyPkcs8: [0x30, 4, 5, 6],
      token: Array.from(new Uint8Array(32).fill(4)),
    },
  };
}

function configurationCredentials(password) {
  return {
    username: 'account@example.test',
    password: password || 'ephemeral-password',
    macValidationData: JSON.stringify(macTokenValue()),
  };
}

function MemoryStorage() {
  this.values = Object.create(null);
  this.mutation = 0;
  this.failure = null;
}

function ManualTimer() {
  this.nextHandle = 1;
  this.pending = new Map();
  this.delays = [];
}
ManualTimer.prototype.after = function (delayMillis, callback) {
  var handle = this.nextHandle;
  this.nextHandle += 1;
  this.delays.push(delayMillis);
  this.pending.set(handle, callback);
  return handle;
};
ManualTimer.prototype.cancel = function (handle) { this.pending.delete(handle); };
ManualTimer.prototype.fireNext = function () {
  var entry = this.pending.entries().next();
  if (entry.done) throw new Error('No pending timer.');
  this.pending.delete(entry.value[0]);
  entry.value[1]();
};
MemoryStorage.prototype.get = function (key) { return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null; };
MemoryStorage.prototype.set = function (key, value) {
  this._mutate(function () { this.values[key] = value; });
};
MemoryStorage.prototype.delete = function (key) {
  this._mutate(function () { delete this.values[key]; });
};
MemoryStorage.prototype.armFailure = function (mutation, after) {
  this.mutation = 0;
  this.failure = { mutation: mutation, after: after };
};
MemoryStorage.prototype._mutate = function (operation) {
  this.mutation += 1;
  var fail = this.failure && this.failure.mutation === this.mutation;
  if (fail && !this.failure.after) throw new Error('simulated crash before storage mutation');
  operation.call(this);
  if (fail) throw new Error('simulated crash after storage mutation');
};

function fixtures() {
  var storage = new MemoryStorage();
  var traces = [];
  var randomCounter = 0;
  var effects = createEffects({
    clock: { now: function () { return 1770000123456; } },
    random: { bytes: function (length) { randomCounter += 1; return new Uint8Array(length).fill(randomCounter); } },
    http: { request: async function () { throw new Error('unexpected HTTP'); } },
    storage: storage,
    trace: { emit: function (event) { traces.push(event); } },
  });
  var repository = new DurableStateRepository(effects, { storagePrefix: 'coordinator.test' });
  var deleted = [];
  var crypto = { deleteKey: function (id) { deleted.push(id); return true; } };
  var validationCalls = [];
  var generatedValidationData = [];
  var validationDataGenerator = {
    generate: async function (hardware) {
      validationCalls.push(hardware);
      var fresh = new Uint8Array([0xa0 + validationCalls.length, 0x55]);
      generatedValidationData.push(fresh);
      return fresh;
    },
  };
  var anisetteArtifact = {
    version: 1, keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16).fill(1)), adiPb: 'AgM=',
  };
  var push = {
    keyId: 'push-key', certificate: new Uint8Array([1, 2, 3]), token: new Uint8Array(32).fill(4), created: true,
    keyRecord: { id: 'push-key', purpose: 'aps-signing' },
    artifact: { version: 1, keyId: 'push-key', certificate: 'AQID', token: bytes.bytesToBase64(new Uint8Array(32).fill(4)) },
  };
  var anisette = {
    ensureCalls: 0,
    setClientInfo: function (value) { this.clientInfo = value; },
    ensureProvisioned: async function (artifact) {
      this.ensureCalls += 1;
      this.receivedArtifact = artifact;
      return { artifact: artifact || anisetteArtifact, created: !artifact };
    },
    getHeaders: async function () { return [['X-Apple-I-MD', 'ephemeral-otp']]; },
  };
  var pushClient = {
    disconnected: 0,
    ensureCalls: 0,
    ensureProvisioned: async function (artifact, mac) {
      this.ensureCalls += 1;
      this.mac = mac;
      this.bootstrap = mac && mac.pushBootstrap;
      if (artifact) return coordinatorModule.restorePushArtifact(artifact);
      return push;
    },
    disconnect: async function () { this.disconnected += 1; },
  };
  var config = {
    ids: {
      authenticationEndpoint: 'https://identity.example.test/auth',
      handlesEndpoint: 'https://identity.example.test/handles',
      registrationEndpoint: 'https://identity.example.test/register',
    },
  };
  return {
    storage: storage, traces: traces, effects: effects, repository: repository, crypto: crypto,
    deleted: deleted, anisette: anisette, pushClient: pushClient, push: push, config: config,
    validationDataGenerator: validationDataGenerator,
    validationCalls: validationCalls,
    generatedValidationData: generatedValidationData,
  };
}

function dependencies(control) {
  control = control || {};
  function FakeLogin(options) {
    if (control.forbidLogin) throw new Error('login must not be reconstructed');
    this.options = options;
    this.status = 'idle';
    this.disposed = false;
    control.login = this;
  }
  FakeLogin.prototype.start = async function (credentials) {
    control.seenCredentials = { username: credentials.username, password: credentials.password };
    if (control.loginFailure) throw new Error('synthetic account login failure');
    this.status = control.twoFactor ? 'needs-two-factor' : 'authenticated';
    return { status: this.status };
  };
  FakeLogin.prototype.submitTwoFactorCode = async function (code) {
    control.seenCode = code;
    if (control.rejectCode) {
      throw new RuntimeError('INVALID_TWO_FACTOR_CODE', 'The verification code was rejected.', {
        kind: ERROR_KINDS.INVALID_INPUT,
      });
    }
    if (control.failAfterCode) {
      this.status = 'failed';
      throw new RuntimeError('NAC_VALIDATION_FAILED', 'Fresh validation data could not be generated.', {
        kind: ERROR_KINDS.INTERNAL,
      });
    }
    this.status = 'authenticated';
    return { status: this.status };
  };
  FakeLogin.prototype.getResult = function () {
    assert.equal(this.status, 'authenticated');
    return { ids: { profileId: 'profile-fixture', authToken: 'ephemeral-delegate-token' } };
  };
  FakeLogin.prototype.dispose = function () { this.disposed = true; this.status = 'disposed'; };

  return {
    AccountLoginSession: FakeLogin,
    authenticateApple: async function (options) {
      control.authenticationOptions = options;
      var keyRecord = { id: 'auth-key', purpose: 'ids-authentication' };
      options.onKeyCreated(keyRecord);
      return {
        userId: options.profileId, userType: 'apple', protocolVersion: 1660,
        keyId: 'auth-key', certificate: new Uint8Array([5]),
        keyRecord: keyRecord,
        artifact: { version: 1, fixture: 'authentication-artifact' },
      };
    },
    restoreAuthenticationArtifact: function () {
      control.restoredAuthentication = true;
      return {
        userId: 'profile-fixture', userType: 'apple', protocolVersion: 1660,
        keyId: 'auth-key', certificate: new Uint8Array([5]),
      };
    },
    createIdentityBundle: function (_crypto, lifecycle) {
      control.identityCreated = (control.identityCreated || 0) + 1;
      var keyRecords = [
        { id: 'legacy-sign', purpose: 'ids-legacy-signing' },
        { id: 'legacy-encrypt', purpose: 'ids-legacy-encryption' },
        { id: 'device-key', purpose: 'ids-ngm-device' },
        { id: 'pre-key', purpose: 'ids-ngm-prekey' },
      ];
      keyRecords.forEach(lifecycle.onKeyCreated);
      return {
        keyRecords: keyRecords,
        artifact: { version: 1, fixture: 'identity-artifact' },
        publicIdentity: new Uint8Array([6]), device: {}, prekey: {},
      };
    },
    restoreIdentityArtifact: function () {
      control.restoredIdentity = true;
      return { publicIdentity: new Uint8Array([6]), device: {}, prekey: {} };
    },
    registerIdentity: async function (options) {
      control.registrationCalls = (control.registrationCalls || 0) + 1;
      control.registrationOptions = options;
      var requestValidationData = options.validationDataProvider
        ? await options.validationDataProvider() : options.validationData;
      control.registrationValidationSnapshot = new Uint8Array(requestValidationData);
      control.registrationValidationReference = requestValidationData;
      if (control.registrationFailure) throw new Error('synthetic registration failure');
      return {
        handles: ['mailto:sender@example.test'],
        artifact: { version: 1, registrations: [{
          service: 'com.apple.madrid',
          userId: 'profile-fixture',
          keyId: 'ids-key',
          certificate: 'fixture',
          handles: ['mailto:sender@example.test'],
          registeredAtSeconds: 1770000123,
          heartbeatIntervalSeconds: null,
        }] },
      };
    },
  };
}

function coordinator(fixture, control) {
  control = control || {};
  var generator = Object.prototype.hasOwnProperty.call(control, 'validationDataGenerator')
    ? control.validationDataGenerator : fixture.validationDataGenerator;
  return new ConfigurationCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    config: fixture.config,
    anisette: fixture.anisette,
    push: fixture.pushClient,
    validationDataGenerator: generator,
    dependencies: dependencies(control),
  });
}

test('configuration failures trace only a sanitized error code', async function () {
  for (var code of ['FIXTURE_SETUP_FAILED', 'secret-token@example.test']) {
    var fixture = fixtures();
    fixture.pushClient.ensureProvisioned = async function () {
      throw new RuntimeError(code, 'secret-password', { details: { token: 'secret-token' } });
    };
    await assert.rejects(coordinator(fixture).configure(configurationCredentials()));
    var trace = fixture.traces[fixture.traces.length - 1];
    assert.deepEqual(trace, { kind: 'configuration.failed.' + (code === 'FIXTURE_SETUP_FAILED' ? code : 'UNKNOWN') });
    assert.doesNotMatch(JSON.stringify(fixture.traces), /secret-password|secret-token/);
  }
});

test('APS provisioner activates hardware-only Mac data and connects once to acquire its first token', async function () {
  var mac = Object.freeze({ hardware: Object.freeze({ platformSerialNumber: 'SERIAL-FIXTURE' }), pushBootstrap: null });
  var activationCertificate = new Uint8Array([1, 2, 3]);
  var firstToken = new Uint8Array(32).fill(0x4a);
  var seenActivation;
  var seenRunner;
  var connects = 0;
  var closes = 0;
  var timer = new ManualTimer();

  function FakeRunner(options) {
    seenRunner = options;
  }
  FakeRunner.prototype.connect = async function () {
    connects += 1;
    return {
      keyId: 'activated-push-key',
      certificate: new Uint8Array(activationCertificate),
      token: new Uint8Array(firstToken),
    };
  };
  FakeRunner.prototype.close = function () { closes += 1; };

  var provisioner = new ApsProvisioner({
    effects: {
      timer: timer,
      trace: { emit: function () { throw new Error('synthetic trace failure'); } },
    },
    crypto: { deleteKey: function () { throw new Error('completed key must not be deleted'); } },
    activatePushIdentity: async function (options) {
      seenActivation = options;
      return {
        keyId: 'activated-push-key',
        certificate: new Uint8Array(activationCertificate),
        keyRecord: { id: 'activated-push-key', purpose: 'aps-signing' },
      };
    },
    ApsClientRunner: FakeRunner,
  });
  var result = await provisioner.ensureProvisioned(null, mac);

  assert.equal(seenActivation.mac, mac);
  assert.equal(seenActivation.crypto, provisioner.crypto);
  assert.equal(seenActivation.effects, provisioner.effects);
  assert.equal(seenRunner.push.keyId, 'activated-push-key');
  assert.deepEqual(seenRunner.push.certificate, activationCertificate);
  assert.equal(seenRunner.push.token, null);
  assert.equal(seenRunner.connectTimeoutMillis, 30000);
  assert.equal(connects, 1);
  assert.equal(closes, 1);
  assert.deepEqual(timer.delays, [30000]);
  assert.equal(timer.pending.size, 0);
  assert.deepEqual(result.token, firstToken);
  assert.deepEqual(result.keyRecord, { id: 'activated-push-key', purpose: 'aps-signing' });
  assert.deepEqual(result.artifact, {
    version: 1,
    keyId: 'activated-push-key',
    certificate: 'AQID',
    token: bytes.bytesToBase64(firstToken),
  });
});

test('APS provisioner closes the bootstrap courier and deletes an unpublished activation key on connect failure', async function () {
  var deleted = [];
  var closes = 0;
  var timer = new ManualTimer();
  function FailingRunner() {}
  FailingRunner.prototype.connect = async function () { throw new Error('private transport detail'); };
  FailingRunner.prototype.close = function () { closes += 1; };
  var provisioner = new ApsProvisioner({
    effects: {
      timer: timer,
      trace: { emit: function () { throw new Error('synthetic trace failure'); } },
    },
    crypto: { deleteKey: function (keyId) { deleted.push(keyId); } },
    activatePushIdentity: async function () {
      return { keyId: 'unpublished-key', certificate: new Uint8Array([9]) };
    },
    ApsClientRunner: FailingRunner,
  });

  await assert.rejects(provisioner.ensureProvisioned(null, { hardware: {}, pushBootstrap: null }), /private transport detail/);
  assert.equal(closes, 1);
  assert.deepEqual(deleted, ['unpublished-key']);
  assert.equal(timer.pending.size, 0);
});

test('APS provisioner times out courier authentication, deletes its unpublished key, and recovers on retry', async function () {
  var timer = new ManualTimer();
  var deleted = [];
  var runners = [];
  var activationAttempt = 0;

  function RecoveringRunner(options) {
    this.push = options.push;
    this.connectTimeoutMillis = options.connectTimeoutMillis;
    this.attempt = runners.length;
    this.closes = 0;
    this.rejectConnect = null;
    runners.push(this);
  }
  RecoveringRunner.prototype.connect = function () {
    var self = this;
    if (this.attempt === 0) {
      return new Promise(function (_, reject) { self.rejectConnect = reject; });
    }
    return Promise.resolve({
      keyId: this.push.keyId,
      certificate: new Uint8Array(this.push.certificate),
      token: new Uint8Array(32).fill(0x72),
    });
  };
  RecoveringRunner.prototype.close = function () {
    this.closes += 1;
    if (this.rejectConnect) {
      this.rejectConnect(new Error('closed hanging courier'));
      this.rejectConnect = null;
    }
  };

  var provisioner = new ApsProvisioner({
    effects: { timer: timer },
    crypto: { deleteKey: function (keyId) { deleted.push(keyId); } },
    initialCourierConnectTimeoutMillis: 17,
    activatePushIdentity: async function () {
      activationAttempt += 1;
      return {
        keyId: 'activation-key-' + activationAttempt,
        certificate: new Uint8Array([activationAttempt]),
      };
    },
    ApsClientRunner: RecoveringRunner,
  });

  var timedOut = provisioner.ensureProvisioned(null, { hardware: {}, pushBootstrap: null });
  await Promise.resolve();
  assert.equal(runners[0].connectTimeoutMillis, 17);
  assert.deepEqual(timer.delays, [17]);
  assert.equal(timer.pending.size, 1);
  timer.fireNext();
  await assert.rejects(timedOut, function (error) {
    return error instanceof RuntimeError
      && error.code === 'APS_CONNECT_TIMEOUT'
      && error.kind === ERROR_KINDS.TIMEOUT
      && error.retryable === true;
  });
  assert.equal(runners[0].closes, 1);
  assert.equal(provisioner.runner, null);
  assert.deepEqual(deleted, ['activation-key-1']);
  assert.equal(timer.pending.size, 0);

  var recovered = await provisioner.ensureProvisioned(null, { hardware: {}, pushBootstrap: null });
  assert.equal(recovered.keyId, 'activation-key-2');
  assert.deepEqual(recovered.token, new Uint8Array(32).fill(0x72));
  assert.equal(runners[1].closes, 1);
  assert.equal(provisioner.runner, null);
  assert.deepEqual(deleted, ['activation-key-1']);
  assert.equal(timer.pending.size, 0);
});

test('an interrupted activation remains durably cleanable by a restarted coordinator session', async function () {
  var fixture = fixtures();
  var rejectActivation;
  var token = macTokenValue();
  delete token.validationData;
  delete token.pushBootstrap;
  fixture.crypto.deleteKey = function (id) { fixture.deleted.push(id); return true; };

  var subject = new ConfigurationCoordinator({
    effects: fixture.effects,
    crypto: fixture.crypto,
    repository: fixture.repository,
    config: fixture.config,
    anisette: fixture.anisette,
    dependencies: Object.assign(dependencies({}), {
      activatePushIdentity: function (options) {
        options.onKeyCreated({ id: 'interrupted-activation-key', purpose: 'aps-signing' });
        return new Promise(function (_, reject) { rejectActivation = reject; });
      },
    }),
  });
  var interrupted = subject.configure({
    username: 'account@example.test',
    password: 'ephemeral-password',
    macValidationData: JSON.stringify(token),
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fixture.repository.load().phase, 'configuring');
  assert.deepEqual(fixture.repository.pendingKeyCleanup().map(function (entry) {
    return { id: entry.id, purpose: entry.purpose, reason: entry.reason };
  }), [{
    id: 'interrupted-activation-key',
    purpose: 'aps-signing',
    reason: 'aps-publication-pending',
  }]);

  // A new JS session has no access to the abandoned promise, but it can discover the opaque key
  // in durable state and retire it through the generic host crypto interface.
  var restarted = coordinator(fixture, {});
  var disconnected = await restarted.disconnect();
  assert.equal(disconnected.pendingKeyCleanup, 0);
  assert.deepEqual(fixture.deleted, ['interrupted-activation-key']);

  rejectActivation(new Error('abandoned activation session'));
  await assert.rejects(interrupted, function (error) {
    return error.code === 'CONFIGURATION_FAILED'
      && error.message === 'iMessage configuration failed.';
  });
  assert.deepEqual(fixture.repository.pendingKeyCleanup(), []);
});

test('configuration composes provisioning, push, account, IDS, identity, registration, and durable state', async function () {
  var fixture = fixtures();
  var control = {};
  var subject = coordinator(fixture, control);
  var credentials = configurationCredentials('ephemeral-password');
  var rawMacToken = credentials.macValidationData;
  var status = await subject.configure(credentials);

  assert.equal(status.phase, 'ready');
  assert.equal(status.busy, false);
  assert.equal(status.ready, true);
  assert.deepEqual(status.handles, ['mailto:sender@example.test']);
  assert.equal(control.login.options.clientInfo.pushToken, bytes.bytesToHex(fixture.push.token).toUpperCase());
  assert.equal(control.login.options.validationDataGenerator, fixture.validationDataGenerator);
  assert.equal(control.login.options.hardware.platformSerialNumber, 'SERIAL-FIXTURE');
  assert.equal(Object.prototype.hasOwnProperty.call(control.login.options.delegateConfig, 'validationData'), false);
  assert.equal(control.authenticationOptions.protocolVersion, 1701);
  assert.equal(control.authenticationOptions.userAgent, '[macOS,14.4.1,23E224,Mac15,3]');
  assert.equal(control.authenticationOptions.authToken, 'ephemeral-delegate-token');
  assert.equal(control.login.disposed, true);
  assert.equal(control.registrationOptions.pushKeyId, 'push-key');
  assert.equal(control.registrationOptions.users[0].keyId, 'auth-key');
  assert.deepEqual(control.registrationValidationSnapshot, new Uint8Array([0xa1, 0x55]));
  assert.deepEqual(control.registrationValidationReference, new Uint8Array(2));
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(2)]);
  assert.equal(fixture.validationCalls[0].platformSerialNumber, 'SERIAL-FIXTURE');
  assert.equal(control.registrationOptions.metadata.hardwareVersion, 'Mac15,3');
  assert.equal(fixture.anisette.clientInfo.hardwareHeaders[0][1], 'MLB-FIXTURE-0000001');
  assert.equal(fixture.pushClient.mac.hardware.platformSerialNumber, 'SERIAL-FIXTURE');
  assert.equal(fixture.pushClient.mac.validationData, null);
  assert.deepEqual(fixture.pushClient.bootstrap.privateKeyPkcs8, new Uint8Array(4));

  var state = fixture.repository.load();
  assert.equal(state.artifacts.provisioning.version, 1);
  assert.equal(state.artifacts.provisioning.anisette.adiPb, 'AgM=');
  assert.equal(state.artifacts.provisioning.mac.protocolVersion, 1701);
  assert.equal(Object.prototype.hasOwnProperty.call(state.artifacts.provisioning.mac, 'pushBootstrap'), false);
  assert.equal(state.artifacts.push.keyId, 'push-key');
  assert.equal(state.artifacts.authentication.fixture, 'authentication-artifact');
  assert.equal(state.artifacts.identities.primary.fixture, 'identity-artifact');
  assert.equal(state.artifacts.registration.version, 1);
  assert.deepEqual(state.keyInventory.active.map(function (entry) { return entry.id; }), [
    'push-key', 'auth-key', 'legacy-sign', 'legacy-encrypt', 'device-key', 'pre-key',
  ]);

  var persisted = Object.keys(fixture.storage.values).map(function (key) { return fixture.storage.values[key]; }).join(' ');
  var publicView = JSON.stringify(subject);
  var traces = JSON.stringify(fixture.traces);
  ['ephemeral-password', 'ephemeral-delegate-token', 'ephemeral-otp', rawMacToken].forEach(function (secret) {
    assert.equal(persisted.indexOf(secret), -1);
    assert.equal(publicView.indexOf(secret), -1);
    assert.equal(traces.indexOf(secret), -1);
  });
});

test('ready status repairs legacy union handles from authoritative Madrid registrations', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  await subject.configure(configurationCredentials());
  fixture.repository.update(function (draft) {
    draft.artifacts.registration.registrations.unshift({
      service: 'com.apple.private.alloy.fixture',
      userId: 'profile-fixture',
      keyId: 'fixture-key',
      certificate: 'fixture',
      handles: ['tel:+15555550999'],
      registeredAtSeconds: 1770000123,
      heartbeatIntervalSeconds: null,
    });
    draft.account.handles = ['tel:+15555550999', 'mailto:sender@example.test'];
  });

  var status = subject.status();
  assert.deepEqual(status.handles, ['mailto:sender@example.test']);
  assert.deepEqual(fixture.repository.load().account.handles, ['mailto:sender@example.test']);
});

test('configuration passes a normalized Mac token to APS provisioning without a legacy bootstrap', async function () {
  var fixture = fixtures();
  var token = macTokenValue();
  delete token.validationData;
  delete token.pushBootstrap;
  var status = await coordinator(fixture, {}).configure({
    username: 'account@example.test',
    password: 'ephemeral-password',
    macValidationData: JSON.stringify(token),
  });
  assert.equal(status.phase, 'ready');
  assert.equal(fixture.anisette.ensureCalls, 1);
  assert.equal(fixture.pushClient.ensureCalls, 1);
  assert.equal(fixture.pushClient.mac.hardware.platformSerialNumber, 'SERIAL-FIXTURE');
  assert.equal(fixture.pushClient.mac.validationData, null);
  assert.equal(fixture.pushClient.mac.pushBootstrap, null);
});

test('push key publication reconciles every durable crash point before deciding cleanup', async function () {
  for (var mutation = 1; mutation <= 3; mutation += 1) {
    for (var afterIndex = 0; afterIndex < 2; afterIndex += 1) {
      var after = afterIndex === 1;
      var fixture = fixtures();
      fixture.pushClient.ensureProvisioned = async function (artifact, mac) {
        this.mac = mac;
        this.bootstrap = mac && mac.pushBootstrap;
        fixture.storage.armFailure(mutation, after);
        return fixture.push;
      };
      var subject = coordinator(fixture, {});

      if (mutation === 1 && !after) {
        await assert.rejects(subject.configure(configurationCredentials()), /durable state/i);
        assert.equal(fixture.repository.load().artifacts.push, null);
        assert.deepEqual(fixture.deleted, ['push-key']);
      } else {
        var status = await subject.configure(configurationCredentials());
        var recovered = fixture.repository.load();
        assert.equal(status.phase, 'ready');
        assert.equal(recovered.artifacts.push.keyId, 'push-key');
        assert.equal(recovered.keyInventory.active.some(function (entry) {
          return entry.id === 'push-key' && entry.purpose === 'aps-signing';
        }), true);
        assert.deepEqual(fixture.deleted, []);
      }
      assert.deepEqual(fixture.pushClient.bootstrap.privateKeyPkcs8, new Uint8Array(4));
    }
  }
});

test('staged activation key promotion is atomic with push artifact publication at every crash point', function () {
  for (var mutation = 1; mutation <= 3; mutation += 1) {
    for (var afterIndex = 0; afterIndex < 2; afterIndex += 1) {
      var after = afterIndex === 1;
      var fixture = fixtures();
      fixture.repository.recordKeyCleanup('push-key', 'aps-signing', 'aps-publication-pending');
      fixture.storage.armFailure(mutation, after);
      var subject = coordinator(fixture, {});

      if (mutation === 1 && !after) {
        assert.throws(function () { subject._installPush(fixture.push); }, /durable state/i);
        assert.equal(fixture.repository.load().artifacts.push, null);
        assert.equal(fixture.repository.pendingKeyCleanup()[0].id, 'push-key');
      } else {
        subject._installPush(fixture.push);
        var recovered = fixture.repository.load();
        assert.equal(recovered.artifacts.push.keyId, 'push-key');
        assert.deepEqual(recovered.keyInventory.cleanup, []);
        assert.deepEqual(recovered.keyInventory.active, [{
          id: 'push-key', purpose: 'aps-signing', createdGeneration: 1,
        }]);
      }
      assert.deepEqual(fixture.deleted, []);
    }
  }
});

test('staged IDS key promotion is atomic with authentication and identity artifact publication', function () {
  [
    {
      records: [{ id: 'auth-key', purpose: 'ids-authentication' }],
      reason: 'ids-authentication-publication-pending',
      publish: function (draft) { draft.artifacts.authentication = { version: 1, fixture: 'auth' }; },
      published: function (state) { return state.artifacts.authentication; },
    },
    {
      records: [
        { id: 'legacy-sign', purpose: 'ids-legacy-signing' },
        { id: 'legacy-encrypt', purpose: 'ids-legacy-encryption' },
        { id: 'device-key', purpose: 'ids-ngm-device' },
        { id: 'pre-key', purpose: 'ids-ngm-prekey' },
      ],
      reason: 'ids-identity-publication-pending',
      publish: function (draft) { draft.artifacts.identities.primary = { version: 1, fixture: 'identity' }; },
      published: function (state) { return state.artifacts.identities.primary || null; },
    },
  ].forEach(function (scenario) {
    for (var mutation = 1; mutation <= 3; mutation += 1) {
      for (var afterIndex = 0; afterIndex < 2; afterIndex += 1) {
        var after = afterIndex === 1;
        var fixture = fixtures();
        scenario.records.forEach(function (record) {
          fixture.repository.recordKeyCleanup(record.id, record.purpose, scenario.reason);
        });
        fixture.storage.armFailure(mutation, after);
        var subject = coordinator(fixture, {});

        if (mutation === 1 && !after) {
          assert.throws(function () {
            subject._publishStaged(scenario.records, scenario.publish);
          }, /durable state/i);
          var interrupted = fixture.repository.load();
          assert.equal(scenario.published(interrupted), null);
          assert.deepEqual(interrupted.keyInventory.active, []);
          assert.deepEqual(interrupted.keyInventory.cleanup.map(function (entry) { return entry.id; }),
            scenario.records.map(function (record) { return record.id; }));
        } else {
          subject._publishStaged(scenario.records, scenario.publish);
          var recovered = fixture.repository.load();
          assert.ok(scenario.published(recovered));
          assert.deepEqual(recovered.keyInventory.cleanup, []);
          assert.deepEqual(recovered.keyInventory.active.map(function (entry) { return entry.id; }),
            scenario.records.map(function (record) { return record.id; }));
        }
        assert.deepEqual(fixture.deleted, []);
      }
    }
  });
});

test('configuration preflight accepts hardware-only Mac data without state writes or endpoint work', function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  var token = macTokenValue();
  delete token.validationData;
  delete token.pushBootstrap;
  subject.validateConfigurationInput({
    username: 'account@example.test',
    password: 'ephemeral-password',
    macValidationData: JSON.stringify(token),
  });
  assert.equal(fixture.repository.load().phase, 'disconnected');
  assert.deepEqual(fixture.storage.values, Object.create(null));
  assert.equal(fixture.anisette.ensureCalls, 0);
  assert.equal(fixture.pushClient.ensureCalls, 0);
});

test('configuration preflight rejects incomplete ExtractKey data before state or endpoint work', function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  var token = macTokenValue();
  delete token.inner.romEnc;
  assert.throws(function () {
    subject.validateConfigurationInput({ macValidationData: JSON.stringify(token) });
  }, function (error) { return error && error.code === 'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED'; });
  assert.deepEqual(fixture.storage.values, Object.create(null));
  assert.equal(fixture.anisette.ensureCalls, 0);
  assert.equal(fixture.pushClient.ensureCalls, 0);
});

test('rejected portable-NAC input explicitly zeroes its parsed APS private key', function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  var source = macTokenValue();
  delete source.inner.romEnc;
  var parsed = macAuthorization.parseMacAuthToken(JSON.stringify(source));
  var privateKey = parsed.pushBootstrap.privateKeyPkcs8;
  var originalParse = macAuthorization.parseMacAuthToken;
  macAuthorization.parseMacAuthToken = function () { return parsed; };
  try {
    assert.throws(function () {
      subject._loadMacAuthorization({ macValidationData: 'synthetic' });
    }, function (error) { return error && error.code === 'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED'; });
  } finally {
    macAuthorization.parseMacAuthToken = originalParse;
  }
  assert.deepEqual(privateKey, new Uint8Array(privateKey.length));
  assert.equal(subject.mac, null);
});

test('configuration restore rewrites legacy durable validation data before reuse', function () {
  var fixture = fixtures();
  var parsed = macAuthorization.parseMacAuthToken(JSON.stringify(macTokenValue()));
  var artifact = coordinatorModule.provisioningArtifact(parsed, null);
  var legacy = Object.assign({}, artifact, {
    mac: Object.assign({}, artifact.mac, {
      validationData: bytes.bytesToBase64(new Uint8Array(128).fill(9)),
    }),
  });
  fixture.repository.update(function (draft) {
    draft.phase = 'configuring';
    draft.artifacts.provisioning = legacy;
  });

  var subject = coordinator(fixture, {});
  var restored = subject._loadMacAuthorization();
  assert.equal(restored.validationData, null);
  assert.equal(fixture.repository.load().artifacts.provisioning.mac.validationData, null);
});

test('two-factor submission remains disabled when no JS validation-data generator is available', async function () {
  var fixture = fixtures();
  var control = { twoFactor: true, validationDataGenerator: null };
  var subject = coordinator(fixture, control);
  var token = macTokenValue();
  delete token.validationData;
  delete token.pushBootstrap;

  var pending = await subject.configure({
    username: 'account@example.test',
    password: 'ephemeral-password',
    macValidationData: JSON.stringify(token),
  });
  assert.equal(pending.phase, 'needs-two-factor');
  assert.equal(pending.canSubmitTwoFactor, false);
  assert.equal(pending.needsMacValidation, true);

  await assert.rejects(subject.submitTwoFactor('123456'), function (error) {
    return error.code === 'MAC_VALIDATION_REQUIRED' && error.kind === ERROR_KINDS.INVALID_INPUT;
  });
  assert.equal(control.seenCode, undefined);
  assert.equal(subject.status().phase, 'needs-two-factor');
  assert.equal(subject.status().canSubmitTwoFactor, false);
});

test('two-factor state retains only the live session; rejected codes remain retryable and never persist', async function () {
  var fixture = fixtures();
  var control = { twoFactor: true, rejectCode: true };
  var subject = coordinator(fixture, control);
  var pending = await subject.configure(configurationCredentials('secret-password'));
  assert.equal(pending.phase, 'needs-two-factor');
  assert.equal(pending.canSubmitTwoFactor, true);
  assert.equal(fixture.repository.load().artifacts.authentication, null);
  assert.equal(JSON.stringify(fixture.storage.values).indexOf('secret-password'), -1);

  await assert.rejects(subject.submitTwoFactor('123456'), function (error) {
    return error.code === 'INVALID_TWO_FACTOR_CODE';
  });
  assert.equal(subject.status().phase, 'needs-two-factor');
  assert.equal(subject.status().canSubmitTwoFactor, true);
  assert.equal(JSON.stringify(fixture.storage.values).indexOf('123456'), -1);
  assert.equal(JSON.stringify(fixture.traces).indexOf('123456'), -1);

  control.rejectCode = false;
  var ready = await subject.submitTwoFactor('654321');
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.busy, false);
  assert.equal(JSON.stringify(fixture.storage.values).indexOf('654321'), -1);
});

test('terminal failure after two-factor submission retires the failed live session', async function () {
  var fixture = fixtures();
  var control = { twoFactor: true, failAfterCode: true };
  var subject = coordinator(fixture, control);
  var pending = await subject.configure(configurationCredentials('secret-password'));
  assert.equal(pending.phase, 'needs-two-factor');
  assert.equal(pending.canSubmitTwoFactor, true);

  await assert.rejects(subject.submitTwoFactor('123456'), function (error) {
    return error.code === 'NAC_VALIDATION_FAILED';
  });
  assert.equal(control.login.disposed, true);
  assert.equal(subject.status().phase, 'configuring');
  assert.equal(subject.status().canSubmitTwoFactor, false);
  await assert.rejects(subject.submitTwoFactor('654321'), function (error) {
    return error.code === 'TWO_FACTOR_NOT_PENDING';
  });
});

test('registration failure leaves restorable artifacts so a new coordinator retries without credentials', async function () {
  var fixture = fixtures();
  var firstControl = { registrationFailure: true };
  await assert.rejects(coordinator(fixture, firstControl).configure(configurationCredentials()), function (error) {
    return error.code === 'CONFIGURATION_FAILED'
      && error.message === 'iMessage configuration failed.'
      && error.cause && error.cause.message === 'synthetic registration failure'
      && JSON.stringify(error).indexOf('synthetic registration failure') === -1;
  });
  var partial = fixture.repository.load();
  assert.equal(partial.phase, 'configuring');
  assert.equal(partial.artifacts.registration, null);
  assert.ok(partial.artifacts.authentication);
  assert.ok(partial.artifacts.identities.primary);
  assert.deepEqual(firstControl.registrationValidationSnapshot, new Uint8Array([0xa1, 0x55]));
  assert.deepEqual(firstControl.registrationValidationReference, new Uint8Array(2));

  var secondControl = { forbidLogin: true };
  var recovered = coordinator(fixture, secondControl);
  var ready = await recovered.configure();
  assert.equal(ready.phase, 'ready');
  assert.equal(secondControl.restoredAuthentication, true);
  assert.equal(secondControl.restoredIdentity, true);
  assert.equal(secondControl.registrationCalls, 1);
  assert.equal(secondControl.identityCreated || 0, 0);
  assert.deepEqual(secondControl.registrationValidationSnapshot, new Uint8Array([0xa2, 0x55]));
  assert.deepEqual(secondControl.registrationValidationReference, new Uint8Array(2));
  assert.equal(fixture.generatedValidationData[0] === fixture.generatedValidationData[1], false);
  assert.deepEqual(fixture.generatedValidationData, [new Uint8Array(2), new Uint8Array(2)]);
});

test('same-Mac account retry preserves provisioned Anisette and APS state', async function () {
  var fixture = fixtures();
  await assert.rejects(
    coordinator(fixture, { loginFailure: true }).configure(configurationCredentials('old-password')),
    /iMessage configuration failed/
  );
  var partial = fixture.repository.load();
  assert.equal(partial.phase, 'configuring');
  assert.ok(partial.artifacts.provisioning.anisette);
  assert.ok(partial.artifacts.push);
  assert.equal(partial.artifacts.authentication, null);
  var provisionedAnisette = partial.artifacts.provisioning.anisette;
  var provisionedPush = partial.artifacts.push;

  var retryControl = {};
  var ready = await coordinator(fixture, retryControl).configure(configurationCredentials('new-password'));

  assert.equal(ready.phase, 'ready');
  assert.deepEqual(retryControl.seenCredentials, {
    username: 'account@example.test', password: 'new-password',
  });
  assert.equal(fixture.pushClient.disconnected, 0);
  assert.equal(fixture.pushClient.ensureCalls, 2);
  assert.equal(fixture.anisette.ensureCalls, 2);
  assert.deepEqual(fixture.pushClient.bootstrap, null);
  assert.deepEqual(fixture.anisette.receivedArtifact, provisionedAnisette);
  assert.deepEqual(fixture.repository.load().artifacts.provisioning.anisette, provisionedAnisette);
  assert.deepEqual(fixture.repository.load().artifacts.push, provisionedPush);
  assert.deepEqual(fixture.deleted, []);
});

test('fresh credentials replace a failed partial setup instead of reusing stale account artifacts', async function () {
  var fixture = fixtures();
  await assert.rejects(
    coordinator(fixture, { registrationFailure: true }).configure(configurationCredentials('old-password')),
    /iMessage configuration failed/
  );

  var replacementToken = macTokenValue();
  replacementToken.inner.platformSerialNumber = 'SERIAL-REPLACEMENT';
  replacementToken.validationData = Array.from(new Uint8Array(128).fill(7));
  var replacement = {
    username: 'replacement@example.test',
    password: 'new-password',
    macValidationData: JSON.stringify(replacementToken),
  };
  var replacementControl = {};
  var ready = await coordinator(fixture, replacementControl).configure(replacement);

  assert.equal(ready.phase, 'ready');
  assert.deepEqual(replacementControl.seenCredentials, {
    username: 'replacement@example.test', password: 'new-password',
  });
  assert.equal(
    fixture.repository.load().artifacts.provisioning.mac.hardware.platformSerialNumber,
    'SERIAL-REPLACEMENT'
  );
  assert.deepEqual(replacementControl.registrationValidationSnapshot, new Uint8Array([0xa2, 0x55]));
  assert.deepEqual(replacementControl.registrationValidationReference, new Uint8Array(2));
  assert.equal(fixture.pushClient.disconnected, 1);
  assert.deepEqual(fixture.deleted, [
    'push-key', 'auth-key', 'legacy-sign', 'legacy-encrypt', 'device-key', 'pre-key',
  ]);
});

test('malformed replacement Mac data does not erase a recoverable partial setup', async function () {
  var fixture = fixtures();
  await assert.rejects(
    coordinator(fixture, { registrationFailure: true }).configure(configurationCredentials()),
    /iMessage configuration failed/
  );
  var generation = fixture.repository.load().generation;

  await assert.rejects(coordinator(fixture, {}).configure({
    username: 'replacement@example.test',
    password: 'new-password',
    macValidationData: '{malformed',
  }));

  assert.equal(fixture.repository.load().generation, generation);
  assert.equal(fixture.repository.load().phase, 'configuring');
  assert.equal(fixture.pushClient.disconnected, 0);
  assert.deepEqual(fixture.deleted, []);
});

test('incomplete ExtractKey replacement does not erase a recoverable partial setup', async function () {
  var fixture = fixtures();
  await assert.rejects(
    coordinator(fixture, { registrationFailure: true }).configure(configurationCredentials()),
    /iMessage configuration failed/
  );
  var generation = fixture.repository.load().generation;
  var replacement = macTokenValue();
  delete replacement.inner.romEnc;

  await assert.rejects(coordinator(fixture, {}).configure({
    username: 'replacement@example.test',
    password: 'new-password',
    macValidationData: JSON.stringify(replacement),
  }), function (error) { return error && error.code === 'MAC_TOKEN_PORTABLE_NAC_UNSUPPORTED'; });

  assert.equal(fixture.repository.load().generation, generation);
  assert.equal(fixture.repository.load().phase, 'configuring');
  assert.equal(fixture.pushClient.disconnected, 0);
  assert.deepEqual(fixture.deleted, []);
});

test('disconnect completes already-absent keys while retaining thrown cleanup obligations', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  await subject.configure(configurationCredentials('password'));
  fixture.crypto.deleteKey = function (id) {
    fixture.deleted.push(id);
    if (id === 'device-key') throw new Error('host key vault unavailable');
    return id !== 'pre-key';
  };
  var status = await subject.disconnect();
  assert.equal(status.phase, 'disconnected');
  assert.equal(status.busy, false);
  assert.equal(status.pendingKeyCleanup, 1);
  assert.equal(fixture.repository.load().keyInventory.cleanup[0].id, 'device-key');
  assert.deepEqual(fixture.repository.load().artifacts, require('../../src/state/state-schema').createEmptyState().artifacts);
  assert.equal(fixture.pushClient.disconnected, 1);
});

test('cleanup retry completes after host deletion succeeded but durable acknowledgement crashed', async function () {
  var fixture = fixtures();
  await coordinator(fixture, {}).configure(configurationCredentials('password'));

  var hostKeys = new Set(fixture.repository.load().keyInventory.active.map(function (entry) {
    return entry.id;
  }));
  var deleteResults = [];
  fixture.crypto.deleteKey = function (id) {
    var deleted = hostKeys.delete(id);
    deleteResults.push({ id: id, deleted: deleted });
    return deleted;
  };

  var completeKeyCleanup = fixture.repository.completeKeyCleanup.bind(fixture.repository);
  var interrupted = false;
  fixture.repository.completeKeyCleanup = function (id) {
    if (!interrupted && id === 'push-key') {
      interrupted = true;
      throw new Error('simulated crash before durable cleanup acknowledgement');
    }
    return completeKeyCleanup(id);
  };

  var interruptedStatus = await coordinator(fixture, {}).disconnect();
  assert.equal(interruptedStatus.pendingKeyCleanup, 1);
  assert.equal(fixture.repository.pendingKeyCleanup()[0].id, 'push-key');
  assert.equal(hostKeys.has('push-key'), false);

  fixture.repository.completeKeyCleanup = completeKeyCleanup;
  var recoveredStatus = await coordinator(fixture, {}).disconnect();
  assert.equal(recoveredStatus.pendingKeyCleanup, 0);
  assert.deepEqual(fixture.repository.pendingKeyCleanup(), []);
  assert.deepEqual(deleteResults.filter(function (result) { return result.id === 'push-key'; }), [
    { id: 'push-key', deleted: true },
    { id: 'push-key', deleted: false },
  ]);
});

test('concurrent configuration is rejected without starting a second lifecycle', async function () {
  var fixture = fixtures();
  var release;
  fixture.anisette.ensureProvisioned = function () {
    return new Promise(function (resolve) { release = resolve; });
  };
  var subject = coordinator(fixture, {});
  var first = subject.configure(configurationCredentials('password'));
  await assert.rejects(subject.configure({
    username: 'other@example.test', password: 'other', macValidationData: JSON.stringify(macTokenValue()),
  }), function (error) {
    return error.code === 'CONFIGURATION_IN_PROGRESS';
  });
  release({ artifact: {
    version: 1, keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16)), adiPb: 'AQ==',
  } });
  assert.equal((await first).phase, 'ready');
});

test('RemoteV3 adapter instantiates the pure protocol session and restores only identifier plus adi_pb', async function () {
  var storage = new MemoryStorage();
  var capturedSession;
  var responseBody = bytes.utf8ToBytes(JSON.stringify({
    result: 'Headers',
    'X-Apple-I-MD-M': 'machine',
    'X-Apple-I-MD': 'one-time-password',
    'X-Apple-I-MD-RINFO': '17106176',
  }));
  var effects = createEffects({
    clock: { now: function () { return Date.parse('2026-08-27T12:34:56Z'); } },
    random: { bytes: function (length) { return new Uint8Array(length).fill(7); } },
    http: { request: async function (request) {
      assert.match(request.url, /\/v3\/get_headers$/);
      return { status: 200, headers: [], body: responseBody };
    } },
    storage: storage,
  });
  var digestCrypto = { digest: function (_, value) { return new Uint8Array(32).fill(value[0]); } };
  var client = new RemoteV3AnisetteClient({
    effects: effects,
    crypto: digestCrypto,
    config: {
      remoteUrl: 'https://ani.example',
      clientInfo: { akdUserAgent: 'akd/fixture', mmeClientInfo: '<fixture>', hardwareHeaders: [] },
    },
    runner: { provision: async function (session) {
      capturedSession = session;
      return anisetteRemote.createState(new Uint8Array(16).fill(7), new Uint8Array([1, 2, 3]));
    } },
  });
  var provisioned = await client.ensureProvisioned(null);
  assert.equal(capturedSession instanceof anisetteRemote.RemoteV3ProvisioningSession, true);
  assert.deepEqual(coordinatorModule.restoreAnisetteArtifact(provisioned.artifact).adiPb, new Uint8Array([1, 2, 3]));
  var headers = await client.getHeaders();
  assert.equal(new Map(headers).get('X-Apple-I-MD'), 'one-time-password');
  assert.equal(JSON.stringify(provisioned.artifact).indexOf('one-time-password'), -1);
});

test('RemoteV3 adapter reprovisions expired state with the same keychain identifier', async function () {
  var identifier = new Uint8Array(16).map(function (_, index) { return index + 1; });
  var capturedSession;
  var client = new RemoteV3AnisetteClient({
    effects: createEffects({
      clock: { now: function () { return Date.parse('2026-08-27T12:34:56Z'); } },
      random: { bytes: function () { throw new Error('recovery must not generate another identifier'); } },
      http: { request: async function () { throw new Error('unexpected HTTP'); } },
      storage: new MemoryStorage(),
    }),
    crypto: { digest: function () { return new Uint8Array(32); } },
    config: {
      remoteUrl: 'https://ani.example',
      clientInfo: { akdUserAgent: 'akd/fixture', mmeClientInfo: '<fixture>', hardwareHeaders: [] },
    },
    runner: { provision: async function (session) {
      capturedSession = session;
      return anisetteRemote.createState(identifier, new Uint8Array([9, 8, 7]));
    } },
  });
  await client.ensureProvisioned({
    version: 1,
    keychainIdentifier: bytes.bytesToBase64(identifier),
    adiPb: 'AQ==',
  });

  var recovered = await client.reprovision();
  assert.deepEqual(capturedSession.state.keychainIdentifier, identifier);
  assert.equal(capturedSession.state.adiPb, null);
  assert.deepEqual(coordinatorModule.restoreAnisetteArtifact(recovered.artifact).keychainIdentifier, identifier);
  assert.deepEqual(coordinatorModule.restoreAnisetteArtifact(recovered.artifact).adiPb, new Uint8Array([9, 8, 7]));
});

test('configuration persists one expired-Anisette recovery before retrying headers', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  subject._loadMacAuthorization(configurationCredentials());
  var calls = 0;
  var recoveredArtifact = {
    version: 1,
    keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16).fill(1)),
    adiPb: bytes.bytesToBase64(new Uint8Array([7, 8, 9])),
  };
  fixture.anisette.getHeaders = async function () {
    calls += 1;
    if (calls === 1) {
      throw new RuntimeError('ANISETTE_NOT_PROVISIONED', 'expired', { kind: ERROR_KINDS.INVALID_INPUT });
    }
    assert.deepEqual(fixture.repository.load().artifacts.provisioning.anisette, recoveredArtifact);
    return [['X-Apple-I-MD', 'fresh-otp']];
  };
  fixture.anisette.reprovision = async function () {
    return { artifact: recoveredArtifact, created: true };
  };

  assert.deepEqual(await subject._getAnisetteHeaders(), [['X-Apple-I-MD', 'fresh-otp']]);
  assert.equal(calls, 2);
  assert.deepEqual(fixture.repository.load().artifacts.provisioning.anisette, recoveredArtifact);
});

test('configuration does not loop when recovered Anisette headers are rejected again', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  subject._loadMacAuthorization(configurationCredentials());
  var calls = 0;
  var reprovisionCalls = 0;
  fixture.anisette.getHeaders = async function () {
    calls += 1;
    throw new RuntimeError('ANISETTE_NOT_PROVISIONED', 'expired', { kind: ERROR_KINDS.INVALID_INPUT });
  };
  fixture.anisette.reprovision = async function () {
    reprovisionCalls += 1;
    return {
      artifact: {
        version: 1,
        keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16).fill(1)),
        adiPb: 'AQ==',
      },
      created: true,
    };
  };

  await assert.rejects(subject._getAnisetteHeaders(), function (error) {
    return error && error.code === 'ANISETTE_NOT_PROVISIONED';
  });
  assert.equal(calls, 2);
  assert.equal(reprovisionCalls, 1);
});

test('Anisette recovery restores prior live state when publication fails before writing', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  subject._loadMacAuthorization(configurationCredentials());
  var oldArtifact = {
    version: 1,
    keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16).fill(1)),
    adiPb: 'AQ==',
  };
  fixture.repository.update(function (draft) {
    draft.artifacts.provisioning = coordinatorModule.provisioningArtifact(subject.mac, oldArtifact);
  });
  var newArtifact = Object.assign({}, oldArtifact, { adiPb: 'Ag==' });
  var restored = null;
  fixture.anisette.getHeaders = async function () {
    throw new RuntimeError('ANISETTE_NOT_PROVISIONED', 'expired', { kind: ERROR_KINDS.INVALID_INPUT });
  };
  fixture.anisette.reprovision = async function () { return { artifact: newArtifact, created: true }; };
  fixture.anisette.restoreProvisioned = function (artifact) { restored = artifact; };
  fixture.storage.armFailure(1, false);

  await assert.rejects(subject._getAnisetteHeaders(), /durable state/i);
  assert.deepEqual(restored, oldArtifact);
  assert.deepEqual(fixture.repository.load().artifacts.provisioning.anisette, oldArtifact);
});

test('Anisette recovery reconciles an after-write publication failure and continues once', async function () {
  var fixture = fixtures();
  var subject = coordinator(fixture, {});
  subject._loadMacAuthorization(configurationCredentials());
  var oldArtifact = {
    version: 1,
    keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16).fill(1)),
    adiPb: 'AQ==',
  };
  fixture.repository.update(function (draft) {
    draft.artifacts.provisioning = coordinatorModule.provisioningArtifact(subject.mac, oldArtifact);
  });
  var newArtifact = Object.assign({}, oldArtifact, { adiPb: 'Ag==' });
  var calls = 0;
  fixture.anisette.getHeaders = async function () {
    calls += 1;
    if (calls === 1) {
      throw new RuntimeError('ANISETTE_NOT_PROVISIONED', 'expired', { kind: ERROR_KINDS.INVALID_INPUT });
    }
    return [['X-Apple-I-MD', 'fresh-otp']];
  };
  fixture.anisette.reprovision = async function () { return { artifact: newArtifact, created: true }; };
  fixture.anisette.restoreProvisioned = function () { throw new Error('new state is already durable'); };
  fixture.storage.armFailure(1, true);

  assert.deepEqual(await subject._getAnisetteHeaders(), [['X-Apple-I-MD', 'fresh-otp']]);
  assert.equal(calls, 2);
  assert.deepEqual(fixture.repository.load().artifacts.provisioning.anisette, newArtifact);
});

test('persisted adapter artifacts reject unexpected fields that could smuggle transient secrets', function () {
  assert.throws(function () {
    coordinatorModule.restoreAnisetteArtifact({
      version: 1, keychainIdentifier: bytes.bytesToBase64(new Uint8Array(16)), adiPb: 'AQ==', password: 'secret',
    });
  }, /unexpected fields/);
  assert.throws(function () {
    coordinatorModule.restorePushArtifact({
      version: 1, keyId: 'key', certificate: 'AQ==', token: bytes.bytesToBase64(new Uint8Array(32)), body: 'secret',
    });
  }, /unexpected fields/);
  assert.throws(function () {
    var token = require('../../src/configuration/mac-auth-token').parseMacAuthToken(JSON.stringify(macTokenValue()));
    var artifact = coordinatorModule.provisioningArtifact(token, null);
    coordinatorModule.restoreProvisioningArtifact(Object.assign({}, artifact, { password: 'secret' }));
  }, /unexpected fields/);
});
