// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['icloud.com', 'https://www.icloud.com/']];
var LAST_KEY = 'apple-notes.blocked.v1';

export function blockedHost(request) {
  request = request || function (url) { return fetch(url); };
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve()
        .then(function () { return request(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

export function checkReach(storage, request) {
  return blockedHost(request).then(function (host) {
    try {
      if (host) storage.setItem(LAST_KEY, host);
      else storage.removeItem(LAST_KEY);
    } catch (e) {}
    return host;
  });
}

export function lastBlocked(storage) { return storage.getItem(LAST_KEY); }

export function blockedMessage(host) {
  return 'Apple Notes doesn\'t have permission to connect to ' + host + '. Turn on "Connect to ' + host +
    '" in Apple Notes\'s Permissions, or check your internet connection.';
}
