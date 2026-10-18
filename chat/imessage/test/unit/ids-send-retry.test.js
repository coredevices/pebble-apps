'use strict';

var assert = require('node:assert/strict');
var test = require('node:test');

var retry = require('../../src/ids/send-retry');

var SENDER = 'mailto:sender@example.test';
var RECIPIENT = 'mailto:recipient@example.test';

function target(participant, byte, session) {
  return {
    participant: participant,
    pushToken: new Uint8Array(32).fill(byte),
    sessionToken: new Uint8Array([session || byte]),
  };
}

test('5032 waits for phase results then requests a fresh lookup for only stale devices', function () {
  var staleRecipient = target(RECIPIENT, 0x21);
  var failedRecipient = target(RECIPIENT, 0x22);
  var self = target(SENDER, 0x31);
  var tracker = new retry.SendResultTracker(SENDER, [staleRecipient, failedRecipient, self]);
  assert.deepEqual(tracker.expectedPushTokens(), [
    staleRecipient.pushToken, failedRecipient.pushToken, self.pushToken,
  ]);
  assert.equal(tracker.accept(staleRecipient.pushToken, 5032).kind, 'pending');
  assert.equal(tracker.accept(failedRecipient.pushToken, 7001).kind, 'pending');
  var result = tracker.accept(self.pushToken, 0);
  assert.equal(result.kind, 'refresh');
  assert.deepEqual(result.statuses, [5032, 7001, 0]);
  assert.deepEqual(result.targets.map(function (item) { return item.participant; }), [RECIPIENT]);
  assert.deepEqual(retry.refreshParticipants(result.targets), [RECIPIENT]);

  var refreshed = [
    target(RECIPIENT, 0x21, 9),
    target(RECIPIENT, 0x23, 10),
    target(SENDER, 0x21, 11),
  ];
  assert.deepEqual(retry.selectRefreshedTargets(refreshed, result.targets), [refreshed[0]]);
});

test('recipient 0 and 5008 statuses succeed while duplicate or unknown results are ignored', function () {
  [0, 5008].forEach(function (status) {
    var recipient = target(RECIPIENT, status === 0 ? 0x41 : 0x42);
    var self = target(SENDER, 0x43);
    var tracker = new retry.SendResultTracker(SENDER, [recipient, self]);
    assert.equal(tracker.accept(new Uint8Array(32).fill(0x99), 0).kind, 'ignored');
    var accepted = tracker.accept(recipient.pushToken, status);
    assert.equal(accepted.kind, 'pending');
    assert.equal(accepted.recipientSucceeded, true);
    assert.equal(tracker.accept(recipient.pushToken, status).kind, 'ignored');
    assert.equal(tracker.accept(self.pushToken, 0).kind, 'success');
  });
});

test('5032 refresh takes precedence after another recipient device succeeds', function () {
  var accepted = target(RECIPIENT, 0x51);
  var stale = target(RECIPIENT, 0x52);
  var tracker = new retry.SendResultTracker(SENDER, [accepted, stale]);
  assert.equal(tracker.accept(accepted.pushToken, 0).kind, 'pending');
  var result = tracker.accept(stale.pushToken, 5032);
  assert.equal(result.kind, 'refresh');
  assert.equal(result.recipientSucceeded, true);
  assert.deepEqual(result.targets.map(function (item) { return item.pushToken; }), [stale.pushToken]);
});

test('retry count and exact original nanosecond timestamp follow RustPush bounds', function () {
  assert.equal(retry.nextRetryCount(0), 1);
  assert.equal(retry.nextRetryCount(4), 5);
  assert.equal(retry.nextRetryCount(5), null);
  assert.equal(retry.originalEpochNanos(1770000123456), 1770000123456000000n);
  assert.throws(function () { retry.nextRetryCount(6); }, /retry count/);
  assert.throws(function () { retry.originalEpochNanos(Number.MAX_SAFE_INTEGER); }, /out of range/);
});
