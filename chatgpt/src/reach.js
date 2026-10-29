'use strict';

var HOSTS = ['chatgpt.com', 'auth.openai.com'];
// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
var PROBES = [['chatgpt.com', 'https://chatgpt.com/']];
var LAST_KEY = 'chatgpt.blocked.v1';

/** Resolves with the first domain whose request fails, or null once every request has answered. */
function unreachableHost(request) {
  return new Promise(function (resolve) {
    var answered = 0;
    PROBES.forEach(function (probe) {
      Promise.resolve().then(function () { return request(probe[1]); })
        .then(function () { if (++answered === PROBES.length) resolve(null); }, function () { resolve(probe[0]); });
    });
  });
}

/** { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null. */
async function blockedHost(request, query) {
  if (query === undefined) query = (typeof Pebble !== 'undefined' && Pebble.permissions) || null;
  if (query) {
    for (var host of HOSTS) {
      if (await query.query('Internet/' + host) !== 'granted') return { host: host, sure: true };
    }
    return null;
  }
  var unreachable = await unreachableHost(request);
  return unreachable && { host: unreachable, sure: false };
}

async function checkReach(storage, request, query) {
  var blocked = await blockedHost(request, query);
  try {
    if (blocked) storage.setItem(LAST_KEY, JSON.stringify(blocked));
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return blocked;
}

function lastBlocked(storage) {
  try {
    return JSON.parse(storage.getItem(LAST_KEY)) || null;
  } catch (e) {
    return null;
  }
}

/** The declared domain a NotAllowedError's URL falls under, as { host, sure: true }, or null. */
function notAllowedHost(error) {
  var match = error && error.name === 'NotAllowedError' && /^fetch not allowed: https?:\/\/([^/?#:\s]+)/i.exec(String(error.message));
  if (!match) return null;
  var hostname = match[1].toLowerCase();
  for (var host of HOSTS) {
    if (hostname === host || hostname.endsWith('.' + host)) return { host: host, sure: true };
  }
  return null;
}

function blockedMessage(blocked) {
  var host = blocked.host;
  return 'ChatGPT doesn\'t have permission to connect to ' + host + '. Turn on "Connect to ' + host + '" in ChatGPT\'s Permissions' +
    (blocked.sure ? '.' : ', or check your internet connection.');
}

module.exports = { HOSTS: HOSTS, PROBES: PROBES, blockedHost: blockedHost, checkReach: checkReach, lastBlocked: lastBlocked,
  notAllowedHost: notAllowedHost, blockedMessage: blockedMessage };
