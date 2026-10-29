const HOSTS = ["muse.ai", "hatch.metaaivm.com"];
// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
const PROBES = { "muse.ai": "https://muse.ai/api/session", "hatch.metaaivm.com": "https://hatch.metaaivm.com/" };
const LAST_KEY = "muse.blocked.v1";
const permissions = () => (typeof Pebble !== "undefined" && Pebble.permissions) || null;
// Resolves with the first domain whose request fails, or null once every request has answered.
export function unreachableHost(request = (url) => fetch(url)) {
  return new Promise((resolve) => {
    let answered = 0;
    for (const host of HOSTS) {
      Promise.resolve()
        .then(() => request(PROBES[host]))
        .then(() => { if (++answered === HOSTS.length) resolve(null); }, () => resolve(host));
    }
  });
}
// { host, sure }: the first domain not allowed (sure) or not reachable (not sure), or null.
export async function blockedHost(request, query = permissions()) {
  if (query) {
    for (const host of HOSTS) {
      if (await query.query("Internet/" + host) !== "granted") return { host, sure: true };
    }
    return null;
  }
  const host = await unreachableHost(request);
  return host && { host, sure: false };
}
export async function checkReach(storage, request, query) {
  const blocked = await blockedHost(request, query);
  try {
    if (blocked) storage.setItem(LAST_KEY, JSON.stringify(blocked));
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return blocked;
}
export function lastBlocked(storage) {
  try {
    return JSON.parse(storage.getItem(LAST_KEY)) || null;
  } catch (e) {
    return null;
  }
}
export const blockedMessage = ({ host, sure }) =>
  `Muse doesn't have permission to connect to ${host}. Turn on "Connect to ${host}" in Muse's Permissions${sure ? "." : ", or check your internet connection."}`;
