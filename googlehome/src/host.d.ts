// Globals the Pebble plugin runtime provides. Network goes only through its fetch().

interface HostFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface HostFetchResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface CoreHost {
  /** Resolves to null when this plugin has never stored `key`. */
  secretGet(key: string): Promise<string | null>;
  /** An empty value removes the key. */
  secretSet(key: string, value: string): Promise<void>;
}

declare global {
  interface PebblePermissions {
    /** The plugin's own permission state, e.g. for `Internet/<domain>`; makes no request. */
    query(key: string): Promise<'granted' | 'denied' | 'prompt'>;
  }
  function fetch(url: string, init?: HostFetchInit): Promise<HostFetchResponse>;
  // eslint-disable-next-line no-var
  var coreHost: CoreHost;
  const localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  // The plugin API (see the app repo's test-apps/plugins.md); untyped here.
  const Pebble: any;
  const console: {
    log(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
  };
}

export {};
