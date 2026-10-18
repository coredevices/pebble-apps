'use strict';

var bytes = require('../runtime/bytes');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var appleTrust = require('../apple/server-trust');

var TRUSTED_DEVICE_CODE_ENDPOINT = 'https://gsa.apple.com/auth/verify/trusteddevice';
var TRUSTED_DEVICE_VERIFY_ENDPOINT = 'https://gsa.apple.com/grandslam/GsService2/validate';
var SMS_CODE_ENDPOINT = 'https://gsa.apple.com/auth/verify/phone';
var SMS_VERIFY_ENDPOINT = 'https://gsa.apple.com/auth/verify/phone/securitycode';
var PET_SERVICE = 'com.apple.gs.idms.pet';
var DEFAULT_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
var DEFAULT_PET_LIFETIME_SECONDS = 300;
var EPOCH_HEURISTIC_MILLISECONDS = 40 * 365 * 24 * 60 * 60 * 1000;
var EXTRA_BASE_HEADER_NAMES = Object.freeze([
  'x-apple-i-md-lu',
  'x-apple-i-md-rinfo',
  'x-apple-i-md-m',
  'x-apple-i-md',
  'x-mme-device-id',
]);
var CFU_STATE = bytes.bytesToBase64(bytes.utf8ToBytes(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n<array/>\n</plist>\n'
));

function protocolError(message) {
  return new RuntimeError('APPLE_ACCOUNT_PROTOCOL_ERROR', message, {
    kind: ERROR_KINDS.INVALID_INPUT,
  });
}

function requireString(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (maximum || 4096)
      || /[\u0000\r\n]/.test(value)) {
    throw protocolError(name + ' is malformed.');
  }
  return value;
}

function requireHeaderList(headers, name) {
  if (!Array.isArray(headers) || headers.length > 1024) {
    throw protocolError((name || 'Header list') + ' is malformed.');
  }
  return headers.map(function (header) {
    if (!Array.isArray(header) || header.length !== 2
        || typeof header[0] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
        || typeof header[1] !== 'string' || header[1].length > 65536 || /[\r\n]/.test(header[1])) {
      throw protocolError((name || 'Header list') + ' contains a malformed entry.');
    }
    return [header[0], header[1]];
  });
}

function hardwareHeaders(clientInfo) {
  return requireHeaderList(clientInfo.hardwareHeaders || [], 'Hardware headers');
}

function buildIdentityToken(spd) {
  if (!spd || typeof spd !== 'object' || Array.isArray(spd)) {
    throw protocolError('Account service data is missing.');
  }
  var adsid = requireString(spd.adsid, 'Account identifier');
  var token = requireString(spd.GsIdmsToken, 'Account identity token', 16384);
  return bytes.bytesToBase64(bytes.utf8ToBytes(adsid + ':' + token));
}

function requireClientInfo(clientInfo) {
  if (!clientInfo || typeof clientInfo !== 'object' || Array.isArray(clientInfo)) {
    throw protocolError('Account client metadata is missing.');
  }
  requireString(clientInfo.clientAppName, 'Client application name');
  requireString(clientInfo.clientBundleId, 'Client bundle identifier');
  requireString(clientInfo.mmeClientInfo, 'Client information');
  requireString(clientInfo.browserUserAgent, 'Browser user agent');
  requireString(clientInfo.akContextType, 'Authentication context');
  hardwareHeaders(clientInfo);
  return clientInfo;
}

function buildExtraHeaders(baseHeaders, clientInfo, sms, spd) {
  clientInfo = requireClientInfo(clientInfo);
  var filtered = requireHeaderList(baseHeaders, 'Anisette headers').filter(function (header) {
    return EXTRA_BASE_HEADER_NAMES.indexOf(header[0].toLowerCase()) !== -1;
  });
  var headers = filtered.concat([
    ['X-Apple-Client-App-Name', clientInfo.clientAppName],
    ['X-Apple-I-Client-Bundle-Id', clientInfo.clientBundleId],
    ['X-MMe-Client-Info', clientInfo.mmeClientInfo],
    ['X-Apple-I-CDP-Circle-Status', 'false'],
    ['X-Apple-I-ICSCREC', 'true'],
    ['User-Agent', clientInfo.browserUserAgent],
    ['Sec-Fetch-Site', 'same-origin'],
    ['X-Apple-Requested-Partition', '0'],
    ['X-Apple-I-DeviceUserMode', '0'],
    ['X-Apple-I-Locale', 'en_US'],
    ['X-Apple-Security-Upgrade-Context', 'com.apple.authkit.generic'],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['X-Apple-I-PRK-Gen', 'true'],
    ['Sec-Fetch-Mode', 'cors'],
    ['X-Apple-I-TimeZone', 'UTC'],
    ['X-Apple-I-OT-Status', 'false'],
    ['X-Apple-I-TimeZone-Offset', '0'],
    ['X-MMe-Country', 'US'],
    ['X-Apple-I-CDP-Status', 'false'],
    ['X-Apple-I-Device-Configuration-Mode', '0'],
    ['Sec-Fetch-Dest', 'empty'],
    ['X-Apple-AK-Context-Type', clientInfo.akContextType],
    ['X-Apple-I-CFU-State', CFU_STATE],
  ]).concat(hardwareHeaders(clientInfo));
  if (!sms) {
    headers.push(['Content-Type', 'text/x-xml-plist']);
    headers.push(['Accept', 'text/x-xml-plist']);
  }
  headers.push(['X-Apple-Identity-Token', buildIdentityToken(spd)]);
  return headers;
}

function requirePhoneId(phoneId) {
  if (!Number.isSafeInteger(phoneId) || phoneId < 1 || phoneId > 0xffffffff) {
    throw protocolError('Trusted phone identifier is invalid.');
  }
  return phoneId;
}

function requireCode(code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    throw new RuntimeError('INVALID_TWO_FACTOR_CODE', 'Enter the six-digit verification code.', {
      kind: ERROR_KINDS.INVALID_INPUT,
    });
  }
  return code;
}

function request(method, url, headers, body) {
  return Object.freeze({
    method: method,
    url: url,
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header.slice()); })),
    body: body || new Uint8Array(0),
    trustAnchors: Object.freeze(appleTrust.appleServerTrustAnchors()),
  });
}

function buildTrustedDeviceCodeRequest(options) {
  return request('GET', TRUSTED_DEVICE_CODE_ENDPOINT,
    buildExtraHeaders(options.baseHeaders, options.clientInfo, false, options.spd));
}

function buildTrustedDeviceVerifyRequest(options) {
  var headers = buildExtraHeaders(options.baseHeaders, options.clientInfo, false, options.spd);
  headers.push(['security-code', requireCode(options.code)]);
  return request('GET', TRUSTED_DEVICE_VERIFY_ENDPOINT, headers);
}

function smsBody(phoneId, code) {
  var body = {
    phoneNumber: { id: requirePhoneId(phoneId) },
    mode: 'sms',
  };
  if (code !== undefined) body.securityCode = { code: requireCode(code) };
  return body;
}

function buildSmsCodeRequest(options) {
  var headers = buildExtraHeaders(options.baseHeaders, options.clientInfo, true, options.spd);
  headers.push(['Accept', 'application/json']);
  headers.push(['Content-Type', 'application/json']);
  return request(
    'PUT',
    SMS_CODE_ENDPOINT,
    headers,
    bytes.utf8ToBytes(JSON.stringify(smsBody(options.phoneId, undefined)))
  );
}

function buildSmsVerifyRequest(options) {
  var headers = buildExtraHeaders(options.baseHeaders, options.clientInfo, true, options.spd);
  headers.push(['Accept', 'application/json']);
  headers.push(['Content-Type', 'application/json']);
  return request(
    'POST',
    SMS_VERIFY_ENDPOINT,
    headers,
    bytes.utf8ToBytes(JSON.stringify(smsBody(options.phoneId, options.code)))
  );
}

function tokenExpiration(parts, options, isPet) {
  var candidate = isPet
    ? parts[2]
    : options.sms && parts[3] !== undefined ? parts[3] : parts[2];
  var defaultSeconds = isPet ? DEFAULT_PET_LIFETIME_SECONDS : DEFAULT_TOKEN_LIFETIME_SECONDS;
  if (candidate === undefined) return options.nowMs + defaultSeconds * 1000;
  if (!/^(0|[1-9][0-9]*)$/.test(candidate)) throw protocolError('Account token expiration is malformed.');
  var numeric = Number(candidate);
  if (!Number.isSafeInteger(numeric)) throw protocolError('Account token expiration is out of range.');
  var expiration = numeric > EPOCH_HEURISTIC_MILLISECONDS ? numeric : options.nowMs + numeric * 1000;
  if (!Number.isSafeInteger(expiration) || expiration < 0) {
    throw protocolError('Account token expiration is out of range.');
  }
  return expiration;
}

function decodeTokenHeader(value, options, isPet, headerName) {
  var decoded;
  try {
    decoded = bytes.bytesToUtf8(bytes.base64ToBytes(value));
  } catch (error) {
    throw protocolError('Account token header is not valid base64 text.');
  }
  if (decoded.length > 32768) throw protocolError('Account token header is too large.');
  var parts = decoded.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]
      || /[\u0000-\u0020\u007f]/.test(parts[0]) || /[\u0000-\u0020\u007f]/.test(parts[1])) {
    throw protocolError('Account token header has an invalid format.');
  }
  return Object.freeze({
    headerName: headerName,
    service: isPet ? PET_SERVICE : parts[0],
    token: parts[1],
    expiresAtMs: tokenExpiration(parts, options, isPet),
  });
}

function parseTokenHeaders(headers, options) {
  options = options || {};
  if (typeof options.nowMs !== 'number' || !Number.isFinite(options.nowMs) || options.nowMs < 0) {
    throw protocolError('Token clock is invalid.');
  }
  var ordered = [];
  requireHeaderList(headers, 'Response headers').forEach(function (header) {
    var name = header[0].toLowerCase();
    if (name === 'x-apple-gs-token' || name === 'x-apple-hb-token' || name === 'x-apple-pe-token') {
      ordered.push(decodeTokenHeader(header[1], options, name === 'x-apple-pe-token', header[0]));
    }
  });
  var tokens = new Map();
  ordered.forEach(function (token) { tokens.set(token.service, token); });
  return Object.freeze({ ordered: Object.freeze(ordered), tokens: tokens });
}

module.exports = {
  PET_SERVICE: PET_SERVICE,
  SMS_CODE_ENDPOINT: SMS_CODE_ENDPOINT,
  SMS_VERIFY_ENDPOINT: SMS_VERIFY_ENDPOINT,
  TRUSTED_DEVICE_CODE_ENDPOINT: TRUSTED_DEVICE_CODE_ENDPOINT,
  TRUSTED_DEVICE_VERIFY_ENDPOINT: TRUSTED_DEVICE_VERIFY_ENDPOINT,
  buildExtraHeaders: buildExtraHeaders,
  buildIdentityToken: buildIdentityToken,
  buildSmsCodeRequest: buildSmsCodeRequest,
  buildSmsVerifyRequest: buildSmsVerifyRequest,
  buildTrustedDeviceCodeRequest: buildTrustedDeviceCodeRequest,
  buildTrustedDeviceVerifyRequest: buildTrustedDeviceVerifyRequest,
  parseTokenHeaders: parseTokenHeaders,
  requireCode: requireCode,
};
