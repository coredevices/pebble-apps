const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../src/reach.mjs");
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const permissions = (states) => ({ query: async (key) => states[key] ?? "granted" });

test("with Pebble.permissions, a domain not granted is named for sure, without any request", async () => {
  const { blockedHost, blockedMessage } = await load();
  const request = () => { throw new Error("no request expected"); };
  assert.equal(await blockedHost(request, permissions({})), null);
  assert.deepEqual(await blockedHost(request, permissions({ "Internet/icloud.com": "denied" })), { host: "icloud.com", sure: true });
  assert.deepEqual(await blockedHost(request, permissions({ "Internet/icloud.com": "prompt" })), { host: "icloud.com", sure: true });
  assert.equal(blockedMessage({ host: "icloud.com", sure: true }), 'Apple Notes doesn\'t have permission to connect to icloud.com. Turn on "Connect to icloud.com" in Apple Notes\'s Permissions.');
});

test("without it, an unreachable domain is named as a guess; any HTTP answer counts as reachable", async () => {
  const { blockedHost, blockedMessage } = await load();
  assert.equal(await blockedHost(async () => ({ status: 403 }), null), null);
  assert.deepEqual(await blockedHost(() => Promise.reject(new TypeError("fetch failed")), null), { host: "icloud.com", sure: false });
  assert.match(blockedMessage({ host: "icloud.com", sure: false }), /"Connect to icloud\.com".*or check your internet connection\.$/);
});

test("the first failure wins without waiting for a stalled probe", async () => {
  const { blockedHost } = await load();
  let calls = 0;
  const blocked = await blockedHost(() => (calls++ ? new Promise(() => {}) : Promise.reject(new TypeError("blocked"))), null);
  assert.equal(blocked.host, "icloud.com");
});

test("the last check is remembered until a check finds everything allowed", async () => {
  const { checkReach, lastBlocked } = await load();
  const storage = memory();
  await checkReach(storage, null, permissions({ "Internet/icloud.com": "denied" }));
  assert.deepEqual(lastBlocked(storage), { host: "icloud.com", sure: true });
  await checkReach(storage, null, permissions({}));
  assert.equal(lastBlocked(storage), null);
  storage.setItem("apple-notes.blocked.v1", "icloud.com");
  assert.equal(lastBlocked(storage), null);
});
