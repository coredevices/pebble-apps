'use strict';

var xmlPlist = require('../codecs/xml-plist');
var bplist = require('../codecs/binary-plist');
var gzipCodec = require('../codecs/gzip');
var bytes = require('../runtime/bytes');
var signing = require('./request-signing');

var LOOKUP_BAG_KEY = 'id-query';

function headersToDictionary(headers) {
  var dictionary = {};
  headers.forEach(function (header) {
    if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== 'string'
        || typeof header[1] !== 'string') throw new TypeError('Lookup header is malformed.');
    if (Object.prototype.hasOwnProperty.call(dictionary, header[0])) throw new TypeError('Lookup header is duplicated.');
    dictionary[header[0]] = header[1];
  });
  return dictionary;
}

function buildLookupTunnel(options) {
  if (!options || typeof options !== 'object') throw new TypeError('Lookup options are required.');
  if (!Array.isArray(options.recipients) || options.recipients.length === 0) {
    throw new TypeError('Lookup needs at least one recipient.');
  }
  options.recipients.forEach(function (recipient) {
    if (typeof recipient !== 'string' || !/^(mailto:|tel:\+)/.test(recipient)) {
      throw new TypeError('Lookup recipient is not normalized.');
    }
  });
  bytes.assertBytes(options.tunnelId, 'tunnel request ID');
  if (options.tunnelId.length !== 16) throw new TypeError('Tunnel request ID must contain 16 bytes.');
  var body = gzipCodec.gzip(xmlPlist.encodeXmlPlist({ uris: options.recipients }));
  var headers = [];
  if (options.requiredForMessage !== false) headers.push(['x-required-for-message', 'true']);
  if (options.resultExpected !== false) headers.push(['x-result-expected', 'true']);
  headers.push(['x-id-self-uri', options.sender]);
  headers.push(['x-push-token', bytes.bytesToBase64(options.pushToken)]);
  headers.push(['x-protocol-version', String(options.protocolVersion)]);
  headers.push(['user-agent', 'com.apple.madrid-lookup ' + options.userAgent]);
  if (options.subService && options.subService !== options.mainService) {
    headers.push(['x-id-sub-service', options.subService]);
  }
  var signed = signing.signRequest({
    crypto: options.crypto,
    keyId: options.keyId,
    certificate: options.certificate,
    keyType: 'id',
    bagKey: LOOKUP_BAG_KEY,
    body: body,
    pushToken: options.pushToken,
    nowMs: options.nowMs,
    randomBytes: options.nonceRandomBytes,
  });
  headers = headers.concat(signed.headers);
  var tunnel = {
    cT: 'application/x-apple-plist',
    U: options.tunnelId,
    c: 96,
    u: options.lookupUrl,
    h: headersToDictionary(headers),
    v: 2,
    b: body,
  };
  return Object.freeze({
    bagKey: LOOKUP_BAG_KEY,
    body: body,
    headers: Object.freeze(headers.map(function (header) { return Object.freeze(header.slice()); })),
    tunnelId: new Uint8Array(options.tunnelId),
    value: tunnel,
    apsPayload: bplist.encodeBinaryPlist(tunnel),
  });
}

function parseLookupTunnelResponse(value, expectedTunnelId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Lookup tunnel response is malformed.');
  if (!(value.U instanceof Uint8Array) || !equal(value.U, expectedTunnelId)) return null;
  if (!(value.b instanceof Uint8Array)) {
    if (Number.isSafeInteger(value.s)) {
      var error = new Error('Lookup tunnel returned status ' + value.s + '.');
      error.code = 'LOOKUP_TUNNEL_ERROR';
      error.status = value.s;
      throw error;
    }
    throw new TypeError('Lookup tunnel response has no body or status.');
  }
  var decoded = xmlPlist.decodeXmlPlist(gzipCodec.ungzip(value.b));
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
      || !Number.isSafeInteger(decoded.status)) throw new TypeError('Lookup response is malformed.');
  if (decoded.status !== 0 || !decoded.results || typeof decoded.results !== 'object') {
    var lookupError = new Error('Lookup failed with status ' + decoded.status + '.');
    lookupError.code = 'LOOKUP_FAILED';
    lookupError.status = decoded.status;
    throw lookupError;
  }
  return decoded.results;
}

function equal(left, right) {
  if (!(right instanceof Uint8Array) || left.length !== right.length) return false;
  var difference = 0;
  for (var index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

module.exports = {
  LOOKUP_BAG_KEY: LOOKUP_BAG_KEY,
  buildLookupTunnel: buildLookupTunnel,
  parseLookupTunnelResponse: parseLookupTunnelResponse,
};
