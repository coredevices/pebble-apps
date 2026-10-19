const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash, randomBytes } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// config.html has no crypto.subtle (not a secure context), so it carries its own SHA-256 for PKCE.
const html = readFileSync(path.join(__dirname, "..", "src", "config.html"), "utf8");
const source = html.match(/      function sha256\(bytes\) \{[\s\S]*?\n      \}\n/)[0];
const sha256 = new Function(source + "return sha256;")();

test("config page SHA-256 matches node's across block boundaries", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const bytes = randomBytes(n);
    assert.equal(Buffer.from(sha256(new Uint8Array(bytes))).toString("hex"), createHash("sha256").update(bytes).digest("hex"), `length ${n}`);
  }
});
