import { test } from "node:test";
import assert from "node:assert/strict";
import { createService, safeError } from "../src/service.js";
function fixture() {
  const data = new Map(),
    cache = new Map(),
    calls = [];
  let chats = [
      { session_id: "primary", is_primary: true, can_send: true },
      { session_id: "spanish", title: "Spanish quiz", can_send: true },
      { session_id: "linked", can_send: false },
    ],
    failure,
    clock = 0,
    onList = () => {},
    onLookup = () => {},
    cacheFails = false;
  class Client {
    constructor(auth) {
      this.auth = auth;
    }
    async connect() {
      calls.push("connect");
      if (failure) throw failure;
    }
    close() {
      calls.push("close");
    }
    async listChats() {
      calls.push("list");
      const result = chats;
      await onList();
      return result;
    }
    async sendMain(message, options) {
      options?.beforeSend?.();
      calls.push(["main", message, this.auth.vm_id]);
    }
    async sendToChat(id, message, options) {
      await onLookup();
      options?.beforeSend?.();
      calls.push([id, message, this.auth.vm_id]);
    }
  }
  const service = createService(
    {
      getItem: (k) => data.get(k),
      setItem: (k, v) => data.set(k, v),
      removeItem: (k) => data.delete(k),
    },
    Client,
    () => clock,
    {
      getItem: (k) => cache.get(k) ?? null,
      setItem: (k, v) => {
        if (cacheFails) throw new Error("quota");
        cache.set(k, v);
      },
      removeItem: (k) => cache.delete(k),
    },
  );
  const connect = (vm) =>
    service.config({
      type: "connect",
      session: { cookie: "hatch_sess=test", vm_id: vm || "vm-one" },
    });
  return {
    service,
    calls,
    connect,
    data,
    cache,
    failCache: () => (cacheFails = true),
    onLookup: (fn) => (onLookup = fn),
    setChats: (v) => (chats = v),
    onList: (fn) => (onList = fn),
    tick: (ms) => (clock += ms),
    fail: (e) => (failure = e),
  };
}
test("new account defaults to main and filters linked chats", async () => {
  const f = fixture(),
    r = await f.connect();
  assert.equal(r.selected, "main");
  assert.deepEqual(r.chats, [{ id: "spanish", title: "Spanish quiz" }]);
  await f.service.action({
    action: "send_to_agent",
    args: { message: "Hola!" },
  });
  assert.deepEqual(f.calls.at(-2), ["main", "Hola! ⌚", "vm-one"]);
  assert.equal(f.calls.at(-1), "close");
});
test("selection persists; vanished chat never falls back to main", async () => {
  const f = fixture();
  await f.connect();
  await f.service.config({ type: "selectChat", id: "spanish" });
  await f.service.action({
    action: "send_to_agent",
    args: { message: "Quiz me" },
  });
  assert.deepEqual(f.calls.at(-2), ["spanish", "Quiz me ⌚", "vm-one"]);
  assert.equal((await f.connect()).selected, "spanish");
  f.setChats([]);
  const count = f.calls.filter(Array.isArray).length;
  await assert.rejects(
    f.service.action({
      action: "send_to_agent",
      args: { message: "No fallback" },
    }),
    /unavailable/,
  );
  assert.equal(f.calls.filter(Array.isArray).length, count);
});
test("switching accounts resets destination; disconnect removes credentials", async () => {
  const f = fixture();
  await f.connect();
  await f.service.config({ type: "selectChat", id: "spanish" });
  assert.equal((await f.connect("vm-two")).selected, "main");
  await f.service.config({ type: "disconnect" });
  await assert.rejects(
    f.service.action({ action: "send_to_agent", args: { message: "hi" } }),
    /Sign in/,
  );
});
test("invalid actions, messages and read-only selections fail", async () => {
  const f = fixture();
  await f.connect();
  await assert.rejects(
    f.service.config({ type: "selectChat", id: "linked" }),
    /no longer available/,
  );
  for (const message of ["", " ", null, "x".repeat(16001)])
    await assert.rejects(
      f.service.action({ action: "send_to_agent", args: { message } }),
      /Provide a message/,
    );
  await assert.rejects(
    f.service.action({ action: "history", args: { message: "hi" } }),
    /Unknown/,
  );
});
test("failure closes connection without retries or secret disclosure", async () => {
  const f = fixture();
  await f.connect();
  f.calls.length = 0;
  f.fail(new Error("secret cookie and URL"));
  await assert.rejects(
    f.service.action({ action: "send_to_agent", args: { message: "hi" } }),
  );
  assert.deepEqual(f.calls, ["connect", "close"]);
  assert.equal(
    safeError(new Error("secret cookie and URL")).message.includes("secret"),
    false,
  );
  assert.equal(safeError({ status: 401 }).code, "AUTH_REQUIRED");
});
test("a cookie-only sign-in asks Muse for the account's VM", async () => {
  const f = fixture();
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([url, init.headers.Cookie]);
    return { status: 200, json: async () => ({ vm_id: "vm-two" }) };
  };
  try {
    await f.service.config({ type: "connect", session: { cookie: "hatch_sess=test" } });
  } finally {
    delete globalThis.fetch;
  }
  assert.deepEqual(seen, [["https://muse.ai/api/session", "hatch_sess=test"]]);
  await f.service.action({ action: "send_to_agent", args: { message: "hi" } });
  assert.deepEqual(f.calls.find((c) => Array.isArray(c)), ["main", "hi ⌚", "vm-two"]);
});
test("chat_id resolves by id, name or Main chat; ambiguous and unknown names fail", async () => {
  const f = fixture();
  await f.connect();
  f.setChats([
    { session_id: "primary", is_primary: true, can_send: true },
    { session_id: "spanish", title: "Spanish quiz", can_send: true },
    { session_id: "french", title: "French quiz", can_send: true },
  ]);
  await f.service.config({ type: "selectChat", id: "spanish" });
  const send = (chat_id) =>
    f.service.action({ action: "send_to_agent", args: { message: "hi", chat_id } });
  await send("french");
  assert.deepEqual(f.calls.at(-2), ["french", "hi ⌚", "vm-one"]);
  await send("SPANISH QUIZ");
  assert.deepEqual(f.calls.at(-2), ["spanish", "hi ⌚", "vm-one"]);
  await send("fren");
  assert.deepEqual(f.calls.at(-2), ["french", "hi ⌚", "vm-one"]);
  await send("Main chat");
  assert.deepEqual(f.calls.at(-2), ["main", "hi ⌚", "vm-one"]);
  await send(null);
  assert.deepEqual(f.calls.at(-2), ["spanish", "hi ⌚", "vm-one"]);
  const count = f.calls.filter(Array.isArray).length;
  await assert.rejects(send("quiz"), /Multiple/);
  await assert.rejects(send("german"), /No Muse chat/);
  await assert.rejects(send(42), /Name a Muse chat/);
  assert.equal(f.calls.filter(Array.isArray).length, count);
});
test("agent sources report setup state and list Main chat plus writable chats", async () => {
  const f = fixture();
  const configured = async () =>
    (await f.service.source({ category: "agent", item: "configured" })).instances[0].properties;
  assert.equal((await configured()).configured.boolean.value, false);
  await assert.rejects(f.service.source({ category: "agent", item: "chats" }), /Sign in/);
  await f.connect();
  assert.equal((await configured()).configured.boolean.value, true);
  assert.equal((await configured()).name.shortText.text, "Main chat");
  await f.service.config({ type: "selectChat", id: "spanish" });
  assert.equal((await configured()).name.shortText.text, "Spanish quiz");
  const chats = await f.service.source({ category: "agent", item: "chats" });
  assert.deepEqual(
    chats.instances.map((i) => [i.instanceId, i.properties.name.shortText.text]),
    [["main", "Main chat"], ["spanish", "Spanish quiz"]],
  );
  await assert.rejects(f.service.source({ category: "notes", item: "configured" }), /Unsupported/);
});
const flush = () => new Promise((r) => setImmediate(r));
const chatIds = async (f) =>
  (await f.service.source({ category: "agent", item: "chats" })).instances.map((i) => i.instanceId);
test("agent/chats serves a fresh cache, relists a stale one, and falls back on failure", async () => {
  const f = fixture();
  await f.connect();
  const lists = () => f.calls.filter((c) => c === "list").length;
  f.setChats([{ session_id: "french", title: "French quiz", can_send: true }]);
  f.tick(299999);
  const before = lists();
  assert.deepEqual(await chatIds(f), ["main", "spanish"]);
  assert.equal(lists(), before);
  f.tick(1);
  assert.deepEqual(await chatIds(f), ["main", "french"]);
  assert.equal(lists(), before + 1);
  assert.equal(JSON.parse(f.cache.get("muse.chats.v1")).fetchedAt, 300000);
  f.tick(300000);
  f.fail(new Error("offline"));
  assert.deepEqual(await chatIds(f), ["main", "french"]);
  f.cache.clear();
  assert.deepEqual(await chatIds(f), ["main"]);
  f.fail(null);
  f.setChats([]);
  await f.service.config({ type: "listChats" });
  assert.deepEqual(JSON.parse(f.cache.get("muse.chats.v1")).chats, []);
});
test("a listing never overwrites a newer cache or one for another sign-in", async () => {
  const f = fixture();
  await f.connect();
  f.tick(300000);
  let release;
  f.onList(() => new Promise((r) => (release = r)));
  f.setChats([{ session_id: "old", title: "Old", can_send: true }]);
  const stale = chatIds(f);
  await flush();
  const late = release;
  f.tick(1000);
  f.onList(() => {});
  f.setChats([{ session_id: "new", title: "New", can_send: true }]);
  await f.service.config({ type: "listChats" });
  late();
  assert.deepEqual(await stale, ["main", "old"]);
  assert.deepEqual(JSON.parse(f.cache.get("muse.chats.v1")).chats, [{ id: "new", title: "New" }]);
  f.tick(300000);
  f.onList(() => new Promise((r) => (release = r)));
  const pending = chatIds(f);
  await flush();
  await f.service.config({ type: "disconnect" });
  assert.equal(f.cache.size, 0);
  release();
  await pending;
  assert.equal(f.cache.size, 0);
});
test("a failed cache write never changes a send receipt or a source read", async () => {
  const f = fixture();
  await f.connect();
  f.failCache();
  const writes = f.data.size;
  const result = await f.service.action({
    action: "send_to_agent",
    args: { message: "hi", chat_id: "Spanish quiz" },
  });
  assert.equal(result.text, "Message accepted by Muse.");
  assert.deepEqual(f.calls.at(-2), ["spanish", "hi ⌚", "vm-one"]);
  assert.equal(f.data.size, writes);
  f.cache.clear();
  assert.deepEqual(await chatIds(f), ["main", "spanish"]);
});
test("a stalled chat listing doesn't block sends or sign-out", async () => {
  const f = fixture();
  await f.connect();
  f.tick(300000);
  f.onList(() => new Promise(() => {}));
  chatIds(f);
  await flush();
  await f.service.action({ action: "send_to_agent", args: { message: "hi" } });
  assert.deepEqual(f.calls.at(-2), ["main", "hi ⌚", "vm-one"]);
  assert.equal((await f.service.config({ type: "disconnect" })).configured, false);
});
test("a send is refused, not attempted, once the time budget is too short", async () => {
  const f = fixture();
  await f.connect();
  await f.service.config({ type: "selectChat", id: "spanish" });
  const sends = () => f.calls.filter(Array.isArray).length;
  const notSent = (e) => e.code === "PLUGIN_UNAVAILABLE" && /not sent/.test(e.message);
  f.onList(() => f.tick(11000));
  await assert.rejects(
    f.service.action({ action: "send_to_agent", args: { message: "late" } }),
    notSent,
  );
  assert.equal(sends(), 0);
  f.onList(() => f.tick(5000));
  f.onLookup(() => f.tick(6000));
  await assert.rejects(
    f.service.action({ action: "send_to_agent", args: { message: "late" } }),
    notSent,
  );
  assert.equal(sends(), 0);
  f.onLookup(() => f.tick(4000));
  await f.service.action({ action: "send_to_agent", args: { message: "ok" } });
  assert.equal(sends(), 1);
});
