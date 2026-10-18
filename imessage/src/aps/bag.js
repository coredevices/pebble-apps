'use strict';

var bplist = require('../codecs/binary-plist');
var xmlPlist = require('../codecs/xml-plist');
var bytes = require('../runtime/bytes');

var APNS_BAG_URL = 'http://init-p01st.push.apple.com/bag';
var IDS_BAG_URL = 'https://init.ess.apple.com/WebObjects/VCInit.woa/wa/getBag?ix=3';

function decodePlist(value) {
  bytes.assertBytes(value, 'property list');
  if (value.length >= 8 && bytes.bytesToUtf8(value.slice(0, 8)) === 'bplist00') {
    return bplist.decodeBinaryPlist(value);
  }
  return xmlPlist.decodeXmlPlist(value);
}

function buildBagRequest(url) {
  if (url !== APNS_BAG_URL && url !== IDS_BAG_URL) throw new TypeError('Unknown bag URL.');
  return Object.freeze({ method: 'GET', url: url, headers: Object.freeze([]), body: new Uint8Array(0) });
}

function parseBagResponse(body) {
  var outer = decodePlist(body);
  if (!outer || typeof outer !== 'object' || Array.isArray(outer) || !(outer.bag instanceof Uint8Array)) {
    throw new TypeError('Bag response does not contain an encoded bag.');
  }
  var bag = decodePlist(outer.bag);
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) throw new TypeError('Decoded bag is not a dictionary.');
  return bag;
}

function getBagValue(bag, key) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) throw new TypeError('Bag must be a dictionary.');
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(bag, key)) {
    throw new TypeError('Bag key is unavailable.');
  }
  return bag[key];
}

function chooseCourierTarget(bag, randomBytes) {
  var hostname = getBagValue(bag, 'APNSCourierHostname');
  var hostCount = getBagValue(bag, 'APNSCourierHostcount');
  if (typeof hostname !== 'string' || hostname.length === 0) throw new TypeError('Courier hostname is invalid.');
  if (!Number.isSafeInteger(hostCount) || hostCount < 1 || hostCount > 10000) {
    throw new TypeError('Courier host count is invalid.');
  }
  bytes.assertBytes(randomBytes, 'courier random bytes');
  if (randomBytes.length < 4) throw new TypeError('Courier selection needs four random bytes.');
  var selected = (bytes.readUint32BE(randomBytes) % hostCount) + 1;
  return Object.freeze({
    host: String(selected) + '-' + hostname,
    port: 5223,
    sni: hostname,
    // Apple's packed selection appends dynamic cache sizes to an unoffered ALPN value. Standard
    // mobile TLS stacks reject that extension, while the legacy raw courier works with no
    // selected protocol and is sufficient for this send-only milestone.
    alpn: Object.freeze(['apns-security-v3']),
  });
}

function packedCacheSizes(negotiatedAlpn) {
  if (negotiatedAlpn === undefined || negotiatedAlpn === null
      || negotiatedAlpn === 'apns-security-v3' || negotiatedAlpn === '') return null;
  if (typeof negotiatedAlpn !== 'string') throw new TypeError('Negotiated ALPN must be a string.');
  var match = negotiatedAlpn.match(/^apns-pack-v1:(\d+):(\d+)$/);
  if (!match) throw new TypeError('Packed courier ALPN is malformed.');
  var encoder = Number(match[1]);
  var decoder = Number(match[2]);
  if (!Number.isSafeInteger(encoder) || !Number.isSafeInteger(decoder)
      || encoder < 0 || decoder < 0 || encoder > 16 * 1024 * 1024 || decoder > 16 * 1024 * 1024) {
    throw new TypeError('Packed courier cache size is invalid.');
  }
  return Object.freeze({ encoder: encoder, decoder: decoder });
}

module.exports = {
  APNS_BAG_URL: APNS_BAG_URL,
  IDS_BAG_URL: IDS_BAG_URL,
  buildBagRequest: buildBagRequest,
  chooseCourierTarget: chooseCourierTarget,
  getBagValue: getBagValue,
  packedCacheSizes: packedCacheSizes,
  parseBagResponse: parseBagResponse,
};
