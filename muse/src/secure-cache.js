// Credentials live in Pebble.secureStorage, which is async, while this plugin reads them
// synchronously: they are loaded once per session (and again after a failed write), and writes land,
// in order, before it responds.
export function secureCache(SECURE_KEYS) {
  var values = {};
  var writing = Promise.resolve();
  var failure = null;
  var SAVE_FAILED = 'Could not save this plugin\'s credentials. Try again.';
  function load() {
    return Promise.all(SECURE_KEYS.map(function (key) {
      return Pebble.secureStorage.getItem(key).then(function (value) { values[key] = value; });
    }));
  }
  var loaded = load();
  function enqueue(write) {
    writing = writing.then(write).catch(function (error) { failure = failure || error; });
  }
  function flush() {
    return writing.then(function () {
      var error = failure;
      failure = null;
      if (!error) return undefined;
      var rethrow = function () { throw error; };
      return load().then(rethrow, rethrow);
    });
  }
  function after(fn, onFailure) {
    return function () {
      var args = arguments;
      return flush().then(function () { return fn.apply(null, args); }, function () { return onFailure(args); });
    };
  }
  function wrap(name, wrapResponder, fail) {
    var register = Pebble[name];
    Pebble[name] = function (handler) {
      register(function (request, respond) {
        var responder = wrapResponder(respond);
        return loaded.then(function () { return handler(request, responder); }, function () { return fail(respond); });
      });
    };
  }
  wrap('registerActionHandler', function (r) {
    var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
    return { ok: after(r.ok, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
  }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
  wrap('registerSourceHandler', function (r) {
    var failed = function () { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); };
    return { data: after(r.data, failed), error: after(r.error, function (args) { return r.error.apply(null, args); }) };
  }, function (r) { return r.error('PLUGIN_UNAVAILABLE', SAVE_FAILED); });
  wrap('registerConfigHandler', function (r) {
    return after(r, function () { return r({ error: SAVE_FAILED }); });
  }, function (r) { return r({ error: SAVE_FAILED }); });
  return {
    has: function (key) { return SECURE_KEYS.indexOf(key) !== -1; },
    getItem: function (key) { return values[key] === undefined ? null : values[key]; },
    setItem: function (key, value) {
      values[key] = String(value);
      enqueue(function () { return Pebble.secureStorage.setItem(key, String(value)); });
    },
    removeItem: function (key) {
      values[key] = null;
      enqueue(function () { return Pebble.secureStorage.removeItem(key); });
    },
  };
}
