'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { byteString } = require('../../harness/schema');
const {
  assertNoSecrets,
  redactTrace,
  scanForSecrets,
  validateFixtureMetadata,
} = require('../../harness/fixture-safety');

const ORACLE_COMMIT = 'a7fab473e7a33325a760635285db2860de8e1cb0';

test('fixture metadata pins deterministic inputs and oracle provenance', function () {
  const metadata = {
    schemaVersion: 1,
    id: 'aps.raw.empty-v1',
    class: 'synthetic-protocol',
    oracle: { repository: 'local-pinned-reference', commit: ORACLE_COMMIT },
    deterministic: { seed: 7, nowMs: 1700000000000 },
    expectedPhase: 'raw-frame-encoding',
    comparison: 'exact',
  };
  assert.equal(validateFixtureMetadata(metadata), metadata);
  assert.throws(function () {
    validateFixtureMetadata({ ...metadata, oracle: undefined });
  }, /oracle/);
  assert.throws(function () {
    validateFixtureMetadata({ ...metadata, extra: true });
  }, /unknown field/);
});

test('trace redaction preserves structure but removes sensitive values', function () {
  const trace = {
    kind: 'http.request',
    requestId: 'request-1',
    headers: [['Content-Type', 'application/octet-stream']],
    body: byteString(new Uint8Array([1, 2, 3, 4])),
    metadata: { password: 'synthetic-value', phase: 'login' },
  };
  const redacted = redactTrace(trace);

  assert.deepEqual(redacted.body, { redacted: true, type: 'bytes', length: 4 });
  assert.deepEqual(redacted.metadata.password, {
    redacted: true,
    type: 'string',
    length: 15,
  });
  assert.equal(redacted.kind, 'http.request');
  assert.equal(JSON.stringify(redacted).includes('synthetic-value'), false);
});

test('secret scanner returns paths without echoing secret contents', function () {
  const value = {
    source: 'authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    nested: ['-----BEGIN PRIVATE KEY-----'],
  };
  const matches = scanForSecrets(value);

  assert.deepEqual(matches, [
    { path: '$.source', rule: 'credential-assignment' },
    { path: '$.source', rule: 'bearer-token' },
    { path: '$.nested[0]', rule: 'private-key' },
  ]);
  assert.throws(function () { assertNoSecrets(value); }, /Potential credential-assignment secret at \$\.source/);
  assert.doesNotThrow(function () { assertNoSecrets({ fixture: 'synthetic-safe-placeholder' }); });
});
