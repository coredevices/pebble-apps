import { test } from "node:test";
import assert from "node:assert/strict";
import { createService, safeError } from "../src/service.js";
function fixture() {
  const data = new Map(),
    calls = [];
  let chats = [
      { session_id: "primary", is_primary: true, can_send: true },
      { session_id: "spanish", title: "Spanish quiz", can_send: true },
      { session_id: "linked", can_send: false },
    ],
    failure;
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
      return chats;
    }
    async sendMain(message) {
      calls.push(["main", message, this.auth.vm_id]);
    }
    async sendToChat(id, message) {
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
    setChats: (v) => (chats = v),
    fail: (e) => (failure = e),
  };
}
test("new account defaults to main and filters linked chats", async () => {
  const f = fixture(),
    r = await f.connect();
  assert.equal(r.selected, "main");
  assert.deepEqual(r.chats, [{ id: "spanish", title: "Spanish quiz" }]);
  await f.service.action({
    action: "send_to_muse",
    args: { message: "Hola!" },
  });
  assert.deepEqual(f.calls.at(-2), ["main", "Hola!", "vm-one"]);
  assert.equal(f.calls.at(-1), "close");
});
test("selection persists; vanished chat never falls back to main", async () => {
  const f = fixture();
  await f.connect();
  await f.service.config({ type: "selectChat", id: "spanish" });
  await f.service.action({
    action: "send_to_muse",
    args: { message: "Quiz me" },
  });
  assert.deepEqual(f.calls.at(-2), ["spanish", "Quiz me", "vm-one"]);
  assert.equal((await f.connect()).selected, "spanish");
  f.setChats([]);
  const count = f.calls.filter(Array.isArray).length;
  await assert.rejects(
    f.service.action({
      action: "send_to_muse",
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
    f.service.action({ action: "send_to_muse", args: { message: "hi" } }),
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
      f.service.action({ action: "send_to_muse", args: { message } }),
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
    f.service.action({ action: "send_to_muse", args: { message: "hi" } }),
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
  await f.service.action({ action: "send_to_muse", args: { message: "hi" } });
  assert.deepEqual(f.calls.find((c) => Array.isArray(c)), ["main", "hi", "vm-two"]);
});
