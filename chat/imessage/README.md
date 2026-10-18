# iMessage sender plugin

This PBW exposes one `send_message` action for one plain-text recipient. Recipient validation,
Apple account setup, APNs/IDS behavior, encryption, persistence, and the action flow all live in
the bundled JavaScript. There is no production Rust or protocol-specific native bridge.

The production target keeps every Apple/iMessage/Anisette request, constant, state machine, retry,
and encryption composition in this JavaScript plugin. CoreApp may expose only generic,
parameter-driven transports, cryptographic primitives, timers, and secure key storage. See
`JS_PORT_SPEC.md` for the test-gated roadmap and ownership boundary.

Deliberately absent: receiving or polling messages, conversation sync, attachments, images,
reactions, SMS fallback, and groups.

The configuration page accepts the JSON or base64 JSON emitted by Corten-Matrix's pinned
[`ExtractKey.app.zip`](https://github.com/lrhodin/corten-matrix/blob/d9fed308b33a03019fd4273a6921a0a5bf818564/tools/ExtractKey.app.zip).
The verified archive SHA-256 is
`380c87cdf059364a9613dff9127af18deeebebd2ccb7af1c18404b0340252e5b`. Its hardware-only shape is
the primary compatibility contract:

```json
{
  "inner": { "...": "rustpush HardwareConfig fields" },
  "version": "<macOS product version>",
  "protocol_version": 1640,
  "device_id": "<hardware UUID>",
  "icloud_ua": "<iCloud user agent>",
  "aoskit_version": "<AOSKit user agent>"
}
```

From this input, JavaScript now reproduces the RustPush/Corten APNs activation sequence: generate a
durable RSA-1024 key, build the Apple Push CSR and Albert activation request, verify the returned
certificate, perform one tokenless courier connection, and persist the resulting APNs certificate,
opaque host-key handle, and 32-byte token. Apple/iMessage request construction remains in JS; KMP
only supplies generic crypto, key storage, HTTP, TLS, and timer effects. The tokenless courier wait
is capped at 30 seconds. The opaque persistent key ID is synchronously staged as a durable cleanup
obligation before the Albert request; certificate/token publication atomically promotes it to an
active key. A timeout, failed publication, or restarted plugin session can therefore delete the
unpublished key before a clean retry.

The current milestone can provision Anisette, run GrandSlam SRP, and reach Apple's trusted-device or
SMS 2FA challenge. ExtractKey does not contain the NAC `validationData` needed for the IDS delegate
request after 2FA, so JavaScript generates a fresh value from the supplied hardware fields before it
consumes the six-digit code. The pending challenge stays only in the live plugin session; password,
2FA code, and generated validation data are never persisted. The config page keeps a start-over and
erase action available when setup cannot continue.

The source-available Corten compatibility path does not expose a conventional NAC cryptographic
algorithm. Its historical portable implementation runs three functions from a hash-pinned x86-64
`IMDAppleServices` image under Unicorn and emulates the small macOS API surface those functions use.
The current JS port implements the bounded download and full/slice hash checks, Mach-O fat-slice and
import parsing, strict ExtractKey hardware mapping, the 37 emulated Foundation/IOKit hooks, and the
complete trap/resume state machine. The Apple image is neither checked into this repository nor
bundled in the PBW. Both Android and iOS execute it using the same bounded Blink interpreter,
compiled to WebAssembly and embedded in the JavaScript bundle. There is no native x86 bridge,
Unicorn dependency, or CPU-emulation permission in the app. The remaining native APIs provide
generic crypto, secure storage, network transport, and isolated JavaScript workers.
iOS runs validation in a temporary WebKit worker for Wasm performance; the rest of the plugin
continues in JavaScriptCore. Android executes the same Wasm directly in its WebView runtime.

The Wasm interpreter preserves guest memory permissions, traps, instruction/time limits, and
syscall containment. Each validation context owns its Wasm instance; destruction wipes its linear
memory and releases the reference. It is allocated only for validation, not ordinary sending.
A private deterministic Corten oracle verifies request and validation output byte for byte.
See [the Wasm build notes](wasm/README.md) for reproducibility and verification. A clean-room NAC
algorithm would be a separate later effort.

Older combined tokens containing fresh `validationData` and a `pushBootstrap` object remain
supported. For those tokens, `push_bootstrap`, `certificate_der`, and `private_key_pkcs8` are accepted
as input aliases. The supplied certificate/key/token must be a matching, valid set. The PKCS#8 key is
imported once into the generic plugin-scoped host vault, then cleared; durable JS state contains only
the opaque handle and public/push data.

To match the known-working Corten-Matrix prototype, the first prototype embeds the same public
legacy FairPlay material for the Albert signature. That shared leaf is expired and Apple may stop
accepting it; this is an explicitly provisional compatibility path, not a durable production
credential design. Treat ExtractKey output as sensitive hardware authentication data. Keep it and
Apple credentials out of the repository, fixtures, screenshots, and logs. The plugin never persists
the Apple ID password or 2FA code.

Install the deterministic JavaScript build dependency and run the unit/differential tests with:

```sh
npm install
npm test
npm run test:oracle
cargo test --offline --locked --manifest-path harness/corten-nac-oracle/Cargo.toml
```

`test:oracle` builds the desktop-only pinned RustPush adapter and verifies raw and packed APNs plus
NGM pair-ec composition against RustPush byte for byte. The separate Cargo command tests the
deterministic desktop-only Corten NAC harness offline; without an explicit local pinned binary and
input vector it does not execute a successful NAC flow. Neither oracle is part of a mobile build.

Build the committed JavaScript artifact and bundled PBW with:

```sh
npm run build:pbw
```
