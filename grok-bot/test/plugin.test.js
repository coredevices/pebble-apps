const test = require("node:test");
const assert = require("node:assert/strict");

// Poll-sized host timers fire at once so tests run fast; deadline-sized ones never fire.
let nextTimer = 0;
globalThis._HostTimer = {
  schedule(ms) {
    const id = ++nextTimer;
    if (ms <= 3000) setImmediate(() => globalThis.__hostTimerDispatch(id));
    return id;
  },
};
const { createService, safeError } = require("../src/plugin/index.js");

const BOX = "https://abc-pod-def.us12.cursorvm.com";

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const reply = (id, content) => ({ id, kind: "send-message", message: { type: "text", content } });

/**
 * A fake Cursor backend + box. Each sendPrompt appends the prompt as a `user` entry and records
 * it in the acceptance ledger; `onSend` lets a test decide what the bot then writes.
 */
function fakeGrokBot(options = {}) {
  const calls = [];
  const transcript = [reply("e1", "old reply")];
  const ledger = new Map();
  let ids = 1;
  async function fetch(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const json = (status, value) => ({ ok: status < 300, status, text: async () => JSON.stringify(value) });
    if (url === "https://api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox") {
      if (options.onEnsure) options.onEnsure();
      if (init.headers.authorization !== "Bearer cursor-token") return json(401, {});
      return json(200, options.ensure || { gatewayUrl: BOX + "/", gatewayToken: "box-token", anyrunNetworkToken: "net" });
    }
    assert.ok(url.startsWith(BOX + "/api/"), url);
    assert.equal(init.headers.authorization, "Bearer box-token");
    assert.equal(init.headers["x-anyrun-network-token"], "net");
    const method = url.slice(BOX.length + 5);
    if (options.fail && options.fail(method)) return json(options.failStatus || 502, {});
    switch (method) {
      case "listAgents":
        return json(200, { agents: [{ id: "g1", name: "Team", memberIds: ["a1"] }, { id: "a1", name: "Ada" }] });
      case "getAgentTranscriptTail":
        return json(200, { entries: transcript });
      case "promptAcceptanceStatus": {
        const record = ledger.get(body.clientNonce);
        return json(200, record ? { outcome: "found", record } : { outcome: "missing" });
      }
      case "sendPrompt": {
        const id = "p" + ids++;
        transcript.push({ id, kind: "user", text: body.prompt });
        ledger.set(body.clientNonce, { status: options.rejected ? "rejected" : "accepted", echoEntryId: id });
        if (options.onSend) options.onSend(body.prompt, transcript);
        else transcript.push(reply("r" + id, "re: " + body.prompt));
        return json(200, { accepted: true });
      }
    }
    throw new Error("unexpected " + url);
  }
  return { fetch, calls, transcript };
}

async function connected(grok) {
  const storage = memoryStorage();
  await createService(storage, grok.fetch).config({ type: "connect", accessToken: "cursor-token" });
  return createService(storage, grok.fetch);
}

test("connects, picks the first bot, sends and returns a receipt; replies are read separately", async () => {
  const grok = fakeGrokBot();
  const service = createService(memoryStorage(), grok.fetch);
  const settings = await service.config({ type: "connect", accessToken: "cursor-token" });
  assert.equal(settings.selected, "a1");
  assert.deepEqual(settings.bots, [{ id: "g1", title: "Team (group)" }, { id: "a1", title: "Ada" }]);

  const result = await service.action({ action: "send_to_grok_bot", args: { message: "hello" } });
  assert.equal(result.text, "Message sent to Ada. Read Grok Bot's replies later for its answer.");
  const sent = grok.calls.find((c) => c.url.endsWith("/api/sendPrompt"));
  assert.equal(sent.body.agentId, "a1");
  assert.ok(sent.body.clientNonce);

  const read = await service.action({ action: "read_grok_bot", args: { limit: 5 } });
  assert.equal(read.text, "Ada: old reply\n\nre: hello");
});

test("reports a send the bot rejected as not sent", async () => {
  const service = await connected(fakeGrokBot({ rejected: true }));
  const err = await service.action({ action: "send_to_grok_bot", args: { message: "x" } }).catch((e) => e);
  assert.match(safeError(err).message, /did not accept/);
});

test("refuses to send when the box lookup used up the time budget", async () => {
  const realNow = Date.now;
  let skew = 0;
  Date.now = () => realNow() + skew;
  try {
    let lookups = 0;
    // Sign-in is quick; the send's box lookup then takes 15s of the 18s budget.
    const slow = fakeGrokBot({ onEnsure: () => (lookups++ > 0 ? (skew += 15000) : 0) });
    const service = await connected(slow);
    const err = await service.action({ action: "send_to_grok_bot", args: { message: "x" } }).catch((e) => e);
    assert.match(safeError(err).message, /not sent/);
    assert.ok(!slow.calls.some((c) => c.url.endsWith("/api/sendPrompt")));
  } finally {
    Date.now = realNow;
  }
});

test("rejects a box URL outside cursorvm.com", async () => {
  const grok = fakeGrokBot({ ensure: { gatewayUrl: "https://evil.example.com", gatewayToken: "t" } });
  const service = createService(memoryStorage(), grok.fetch);
  await assert.rejects(service.config({ type: "connect", accessToken: "cursor-token" }), /not available/);
  assert.equal(grok.calls.length, 1);
});

test("expired sign-in and uncertain send are reported distinctly", async () => {
  const err = await createService(memoryStorage(), fakeGrokBot().fetch)
    .config({ type: "connect", accessToken: "stale" })
    .catch((e) => e);
  assert.equal(safeError(err).code, "AUTH_REQUIRED");

  const broken = await connected(fakeGrokBot({ fail: (m) => m === "sendPrompt" }));
  const sendErr = await broken.action({ action: "send_to_grok_bot", args: { message: "x" } }).catch((e) => e);
  assert.match(safeError(sendErr).message, /uncertain/);
});

test("requires sign-in and valid args", async () => {
  const service = createService(memoryStorage(), fakeGrokBot().fetch);
  const noAuth = await service.action({ action: "read_grok_bot", args: {} }).catch((e) => e);
  assert.equal(safeError(noAuth).code, "AUTH_REQUIRED");
  const bad = await service.action({ action: "send_to_grok_bot", args: { message: " " } }).catch((e) => e);
  assert.equal(safeError(bad).code, "INVALID_ARGS");
});

test("finishing Cursor's login polls for the token, then connects", async () => {
  const grok = fakeGrokBot();
  const polls = [];
  const fetch = async (url, init) => {
    if (!url.startsWith("https://api2.cursor.sh/auth/poll")) return grok.fetch(url, init);
    polls.push(url);
    return polls.length < 3
      ? { status: 404, json: async () => ({}) }
      : { status: 200, json: async () => ({ accessToken: "cursor-token" }) };
  };
  const uuid = "123e4567-e89b-42d3-a456-426614174000";
  const verifier = "v".repeat(43);
  const settings = await createService(memoryStorage(), fetch).config({ type: "finishSignIn", uuid, verifier });
  assert.equal(polls.length, 3);
  assert.equal(polls[0], `https://api2.cursor.sh/auth/poll?uuid=${uuid}&verifier=${verifier}`);
  assert.equal(settings.configured, true);
  await assert.rejects(
    createService(memoryStorage(), fetch).config({ type: "finishSignIn", uuid: "x", verifier }),
    /not started correctly/,
  );
});
