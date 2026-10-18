'use strict';

function scheduleDeadline(timer, delayMillis, callback) {
  if (!timer || typeof timer.after !== 'function' || typeof timer.cancel !== 'function') {
    throw new TypeError('Deadline timer is unavailable.');
  }
  if (!Number.isSafeInteger(delayMillis) || delayMillis <= 0 || typeof callback !== 'function') {
    throw new TypeError('Deadline arguments are invalid.');
  }
  var active = true;
  var handle = timer.after(delayMillis, function () {
    if (!active) return;
    active = false;
    callback();
  });
  return Object.freeze({
    cancel: function () {
      if (!active) return;
      active = false;
      try { timer.cancel(handle); }
      catch (_) { /* terminal operation remains authoritative */ }
    },
  });
}

module.exports = { scheduleDeadline: scheduleDeadline };
