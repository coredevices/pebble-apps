import test from "node:test";
import assert from "node:assert/strict";
import { blockedHost, blockedMessage, checkReach, lastBlocked } from "../src/reach.js";

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };

test("a domain that can't be reached is named; any HTTP answer counts as reachable", async () => {
  assert.equal(await blockedHost(async () => ({ status: 401 })), null);
  assert.equal(await blockedHost(async (url) => {
    if (url.includes("metaaivm")) throw new TypeError("fetch failed: " + url);
    return { status: 401 };
  }), "hatch.metaaivm.com");
  assert.match(blockedMessage("muse.ai"), /permission to connect to muse\.ai.*"Connect to muse\.ai".*internet connection/);
});

test("a blocked domain is reported without waiting for a stalled one", async () => {
  const host = await blockedHost((url) => url.includes("metaaivm") ? new Promise(() => {}) : Promise.reject(new TypeError("blocked")));
  assert.equal(host, "muse.ai");
});

test("the last check is remembered until a check finds everything reachable", async () => {
  const storage = memory();
  await checkReach(storage, () => Promise.reject(new TypeError("blocked")));
  assert.equal(lastBlocked(storage), "muse.ai");
  await checkReach(storage, async () => ({ status: 200 }));
  assert.equal(lastBlocked(storage), null);
});
