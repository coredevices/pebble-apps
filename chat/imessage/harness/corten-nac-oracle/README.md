# Deterministic Corten NAC oracle

This desktop-only crate is an offline differential oracle for the JavaScript NAC port. It is not
bundled into the plugin, Gradle, Android, or iOS. The emulator source is derived from
`rustpush/open-absinthe` at Corten-Matrix commit
`501403fcbe8802cc427e9ccab3573c5367508fdf` and remains AGPL-3.0-only.

The oracle makes two safety changes to the historical implementation:

- it has no HTTP dependency or binary-download fallback;
- every emulated `arc4random()` result comes from the request's exact `arc4random_words` list.

The list must be exact. Exhausting it or leaving entries unused fails the request. This makes changes
in the native binary's random-call behavior visible instead of silently changing test vectors.

## NAC binary

The Apple binary is deliberately absent from this directory and ignored by Git. Set
`NAC_BINARY_FILE` to an explicit local regular file. The oracle reads at most 32 MiB and requires
all three pins before starting Unicorn:

- full-file SHA-1 `e1181ccad82e6629d52c6a006645ad87ee59bd13`;
- full-file SHA-256 `74c2a8fe826a478f14f6e17b3709a8b315e8c0e0e34e3fba6b9c4eee2f4516e9`;
- selected x86_64-slice SHA-256
  `7f225430438171b2d460cd953fe1110a2d6699e6d0d944780471ef58fd075d9f`.

It never searches for, caches, writes, or downloads the binary.

Hardware input is consumed exactly as supplied. The oracle does not embed XNU code to derive
missing `*_enc` properties: all five encrypted properties must be the 17-byte values produced by
ExtractKey. The MAC address and ROM must each contain exactly 6 bytes. Platform and root-disk UUIDs
must use the same case-insensitive hexadecimal `8-4-4-4-12` syntax enforced by the JavaScript port.

## Line protocol

Run one long-lived process and send one JSON object per line:

```sh
NAC_BINARY_FILE=/absolute/local/path/IMDAppleServices \
  cargo run --offline --locked
```

The process never performs HTTP, opens an Apple account session, or accepts account credentials.
The caller is responsible for obtaining the credential-free certificate and for exchanging the
NACInit request for matching session info. If that exchange fails, cancel the pending oracle
session. Keep the same oracle process alive: a session ID is intentionally invalid after restart.
Library callers must likewise retain one `OracleSessionServer`; the legacy stateless `process_line`
helper rejects stateful operations with `stateful_server_required` rather than returning an unusable
session ID.

### Stateful two-stage operation

`initialize_nac_validation` creates the native context and returns the NACInit request. Apple does
not return matching session info for fabricated device identities, so a live local capture must use
the hardware object produced by ExtractKey. The object is strictly shaped and bounded but treated
as private local input: never log it or commit it as a fixture. `replace_pending` is required. Set
it to `false` normally, or to `true` to explicitly drop an earlier pending context before starting
a replacement. The synthetic object below is suitable only for protocol-shape tests that use a fake
initializer; it is not expected to complete Apple's public session exchange.

```json
{
  "schema_version": 1,
  "request_id": "initialize-1",
  "operation": "initialize_nac_validation",
  "cert_chain_base64": "<canonical padded base64>",
  "hardware": {
    "product_name": "SyntheticMac1,1",
    "io_mac_address": [2, 0, 0, 0, 0, 1],
    "platform_serial_number": "SYNTHETIC0001",
    "platform_uuid": "00000000-0000-4000-8000-000000000001",
    "root_disk_uuid": "00000000-0000-4000-8000-000000000002",
    "board_id": "Synthetic-Board",
    "os_build_num": "00A000",
    "platform_serial_number_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "platform_uuid_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "root_disk_uuid_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "rom": [2, 0, 0, 0, 0, 1],
    "rom_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    "mlb": "SYNTHETICMLB00001",
    "mlb_enc": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  "arc4random_words": [1, 2, 3],
  "replace_pending": false
}
```

A successful response contains an opaque 64-character `session_id` and canonical-base64
`session_info_request_base64`. Supply the matching response to that same process:

```json
{
  "schema_version": 1,
  "request_id": "complete-1",
  "operation": "complete_nac_validation",
  "session_id": "<opaque session_id returned by initialize>",
  "session_info_base64": "<canonical padded base64>"
}
```

The completion result contains the same session ID, canonical-base64 `validation_data_base64`, the
exact `arc4random_words_consumed` count, the Corten commit, and the three verified image hashes. A
completion attempt consumes and drops the native context whether native establishment/signing
succeeds, fails, or panics. Validation errors that occur before native execution (such as invalid
base64 or a mismatched session ID) preserve it so the caller can correct the request.

Explicitly cancel a pending context when the external exchange is abandoned:

```json
{
  "schema_version": 1,
  "request_id": "cancel-1",
  "operation": "cancel_nac_validation",
  "session_id": "<opaque session_id returned by initialize>"
}
```

There is at most one pending native context. A second initialization fails with
`pending_context_exists` unless `replace_pending` is true. Replacement drops the old context before
running the new initialization; if the new initialization then fails, no context remains. Process
exit also drops any pending context. All errors for a recognized stateful operation contain only a
stable `error.code`; they do not echo protocol bytes, hardware fields, internal native errors, or the
binary path. Request objects reject unknown fields.

The verified binary is cached in the long-lived process after its first successful three-hash
verification. One way to discover an exact deterministic random count is to try successively longer
prefixes of a fixed candidate word stream. If completion reports `deterministic_random_mismatch`,
initialize the next prefix and replay the already captured session info only after asserting the new
session-info request is byte-identical. The first successful completion identifies the exact prefix;
rerun that prefix offline to confirm identical output. Never make a second external exchange for a
different initialization request.

### Atomic compatibility operation

The original `run_nac_validation` operation remains supported. It performs NACInit, consumes the
supplied `session_info_base64` in NACKeyEstablishment, and runs NACSign atomically on one in-memory
context. It accepts the same structurally valid local hardware. Its request has the same fields as
the initialize example, except:

- `operation` is `run_nac_validation`;
- `session_info_base64` is required;
- `replace_pending` is absent.

Its success result contains both `session_info_request_base64` and `validation_data_base64`, random
consumption, and the same provenance fields. Its legacy diagnostic `error.message` remains present;
new stateful callers should depend only on stable error codes.

## Execution bounds

Each native call has both a 60-second wall-clock limit and a 500-million-instruction limit. Native
session-request and validation outputs are rejected unless they are between 1 byte and 1 MiB. Input
certificate and session-info values have the same decoded limit, random input is capped at 4,096
words, and the LDJSON reader stops buffering at 4 MiB, drains an oversized record, and continues with
the next one.

The pinned binary is a full application image and therefore contains unrelated imports outside the
NAC path; rejecting every such import while loading would reject the genuine pinned binary. The
oracle instead requires every NAC host hook to be present, binds unrelated imports to a trap, and
fails if emulated NAC code executes that trap. The full-file hashes also prevent the import set from
changing unnoticed.

Real device identifiers, certificates, session info, and validation output must not be committed as
fixtures. A future checked-in vector should contain only reviewed synthetic data derived from a
credential-free flow, with every binary input represented by a digest or an explicitly approved
non-secret test value.

## Tests

```sh
cargo test --offline --locked
```

The ordinary tests require no NAC binary, credentials, sockets, Apple services, or network access.
They cover explicit-path enforcement, verified-binary caching, all three pinned hashes, size limits,
complete encrypted hardware fields, canonical input decoding, unknown-field rejection,
deterministic random ordering/exhaustion, native execution limits, bounded LDJSON, and the two-stage
session lifecycle using a fake native backend. Lifecycle tests verify same-context completion,
single-context replacement, cancellation, mismatch preservation, panic/error cleanup, server-drop
cleanup, code-only stateful errors, and atomic response compatibility.
