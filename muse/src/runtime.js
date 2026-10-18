// JavaScriptCore has no DOM AbortController. Only this bundle uses these minimal signals.
export class AbortController {
  constructor() {
    const listeners = new Set();
    this.signal = {
      aborted: false,
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
    };
    this.abort = () => {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      for (const fn of listeners) fn();
      listeners.clear();
    };
  }
}
if (!Object.hasOwn)
  Object.hasOwn = (object, key) =>
    Object.prototype.hasOwnProperty.call(object, key);
export class TextEncoder {
  encode(value = "") {
    return new Uint8Array(Buffer.from(String(value), "utf8"));
  }
}
export class TextDecoder {
  constructor(_, options = {}) {
    this.fatal = options.fatal;
    this.ignoreBOM = options.ignoreBOM;
  }
  decode(value = new Uint8Array()) {
    const bytes = Buffer.from(value),
      text = bytes.toString("utf8");
    if (this.fatal && !Buffer.from(text, "utf8").equals(bytes))
      throw new TypeError("Invalid UTF-8");
    return !this.ignoreBOM && text.charCodeAt(0) === 0xfeff
      ? text.slice(1)
      : text;
  }
}

// Plugin engines may expose native timers instead of browser/Node timer globals. Timers here only
// bound how long a request may take, so without them they never fire and the host's own action
// limit applies instead.
const hostTimer = typeof _HostTimer === "undefined" ? null : _HostTimer;
const timers = new Map();
let nextTimer = 0;
globalThis.__hostTimerDispatch = (id) => {
  const callback = timers.get(id);
  timers.delete(id);
  callback?.();
};
export function setTimeout(callback, delay = 0, ...args) {
  const milliseconds = Math.max(1, Math.min(86400000, Math.trunc(Number(delay)) || 1));
  if (!hostTimer) return --nextTimer;
  const id = hostTimer.schedule(milliseconds);
  timers.set(id, () => callback(...args));
  return id;
}
export function clearTimeout(id) {
  if (!timers.delete(id)) return;
  hostTimer.cancel(id);
}
