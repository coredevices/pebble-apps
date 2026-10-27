const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// Plugins get no timers, and Android's lockdown makes touching setTimeout throw.
function load() {
  const module = { exports: {} };
  const context = { module, Date, Math, JSON, Promise, encodeURIComponent };
  Object.defineProperty(context, "setTimeout", { get() { throw new Error("setTimeout is not available to plugins"); } });
  vm.runInNewContext(readFileSync(path.join(__dirname, "..", "src", "plugin", "index.js"), "utf8"), context);
  return module.exports;
}

test("loads and answers sign-in where touching setTimeout throws", async () => {
  const { createService } = load();
  const fetch = async () => ({ status: 404, json: async () => ({}) });
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const result = await createService(storage, fetch)
    .config({ type: "finishSignIn", uuid: "123e4567-e89b-42d3-a456-426614174000", verifier: "v".repeat(43) });
  assert.equal(result.pending, true);
});
