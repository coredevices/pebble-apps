const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function loadPlugin() {
  const noop = () => {};
  const Pebble = {
    registerConfigHandler: noop, registerActionHandler: noop, registerSourceHandler: noop, refreshSources: noop,
    secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
  };
  const context = { Pebble, console, TextEncoder, TextDecoder, btoa, atob, crypto: webcrypto };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "pbw", "plugin.js"), "utf8"), context);
  return context;
}

const context = loadPlugin();
const T = context.__appleNotesPbwTest;
const replica = new Uint8Array(16).fill(7);

function record(document) {
  return { recordChangeTag: "tag", fields: { TextDataEncrypted: { value: T.bytesToBase64(T.deflate(document)) } } };
}

function paragraphs(compressedBase64) {
  const doc = T.parseNoteDocument(T.inflate(T.base64ToBytes(compressedBase64)));
  const styleAt = [];
  for (const run of doc.attributeRuns) {
    for (let i = 0; i < run.length; i++) styleAt.push(run.paragraphStyle ? run.paragraphStyle.style : undefined);
  }
  let start = 0;
  return doc.text.split("\n").map((line) => {
    const style = styleAt[start];
    start += line.length + 1;
    return [line, style];
  });
}

test("an append moves our replica to clock slot 1, like iCloud.com", () => {
  const mac = new Uint8Array(16).fill(1);
  const original = T.encodeInitialNote("Index Todos\nWritten in notes app", mac);
  const appended = T.prepareAppend(record(original), "from index", "bottom", replica);
  assert.equal(appended.ok, true, appended.error);
  assert.equal(appended.text, "Index Todos\nWritten in notes app\nfrom index");
  const doc = T.parseNoteDocument(T.inflate(T.base64ToBytes(appended.compressedBase64)));
  assert.deepEqual([...doc.replicas.map((r) => r.id[0])], [7, 1]);
  const before = T.parseNoteDocument(original);
  const macRuns = before.runs.filter((run) => run.coord.replica === 1).length;
  assert.equal(doc.runs.filter((run) => run.coord.replica === 2).length, macRuns);
  assert.ok(doc.runs.some((run) => run.coord.replica === 1 && run.length === "\nfrom index".length));

  const again = T.prepareAppend(record(T.inflate(T.base64ToBytes(appended.compressedBase64))), "more", "bottom", replica);
  assert.equal(again.ok, true, again.error);
  assert.deepEqual([...T.parseNoteDocument(T.inflate(T.base64ToBytes(again.compressedBase64))).replicas.map((r) => r.id[0])], [7, 1]);
});

test("every added line is a dash item, under the title for top and after the last line for bottom", () => {
  const plain = T.encodeInitialNote("Index Todos", replica);
  const bottom = T.prepareAppend(record(plain), "first\n", "bottom", replica);
  assert.equal(bottom.ok, true, bottom.error);
  assert.equal(bottom.text, "Index Todos\nfirst");
  assert.deepEqual(paragraphs(bottom.compressedBase64).slice(1), [["first", 101]]);

  const base = T.inflate(T.base64ToBytes(bottom.compressedBase64));
  const second = T.prepareAppend(record(base), "second", "bottom", replica);
  assert.equal(second.text, "Index Todos\nfirst\nsecond");
  assert.deepEqual(paragraphs(second.compressedBase64).slice(1), [["first", 101], ["second", 101]]);

  // The title ends where the dash item's formatting run starts: the case that used to fail.
  const top = T.prepareAppend(record(base), "zeroth", "top", replica);
  assert.equal(top.ok, true, top.error);
  assert.equal(top.text, "Index Todos\nzeroth\nfirst");
  const lines = paragraphs(top.compressedBase64);
  assert.equal(lines[0][1], paragraphs(bottom.compressedBase64)[0][1]);
  assert.deepEqual(lines.slice(1), [["zeroth", 101], ["first", 101]]);
});

test("a fetch the user hasn't allowed fails like a dead network and answers from the last check", async () => {
  const storage = new Map([["apple-notes.blocked.v1", JSON.stringify({ host: "icloud.com", sure: true })]]);
  context.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) };
  context.fetch = async (url) => { const e = new Error("fetch not allowed: " + url); e.name = "NotAllowedError"; throw e; };
  const result = await T.http("POST", "https://p1-ckdatabasews.icloud.com/x", {}, "{}");
  assert.equal(result.status, 0);
  assert.equal(T.pluginError(result).message, 'Apple Notes doesn\'t have permission to connect to icloud.com. Turn on "Connect to icloud.com" in Apple Notes\'s Permissions.');
});
