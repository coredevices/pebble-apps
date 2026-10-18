import { build } from "esbuild";
import protobuf from "protobufjs";
import { readFileSync, writeFileSync } from "node:fs";
const root = protobuf.parse(
  readFileSync(
    new URL("./vendor/musemeow/noise.proto", import.meta.url),
    "utf8",
  ),
).root;
writeFileSync(
  new URL("./vendor/musemeow/schema.json", import.meta.url),
  JSON.stringify(root.toJSON()) + "\n",
);
export const options = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  alias: { "node:crypto": "./src/crypto.js" },
  inject: ["./src/globals.js", "./src/runtime.js"],
  logLevel: "info",
};
await build({
  ...options,
  entryPoints: ["src/index.js"],
  outfile: "plugin.js",
});
