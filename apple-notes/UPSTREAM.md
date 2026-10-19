# Apple Notes plugin provenance

This plugin is a narrow, browser-JavaScript port of the new-note creation path in
[`coddingtonbear/icloud-md`](https://github.com/coddingtonbear/icloud-md), licensed MIT.

- Upstream version: `0.6.2`
- Upstream revision: `a5160cc78e2bfeab35b8c8b365b1ef25662b21bb`
- Source retrieved: 2026-08-27
- Port version: `0.2.0` (plugin `0.3.0`)

## File and function mapping

| PBW implementation | icloud-md source of truth |
| --- | --- |
| Browser-session JSON shape and cookie rotation | `src/session.ts` (`IcloudSession`, `mergeSetCookiesIntoSession`) |
| Manual auth guidance | `src/auth/browserLogin.ts`, `src/auth/accountStore.ts`, `README.md` |
| `/validate` account/CloudKit bootstrap | `src/cloudkit/setupClient.ts` (`checkAuthentication`) |
| CloudKit request URL, headers, and client constants | `src/cloudkit/databaseClient.ts` (`postDatabase`) |
| Ten most-recent private-note listing | `src/cloudkit/databaseClient.ts` (`fetchZoneNoteRecords`, `firstZone`) |
| Fresh selected-note lookup | `src/cloudkit/databaseClient.ts` (`lookupRecords`) |
| `records/modify` create request | `src/cloudkit/databaseClient.ts` (`createNoteRecord`, `createZoneRecord`) |
| Optimistic `recordChangeTag` append update | `src/cloudkit/databaseClient.ts` (`updateNoteRecord`, `updateRecords`) |
| New-note fields, title, snippet, default folder | `src/notes/encodeNoteRecord.ts` (`buildNoteCreateFields`) |
| Existing-note update fields | `src/notes/encodeNoteRecord.ts` (`buildNoteUpdateFields`) |
| Initial one-replica CRDT document | `src/notes/noteDocument.ts` (`buildInitialNoteDocument`, `encodeNoteDocument`) |
| Safe parse/round-trip/edit/re-encode append | `src/notes/noteDocument.ts` (`parseNoteDocument`, `noteDocumentRoundTrips`, `applyTextEdit`) |
| Wire field numbers and proto2 presence | `proto/topotext.proto`, `proto/versioned_document.proto` |
| Zlib compression requirement | `src/notes/noteText.ts` (`compressNoteDocument`) |

The PBW uses a small purpose-built protobuf writer only for the one shape above. Its output is
tested byte-for-byte against upstream `buildInitialNoteDocument` for ASCII, multiline, non-ASCII,
emoji, and long text. It uses pako 3.0.1 (`MIT AND Zlib`) for browser-compatible zlib deflate in
place of icloud-md's Node `zlib.deflateSync`.

Append mode vendors the following pinned files unchanged under `vendor/icloud-md/`, because
editing an existing Apple Notes CRDT safely is not a shape suitable for a smaller hand port:

- `src/notes/noteDocument.ts`
- `src/notes/versionedDocument.ts`
- `src/notes/gen/topotext_pb.ts`
- `src/notes/gen/versioned_document_pb.ts`

`test/vendor-sync.mjs` proves those copies are byte-identical to the fetched revision on every
test run. The runtime bundles them with pinned `@bufbuild/protobuf` and `node-diff3`; a small UTF-8
API fallback supplies `TextEncoder`/`TextDecoder` on iOS JavaScriptCore.

## Updating from icloud-md

The source is `src/plugin.js`; `npm run build` bundles it into `pbw/plugin.js`, and `pebble build`
in `pbw/` packs the PBW.

```sh
npm ci
npm test          # fetches the pinned icloud-md, checks the vendored copies, builds, compares
cd pbw && pebble build
```

For a new icloud-md release:

1. Update `ICLOUD_MD_COMMIT` in `scripts/prepare-upstream.mjs`, and record the matching
   upstream version/revision here.
2. Remove only `.cache/icloud-md`, then run `npm run prepare:upstream`.
3. Diff every mapped file above from `a5160cc78e2bfeab35b8c8b365b1ef25662b21bb` to the new
   revision.
4. Refresh the four exact files in `vendor/icloud-md/`, then port request/field-construction
   changes only to the corresponding sections of `src/plugin.js`.
5. Re-run `npm test`, which verifies the vendored copies, compares create/update payloads with the
   newly pinned upstream, and exercises appending.
6. Run `pebble build` in `pbw/`.

## Deliberate scope limits

- Creates one new plain-text note in the account's private default Notes folder, or appends plain
  text to the configured top-of-body/bottom position in one selected private note.
- Lists only note title, id, and modification date for destination selection; it does not expose
  note bodies through the plugin source API.
- Append always performs a fresh lookup, verifies the protobuf round trip, preserves its CRDT and
  formatting history through upstream `applyTextEdit` using a stable plugin editor replica,
  verifies the rebuilt text, and writes with the fresh `recordChangeTag`. A concurrent edit is
  refused rather than overwritten. Top placement inserts a plain formatting run immediately below
  the existing first-line title; it never replaces or restyles the title.
- Authentication persistence is guarded by an opaque generation token stored beside the
  session. Unlink rotates that marker before clearing credentials, so late validation/list/lookup
  callbacks cannot restore a cleared session or advance an in-flight action to create/update.
- Does not move, delete, format, attach content, edit shared notes, or edit text stored as a
  separate CloudKit asset.
- Does not create notes in shared folders.
- Does not implement Apple sign-in. It imports an icloud-md browser session after Apple itself
  has handled password, 2FA, CAPTCHAs, and device trust.
- Apple exposes no public Notes API; the private CloudKit protocol can change without notice.
- Advanced Data Protection likely must be disabled, as documented by icloud-md.
- Test credentials live in UUID-scoped plugin local storage rather than a production secret vault.
- The exact result link uses the unofficial cross-platform `applenotes://showNote?identifier=…`
  scheme. CoreApp must narrowly allow that scheme for the action pill; otherwise it should fall
  back to opening `https://www.icloud.com/notes/`.
