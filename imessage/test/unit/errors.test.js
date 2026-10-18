'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var errors = require('../../src/runtime/errors');

test('RuntimeError exposes a stable serializable boundary shape', function () {
  var error = new errors.RuntimeError('NETWORK_DOWN', 'Network unavailable.', {
    kind: errors.ERROR_KINDS.TRANSPORT,
    retryable: true,
    details: { phase: 'connect' },
    cause: new Error('private low-level detail'),
  });

  assert.equal(error.name, 'RuntimeError');
  assert.equal(error.code, 'NETWORK_DOWN');
  assert.equal(error.retryable, true);
  assert.deepEqual(error.toJSON(), {
    name: 'RuntimeError',
    code: 'NETWORK_DOWN',
    message: 'Network unavailable.',
    kind: 'transport',
    retryable: true,
    details: { phase: 'connect' },
  });
  assert.equal(JSON.stringify(error).includes('private low-level detail'), false);
});

test('asRuntimeError preserves structured errors and safely wraps unknown values', function () {
  var existing = new errors.RuntimeError('CANCELLED', 'Operation cancelled.', {
    kind: errors.ERROR_KINDS.CANCELLED,
  });
  assert.equal(errors.asRuntimeError(existing, 'OTHER', 'Other.'), existing);

  var wrapped = errors.asRuntimeError(
    new Error('secret transport response'),
    'UNEXPECTED_ERROR',
    'The operation failed.'
  );
  assert.equal(wrapped.message, 'The operation failed.');
  assert.equal(wrapped.cause.message, 'secret transport response');
  assert.equal(wrapped.toJSON().message, 'The operation failed.');
});

test('serialized runtime errors can be reconstructed after JSON transport', function () {
  var original = new errors.RuntimeError('TIMED_OUT', 'The operation timed out.', {
    kind: errors.ERROR_KINDS.TIMEOUT,
    retryable: true,
  });
  var restored = errors.deserializeRuntimeError(JSON.parse(JSON.stringify(original)));

  assert.equal(errors.isRuntimeError(restored), true);
  assert.deepEqual(restored.toJSON(), original.toJSON());
  assert.throws(function () {
    errors.deserializeRuntimeError({ code: 42, message: 'bad' });
  }, /missing its code or message/);
});
