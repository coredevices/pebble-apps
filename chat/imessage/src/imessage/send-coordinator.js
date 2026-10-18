'use strict';

var ApsClientRunner = require('../aps/client-runner').ApsClientRunner;
var apsMessages = require('../aps/messages');
var configurationArtifacts = require('../configuration/coordinator');
var macAuth = require('../configuration/mac-auth-token');
var authentication = require('../ids/authentication');
var protobuf = require('../codecs/protobuf');
var bytes = require('../runtime/bytes');
var scheduleDeadline = require('../runtime/deadline').scheduleDeadline;
var errors = require('../runtime/errors');
var identities = require('../ids/identities');
var idsBag = require('../ids/bag');
var legacyEncryption = require('../ids/legacy-encryption');
var lookup = require('../ids/lookup');
var ngm = require('../ids/ngm-pair-ec');
var publicIdentity = require('../ids/public-identity');
var registration = require('../ids/registration');
var sendEnvelope = require('../ids/send-envelope');
var sendRetry = require('../ids/send-retry');
var plainText = require('./plain-text');
var recipientLogic = require('./recipient');

var RuntimeError = errors.RuntimeError;
var ERROR_KINDS = errors.ERROR_KINDS;
var MADRID_TOPIC = registration.MADRID_SERVICE;
var MAX_DELIVERY_IDENTITIES = 1024;
var DEFAULT_LOOKUP_TIMEOUT_MILLIS = 30000;
var DEFAULT_SEND_ACK_TIMEOUT_MILLIS = 15000;
var DEFAULT_SEND_RESULT_TIMEOUT_MILLIS = 30000;
var MAX_PENDING_APS_EVENTS = MAX_DELIVERY_IDENTITIES + sendEnvelope.MAX_BATCH_COUNT + 1;

function sendError(code, message, kind, details, retryable) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.INVALID_INPUT,
    details: details,
    retryable: retryable === true,
  });
}

function timeoutOption(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(name + ' must be a positive integer.');
  }
  return value;
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw sendError('INVALID_SEND_STATE', name + ' is missing or malformed.', ERROR_KINDS.STORAGE);
  }
  return value;
}

function requireDictionary(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new TypeError(name + ' is malformed.');
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384) {
    throw sendError('INVALID_SEND_STATE', name + ' is missing or malformed.', ERROR_KINDS.STORAGE);
  }
  return value;
}

function normalizedHandle(value, name) {
  if (typeof value !== 'string'
      || !/^(mailto:[^@\s]+@[^@\s]+|tel:\+[1-9][0-9]{6,14})$/.test(value)) {
    throw sendError('INVALID_RECIPIENT', name + ' is not one normalized IDS handle.');
  }
  return value;
}

function persistedHandle(value, name) {
  try { return normalizedHandle(value, name); }
  catch (_) {
    throw sendError('INVALID_SEND_STATE', name + ' is malformed.', ERROR_KINDS.STORAGE);
  }
}

function exactKeys(value, expected, name) {
  var actual = Object.keys(value).sort();
  expected = expected.slice().sort();
  if (actual.length !== expected.length || actual.some(function (key, index) {
    return key !== expected[index];
  })) throw sendError('INVALID_SEND_STATE', name + ' has unexpected fields.', ERROR_KINDS.STORAGE);
}

function decodeArtifactBytes(value, name, length) {
  if (typeof value !== 'string') {
    throw sendError('INVALID_SEND_STATE', name + ' is malformed.', ERROR_KINDS.STORAGE);
  }
  var decoded;
  try { decoded = bytes.base64ToBytes(value); }
  catch (_) { throw sendError('INVALID_SEND_STATE', name + ' is malformed.', ERROR_KINDS.STORAGE); }
  if (decoded.length === 0 || (length !== undefined && decoded.length !== length)) {
    throw sendError('INVALID_SEND_STATE', name + ' is malformed.', ERROR_KINDS.STORAGE);
  }
  return decoded;
}

function restoreMadridRegistration(artifact, sender) {
  artifact = requireObject(artifact, 'Persisted IDS registration');
  if (artifact.version === 1) {
    exactKeys(artifact, ['version', 'registrations'], 'Persisted IDS registration');
  } else if (artifact.version === 2) {
    exactKeys(artifact, ['version', 'pushToken', 'registrations'], 'Persisted IDS registration');
  } else if (artifact.version === 3) {
    exactKeys(
      artifact,
      ['version', 'pushToken', 'serviceDataHash', 'registrations'],
      'Persisted IDS registration'
    );
    if (typeof artifact.serviceDataHash !== 'string'
        || !/^[0-9a-f]{64}$/.test(artifact.serviceDataHash)) {
      throw sendError(
        'INVALID_SEND_STATE',
        'Persisted IDS service metadata hash is malformed.',
        ERROR_KINDS.STORAGE
      );
    }
  } else {
    throw sendError('INVALID_SEND_STATE', 'Persisted IDS registration is unsupported.', ERROR_KINDS.STORAGE);
  }
  if (!Array.isArray(artifact.registrations)
      || artifact.registrations.length === 0 || artifact.registrations.length > 32) {
    throw sendError('INVALID_SEND_STATE', 'Persisted IDS registration is unsupported.', ERROR_KINDS.STORAGE);
  }
  var registeredPushToken = artifact.version >= 2
    ? decodeArtifactBytes(artifact.pushToken, 'Persisted IDS registration push token', 32)
    : null;
  var serviceDataHash = artifact.version === 3 ? artifact.serviceDataHash : null;
  var selected = null;
  artifact.registrations.forEach(function (value) {
    value = requireObject(value, 'Persisted IDS registration record');
    exactKeys(value, [
      'service', 'userId', 'keyId', 'certificate', 'handles',
      'registeredAtSeconds', 'heartbeatIntervalSeconds',
    ], 'Persisted IDS registration record');
    if (typeof value.service !== 'string' || typeof value.userId !== 'string'
        || typeof value.keyId !== 'string' || value.keyId.length === 0
        || !Array.isArray(value.handles) || value.handles.length === 0
        || !Number.isSafeInteger(value.registeredAtSeconds) || value.registeredAtSeconds < 0
        || (value.heartbeatIntervalSeconds !== null
          && (!Number.isSafeInteger(value.heartbeatIntervalSeconds)
            || value.heartbeatIntervalSeconds < 0))) {
      throw sendError('INVALID_SEND_STATE', 'Persisted IDS registration record is malformed.', ERROR_KINDS.STORAGE);
    }
    value.handles.forEach(function (handle) { persistedHandle(handle, 'Persisted sender handle'); });
    var restored = Object.freeze({
      service: value.service,
      userId: value.userId,
      keyId: value.keyId,
      certificate: decodeArtifactBytes(value.certificate, 'Persisted IDS certificate'),
      handles: Object.freeze(value.handles.slice()),
      registeredAtSeconds: value.registeredAtSeconds,
      heartbeatIntervalSeconds: value.heartbeatIntervalSeconds,
      pushToken: registeredPushToken === null ? null : new Uint8Array(registeredPushToken),
      serviceDataHash: serviceDataHash,
    });
    if (value.service === MADRID_TOPIC && value.handles.indexOf(sender) !== -1 && selected === null) {
      selected = restored;
    }
  });
  if (!selected) {
    throw sendError('INVALID_SEND_STATE', 'No Madrid registration covers the selected sender.', ERROR_KINDS.STORAGE);
  }
  return selected;
}

function registrationHeartbeatElapsed(registered, nowMs) {
  if (!registered || registered.heartbeatIntervalSeconds === null) return false;
  if (!Number.isSafeInteger(registered.registeredAtSeconds)
      || !Number.isSafeInteger(registered.heartbeatIntervalSeconds)
      || !Number.isFinite(nowMs)) {
    throw new TypeError('IDS registration heartbeat state is malformed.');
  }
  var nowSeconds = Math.floor(nowMs / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < registered.registeredAtSeconds) return false;
  return nowSeconds - registered.registeredAtSeconds >= registered.heartbeatIntervalSeconds;
}

function decodeKtDeviceKey(encoded) {
  if (!(encoded instanceof Uint8Array)) throw new TypeError('NGM device identity is malformed.');
  var outer = new protobuf.ProtobufReader(encoded, {
    maxMessageLength: 4096, maxFieldLength: 1024, maxFields: 32,
  });
  var nested = null;
  for (var field = outer.nextField(); field !== null; field = outer.nextField()) {
    if (field.number === 1) {
      if (nested !== null) throw new TypeError('NGM device identity has duplicate keys.');
      nested = outer.readBytes(field);
    } else {
      outer.skipField(field);
    }
  }
  outer.finish();
  if (nested === null) throw new TypeError('NGM device identity has no key.');

  var inner = new protobuf.ProtobufReader(nested, {
    maxMessageLength: 1024, maxFieldLength: 256, maxFields: 16,
  });
  var key = null;
  for (field = inner.nextField(); field !== null; field = inner.nextField()) {
    if (field.number === 1) {
      if (key !== null) throw new TypeError('NGM device identity has duplicate public keys.');
      key = inner.readBytes(field);
    } else {
      inner.skipField(field);
    }
  }
  inner.finish();
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new TypeError('NGM device identity public key is malformed.');
  }
  ngm.compactP256ToSpki(key);
  return key;
}

function requireDeliveryBytes(value, name, length) {
  if (!(value instanceof Uint8Array) || value.length === 0
      || (length !== undefined && value.length !== length)) {
    throw new TypeError(name + ' is malformed.');
  }
  return new Uint8Array(value);
}

function normalizeDeliveryRecord(participant, value) {
  value = requireDictionary(value, 'IDS delivery identity');
  var clientData = requireDictionary(value['client-data'], 'IDS delivery client data');
  var encodedLegacy = requireDeliveryBytes(
    clientData['public-message-identity-key'],
    'IDS public message identity'
  );
  var decodedLegacy = publicIdentity.decodePublicIdentity(encodedLegacy);
  var pushToken = requireDeliveryBytes(value['push-token'], 'IDS delivery push token', 32);
  var sessionToken = requireDeliveryBytes(value['session-token'], 'IDS delivery session token');
  ['session-token-expires-seconds', 'session-token-refresh-seconds'].forEach(function (name) {
    if (!Number.isSafeInteger(value[name]) || value[name] < 0) {
      throw new TypeError('IDS delivery token lifetime is malformed.');
    }
  });

  var encodedDevice = value['kt-loggable-data'] === undefined
    ? clientData['ngm-public-identity']
    : value['kt-loggable-data'];
  var preKeyData = clientData['public-message-ngm-device-prekey-data-key'];
  var deviceKey = encodedDevice === undefined ? null : decodeKtDeviceKey(encodedDevice);
  if (preKeyData !== undefined) preKeyData = requireDeliveryBytes(preKeyData, 'IDS NGM prekey data');

  return Object.freeze({
    participant: participant,
    pushToken: pushToken,
    sessionToken: sessionToken,
    legacyIdentity: Object.freeze({
      signingPublicKey: new Uint8Array(decodedLegacy.signingPublicKey),
      encryptionPublicKey: new Uint8Array(decodedLegacy.encryptionPublicKey),
    }),
    deviceKey: deviceKey,
    preKeyData: preKeyData || null,
    supportsCertifiedDeliveryV1: clientData['supports-certified-delivery-v1'] === true,
  });
}

/** Normalize the exact send-only IDS lookup subset and remove this connection's own device. */
function normalizeDeliveryIdentities(results, participants, currentPushToken) {
  results = requireDictionary(results, 'IDS lookup results');
  if (!Array.isArray(participants) || participants.length === 0) {
    throw new TypeError('IDS lookup participants are required.');
  }
  requireDeliveryBytes(currentPushToken, 'current push token', 32);
  var output = [];
  var count = 0;
  participants.forEach(function (participant) {
    normalizedHandle(participant, 'IDS lookup participant');
    var result = results[participant];
    if (result === undefined) return;
    result = requireDictionary(result, 'IDS participant lookup result');
    if (!Array.isArray(result.identities)) throw new TypeError('IDS participant identities are malformed.');
    result.identities.forEach(function (identity) {
      count += 1;
      if (count > MAX_DELIVERY_IDENTITIES) throw new TypeError('IDS lookup returned too many identities.');
      var normalized = normalizeDeliveryRecord(participant, identity);
      if (!bytes.bytesEqual(normalized.pushToken, currentPushToken)) output.push(normalized);
    });
  });
  return Object.freeze(output);
}

function uniqueParticipants(recipient, sender) {
  return recipient === sender ? [recipient] : [recipient, sender];
}

function nextApsId(randomBytes) {
  if (!(randomBytes instanceof Uint8Array) || randomBytes.length !== 4) {
    throw new TypeError('APS identifier randomness must contain four bytes.');
  }
  return (bytes.readUint32BE(randomBytes) % 0x7fffffff) + 1;
}

function EventChannel() {
  this.queue = [];
  this.waiters = [];
  this.failure = null;
}

EventChannel.prototype.push = function (event) {
  if (this.failure) return;
  if (event && event.type === 'error') {
    try { this.fail(errors.deserializeRuntimeError(event.error)); }
    catch (_) { this.fail(sendError('APS_PROTOCOL_FAILED', 'APS client failed.', ERROR_KINDS.TRANSPORT)); }
    return;
  }
  for (var index = 0; index < this.waiters.length; index += 1) {
    if (this.waiters[index].predicate(event)) {
      var waiter = this.waiters.splice(index, 1)[0];
      waiter.resolve(event);
      return;
    }
  }
  if (event && (event.type === 'lookupResult' || event.type === 'sendResult'
      || event.type === 'sendAcknowledged')) {
    if (this.queue.length >= MAX_PENDING_APS_EVENTS) {
      this.fail(sendError('APS_EVENT_OVERFLOW', 'APS client produced too many pending events.', ERROR_KINDS.TRANSPORT));
    } else {
      this.queue.push(event);
    }
  }
};

EventChannel.prototype.next = function (predicate) {
  if (this.failure) return Promise.reject(this.failure);
  for (var index = 0; index < this.queue.length; index += 1) {
    if (predicate(this.queue[index])) return Promise.resolve(this.queue.splice(index, 1)[0]);
  }
  var self = this;
  return new Promise(function (resolve, reject) {
    self.waiters.push({ predicate: predicate, resolve: resolve, reject: reject });
  });
};

EventChannel.prototype.fail = function (error) {
  if (this.failure) return;
  this.failure = error;
  var waiters = this.waiters.splice(0);
  waiters.forEach(function (waiter) { waiter.reject(error); });
  this.queue = [];
};

function SendCoordinator(options) {
  options = requireObject(options, 'Send coordinator options');
  this.effects = requireObject(options.effects, 'Send effects');
  this.crypto = requireObject(options.crypto, 'Send crypto');
  this.repository = requireObject(options.repository, 'Durable state repository');
  this.sender = options.sender === undefined || options.sender === null
    ? null
    : persistedHandle(options.sender, 'Selected sender handle');
  if (!this.effects.http || typeof this.effects.http.request !== 'function'
      || !this.effects.random || typeof this.effects.random.bytes !== 'function'
      || !this.effects.clock || typeof this.effects.clock.now !== 'function') {
    throw new TypeError('Send coordinator HTTP, random, and clock effects are required.');
  }
  if (typeof this.repository.load !== 'function'
      || typeof this.repository.update !== 'function'
      || typeof this.repository.reserveMessageCounter !== 'function') {
    throw new TypeError('Send coordinator durable repository is invalid.');
  }
  var dependencies = options.dependencies || {};
  this.ApsClientRunner = dependencies.ApsClientRunner || ApsClientRunner;
  this.restorePushArtifact = dependencies.restorePushArtifact || configurationArtifacts.restorePushArtifact;
  this.restoreProvisioningArtifact = dependencies.restoreProvisioningArtifact
    || configurationArtifacts.restoreProvisioningArtifact;
  this.restoreIdentityArtifact = dependencies.restoreIdentityArtifact || identities.restoreIdentityArtifact;
  this.restoreAuthenticationArtifact = dependencies.restoreAuthenticationArtifact
    || authentication.restoreAuthenticationArtifact;
  this.registerIdentity = dependencies.registerIdentity || registration.registerIdentity;
  this.deriveMacConfiguration = dependencies.deriveMacConfiguration || macAuth.deriveMacConfiguration;
  this.validationDataGeneratorFactory = options.validationDataGeneratorFactory || null;
  if (this.validationDataGeneratorFactory !== null
      && typeof this.validationDataGeneratorFactory !== 'function') {
    throw new TypeError('Send coordinator Mac validation-data generator factory is invalid.');
  }
  this.encryptPairEc = dependencies.encryptPairEc || ngm.encryptPairEc;
  this.encryptLegacyPayload = dependencies.encryptLegacyPayload || legacyEncryption.encryptLegacyPayload;
  this.lookupTimeoutMillis = timeoutOption(
    options.lookupTimeoutMillis,
    DEFAULT_LOOKUP_TIMEOUT_MILLIS,
    'IDS lookup timeout'
  );
  this.sendResultTimeoutMillis = timeoutOption(
    options.sendResultTimeoutMillis,
    DEFAULT_SEND_RESULT_TIMEOUT_MILLIS,
    'iMessage send-result timeout'
  );
  this.sendAckTimeoutMillis = timeoutOption(
    options.sendAckTimeoutMillis,
    DEFAULT_SEND_ACK_TIMEOUT_MILLIS,
    'iMessage APS acknowledgement timeout'
  );
  if (typeof this.restoreProvisioningArtifact !== 'function') {
    throw new TypeError('Send coordinator provisioning artifact API is unavailable.');
  }
  this.busy = false;
}

SendCoordinator.prototype._restore = function () {
  var state = this.repository.load();
  if (state.phase !== 'ready') {
    throw sendError('AUTH_REQUIRED', 'Configure iMessage before sending.');
  }
  if (!Array.isArray(state.account.handles) || state.account.handles.length === 0) {
    throw sendError('INVALID_SEND_STATE', 'Persisted sender handles are missing.', ERROR_KINDS.STORAGE);
  }
  var sender = this.sender === null
    ? persistedHandle(state.account.handles[0], 'Persisted sender handle')
    : this.sender;
  if (state.account.handles.indexOf(sender) === -1) {
    throw sendError('INVALID_SEND_STATE', 'Selected sender is not registered for this Apple ID.', ERROR_KINDS.STORAGE);
  }
  var provisioning = this.restoreProvisioningArtifact(state.artifacts.provisioning);
  if (!provisioning || !provisioning.mac) {
    throw sendError('INVALID_SEND_STATE', 'Persisted Mac authorization is missing.', ERROR_KINDS.STORAGE);
  }
  if (state.artifacts.provisioning.mac.validationData !== null) {
    this.repository.update(function (draft) {
      draft.artifacts.provisioning = provisioning.artifact;
    });
  }
  var push = this.restorePushArtifact(state.artifacts.push);
  var identity = this.restoreIdentityArtifact(state.artifacts.identities.primary);
  var registered = restoreMadridRegistration(state.artifacts.registration, sender);
  var nowMs = this.effects.clock.now();
  var macConfig = this.deriveMacConfiguration(provisioning.mac, nowMs, push.token);
  if (!macConfig || !macConfig.ids) {
    throw sendError('INVALID_SEND_STATE', 'Persisted Mac configuration is malformed.', ERROR_KINDS.STORAGE);
  }
  return Object.freeze({
    sender: sender,
    provisioning: provisioning,
    push: push,
    identity: identity,
    authenticationArtifact: state.artifacts.authentication,
    registration: registered,
    registrationNeedsRefresh: registered.pushToken === null
      || !bytes.bytesEqual(registered.pushToken, push.token)
      || registration.registrationNeedsRefresh(
        registered,
        registration.madridServiceDataHash(this.crypto),
        nowMs
      ),
    idsConfig: macConfig.ids,
  });
};

SendCoordinator.prototype._fetchIdsEndpoints = function () {
  return idsBag.fetchIdsEndpoints(this.effects);
};

SendCoordinator.prototype._persistConnectedPush = function (restored, connectedPush) {
  var normalized = this.restorePushArtifact(configurationArtifacts.pushArtifact(connectedPush));
  this.repository.update(function (draft) {
    draft.artifacts.push = normalized.artifact;
  });
  return Object.freeze({
    sender: restored.sender,
    provisioning: restored.provisioning,
    push: normalized,
    identity: restored.identity,
    authenticationArtifact: restored.authenticationArtifact,
    registration: restored.registration,
    registrationNeedsRefresh: true,
    idsConfig: restored.idsConfig,
  });
};

SendCoordinator.prototype._refreshRegistration = async function (restored, endpoints) {
  var authenticated = this.restoreAuthenticationArtifact(restored.authenticationArtifact);
  var runtime = this.deriveMacConfiguration(
    restored.provisioning.mac,
    this.effects.clock.now(),
    restored.push.token
  );
  if (!runtime || !runtime.ids) {
    throw sendError('INVALID_SEND_STATE', 'Persisted Mac configuration is malformed.', ERROR_KINDS.STORAGE);
  }
  if (!this.validationDataGeneratorFactory) {
    throw sendError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data is required to refresh iMessage registration.');
  }
  var generator = this.validationDataGeneratorFactory(endpoints);
  if (!generator || typeof generator.generate !== 'function') {
    throw sendError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data is unavailable.');
  }
  var validationData = null;
  var refreshed;
  try {
    refreshed = await this.registerIdentity({
      effects: this.effects,
      crypto: this.crypto,
      users: [authenticated],
      identity: restored.identity,
      handlesEndpoint: endpoints.handlesEndpoint,
      registrationEndpoint: endpoints.registrationEndpoint,
      pushKeyId: restored.push.keyId,
      pushCertificate: restored.push.certificate,
      pushToken: restored.push.token,
      validationDataProvider: async function () {
        if (validationData !== null) {
          throw sendError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data cannot be reused.');
        }
        validationData = await generator.generate(restored.provisioning.mac.hardware);
        bytes.assertBytes(validationData, 'IDS validation data');
        if (validationData.length === 0) {
          throw sendError('MAC_VALIDATION_REQUIRED', 'Fresh Mac validation data is empty.');
        }
        return validationData;
      },
      userAgent: runtime.ids.userAgent,
      metadata: runtime.ids.registrationMetadata,
    });
    if (validationData === null) {
      throw sendError('MAC_VALIDATION_REQUIRED', 'IDS registration skipped fresh Mac validation data.');
    }
  } finally {
    if (validationData instanceof Uint8Array) validationData.fill(0);
  }
  if (!Array.isArray(refreshed.handles) || refreshed.handles.length === 0) {
    throw sendError('INVALID_SEND_STATE', 'Refreshed IDS registration has no sender handles.', ERROR_KINDS.STORAGE);
  }
  var handles = refreshed.handles.map(function (handle) {
    return persistedHandle(handle, 'Refreshed sender handle');
  });
  var sender = handles.indexOf(restored.sender) === -1
    ? recipientLogic.preferredSender(handles)
    : restored.sender;
  var registered = restoreMadridRegistration(refreshed.artifact, sender);
  if (registered.pushToken === null || !bytes.bytesEqual(registered.pushToken, restored.push.token)) {
    throw sendError('INVALID_SEND_STATE', 'Refreshed IDS registration has no current push-token binding.', ERROR_KINDS.STORAGE);
  }
  this.repository.update(function (draft) {
    draft.artifacts.registration = refreshed.artifact;
    draft.account.handles = handles.slice();
  });
  this.sender = sender;
  return Object.freeze({
    sender: sender,
    provisioning: restored.provisioning,
    push: restored.push,
    identity: restored.identity,
    authenticationArtifact: restored.authenticationArtifact,
    registration: registered,
    registrationNeedsRefresh: false,
    idsConfig: runtime.ids,
  });
};

SendCoordinator.prototype._encryptTargets = function (delivery, restored, body) {
  var self = this;
  var localLegacy = publicIdentity.decodePublicIdentity(restored.identity.publicIdentity);
  var localIdentity = {
    signingKeyId: restored.identity.legacySigning.keyId,
    signingPublicKey: localLegacy.signingPublicKey,
    encryptionPublicKey: localLegacy.encryptionPublicKey,
  };
  return delivery.map(function (target) {
    var encrypted;
    if (target.deviceKey && target.preKeyData) {
      encrypted = self.encryptPairEc({
        crypto: self.crypto,
        sender: {
          deviceKeyId: restored.identity.device.keyId,
          devicePublicKey: restored.identity.device.publicKeySpki,
        },
        target: { deviceKey: target.deviceKey, preKeyData: target.preKeyData },
        message: body,
        reserveCounter: function (scope) { return self.repository.reserveMessageCounter(scope); },
      });
    } else {
      encrypted = {
        payload: self.encryptLegacyPayload(self.crypto, {
          localIdentity: localIdentity,
          targetIdentity: target.legacyIdentity,
          body: body,
          randomKeyBytes: self.crypto.random(11),
        }),
        format: 'pair',
      };
    }
    return Object.freeze({
      participant: target.participant,
      pushToken: target.pushToken,
      sessionToken: target.sessionToken,
      payload: encrypted.payload,
      encryption: encrypted.format,
      supportsCertifiedDeliveryV1: target.supportsCertifiedDeliveryV1,
    });
  });
};

SendCoordinator.prototype._lookupDelivery = async function (
  events,
  runner,
  restored,
  connectedPush,
  idsEndpoints,
  topicHash,
  participants
) {
  var lookupId = nextApsId(this.effects.random.bytes(4));
  var tunnel = lookup.buildLookupTunnel({
    recipients: participants,
    sender: restored.sender,
    pushToken: connectedPush.token,
    protocolVersion: restored.idsConfig.protocolVersion,
    userAgent: restored.idsConfig.userAgent,
    mainService: MADRID_TOPIC,
    subService: MADRID_TOPIC,
    lookupUrl: idsEndpoints.lookupEndpoint,
    tunnelId: this.effects.random.bytes(16),
    crypto: this.crypto,
    keyId: restored.registration.keyId,
    certificate: restored.registration.certificate,
    nowMs: this.effects.clock.now(),
    nonceRandomBytes: this.effects.random.bytes(8),
  });
  runner.sendLookupTunnel({ id: lookupId, topicHash: topicHash, tunnel: tunnel });
  var lookupResults = await this._waitForLookup(events, lookupId);
  return normalizeDeliveryIdentities(lookupResults, participants, connectedPush.token);
};

SendCoordinator.prototype._waitForLookup = async function (events, apsId) {
  var timeout = sendError(
    'IDS_LOOKUP_TIMEOUT',
    'Timed out waiting for the IDS lookup response.',
    ERROR_KINDS.TIMEOUT,
    { timeoutMillis: this.lookupTimeoutMillis },
    true
  );
  var deadline = scheduleDeadline(this.effects.timer, this.lookupTimeoutMillis, function () {
    events.fail(timeout);
  });
  var lookupResults = null;
  var acknowledged = false;
  try {
    while (lookupResults === null || !acknowledged) {
      var event = await events.next(function (candidate) {
        return candidate && ((candidate.type === 'lookupResult' && candidate.apsId === apsId)
          || (candidate.type === 'sendAcknowledged' && candidate.id === apsId));
      });
      if (event.type === 'sendAcknowledged') {
        if (event.status !== 0) {
          throw sendError('IDS_LOOKUP_REJECTED', 'APS rejected the IDS lookup request.', ERROR_KINDS.TRANSPORT, {
            status: event.status,
          });
        }
        acknowledged = true;
      } else {
        lookupResults = event.results;
      }
    }
  } finally {
    deadline.cancel();
  }
  return lookupResults;
};

SendCoordinator.prototype._waitForRecipientSuccess = async function (events, apsId, tracker) {
  var expectedCount = tracker.expectedPushTokens().length;
  var timeout = sendError(
    'IMESSAGE_SEND_TIMEOUT',
    'Timed out waiting for recipient delivery results.',
    ERROR_KINDS.TIMEOUT,
    { timeoutMillis: this.sendResultTimeoutMillis, expectedTargets: expectedCount },
    true
  );
  var deadline = scheduleDeadline(this.effects.timer, this.sendResultTimeoutMillis, function () {
    events.fail(timeout);
  });
  try {
    while (true) {
      var event = await events.next(function (candidate) {
        return candidate && ((candidate.type === 'sendResult' && candidate.apsId === apsId)
          || (candidate.type === 'sendAcknowledged' && candidate.id === apsId && candidate.status !== 0));
      });
      if (event.type === 'sendAcknowledged') {
        throw sendError('IMESSAGE_SEND_REJECTED', 'APS rejected the iMessage envelope.', ERROR_KINDS.TRANSPORT, {
          status: event.status,
        });
      }
      var outcome = tracker.accept(event.pushToken, event.status);
      if (outcome.kind === 'ignored' || outcome.kind === 'pending') continue;
      return outcome;
    }
  } finally {
    deadline.cancel();
  }
};

SendCoordinator.prototype._waitForSendAcknowledgement = async function (
  events,
  apsId,
  batch,
  batchCount,
  tracker
) {
  var timeout = sendError(
    'IMESSAGE_SEND_ACK_TIMEOUT',
    'Timed out waiting for the APS acknowledgement.',
    ERROR_KINDS.TIMEOUT,
    {
      timeoutMillis: this.sendAckTimeoutMillis,
      batch: batch,
      batchCount: batchCount,
    },
    true
  );
  var deadline = scheduleDeadline(this.effects.timer, this.sendAckTimeoutMillis, function () {
    events.fail(timeout);
  });
  var outcome = null;
  try {
    while (true) {
      var event = await events.next(function (candidate) {
        return candidate && ((candidate.type === 'sendAcknowledged' && candidate.id === apsId)
          || (candidate.type === 'sendResult' && candidate.apsId === apsId));
      });
      if (event.type === 'sendResult') {
        var sendOutcome = tracker.accept(event.pushToken, event.status);
        if (sendOutcome.kind !== 'ignored' && sendOutcome.kind !== 'pending') outcome = sendOutcome;
        continue;
      }
      if (event.status !== 0) {
        throw sendError('IMESSAGE_SEND_REJECTED', 'APS rejected the iMessage envelope.', ERROR_KINDS.TRANSPORT, {
          status: event.status,
          batch: batch,
          batchCount: batchCount,
        });
      }
      return outcome;
    }
  } finally {
    deadline.cancel();
  }
};

SendCoordinator.prototype.refresh = async function () {
  if (this.busy) throw sendError('SEND_IN_PROGRESS', 'An iMessage operation is already in progress.');
  this.busy = true;
  var runner = null;
  try {
    var restored = this._restore();
    var endpoints = await this._fetchIdsEndpoints();
    runner = new this.ApsClientRunner({ effects: this.effects, crypto: this.crypto, push: restored.push,
      topics: [apsMessages.hashTopic(this.crypto, MADRID_TOPIC)], onEvent: function () {} });
    var connectedPush = await runner.connect();
    if (!bytes.bytesEqual(connectedPush.token, restored.push.token)) restored = this._persistConnectedPush(restored, connectedPush);
    if (restored.registrationNeedsRefresh) await this._refreshRegistration(restored, endpoints);
    return { ready: true };
  } finally {
    if (runner) { try { runner.close(); } catch (_) {} }
    this.busy = false;
  }
};

SendCoordinator.prototype.send = async function (request) {
  if (this.busy) throw sendError('SEND_IN_PROGRESS', 'An iMessage send is already in progress.');
  request = requireDictionary(request, 'Send request');
  var recipient = request.recipient;
  var text = request.text;
  recipient = normalizedHandle(recipient, 'Recipient');
  if (typeof text !== 'string' || text.length === 0) throw sendError('INVALID_MESSAGE', 'Message text must be non-empty.');
  this.busy = true;
  var runner = null;
  var events = new EventChannel();
  try {
    var restored = this._restore();
    if (recipient === restored.sender) {
      throw sendError('NO_NON_SELF_TARGET', 'The send-only client requires a recipient other than its sender handle.');
    }
    var idsEndpoints = await this._fetchIdsEndpoints();
    var topicHash = apsMessages.hashTopic(this.crypto, MADRID_TOPIC);
    runner = new this.ApsClientRunner({
      effects: this.effects,
      crypto: this.crypto,
      push: restored.push,
      topics: [topicHash],
      onEvent: function (event) { events.push(event); },
    });
    var connectedPush = await runner.connect();
    if (!bytes.bytesEqual(connectedPush.token, restored.push.token)) {
      restored = this._persistConnectedPush(restored, connectedPush);
    }
    if (restored.registrationNeedsRefresh) {
      restored = await this._refreshRegistration(restored, idsEndpoints);
    }

    var participants = uniqueParticipants(recipient, restored.sender);
    var delivery = await this._lookupDelivery(
      events, runner, restored, connectedPush, idsEndpoints, topicHash, participants
    );
    if (!delivery.some(function (target) { return target.participant !== restored.sender; })) {
      throw sendError('NO_VALID_TARGETS', 'IDS returned no recipient devices.', ERROR_KINDS.INVALID_INPUT);
    }

    var messageId = plainText.formatUuid(this.effects.random.bytes(16), true);
    var conversationId = plainText.formatUuid(this.effects.random.bytes(16), false);
    var message = plainText.buildPlainTextMessage({
      recipient: recipient,
      sender: restored.sender,
      text: text,
      messageId: messageId,
      conversationId: conversationId,
    });
    var originalSendAtMs = Math.floor(this.effects.clock.now());
    var retryCount = 0;
    var recipientSucceededEver = false;
    var tracker = null;
    while (true) {
      tracker = null;
      var envelopeSequenceComplete = false;
      try {
        var encryptedTargets = this._encryptTargets(delivery, restored, message.body);
        tracker = new sendRetry.SendResultTracker(restored.sender, encryptedTargets);
        var sendId = nextApsId(this.effects.random.bytes(4));
        var envelopeOptions = {
          sender: restored.sender,
          targets: encryptedTargets,
          apsId: sendId,
          uuid: message.uuid,
          userAgent: restored.idsConfig.userAgent,
        };
        if (retryCount > 0) {
          envelopeOptions.retryCount = retryCount;
          envelopeOptions.originalEpochNanos = sendRetry.originalEpochNanos(originalSendAtMs);
        }
        var envelopes = sendEnvelope.buildSendEnvelopes(envelopeOptions);
        var earlyOutcome = null;
        for (var batchIndex = 0; batchIndex < envelopes.length; batchIndex += 1) {
          var sendOptions = {
            id: sendId,
            topicHash: topicHash,
            uuid: message.uuid,
            envelope: envelopes[batchIndex],
          };
          if (batchIndex === 0) {
            sendOptions.expectedPushTokens = tracker.expectedPushTokens();
            runner.sendEnvelope(sendOptions);
          } else {
            runner.sendEnvelopeContinuation(sendOptions);
          }
          var acknowledgementOutcome = await this._waitForSendAcknowledgement(
            events,
            sendId,
            batchIndex + 1,
            envelopes.length,
            tracker
          );
          if (acknowledgementOutcome) earlyOutcome = acknowledgementOutcome;
        }
        runner.completeEnvelopeSequence({ id: sendId, uuid: message.uuid });
        envelopeSequenceComplete = true;
        var outcome = earlyOutcome || await this._waitForRecipientSuccess(events, sendId, tracker);
        recipientSucceededEver = recipientSucceededEver || outcome.recipientSucceeded;
        if (outcome.kind === 'success' || (outcome.kind === 'failure' && recipientSucceededEver)) {
          return Object.freeze({ messageId: message.id, recipient: recipient });
        }
        if (outcome.kind === 'failure') {
          throw sendError('NO_SUCCESSFUL_TARGET', 'No recipient device accepted the iMessage.', ERROR_KINDS.TRANSPORT, {
            statuses: outcome.statuses,
          });
        }

        var nextRetry = sendRetry.nextRetryCount(retryCount);
        if (nextRetry === null) {
          if (recipientSucceededEver) {
            return Object.freeze({ messageId: message.id, recipient: recipient });
          }
          throw sendError(
            'IMESSAGE_SEND_RETRY_EXHAUSTED',
            'Recipient device keys remained stale after bounded retries.',
            ERROR_KINDS.TRANSPORT,
            { retryCount: retryCount, statuses: outcome.statuses },
            true
          );
        }
        var refreshParticipants = sendRetry.refreshParticipants(outcome.targets);
        var refreshed = await this._lookupDelivery(
          events, runner, restored, connectedPush, idsEndpoints, topicHash, refreshParticipants
        );
        delivery = sendRetry.selectRefreshedTargets(refreshed, outcome.targets);
        if (delivery.length === 0) {
          if (recipientSucceededEver) {
            return Object.freeze({ messageId: message.id, recipient: recipient });
          }
          throw sendError(
            'NO_VALID_TARGETS',
            'IDS returned no refreshed recipient devices.',
            ERROR_KINDS.TRANSPORT
          );
        }
        retryCount = nextRetry;
      } catch (retryError) {
        if (envelopeSequenceComplete && tracker && tracker.recipientSucceeded) {
          recipientSucceededEver = true;
        }
        if (recipientSucceededEver) {
          return Object.freeze({ messageId: message.id, recipient: recipient });
        }
        throw retryError;
      }
    }
  } catch (error) {
    throw errors.asRuntimeError(error, 'IMESSAGE_SEND_FAILED', 'iMessage send failed.', {
      kind: ERROR_KINDS.INTERNAL,
    });
  } finally {
    if (runner) {
      try { runner.close(); } catch (_) { /* preserve the send outcome */ }
    }
    events.fail(sendError('IMESSAGE_SEND_FINISHED', 'The iMessage send operation finished.', ERROR_KINDS.CANCELLED));
    this.busy = false;
    text = null;
  }
};

module.exports = {
  MADRID_TOPIC: MADRID_TOPIC,
  SendCoordinator: SendCoordinator,
  decodeKtDeviceKey: decodeKtDeviceKey,
  normalizeDeliveryIdentities: normalizeDeliveryIdentities,
  registrationHeartbeatElapsed: registrationHeartbeatElapsed,
  restoreMadridRegistration: restoreMadridRegistration,
};
