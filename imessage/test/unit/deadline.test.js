'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var scheduleDeadline = require('../../src/runtime/deadline').scheduleDeadline;

test('deadline cancellation is best-effort and permanently suppresses a late callback', function () {
  var scheduled;
  var calls = 0;
  var deadline = scheduleDeadline({
    after: function (delayMillis, callback) {
      assert.equal(delayMillis, 25);
      scheduled = callback;
      return 7;
    },
    cancel: function (handle) {
      assert.equal(handle, 7);
      throw new Error('synthetic timer cancellation failure');
    },
  }, 25, function () { calls += 1; });

  assert.doesNotThrow(function () { deadline.cancel(); });
  scheduled();
  assert.equal(calls, 0);
});
