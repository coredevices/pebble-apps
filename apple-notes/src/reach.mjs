var HOSTS = ['icloud.com'];
// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
var PROBES = { 'icloud.com': 'https://www.icloud.com/' };
var LAST_KEY = 'apple-notes.blocked.v1';

function permissions() { return (typeof Pebble !== 'undefined' && Pebble.permissions) || null; }

function unreachableHost(request) {
  request = request || function (url) { return fetch(url); };
  return new Promise(function (resolve) {
    var answered = 0;
    HOSTS.forEach(function (host) {
      Promise.resolve()
        .then(function () { return request(PROBES[host]); })
        .then(function () { if (++answered === HOSTS.length) resolve(null); }, function () { resolve(host); });
    });
  });
}

// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
export async function blockedHost(request, query) {
  if (query === undefined) query = permissions();
  if (query) {
    for (var i = 0; i < HOSTS.length; i++) {
      if (await query.query('Internet/' + HOSTS[i]) !== 'granted') return { host: HOSTS[i], sure: true };
    }
    return null;
  }
  var host = await unreachableHost(request);
  return host && { host: host, sure: false };
}

export function checkReach(storage, request, query) {
  return blockedHost(request, query).then(function (blocked) {
    try {
      if (blocked) storage.setItem(LAST_KEY, JSON.stringify(blocked));
      else storage.removeItem(LAST_KEY);
    } catch (e) {}
    return blocked;
  });
}

export function lastBlocked(storage) {
  try {
    return JSON.parse(storage.getItem(LAST_KEY)) || null;
  } catch (e) {
    return null;
  }
}

export function blockedMessage(blocked) {
  return 'Apple Notes doesn\'t have permission to connect to ' + blocked.host + '. Turn on "Connect to ' + blocked.host +
    '" in Apple Notes\'s Permissions' + (blocked.sure ? '.' : ', or check your internet connection.');
}
