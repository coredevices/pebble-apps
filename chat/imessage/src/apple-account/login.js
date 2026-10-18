'use strict';

var bytes = require('../runtime/bytes');
var plist = require('../codecs/xml-plist');
var binaryPlist = require('../codecs/binary-plist');
var RuntimeError = require('../runtime/errors').RuntimeError;
var ERROR_KINDS = require('../runtime/errors').ERROR_KINDS;
var srp = require('./srp');
var twoFactor = require('./two-factor');
var delegates = require('./delegates');
var appleTrust = require('../apple/server-trust');

var GSA_ENDPOINT = 'https://gsa.apple.com/grandslam/GsService2';
var GSA_VERSION = '1.0.1';
var GS_HEADER_NAMES = Object.freeze({
  'x-apple-i-md-lu': 'X-Apple-I-MD-LU',
  'x-apple-i-md-rinfo': 'X-Apple-I-MD-RINFO',
  'x-apple-i-md-m': 'X-Apple-I-MD-M',
  'x-apple-i-md': 'X-Apple-I-MD',
  'x-mme-device-id': 'X-Mme-Device-Id',
});
var CPD_HEADER_NAMES = Object.freeze(Object.assign({}, GS_HEADER_NAMES, {
  'x-apple-i-client-time': 'X-Apple-I-Client-Time',
}));

function accountError(code, message, kind, details) {
  return new RuntimeError(code, message, {
    kind: kind || ERROR_KINDS.INVALID_INPUT,
    details: details,
  });
}

function protocolError(message, details) {
  return accountError('APPLE_ACCOUNT_PROTOCOL_ERROR', message, ERROR_KINDS.INVALID_INPUT, details);
}

function requireDictionary(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw protocolError(name + ' is malformed.');
  }
  return value;
}

function requireString(value, name, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > (maximum || 16384)
      || /[\u0000\r\n]/.test(value)) throw protocolError(name + ' is malformed.');
  return value;
}

function requireHeaderList(headers, name) {
  if (!Array.isArray(headers) || headers.length > 1024) throw protocolError(name + ' is malformed.');
  return headers.map(function (header) {
    if (!Array.isArray(header) || header.length !== 2
        || typeof header[0] !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(header[0])
        || typeof header[1] !== 'string' || header[1].length > 65536 || /[\r\n]/.test(header[1])) {
      throw protocolError(name + ' contains a malformed entry.');
    }
    return header.slice();
  });
}

function selectedHeaders(headers, names, name) {
  var selected = [];
  var seen = Object.create(null);
  requireHeaderList(headers, name).forEach(function (header) {
    var lowered = header[0].toLowerCase();
    var canonical = Object.prototype.hasOwnProperty.call(names, lowered) ? names[lowered] : null;
    if (!canonical) return;
    if (seen[canonical]) throw protocolError(name + ' contains a duplicate ' + canonical + ' value.');
    seen[canonical] = true;
    selected.push([canonical, header[1]]);
  });
  return selected;
}

function requireClientInfo(clientInfo) {
  clientInfo = requireDictionary(clientInfo, 'Account client metadata');
  requireString(clientInfo.akContextType, 'Authentication context');
  requireString(clientInfo.clientAppName, 'Client application name');
  requireString(clientInfo.clientBundleId, 'Client bundle identifier');
  requireString(clientInfo.mmeClientInfo, 'Client information');
  requireString(clientInfo.mmeClientInfoAkd, 'AuthKit client information');
  requireString(clientInfo.akdUserAgent, 'AuthKit user agent');
  requireString(clientInfo.browserUserAgent, 'Browser user agent');
  requireHeaderList(clientInfo.hardwareHeaders || [], 'Hardware headers');
  if (clientInfo.pushToken !== undefined && clientInfo.pushToken !== null) {
    requireString(clientInfo.pushToken, 'Push token');
  }
  return clientInfo;
}

function copyClientInfo(clientInfo) {
  clientInfo = requireClientInfo(clientInfo);
  return Object.freeze({
    akContextType: clientInfo.akContextType,
    clientAppName: clientInfo.clientAppName,
    clientBundleId: clientInfo.clientBundleId,
    mmeClientInfo: clientInfo.mmeClientInfo,
    mmeClientInfoAkd: clientInfo.mmeClientInfoAkd,
    akdUserAgent: clientInfo.akdUserAgent,
    browserUserAgent: clientInfo.browserUserAgent,
    hardwareHeaders: Object.freeze(requireHeaderList(clientInfo.hardwareHeaders || [], 'Hardware headers').map(function (header) {
      return Object.freeze(header);
    })),
    pushToken: clientInfo.pushToken === undefined ? null : clientInfo.pushToken,
  });
}

function buildCpd(baseHeaders, clientInfo, requestId) {
  clientInfo = requireClientInfo(clientInfo);
  requestId = requireString(requestId, 'Request identifier');
  var cpd = Object.create(null);
  selectedHeaders(baseHeaders, CPD_HEADER_NAMES, 'Anisette headers').forEach(function (header) {
    cpd[header[0]] = header[1];
  });
  if (clientInfo.pushToken) cpd.ptkn = clientInfo.pushToken;
  cpd['X-Apple-I-Device-Configuration-Mode'] = '0';
  cpd['X-Apple-I-Request-UUID'] = requestId;
  cpd['X-Apple-Requested-Partition'] = '0';
  cpd['X-Apple-Security-Upgrade-Context'] = 'com.apple.authkit.generic';
  cpd.capp = clientInfo.clientAppName;
  cpd.cbid = clientInfo.clientBundleId;
  cpd.cou = 'US';
  cpd.loc = 'en_US';
  cpd.svct = clientInfo.akContextType;
  cpd['X-Apple-Offer-Security-Upgrade'] = true;
  cpd.at = 0;
  cpd.bootstrap = true;
  cpd.ckgen = true;
  cpd.fcd = true;
  cpd.icdrsDisabled = false;
  cpd.icscrec = true;
  cpd.pbe = false;
  cpd.prkgen = true;
  cpd.webAccessEnabled = false;
  requireHeaderList(clientInfo.hardwareHeaders || [], 'Hardware headers').forEach(function (header) {
    if (Object.prototype.hasOwnProperty.call(cpd, header[0])) {
      throw protocolError('Hardware headers collide with account request metadata.');
    }
    cpd[header[0]] = header[1];
  });
  return cpd;
}

function buildGsaHeaders(baseHeaders, clientInfo) {
  clientInfo = requireClientInfo(clientInfo);
  return [
    ['Content-Type', 'text/x-xml-plist'],
    ['Accept', '*/*'],
  ].concat(selectedHeaders(baseHeaders, GS_HEADER_NAMES, 'Anisette headers'), [
    ['X-Apple-AK-Context-Type', clientInfo.akContextType],
    ['X-Apple-Client-App-Name', clientInfo.clientAppName],
    ['X-Apple-I-Client-Bundle-Id', clientInfo.clientBundleId],
    ['X-MMe-Client-Info', clientInfo.mmeClientInfoAkd],
    ['Accept-Language', 'en-US,en;q=0.9'],
    ['User-Agent', clientInfo.akdUserAgent],
  ]);
}

function httpRequest(method, url, headers, body) {
  return Object.freeze({
    method: method,
    url: url,
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header.slice()); })),
    body: body,
    trustAnchors: Object.freeze(appleTrust.appleServerTrustAnchors()),
  });
}

function httpsCookieTarget(url) {
  var match = typeof url === 'string'
    ? /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(\/[^?#]*)?(?:[?#].*)?$/.exec(url)
    : null;
  if (!match || match[1].startsWith('.') || match[1].endsWith('.') || match[1].indexOf('..') !== -1) {
    throw protocolError('Account cookie URL is malformed.');
  }
  return Object.freeze({ host: match[1].toLowerCase(), path: match[2] || '/' });
}

function cookieDomainMatches(host, domain, hostOnly) {
  return host === domain || !hostOnly && host.endsWith('.' + domain);
}

function cookiePathMatches(path, cookiePath) {
  return path === cookiePath || path.startsWith(cookiePath)
    && (cookiePath.endsWith('/') || path[cookiePath.length] === '/');
}

function defaultCookiePath(path) {
  if (!path.startsWith('/') || path === '/') return '/';
  var lastSlash = path.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
}

function cookieKey(name, domain, path) { return domain + '\n' + path + '\n' + name; }

function withSessionCookies(request, cookies) {
  var headers = requireHeaderList(request.headers || [], 'HTTP request headers');
  var target = httpsCookieTarget(request.url);
  var matching = Array.from(cookies.values()).filter(function (cookie) {
    return cookieDomainMatches(target.host, cookie.domain, cookie.hostOnly)
      && cookiePathMatches(target.path, cookie.path);
  }).sort(function (left, right) { return right.path.length - left.path.length; });
  if (matching.length > 0 && !headers.some(function (header) {
    return header[0].toLowerCase() === 'cookie';
  })) {
    headers.push(['Cookie', matching.map(function (cookie) {
      return cookie.name + '=' + cookie.value;
    }).join('; ')]);
  }
  return Object.freeze(Object.assign({}, request, {
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header); })),
  }));
}

function rememberSessionCookies(cookies, requestUrl, headers, nowMs) {
  var target = httpsCookieTarget(requestUrl);
  requireHeaderList(headers || [], 'HTTP response headers').forEach(function (header) {
    if (header[0].toLowerCase() !== 'set-cookie') return;
    var parts = header[1].split(';');
    var pair = parts.shift();
    var separator = pair.indexOf('=');
    var name = separator < 1 ? '' : pair.slice(0, separator).trim();
    var value = separator < 1 ? '' : pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u0000-\u0020\u007f;,]/.test(value)) {
      throw protocolError('Account session cookie is malformed.');
    }
    var domain = target.host;
    var hostOnly = true;
    var path = defaultCookiePath(target.path);
    var deleteCookie = false;
    for (var index = 0; index < parts.length; index += 1) {
      var attribute = parts[index].trim();
      var attributeSeparator = attribute.indexOf('=');
      var attributeName = (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase();
      var attributeValue = attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim();
      if (attributeName === 'domain') {
        var candidate = attributeValue.toLowerCase().replace(/^\.+/, '');
        if (!/^[a-z0-9.-]+$/.test(candidate) || candidate.endsWith('.')
            || candidate.indexOf('.') === -1 || candidate.indexOf('..') !== -1
            || !cookieDomainMatches(target.host, candidate, false)) return;
        // This bounded account-session jar never needs cross-host cookies. Scope accepted Domain
        // cookies to the issuing host so a public-suffix attribute cannot bridge Apple endpoints.
        domain = target.host;
        hostOnly = true;
      } else if (attributeName === 'path' && attributeValue.startsWith('/')) {
        path = attributeValue;
      } else if (attributeName === 'max-age' && /^-?[0-9]+$/.test(attributeValue)) {
        deleteCookie = Number(attributeValue) <= 0;
      } else if (attributeName === 'expires') {
        var expiration = Date.parse(attributeValue);
        if (Number.isFinite(expiration) && expiration <= nowMs) deleteCookie = true;
      }
    }
    var key = cookieKey(name, domain, path);
    if (deleteCookie) {
      cookies.delete(key);
      return;
    }
    if (cookies.size >= 128 && !cookies.has(key)) throw protocolError('Account session has too many cookies.');
    cookies.set(key, Object.freeze({
      name: name,
      value: value,
      domain: domain,
      path: path,
      hostOnly: hostOnly,
    }));
  });
}

function buildGsaInitRequest(options) {
  if (!options || typeof options !== 'object') throw protocolError('GSA init options are missing.');
  bytes.assertBytes(options.publicEphemeral, 'public ephemeral');
  if (options.publicEphemeral.length === 0 || options.publicEphemeral.length > 512) {
    throw protocolError('GSA public ephemeral is malformed.');
  }
  var packet = {
    Header: { Version: GSA_VERSION },
    Request: {
      A2k: options.publicEphemeral,
      cpd: buildCpd(options.baseHeaders, options.clientInfo, options.requestId),
      o: 'init',
      ps: ['s2k', 's2k_fo'],
      u: requireString(options.username, 'Account name'),
    },
  };
  return httpRequest('POST', GSA_ENDPOINT, buildGsaHeaders(options.baseHeaders, options.clientInfo), plist.encodeXmlPlist(packet));
}

function buildGsaCompleteRequest(options) {
  if (!options || typeof options !== 'object') throw protocolError('GSA completion options are missing.');
  bytes.assertBytes(options.proof, 'client proof');
  if (options.proof.length !== 32) throw protocolError('GSA client proof is malformed.');
  var packet = {
    Header: { Version: GSA_VERSION },
    Request: {
      M1: options.proof,
      cpd: buildCpd(options.baseHeaders, options.clientInfo, options.requestId),
      c: requireString(options.challenge, 'GSA challenge'),
      o: 'complete',
      u: requireString(options.username, 'Account name'),
    },
  };
  return httpRequest('POST', GSA_ENDPOINT, buildGsaHeaders(options.baseHeaders, options.clientInfo), plist.encodeXmlPlist(packet));
}

function plistFailureDiagnostic(name, isBinary, error) {
  var base = name === 'Account service data' ? 'spd-plist' : 'response-plist';
  var message = error && typeof error.message === 'string' ? error.message : '';
  if (!isBinary) {
    if (/UTF-8/i.test(message)) return base + '-xml-utf8';
    if (/declaration/i.test(message)) return base + '-xml-declaration';
    if (/DOCTYPE/i.test(message)) return base + '-xml-doctype';
    if (/plist root/i.test(message)) return base + '-xml-root';
    if (/integer/i.test(message)) return base + '-xml-integer';
    if (/real/i.test(message)) return base + '-xml-real';
    if (/data|base64/i.test(message)) return base + '-xml-data';
    if (/date/i.test(message)) return base + '-xml-date';
    if (/nested markup|string/i.test(message)) return base + '-xml-string';
    if (/duplicate key/i.test(message)) return base + '-xml-duplicate-key';
    if (/dictionary|key/i.test(message)) return base + '-xml-dictionary';
    if (/Unsupported or malformed plist value/i.test(message)) return base + '-xml-value';
    if (/after plist root/i.test(message)) return base + '-xml-trailing';
    if (/max|too many|exceeds/i.test(message)) return base + '-xml-limits';
    return base + '-xml-other';
  }
  var unsupportedType = /Unsupported binary plist object type 0x([0-9a-f]+)\./i.exec(message);
  if (unsupportedType) return base + '-binary-type-' + unsupportedType[1].toLowerCase();
  if (/simple object/i.test(message)) return base + '-binary-simple';
  if (/real object/i.test(message)) return base + '-binary-real';
  if (/UID object/i.test(message)) return base + '-binary-uid';
  if (/UTF-8/i.test(message)) return base + '-binary-utf8';
  if (/UTF-16/i.test(message)) return base + '-binary-utf16';
  if (/ASCII/i.test(message)) return base + '-binary-ascii';
  if (/dictionary/i.test(message)) return base + '-binary-dictionary';
  if (/integer/i.test(message)) return base + '-binary-integer';
  if (/reference|cycle|container/i.test(message)) return base + '-binary-references';
  if (/header|trailer|offset|object table|object count|bounds|overlap|length|too short/i.test(message)) {
    return base + '-binary-structure';
  }
  return base + '-binary-other';
}

function decodePlistResponse(body, name) {
  bytes.assertBytes(body, name);
  var binaryHeader = 'bplist00';
  var isBinary = body.length >= binaryHeader.length;
  for (var headerIndex = 0; isBinary && headerIndex < binaryHeader.length; headerIndex += 1) {
    isBinary = body[headerIndex] === binaryHeader.charCodeAt(headerIndex);
  }
  try {
    var decoded = isBinary
      ? binaryPlist.decodeBinaryPlist(body, { maxInputBytes: 4 * 1024 * 1024 })
      : plist.decodeXmlPlist(body, { maxInputBytes: 4 * 1024 * 1024 });
    return requireDictionary(decoded, name);
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'APPLE_ACCOUNT_PROTOCOL_ERROR') throw error;
    throw protocolError(name + ' is not a valid property list.', {
      diagnosticCode: plistFailureDiagnostic(name, isBinary, error),
    });
  }
}

function classifyServiceMessage(value) {
  if (typeof value !== 'string' || value.length === 0) return 'none';
  var normalized = value.toLowerCase();
  if (/password|credential|apple id|apple account/.test(normalized)) return 'credentials';
  if (/locked|disabled|inactive/.test(normalized)) return 'account-state';
  if (/verification|security code|two-factor/.test(normalized)) return 'verification';
  if (/try again|temporar|later|unavailable/.test(normalized)) return 'service';
  return 'other';
}

function checkServiceError(dictionary, diagnostics) {
  var status = dictionary.Status === undefined ? dictionary : requireDictionary(dictionary.Status, 'Account service status');
  if (!Number.isSafeInteger(status.ec)) throw protocolError('Account service status code is malformed.');
  if (status.ec !== 0) {
    var details = Object.assign({
      serverCode: status.ec,
      serverMessageKind: classifyServiceMessage(status.em),
    }, diagnostics || {});
    throw accountError('APPLE_AUTH_ERROR', 'Account authentication was rejected.', ERROR_KINDS.INVALID_INPUT, {
      serverCode: details.serverCode,
      serverMessageKind: details.serverMessageKind,
      stage: details.stage,
      protocol: details.protocol,
      serverPublicLength: details.serverPublicLength,
      serverPublicLeadingZero: details.serverPublicLeadingZero,
      cookieCount: details.cookieCount,
    });
  }
  return status;
}

function parseGsaEnvelope(body, name, diagnostics) {
  var root = decodePlistResponse(body, name);
  var response = requireDictionary(root.Response, name + ' payload');
  checkServiceError(response, diagnostics);
  return response;
}

function parseGsaInitResponse(body, diagnostics) {
  var response = parseGsaEnvelope(body, 'GSA init response', diagnostics);
  if (!(response.s instanceof Uint8Array) || !(response.B instanceof Uint8Array)
      || response.s.length === 0 || response.s.length > 1024
      || response.B.length === 0 || response.B.length > 512) {
    throw protocolError('GSA challenge bytes are malformed.');
  }
  if (!Number.isSafeInteger(response.i) || response.i < 1 || response.i > 10000000) {
    throw protocolError('GSA iteration count is malformed.');
  }
  var selectedProtocol = response.sp === undefined ? 's2k' : response.sp;
  if (selectedProtocol !== 's2k' && selectedProtocol !== 's2k_fo') {
    throw protocolError('GSA selected an unsupported password protocol.');
  }
  return Object.freeze({
    salt: new Uint8Array(response.s),
    serverPublic: new Uint8Array(response.B),
    iterations: response.i,
    challenge: requireString(response.c, 'GSA challenge'),
    protocol: selectedProtocol,
  });
}

function parseGsaCompleteResponse(body, diagnostics) {
  var response = parseGsaEnvelope(body, 'GSA completion response', diagnostics);
  if (!(response.M2 instanceof Uint8Array) || !(response.spd instanceof Uint8Array)
      || response.M2.length !== 32 || response.spd.length === 0
      || response.spd.length > 4 * 1024 * 1024) {
    throw protocolError('GSA completion bytes are malformed.', { diagnosticCode: 'completion-shape' });
  }
  var status = requireDictionary(response.Status, 'Account service status');
  if (status.au !== undefined) requireString(status.au, 'Account authentication state');
  return Object.freeze({
    serverProof: new Uint8Array(response.M2),
    encryptedSpd: new Uint8Array(response.spd),
    authenticationState: status.au === undefined ? null : status.au,
  });
}

function tokenExpiration(token, nowMs) {
  var expiration;
  if (token.expiry !== undefined) {
    if (!Number.isSafeInteger(token.expiry) || token.expiry < 0) throw protocolError('SPD token expiry is malformed.');
    expiration = token.expiry;
  } else {
    if (!Number.isSafeInteger(token.duration) || token.duration < 0) throw protocolError('SPD token duration is malformed.');
    expiration = nowMs + token.duration * 1000;
  }
  if (!Number.isSafeInteger(expiration)) throw protocolError('SPD token expiry is out of range.');
  return expiration;
}

function parseSpd(value, nowMs) {
  var spd = requireDictionary(value, 'Account service data');
  var normalized = {
    acname: requireString(spd.acname, 'Account name'),
    adsid: requireString(spd.adsid, 'Account identifier'),
    GsIdmsToken: requireString(spd.GsIdmsToken, 'Account identity token'),
  };
  var tokens = new Map();
  if (spd.t !== undefined) {
    var tokenDictionary = requireDictionary(spd.t, 'Account token collection');
    Object.keys(tokenDictionary).forEach(function (service) {
      var token = requireDictionary(tokenDictionary[service], 'Account token');
      tokens.set(requireString(service, 'Account token service'), Object.freeze({
        service: service,
        token: requireString(token.token, 'Account token'),
        expiresAtMs: tokenExpiration(token, nowMs),
      }));
    });
  }
  return Object.freeze({ spd: Object.freeze(normalized), tokens: tokens });
}

function validateHttpResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
      || !(value.body instanceof Uint8Array)) {
    throw protocolError('HTTP provider returned a malformed response.');
  }
  return Object.freeze({
    status: value.status,
    headers: Object.freeze(requireHeaderList(value.headers || [], 'HTTP response headers').map(function (header) {
      return Object.freeze(header);
    })),
    body: new Uint8Array(value.body),
  });
}

function assertSuccess(response, code, message) {
  if (response.status < 200 || response.status >= 300) {
    throw accountError(code || 'APPLE_NETWORK_ERROR', message || 'Account request failed.', ERROR_KINDS.TRANSPORT, {
      status: response.status,
    });
  }
  return response;
}

function normalizeFailure(error, unexpectedStage) {
  if (error instanceof RuntimeError) return error;
  var details;
  if (typeof unexpectedStage === 'string' && /^[a-z0-9-]{1,32}$/.test(unexpectedStage)) {
    var unexpectedName = error && typeof error.name === 'string' ? error.name.toLowerCase() : 'error';
    if (!/^(error|typeerror|rangeerror|syntaxerror|referenceerror)$/.test(unexpectedName)) {
      unexpectedName = 'error';
    }
    details = { diagnosticCode: ('unexpected-' + unexpectedStage + '-' + unexpectedName).slice(0, 48) };
  }
  return accountError('APPLE_AUTH_ERROR', 'Account authentication failed.', ERROR_KINDS.INTERNAL, details);
}

function failureTraceKind(error) {
  var code = error instanceof RuntimeError ? error.code : 'UNEXPECTED';
  var details = error instanceof RuntimeError && error.details && typeof error.details === 'object'
    ? error.details : null;
  var qualifier = '';
  if (details && Number.isSafeInteger(details.serverCode)) {
    qualifier = '.server-' + (details.serverCode < 0 ? 'neg' + (-details.serverCode) : details.serverCode);
  }
  else if (details && Number.isSafeInteger(details.status)) qualifier = '.http-' + details.status;
  if (details && (details.stage === 'init' || details.stage === 'complete')) {
    qualifier += '.stage-' + details.stage;
  }
  if (details && /^(none|credentials|account-state|verification|service|other)$/.test(details.serverMessageKind)) {
    qualifier += '.message-' + details.serverMessageKind;
  }
  if (details && (details.protocol === 's2k' || details.protocol === 's2k_fo')) {
    qualifier += '.protocol-' + details.protocol;
  }
  if (details && Number.isSafeInteger(details.serverPublicLength)
      && details.serverPublicLength >= 0 && details.serverPublicLength <= 512) {
    qualifier += '.b-' + details.serverPublicLength;
  }
  if (details && typeof details.serverPublicLeadingZero === 'boolean') {
    qualifier += '.leading-zero-' + (details.serverPublicLeadingZero ? 'yes' : 'no');
  }
  if (details && Number.isSafeInteger(details.cookieCount)
      && details.cookieCount >= 0 && details.cookieCount <= 128) {
    qualifier += '.cookies-' + details.cookieCount;
  }
  if (details && typeof details.diagnosticCode === 'string'
      && /^[a-z0-9-]{1,48}$/.test(details.diagnosticCode)) {
    qualifier += '.diagnostic-' + details.diagnosticCode;
  }
  if (!(error instanceof RuntimeError)) {
    var unexpectedName = error && typeof error.name === 'string' ? error.name.toLowerCase() : '';
    if (/^(error|typeerror|rangeerror|syntaxerror|referenceerror)$/.test(unexpectedName)) {
      qualifier += '.type-' + unexpectedName;
    }
  }
  return 'account.failure.' + code + qualifier;
}

function AccountLoginSession(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Account login options are required.');
  if (!options.effects || !options.effects.http || typeof options.effects.http.request !== 'function'
      || !options.effects.random || typeof options.effects.random.bytes !== 'function'
      || !options.effects.clock || typeof options.effects.clock.now !== 'function'
      || !options.effects.trace || typeof options.effects.trace.emit !== 'function') {
    throw new TypeError('Account login requires injected HTTP, random, clock, and trace effects.');
  }
  if (!options.crypto || typeof options.crypto.digest !== 'function') {
    throw new TypeError('Account login requires injected crypto compositions.');
  }
  if (!options.anisette || typeof options.anisette.getHeaders !== 'function') {
    throw new TypeError('Account login requires an injected Anisette effect.');
  }
  var validationDataGenerator = options.validationDataGenerator || null;
  if (validationDataGenerator !== null && typeof validationDataGenerator.generate !== 'function') {
    throw new TypeError('Account login Mac validation-data generator is invalid.');
  }
  var hardware = options.hardware || null;
  if (hardware !== null && (typeof hardware !== 'object' || Array.isArray(hardware))) {
    throw new TypeError('Account login Mac hardware metadata is invalid.');
  }
  var delegateConfig = requireDictionary(options.delegateConfig, 'Delegate client metadata');

  this.effects = options.effects;
  this.crypto = options.crypto;
  this.anisette = options.anisette;
  this.validationDataGenerator = validationDataGenerator;
  this.hardware = hardware;
  this.clientInfo = copyClientInfo(options.clientInfo);
  this.delegateConfig = Object.freeze({
    userAgent: requireString(delegateConfig.userAgent, 'Delegate user agent'),
    mmeClientInfo: requireString(delegateConfig.mmeClientInfo, 'Delegate client information'),
    timezone: requireString(delegateConfig.timezone || 'America/New_York', 'Delegate timezone'),
  });
  this.status = 'idle';
  this.verification = null;
  this.busy = false;
  this.username = null;
  this.passwordHash = null;
  this.spd = null;
  this.tokens = new Map();
  this.cookies = new Map();
  this.result = null;
  [
    'effects', 'crypto', 'anisette', 'validationDataGenerator', 'hardware',
    'clientInfo', 'delegateConfig',
    'username', 'passwordHash', 'spd', 'tokens', 'cookies', 'result',
  ].forEach(function (name) {
    Object.defineProperty(this, name, { enumerable: false });
  }, this);
}

AccountLoginSession.prototype._transition = function (next, failure) {
  var previous = this.status;
  this.status = next;
  this.effects.trace.emit(Object.freeze({
    kind: (failure === undefined ? 'account.state-transition' : failureTraceKind(failure)) + '.to-' + next,
    from: previous,
    to: next,
  }));
};

AccountLoginSession.prototype.snapshot = function () {
  return Object.freeze({
    status: this.status,
    verification: this.verification === null ? null : this.verification.mode,
    authenticated: this.status === 'authenticated',
  });
};

AccountLoginSession.prototype.toJSON = function () {
  return this.snapshot();
};

AccountLoginSession.prototype.getResult = function () {
  if (this.status !== 'authenticated' || !this.result) {
    throw accountError('AUTH_REQUIRED', 'Account login has not completed.', ERROR_KINDS.INVALID_INPUT);
  }
  return Object.freeze({
    ids: Object.freeze({
      authToken: this.result.ids.authToken,
      profileId: this.result.ids.profileId,
    }),
  });
};

AccountLoginSession.prototype._getAnisetteHeaders = async function () {
  var headers;
  try {
    headers = await this.anisette.getHeaders();
  } catch (error) {
    throw accountError('ANISSETTE_UNAVAILABLE', 'Could not obtain account authentication metadata.', ERROR_KINDS.TRANSPORT);
  }
  return requireHeaderList(headers, 'Anisette headers');
};

AccountLoginSession.prototype._request = async function (request) {
  var response;
  try {
    response = await this.effects.http.request(withSessionCookies(request, this.cookies));
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw accountError('APPLE_NETWORK_ERROR', 'Account network request failed.', ERROR_KINDS.TRANSPORT);
  }
  response = validateHttpResponse(response);
  rememberSessionCookies(this.cookies, request.url, response.headers, this.effects.clock.now());
  return response;
};

AccountLoginSession.prototype._pet = function () {
  var pet = this.tokens.get(twoFactor.PET_SERVICE);
  return pet && pet.expiresAtMs > this.effects.clock.now() ? pet.token : null;
};

AccountLoginSession.prototype._runSrp = async function () {
  var privateEphemeral = this.effects.random.bytes(32);
  var srpResult = null;
  var decryptedSpd = null;
  var srpStage = 'start';
  function stage(name) {
    srpStage = name;
  }
  try {
    stage('public-start');
    var publicEphemeral = srp.createPublicEphemeral(this.crypto, privateEphemeral);
    stage('public-complete');
    var baseHeaders = await this._getAnisetteHeaders();
    stage('anisette-complete');
    var requestId = delegates.uuidString(this.effects.random.bytes(16));
    var initRequest = buildGsaInitRequest({
      publicEphemeral: publicEphemeral,
      baseHeaders: baseHeaders,
      clientInfo: this.clientInfo,
      requestId: requestId,
      username: this.username,
    });
    stage('init-request-built');
    var initResponse = assertSuccess(
      await this._request(initRequest),
      'APPLE_AUTH_ERROR',
      'Account authentication request failed.'
    );
    stage('init-response-received');
    var challenge = parseGsaInitResponse(initResponse.body, {
      stage: 'init',
      cookieCount: this.cookies.size,
    });
    stage('init-response-parsed');
    srpResult = srp.completeChallenge(this.crypto, {
      username: this.username,
      passwordHash: this.passwordHash,
      protocol: challenge.protocol,
      salt: challenge.salt,
      iterations: challenge.iterations,
      privateEphemeral: privateEphemeral,
      serverPublic: challenge.serverPublic,
    });
    stage('challenge-complete');
    var completeRequest = buildGsaCompleteRequest({
      proof: srpResult.proof,
      challenge: challenge.challenge,
      baseHeaders: baseHeaders,
      clientInfo: this.clientInfo,
      requestId: requestId,
      username: this.username,
    });
    stage('complete-request-built');
    var completeResponse = assertSuccess(
      await this._request(completeRequest),
      'APPLE_AUTH_ERROR',
      'Account authentication request failed.'
    );
    stage('complete-response-received');
    var completion = parseGsaCompleteResponse(completeResponse.body, {
      stage: 'complete',
      protocol: challenge.protocol,
      serverPublicLength: challenge.serverPublic.length,
      serverPublicLeadingZero: challenge.serverPublic[0] === 0,
      cookieCount: this.cookies.size,
    });
    stage('complete-response-parsed');
    if (!srp.verifyServerProof(srpResult, completion.serverProof)) {
      throw protocolError('GSA server proof did not match the authenticated session.', {
        diagnosticCode: 'server-proof',
      });
    }
    try {
      decryptedSpd = srp.decryptExtraData(this.crypto, srpResult.sessionKey, completion.encryptedSpd);
    } catch (error) {
      throw protocolError('Encrypted account service data could not be decrypted.', {
        diagnosticCode: 'spd-decrypt',
      });
    }
    var decodedSpd = decodePlistResponse(decryptedSpd, 'Account service data');
    var parsedSpd;
    try {
      parsedSpd = parseSpd(decodedSpd, this.effects.clock.now());
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== 'APPLE_ACCOUNT_PROTOCOL_ERROR') throw error;
      throw protocolError('Account service data is missing required login fields.', {
        diagnosticCode: 'spd-content',
      });
    }
    this.spd = parsedSpd.spd;
    this.tokens = parsedSpd.tokens;

    if (completion.authenticationState === 'trustedDeviceSecondaryAuth') return 'trusted-device';
    if (completion.authenticationState === 'secondaryAuth') return 'sms';
    if (completion.authenticationState !== null) {
      if (this._pet()) return 'logged-in';
      throw accountError('APPLE_EXTRA_STEP_REQUIRED', 'The account requires an unsupported authentication step.', ERROR_KINDS.INVALID_INPUT);
    }
    return 'logged-in';
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    var unexpectedName = error && typeof error.name === 'string'
      ? error.name.toLowerCase() : 'error';
    if (!/^(error|typeerror|rangeerror|syntaxerror|referenceerror)$/.test(unexpectedName)) {
      unexpectedName = 'error';
    }
    throw accountError(
      'APPLE_AUTH_ERROR',
      'Account authentication failed.',
      ERROR_KINDS.INTERNAL,
      { diagnosticCode: ('unexpected-' + srpStage + '-' + unexpectedName).slice(0, 48) }
    );
  } finally {
    privateEphemeral.fill(0);
    if (decryptedSpd) decryptedSpd.fill(0);
    if (srpResult) {
      srpResult.proof.fill(0);
      srpResult.expectedServerProof.fill(0);
      srpResult.sessionKey.fill(0);
    }
  }
};

AccountLoginSession.prototype._requestTrustedDeviceCode = async function () {
  var request = twoFactor.buildTrustedDeviceCodeRequest({
    baseHeaders: await this._getAnisetteHeaders(),
    clientInfo: this.clientInfo,
    spd: this.spd,
  });
  assertSuccess(await this._request(request), 'APPLE_AUTH_ERROR', 'Could not request a trusted-device code.');
  this.verification = Object.freeze({ mode: 'trusted-device' });
  this._transition('needs-two-factor');
};

AccountLoginSession.prototype._requestSmsCode = async function (phoneId) {
  var request = twoFactor.buildSmsCodeRequest({
    baseHeaders: await this._getAnisetteHeaders(),
    clientInfo: this.clientInfo,
    spd: this.spd,
    phoneId: phoneId,
  });
  try {
    assertSuccess(await this._request(request), 'APPLE_AUTH_ERROR', 'Could not request an SMS code.');
  } finally {
    request.body.fill(0);
  }
  this.verification = Object.freeze({ mode: 'sms', phoneId: phoneId });
  this._transition('needs-two-factor');
};

AccountLoginSession.prototype._finishDelegate = async function () {
  var pet = this._pet();
  if (!pet) throw accountError('APPLE_AUTH_ERROR', 'Account login completed without a persistent authentication token.');
  if (!this.validationDataGenerator || this.hardware === null) {
    throw accountError(
      'MAC_VALIDATION_REQUIRED',
      'Fresh Mac validation data is required to finish account login.',
      ERROR_KINDS.INVALID_INPUT
    );
  }
  this._transition('fetching-delegate');
  var baseHeaders = await this._getAnisetteHeaders();
  var clientIdRandom = this.effects.random.bytes(16);
  var validationData = null;
  var request = null;
  try {
    // Generate only after every other delegate input is ready so the blob belongs to exactly one
    // immediately-following Apple request and cannot be retained as account-session state.
    validationData = await this.validationDataGenerator.generate(this.hardware);
    bytes.assertBytes(validationData, 'validation data');
    if (validationData.length === 0) throw protocolError('Validation data is missing.');
    request = delegates.buildDelegateRequest({
      username: this.username,
      pet: pet,
      adsid: this.spd.adsid,
      baseHeaders: baseHeaders,
      validationData: validationData,
      userAgent: this.delegateConfig.userAgent,
      mmeClientInfo: this.delegateConfig.mmeClientInfo,
      timezone: this.delegateConfig.timezone,
      clientIdRandom: clientIdRandom,
    });
    var response = assertSuccess(await this._request(request), 'DELEGATE_LOGIN_FAILED', 'Account delegate login failed.');
    var ids = delegates.parseDelegateResponse(response.body);
    this.result = Object.freeze({ ids: ids });
    this._clearTransient();
    this._transition('authenticated');
  } finally {
    if (validationData instanceof Uint8Array) validationData.fill(0);
    request = null;
  }
};

AccountLoginSession.prototype._handleSrpState = async function (srpState, afterVerification) {
  if (srpState === 'logged-in') {
    await this._finishDelegate();
  } else if (srpState === 'trusted-device' && !afterVerification) {
    await this._requestTrustedDeviceCode();
  } else if (srpState === 'sms' && !afterVerification) {
    await this._requestSmsCode(1);
  } else {
    throw accountError(
      afterVerification ? 'INVALID_TWO_FACTOR_CODE' : 'APPLE_AUTH_ERROR',
      afterVerification ? 'Account verification did not complete.' : 'Account login did not complete.',
      ERROR_KINDS.INVALID_INPUT
    );
  }
};

AccountLoginSession.prototype.start = async function (credentials) {
  if (this.busy || this.status !== 'idle') {
    throw accountError('AUTH_IN_PROGRESS', 'Account login has already started.', ERROR_KINDS.INVALID_INPUT);
  }
  credentials = requireDictionary(credentials, 'Account credentials');
  var username = requireString(credentials.username, 'Account name').trim();
  if (username.length === 0 || /[\u0000-\u0020\u007f:]/.test(username)) throw protocolError('Account name is malformed.');
  if (typeof credentials.password !== 'string' || credentials.password.length === 0 || credentials.password.length > 4096) {
    throw accountError('INVALID_CREDENTIALS', 'Account credentials are missing.', ERROR_KINDS.INVALID_INPUT);
  }
  this.busy = true;
  this.username = username;
  var operationStage = 'password';
  try {
    this.passwordHash = srp.derivePasswordHash(this.crypto, credentials.password);
    credentials = null;
    this._transition('signing-in');
    operationStage = 'srp';
    var srpState = await this._runSrp();
    operationStage = srpState === 'trusted-device' ? 'trusted-device'
      : srpState === 'sms' ? 'sms' : 'delegate';
    await this._handleSrpState(srpState, false);
    return this.snapshot();
  } catch (error) {
    var normalized = normalizeFailure(error, operationStage);
    this._clearTransient();
    this._transition('failed', normalized);
    throw normalized;
  } finally {
    this.busy = false;
  }
};

AccountLoginSession.prototype.submitTwoFactorCode = async function (code) {
  code = twoFactor.requireCode(code);
  if (this.busy || this.status !== 'needs-two-factor' || !this.verification) {
    throw accountError('AUTH_REQUIRED', 'Start account sign-in before entering a code.', ERROR_KINDS.INVALID_INPUT);
  }
  // Do not consume a one-time verification code when this login cannot yet generate the fresh
  // validation blob required at the delegate boundary.
  if (!this.validationDataGenerator || this.hardware === null) {
    throw accountError(
      'MAC_VALIDATION_REQUIRED',
      'Fresh Mac validation data is required to finish account login.',
      ERROR_KINDS.INVALID_INPUT
    );
  }
  this.busy = true;
  var verificationMode = this.verification;
  var verificationRequest = null;
  var verificationBody = null;
  try {
    var baseHeaders = await this._getAnisetteHeaders();
    if (verificationMode.mode === 'trusted-device') {
      verificationRequest = twoFactor.buildTrustedDeviceVerifyRequest({
        baseHeaders: baseHeaders,
        clientInfo: this.clientInfo,
        spd: this.spd,
        code: code,
      });
    } else {
      verificationRequest = twoFactor.buildSmsVerifyRequest({
        baseHeaders: baseHeaders,
        clientInfo: this.clientInfo,
        spd: this.spd,
        code: code,
        phoneId: verificationMode.phoneId,
      });
    }
    verificationBody = verificationRequest.body;
    code = null;
    var response = await this._request(verificationRequest);
    if (verificationMode.mode === 'sms') verificationBody.fill(0);
    verificationRequest = null;
    if (verificationMode.mode === 'sms') {
      if (response.status !== 200) {
        throw accountError('INVALID_TWO_FACTOR_CODE', 'The verification code was rejected.', ERROR_KINDS.INVALID_INPUT);
      }
    } else {
      if (response.status < 200 || response.status >= 300) {
        throw accountError('INVALID_TWO_FACTOR_CODE', 'The verification code was rejected.', ERROR_KINDS.INVALID_INPUT);
      }
      try {
        checkServiceError(decodePlistResponse(response.body, 'Trusted-device verification response'));
      } catch (error) {
        if (error instanceof RuntimeError && error.code === 'APPLE_AUTH_ERROR') {
          throw accountError('INVALID_TWO_FACTOR_CODE', 'The verification code was rejected.', ERROR_KINDS.INVALID_INPUT);
        }
        throw error;
      }
    }
    var parsedTokens = twoFactor.parseTokenHeaders(response.headers, {
      sms: verificationMode.mode === 'sms',
      nowMs: this.effects.clock.now(),
    });
    this.tokens = parsedTokens.tokens;
    this.verification = null;
    if (this._pet()) {
      await this._finishDelegate();
    } else {
      await this._handleSrpState(await this._runSrp(), true);
    }
    return this.snapshot();
  } catch (error) {
    var normalized = normalizeFailure(error);
    if (normalized.code === 'INVALID_TWO_FACTOR_CODE') {
      this.verification = verificationMode;
      throw normalized;
    }
    this._clearTransient();
    this._transition('failed', normalized);
    throw normalized;
  } finally {
    if (verificationBody) verificationBody.fill(0);
    this.busy = false;
  }
};

AccountLoginSession.prototype._clearTransient = function () {
  if (this.passwordHash) this.passwordHash.fill(0);
  this.passwordHash = null;
  this.username = null;
  this.spd = null;
  this.tokens.clear();
  this.tokens = new Map();
  this.cookies.clear();
  this.cookies = new Map();
  this.verification = null;
};

AccountLoginSession.prototype.dispose = function () {
  if (this.busy) throw accountError('AUTH_IN_PROGRESS', 'Account login is busy.', ERROR_KINDS.INVALID_INPUT);
  this._clearTransient();
  this.result = null;
  if (this.status !== 'disposed') this._transition('disposed');
};

module.exports = {
  AccountLoginSession: AccountLoginSession,
  GSA_ENDPOINT: GSA_ENDPOINT,
  GSA_VERSION: GSA_VERSION,
  buildCpd: buildCpd,
  buildGsaCompleteRequest: buildGsaCompleteRequest,
  buildGsaHeaders: buildGsaHeaders,
  buildGsaInitRequest: buildGsaInitRequest,
  checkServiceError: checkServiceError,
  parseGsaCompleteResponse: parseGsaCompleteResponse,
  parseGsaInitResponse: parseGsaInitResponse,
  parseSpd: parseSpd,
  rememberSessionCookies: rememberSessionCookies,
  withSessionCookies: withSessionCookies,
};
