import path from 'node:path';
import { build } from 'esbuild';
import { devDir } from './paths.mjs';

await build({
  entryPoints: [path.join(devDir, 'src', 'plugin.js')],
  outfile: path.join(devDir, 'pbw', 'plugin.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2017'],
  legalComments: 'inline',
});
console.log('Built pbw/plugin.js.');
