'use strict';
// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['google.com', 'https://www.google.com/']];
var LAST_KEY = 'location-sharing.blocked.v1';

function blockedHost(request) {
  request = request || function(url) { return fetch(url); };
  return new Promise(function(resolve) {
    var answered = 0;
    PROBES.forEach(function(probe) {
      Promise.resolve()
        .then(function() { return request(probe[1]); })
        .then(function() { if (++answered === PROBES.length) resolve(null); }, function() { resolve(probe[0]); });
    });
  });
}

function checkReach(storage, request) {
  return blockedHost(request).then(function(host) {
    try {
      if (host) storage.setItem(LAST_KEY, host);
      else storage.removeItem(LAST_KEY);
    } catch (e) {}
    return host;
  });
}

function lastBlocked(storage) { return storage.getItem(LAST_KEY); }

function blockedMessage(host) {
  return 'Location Sharing doesn\'t have permission to connect to ' + host + '. Turn on "Connect to ' + host +
    '" in Location Sharing\'s Permissions, or check your internet connection.';
}

module.exports = { blockedHost, checkReach, lastBlocked, blockedMessage };
