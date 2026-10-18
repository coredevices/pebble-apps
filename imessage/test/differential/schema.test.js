'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const {
  SchemaValidationError,
  assertEventRespondsTo,
  byteString,
  createEffect,
  createEvent,
  decodeByteString,
  validateEffect,
} = require('../../harness');

test('byte envelopes round-trip every byte and canonical padding', () => {
  const input = Uint8Array.from({ length: 256 }, (_, index) => index);
  const encoded = byteString(input);
  assert.equal(encoded.$bytes.endsWith('=='), true);
  assert.deepEqual(decodeByteString(encoded), input);
});

test('HTTP schema preserves duplicate ordered headers and rejects flattened maps', () => {
  const request = createEffect('http.request', {
    requestId: 'http-1',
    method: 'POST',
    url: 'https://fixture.invalid/test',
    headers: [['x-token', 'first'], ['x-token', 'second']],
    body: byteString([0, 1, 2]),
  });
  assert.deepEqual(request.headers, [['x-token', 'first'], ['x-token', 'second']]);

  assert.throws(() => validateEffect({
    ...request,
    headers: { 'x-token': 'second' },
  }), (error) => {
    assert.equal(error instanceof SchemaValidationError, true);
    assert.equal(error.path, '$.headers');
    return true;
  });
});

test('an input event must answer the exact pending request kind and ID', () => {
  const read = createEffect('tls.read', {
    requestId: 'read-7',
    streamId: 'fixture-stream',
    maximumBytes: 1024,
  });
  const data = createEvent('tls.data', {
    requestId: 'read-7',
    streamId: 'fixture-stream',
    data: byteString([1]),
  });
  assert.doesNotThrow(() => assertEventRespondsTo(read, data));

  assert.throws(() => assertEventRespondsTo(read, {
    ...data,
    requestId: 'read-8',
  }), /expected "read-7"/);
  assert.throws(() => assertEventRespondsTo(read, createEvent('clock.result', {
    requestId: 'read-7',
    nowMs: 1,
  })), /clock.result cannot answer tls.read/);
});

test('unknown fields and malformed byte envelopes fail at their exact path', () => {
  assert.throws(() => validateEffect({
    version: 1,
    kind: 'tls.write',
    requestId: 'write-1',
    streamId: 'fixture-stream',
    data: { $bytes: 'not padded' },
  }), (error) => {
    assert.equal(error.path, '$.data.$bytes');
    return true;
  });

  assert.throws(() => validateEffect({
    version: 1,
    kind: 'storage.read',
    requestId: 'storage-1',
    key: 'state',
    typo: true,
  }), (error) => {
    assert.equal(error.path, '$.typo');
    return true;
  });
});

test('schema accepts plain JSON records crossing a JavaScript realm boundary', () => {
  const effect = vm.runInNewContext(`({
    version: 1,
    kind: 'terminal.result',
    result: { engine: 'other-realm' },
  })`);
  assert.doesNotThrow(() => validateEffect(effect));
});
