'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var HostTimer = require('../../src/runtime/host-timer-provider').HostTimer;

test('host timer dispatches one-shot callbacks and cancels pending callbacks', function () {
  var scheduled = [];
  var cancelled = [];
  var globalObject = {};
  var timer = new HostTimer({
    schedule: function (delayMillis) {
      scheduled.push(delayMillis);
      return scheduled.length;
    },
    cancel: function (handle) { cancelled.push(handle); },
  }, globalObject);
  var calls = 0;

  var fired = timer.after(25, function () { calls += 1; });
  assert.equal(fired, 1);
  assert.deepEqual(scheduled, [25]);
  globalObject.__hostTimerDispatch(fired);
  globalObject.__hostTimerDispatch(fired);
  assert.equal(calls, 1);

  var stopped = timer.after(50, function () { calls += 10; });
  timer.cancel(stopped);
  globalObject.__hostTimerDispatch(stopped);
  assert.equal(calls, 1);
  assert.deepEqual(cancelled, [2]);
});

test('host timer validates the native surface, arguments, and returned handles', function () {
  assert.throws(function () { return new HostTimer({}, {}); }, /unavailable/);
  var timer = new HostTimer({ schedule: function () { return 0; }, cancel: function () {} }, {});
  assert.throws(function () { timer.after(0, function () {}); }, /invalid/);
  assert.throws(function () { timer.after(1, null); }, /invalid/);
  assert.throws(function () { timer.after(1, function () {}); }, /invalid handle/);
  assert.throws(function () { timer.cancel(0); }, /invalid/);
});
