// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
const PROBES = [
  ["muse.ai", "https://muse.ai/api/session"],
  ["hatch.metaaivm.com", "https://hatch.metaaivm.com/"],
];
const LAST_KEY = "muse.blocked.v1";
// Resolves with the first domain whose request fails, or null once every request has answered.
export function blockedHost(request = (url) => fetch(url)) {
  return new Promise((resolve) => {
    let answered = 0;
    for (const [host, url] of PROBES) {
      Promise.resolve()
        .then(() => request(url))
        .then(() => { if (++answered === PROBES.length) resolve(null); }, () => resolve(host));
    }
  });
}
export async function checkReach(storage, request) {
  const host = await blockedHost(request);
  try {
    if (host) storage.setItem(LAST_KEY, host);
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return host;
}
export const lastBlocked = (storage) => storage.getItem(LAST_KEY);
export const blockedMessage = (host) =>
  `Muse doesn't have permission to connect to ${host}. Turn on "Connect to ${host}" in Muse's Permissions, or check your internet connection.`;
