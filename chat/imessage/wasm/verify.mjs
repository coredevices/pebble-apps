import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(root, '../../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json')));
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
for (const [file, expected] of Object.entries(manifest.inputs)) {
  if (hash(path.join(publicRoot, file)) !== expected) throw Error('Rebuild Wasm: changed source ' + file);
}
for (const [file, expected] of Object.entries(manifest.outputs)) {
  if (hash(path.join(root, '../src/runtime/generated', file)) !== expected) throw Error('Rebuild Wasm: generated artifact mismatch ' + file);
}
console.log('Wasm source and artifact hashes match.');
