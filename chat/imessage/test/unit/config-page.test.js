'use strict';

var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');

var source = fs.readFileSync(path.join(__dirname, '..', '..', 'config.html'), 'utf8');

test('two-factor page exposes start-over recovery through the disconnect controller action', function () {
  assert.match(source, /id="twoFactor"[\s\S]*id="resetTwoFactor"/);
  assert.match(source, /\$\('resetTwoFactor'\)\.onclick = disconnect;/);
  assert.match(source, /send\(\{ type: 'disconnect' \}\)/);
});

test('ready page renders registered senders and persists an explicit send-from selection', function () {
  assert.match(source, /id="sender"/);
  assert.match(source, /Valid addresses for this Apple ID/);
  assert.match(source, /option\.value = handle/);
  assert.match(source, /handle === result\.selectedSender/);
  assert.match(source, /type: 'selectSender', sender: \$\('sender'\)\.value/);
  assert.match(source, /first phone number is selected automatically/);
});

test('ready page adds and removes named contacts without rendering contact data as HTML', function () {
  assert.match(source, /id="contactName"/);
  assert.match(source, /id="contactAddress"/);
  assert.match(source, /id="addContact"/);
  assert.match(source, /type: 'saveContacts', contacts: nextContacts/);
  assert.match(source, /contacts\.concat\(\[\{ name: name, address: address \}\]\)/);
  assert.match(source, /removeContact\(index\)/);
  assert.match(source, /id="clearContacts"/);
  assert.match(source, /saveContacts\(\[\], 'Contacts cleared\.'/);
  assert.match(source, /Saved contacts will remain/);
  assert.match(source, /name\.textContent = contact\.name/);
  assert.match(source, /address\.textContent = displayAddress\(contact\.address\)/);
  assert.doesNotMatch(source, /contact[^\n]*innerHTML/);
});

test('disconnect always applies the authoritative connection status but only replaces settings on success', function () {
  assert.match(source, /show\(result\.status \|\| 'disconnected', result\.canSubmitTwoFactor\);\s*if \(result\.ok\) \{/);
  assert.match(source, /if \(result\.ok\) \{[\s\S]*renderSettings\(result\);\s*\}/);
});
