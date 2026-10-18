'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

test('malformed local input returns a code-only failure without echoing input', function () {
  var captured = null;
  globalThis._NacParityInput = {
    read: function () { return '{"unexpectedField":"must-never-be-echoed"}'; },
  };
  globalThis._NacParityResult = {
    complete: function (value) { captured = value; },
  };
  try {
    require('./entry');
    globalThis.__runNacAndroidParity();
    assert.deepEqual(JSON.parse(captured), {
      ok: false,
      code: 'NAC_PARITY_INPUT_INVALID',
    });
    assert.equal(captured.includes('must-never-be-echoed'), false);
  } finally {
    delete globalThis._NacParityInput;
    delete globalThis._NacParityResult;
    delete globalThis.__runNacAndroidParity;
  }
});
