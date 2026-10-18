'use strict';

var asn1 = require('../codecs/asn1');
var gzipCodec = require('../codecs/gzip');
var plist = require('../codecs/xml-plist');
var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var appleTrust = require('../apple/server-trust');
var signing = require('./request-signing');
var identityLogic = require('./identities');

var HANDLES_BAG_KEY = 'id-get-handles';
var REGISTER_BAG_KEY = 'id-register';
var MADRID_SERVICE = 'com.apple.madrid';
var MADRID_SUB_SERVICES = Object.freeze([
  'com.apple.private.alloy.sms',
  'com.apple.private.alloy.gelato',
  'com.apple.private.alloy.biz',
  'com.apple.private.alloy.gamecenter.imessage',
]);
var MADRID_CLIENT_DATA = Object.freeze({
  'is-c2k-equipment': true,
  'optionally-receive-typing-indicators': true,
  'show-peer-errors': true,
  'supports-ack-v1': true,
  'supports-activity-sharing-v1': true,
  'supports-audio-messaging-v2': true,
  'supports-autoloopvideo-v1': true,
  'supports-be-v1': true,
  'supports-ca-v1': true,
  'supports-fsm-v1': true,
  'supports-fsm-v2': true,
  'supports-fsm-v3': true,
  'supports-ii-v1': true,
  'supports-impact-v1': true,
  'supports-inline-attachments': true,
  'supports-keep-receipts': true,
  'supports-location-sharing': true,
  'supports-media-v2': true,
  'supports-photos-extension-v1': true,
  'supports-st-v1': true,
  'supports-update-attachments-v1': true,
  'supports-people-request-messages': true,
  'supports-people-request-messages-v2': true,
  'supports-people-request-messages-v3': true,
  'supports-rem': true,
  'nicknames-version': plist.real(1),
  'ec-version': plist.real(1),
  'supports-cross-platform-sharing': true,
  'supports-original-timestamp-v1': true,
  'supports-sa-v1': true,
  'supports-photos-extension-v2': true,
  'prefers-sdr': false,
  'supports-shared-exp': true,
  'supports-protobuf-payload-data-v2': true,
  'supports-hdr': true,
  'supports-heif': true,
  'supports-dq-nr': true,
  'supports-family-invite-message-bubble': true,
  'supports-live-delivery': true,
  'supports-findmy-plugin-messages': true,
  'supports-stick-moji-backs': true,
  'supports-emoji-tapbacks': true,
  'supports-send-later-messages': true,
  'supports-certified-delivery-v1': true,
  'supports-transcript-backgrounds': true,
  'supports-gti': true,
  'supports-polls': true,
});
var CERTIFICATE_REFRESH_MARGIN_MILLIS = 5 * 60 * 1000;

function registrationError(code, message, kind, details) {
  return new RuntimeError(code, message, { kind: kind || ERROR_KINDS.INVALID_INPUT, details: details });
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16384 || /[\u0000\r\n]/.test(value)) {
    throw registrationError('IDS_PROTOCOL_ERROR', name + ' is malformed.');
  }
  return value;
}

function requireDictionary(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw registrationError('IDS_PROTOCOL_ERROR', name + ' is malformed.');
  }
  return value;
}

function normalizedHandle(value) {
  return typeof value === 'string' && (/^mailto:[^\s@]+@[^\s@]+$/.test(value) || /^tel:\+[1-9][0-9]{1,14}$/.test(value));
}

function immutableRequest(method, url, headers, body) {
  return Object.freeze({
    method: method,
    url: requireString(url, 'IDS endpoint'),
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header.slice()); })),
    body: body,
    trustAnchors: Object.freeze(appleTrust.appleServerTrustAnchors()),
  });
}

function authUser(user) {
  user = requireDictionary(user, 'IDS authenticated user');
  requireString(user.userId, 'IDS user ID');
  requireString(user.keyId, 'IDS authentication key ID');
  bytes.assertBytes(user.certificate, 'IDS authentication certificate');
  if (!Number.isSafeInteger(user.protocolVersion) || user.protocolVersion < 1) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS protocol version is malformed.');
  }
  return user;
}

function appendSignature(headers, options) {
  var signed = signing.signRequest(options);
  signed.headers.forEach(function (header) { headers.push(header.slice()); });
}

function buildHandlesRequest(options) {
  if (!options || typeof options !== 'object') throw registrationError('IDS_PROTOCOL_ERROR', 'Handle request options are missing.');
  var user = authUser(options.user);
  bytes.assertBytes(options.pushToken, 'push token');
  var body = new Uint8Array(0);
  var headers = [
    ['x-push-token', bytes.bytesToBase64(options.pushToken)],
    ['x-protocol-version', String(user.protocolVersion)],
    ['x-auth-user-id', user.userId],
  ];
  appendSignature(headers, {
    crypto: options.crypto, keyId: user.keyId, certificate: user.certificate,
    keyType: 'auth', bagKey: HANDLES_BAG_KEY, body: body, pushToken: options.pushToken,
    nowMs: options.nowMs, randomBytes: options.authNonce,
  });
  appendSignature(headers, {
    crypto: options.crypto, keyId: options.pushKeyId, certificate: options.pushCertificate,
    keyType: 'push', bagKey: HANDLES_BAG_KEY, body: body, pushToken: options.pushToken,
    nowMs: options.nowMs, randomBytes: options.pushNonce,
  });
  var request = immutableRequest('GET', options.endpoint, headers, body);
  return Object.freeze(Object.assign({ bagKey: HANDLES_BAG_KEY }, request));
}

function parseHandlesResponse(body) {
  bytes.assertBytes(body, 'IDS handles response');
  var response;
  try { response = requireDictionary(plist.decodeXmlPlist(body, { maxInputBytes: 4 * 1024 * 1024 }), 'IDS handles response'); }
  catch (error) {
    if (error instanceof RuntimeError && error.code === 'IDS_PROTOCOL_ERROR') throw error;
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS handles response is not a valid property list.');
  }
  if (!Number.isSafeInteger(response.status)) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS handles status is malformed.');
  if (response.status !== 0 || !Array.isArray(response.handles)) {
    throw registrationError('IDS_AUTHENTICATION_FAILED', 'IDS did not return account handles.', ERROR_KINDS.INVALID_INPUT, {
      serverCode: response.status,
    });
  }
  var seen = Object.create(null);
  return Object.freeze(response.handles.map(function (record) {
    record = requireDictionary(record, 'IDS handle');
    var uri = requireString(record.uri, 'IDS handle URI');
    if (!normalizedHandle(uri) || seen[uri]) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS handle URI is invalid or duplicated.');
    seen[uri] = true;
    var aliases = record.aliases === undefined ? {} : requireDictionary(record.aliases, 'IDS handle aliases');
    return Object.freeze({ uri: uri, aliases: Object.freeze(Object.assign({}, aliases)) });
  }));
}

function madridService() {
  return Object.freeze({
    name: MADRID_SERVICE,
    subServices: MADRID_SUB_SERVICES,
    clientData: MADRID_CLIENT_DATA,
    flags: 17,
    capabilitiesName: 'Messenger',
  });
}

/**
 * Fingerprint the static service metadata that RustPush stores as IDSRegistration.data_hash.
 * The exact digest representation is private durable metadata; semantic parity is what matters:
 * any client-data or sub-service change forces one registration refresh after an app update.
 */
function serviceDataHash(crypto, service) {
  if (!crypto || typeof crypto.digest !== 'function') {
    throw new TypeError('IDS service metadata digest capability is required.');
  }
  service = service || madridService();
  if (!service || typeof service !== 'object' || Array.isArray(service)
      || !service.clientData || typeof service.clientData !== 'object'
      || !Array.isArray(service.subServices)) {
    throw new TypeError('IDS service metadata is malformed.');
  }
  var manifest = Object.freeze({
    clientData: service.clientData,
    subServices: service.subServices,
  });
  var digest = crypto.digest('sha256', plist.encodeXmlPlist(manifest));
  bytes.assertBytes(digest, 'IDS service metadata digest');
  if (digest.length !== 32) throw new TypeError('IDS service metadata digest is malformed.');
  return bytes.bytesToHex(digest);
}

function madridServiceDataHash(crypto) {
  return serviceDataHash(crypto, madridService());
}

/** Match RustPush registration scheduling: metadata changes refresh immediately; next-hbi wins
 * when present; otherwise refresh five minutes before the registration certificate expires. */
function registrationNeedsRefresh(record, expectedDataHash, nowMs) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('IDS registration freshness state is malformed.');
  }
  if (typeof expectedDataHash !== 'string' || !/^[0-9a-f]{64}$/.test(expectedDataHash)) {
    throw new TypeError('IDS service metadata hash is malformed.');
  }
  if (record.serviceDataHash !== expectedDataHash) return true;
  if (!Number.isFinite(nowMs)) throw new TypeError('IDS registration clock is malformed.');

  if (record.heartbeatIntervalSeconds !== null) {
    if (!Number.isSafeInteger(record.registeredAtSeconds) || record.registeredAtSeconds < 0
        || !Number.isSafeInteger(record.heartbeatIntervalSeconds)
        || record.heartbeatIntervalSeconds < 0) {
      throw new TypeError('IDS registration heartbeat state is malformed.');
    }
    var nowSeconds = Math.floor(nowMs / 1000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds < record.registeredAtSeconds) return false;
    return nowSeconds - record.registeredAtSeconds >= record.heartbeatIntervalSeconds;
  }

  bytes.assertBytes(record.certificate, 'IDS registration certificate');
  var parsed;
  try { parsed = asn1.parseCertificate(record.certificate); }
  catch (_) { throw new TypeError('IDS registration certificate is not valid DER.'); }
  return nowMs >= parsed.notAfter.epochMilliseconds - CERTIFICATE_REFRESH_MARGIN_MILLIS;
}

function buildRegistrationBody(options) {
  if (!options || typeof options !== 'object') throw registrationError('IDS_PROTOCOL_ERROR', 'Registration body options are missing.');
  if (!Array.isArray(options.users) || options.users.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'Registration users are missing.');
  var identity = options.identity;
  if (!identity || !(identity.publicIdentity instanceof Uint8Array)) throw registrationError('IDS_PROTOCOL_ERROR', 'Registration identity is missing.');
  bytes.assertBytes(options.prekeyData, 'NGM prekey data');
  bytes.assertBytes(options.validationData, 'IDS validation data');
  var service = options.service || madridService();
  var clientData = {
    'public-message-identity-key': identity.publicIdentity,
    'public-message-identity-version': 2,
    'ec-version': 1,
    'public-message-identity-ngm-version': 13,
    'public-message-ngm-device-prekey-data-key': options.prekeyData,
    'kt-version': 5,
  };
  Object.keys(service.clientData || {}).forEach(function (key) { clientData[key] = service.clientData[key]; });
  var ktData = identityLogic.buildKtLoggableData(identity);
  var users = options.users.map(function (entry) {
    var user = authUser(entry.user);
    if (!Array.isArray(entry.handles) || entry.handles.length === 0) {
      throw registrationError('IDS_PROTOCOL_ERROR', 'Registration handles are missing.');
    }
    return {
      'client-data': clientData,
      'kt-loggable-data': ktData,
      uris: entry.handles.map(function (handle) {
        var uri = typeof handle === 'string' ? handle : handle.uri;
        if (!normalizedHandle(uri)) throw registrationError('IDS_PROTOCOL_ERROR', 'Registration handle is malformed.');
        return { uri: uri };
      }),
      'user-id': user.userId,
    };
  });
  var metadata = requireDictionary(options.metadata, 'Registration device metadata');
  return {
    'device-name': requireString(metadata.deviceName, 'Registration device name'),
    'hardware-version': requireString(metadata.hardwareVersion, 'Registration hardware version'),
    language: 'en-US',
    'os-version': requireString(metadata.osVersion, 'Registration OS version'),
    'private-device-data': requireDictionary(metadata.privateDeviceData, 'Registration private device data'),
    services: [{
      capabilities: [{ flags: service.flags, name: service.capabilitiesName, version: 1 }],
      service: service.name,
      'sub-services': service.subServices,
      users: users,
    }],
    'software-version': requireString(metadata.softwareVersion, 'Registration software version'),
    'validation-data': options.validationData,
  };
}

function buildRegistrationRequest(options) {
  if (!options || typeof options !== 'object') throw registrationError('IDS_PROTOCOL_ERROR', 'Registration request options are missing.');
  if (!Array.isArray(options.users) || options.users.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'Registration users are missing.');
  bytes.assertBytes(options.pushToken, 'push token');
  bytes.assertBytes(options.pushCertificate, 'push certificate');
  var encodedBody = plist.encodeXmlPlist(options.value);
  var body = gzipCodec.gzip(encodedBody);
  var protocolVersion = authUser(options.users[0]).protocolVersion;
  var headers = [
    ['x-push-token', bytes.bytesToBase64(options.pushToken)],
    ['x-protocol-version', String(protocolVersion)],
    ['user-agent', 'com.apple.invitation-registration ' + requireString(options.userAgent, 'IDS user agent')],
    ['content-type', 'application/x-apple-plist'],
    ['content-encoding', 'gzip'],
    ['accept-encoding', 'gzip'],
  ];
  appendSignature(headers, {
    crypto: options.crypto, keyId: options.pushKeyId, certificate: options.pushCertificate,
    keyType: 'push', bagKey: REGISTER_BAG_KEY, body: body, pushToken: options.pushToken,
    nowMs: options.nowMs, randomBytes: options.nonces[0],
  });
  options.users.forEach(function (user, index) {
    user = authUser(user);
    headers.push(['x-auth-user-id-' + index, user.userId]);
    appendSignature(headers, {
      crypto: options.crypto, keyId: user.keyId, certificate: user.certificate,
      keyType: 'auth', index: index, bagKey: REGISTER_BAG_KEY, body: body,
      pushToken: options.pushToken, nowMs: options.nowMs, randomBytes: options.nonces[index + 1],
    });
  });
  var request = immutableRequest('POST', options.endpoint, headers, body);
  return Object.freeze(Object.assign({ bagKey: REGISTER_BAG_KEY, plistBody: encodedBody }, request));
}

function serverStatus(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw registrationError('IDS_PROTOCOL_ERROR', name + ' is malformed.');
  if (value !== 0) throw registrationError('IDS_REGISTRATION_FAILED', 'IDS registration was rejected.', ERROR_KINDS.INVALID_INPUT, {
    serverCode: value,
  });
}

function parseRegistrationResponse(body, users, registeredAtSeconds, pushToken, dataHash) {
  bytes.assertBytes(body, 'IDS registration response');
  if (!Array.isArray(users) || users.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'Registered users are missing.');
  var response;
  try { response = requireDictionary(plist.decodeXmlPlist(body, { maxInputBytes: 8 * 1024 * 1024 }), 'IDS registration response'); }
  catch (error) {
    if (error instanceof RuntimeError && error.code === 'IDS_PROTOCOL_ERROR') throw error;
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration response is not a valid property list.');
  }
  serverStatus(response.status, 'IDS registration status');
  if (!Array.isArray(response.services)) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration services are malformed.');
  var userById = Object.create(null);
  users.forEach(function (user) { user = authUser(user); userById[user.userId] = user; });
  var records = [];
  response.services.forEach(function (serviceRecord) {
    serviceRecord = requireDictionary(serviceRecord, 'IDS registration service');
    var serviceName = requireString(serviceRecord.service, 'IDS registration service name');
    if (!Array.isArray(serviceRecord.users)) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration service users are malformed.');
    serviceRecord.users.forEach(function (record) {
      record = requireDictionary(record, 'IDS registered user');
      serverStatus(record.status, 'IDS registered user status');
      var userId = requireString(record['user-id'], 'IDS registered user ID');
      var user = userById[userId];
      if (!user) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration returned an unknown user.');
      if (!(record.cert instanceof Uint8Array) || record.cert.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration certificate is malformed.');
      try { asn1.parseCertificate(record.cert); } catch (_) { throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration certificate is not valid DER.'); }
      if (!Array.isArray(record.uris) || record.uris.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registered handles are malformed.');
      var handles = record.uris.map(function (uriRecord) {
        uriRecord = requireDictionary(uriRecord, 'IDS registered handle');
        serverStatus(uriRecord.status, 'IDS registered handle status');
        var uri = requireString(uriRecord.uri, 'IDS registered handle URI');
        if (!normalizedHandle(uri)) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registered handle URI is malformed.');
        return uri;
      });
      if (record['next-hbi'] !== undefined && (!Number.isSafeInteger(record['next-hbi']) || record['next-hbi'] < 0)) {
        throw registrationError('IDS_PROTOCOL_ERROR', 'IDS heartbeat interval is malformed.');
      }
      records.push(Object.freeze({
        service: serviceName,
        userId: userId,
        keyId: user.keyId,
        certificate: new Uint8Array(record.cert),
        handles: Object.freeze(handles),
        registeredAtSeconds: registeredAtSeconds,
        heartbeatIntervalSeconds: record['next-hbi'] === undefined ? null : record['next-hbi'],
      }));
    });
  });
  if (records.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration response contains no registrations.');
  var serializedRecords = Object.freeze(records.map(function (record) {
    return Object.freeze({
      service: record.service, userId: record.userId, keyId: record.keyId,
      certificate: bytes.bytesToBase64(record.certificate), handles: Object.freeze(record.handles.slice()),
      registeredAtSeconds: record.registeredAtSeconds,
      heartbeatIntervalSeconds: record.heartbeatIntervalSeconds,
    });
  }));
  var artifact;
  if (pushToken === undefined) {
    // Compatibility for callers parsing captured version-one responses without connection state.
    artifact = Object.freeze({ version: 1, registrations: serializedRecords });
  } else {
    bytes.assertBytes(pushToken, 'push token');
    if (pushToken.length !== 32) throw registrationError('IDS_PROTOCOL_ERROR', 'Push token is malformed.');
    if (dataHash === undefined) {
      // Compatibility for callers parsing older captured responses without the request metadata.
      artifact = Object.freeze({
        version: 2,
        pushToken: bytes.bytesToBase64(pushToken),
        registrations: serializedRecords,
      });
    } else {
      if (typeof dataHash !== 'string' || !/^[0-9a-f]{64}$/.test(dataHash)) {
        throw registrationError('IDS_PROTOCOL_ERROR', 'IDS service metadata hash is malformed.');
      }
      artifact = Object.freeze({
        version: 3,
        pushToken: bytes.bytesToBase64(pushToken),
        serviceDataHash: dataHash,
        registrations: serializedRecords,
      });
    }
  }
  // Only successful Madrid registrations are valid iMessage send-from identities. Other
  // services may return URI records in the same response, but RustPush deliberately excludes
  // those from its public handle catalog.
  var allHandles = [];
  records.forEach(function (record) {
    if (record.service !== MADRID_SERVICE) return;
    record.handles.forEach(function (handle) { if (allHandles.indexOf(handle) === -1) allHandles.push(handle); });
  });
  if (allHandles.length === 0) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration returned no Madrid send-from addresses.');
  }
  return Object.freeze({ records: Object.freeze(records), handles: Object.freeze(allHandles), artifact: artifact });
}

/** Recover the authoritative send-from catalog from a durable registration artifact. */
function registeredMadridHandles(artifact) {
  artifact = requireDictionary(artifact, 'Persisted IDS registration');
  if (artifact.version !== 1 && artifact.version !== 2 && artifact.version !== 3) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'Persisted IDS registration version is unsupported.');
  }
  if (!Array.isArray(artifact.registrations)
      || artifact.registrations.length === 0 || artifact.registrations.length > 32) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'Persisted IDS registrations are malformed.');
  }
  var handles = [];
  artifact.registrations.forEach(function (value) {
    value = requireDictionary(value, 'Persisted IDS registration record');
    var service = requireString(value.service, 'Persisted IDS registration service');
    if (service !== MADRID_SERVICE) return;
    if (!Array.isArray(value.handles) || value.handles.length === 0 || value.handles.length > 32) {
      throw registrationError('IDS_PROTOCOL_ERROR', 'Persisted Madrid handles are malformed.');
    }
    value.handles.forEach(function (handle) {
      if (!normalizedHandle(handle)) {
        throw registrationError('IDS_PROTOCOL_ERROR', 'Persisted Madrid handle is malformed.');
      }
      if (handles.indexOf(handle) === -1) handles.push(handle);
    });
  });
  if (handles.length === 0) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'Persisted IDS registration has no Madrid send-from addresses.');
  }
  return Object.freeze(handles);
}

function validateHttpResponse(response, operation) {
  if (!response || typeof response !== 'object' || !Number.isSafeInteger(response.status)
      || !(response.body instanceof Uint8Array)) {
    throw registrationError('IDS_NETWORK_ERROR', operation + ' transport returned a malformed response.', ERROR_KINDS.TRANSPORT);
  }
  if (response.status < 200 || response.status >= 300) {
    throw registrationError('IDS_NETWORK_ERROR', operation + ' request failed.', ERROR_KINDS.TRANSPORT, { httpStatus: response.status });
  }
  return response;
}

/** Fetch handles, build the public identity profile, and register it using only injected effects. */
async function registerIdentity(options) {
  if (!options || !options.effects || !options.effects.http || typeof options.effects.http.request !== 'function'
      || !options.effects.clock || typeof options.effects.clock.now !== 'function'
      || !options.effects.random || typeof options.effects.random.bytes !== 'function') {
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration effects are missing.');
  }
  if (!Array.isArray(options.users) || options.users.length === 0) throw registrationError('IDS_PROTOCOL_ERROR', 'IDS registration users are missing.');
  if (options.validationDataProvider !== undefined
      && typeof options.validationDataProvider !== 'function') {
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS validation-data provider is invalid.');
  }
  if (options.validationDataProvider !== undefined && options.validationData !== undefined) {
    throw registrationError('IDS_PROTOCOL_ERROR', 'IDS validation data is ambiguous.');
  }
  var nowMs = options.effects.clock.now();
  var handleEntries = [];
  for (var index = 0; index < options.users.length; index += 1) {
    var user = authUser(options.users[index]);
    var handlesRequest = buildHandlesRequest({
      crypto: options.crypto, endpoint: options.handlesEndpoint, user: user,
      pushKeyId: options.pushKeyId, pushCertificate: options.pushCertificate,
      pushToken: options.pushToken, nowMs: nowMs,
      authNonce: options.effects.random.bytes(8), pushNonce: options.effects.random.bytes(8),
    });
    var handleResponse = validateHttpResponse(await options.effects.http.request(handlesRequest), 'IDS handles');
    handleEntries.push({ user: user, handles: parseHandlesResponse(handleResponse.body) });
  }
  var prekeyData = identityLogic.buildPrekeyData(options.crypto, options.identity, Math.floor(nowMs / 1000));
  var nonces = [];
  for (index = 0; index < options.users.length + 1; index += 1) nonces.push(options.effects.random.bytes(8));
  // A provider lets the coordinator delay expensive, one-use validation generation until every
  // prerequisite request and composition has completed. Direct bytes remain supported for the
  // pure request builder and low-level protocol tests.
  var requestValidationData = options.validationDataProvider === undefined
    ? options.validationData : await options.validationDataProvider();
  var service = options.service || madridService();
  var dataHash = serviceDataHash(options.crypto, service);
  var value = buildRegistrationBody({
    users: handleEntries,
    identity: options.identity,
    prekeyData: prekeyData,
    validationData: requestValidationData,
    metadata: options.metadata,
    service: service,
  });
  var request = buildRegistrationRequest({
    crypto: options.crypto, endpoint: options.registrationEndpoint, value: value,
    users: options.users, pushKeyId: options.pushKeyId, pushCertificate: options.pushCertificate,
    pushToken: options.pushToken, userAgent: options.userAgent, nowMs: nowMs, nonces: nonces,
  });
  var response = validateHttpResponse(await options.effects.http.request(request), 'IDS registration');
  return parseRegistrationResponse(
    response.body,
    options.users,
    Math.floor(nowMs / 1000),
    options.pushToken,
    dataHash
  );
}

module.exports = {
  HANDLES_BAG_KEY: HANDLES_BAG_KEY,
  MADRID_CLIENT_DATA: MADRID_CLIENT_DATA,
  MADRID_SERVICE: MADRID_SERVICE,
  MADRID_SUB_SERVICES: MADRID_SUB_SERVICES,
  CERTIFICATE_REFRESH_MARGIN_MILLIS: CERTIFICATE_REFRESH_MARGIN_MILLIS,
  REGISTER_BAG_KEY: REGISTER_BAG_KEY,
  buildHandlesRequest: buildHandlesRequest,
  buildRegistrationBody: buildRegistrationBody,
  buildRegistrationRequest: buildRegistrationRequest,
  madridService: madridService,
  madridServiceDataHash: madridServiceDataHash,
  parseHandlesResponse: parseHandlesResponse,
  parseRegistrationResponse: parseRegistrationResponse,
  registerIdentity: registerIdentity,
  registeredMadridHandles: registeredMadridHandles,
  registrationNeedsRefresh: registrationNeedsRefresh,
  serviceDataHash: serviceDataHash,
};
