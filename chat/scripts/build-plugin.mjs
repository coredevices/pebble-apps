import '../../imessage/scripts/build-worker.mjs';
import { build } from '../../imessage/node_modules/esbuild/lib/main.js';
import { existsSync } from 'node:fs';

// The Wasm sources are only checked out alongside the interpreter; elsewhere skip the hash check.
if (existsSync(new URL('../../../x86executor-interpreter', import.meta.url))) await import('../../imessage/wasm/verify.mjs');
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

await build({
  absWorkingDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  entryPoints: ['src/plugin-entry.js'], outfile: 'plugin.js', bundle: true,
  charset: 'utf8', format: 'iife', legalComments: 'none', logLevel: 'info',
  banner: { js: '/*! Blink Wasm interpreter\n' + await readFile(new URL('../../imessage/wasm/LICENSE.blink', import.meta.url), 'utf8') + '\n*/' },
  platform: 'browser', sourcemap: false, target: ['es2020'],
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const settings = await build({
  absWorkingDir: root, entryPoints: ['src/settings.js'], bundle: true, write: false,
  charset: 'utf8', format: 'iife', legalComments: 'none', platform: 'browser', target: ['es2020'],
});
const template = await readFile(path.join(root, 'config.template.html'), 'utf8');
await writeFile(path.join(root, 'config.html'), template.replace('/* CHAT_SETTINGS_SCRIPT */', () => settings.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')));
