'use strict';

var anisetteRemote = require('../../../chat/imessage/src/anisette/remote-v3');
var accountLogin = require('../apple-account/login');
var activatePushIdentity = require('../../../chat/imessage/src/aps/activation').activatePushIdentity;
var ApsClientRunner = require('../../../chat/imessage/src/aps/client-runner').ApsClientRunner;
var pushBootstrap = require('../../../chat/imessage/src/aps/push-bootstrap');
var authentication = require('../../../chat/imessage/src/ids/authentication');
var identities = require('../../../chat/imessage/src/ids/identities');
var registration = require('../../../chat/imessage/src/ids/registration');
var macAuthorization = require('../../../chat/imessage/src/configuration/mac-auth-token');
var bytes = require('../../../chat/imessage/src/runtime/bytes');
var errors = require('../../../chat/imessage/src/runtime/errors');
var RuntimeError = errors.RuntimeError;
var ERROR_KINDS = errors.ERROR_KINDS;
var INITIAL_COURIER_CONNECT_TIMEOUT_MILLIS = 30000;

function configurationError(code, message, kind, details) {
  return new RuntimeError(code, message, { kind: kind || ERROR_KINDS.INVALID_INPUT, details: details });
}

function emitTrace(effects, kind) {
  if (!effects || !effects.trace || typeof effects.trace.emit !== 'function') return;
  try { effects.trace.emit(Object.freeze({ kind: kind })); }
  catch (_) { /* diagnostics must never change provisioning or cleanup behavior */ }
}

function emitFailureTrace(effects, prefix, error) {
  var code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code : 'UNKNOWN';
  emitTrace(effects, prefix + '.' + code);
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError('INVALID_CONFIGURATION', name + ' is missing or malformed.');
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384 || /[\u0000\r\n]/.test(value)) {
    throw configurationError('INVALID_CONFIGURATION', name + ' is missing or malformed.');
  }
  return value;
}

function validateHttpResponse(response, operation) {
  if (!response || typeof response !== 'object' || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array) || !Array.isArray(response.headers || [])) {
    throw configurationError('CONFIGURATION_NETWORK_ERROR', operation + ' returned a malformed response.', ERROR_KINDS.TRANSPORT);
  }
  if (response.status < 200 || response.status >= 300) {
    throw configurationError('CONFIGURATION_NETWORK_ERROR', operation + ' failed.', ERROR_KINDS.TRANSPORT, {
      httpStatus: response.status,
    });
  }
  return response;
}

function anisetteArtifact(state) {
  return Object.freeze({
    version: 1,
    keychainIdentifier: bytes.bytesToBase64(state.keychainIdentifier),
    adiPb: bytes.bytesToBase64(state.adiPb),
  });
}

function sameAnisetteArtifact(left, right) {
  return !!left && !!right
    && left.version === right.version
    && left.keychainIdentifier === right.keychainIdentifier
    && left.adiPb === right.adiPb;
}

function restoreAnisetteArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1
      || typeof artifact.keychainIdentifier !== 'string' || typeof artifact.adiPb !== 'string') {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted Anisette state is malformed.', ERROR_KINDS.STORAGE);
  }
  var keys = Object.keys(artifact).sort().join(',');
  if (keys !== ['adiPb', 'keychainIdentifier', 'version'].sort().join(',')) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted Anisette state has unexpected fields.', ERROR_KINDS.STORAGE);
  }
  return anisetteRemote.createState(
    bytes.base64ToBytes(artifact.keychainIdentifier),
    bytes.base64ToBytes(artifact.adiPb)
  );
}

function provisioningArtifact(mac, anisette) {
  var normalizedMac = macAuthorization.macAuthArtifact(mac);
  var normalizedAnisette = null;
  if (anisette !== null && anisette !== undefined) {
    normalizedAnisette = anisetteArtifact(restoreAnisetteArtifact(anisette));
  }
  return Object.freeze({
    version: 1,
    mac: normalizedMac,
    anisette: normalizedAnisette,
  });
}

function restoreProvisioningArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted provisioning state is malformed.', ERROR_KINDS.STORAGE);
  }
  var keys = Object.keys(artifact).sort().join(',');
  if (keys !== ['anisette', 'mac', 'version'].sort().join(',')) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted provisioning state has unexpected fields.', ERROR_KINDS.STORAGE);
  }
  var mac = macAuthorization.restoreMacAuthArtifact(artifact.mac);
  var normalized = provisioningArtifact(mac, artifact.anisette);
  return Object.freeze({
    mac: mac,
    anisette: normalized.anisette === null ? null : restoreAnisetteArtifact(normalized.anisette),
    artifact: normalized,
  });
}

/**
 * Adapter that composes the pure RemoteV3 protocol session with an injected WebSocket relay
 * runner. The runner handles callback scheduling only; every Apple/Anisette request remains in JS.
 */
function RemoteV3AnisetteClient(options) {
  options = requireObject(options, 'RemoteV3 client options');
  this.effects = requireObject(options.effects, 'RemoteV3 effects');
  this.crypto = options.crypto;
  this.config = requireObject(options.config, 'RemoteV3 configuration');
  this.runner = requireObject(options.runner, 'RemoteV3 provisioning runner');
  if (typeof this.runner.provision !== 'function') {
    throw configurationError('INVALID_CONFIGURATION', 'RemoteV3 provisioning runner is unavailable.');
  }
  this.state = null;
  this.clientInfo = this.config.clientInfo || null;
}

RemoteV3AnisetteClient.prototype.setClientInfo = function (clientInfo) {
  this.clientInfo = requireObject(clientInfo, 'RemoteV3 client metadata');
};

RemoteV3AnisetteClient.prototype.ensureProvisioned = async function (artifact) {
  if (artifact) {
    this.state = restoreAnisetteArtifact(artifact);
    return Object.freeze({ state: this.state, artifact: anisetteArtifact(this.state), created: false });
  }
  return this._provision(anisetteRemote.createState(this.effects.random.bytes(16)));
};

RemoteV3AnisetteClient.prototype._provision = async function (state) {
  var session = new anisetteRemote.RemoteV3ProvisioningSession({
    remoteUrl: this.config.remoteUrl,
    state: state,
    clientInfo: requireObject(this.clientInfo, 'RemoteV3 client metadata'),
    crypto: this.crypto,
    nowMs: this.effects.clock.now(),
  });
  var provisioned = await this.runner.provision(session);
  if (!provisioned || !(provisioned.keychainIdentifier instanceof Uint8Array)
      || !(provisioned.adiPb instanceof Uint8Array)) {
    throw configurationError('ANISSETTE_PROVISIONING_FAILED', 'Anisette provisioning returned no restorable state.', ERROR_KINDS.TRANSPORT);
  }
  this.state = anisetteRemote.createState(provisioned.keychainIdentifier, provisioned.adiPb);
  return Object.freeze({ state: this.state, artifact: anisetteArtifact(this.state), created: true });
};

RemoteV3AnisetteClient.prototype.reprovision = function () {
  if (!this.state) {
    throw configurationError('ANISSETTE_NOT_PROVISIONED', 'Anisette must be provisioned first.');
  }
  // OpenBubbles keeps the keychain identifier stable and discards only the expired adi_pb.
  return this._provision(anisetteRemote.createState(this.state.keychainIdentifier));
};

RemoteV3AnisetteClient.prototype.restoreProvisioned = function (artifact) {
  this.state = restoreAnisetteArtifact(artifact);
};

RemoteV3AnisetteClient.prototype.getHeaders = async function () {
  if (!this.state || this.state.adiPb === null) {
    throw configurationError('ANISSETTE_NOT_PROVISIONED', 'Anisette must be provisioned first.');
  }
  var request = anisetteRemote.buildGetHeadersRequest(this.config.remoteUrl, this.state);
  var response = validateHttpResponse(await this.effects.http.request(request), 'Anisette header generation');
  return anisetteRemote.parseGetHeadersResponse(response.body, {
    state: this.state,
    clientInfo: requireObject(this.clientInfo, 'RemoteV3 client metadata'),
    crypto: this.crypto,
    nowMs: this.effects.clock.now(),
  });
};

function pushArtifact(push) {
  return Object.freeze({
    version: 1,
    keyId: push.keyId,
    certificate: bytes.bytesToBase64(push.certificate),
    token: bytes.bytesToBase64(push.token),
  });
}

function restorePushArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object' || artifact.version !== 1
      || typeof artifact.keyId !== 'string' || artifact.keyId.length === 0
      || typeof artifact.certificate !== 'string' || typeof artifact.token !== 'string') {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted push state is malformed.', ERROR_KINDS.STORAGE);
  }
  var keys = Object.keys(artifact).sort().join(',');
  if (keys !== ['certificate', 'keyId', 'token', 'version'].sort().join(',')) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted push state has unexpected fields.', ERROR_KINDS.STORAGE);
  }
  var certificate = bytes.base64ToBytes(artifact.certificate);
  var token = bytes.base64ToBytes(artifact.token);
  if (certificate.length === 0 || token.length !== 32) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted push credentials are malformed.', ERROR_KINDS.STORAGE);
  }
  return Object.freeze({ keyId: artifact.keyId, certificate: certificate, token: token, artifact: pushArtifact({
    keyId: artifact.keyId, certificate: certificate, token: token,
  }), created: false });
}

function connectWithTimeout(runner, timer, timeoutMillis) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var scheduled = false;
    var timeoutHandle;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (scheduled) {
        try { timer.cancel(timeoutHandle); } catch (_) { /* a settled connection remains authoritative */ }
      }
      if (error) reject(error); else resolve(value);
    }

    var connection;
    try {
      connection = runner.connect();
    } catch (error) {
      finish(error);
      return;
    }
    Promise.resolve(connection).then(function (value) {
      finish(null, value);
    }, function (error) {
      finish(error);
    });

    try {
      timeoutHandle = timer.after(timeoutMillis, function () {
        finish(new RuntimeError('APS_CONNECT_TIMEOUT', 'APS courier authentication timed out.', {
          kind: ERROR_KINDS.TIMEOUT,
          retryable: true,
        }));
      });
      scheduled = true;
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Establish durable APS credentials. Legacy combined tokens are imported as before; hardware-only
 * Mac tokens are activated in JavaScript and connected once to obtain their first courier token.
 */
function ApsProvisioner(options) {
  options = requireObject(options, 'APS provisioner options');
  this.effects = requireObject(options.effects, 'APS effects');
  this.crypto = options.crypto;
  this.activatePushIdentity = options.activatePushIdentity || activatePushIdentity;
  this.ApsClientRunner = options.ApsClientRunner || ApsClientRunner;
  this.keyLifecycle = options.keyLifecycle || Object.freeze({
    stage: function () {},
    completeCleanup: function () {},
  });
  if (typeof this.keyLifecycle.stage !== 'function'
      || typeof this.keyLifecycle.completeCleanup !== 'function') {
    throw configurationError('INVALID_CONFIGURATION', 'APS key lifecycle is unavailable.');
  }
  this.initialCourierConnectTimeoutMillis = options.initialCourierConnectTimeoutMillis
    === undefined ? INITIAL_COURIER_CONNECT_TIMEOUT_MILLIS : options.initialCourierConnectTimeoutMillis;
  if (!Number.isSafeInteger(this.initialCourierConnectTimeoutMillis)
      || this.initialCourierConnectTimeoutMillis <= 0) {
    throw configurationError('INVALID_CONFIGURATION', 'Initial courier timeout is invalid.');
  }
  this.runner = null;
}

ApsProvisioner.prototype.ensureProvisioned = async function (artifact, mac) {
  emitTrace(this.effects, 'configuration.aps-provision-start');
  var bootstrap = mac && mac.pushBootstrap;
  if (artifact) {
    macAuthorization.disposePushBootstrap(bootstrap);
    emitTrace(this.effects, 'configuration.aps-provision-restored');
    return restorePushArtifact(artifact);
  }
  requireObject(mac, 'Mac authorization');
  var provisioned;
  var completed = false;
  var stagedKeyRecord = null;
  var provisioner = this;
  try {
    if (bootstrap) {
      emitTrace(this.effects, 'configuration.aps-bootstrap-import-start');
      provisioned = pushBootstrap.importPushBootstrap(
        this.crypto,
        bootstrap,
        this.effects.clock.now(),
        {
          onKeyCreated: function (record) {
            stagedKeyRecord = record;
            provisioner.keyLifecycle.stage(record);
          },
          onKeyDeleted: function (keyId) {
            provisioner.keyLifecycle.completeCleanup(keyId);
            stagedKeyRecord = null;
          },
        }
      );
      emitTrace(this.effects, 'configuration.aps-bootstrap-import-complete');
    } else {
      if (typeof this.activatePushIdentity !== 'function') {
        throw configurationError('APS_ACTIVATION_UNAVAILABLE', 'Apple Push activation is unavailable.', ERROR_KINDS.CAPABILITY);
      }
      provisioned = await this.activatePushIdentity({
        effects: this.effects,
        crypto: this.crypto,
        mac: mac,
        onKeyCreated: function (record) {
          // Assign before the durable write so a throw-after-commit can still be reconciled by
          // idempotent deletion and cleanup acknowledgement in the outer finally block.
          stagedKeyRecord = record;
          provisioner.keyLifecycle.stage(record);
        },
      });
      emitTrace(this.effects, 'configuration.aps-courier-connect-start');
      if (!provisioned || typeof provisioned.keyId !== 'string' || provisioned.keyId.length === 0
          || !(provisioned.certificate instanceof Uint8Array) || provisioned.certificate.length === 0) {
        throw configurationError('APS_ACTIVATION_FAILED', 'Apple Push activation returned malformed credentials.', ERROR_KINDS.TRANSPORT);
      }
      var runner = new this.ApsClientRunner({
        effects: this.effects,
        crypto: this.crypto,
        connectTimeoutMillis: this.initialCourierConnectTimeoutMillis,
        push: {
          keyId: provisioned.keyId,
          certificate: provisioned.certificate,
          token: null,
        },
      });
      this.runner = runner;
      var connected;
      try {
        connected = await connectWithTimeout(
          runner,
          requireObject(this.effects.timer, 'Timer effects'),
          this.initialCourierConnectTimeoutMillis
        );
      } finally {
        try { runner.close(); } catch (_) { /* preserve activation/connect result */ }
        if (this.runner === runner) this.runner = null;
      }
      if (!connected || connected.keyId !== provisioned.keyId
          || !(connected.token instanceof Uint8Array) || connected.token.length !== 32) {
        throw configurationError('APS_ACTIVATION_FAILED', 'Apple Push activation returned malformed credentials.', ERROR_KINDS.TRANSPORT);
      }
      emitTrace(this.effects, 'configuration.aps-courier-connect-complete');
      provisioned = {
        keyId: provisioned.keyId,
        certificate: new Uint8Array(provisioned.certificate),
        token: new Uint8Array(connected.token),
      };
    }
    var result = {
      keyId: provisioned.keyId,
      certificate: new Uint8Array(provisioned.certificate),
      token: new Uint8Array(provisioned.token),
      keyRecord: Object.freeze({ id: provisioned.keyId, purpose: 'aps-signing' }),
      created: true,
    };
    result.artifact = pushArtifact(result);
    completed = true;
    emitTrace(this.effects, 'configuration.aps-provision-complete');
    return Object.freeze(result);
  } catch (error) {
    emitFailureTrace(this.effects, 'configuration.aps-provision-failed', error);
    throw error;
  } finally {
    macAuthorization.disposePushBootstrap(bootstrap);
    var failedKeyId = stagedKeyRecord && stagedKeyRecord.id;
    if (!failedKeyId && provisioned && typeof provisioned.keyId === 'string') failedKeyId = provisioned.keyId;
    if (!completed && typeof failedKeyId === 'string') {
      var deleted = false;
      try {
        // `false` means the opaque handle was already removed by activation's own failure path.
        this.crypto.deleteKey(failedKeyId);
        deleted = true;
      } catch (_) { /* preserve provisioning failure and its durable cleanup obligation */ }
      if (deleted && stagedKeyRecord) {
        try { this.keyLifecycle.completeCleanup(failedKeyId); }
        catch (_) { /* a later session will repeat idempotent deletion and acknowledgement */ }
      }
    }
  }
};

ApsProvisioner.prototype.disconnect = async function () {
  var runner = this.runner;
  this.runner = null;
  if (runner) runner.close();
};

function addActiveKeys(draft, keyRecords) {
  var nextGeneration = draft.generation + 1;
  keyRecords.forEach(function (record) {
    if (!record || typeof record.id !== 'string' || typeof record.purpose !== 'string') {
      throw configurationError('INVALID_CONFIGURATION_STATE', 'Generated key metadata is malformed.', ERROR_KINDS.INTERNAL);
    }
    var duplicate = draft.keyInventory.active.concat(draft.keyInventory.cleanup).some(function (entry) {
      return entry.id === record.id;
    });
    if (duplicate) throw configurationError('INVALID_CONFIGURATION_STATE', 'Generated key ID is already tracked.', ERROR_KINDS.STORAGE);
    draft.keyInventory.active.push({
      id: record.id, purpose: record.purpose, createdGeneration: nextGeneration,
    });
  });
}

function isFreshConfigurationSubmission(credentials) {
  return !!credentials && typeof credentials === 'object'
    && typeof credentials.username === 'string' && credentials.username.length > 0
    && typeof credentials.password === 'string' && credentials.password.length > 0
    && typeof credentials.macValidationData === 'string' && credentials.macValidationData.length > 0;
}

function hasIncompleteSetup(state) {
  if (!state || state.phase === 'ready') return false;
  var artifacts = state.artifacts;
  return state.phase !== 'disconnected'
    || artifacts.provisioning !== null
    || artifacts.push !== null
    || artifacts.authentication !== null
    || artifacts.findMy !== null
    || artifacts.registration !== null
    || Object.keys(artifacts.identities).length > 0
    || Object.keys(artifacts.targetCache).length > 0
    || state.keyInventory.active.length > 0;
}

function canRetryAccountWithExistingPrerequisites(state) {
  if (!state || state.phase === 'ready' || !state.artifacts.provisioning
      || !state.artifacts.push || state.artifacts.authentication !== null
      || state.artifacts.findMy !== null
      || state.artifacts.registration !== null
      || Object.keys(state.artifacts.identities).length > 0
      || Object.keys(state.artifacts.targetCache).length > 0) return false;
  return state.keyInventory.active.length > 0 && state.keyInventory.active.every(function (entry) {
    return entry.purpose === 'aps-signing';
  });
}

function sameMacAuthorization(artifact, candidate) {
  var restored = macAuthorization.restoreMacAuthArtifact(artifact);
  try {
    return JSON.stringify(macAuthorization.macAuthArtifact(restored))
      === JSON.stringify(macAuthorization.macAuthArtifact(candidate));
  } finally {
    macAuthorization.disposeMacAuthToken(restored);
  }
}

function ConfigurationCoordinator(options) {
  options = requireObject(options, 'Configuration coordinator options');
  this.effects = requireObject(options.effects, 'Configuration effects');
  this.crypto = options.crypto;
  this.repository = requireObject(options.repository, 'Durable state repository');
  this.config = requireObject(options.config, 'iMessage configuration');
  var dependencies = options.dependencies || {};
  this.anisette = options.anisette || new RemoteV3AnisetteClient({
    effects: this.effects, crypto: this.crypto, config: this.config.anisette,
    runner: requireObject(options.anisetteRunner, 'RemoteV3 provisioning runner'),
  });
  this.push = options.push || new ApsProvisioner({
    effects: this.effects,
    crypto: this.crypto,
    activatePushIdentity: dependencies.activatePushIdentity,
    ApsClientRunner: dependencies.ApsClientRunner,
    keyLifecycle: Object.freeze({
      stage: function (record) {
        options.repository.recordKeyCleanup(record.id, record.purpose, 'aps-publication-pending');
      },
      completeCleanup: function (keyId) { options.repository.completeKeyCleanup(keyId); },
    }),
  });
  this.AccountLoginSession = dependencies.AccountLoginSession || accountLogin.AccountLoginSession;
  this.authenticateApple = dependencies.authenticateApple || authentication.authenticateApple;
  this.createIdentityBundle = dependencies.createIdentityBundle || identities.createIdentityBundle;
  this.restoreAuthenticationArtifact = dependencies.restoreAuthenticationArtifact || authentication.restoreAuthenticationArtifact;
  this.restoreIdentityArtifact = dependencies.restoreIdentityArtifact || identities.restoreIdentityArtifact;
  this.registerIdentity = dependencies.registerIdentity || registration.registerIdentity;
  this.validationDataGenerator = options.validationDataGenerator || null;
  if (this.validationDataGenerator !== null
      && typeof this.validationDataGenerator.generate !== 'function') {
    throw new TypeError('Configuration Mac validation-data generator is invalid.');
  }
  this.loginSession = null;
  this.mac = null;
  this.busy = false;
  [
    'effects', 'crypto', 'repository', 'config', 'anisette', 'push',
    'validationDataGenerator', 'loginSession', 'mac',
  ].forEach(function (name) {
    Object.defineProperty(this, name, { enumerable: false, writable: true });
  }, this);
}

ConfigurationCoordinator.prototype.setValidationDataGenerator = function (generator) {
  if (!generator || typeof generator.generate !== 'function') {
    throw new TypeError('Configuration Mac validation-data generator is invalid.');
  }
  this.validationDataGenerator = generator;
};

ConfigurationCoordinator.prototype._trace = function (from, to) {
  this.effects.trace.emit(Object.freeze({ kind: 'configuration.state-transition', from: from, to: to }));
};

ConfigurationCoordinator.prototype._setPhase = function (phase) {
  var previous = this.repository.load().phase;
  if (previous === phase) return;
  this.repository.update(function (draft) { draft.phase = phase; });
  this._trace(previous, phase);
};

ConfigurationCoordinator.prototype.status = function () {
  var state = this.repository.load();
  if (state.phase === 'ready') {
    var canonicalHandles;
    try {
      canonicalHandles = registration.registeredMadridHandles(state.artifacts.registration);
    } catch (_) {
      throw configurationError(
        'INVALID_CONFIGURATION_STATE',
        'Persisted iMessage sender registrations are malformed.',
        ERROR_KINDS.STORAGE
      );
    }
    var handlesChanged = canonicalHandles.length !== state.account.handles.length
      || canonicalHandles.some(function (handle, index) {
        return state.account.handles[index] !== handle;
      });
    if (handlesChanged) {
      state = this.repository.update(function (draft) {
        draft.account.handles = canonicalHandles.slice();
      });
    }
  }
  var twoFactorPending = !!this.loginSession && state.phase === 'needs-two-factor';
  var hasValidationDataGenerator = !!this.validationDataGenerator
    && typeof this.validationDataGenerator.generate === 'function';
  return Object.freeze({
    phase: state.phase,
    ready: state.phase === 'ready',
    busy: this.busy,
    canSubmitTwoFactor: twoFactorPending && hasValidationDataGenerator,
    needsMacValidation: twoFactorPending && !hasValidationDataGenerator,
    accountId: state.account.id,
    handles: Object.freeze(state.account.handles.slice()),
    pendingKeyCleanup: state.keyInventory.cleanup.length,
  });
};

/** Validate Mac authorization before endpoint discovery without requiring legacy APS credentials. */
ConfigurationCoordinator.prototype.validateConfigurationInput = function (credentials) {
  var state = this.repository.load();
  var replacement = isFreshConfigurationSubmission(credentials) && hasIncompleteSetup(state);
  if (state.artifacts.push && !replacement) return;
  if (!credentials || typeof credentials !== 'object'
      || typeof credentials.macValidationData !== 'string') {
    throw configurationError('MAC_AUTHORIZATION_REQUIRED', 'Mac authentication data is required.');
  }
  var token = null;
  try {
    token = macAuthorization.parseMacAuthToken(credentials.macValidationData);
    macAuthorization.assertPortableNacCompatible(token);
  } finally {
    macAuthorization.disposeMacAuthToken(token);
  }
};

ConfigurationCoordinator.prototype._install = function (keyRecords, mutation) {
  var coordinator = this;
  var records = keyRecords || [];
  var before;
  try {
    before = this.repository.load();
  } catch (error) {
    // No publication was attempted, so every newly generated key remains untracked.
    this._deleteUninstalled(records);
    throw error;
  }
  var createdGeneration = before.generation + 1;
  try {
    return this.repository.update(function (draft) {
      addActiveKeys(draft, records);
      mutation(draft);
    });
  } catch (error) {
    var recovered;
    try {
      recovered = this.repository.load();
    } catch (_) {
      // Publication may already be durable. Preserve the host keys until storage can be
      // recovered rather than risk leaving a committed artifact pointing at deleted material.
      throw error;
    }
    var installed = records.length > 0 && records.every(function (record) {
      return recovered.keyInventory.active.some(function (active) {
        return active.id === record.id
          && active.purpose === record.purpose
          && active.createdGeneration === createdGeneration;
      });
    });
    if (installed) return recovered;

    var untracked = records.filter(function (record) {
      return !before.keyInventory.active.concat(before.keyInventory.cleanup).some(function (entry) {
        return entry.id === record.id;
      });
    });
    coordinator._deleteUninstalled(untracked);
    throw error;
  }
};

ConfigurationCoordinator.prototype._deleteUninstalled = function (keyRecords) {
  for (var index = keyRecords.length - 1; index >= 0; index -= 1) {
    try { this.crypto.deleteKey(keyRecords[index].id); } catch (_) { /* best effort for an untracked failed install */ }
  }
};

ConfigurationCoordinator.prototype._retryPendingKeyCleanup = function () {
  var pending = this.repository.pendingKeyCleanup().slice();
  for (var index = 0; index < pending.length; index += 1) {
    try {
      this.crypto.deleteKey(pending[index].id);
      this.repository.completeKeyCleanup(pending[index].id);
    } catch (_) { /* keep the durable obligation for the next retry */ }
  }
};

ConfigurationCoordinator.prototype._resetSetup = async function (reason) {
  if (this.loginSession) {
    this.loginSession.dispose();
    this.loginSession = null;
  }
  macAuthorization.disposeMacAuthToken(this.mac);
  this.mac = null;
  if (typeof this.push.disconnect === 'function') await this.push.disconnect();
  var previous = this.repository.load().phase;
  this.repository.resetForDisconnect(reason);
  // Key deletion is idempotent: `false` means the opaque key id is already absent, which
  // satisfies the same durable cleanup obligation as deleting it now. An exception from deletion
  // or durable acknowledgement leaves the obligation queued for a later retry.
  this._retryPendingKeyCleanup();
  this._trace(previous, 'disconnected');
};

ConfigurationCoordinator.prototype._loadMacAuthorization = function (credentials) {
  var state = this.repository.load();
  if (state.artifacts.provisioning) {
    var restored = restoreProvisioningArtifact(state.artifacts.provisioning);
    this.mac = macAuthorization.assertPortableNacCompatible(restored.mac);
    if (state.artifacts.provisioning.mac.validationData !== null) {
      this.repository.update(function (draft) {
        draft.artifacts.provisioning = restored.artifact;
      });
    }
    return this.mac;
  }
  if (!credentials || typeof credentials !== 'object' || typeof credentials.macValidationData !== 'string') {
    throw configurationError('MAC_AUTHORIZATION_REQUIRED', 'Mac authentication data is required.');
  }
  var candidate = null;
  try {
    candidate = macAuthorization.stripLegacyValidationData(
      macAuthorization.parseMacAuthToken(credentials.macValidationData)
    );
    macAuthorization.assertPortableNacCompatible(candidate);
    var artifact = provisioningArtifact(candidate, null);
    this.repository.update(function (draft) { draft.artifacts.provisioning = artifact; });
    this.mac = candidate;
    candidate = null;
    return this.mac;
  } finally {
    macAuthorization.disposeMacAuthToken(candidate);
  }
};

ConfigurationCoordinator.prototype._getAnisetteHeaders = async function () {
  try {
    return await this.anisette.getHeaders();
  } catch (error) {
    if (!error || error.code !== 'ANISETTE_NOT_PROVISIONED'
        || typeof this.anisette.reprovision !== 'function') throw error;
  }

  var before = restoreProvisioningArtifact(this.repository.load().artifacts.provisioning);
  var recovered = await this.anisette.reprovision();
  var next = provisioningArtifact(before.mac, recovered.artifact);
  try {
    this.repository.update(function (draft) { draft.artifacts.provisioning = next; });
  } catch (publicationError) {
    var durable = null;
    try { durable = this.repository.load().artifacts.provisioning; }
    catch (_) { /* restore the known prior live state below */ }
    if (!durable || !sameAnisetteArtifact(durable.anisette, recovered.artifact)) {
      try {
        if (typeof this.anisette.restoreProvisioned === 'function') {
          this.anisette.restoreProvisioned(before.artifact.anisette);
        } else {
          await this.anisette.ensureProvisioned(before.artifact.anisette);
        }
      } catch (_) { /* preserve the storage failure; the setup cannot continue */ }
      throw publicationError;
    }
  }
  // Exactly one retry: another -45061 is surfaced to the account layer as unavailable.
  return this.anisette.getHeaders();
};

ConfigurationCoordinator.prototype._runtimeConfiguration = function (pushToken) {
  if (!this.mac) {
    var persisted = this.repository.load().artifacts.provisioning;
    if (!persisted) throw configurationError('MAC_AUTHORIZATION_REQUIRED', 'Mac authentication data is required.');
    this.mac = restoreProvisioningArtifact(persisted).mac;
  }
  return macAuthorization.deriveMacConfiguration(this.mac, this.effects.clock.now(), pushToken);
};

ConfigurationCoordinator.prototype._applyAdapterConfiguration = function (runtime) {
  if (typeof this.anisette.setClientInfo === 'function') this.anisette.setClientInfo(runtime.anisetteClientInfo);
};

ConfigurationCoordinator.prototype._ensurePrerequisites = async function () {
  this._retryPendingKeyCleanup();
  var blockedActivationCleanup = this.repository.pendingKeyCleanup().some(function (entry) {
    return entry.purpose === 'aps-signing';
  });
  if (blockedActivationCleanup) {
    throw configurationError(
      'APS_KEY_CLEANUP_PENDING',
      'A previous APS activation key could not be cleaned up.',
      ERROR_KINDS.STORAGE
    );
  }
  var state = this.repository.load();
  var persisted = restoreProvisioningArtifact(state.artifacts.provisioning);
  var push = await this.push.ensureProvisioned(state.artifacts.push, this.mac);
  if (!state.artifacts.push) {
    this._installPush(push);
    state = this.repository.load();
  }
  this._applyAdapterConfiguration(this._runtimeConfiguration());
  var provisioned = await this.anisette.ensureProvisioned(persisted.artifact.anisette);
  if (!persisted.artifact.anisette) {
    var nextProvisioning = provisioningArtifact(this.mac, provisioned.artifact);
    this.repository.update(function (draft) { draft.artifacts.provisioning = nextProvisioning; });
  }
  this._applyAdapterConfiguration(this._runtimeConfiguration(push.token));
  return push;
};

ConfigurationCoordinator.prototype._installPush = function (push) {
  var keyRecord = push.keyRecord || { id: push.keyId, purpose: 'aps-signing' };
  var before = this.repository.load();
  var staged = before.keyInventory.cleanup.filter(function (entry) {
    return entry.id === keyRecord.id && entry.purpose === keyRecord.purpose;
  })[0];
  if (!staged) {
    return this._install([keyRecord], function (draft) { draft.artifacts.push = push.artifact; });
  }

  try {
    return this.repository.update(function (draft) {
      var index = -1;
      for (var cursor = 0; cursor < draft.keyInventory.cleanup.length; cursor += 1) {
        if (draft.keyInventory.cleanup[cursor].id === keyRecord.id
            && draft.keyInventory.cleanup[cursor].purpose === keyRecord.purpose) {
          index = cursor;
          break;
        }
      }
      if (index === -1) {
        throw configurationError('INVALID_CONFIGURATION_STATE', 'Staged APS key is missing.', ERROR_KINDS.STORAGE);
      }
      var pending = draft.keyInventory.cleanup.splice(index, 1)[0];
      draft.keyInventory.active.push({
        id: pending.id,
        purpose: pending.purpose,
        createdGeneration: pending.createdGeneration,
      });
      draft.artifacts.push = push.artifact;
    });
  } catch (error) {
    // A storage adapter can report failure after the pending or committed slot was written. If
    // recovery proves both the artifact and key inventory were published, accept that generation;
    // otherwise leave the staged cleanup record intact for the next session.
    var recovered;
    try { recovered = this.repository.load(); } catch (_) { throw error; }
    var published = recovered.artifacts.push
      && recovered.artifacts.push.keyId === keyRecord.id
      && recovered.keyInventory.active.some(function (entry) {
        return entry.id === keyRecord.id && entry.purpose === keyRecord.purpose;
      });
    if (published) return recovered;
    throw error;
  }
};

ConfigurationCoordinator.prototype._publishStaged = function (keyRecords, mutation) {
  var records = keyRecords || [];
  if (records.length === 0) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'No staged keys were provided.', ERROR_KINDS.INTERNAL);
  }
  try {
    return this.repository.update(function (draft) {
      records.forEach(function (record) {
        var index = -1;
        for (var cursor = 0; cursor < draft.keyInventory.cleanup.length; cursor += 1) {
          if (draft.keyInventory.cleanup[cursor].id === record.id
              && draft.keyInventory.cleanup[cursor].purpose === record.purpose) {
            index = cursor;
            break;
          }
        }
        if (index === -1) {
          throw configurationError(
            'INVALID_CONFIGURATION_STATE',
            'Generated persistent key was not staged before publication.',
            ERROR_KINDS.STORAGE
          );
        }
        var staged = draft.keyInventory.cleanup.splice(index, 1)[0];
        draft.keyInventory.active.push({
          id: staged.id,
          purpose: staged.purpose,
          createdGeneration: staged.createdGeneration,
        });
      });
      mutation(draft);
    });
  } catch (error) {
    // Storage may throw after either crash-safe slot is durable. Active inventory can only be
    // written in the same generation as mutation(), so it proves the artifact was published too.
    var recovered;
    try { recovered = this.repository.load(); }
    catch (_) { throw error; }
    var published = records.every(function (record) {
      return recovered.keyInventory.active.some(function (active) {
        return active.id === record.id && active.purpose === record.purpose;
      });
    });
    if (published) return recovered;
    throw error;
  }
};

ConfigurationCoordinator.prototype._createLogin = function (push) {
  var coordinator = this;
  var runtime = this._runtimeConfiguration(push.token);
  this.loginSession = new this.AccountLoginSession({
    effects: this.effects,
    crypto: this.crypto,
    anisette: Object.freeze({ getHeaders: function () { return coordinator._getAnisetteHeaders(); } }),
    clientInfo: runtime.accountClientInfo,
    delegateConfig: runtime.delegateConfig,
    validationDataGenerator: this.validationDataGenerator,
    hardware: this.mac.hardware,
    pushToken: push.token,
  });
};

ConfigurationCoordinator.prototype._ensureAuthentication = async function (credentials, push) {
  var state = this.repository.load();
  if (state.artifacts.authentication) return this.restoreAuthenticationArtifact(state.artifacts.authentication);
  if (!credentials || typeof credentials !== 'object') {
    throw configurationError('CREDENTIALS_REQUIRED', 'Apple account credentials are required.');
  }
  this._createLogin(push);
  var loginStatus = await this.loginSession.start({
    username: credentials.username,
    password: credentials.password,
  });
  credentials = null;
  if (loginStatus.status === 'needs-two-factor') {
    this._setPhase('needs-two-factor');
    return null;
  }
  return this._exchangeDelegate();
};

ConfigurationCoordinator.prototype._exchangeDelegate = async function () {
  var coordinator = this;
  var loginResult = this.loginSession.getResult();
  var delegate = requireObject(loginResult.ids, 'IDS delegate credentials');
  var mobileMe = requireObject(loginResult.mobileMe, 'MobileMe delegate credentials');
  var findMyArtifact = Object.freeze({
    version: 1,
    dsid: requireString(loginResult.dsid, 'iCloud account identifier'),
    username: requireString(loginResult.username, 'Apple account name'),
    fmfToken: requireString(mobileMe.fmfToken, 'Find My Friends authentication token'),
  });
  var idsConfig = requireObject(this.config.ids, 'IDS configuration');
  var runtime = this._runtimeConfiguration();
  var authenticated;
  try {
    authenticated = await this.authenticateApple({
      effects: this.effects,
      crypto: this.crypto,
      endpoint: requireString(idsConfig.authenticationEndpoint, 'IDS authentication endpoint'),
      profileId: delegate.profileId,
      authToken: delegate.authToken,
      protocolVersion: runtime.ids.protocolVersion,
      userAgent: runtime.ids.userAgent,
      onKeyCreated: function (record) {
        coordinator.repository.recordKeyCleanup(
          record.id, record.purpose, 'ids-authentication-publication-pending'
        );
      },
      onKeyDeleted: function (keyId) { coordinator.repository.completeKeyCleanup(keyId); },
    });
  } finally {
    delegate = null;
    this.loginSession.dispose();
    this.loginSession = null;
  }
  this._publishStaged([authenticated.keyRecord], function (draft) {
    draft.artifacts.authentication = authenticated.artifact;
    draft.artifacts.findMy = findMyArtifact;
    draft.account.id = authenticated.userId;
  });
  return authenticated;
};

ConfigurationCoordinator.prototype.findMyRuntime = async function () {
  var state = this.repository.load();
  if (state.phase !== 'ready' || !state.artifacts.findMy) {
    throw configurationError('AUTH_REQUIRED', 'Configure Find My first.', ERROR_KINDS.INVALID_INPUT);
  }
  var findMy = state.artifacts.findMy;
  var expected = ['version', 'dsid', 'username', 'fmfToken'].sort();
  var actual = Object.keys(findMy).sort();
  if (findMy.version !== 1 || actual.length !== expected.length
      || actual.some(function (key, index) { return key !== expected[index]; })) {
    throw configurationError('INVALID_CONFIGURATION_STATE', 'Persisted Find My credentials are malformed.', ERROR_KINDS.STORAGE);
  }
  var push = restorePushArtifact(state.artifacts.push);
  var provisioning = restoreProvisioningArtifact(state.artifacts.provisioning);
  this.mac = provisioning.mac;
  this._applyAdapterConfiguration(this._runtimeConfiguration(push.token));
  await this.anisette.ensureProvisioned(provisioning.artifact.anisette);
  var anisetteHeaders = await this._getAnisetteHeaders();
  return Object.freeze({
    dsid: requireString(findMy.dsid, 'iCloud account identifier'),
    username: requireString(findMy.username, 'Apple account name'),
    fmfToken: requireString(findMy.fmfToken, 'Find My Friends authentication token'),
    apsToken: push.token,
    udid: this.mac.udid,
    productVersion: this.mac.version,
    buildVersion: this.mac.hardware.osBuildNum,
    productType: this.mac.hardware.productName,
    icloudUa: this.mac.icloudUa,
    anisetteHeaders: anisetteHeaders,
  });
};

ConfigurationCoordinator.prototype._ensureIdentity = function () {
  var state = this.repository.load();
  if (state.artifacts.identities.primary) return this.restoreIdentityArtifact(state.artifacts.identities.primary);
  var coordinator = this;
  var generated = this.createIdentityBundle(this.crypto, {
    onKeyCreated: function (record) {
      coordinator.repository.recordKeyCleanup(
        record.id, record.purpose, 'ids-identity-publication-pending'
      );
    },
    onKeyDeleted: function (keyId) { coordinator.repository.completeKeyCleanup(keyId); },
  });
  this._publishStaged(generated.keyRecords, function (draft) {
    draft.artifacts.identities.primary = generated.artifact;
  });
  return generated;
};

ConfigurationCoordinator.prototype._finish = async function (authenticated, push) {
  var identity = this._ensureIdentity();
  var idsConfig = requireObject(this.config.ids, 'IDS configuration');
  var runtime = this._runtimeConfiguration(push.token);
  if (!this.validationDataGenerator || typeof this.validationDataGenerator.generate !== 'function') {
    throw configurationError(
      'MAC_VALIDATION_REQUIRED',
      'Fresh Mac validation data is required to register iMessage.',
      ERROR_KINDS.INVALID_INPUT
    );
  }
  var validationData = null;
  var result;
  var coordinator = this;
  try {
    result = await this.registerIdentity({
      effects: this.effects,
      crypto: this.crypto,
      users: [authenticated],
      identity: identity,
      handlesEndpoint: idsConfig.handlesEndpoint,
      registrationEndpoint: idsConfig.registrationEndpoint,
      pushKeyId: push.keyId,
      pushCertificate: push.certificate,
      pushToken: push.token,
      validationDataProvider: async function () {
        if (validationData !== null) {
          throw configurationError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data cannot be reused.');
        }
        // registerIdentity invokes this only after handle discovery and request prerequisites.
        validationData = await coordinator.validationDataGenerator.generate(coordinator.mac.hardware);
        bytes.assertBytes(validationData, 'IDS validation data');
        if (validationData.length === 0) {
          throw configurationError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data is empty.');
        }
        return validationData;
      },
      userAgent: runtime.ids.userAgent,
      metadata: runtime.ids.registrationMetadata,
    });
    if (validationData === null) {
      throw configurationError('MAC_VALIDATION_REQUIRED', 'IDS registration skipped fresh Mac validation data.');
    }
  } finally {
    if (validationData instanceof Uint8Array) validationData.fill(0);
  }
  var previous = this.repository.load().phase;
  this.repository.update(function (draft) {
    draft.artifacts.registration = result.artifact;
    draft.account.id = authenticated.userId;
    draft.account.handles = result.handles.slice();
    draft.phase = 'ready';
  });
  this._trace(previous, 'ready');
  return this.status();
};

ConfigurationCoordinator.prototype.configure = async function (credentials) {
  if (this.busy) throw configurationError('CONFIGURATION_IN_PROGRESS', 'Configuration is already in progress.');
  var initialState = this.repository.load();
  if (initialState.phase === 'ready') return this.status();
  this.busy = true;
  try {
    if (isFreshConfigurationSubmission(credentials) && hasIncompleteSetup(initialState)) {
      // Validate the replacement token before retiring a recoverable partial setup. A complete
      // explicit submission usually means "start over". Account authentication is the one safe
      // exception: retrying the same Mac must preserve its provisioned Anisette identity and APS
      // credentials. Reprovisioning them for every password attempt causes Apple to reject the
      // GrandSlam completion request, and there are no account or IDS artifacts to become stale.
      var replacementMac = macAuthorization.parseMacAuthToken(credentials.macValidationData);
      try {
        macAuthorization.assertPortableNacCompatible(replacementMac);
        var preservePrerequisites = canRetryAccountWithExistingPrerequisites(initialState)
          && sameMacAuthorization(initialState.artifacts.provisioning.mac, replacementMac);
        if (!preservePrerequisites) await this._resetSetup('reconfigure');
      } finally {
        macAuthorization.disposeMacAuthToken(replacementMac);
      }
    }
    if (this.loginSession) {
      this.loginSession.dispose();
      this.loginSession = null;
    }
    this._loadMacAuthorization(credentials);
    this._setPhase('configuring');
    var push = await this._ensurePrerequisites();
    var authenticated = await this._ensureAuthentication(credentials, push);
    credentials = null;
    if (authenticated) await this._finish(authenticated, push);
  } catch (error) {
    emitFailureTrace(this.effects, 'configuration.failed', error);
    credentials = null;
    if (this.loginSession) {
      try { this.loginSession.dispose(); } catch (_) { /* preserve configuration failure */ }
      this.loginSession = null;
    }
    throw errors.asRuntimeError(error, 'CONFIGURATION_FAILED', 'iMessage configuration failed.', {
      kind: ERROR_KINDS.INTERNAL,
    });
  } finally {
    macAuthorization.disposeMacAuthToken(this.mac);
    this.busy = false;
  }
  return this.status();
};

ConfigurationCoordinator.prototype.submitTwoFactor = async function (code) {
  if (this.busy) throw configurationError('CONFIGURATION_IN_PROGRESS', 'Configuration is already in progress.');
  if (!this.loginSession || this.repository.load().phase !== 'needs-two-factor') {
    throw configurationError('TWO_FACTOR_NOT_PENDING', 'No two-factor verification is pending.');
  }
  if (this.status().canSubmitTwoFactor !== true) {
    throw configurationError(
      'MAC_VALIDATION_REQUIRED',
      'Fresh Mac validation data is required to finish account login.',
      ERROR_KINDS.INVALID_INPUT
    );
  }
  this.busy = true;
  try {
    var loginStatus = await this.loginSession.submitTwoFactorCode(code);
    code = null;
    if (loginStatus.status !== 'needs-two-factor') {
      this._setPhase('configuring');
      var authenticated = await this._exchangeDelegate();
      var push = restorePushArtifact(this.repository.load().artifacts.push);
      await this._finish(authenticated, push);
    }
  } catch (error) {
    code = null;
    var normalized = errors.asRuntimeError(error, 'CONFIGURATION_FAILED', 'iMessage configuration failed.', {
      kind: ERROR_KINDS.INTERNAL,
    });
    emitFailureTrace(this.effects, 'configuration.two-factor-failed', normalized);
    if (normalized.code !== 'INVALID_TWO_FACTOR_CODE') {
      if (this.loginSession) {
        try { this.loginSession.dispose(); } catch (_) { /* preserve the terminal login failure */ }
        this.loginSession = null;
      }
      if (this.repository.load().phase === 'needs-two-factor') this._setPhase('configuring');
    }
    throw normalized;
  } finally {
    this.busy = false;
  }
  return this.status();
};

ConfigurationCoordinator.prototype.disconnect = async function () {
  if (this.busy) throw configurationError('CONFIGURATION_IN_PROGRESS', 'Configuration is already in progress.');
  this.busy = true;
  try {
    await this._resetSetup('disconnect');
  } finally {
    this.busy = false;
  }
  return this.status();
};

ConfigurationCoordinator.prototype.toJSON = function () { return this.status(); };

module.exports = {
  ApsProvisioner: ApsProvisioner,
  ConfigurationCoordinator: ConfigurationCoordinator,
  RemoteV3AnisetteClient: RemoteV3AnisetteClient,
  anisetteArtifact: anisetteArtifact,
  pushArtifact: pushArtifact,
  restoreAnisetteArtifact: restoreAnisetteArtifact,
  provisioningArtifact: provisioningArtifact,
  restoreProvisioningArtifact: restoreProvisioningArtifact,
  restorePushArtifact: restorePushArtifact,
};
