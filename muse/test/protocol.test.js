import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";
const built = await build({
  stdin: {
    contents:
      "export {SymmetricState,keypair,dh} from './vendor/musemeow/noise.js'; export {FrameDecoder,framePayload} from './vendor/musemeow/transport.js'; export {encode,decode} from './vendor/musemeow/wire.js';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
});
const module = { exports: {} };
vm.runInNewContext(built.outputFiles[0].text, {
  module,
  exports: module.exports,
  require: createRequire(import.meta.url),
  Buffer,
  TextDecoder,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  DataView,
});
const {
  SymmetricState,
  keypair,
  dh,
  FrameDecoder,
  framePayload,
  encode,
  decode,
} = module.exports;
function fixture({ drop = false, rv = false, failOpens = 0, slowClock = false } = {}) {
  const logs = [];
  let clock = Date.now();
  let opens = 0;
  let failWrites = false;
  let config,
    action,
    next = 0,
    sends = 0,
    mints = 0;
  const data = new Map(),
    sockets = new Map(),
    failures = [];
  const chats = [
    {
      session_id: "primary",
      title: "Main",
      status: "active",
      is_primary: true,
      is_thread: false,
    },
    {
      session_id: "quiz",
      title: "Spanish",
      status: "active",
      is_primary: false,
      is_thread: true,
    },
  ];
  const instances = new Map();
  const dispatch = (id, event) =>
    queueMicrotask(() => {
      const ws = instances.get(id);
      if (!ws) return;
      if (event.type !== "message") return ws["on" + event.type]?.({});
      const b = Buffer.from(event.data, "base64");
      ws.onmessage?.({ data: b.buffer.slice(b.byteOffset, b.byteOffset + b.length) });
    });
  const fetchStub = async (url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Cookie, "hatch_sess=fixture");
    assert.equal(init.headers["Sec-Fetch-Site"], "same-origin");
    if (url.endsWith("/token")) mints++;
    const text = JSON.stringify(
      url.endsWith("/token") ? { token: "one-use-" + mints } : {},
    );
    return { status: 200, text: async () => text };
  };
  const context = vm.createContext({
    console: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    // Every clock read moves 3 s on, so each connect attempt looks slow.
    ...(slowClock && { Date: class extends Date { static now() { return (clock += 3000); } } }),
    fetch: fetchStub,
    Pebble: {
      secureStorage: {
        getItem: async (k) => (data.has(k) ? data.get(k) : null),
        setItem: async (k, v) => {
          if (failWrites) throw new Error("keystore");
          data.set(k, v);
        },
        removeItem: async (k) => { data.delete(k); },
      },
      registerActionHandler: (fn) => (action = fn),
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: () => {},
    },
    crypto: { getRandomValues: (array) => crypto.getRandomValues(array) },
    WebSocket: class {
      constructor(url) {
        this.id = hostSocket.open(url);
        instances.set(this.id, this);
      }
      send(data) {
        hostSocket.send(this.id, Buffer.from(data).toString("base64"));
      }
      close() {
        hostSocket.close(this.id);
      }
    },
  });
  const hostSocket = {
      open(url) {
        assert.equal(
          new URL(url).searchParams.get("auth_token"),
          "one-use-" + mints,
        );
        const id = ++next;
        sockets.set(id, {
          s: new SymmetricState(),
          e: keypair(),
          k: keypair(),
          phase: 0,
          decoder: new FrameDecoder(),
        });
        dispatch(id, { type: ++opens <= failOpens ? "error" : "open" });
        return id;
      },
      send(id, base64) {
        try {
          const c = sockets.get(id),
            b = Buffer.from(base64, "base64");
          const emit = (b) =>
            dispatch(id, {
              type: "message",
              binary: true,
              data: b.toString("base64"),
            });
          if (c.phase === 0) {
            c.re = b.subarray(0, 32);
            c.s.mixHash(c.re);
            assert.equal(
              decode("ClientHello", c.s.decryptAndHash(b.subarray(32)))
                .clientNonce.length,
              32,
            );
            c.s.mixHash(c.e.publicKey);
            c.s.mixKey(dh(c.e, c.re));
            const sk = c.s.encryptAndHash(c.k.publicKey);
            c.s.mixKey(dh(c.k, c.re));
            emit(
              Buffer.concat([
                c.e.publicKey,
                sk,
                c.s.encryptAndHash(
                  rv
                    ? encode("RVChallenge", {
                        state: 2,
                        vmNonce: Buffer.alloc(32),
                      })
                    : Buffer.alloc(0),
                ),
              ]),
            );
            c.phase = 1;
            return;
          }
          if (c.phase === 1) {
            const remote = c.s.decryptAndHash(b.subarray(0, 48));
            c.s.mixKey(dh(c.e, remote));
            assert.equal(c.s.decryptAndHash(b.subarray(48)).length, 0);
            [c.receive, c.send] = c.s.split();
            c.phase = 2;
            return;
          }
          const payload = c.decoder.decode(c.receive.decrypt(b));
          if (!payload) return;
          const frame = decode(
              "ServiceFrame",
              decode("ServiceRequest", payload).payload,
            ),
            req = frame.request;
          let result;
          if (req.path === "/api/session/list")
            result = { ok: true, result: { sessions: chats } };
          else if (req.path === "/api/session/list/quiz")
            result = { ok: true, result: { session: chats[1] } };
          else {
            assert.equal(req.path, "/chat/stream");
            const message = JSON.parse(Buffer.from(req.body));
            assert.equal(message.message, "¿Cómo estás?");
            assert.ok(
              message.session_id === undefined || message.session_id === "quiz",
            );
            sends++;
            if (drop) {
              dispatch(id, { type: "close" });
              return;
            }
            result = {
              message_id: "receipt",
              session_id: message.session_id || "primary",
            };
          }
          const response = encode("ServiceResponse", {
            payload: encode("ServiceFrame", {
              streamId: frame.streamId,
              response: {
                status: 200,
                body: Buffer.from(JSON.stringify(result)),
                endBody: true,
              },
            }),
          });
          for (const chunk of framePayload(response))
            emit(c.send.encrypt(chunk));
        } catch (e) {
          failures.push(e);
          dispatch(id, { type: "error" });
        }
      },
      close(id) {
        sockets.delete(id);
      },
  };
  vm.runInContext(readFileSync("plugin.js", "utf8"), context);
  return {
    config: (m) => new Promise((r) => config(m, r)),
    failWrites: () => (failWrites = true),
    send: (chat_id) =>
      new Promise((resolve) =>
        action(
          { action: "send_to_agent", args: { message: "¿Cómo estás?", chat_id } },
          {
            ok: (value) => resolve({ ok: true, ...value }),
            error: (code, message) => resolve({ code, message }),
          },
        ),
      ),
    get sends() {
      return sends;
    },
    failures,
    logs,
    get opens() {
      return opens;
    },
  };
}
for (const selected of ["main", "quiz"])
  test("Noise handshake and encrypted send to " + selected, async () => {
    const f = fixture();
    const result = await f.config({
      type: "connect",
      session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
    });
    assert.equal(result.configured, true, JSON.stringify(result));
    assert.equal(
      (await f.config({ type: "selectChat", id: selected })).selected,
      selected,
    );
    assert.equal((await f.send()).ok, true);
    assert.equal(f.sends, 1);
    assert.deepEqual(f.failures, []);
  });
test("disconnect after send reports uncertainty and never resends", async () => {
  const f = fixture({ drop: true });
  await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  const result = await f.send();
  assert.match(result.message, /uncertain/);
  assert.equal(f.sends, 1);
  assert.deepEqual(f.failures, []);
});
test("confidential VM challenge is rejected before sending", async () => {
  const f = fixture({ rv: true });
  const r = await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  assert.ok(r.error);
  assert.equal(f.sends, 0);
  assert.deepEqual(f.failures, []);
});
test("a failing credential store never turns a delivered send into an error", async () => {
  const f = fixture();
  await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  f.failWrites();
  const result = await f.send("quiz");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.sends, 1);
  assert.deepEqual(f.failures, []);
});
test("a socket the just-woken VM refuses is retried until it opens", async () => {
  const f = fixture({ failOpens: 2 });
  const result = await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  assert.equal(result.configured, true, JSON.stringify(result));
  assert.equal(f.opens, 3);
  assert.ok(f.logs.some((l) => /opened on attempt 3/.test(l)), f.logs.join("\n"));
  assert.equal((await f.send()).ok, true);
});
test("connecting gives up after four refused sockets", async () => {
  const f = fixture({ failOpens: 99 });
  const r = await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  assert.ok(r.error);
  assert.equal(f.opens, 4);
  assert.equal(f.sends, 0);
});
test("connecting stops retrying once another attempt would pass the deadline", async () => {
  const f = fixture({ failOpens: 99, slowClock: true });
  const r = await f.config({
    type: "connect",
    session: { cookie: "hatch_sess=fixture", vm_id: "vm-fixture" },
  });
  assert.ok(r.error);
  assert.ok(f.opens < 4, String(f.opens));
  assert.ok(f.logs.some((l) => /retries stopped/.test(l)), f.logs.join("\n"));
});
