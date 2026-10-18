'use strict';

// Plugin state lives in one Pebble.secureStorage entry. It is read once per session and each
// session writes back only the keys it changed, merged into a fresh read, before it responds; that
// keeps the synchronous Storage-shaped API the runtime expects, and a session that started before a
// disconnect can't write the old state back once that disconnect has landed.
// ponytail: two sessions flushing at the same instant can still lose one side's change; needs a
// host-side compare-and-set on secureStorage to close.
function SecureBlobStorage(secureStorage, key) {
  var self = this;
  this.secure = secureStorage;
  this.key = key;
  this.values = {};
  this.changes = {};
  this.writing = Promise.resolve();
  this.loaded = Promise.resolve(secureStorage.getItem(key)).then(function (raw) {
    self.values = parse(raw);
  });
}

function parse(raw) {
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

SecureBlobStorage.prototype.getItem = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};

SecureBlobStorage.prototype.setItem = function (key, value) {
  this.values[key] = String(value);
  this.changes[key] = String(value);
};

SecureBlobStorage.prototype.removeItem = function (key) {
  delete this.values[key];
  this.changes[key] = null;
};

/** Lands this session's changes; a failure keeps them for the next flush and rejects this one. */
SecureBlobStorage.prototype.flush = function () {
  var self = this;
  var write = this.writing.then(function () {
    var changes = self.changes;
    if (!Object.keys(changes).length) return undefined;
    self.changes = {};
    return Promise.resolve(self.secure.getItem(self.key)).then(function (raw) {
      var merged = parse(raw);
      Object.keys(changes).forEach(function (name) {
        if (changes[name] === null) delete merged[name];
        else merged[name] = changes[name];
      });
      return self.secure.setItem(self.key, JSON.stringify(merged));
    }).catch(function (error) {
      Object.keys(changes).forEach(function (name) {
        if (!Object.prototype.hasOwnProperty.call(self.changes, name)) self.changes[name] = changes[name];
      });
      throw error;
    });
  });
  this.writing = write.catch(function () {});
  return write;
};

module.exports = { SecureBlobStorage: SecureBlobStorage };
