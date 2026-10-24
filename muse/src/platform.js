import { MuseError, HTTPError } from "../vendor/musemeow/errors.js";

const REST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_CHARS = 1024 * 1024;

// The host's fetch has no AbortSignal or timeout, so both race the request instead.
export async function rest(origin, cookie, path, body, signal) {
  if (signal.aborted) throw new MuseError("operation aborted");
  const failed = () =>
    new MuseError("Muse connection failed. Sign in again in settings.");
  let onAbort, timer;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(failed());
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(failed()), REST_TIMEOUT_MS);
  });
  interrupted.catch(() => {});
  try {
    const response = await Promise.race([
      fetch(`${origin}/api/hatch/${path}`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: origin,
          Referer: origin + "/",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          "User-Agent": "Mozilla/5.0 musemeow",
        },
        body: JSON.stringify(body),
      }).catch((error) => {
        console.error(`Muse POST /api/hatch/${path} failed: ${error?.message || error}`);
        throw failed();
      }),
      interrupted,
    ]);
    if (response.status !== 200) {
      console.error(`Muse POST /api/hatch/${path} failed: HTTP ${response.status}`);
      throw new HTTPError(path, response.status);
    }
    const text = String(await Promise.race([response.text(), interrupted]));
    if (text.length > MAX_RESPONSE_CHARS)
      throw new MuseError("REST response too large");
    if (path === "vm/wake") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new MuseError("Invalid Muse connection response");
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
