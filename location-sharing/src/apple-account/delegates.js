'use strict';

var bytes = require('../../../imessage/src/runtime/bytes');
var plist = require('../../../imessage/src/codecs/xml-plist');
var binaryPlist = require('../../../imessage/src/codecs/binary-plist');
var gzipCodec = require('../../../imessage/src/codecs/gzip');
var RuntimeError = require('../../../imessage/src/runtime/errors').RuntimeError;
var ERROR_KINDS = require('../../../imessage/src/runtime/errors').ERROR_KINDS;

var DELEGATE_ENDPOINT = 'https://setup.icloud.com/setup/signin/v2/login';
var IDS_DELEGATE = 'com.apple.private.ids';
var MOBILEME_DELEGATE = 'com.apple.mobileme';

function delegateError(code, message, details) {
  return new RuntimeError(code, message, {
    kind: ERROR_KINDS.INVALID_INPUT,
    details: details,
  });
}

function requireString(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (maximum || 16384)
      || /[\u0000\r\n]/.test(value)) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', name + ' is malformed.');
  }
  return value;
}

function requireHeaders(headers) {
  if (!Array.isArray(headers) || headers.length > 1024) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Anisette headers are malformed.');
  }
  return headers.map(function (header) {
    if (!Array.isArray(header) || header.length !== 2
        || typeof header[0] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
        || typeof header[1] !== 'string' || header[1].length > 65536 || /[\r\n]/.test(header[1])) {
      throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Anisette header is malformed.');
    }
    return header.slice();
  });
}

function basicAuthorization(username, pet) {
  username = requireString(username, 'Account name').trim();
  pet = requireString(pet, 'Persistent authentication token');
  if (!username || /[\u0000-\u0020\u007f:]/.test(username) || /[\u0000-\u0020\u007f:]/.test(pet)) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Basic authentication input is malformed.');
  }
  return 'Basic ' + bytes.bytesToBase64(bytes.utf8ToBytes(username + ':' + pet));
}

function uuidString(value) {
  bytes.assertBytes(value, 'delegate client ID randomness');
  if (value.length !== 16) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Delegate client ID randomness is malformed.');
  }
  var uuid = new Uint8Array(value);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  var hex = bytes.bytesToHex(uuid).toUpperCase();
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

function buildDelegateRequest(options) {
  if (!options || typeof options !== 'object') {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Delegate request options are missing.');
  }
  bytes.assertBytes(options.validationData, 'validation data');
  if (options.validationData.length === 0 || options.validationData.length > 1024 * 1024) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Validation data is malformed.');
  }
  var timezone = requireString(options.timezone || 'America/New_York', 'Delegate timezone');
  var requestValue = {
    delegates: {},
    protocolVersion: '1.0',
    userInfo: {
      'client-id': uuidString(options.clientIdRandom),
      language: 'en-US',
      timezone: timezone,
    },
  };
  requestValue.delegates[IDS_DELEGATE] = { 'protocol-version': '4' };
  requestValue.delegates[MOBILEME_DELEGATE] = {};

  var headers = [
    ['Accept-Encoding', 'gzip'],
    ['User-Agent', requireString(options.userAgent, 'Delegate user agent')],
    ['X-Mme-Client-Info', requireString(options.mmeClientInfo, 'Delegate client information')],
    ['X-Mme-Nas-Qualify', bytes.bytesToBase64(options.validationData)],
    ['X-Apple-ADSID', requireString(options.adsid, 'Account identifier')],
  ].concat(requireHeaders(options.baseHeaders));
  headers.push(['Authorization', basicAuthorization(options.username, options.pet)]);
  if (options.cookie !== undefined) headers.push(['Cookie', requireString(options.cookie, 'Delegate cookie')]);
  var uniqueHeaders = new Map();
  headers.forEach(function (header) { uniqueHeaders.set(header[0].toLowerCase(), header); });
  headers = Array.from(uniqueHeaders.values());

  return Object.freeze({
    method: 'POST',
    url: DELEGATE_ENDPOINT,
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header); })),
    body: plist.encodeXmlPlist(requestValue),
    maxResponseBytes: 4 * 1024 * 1024,
    clientId: requestValue.userInfo['client-id'],
  });
}

function valueKind(value) {
  if (value === undefined) return 'missing';
  if (value instanceof Uint8Array) return 'bytes';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'object') return 'object';
  return 'other';
}

function requireDictionary(value, name, diagnosticCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', name + ' is malformed.', diagnosticCode ? {
      diagnosticCode: diagnosticCode + '-' + valueKind(value),
    } : undefined);
  }
  return value;
}

function wireKind(body) {
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) return 'gzip';
  if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return 'utf16le';
  if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return 'utf16be';
  var offset = body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (offset < body.length && (body[offset] === 0x09 || body[offset] === 0x0a
      || body[offset] === 0x0d || body[offset] === 0x20)) offset += 1;
  if (offset < body.length && body[offset] === 0x3c) return 'xml';
  if (offset < body.length && (body[offset] === 0x7b || body[offset] === 0x5b)) return 'json';
  return body.length === 0 ? 'empty' : 'binary';
}

function plistFailureDiagnostic(isBinary, error, body) {
  var message = error && typeof error.message === 'string' ? error.message : '';
  if (isBinary) {
    if (/unsupported binary plist object type/i.test(message)) return 'delegate-binary-type';
    if (/UTF-8/i.test(message)) return 'delegate-binary-utf8';
    if (/UTF-16/i.test(message)) return 'delegate-binary-utf16';
    if (/dictionary/i.test(message)) return 'delegate-binary-dictionary';
    if (/integer/i.test(message)) return 'delegate-binary-integer';
    if (/reference|cycle|container/i.test(message)) return 'delegate-binary-references';
    if (/header|trailer|offset|object table|object count|bounds|overlap|length|too short/i.test(message)) {
      return 'delegate-binary-structure';
    }
    return 'delegate-binary-other';
  }
  if (/UTF-8/i.test(message)) return 'delegate-wire-' + wireKind(body);
  if (/declaration/i.test(message)) return 'delegate-xml-declaration';
  if (/DOCTYPE/i.test(message)) return 'delegate-xml-doctype';
  if (/plist root/i.test(message)) return 'delegate-xml-root';
  if (/integer/i.test(message)) return 'delegate-xml-integer';
  if (/real/i.test(message)) return 'delegate-xml-real';
  if (/data|base64/i.test(message)) return 'delegate-xml-data';
  if (/date/i.test(message)) return 'delegate-xml-date';
  if (/nested markup|string/i.test(message)) return 'delegate-xml-string';
  if (/duplicate key/i.test(message)) return 'delegate-xml-duplicate-key';
  if (/dictionary|key/i.test(message)) return 'delegate-xml-dictionary';
  if (/Unsupported or malformed plist value/i.test(message)) return 'delegate-xml-value';
  if (/after plist root/i.test(message)) return 'delegate-xml-trailing';
  if (/max|too many|exceeds/i.test(message)) return 'delegate-xml-limits';
  return 'delegate-xml-other';
}

function parseDelegateResponse(body) {
  bytes.assertBytes(body, 'delegate response');
  if (wireKind(body) === 'gzip') {
    try {
      body = gzipCodec.ungzip(body, {
        maxInputBytes: 4 * 1024 * 1024,
        maxOutputBytes: 4 * 1024 * 1024,
      });
    } catch (_) {
      throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Delegate response gzip is malformed.', {
        diagnosticCode: 'delegate-gzip-invalid',
      });
    }
  }
  var root;
  var isBinary = body.length >= 8 && body[0] === 0x62 && body[1] === 0x70
    && body[2] === 0x6c && body[3] === 0x69 && body[4] === 0x73
    && body[5] === 0x74 && body[6] === 0x30 && body[7] === 0x30;
  try {
    root = requireDictionary(isBinary
      ? binaryPlist.decodeBinaryPlist(body, { maxInputBytes: 4 * 1024 * 1024 })
      : plist.decodeXmlPlist(body, { maxInputBytes: 4 * 1024 * 1024 }),
    'Delegate response', 'delegate-root');
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'APPLE_ACCOUNT_PROTOCOL_ERROR') throw error;
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Delegate response is not a valid property list.', {
      diagnosticCode: plistFailureDiagnostic(isBinary, error, body),
    });
  }
  if (root.localizedError !== undefined) {
    var reason = typeof root.localizedError === 'string' && root.localizedError === 'UNAUTHORIZED'
      ? 'unauthorized'
      : 'service-error';
    throw delegateError('DELEGATE_LOGIN_FAILED', 'Account delegate login was rejected.', { reason: reason });
  }
  if (!Number.isSafeInteger(root.status)) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'Delegate response status is malformed.', {
      diagnosticCode: 'delegate-status-' + valueKind(root.status),
    });
  }
  if (root.status !== 0) {
    throw delegateError('DELEGATE_LOGIN_FAILED', 'Account delegate login failed.', {
      status: root.status,
    });
  }
  var delegates = requireDictionary(root.delegates, 'Delegate response collection', 'delegate-collection');
  var ids = requireDictionary(delegates[IDS_DELEGATE], 'IDS delegate response', 'ids-delegate');
  if (!Number.isSafeInteger(ids.status)) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'IDS delegate status is malformed.', {
      diagnosticCode: 'ids-status-' + valueKind(ids.status),
    });
  }
  if (ids.status !== 0 || ids['service-data'] === undefined) {
    throw delegateError('DELEGATE_LOGIN_FAILED', 'IDS delegate login failed.', { status: ids.status });
  }
  var serviceData = requireDictionary(ids['service-data'], 'IDS delegate service data', 'ids-service-data');
  var mobileMe = requireDictionary(delegates[MOBILEME_DELEGATE], 'MobileMe delegate response', 'mobileme-delegate');
  if (!Number.isSafeInteger(mobileMe.status)) {
    throw delegateError('APPLE_ACCOUNT_PROTOCOL_ERROR', 'MobileMe delegate status is malformed.', {
      diagnosticCode: 'mobileme-status-' + valueKind(mobileMe.status),
    });
  }
  if (mobileMe.status !== 0 || mobileMe['service-data'] === undefined) {
    throw delegateError('DELEGATE_LOGIN_FAILED', 'MobileMe delegate login failed.', { status: mobileMe.status });
  }
  var mobileMeServiceData = requireDictionary(mobileMe['service-data'], 'MobileMe delegate service data', 'mobileme-service-data');
  var tokens = requireDictionary(mobileMeServiceData.tokens, 'MobileMe token collection', 'mobileme-tokens');
  return Object.freeze({
    ids: Object.freeze({
      authToken: requireString(serviceData['auth-token'], 'IDS authentication token'),
      profileId: requireString(serviceData['profile-id'], 'IDS profile identifier'),
    }),
    mobileMe: Object.freeze({
      fmfToken: requireString(tokens.mmeFMFAppToken, 'Find My Friends authentication token'),
    }),
  });
}

module.exports = {
  DELEGATE_ENDPOINT: DELEGATE_ENDPOINT,
  IDS_DELEGATE: IDS_DELEGATE,
  MOBILEME_DELEGATE: MOBILEME_DELEGATE,
  buildDelegateRequest: buildDelegateRequest,
  parseDelegateResponse: parseDelegateResponse,
  uuidString: uuidString,
};
