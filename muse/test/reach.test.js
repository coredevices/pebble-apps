import test from "node:test";
import assert from "node:assert/strict";
import { blockedHost, blockedMessage, checkReach, lastBlocked } from "../src/reach.js";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const permissions = (states) => ({ query: async (key) => states[key] ?? "granted" });

test("with Pebble.permissions, the first domain not granted is named for sure, without any request", async () => {
  const request = () => { throw new Error("no request expected"); };
  assert.equal(await blockedHost(request, permissions({})), null);
  assert.deepEqual(await blockedHost(request, permissions({ "Internet/hatch.metaaivm.com": "denied" })), { host: "hatch.metaaivm.com", sure: true });
  assert.deepEqual(await blockedHost(request, permissions({ "Internet/muse.ai": "prompt" })), { host: "muse.ai", sure: true });
  assert.equal(blockedMessage({ host: "muse.ai", sure: true }), 'Muse doesn\'t have permission to connect to muse.ai. Turn on "Connect to muse.ai" in Muse\'s Permissions.');
});

test("without it, a domain that can't be reached is named as a guess; any HTTP answer counts as reachable", async () => {
  assert.equal(await blockedHost(async () => ({ status: 401 }), null), null);
  assert.deepEqual(await blockedHost(async (url) => {
    if (url.includes("metaaivm")) throw new TypeError("fetch failed: " + url);
    return { status: 401 };
  }, null), { host: "hatch.metaaivm.com", sure: false });
  assert.match(blockedMessage({ host: "muse.ai", sure: false }), /"Connect to muse\.ai".*or check your internet connection\.$/);
});

test("a blocked domain is reported without waiting for a stalled one", async () => {
  const blocked = await blockedHost((url) => url.includes("metaaivm") ? new Promise(() => {}) : Promise.reject(new TypeError("blocked")), null);
  assert.equal(blocked.host, "muse.ai");
});

test("the last check is remembered until a check finds everything allowed", async () => {
  const storage = memory();
  await checkReach(storage, null, permissions({ "Internet/muse.ai": "denied" }));
  assert.deepEqual(lastBlocked(storage), { host: "muse.ai", sure: true });
  await checkReach(storage, null, permissions({}));
  assert.equal(lastBlocked(storage), null);
  storage.setItem("muse.blocked.v1", "muse.ai");
  assert.equal(lastBlocked(storage), null);
});
