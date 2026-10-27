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

// Plugins get no timers (Android blocks setTimeout, iOS has none), so timers here never fire and the
// host's own action limit bounds how long a request may take.
export function setTimeout() {
  return 0;
}
export function clearTimeout() {}
