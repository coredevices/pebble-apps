import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { build } from "esbuild";
test("bundle loads without Node or DOM globals and registers its handlers", async () => {
  let action, config, source;
  const data = new Map();
  const context = vm.createContext({
    Pebble: {
      secureStorage: {
        getItem: async (k) => (data.has(k) ? data.get(k) : null),
        setItem: async (k, v) => { data.set(k, v); },
        removeItem: async (k) => { data.delete(k); },
      },
      registerActionHandler: (fn) => (action = fn),
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: (fn) => (source = fn),
    },
  });
  vm.runInContext(readFileSync("plugin.js", "utf8"), context);
  assert.equal(typeof action, "function");
  assert.equal(typeof config, "function");
  const status = await new Promise((resolve) =>
    config({ type: "status" }, resolve),
  );
  assert.equal(status.selected, "main");
  let error;
  await action(
    { action: "send_to_agent", args: { message: "test" } },
    {
      ok: () => assert.fail(),
      error: (code, message) => (error = { code, message }),
    },
  );
  assert.equal(error.code, "AUTH_REQUIRED");
  const configured = await new Promise((resolve, reject) =>
    source({ category: "agent", item: "configured" }, { data: resolve, error: reject }),
  );
  assert.equal(configured.instances[0].properties.configured.boolean.value, false);
});
test("portable X25519 and AES-GCM interoperate with native crypto and reject tampering", async () => {
  const r = await build({
    entryPoints: ["src/crypto.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "primitives",
    platform: "browser",
    target: "es2020",
    inject: ["./src/globals.js"],
  });
  const context = vm.createContext({
    Uint8Array,
    ArrayBuffer,
    DataView,
    crypto: { getRandomValues: (array) => crypto.getRandomValues(array) },
  });
  vm.runInContext(r.outputFiles[0].text, context);
  const p = context.primitives,
    a = p.generateKeyPairSync(),
    b = crypto.generateKeyPairSync("x25519");
  const remote = b.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32),
    secret = p.diffieHellman({ privateKey: a.privateKey, publicKey: remote });
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      a.publicKey.export(),
    ]),
    format: "der",
    type: "spki",
  });
  assert.deepEqual(
    Buffer.from(secret),
    crypto.diffieHellman({ privateKey: b.privateKey, publicKey }),
  );
  const key = crypto.randomBytes(32),
    iv = crypto.randomBytes(12),
    ad = Buffer.from("ad"),
    plain = Buffer.from("Muse message");
  const c = p.createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(ad);
  c.update(plain);
  const encrypted = Buffer.from(c.final()),
    tag = Buffer.from(c.getAuthTag());
  const native = crypto.createDecipheriv("aes-256-gcm", key, iv);
  native.setAAD(ad);
  native.setAuthTag(tag);
  assert.deepEqual(
    Buffer.concat([native.update(encrypted), native.final()]),
    plain,
  );
  const d = p.createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(ad);
  d.setAuthTag(tag);
  d.update(encrypted);
  assert.deepEqual(Buffer.from(d.final()), plain);
  tag[0] ^= 1;
  const bad = p.createDecipheriv("aes-256-gcm", key, iv);
  bad.setAAD(ad);
  bad.setAuthTag(tag);
  bad.update(encrypted);
  assert.throws(() => bad.final());
  assert.match(p.randomUUID(), /^[a-f0-9-]{36}$/);
});

test("bundle works with no host timers or crypto, as on stock CoreApp", async () => {
  const r = await build({
    entryPoints: ["src/crypto.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "primitives",
    platform: "browser",
    target: "es2020",
    inject: ["./src/globals.js"],
  });
  const context = vm.createContext({ Uint8Array, ArrayBuffer, DataView, Math });
  vm.runInContext(r.outputFiles[0].text, context);
  const bytes = context.primitives.randomBytes(32);
  assert.equal(bytes.length, 32);
  assert.ok(bytes.some((b) => b !== 0));
  let config;
  const data = new Map();
  const plugin = vm.createContext({
    Pebble: {
      secureStorage: {
        getItem: async (k) => (data.has(k) ? data.get(k) : null),
        setItem: async (k, v) => { data.set(k, v); },
        removeItem: async (k) => { data.delete(k); },
      },
      registerActionHandler: () => {},
      registerConfigHandler: (fn) => (config = fn),
      registerSourceHandler: () => {},
    },
  });
  vm.runInContext(readFileSync("plugin.js", "utf8"), plugin);
  const status = await new Promise((resolve) => config({ type: "status" }, resolve));
  assert.equal(status.configured, false);
});
