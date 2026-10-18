'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');
var trust = require('../../src/aps/courier-trust');
var serverTrust = require('../../src/apple/server-trust');
var bagTrust = require('../../src/ids/bag-trust');
var manifest = require('../../appinfo.json');
var chatManifest = require('../../../chat/appinfo.json');

test('Apple services and courier share the full chain required by iOS', function () {
  var anchors = trust.courierTrustAnchors();
  var digests = anchors.map(value => crypto.createHash('sha256').update(value).digest('hex'));
  assert.deepEqual(digests, [
    'efd0c3352e8f5cc6c7678a5cb48370c341db58d39fc0569d5e106f02c4fcaceb',
    'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
  ]);
  assert.ok(new crypto.X509Certificate(anchors[0]).verify(new crypto.X509Certificate(anchors[1]).publicKey));
  for (var app of [manifest, chatManifest]) {
    var pins = app.plugin.actions[0].usesPermissions.find(p => p.name === 'NetworkSockets').parameters.tlsTrustAnchorSha256;
    for (var digest of digests) assert.ok(pins.includes(digest));
  }
  // Each native open consumes and wipes its own copy.
  anchors[1].fill(0);
  assert.equal(crypto.createHash('sha256').update(trust.courierTrustAnchors()[1]).digest('hex'), digests[1]);
  assert.deepEqual(serverTrust.appleServerTrustAnchors().map(value => crypto.createHash('sha256').update(value).digest('hex')), digests);
});

test('Apple bag and validation certificate endpoints pin their complete G3 chain', function () {
  var anchors = bagTrust.bagTrustAnchors();
  var digests = anchors.map(value => crypto.createHash('sha256').update(value).digest('hex'));
  assert.deepEqual(digests, [
    '2d9b64d8ec50d5d3e5a6659194ce52d607b2ad3c026fdd3d7fab724183c232d5',
    '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
  ]);
  assert.ok(new crypto.X509Certificate(anchors[0]).verify(new crypto.X509Certificate(anchors[1]).publicKey));
  for (var app of [manifest, chatManifest]) {
    var pins = app.plugin.actions[0].usesPermissions.find(p => p.name === 'NetworkSockets').parameters.tlsTrustAnchorSha256;
    for (var digest of digests) assert.ok(pins.includes(digest));
  }
  anchors.forEach(value => value.fill(0));
  assert.deepEqual(bagTrust.bagTrustAnchors().map(value => crypto.createHash('sha256').update(value).digest('hex')), digests);
});
