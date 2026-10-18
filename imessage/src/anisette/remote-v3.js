'use strict';

var bytes = require('../runtime/bytes');
var xmlPlist = require('../codecs/xml-plist');
var binaryPlist = require('../codecs/binary-plist');
var appleTrust = require('../apple/server-trust');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;

var DEFAULT_REMOTE_URL = 'https://ani.sidestore.io';
var APPLE_LOOKUP_URL = 'https://gsa.apple.com/grandslam/GsService2/lookup';
var MAX_JSON_BYTES = 1024 * 1024;
var MAX_ADI_PB_BYTES = 1024 * 1024;

function protocolError(message, code) {
  return new RuntimeError(code || 'ANISETTE_PROTOCOL_ERROR', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function requireRecord(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw protocolError(name + ' is malformed.');
  }
  return value;
}

function requireString(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (maximum || 65536)
      || /[\u0000\r\n]/.test(value)) {
    throw protocolError(name + ' is malformed.');
  }
  return value;
}

function requireUrl(value, name, protocols) {
  requireString(value, name, 4096);
  var match = value.match(/^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^#]*)$/i);
  if (!match || protocols.indexOf(match[1].toLowerCase()) === -1 || !match[2]
      || /[\u0000-\u0020\u007f@\\]/.test(match[2])) {
    throw protocolError(name + ' is malformed.');
  }
  return value.replace(/\/$/, '');
}

function requireBytes(value, name, exactLength, maximumLength) {
  if (!(value instanceof Uint8Array)) throw protocolError(name + ' is malformed.');
  if (exactLength !== undefined && value.length !== exactLength) {
    throw protocolError(name + ' has the wrong length.');
  }
  if (maximumLength !== undefined && value.length > maximumLength) {
    throw protocolError(name + ' is too large.');
  }
  return new Uint8Array(value);
}

function createState(identifier, adiPb) {
  return Object.freeze({
    keychainIdentifier: requireBytes(identifier, 'Anisette identifier', 16),
    adiPb: adiPb == null ? null : requireBytes(adiPb, 'Anisette provisioning data', undefined, MAX_ADI_PB_BYTES),
  });
}

function copyState(state) {
  state = requireRecord(state, 'Anisette state');
  return createState(state.keychainIdentifier, state.adiPb);
}

function lowercaseHex(value) {
  var output = '';
  for (var index = 0; index < value.length; index += 1) {
    output += value[index].toString(16).padStart(2, '0');
  }
  return output;
}

function deviceUuid(identifier) {
  var hex = lowercaseHex(requireBytes(identifier, 'Anisette identifier', 16));
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-'
    + hex.slice(16, 20) + '-' + hex.slice(20);
}

function isoSeconds(nowMs) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs) || nowMs < 0) {
    throw protocolError('Anisette clock is invalid.');
  }
  return new Date(Math.round(nowMs / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function deriveStateMetadata(state, crypto) {
  state = copyState(state);
  if (!crypto || typeof crypto.digest !== 'function') {
    throw protocolError('Anisette digest capability is unavailable.');
  }
  var digest = crypto.digest('sha256', state.keychainIdentifier);
  return Object.freeze({
    identifierBase64: bytes.bytesToBase64(state.keychainIdentifier),
    localUserId: lowercaseHex(requireBytes(digest, 'Anisette local-user digest', 32)),
    deviceId: deviceUuid(state.keychainIdentifier),
  });
}

function requireClientInfo(value) {
  value = requireRecord(value, 'Anisette client metadata');
  var headers = value.hardwareHeaders || [];
  if (!Array.isArray(headers) || headers.length > 128) {
    throw protocolError('Anisette hardware headers are malformed.');
  }
  headers = headers.map(function (entry) {
    if (!Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(entry[0])
        || typeof entry[1] !== 'string' || entry[1].length > 16384 || /[\r\n]/.test(entry[1])) {
      throw protocolError('Anisette hardware headers contain a malformed entry.');
    }
    return Object.freeze([entry[0], entry[1]]);
  });
  return Object.freeze({
    akdUserAgent: requireString(value.akdUserAgent, 'Anisette user agent', 4096),
    mmeClientInfo: requireString(value.mmeClientInfo, 'Anisette client information', 4096),
    hardwareHeaders: Object.freeze(headers),
  });
}

function request(method, url, headers, body, trustAnchors) {
  return Object.freeze({
    method: method,
    url: url,
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header.slice()); })),
    body: body ? new Uint8Array(body) : new Uint8Array(0),
    trustAnchors: Object.freeze((trustAnchors || []).map(function (anchor) {
      return new Uint8Array(anchor);
    })),
  });
}

function buildAppleHeaders(options) {
  var clientInfo = requireClientInfo(options.clientInfo);
  var metadata = deriveStateMetadata(options.state, options.crypto);
  var headers = [
    ['User-Agent', clientInfo.akdUserAgent],
    ['X-Apple-Baa-E', '-10000'],
    ['X-Apple-I-MD-LU', metadata.localUserId],
    ['X-Mme-Device-Id', metadata.deviceId],
    ['X-Apple-Baa-Avail', '2'],
    ['X-Mme-Client-Info', clientInfo.mmeClientInfo],
    ['X-Apple-I-Client-Time', isoSeconds(options.nowMs)],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['X-Apple-Client-App-Name', 'akd'],
    ['Accept', '*/*'],
    ['Content-Type', 'application/x-www-form-urlencoded'],
    ['X-Apple-Baa-UE', 'AKAuthenticationError:-7066|com.apple.devicecheck.error.baa:-10000'],
    ['X-Apple-Host-Baa-E', '-7066'],
  ];
  return Object.freeze(headers.concat(clientInfo.hardwareHeaders).map(function (header) {
    return Object.freeze(header.slice());
  }));
}

function buildAppleLookupRequest(options) {
  return request('GET', APPLE_LOOKUP_URL, buildAppleHeaders(options), null,
    appleTrust.appleServerTrustAnchors());
}

function decodePlist(input) {
  input = requireBytes(input, 'Anisette property list', undefined, MAX_JSON_BYTES);
  if (input.length >= 8 && bytes.bytesToUtf8(input.slice(0, 8)) === 'bplist00') {
    return binaryPlist.decodeBinaryPlist(input);
  }
  return xmlPlist.decodeXmlPlist(input);
}

function parseLookupResponse(input) {
  var root = requireRecord(decodePlist(input), 'Anisette lookup response');
  var urls = requireRecord(root.urls, 'Anisette lookup URLs');
  return Object.freeze({
    startUrl: requireUrl(urls.midStartProvisioning, 'Anisette start-provisioning URL', ['https']),
    finishUrl: requireUrl(urls.midFinishProvisioning, 'Anisette finish-provisioning URL', ['https']),
  });
}

function provisioningBody(requestBody) {
  return xmlPlist.encodeXmlPlist({ Header: {}, Request: requestBody || {} });
}

function buildAppleProvisionRequest(kind, url, options, cpim) {
  if (kind !== 'start' && kind !== 'finish') throw protocolError('Unknown Anisette provisioning request.');
  var body = kind === 'finish'
    ? provisioningBody({ cpim: requireString(cpim, 'Anisette CPIM', MAX_JSON_BYTES) })
    : provisioningBody({});
  return request('POST', requireUrl(url, 'Anisette provisioning URL', ['https']),
    buildAppleHeaders(options), body, appleTrust.appleServerTrustAnchors());
}

function parseAppleProvisionResponse(kind, input) {
  if (kind !== 'start' && kind !== 'finish') throw protocolError('Unknown Anisette provisioning response.');
  var root = requireRecord(decodePlist(input), 'Anisette provisioning response');
  var response = requireRecord(root.Response, 'Anisette provisioning payload');
  if (kind === 'start') {
    return Object.freeze({ spim: requireString(response.spim, 'Anisette SPIM', MAX_JSON_BYTES) });
  }
  return Object.freeze({
    ptm: requireString(response.ptm, 'Anisette PTM', MAX_JSON_BYTES),
    tk: requireString(response.tk, 'Anisette TK', MAX_JSON_BYTES),
  });
}

function parseJsonObject(text, name) {
  if (typeof text !== 'string' || bytes.utf8ToBytes(text).length > MAX_JSON_BYTES) {
    throw protocolError(name + ' is malformed.');
  }
  var parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw protocolError(name + ' is not valid JSON.'); }
  return requireRecord(parsed, name);
}

function parseRemoteMessage(text) {
  var message = parseJsonObject(text, 'Anisette provisioning message');
  var result = requireString(message.result, 'Anisette provisioning result', 128);
  if (result === 'GiveIdentifier' || result === 'GiveStartProvisioningData') {
    return Object.freeze({ result: result });
  }
  if (result === 'GiveEndProvisioningData') {
    return Object.freeze({ result: result, cpim: requireString(message.cpim, 'Anisette CPIM', MAX_JSON_BYTES) });
  }
  if (result === 'ProvisioningSuccess') {
    var adiPb;
    try { adiPb = bytes.base64ToBytes(requireString(message.adi_pb, 'Anisette provisioning data', MAX_JSON_BYTES)); }
    catch (_) { throw protocolError('Anisette provisioning data is not valid base64.'); }
    return Object.freeze({ result: result, adiPb: requireBytes(adiPb, 'Anisette provisioning data', undefined, MAX_ADI_PB_BYTES) });
  }
  throw protocolError('Anisette provisioning server returned an unknown result.');
}

function websocketUrl(remoteUrl) {
  remoteUrl = requireUrl(remoteUrl || DEFAULT_REMOTE_URL, 'Anisette service URL', ['https']);
  return 'wss://' + remoteUrl.slice('https://'.length) + '/v3/provisioning_session';
}

function getHeadersUrl(remoteUrl) {
  return requireUrl(remoteUrl || DEFAULT_REMOTE_URL, 'Anisette service URL', ['https']) + '/v3/get_headers';
}

function buildGetHeadersRequest(remoteUrl, state) {
  state = copyState(state);
  if (state.adiPb === null) {
    throw protocolError('Anisette is not provisioned.', 'ANISETTE_NOT_PROVISIONED');
  }
  return request('POST', getHeadersUrl(remoteUrl), [
    ['Accept', 'application/json'],
    ['Content-Type', 'application/json'],
  ], bytes.utf8ToBytes(JSON.stringify({
    identifier: bytes.bytesToBase64(state.keychainIdentifier),
    adi_pb: bytes.bytesToBase64(state.adiPb),
  })));
}

function parseGetHeadersResponse(input, options) {
  var text;
  try { text = bytes.bytesToUtf8(requireBytes(input, 'Anisette headers response', undefined, MAX_JSON_BYTES)); }
  catch (_) { throw protocolError('Anisette headers response is malformed.'); }
  var response = parseJsonObject(text, 'Anisette headers response');
  if (response.result === 'GetHeadersError') {
    var message = typeof response.message === 'string' ? response.message : '';
    if (message.indexOf('-45061') !== -1) {
      throw protocolError('Anisette provisioning expired.', 'ANISETTE_NOT_PROVISIONED');
    }
    throw protocolError('Anisette header generation failed.');
  }
  if (response.result !== 'Headers') {
    throw protocolError('Anisette headers response has an unknown result.');
  }
  var metadata = deriveStateMetadata(options.state, options.crypto);
  var clientInfo = requireClientInfo(options.clientInfo);
  var machineId = requireString(response['X-Apple-I-MD-M'], 'Anisette machine identifier', 16384);
  var oneTimePassword = requireString(response['X-Apple-I-MD'], 'Anisette one-time password', 16384);
  var routingInfo = requireString(response['X-Apple-I-MD-RINFO'], 'Anisette routing information', 16384);
  return Object.freeze([
    Object.freeze(['X-Apple-I-Client-Time', isoSeconds(options.nowMs)]),
    Object.freeze(['X-Apple-I-TimeZone', 'UTC']),
    Object.freeze(['X-Apple-Locale', 'en_US']),
    Object.freeze(['X-Apple-I-MD-RINFO', routingInfo]),
    Object.freeze(['X-Apple-I-MD-LU', metadata.localUserId]),
    Object.freeze(['X-Mme-Device-Id', metadata.deviceId]),
    Object.freeze(['X-Apple-I-MD', oneTimePassword]),
    Object.freeze(['X-Apple-I-MD-M', machineId]),
    Object.freeze(['X-Mme-Client-Info', clientInfo.mmeClientInfo]),
  ]);
}

function RemoteV3ProvisioningSession(options) {
  options = requireRecord(options, 'Anisette session options');
  this.remoteUrl = requireUrl(options.remoteUrl || DEFAULT_REMOTE_URL, 'Anisette service URL', ['https']);
  this.state = copyState(options.state);
  this.clientInfo = requireClientInfo(options.clientInfo);
  this.crypto = options.crypto;
  this.nowMs = options.nowMs;
  this.endpoints = null;
  this.pendingApple = null;
  this.complete = false;
}

RemoteV3ProvisioningSession.prototype._appleOptions = function () {
  return { state: this.state, clientInfo: this.clientInfo, crypto: this.crypto, nowMs: this.nowMs };
};

RemoteV3ProvisioningSession.prototype.lookupRequest = function () {
  if (this.endpoints || this.complete) throw protocolError('Anisette provisioning lookup is out of sequence.');
  return buildAppleLookupRequest(this._appleOptions());
};

RemoteV3ProvisioningSession.prototype.acceptLookupResponse = function (body) {
  if (this.endpoints || this.complete) throw protocolError('Anisette provisioning lookup is out of sequence.');
  this.endpoints = parseLookupResponse(body);
  return Object.freeze({ type: 'websocket-connect', url: websocketUrl(this.remoteUrl) });
};

RemoteV3ProvisioningSession.prototype.acceptRemoteMessage = function (text) {
  if (!this.endpoints || this.pendingApple || this.complete) {
    throw protocolError('Anisette provisioning message is out of sequence.');
  }
  var message = parseRemoteMessage(text);
  if (message.result === 'GiveIdentifier') {
    return Object.freeze({
      type: 'websocket-send',
      text: JSON.stringify({ identifier: bytes.bytesToBase64(this.state.keychainIdentifier) }),
    });
  }
  if (message.result === 'GiveStartProvisioningData') {
    this.pendingApple = 'start';
    return Object.freeze({
      type: 'http',
      request: buildAppleProvisionRequest('start', this.endpoints.startUrl, this._appleOptions()),
    });
  }
  if (message.result === 'GiveEndProvisioningData') {
    this.pendingApple = 'finish';
    return Object.freeze({
      type: 'http',
      request: buildAppleProvisionRequest('finish', this.endpoints.finishUrl, this._appleOptions(), message.cpim),
    });
  }
  this.state = createState(this.state.keychainIdentifier, message.adiPb);
  this.complete = true;
  return Object.freeze({ type: 'complete', state: copyState(this.state), closeWebSocket: true });
};

RemoteV3ProvisioningSession.prototype.acceptAppleResponse = function (body) {
  if (!this.pendingApple || this.complete) {
    throw protocolError('Anisette Apple response is out of sequence.');
  }
  var kind = this.pendingApple;
  var value = parseAppleProvisionResponse(kind, body);
  this.pendingApple = null;
  return Object.freeze({ type: 'websocket-send', text: JSON.stringify(value) });
};

module.exports = {
  APPLE_LOOKUP_URL: APPLE_LOOKUP_URL,
  DEFAULT_REMOTE_URL: DEFAULT_REMOTE_URL,
  RemoteV3ProvisioningSession: RemoteV3ProvisioningSession,
  buildAppleHeaders: buildAppleHeaders,
  buildAppleLookupRequest: buildAppleLookupRequest,
  buildAppleProvisionRequest: buildAppleProvisionRequest,
  buildGetHeadersRequest: buildGetHeadersRequest,
  createState: createState,
  deriveStateMetadata: deriveStateMetadata,
  deviceUuid: deviceUuid,
  getHeadersUrl: getHeadersUrl,
  parseAppleProvisionResponse: parseAppleProvisionResponse,
  parseGetHeadersResponse: parseGetHeadersResponse,
  parseLookupResponse: parseLookupResponse,
  parseRemoteMessage: parseRemoteMessage,
  websocketUrl: websocketUrl,
};
