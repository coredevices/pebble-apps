'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { decodeBinaryPlist } = require('../../src/codecs/binary-plist');
const { encodeXmlPlist } = require('../../src/codecs/xml-plist');
const { gzip } = require('../../src/codecs/gzip');
const lookup = require('../../src/ids/lookup');

function build() {
  return lookup.buildLookupTunnel({
    recipients: ['mailto:recipient@example.invalid'], sender: 'mailto:sender@example.invalid',
    pushToken: new Uint8Array(32).fill(1), protocolVersion: 4, userAgent: '[synthetic]',
    mainService: 'com.apple.madrid', subService: 'com.apple.madrid',
    lookupUrl: 'https://example.invalid/id-query', tunnelId: new Uint8Array(16).fill(2),
    crypto: { sign() { return new Uint8Array([3]); } }, keyId: 'id-key',
    certificate: new Uint8Array([4]), nowMs: 1000, nonceRandomBytes: new Uint8Array(8),
  });
}

test('IDS lookup constructs signed command-96 web tunnel entirely in JS', function () {
  const result = build();
  const tunnel = decodeBinaryPlist(result.apsPayload);
  assert.equal(tunnel.c, 96);
  assert.equal(tunnel.cT, 'application/x-apple-plist');
  assert.equal(tunnel.h['x-required-for-message'], 'true');
  assert.equal(tunnel.h['x-result-expected'], 'true');
  assert.equal(typeof tunnel.h['x-id-sig'], 'string');
});

test('IDS lookup response correlates tunnel ID and exposes parsed results', function () {
  const request = build();
  assert.equal(lookup.parseLookupTunnelResponse({ U: new Uint8Array(16).fill(9) }, request.tunnelId), null);
  const results = { 'mailto:recipient@example.invalid': { identities: [] } };
  assert.deepEqual(lookup.parseLookupTunnelResponse({
    U: request.tunnelId, b: gzip(encodeXmlPlist({ status: 0, results })),
  }, request.tunnelId), results);
  assert.throws(() => lookup.parseLookupTunnelResponse({ U: request.tunnelId, s: 5206 }, request.tunnelId),
    (error) => error.code === 'LOOKUP_TUNNEL_ERROR' && error.status === 5206);
});
