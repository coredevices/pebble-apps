# RustPush desktop oracle

This crate is a credential-free desktop test adapter for the JavaScript port. The default
executable never initiates network traffic and is not referenced by Gradle, the plugin package, or
either mobile application build.

An additional `live-aps-activation` feature exposes a separate, one-shot Albert acceptance probe.
That binary is opt-in, excluded from the default build and test commands, and must never run in CI.

## Provenance

The oracle is pinned to RustPush commit
`a7fab473e7a33325a760635285db2860de8e1cb0`. Its first surface reproduces that revision's raw APNs
frame encoding from `src/aps.rs`: one command byte, a big-endian `u32` body length, then ordered
fields containing an ID byte, big-endian `u16` value length, and value bytes.

The oracle also exposes the credential-free GrandSlam SRP-6a completion used by the same pinned
RustPush account client. The adapter takes a pre-hashed synthetic password plus deterministic salt,
ephemeral, and server-public bytes, then returns the public ephemeral, client proof, expected server
proof, and session key. It never accepts an Apple ID password and never opens a socket.

RustPush's `APSMessage::to_raw`, `APSRawMessage`, and `APSRawField` are private, and the final
`DekuWrite::to_bytes` call is made inside the network connection. The desktop-only `port-oracle`
patch exposes that same internal encoder without opening a connection. This crate calls the patched
pinned implementation directly rather than duplicating its wire algorithm.

Source reference:
<https://github.com/OpenBubbles/rustpush/blob/a7fab473e7a33325a760635285db2860de8e1cb0/src/aps.rs>

## Line protocol

Run the process once and write one JSON request per line to stdin. It writes exactly one JSON
response per non-empty input line and continues after malformed requests.

```sh
cargo run --quiet <<'EOF'
{"schema_version":1,"request_id":"ping-1","operation":"encode_raw_aps","command":12,"fields":[]}
EOF
```

Successful response:

```json
{"schema_version":1,"request_id":"ping-1","ok":true,"result":{"frame_base64":"DAAAAAA=","byte_length":5,"rustpush_commit":"a7fab473e7a33325a760635285db2860de8e1cb0"}}
```

`request_id` may be any JSON value and is echoed unchanged. Each field is
`{"id": <0..255>, "value_base64": "..."}`. Fields are encoded in request order. Values use standard
padded base64. A field longer than 65,535 decoded bytes is rejected instead of truncating its wire
length.

Errors have `ok: false` and a stable `error.code`. A malformed JSON request cannot safely recover
its ID, so its response uses `request_id: null`.

## Tests

Generate the patched RustPush tree, then run the tests:

```sh
../oracle-support/prepare-rustpush.sh
cargo test --locked
```

The tests cover exact empty and multi-field frames, length rejection, structured input errors, and
multiple requests through the real CLI process. They require no credentials, sockets, fixtures, or
Apple services.

## Opt-in live APS acceptance probe

The live binary accepts only the hardware JSON emitted inside the Corten-Matrix ExtractKey token.
It rejects unknown root fields, including account credentials and push bootstrap material. Input
must be an owner-only regular file no larger than 4 MiB. The binary outputs only a stable acceptance
or failure category plus hashes and lengths for a successful public identity; it never outputs the
hardware data, response body, private key, certificate bytes, or raw RustPush error.

```sh
chmod 600 /absolute/path/to/extract-key-hardware.json
IMESSAGE_RUST_LIVE_APS_INPUT=/absolute/path/to/extract-key-hardware.json \
  cargo run --locked --offline --features live-aps-activation \
  --bin imessage-rust-live-aps-oracle
```

`--offline` constrains Cargo dependency resolution only; the opt-in binary itself performs the real
Albert HTTPS request. Run it manually and sparingly because Apple may throttle repeated activation.
