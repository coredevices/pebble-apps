import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildInitialNoteDocument,
  encodeNoteDocument,
  buildNoteCreateFields,
  buildNoteUpdateFields,
} from '../.build/upstream-bundle.mjs';

const pluginCode = readFileSync(new URL('../pbw/plugin.js', import.meta.url), 'utf8');
const handlers = {};
const store = new Map();
const context = {
  console,
  Uint8Array,
  Date,
  Math,
  JSON,
  Promise,
  String,
  Object,
  Array,
  Number,
  RegExp,
  Error,
  encodeURIComponent,
  decodeURIComponent,
  btoa,
  atob,
  Pebble: {
    registerSourceHandler: (handler) => { handlers.source = handler; },
    registerActionHandler: (handler) => { handlers.action = handler; },
    registerConfigHandler: (handler) => { handlers.config = handler; },
    refreshSources: () => {},
    secureStorage: {
      getItem: async (key) => store.get(key) ?? null,
      setItem: async (key, value) => { store.set(key, String(value)); },
      removeItem: async (key) => { store.delete(key); },
    },
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(pluginCode, context);

const replica = Uint8Array.from({ length: 16 }, (_, i) => i);
const cases = [
  'A',
  'Title line\nBody line',
  'Grüße 世界',
  'Emoji 😀 and a surrogate pair',
  'x'.repeat(130) + '\nSecond paragraph',
];

for (const text of cases) {
  const expected = encodeNoteDocument(buildInitialNoteDocument(text, replica));
  const actual = context.__appleNotesPbwTest.encodeInitialNote(text, replica);
  assert.deepEqual(Array.from(actual), Array.from(expected), `protobuf differs for ${JSON.stringify(text)}`);

  const compressed = deflateSync(expected);
  assert.deepEqual(Array.from(inflateSync(compressed)), Array.from(actual));

  const upstreamFields = buildNoteCreateFields('PAYLOAD', text, 123456789);
  const pbwFields = context.__appleNotesPbwTest.buildCreateFields(text, 'PAYLOAD', 123456789);
  assert.deepEqual(JSON.parse(JSON.stringify(pbwFields)), JSON.parse(JSON.stringify(upstreamFields)));
}

const currentRecord = {
  recordName: 'note-id',
  recordType: 'Note',
  fields: {
    CreationDate: { type: 'TIMESTAMP', value: 111 },
    Folder: { type: 'REFERENCE', value: { recordName: 'DefaultFolder-CloudKit' } },
    Folders: { type: 'REFERENCE_LIST', value: [{ recordName: 'DefaultFolder-CloudKit' }] },
    PaperStyleType: { type: 'INT64', value: 2 },
    FirstAttachmentThumbnail: { type: 'BYTES', value: null },
  },
};
const upstreamUpdate = buildNoteUpdateFields(currentRecord, 'UPDATED_PAYLOAD', 'Title\nNew body', 987654321);
const pbwUpdate = context.__appleNotesPbwTest.buildUpdateFields(
  currentRecord,
  'UPDATED_PAYLOAD',
  'Title\nNew body',
  987654321,
);
assert.deepEqual(JSON.parse(JSON.stringify(pbwUpdate)), JSON.parse(JSON.stringify(upstreamUpdate)));

assert.equal(typeof handlers.source, 'function');
assert.equal(typeof handlers.action, 'function');
assert.equal(typeof handlers.config, 'function');
console.log(`Compared ${cases.length} create payloads and the append update fields with icloud-md upstream.`);
