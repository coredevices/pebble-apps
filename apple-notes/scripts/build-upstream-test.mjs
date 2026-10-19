import path from 'node:path';
import { build } from 'esbuild';
import { buildDir, devDir } from './paths.mjs';

await build({
  entryPoints: [path.join(devDir, 'test', 'upstream-entry.js')],
  outfile: path.join(buildDir, 'upstream-bundle.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  nodePaths: [path.join(devDir, 'node_modules')],
});
console.log('Built .build/upstream-bundle.mjs.');
