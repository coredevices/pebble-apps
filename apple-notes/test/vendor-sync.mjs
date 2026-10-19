import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { devDir, upstreamDir } from '../scripts/paths.mjs';

const pinnedFiles = [
  'src/notes/noteDocument.ts',
  'src/notes/versionedDocument.ts',
  'src/notes/gen/topotext_pb.ts',
  'src/notes/gen/versioned_document_pb.ts',
];

for (const relative of pinnedFiles) {
  const upstream = await readFile(path.join(upstreamDir, relative));
  const vendored = await readFile(path.join(devDir, 'vendor', 'icloud-md', relative));
  assert.deepEqual(vendored, upstream, `vendored icloud-md file drifted: ${relative}`);
}

console.log(`Verified ${pinnedFiles.length} vendored runtime files byte-for-byte against pinned icloud-md.`);
