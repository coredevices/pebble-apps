'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { encodeBinaryPlist } = require('../../src/codecs/binary-plist');
const { encodeXmlPlist } = require('../../src/codecs/xml-plist');
const bag = require('../../src/aps/bag');

test('bag parser unwraps both XML and binary property lists', function () {
  const values = { APNSCourierHostname: 'courier.example.invalid', APNSCourierHostcount: 7 };
  const binary = bag.parseBagResponse(encodeXmlPlist({ bag: encodeBinaryPlist(values) }));
  assert.deepEqual(binary, values);
  const xml = bag.parseBagResponse(encodeBinaryPlist({ bag: encodeXmlPlist(values) }));
  assert.deepEqual(xml, values);
});

test('courier target selection keeps hostname, SNI, port, and ALPN in JS', function () {
  const target = bag.chooseCourierTarget({
    APNSCourierHostname: 'courier.example.invalid', APNSCourierHostcount: 7,
  }, new Uint8Array([0, 0, 0, 9]));
  assert.deepEqual(target, {
    host: '3-courier.example.invalid', port: 5223, sni: 'courier.example.invalid',
    alpn: ['apns-security-v3'],
  });
  assert.deepEqual(bag.packedCacheSizes('apns-pack-v1:4096:2048'), { encoder: 4096, decoder: 2048 });
  assert.equal(bag.packedCacheSizes('apns-security-v3'), null);
});

test('bag operations reject unknown endpoints and malformed values', function () {
  assert.throws(() => bag.buildBagRequest('https://example.invalid'), /Unknown bag URL/);
  assert.throws(() => bag.parseBagResponse(encodeXmlPlist({ nope: true })), /encoded bag/);
  assert.throws(() => bag.chooseCourierTarget({ APNSCourierHostname: 'x', APNSCourierHostcount: 0 }, new Uint8Array(4)), /host count/);
  assert.throws(() => bag.packedCacheSizes('apns-pack-v1:one:2'), /malformed/);
});
