const HOSTS = ['googlehomefoyer-pa.clients6.google.com', 'android.clients.google.com'];
// Apps without Pebble.permissions fail a request to a domain the user hasn't allowed the same way
// as a dead network, so there a failed request is all we know.
const PROBES: Record<string, string> = {
  'googlehomefoyer-pa.clients6.google.com': 'https://googlehomefoyer-pa.clients6.google.com/',
  'android.clients.google.com': 'https://android.clients.google.com/',
};
const LAST_KEY = 'googlehome.blocked.v1';

interface ReachStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Blocked {
  host: string;
  sure: boolean;
}

type Request = (url: string) => Promise<unknown>;

const permissions = (): PebblePermissions | null => (typeof Pebble !== 'undefined' && Pebble.permissions) || null;

/** Resolves with the first domain whose request fails, or null once every request has answered. */
export function unreachableHost(request: Request = (url) => fetch(url)): Promise<string | null> {
  return new Promise((resolve) => {
    let answered = 0;
    for (const host of HOSTS) {
      Promise.resolve()
        .then(() => request(PROBES[host]))
        .then(() => { if (++answered === HOSTS.length) resolve(null); }, () => resolve(host));
    }
  });
}

/** The first domain not allowed (sure) or not reachable (not sure), or null. */
export async function blockedHost(request?: Request, query: PebblePermissions | null = permissions()): Promise<Blocked | null> {
  if (query) {
    for (const host of HOSTS) {
      if ((await query.query(`Internet/${host}`)) !== 'granted') return { host, sure: true };
    }
    return null;
  }
  const host = await unreachableHost(request);
  return host ? { host, sure: false } : null;
}

export async function checkReach(storage: ReachStorage, request?: Request, query?: PebblePermissions | null): Promise<Blocked | null> {
  const blocked = await blockedHost(request, query);
  try {
    if (blocked) storage.setItem(LAST_KEY, JSON.stringify(blocked));
    else storage.removeItem(LAST_KEY);
  } catch (e) {}
  return blocked;
}

export function lastBlocked(storage: ReachStorage): Blocked | null {
  try {
    return JSON.parse(storage.getItem(LAST_KEY) ?? 'null') || null;
  } catch (e) {
    return null;
  }
}

function deniedHost(error: Error): Blocked | null {
  const hostname = /^fetch not allowed: https?:\/\/([^/:?#]+)/.exec(error.message)?.[1]?.toLowerCase();
  const host = hostname && HOSTS.find((domain) => hostname === domain || hostname.endsWith("." + domain));
  return host ? { host, sure: true } : null;
}

// Never waits (probes have no deadline): answers from the last check and starts a new one.
export function failureBlocked(error: unknown, storage: ReachStorage, request?: Request, query?: PebblePermissions | null): Blocked | null {
  if (!(error instanceof Error)) return null;
  const notAllowed = error.name === 'NotAllowedError';
  if (!notAllowed && !(error instanceof TypeError)) return null;
  let cached: Blocked | null = null;
  try {
    cached = lastBlocked(storage);
    checkReach(storage, request, query).catch(() => {});
  } catch {}
  return (notAllowed && deniedHost(error)) || cached;
}

export const blockedMessage = ({ host, sure }: Blocked): string =>
  `Google Home doesn't have permission to connect to ${host}. Turn on "Connect to ${host}" in Google Home's Permissions${sure ? '.' : ', or check your internet connection.'}`;
