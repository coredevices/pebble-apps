'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');
var preferencesModule = require('../../src/preferences/user-preferences');
var UserPreferences = preferencesModule.UserPreferences;

function MemoryStorage() { this.values = Object.create(null); }
MemoryStorage.prototype.get = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};
MemoryStorage.prototype.set = function (key, value) { this.values[key] = value; };
MemoryStorage.prototype.delete = function (key) { delete this.values[key]; };

test('first sender selection prefers the first registered phone and remains user-selectable', function () {
  var storage = new MemoryStorage();
  var subject = new UserPreferences(storage, { storageKey: 'preferences' });
  var handles = [
    'mailto:sender@example.test',
    'tel:+15555550123',
    'tel:+15555550124',
  ];

  assert.equal(subject.reconcileSelectedSender(handles), 'tel:+15555550123');
  assert.equal(new UserPreferences(storage, { storageKey: 'preferences' }).snapshot(handles).selectedSender,
    'tel:+15555550123');
  assert.equal(subject.selectSender('sender@example.test', handles), 'mailto:sender@example.test');
  assert.equal(subject.reconcileSelectedSender(handles), 'mailto:sender@example.test');
  assert.throws(function () { subject.selectSender('+15555550999', handles); }, function (error) {
    return error.code === 'INVALID_SENDER';
  });

  subject.clearSelectedSender();
  assert.equal(subject.reconcileSelectedSender(handles), 'tel:+15555550123');
});

test('contacts persist normalized destinations and resolve case-insensitive spoken names', function () {
  var storage = new MemoryStorage();
  var subject = new UserPreferences(storage, { storageKey: 'preferences' });
  subject.replaceContacts([
    { name: '  Danny  ', address: ' +1 (510) 508-5455 ' },
    { name: 'Work Alice', address: 'alice@example.test' },
  ]);

  var restored = new UserPreferences(storage, { storageKey: 'preferences' });
  assert.deepEqual(restored.snapshot([]).contacts, [
    { name: 'Danny', address: 'tel:+15105085455' },
    { name: 'Work Alice', address: 'mailto:alice@example.test' },
  ]);
  assert.equal(restored.resolveRecipient('dAnNy'), 'tel:+15105085455');
  assert.equal(restored.resolveRecipient('  work   alice '), 'mailto:alice@example.test');
  assert.equal(restored.resolveRecipient('+1 415 555 0123'), 'tel:+14155550123');
  assert.equal(restored.resolveRecipient('unknown'), null);
});

test('contact list rejects invalid addresses, duplicate names, excess entries, and corrupt storage', function () {
  var storage = new MemoryStorage();
  var subject = new UserPreferences(storage, { storageKey: 'preferences' });
  assert.throws(function () {
    subject.replaceContacts([{ name: 'Danny', address: '5105085455' }]);
  }, function (error) { return error.code === 'INVALID_CONTACTS'; });
  assert.throws(function () {
    subject.replaceContacts([
      { name: 'Danny', address: '+15105085455' },
      { name: ' danny ', address: 'danny@example.test' },
    ]);
  }, function (error) { return error.code === 'INVALID_CONTACTS'; });
  assert.throws(function () {
    subject.replaceContacts([{ name: 'danny@example.test', address: '+15105085455' }]);
  }, function (error) { return error.code === 'INVALID_CONTACTS'; });
  assert.throws(function () {
    subject.replaceContacts(new Array(51).fill({ name: 'Danny', address: '+15105085455' }));
  }, function (error) { return error.code === 'INVALID_CONTACTS'; });

  storage.values.preferences = '{not-json';
  assert.throws(function () { subject.snapshot([]); }, function (error) {
    return error.code === 'INVALID_PREFERENCES_STATE' && error.kind === 'storage';
  });
  storage.values.preferences = JSON.stringify({
    version: 1,
    contacts: [{ name: 'Danny', address: new Array(322).join('a') + '@example.test' }],
    selectedSender: null,
  });
  assert.throws(function () { subject.snapshot([]); }, function (error) {
    return error.code === 'INVALID_PREFERENCES_STATE' && error.kind === 'storage';
  });
});
