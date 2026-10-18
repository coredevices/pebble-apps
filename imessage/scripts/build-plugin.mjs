import './build-worker.mjs';
import '../wasm/verify.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pluginDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  absWorkingDir: pluginDirectory,
  entryPoints: ['src/plugin-entry.js'],
  outfile: 'plugin.js',
  bundle: true,
  banner: { js: '/*! Blink Wasm interpreter\n' + readFileSync(path.join(pluginDirectory, 'wasm/LICENSE.blink'), 'utf8') + '\n*/' },
  charset: 'utf8',
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
  platform: 'browser',
  sourcemap: false,
  target: ['es2020'],
});
