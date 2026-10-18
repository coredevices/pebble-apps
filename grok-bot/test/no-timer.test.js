const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// Stock CoreApp: no _HostTimer, and Android's lockdown makes touching setTimeout throw.
function load() {
  const module = { exports: {} };
  const context = { module, Date, Math, JSON, Promise, encodeURIComponent };
  Object.defineProperty(context, "setTimeout", { get() { throw new Error("setTimeout is not available to plugins"); } });
  vm.runInNewContext(readFileSync(path.join(__dirname, "..", "plugin.js"), "utf8"), context);
  return module.exports;
}

test("sign-in polling works without host timers", async () => {
  const { createService, safeError } = load();
  let polls = 0;
  const fetch = async (url) => {
    if (url.startsWith("https://api2.cursor.sh/auth/poll")) {
      return ++polls < 3 ? { status: 404, json: async () => ({}) } : { status: 200, json: async () => ({ accessToken: "t" }) };
    }
    return { ok: false, status: 401, text: async () => "{}" };
  };
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const err = await createService(storage, fetch)
    .config({ type: "finishSignIn", uuid: "123e4567-e89b-42d3-a456-426614174000", verifier: "v".repeat(43) })
    .catch((e) => e);
  assert.equal(polls, 3);
  assert.equal(safeError(err).code, "AUTH_REQUIRED");
});
