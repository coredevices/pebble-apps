'use strict';

// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
var PROBES = [['chatgpt.com', 'https://chatgpt.com/']];
var LAST_KEY = 'chatgpt.blocked.v1';

/** Resolves with the first domain whose request fails, or null once every request has answered. */
function blockedHost(request) {
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve().then(function () { return request(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

async function checkReach(storage, request) {
  var host = await blockedHost(request);
  try {
    if (host) storage.setItem(LAST_KEY, host);
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return host;
}

function lastBlocked(storage) {
  return storage.getItem(LAST_KEY);
}

function blockedMessage(host) {
  return 'ChatGPT doesn\'t have permission to connect to ' + host + '. Turn on "Connect to ' + host + '" in ChatGPT\'s Permissions, or check your internet connection.';
}

module.exports = { PROBES: PROBES, blockedHost: blockedHost, checkReach: checkReach, lastBlocked: lastBlocked, blockedMessage: blockedMessage };
