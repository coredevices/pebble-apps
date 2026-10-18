import { build } from '../../chat/imessage/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

// The Wasm sources are only checked out alongside the interpreter; plugin-only branches skip the hash check.
if (existsSync(new URL('../../../x86executor-interpreter', import.meta.url))) await import('../../chat/imessage/wasm/verify.mjs');

await build({
  absWorkingDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  entryPoints: ['src/plugin-entry.js'], outfile: 'pbw/plugin.js', bundle: true,
  charset: 'utf8', format: 'iife', legalComments: 'eof', logLevel: 'info',
  banner: { js: '/*! Blink Wasm interpreter\n' + await readFile(new URL('../../chat/imessage/wasm/LICENSE.blink', import.meta.url), 'utf8') + '\n*/' },
  platform: 'browser', sourcemap: false, target: ['es2020'],
  // NAC runs inline (no JavaScriptWorker host), so the worker's self-contained bundle is dead weight.
  plugins: [{
    name: 'drop-nac-worker-source',
    setup(build) {
      build.onResolve({ filter: /\/generated\/nac-worker-source$/ }, () => ({ path: 'nac-worker-source', namespace: 'dropped' }));
      build.onLoad({ filter: /.*/, namespace: 'dropped' }, () => ({ contents: 'module.exports = null;' }));
    },
  }],
});
