import { test } from "node:test";
import assert from "node:assert/strict";
import { secureCache } from "../src/secure-cache.js";

function host({ failSet = false } = {}) {
  const log = [], store = new Map([["tok", "old"]]), handlers = {};
  let writes = 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  globalThis.Pebble = {
    secureStorage: {
      getItem: async (k) => (store.has(k) ? store.get(k) : null),
      // The first write is the slowest, so writes that weren't serialized would land out of order.
      setItem: async (k, v) => { await delay(writes++ === 0 ? 20 : 1); if (failSet) throw new Error("keystore"); store.set(k, v); log.push(`set ${v}`); },
      removeItem: async (k) => { await delay(writes++ === 0 ? 20 : 1); store.delete(k); log.push("rm"); },
    },
    registerConfigHandler: (fn) => (handlers.config = fn),
    registerActionHandler: (fn) => (handlers.action = fn),
    registerSourceHandler: (fn) => (handlers.source = fn),
  };
  const cache = secureCache(["tok"]);
  Pebble.registerConfigHandler((m, respond) => {
    const old = cache.getItem("tok");
    cache.removeItem("tok");
    cache.setItem("tok", "new:" + old);
    respond({ seen: old });
  });
  return { log, store, handlers, cache };
}

test("writes land in order before the plugin responds", async () => {
  const { log, store, handlers } = host();
  const reply = await new Promise((r) => handlers.config({}, (v) => { log.push("respond"); r(v); }));
  assert.equal(reply.seen, "old");
  assert.deepEqual(log, ["rm", "set new:old", "respond"]);
  assert.equal(store.get("tok"), "new:old");
});

test("a failed write still answers, with an error", async () => {
  const { handlers } = host({ failSet: true });
  const reply = await new Promise((r) => handlers.config({}, r));
  assert.match(reply.error, /Could not save/);
});

test("a failed write reloads what storage actually holds", async () => {
  const { store, handlers, cache } = host({ failSet: true });
  await new Promise((r) => handlers.config({}, r));
  assert.equal(store.has("tok"), false);
  assert.equal(cache.getItem("tok"), null);
});
