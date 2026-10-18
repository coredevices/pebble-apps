import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await build({
  absWorkingDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  entryPoints: ['src/plugin-entry.js'], outfile: 'pbw/plugin.js', bundle: true,
  charset: 'utf8', format: 'iife', legalComments: 'eof', logLevel: 'info',
  platform: 'browser', sourcemap: false, target: ['es2020'],
});
