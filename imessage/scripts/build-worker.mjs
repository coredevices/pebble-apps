import { existsSync } from 'node:fs';

// The Wasm sources are only checked out alongside the interpreter; elsewhere skip the hash check.
if (existsSync(new URL('../../../x86executor-interpreter', import.meta.url))) await import('../wasm/verify.mjs');
import { build } from 'esbuild';
import { writeFile } from 'node:fs/promises';
const result = await build({
  entryPoints: [new URL('../src/nac/worker-entry.js', import.meta.url).pathname],
  bundle: true, write: false, platform: 'browser', target: ['es2020'],
  format: 'iife', minify: true, legalComments: 'none',
});
await writeFile(new URL('../src/runtime/generated/nac-worker-source.js', import.meta.url),
  "'use strict';\nmodule.exports = " + JSON.stringify(result.outputFiles[0].text) + ";\n");
