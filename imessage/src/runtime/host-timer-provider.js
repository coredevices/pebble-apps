'use strict';

function HostTimer(nativeInterface, globalObject) {
  if (!nativeInterface || typeof nativeInterface.schedule !== 'function'
      || typeof nativeInterface.cancel !== 'function') {
    throw new TypeError('Native timer service is unavailable.');
  }
  this.native = nativeInterface;
  this.callbacks = Object.create(null);
  var callbacks = this.callbacks;
  globalObject = globalObject || globalThis;
  globalObject.__hostTimerDispatch = function (id) {
    var key = String(id);
    var callback = callbacks[key];
    if (!callback) return;
    delete callbacks[key];
    callback();
  };
}

HostTimer.prototype.after = function (delayMillis, callback) {
  if (!Number.isSafeInteger(delayMillis) || delayMillis <= 0 || typeof callback !== 'function') {
    throw new TypeError('Timer delay and callback are invalid.');
  }
  var handle = this.native.schedule(delayMillis);
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new TypeError('Native timer service returned an invalid handle.');
  }
  this.callbacks[String(handle)] = callback;
  return handle;
};

HostTimer.prototype.cancel = function (handle) {
  if (!Number.isSafeInteger(handle) || handle <= 0) {
    throw new TypeError('Timer handle is invalid.');
  }
  delete this.callbacks[String(handle)];
  this.native.cancel(handle);
};

module.exports = { HostTimer: HostTimer };
