'use strict';

var bytes = require('../runtime/bytes');

var REFRESH_KEYS_STATUS = 5032;
var SUCCESS_STATUSES = Object.freeze({ 0: true, 5008: true });
var MAX_REFRESH_RETRIES = 5;

function requireTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)
      || typeof target.participant !== 'string' || target.participant.length === 0
      || !(target.pushToken instanceof Uint8Array) || target.pushToken.length !== 32) {
    throw new TypeError('IDS delivery target is malformed.');
  }
  return target;
}

/** Track the one command-255 result emitted for each unique target push token. */
function SendResultTracker(sender, targets) {
  if (typeof sender !== 'string' || sender.length === 0) throw new TypeError('IDS sender is malformed.');
  if (!Array.isArray(targets) || targets.length === 0) throw new TypeError('IDS delivery targets are missing.');
  this.sender = sender;
  this.entries = Object.create(null);
  this.order = [];
  this.remaining = 0;
  this.statuses = [];
  this.refreshTargets = [];
  this.recipientSucceeded = false;
  var self = this;
  targets.forEach(function (target) {
    target = requireTarget(target);
    var token = new Uint8Array(target.pushToken);
    var tokenKey = bytes.bytesToHex(token);
    var entry = self.entries[tokenKey];
    if (!entry) {
      entry = self.entries[tokenKey] = {
        token: token,
        targets: [],
        complete: false,
      };
      self.order.push(tokenKey);
      self.remaining += 1;
    }
    if (!entry.targets.some(function (existing) { return existing.participant === target.participant; })) {
      entry.targets.push(Object.freeze({ participant: target.participant, pushToken: token }));
    }
  });
}

SendResultTracker.prototype.expectedPushTokens = function () {
  var self = this;
  return Object.freeze(this.order.map(function (key) {
    return new Uint8Array(self.entries[key].token);
  }));
};

function outcome(kind, tracker, extra) {
  return Object.freeze(Object.assign({
    kind: kind,
    remaining: tracker.remaining,
    statuses: Object.freeze(tracker.statuses.slice()),
    recipientSucceeded: tracker.recipientSucceeded,
  }, extra || {}));
}

/**
 * Accept a correlated command-255 status. A 5032 result requests fresh IDS keys for that exact
 * participant/device; it is not treated as an account re-registration request.
 */
SendResultTracker.prototype.accept = function (pushToken, status) {
  if (!(pushToken instanceof Uint8Array) || pushToken.length !== 32
      || !Number.isSafeInteger(status)) throw new TypeError('IDS send result is malformed.');
  var entry = this.entries[bytes.bytesToHex(pushToken)];
  if (!entry || entry.complete) return outcome('ignored', this);
  entry.complete = true;
  this.remaining -= 1;
  this.statuses.push(status);

  var hasRecipient = entry.targets.some(function (target) {
    return target.participant !== this.sender;
  }, this);
  if (hasRecipient && SUCCESS_STATUSES[status]) this.recipientSucceeded = true;
  if (status === REFRESH_KEYS_STATUS) {
    entry.targets.forEach(function (target) {
      this.refreshTargets.push(Object.freeze({
        participant: target.participant,
        pushToken: new Uint8Array(target.pushToken),
      }));
    }, this);
  }
  if (this.remaining > 0) return outcome('pending', this);
  if (this.refreshTargets.length > 0) {
    return outcome('refresh', this, {
      targets: Object.freeze(this.refreshTargets.slice()),
    });
  }
  if (this.recipientSucceeded) return outcome('success', this);
  return outcome('failure', this);
};

function nextRetryCount(current) {
  if (!Number.isInteger(current) || current < 0 || current > MAX_REFRESH_RETRIES) {
    throw new TypeError('IDS retry count is malformed.');
  }
  return current < MAX_REFRESH_RETRIES ? current + 1 : null;
}

function originalEpochNanos(epochMilliseconds) {
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new TypeError('Original send timestamp is malformed.');
  }
  var value = BigInt(epochMilliseconds) * 1000000n;
  if (value > 0xffffffffffffffffn) throw new TypeError('Original send timestamp is out of range.');
  return value;
}

function refreshParticipants(targets) {
  if (!Array.isArray(targets) || targets.length === 0) throw new TypeError('IDS refresh targets are missing.');
  var seen = Object.create(null);
  var participants = [];
  targets.forEach(function (target) {
    target = requireTarget(target);
    if (!seen[target.participant]) {
      seen[target.participant] = true;
      participants.push(target.participant);
    }
  });
  return Object.freeze(participants);
}

/** Mirror RustPush refresh_handles: refreshed records must match a stale participant and token. */
function selectRefreshedTargets(delivery, staleTargets) {
  if (!Array.isArray(delivery)) throw new TypeError('Refreshed IDS delivery targets are malformed.');
  var participants = refreshParticipants(staleTargets);
  var participantSet = Object.create(null);
  participants.forEach(function (participant) { participantSet[participant] = true; });
  var tokenSet = Object.create(null);
  staleTargets.forEach(function (target) {
    target = requireTarget(target);
    tokenSet[bytes.bytesToHex(target.pushToken)] = true;
  });
  return Object.freeze(delivery.filter(function (target) {
    target = requireTarget(target);
    return participantSet[target.participant] && tokenSet[bytes.bytesToHex(target.pushToken)];
  }));
}

module.exports = {
  MAX_REFRESH_RETRIES: MAX_REFRESH_RETRIES,
  REFRESH_KEYS_STATUS: REFRESH_KEYS_STATUS,
  SendResultTracker: SendResultTracker,
  nextRetryCount: nextRetryCount,
  originalEpochNanos: originalEpochNanos,
  refreshParticipants: refreshParticipants,
  selectRefreshedTargets: selectRefreshedTargets,
};
