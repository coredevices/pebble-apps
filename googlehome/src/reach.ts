// The host fails a request to a domain the user hasn't allowed the same way as a dead network.
const PROBES: [string, string][] = [
  ['googlehomefoyer-pa.clients6.google.com', 'https://googlehomefoyer-pa.clients6.google.com/'],
  ['android.clients.google.com', 'https://android.clients.google.com/'],
];
const LAST_KEY = 'googlehome.blocked.v1';

interface ReachStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolves with the first domain whose request fails, or null once every request has answered. */
export function blockedHost(request: (url: string) => Promise<unknown> = (url) => fetch(url)): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = 0;
    for (const [host, url] of PROBES) {
      Promise.resolve()
        .then(() => request(url))
        .then(() => { if (++answered === PROBES.length) resolve(null); }, () => resolve(host));
    }
  });
}

export async function checkReach(storage: ReachStorage, request?: (url: string) => Promise<unknown>): Promise<string | null> {
  const host = await blockedHost(request);
  try {
    if (host) storage.setItem(LAST_KEY, host);
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return host;
}

export const lastBlocked = (storage: ReachStorage): string | null => storage.getItem(LAST_KEY);

export const blockedMessage = (host: string): string =>
  `GoogleHome doesn't have permission to connect to ${host}. Turn on "Connect to ${host}" in GoogleHome's Permissions, or check your internet connection.`;
