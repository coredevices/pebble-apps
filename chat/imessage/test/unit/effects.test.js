'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var createEffects = require('../../src/runtime/effects').createEffects;
var errors = require('../../src/runtime/errors');

test('effects delegate to deterministic injected providers and preserve provider context', function () {
  var provider = {
    seed: 7,
    bytes: function (length) {
      return new Uint8Array(length).fill(this.seed);
    },
  };
  var effects = createEffects({
    clock: { now: function () { return 123456; } },
    random: provider,
    storage: {
      get: function (key) { return key === 'state' ? 'value' : null; },
      set: function () {},
      delete: function () {},
    },
  });

  assert.equal(effects.clock.now(), 123456);
  var random = effects.random.bytes(4);
  assert.deepEqual(random, new Uint8Array([7, 7, 7, 7]));
  random[0] = 0;
  assert.deepEqual(provider.bytes(4), new Uint8Array([7, 7, 7, 7]));
  assert.equal(effects.storage.get('state'), 'value');
  assert.equal(Object.isFrozen(effects), true);
  assert.equal(Object.isFrozen(effects.random), true);
});

test('missing capabilities fail at call time with a structured error', function () {
  var effects = createEffects();

  assert.doesNotThrow(function () { effects.trace.emit({ phase: 'test' }); });
  assert.throws(function () { effects.http.request({}); }, function (error) {
    return errors.isRuntimeError(error) &&
      error.code === 'MISSING_EFFECT' &&
      error.kind === errors.ERROR_KINDS.CAPABILITY;
  });
});

test('clock and random results are validated before consumers receive them', function () {
  var badClock = createEffects({ clock: { now: function () { return Infinity; } } });
  assert.throws(function () { badClock.clock.now(); }, function (error) {
    return error.code === 'INVALID_EFFECT_RESULT';
  });

  var calls = 0;
  var badRandom = createEffects({
    random: { bytes: function () { calls += 1; return new Uint8Array(1); } },
  });
  assert.throws(function () { badRandom.random.bytes(2); }, /requested length/);
  assert.throws(function () { badRandom.random.bytes(-1); }, /non-negative safe integer/);
  assert.equal(calls, 1);
});

test('effects reject misspelled or malformed providers', function () {
  assert.throws(function () { createEffects({ htpp: {} }); }, /Unknown effects provider/);
  assert.throws(function () { createEffects({ tls: true }); }, /tls effects provider must be an object/);
  assert.throws(function () { createEffects({ trace: {} }).trace.emit({}); }, /trace\.emit/);
});
