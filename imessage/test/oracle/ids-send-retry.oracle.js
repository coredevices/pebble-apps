'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');

var retry = require('../../src/ids/send-retry');

test('IDS send retry constants and refresh shape match pinned RustPush', function () {
  var rustSource = fs.readFileSync(path.resolve(
    __dirname,
    '../../harness/oracle-support/rustpush/src/ids/identity_manager.rs'
  ), 'utf8');
  assert.match(rustSource, /5032\s*=>\s*\{/);
  assert.match(rustSource, /0\s*\|\s*5008\s*=>\s*\{/);
  assert.match(rustSource, /refresh_handles\(self\.topic, &handle, &refresh_targets\)/);
  assert.match(rustSource, /retry_count\s*==\s*5/);
  assert.equal(retry.REFRESH_KEYS_STATUS, 5032);
  assert.equal(retry.MAX_REFRESH_RETRIES, 5);
});
