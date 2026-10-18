'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');

var bytes = require('../../src/runtime/bytes');
var plist = require('../../src/codecs/xml-plist');
var registration = require('../../src/ids/registration');

test('Madrid version capability types match the pinned RustPush plist values', function () {
  var rustSource = fs.readFileSync(path.resolve(
    __dirname,
    '../../harness/oracle-support/rustpush/src/imessage/aps_client.rs'
  ), 'utf8');
  assert.match(rustSource, /\("nicknames-version", Value::Real\(1\.0\)\)/);
  assert.match(rustSource, /\("ec-version", Value::Real\(1\.0\)\)/);

  var encoded = plist.encodeXmlPlist(registration.MADRID_CLIENT_DATA);
  var xml = bytes.bytesToUtf8(encoded);
  assert.match(xml, /<key>nicknames-version<\/key><real>1<\/real>/);
  assert.match(xml, /<key>ec-version<\/key><real>1<\/real>/);
});
