'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var apsBag = require('../../src/aps/bag');
var bplist = require('../../src/codecs/binary-plist');
var xmlPlist = require('../../src/codecs/xml-plist');
var idsBag = require('../../src/ids/bag');

function values(overrides) {
  return Object.assign({
    'id-authenticate-ds-id': 'https://profile.ess.apple.com/authenticate',
    'id-get-handles': 'https://profile.ess.apple.com/handles',
    'id-register': 'https://identity.ess.apple.com/register',
    'id-query': 'https://query.ess.apple.com/query',
    'id-validation-cert': 'https://identity.ess.apple.com/validation/cert',
    'id-initialize-validation': 'https://identity.ess.apple.com/validation/initialize',
  }, overrides || {});
}

function responseBody(value) {
  return xmlPlist.encodeXmlPlist({ bag: bplist.encodeBinaryPlist(value) });
}

test('IDS endpoints are selected by their protocol keys and remain Apple HTTPS URLs', function () {
  assert.deepEqual(idsBag.endpointsFromBag(values()), {
    authenticationEndpoint: 'https://profile.ess.apple.com/authenticate',
    handlesEndpoint: 'https://profile.ess.apple.com/handles',
    registrationEndpoint: 'https://identity.ess.apple.com/register',
    lookupEndpoint: 'https://query.ess.apple.com/query',
    validationCertificateEndpoint: 'https://identity.ess.apple.com/validation/cert',
    validationInitializationEndpoint: 'https://identity.ess.apple.com/validation/initialize',
  });
  assert.throws(function () {
    idsBag.endpointsFromBag(values({ 'id-query': 'https://example.test/query' }));
  }, /untrusted endpoint/);
  assert.throws(function () {
    var missing = values(); delete missing['id-register']; idsBag.endpointsFromBag(missing);
  }, /missing a required endpoint/);
});

test('current HTTP certificate bag endpoint is upgraded only for the exact Apple host', function () {
  var endpoints = idsBag.endpointsFromBag(values({
    'id-validation-cert': 'http://static.ess.apple.com/identity/validation/cert-1.0.plist',
  }));
  assert.equal(
    endpoints.validationCertificateEndpoint,
    'https://static.ess.apple.com/identity/validation/cert-1.0.plist'
  );
  assert.throws(function () {
    idsBag.endpointsFromBag(values({
      'id-validation-cert': 'http://identity.ess.apple.com/identity/validation/cert-1.0.plist',
    }));
  }, /untrusted endpoint/);
  assert.throws(function () {
    idsBag.endpointsFromBag(values({
      'id-validation-cert': 'http://static.ess.apple.com.example.test/cert',
    }));
  }, /untrusted endpoint/);
});

test('IDS endpoint fetch validates HTTP and ignores diagnostic trace failures', async function () {
  var requests = [];
  var endpoints = await idsBag.fetchIdsEndpoints({
    http: { request: async function (request) {
      requests.push(request);
      return { status: 200, headers: [], body: responseBody(values()) };
    } },
    trace: { emit: function () { throw new Error('synthetic trace failure'); } },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, apsBag.IDS_BAG_URL);
  assert.equal(requests[0].trustAnchors.length, 2);
  assert.ok(requests[0].trustAnchors[0] instanceof Uint8Array);
  assert.equal(requests[0].maxResponseBytes, 2 * 1024 * 1024);
  assert.equal(endpoints.lookupEndpoint, 'https://query.ess.apple.com/query');

  await assert.rejects(idsBag.fetchIdsEndpoints({ http: { request: async function () {
    return { status: 503, headers: [], body: new Uint8Array(0) };
  } } }), /rejected/);
  await assert.rejects(idsBag.fetchIdsEndpoints({ http: { request: async function () {
    return { status: 200, headers: [], body: new Uint8Array([1, 2, 3]) };
  } } }), /could not be decoded/);
});
