import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const harnessDirectory = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(
  harnessDirectory,
  '../../../../../libpebble3/src/androidDeviceTest/assets/nac-parity/harness.js',
);

await build({
  absWorkingDir: harnessDirectory,
  entryPoints: ['entry.js'],
  outfile: output,
  bundle: true,
  charset: 'utf8',
  format: 'iife',
  legalComments: 'none',
  logLevel: 'info',
  platform: 'browser',
  sourcemap: false,
  target: ['es2020'],
});
