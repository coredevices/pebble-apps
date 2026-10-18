# Send-only RustPush to JavaScript port

Implementation update (2026-09-18): x86 execution now runs in bundled Blink WebAssembly.
The native executor proposal below is historical; see [the current runtime notes](wasm/README.md).

Status: offline send path and ExtractKey-to-2FA path implemented; JS NAC loader, Mach-O import
resolution, and emulated macOS hooks implemented; x86 execution, NAC wire integration, and
credentialed device acceptance pending,
2026-08-28
Target: CoreApp iOS and Android JavaScript plugin runtime
Reference implementation: OpenBubbles RustPush pinned at `a7fab473e7a33325a760635285db2860de8e1cb0`

> Anisette and every other Apple/iMessage-specific state machine, constant, request, and policy
> belong in JavaScript. KMP is limited to generic, parameter-driven capabilities.

## 1. Decision summary

Release 1 will be a send-only JavaScript implementation of the behavior currently exposed by the
iMessage PBW:

- accept Corten-Matrix `ExtractKey.app` output, Apple ID, password, and a six-digit 2FA code when
  required;
- create an APNs identity in JavaScript, retain its private key in generic secure host storage, and
  create the remaining IDS identities needed to send;
- report `disconnected`, `needsTwoFactor`, or `ready`;
- send exact plain text to one normalized `mailto:` or `tel:+` recipient;
- clear all state and keys on disconnect.

It will not port the whole RustPush crate. It will port only the transitive call graph needed by
those operations. Receiving user messages, syncing, history, attachments, media, SMS relay,
reactions, group chats, typing, read receipts, FaceTime, Find My, CloudKit, and MMCS are excluded.

The production plugin will contain all Apple-facing protocol behavior. The host may provide
generic crypto, secure key storage, HTTP/WebSocket execution, timers, a duplex TLS byte stream, and
a protocol-neutral bounded x86-64 memory/register executor.
No host implementation may contain an Apple hostname, iMessage/APNs/IDS topic, private plist key,
Apple header, retry/status rule, or iMessage-specific type.

Rust remains a test oracle during the port. It is removed from the shipped Android/iOS product only
after a fresh JavaScript sign-in and credential-restored JavaScript sign-in can both send on real
devices. Keeping the oracle out of production and keeping it in the harness are separate decisions.

## 2. Normative scope

### 2.1 Public plugin contract

The PBW keeps its current external contract:

```text
configure(macValidationData, appleId, password)
  -> ready | needsTwoFactor | error

submitTwoFactorCode(code)
  -> ready | error

status()
  -> disconnected | needsTwoFactor | ready

send_message(recipient, text)
  -> sent(messageId, recipient) | error

disconnect()
  -> disconnected
```

The legacy wire-field name `macValidationData` is retained for PBW compatibility. Its primary value
is the exact JSON or base64 JSON emitted by the pinned Corten-Matrix `ExtractKey.app`. Legacy
combined tokens may additionally contain root `validationData` and `pushBootstrap` fields.

`recipient` is exactly one email address or E.164 number. `text` is non-empty and is preserved
byte-for-byte after UTF-8 encoding; it is not trimmed, reformatted, translated, or split.

### 2.2 Release 1 parity definition

Release 1 is parity with the current prototype, not parity with all OpenBubbles features:

1. Trusted-device 2FA and SMS 2FA are represented in the state machine. Fixture tests cover both;
   the live test covers whichever route the test account receives.
2. The first registered sender handle is used, matching the current wrapper.
3. The sender obtains recipient device identities through IDS, encrypts for all valid target
   devices, sends through APNs, and waits for the correlated send result.
4. A cold app restart restores state without asking for the Apple ID password again.
5. Registration is refreshed lazily before a send when its persisted expiration/heartbeat requires
   it. There is no background receive or renewal service in Release 1.
6. APNs control frames and unrelated notifications may be acknowledged and discarded. They are
   never decrypted, surfaced, indexed, or synchronized.

### 2.3 Explicit non-goals

- indefinite background connectivity;
- incoming message delivery or download;
- conversation storage;
- attachments, images, audio, rich links, balloons, or effects;
- groups or participant mutation;
- SMS/MMS or fallback routing;
- Apple account management beyond the login needed for IDS;
- a general JavaScript port of every RustPush module;
- preserving compatibility with arbitrary RustPush state versions.

## 3. Research baseline

The oracle must remain pinned. Private protocols drift, so “matches RustPush” is not precise enough
without a commit. The current CoreApp submodule and the current OpenBubbles app both use
`a7fab473e7a33325a760635285db2860de8e1cb0`.

Primary references:

- [Pinned RustPush source](https://github.com/OpenBubbles/rustpush/tree/a7fab473e7a33325a760635285db2860de8e1cb0)
- [APNs courier implementation](https://github.com/OpenBubbles/rustpush/blob/a7fab473e7a33325a760635285db2860de8e1cb0/src/aps.rs)
- [IDS identities, registration, and encryption](https://github.com/OpenBubbles/rustpush/blob/a7fab473e7a33325a760635285db2860de8e1cb0/src/ids/user.rs)
- [IDS lookup and send jobs](https://github.com/OpenBubbles/rustpush/blob/a7fab473e7a33325a760635285db2860de8e1cb0/src/ids/identity_manager.rs)
- [iMessage send client](https://github.com/OpenBubbles/rustpush/blob/a7fab473e7a33325a760635285db2860de8e1cb0/src/imessage/aps_client.rs)
- [Apple SRP/2FA implementation at the pinned nested revision](https://github.com/OpenBubbles/apple-private-apis/blob/e1c2b0b26bc0d1e9ef04191b8d31c079ee625586/icloud-auth/src/client.rs)
- [OpenBubbles application wrapper](https://github.com/OpenBubbles/openbubbles-app/blob/eed1b6332efbb17adbf5ebfa2263ad770169f75e/rust/src/api/api.rs)
- [Corten-Matrix RustPush wrapper](https://github.com/lrhodin/corten-matrix/blob/7b3af506a73de0b202ec42bd1fb4c032d5bc9da5/pkg/rustpushgo/src/lib.rs)
- [User-pinned Corten ExtractKey-compatible revision](https://github.com/lrhodin/corten-matrix/tree/d9fed308b33a03019fd4273a6921a0a5bf818564)
- [Historical source-available Corten x86-64 NAC emulator](https://github.com/lrhodin/corten-matrix/blob/cb61e824a014c3a0f1ca60542ce825472049f20e/rustpush/open-absinthe/src/nac.rs)
- [Current RustPush fake-FairPlay CI setup](https://github.com/OpenBubbles/rustpush/blob/0e0f13c6417f621be72d4e0e5cc2df89de55144e/.github/workflows/build.yml#L27-L47)
- [OpenBubbles app fake-FairPlay CI setup](https://github.com/OpenBubbles/openbubbles-app/blob/eed1b6332efbb17adbf5ebfa2263ad770169f75e/.github/workflows/build.yml#L45-L65)
- [Corten-Matrix fake-FairPlay source preparation](https://github.com/lrhodin/corten-matrix/blob/7b3af506a73de0b202ec42bd1fb4c032d5bc9da5/Makefile#L161-L200)
- [RustPush APS state stores a key alias](https://github.com/OpenBubbles/rustpush/blob/0e0f13c6417f621be72d4e0e5cc2df89de55144e/src/aps.rs#L1177-L1182)
- [RustPush generic RSA key-alias implementation](https://github.com/OpenBubbles/rustpush/blob/0e0f13c6417f621be72d4e0e5cc2df89de55144e/keystore/src/lib.rs#L198-L229)
- [Corten-Matrix file-backed software keystore](https://github.com/lrhodin/corten-matrix/blob/7b3af506a73de0b202ec42bd1fb4c032d5bc9da5/pkg/rustpushgo/src/lib.rs#L4284-L4333)
- [OpenBubbles registration-renewal notes](https://github.com/OpenBubbles/site/blob/main/docs/renewal.md)
- [Apple JavaScriptCore](https://developer.apple.com/documentation/javascriptcore)
- [Apple Network TLS byte streams](https://developer.apple.com/documentation/network/tls)
- [Android `SSLSocket` and ALPN](https://developer.android.com/reference/javax/net/ssl/SSLParameters#setApplicationProtocols(java.lang.String%5B%5D))
- [Kotlin expect/actual mechanism](https://kotlinlang.org/docs/multiplatform/multiplatform-expect-actual.html)

OpenBubbles and Corten-Matrix are useful production references, but both retain a long-lived native
Rust object, APNs receive loop, renewal scheduler, and connection watchdog. Those are evidence that
state and courier lifecycle matter; they are not the architecture for this send-only PBW.

The exact compatibility target is Corten-Matrix's pinned `ExtractKey.app`. Its token contains the
Mac/RustPush hardware configuration but neither APNs credentials nor NAC `validationData`. RustPush
and Corten first generate a new RSA-1024 APNs identity, sign an Albert activation request with their
shared `legacy-fairplay` material, then obtain the initial 32-byte push token from a tokenless courier
connection. The JS prototype now performs that same sequence.

Historical Corten does not expose the NAC cryptography as source-level primitives. Its portable
implementation executes three entrypoints in a pinned x86-64 Apple image through Unicorn. A
credential-free synthetic run of that path reached init, key establishment, and signing, but
dynamic tracing covered 377,542 distinct instruction addresses. Research found no adoptable
pure-JavaScript x86-64 engine capable of that image. A hand-built JS executor is therefore estimated
at 8–20 engineer-weeks. Release 1 instead allows a generic bounded x86-64 executor in the host,
estimated at 1–3 engineering weeks to integrate, while JS retains the image URL and hashes, Mach-O
loader, addresses, imports, macOS hooks, hardware values, random-word policy, and all NAC/wire logic.

The shared FairPlay leaf expired on 2024-10-11 and the reference projects describe the copied files
as fake FairPlay keys. This prototype intentionally accepts that compatibility risk; live acceptance
must be verified and cannot be assumed to remain stable. The legacy combined-token path is retained
as a fallback for tokens that already contain fresh validation data plus:

```json
{
  "pushBootstrap": {
    "certificateDer": "<base64 DER>",
    "privateKeyPkcs8": "<base64 PKCS#8>",
    "token": "<base64, exactly 32 bytes>"
  }
}
```

The legacy parser accepts base64 strings or byte arrays for binary fields. It accepts `push_bootstrap`,
`certificate_der`, and `private_key_pkcs8` as input aliases, but rejects a token that supplies both
spellings of the same field. `token` must decode to exactly 32 bytes; certificate and private-key
inputs must be non-empty and no larger than 256 KiB each. All three APNs values must be a matching
set. The private key is transient input: JS immediately imports it into the generic plugin-scoped
host key vault, clears the input, and persists only the opaque key ID. JS may persist the certificate
DER and 32-byte token.

A serialized RustPush `APSState` string alone is not a portable legacy bootstrap: it contains the device
certificate and a generic `RsaKey` alias, while the private key lives in RustPush's selected
keystore. The local exporter must run against the same successful sign-in and keystore, resolve that
alias, convert the corresponding RSA key to unencrypted PKCS#8, verify it matches the still-valid
certificate, and emit the exact `pushBootstrap` object. This extraction belongs in the desktop/local
harness. It must not add a private-key export operation to the mobile KMP host or weaken the
plugin-scoped vault.

### 3.1 Exact configure call graph

The credentialed JavaScript prototype performs this sequence:

1. Parse the exact ExtractKey hardware token. If a legacy combined token supplies `pushBootstrap`,
   validate/import it instead.
2. For hardware-only input, generate the RSA-1024 APNs key in the generic host vault. JS builds the
   CSR, FairPlay-signed Albert request, and validates the returned certificate.
3. Open a tokenless APNs courier connection, capture its 32-byte token, close the bootstrap courier,
   and persist the token, certificate, and opaque host-key handle as one durable push artifact. The
   initial courier authentication has a 30-second JS-owned deadline (below the host configuration
   timeout); timeout closes the runner and deletes the unpublished persistent APNs key before retry.
4. Provision or restore remote Anisette v3 state and obtain fresh Anisette headers.
5. Generate one fresh, ephemeral NAC validation blob in JS. Load and verify the pinned compatibility
   image, fetch the validation certificate, run NAC init, exchange `session-info-request` for
   `session-info`, establish the context, sign, and dispose the context. Do not persist the blob.
6. Run Apple GrandSlam SRP login with that validation blob already attached to the IDS delegate:
   SHA-256 password -> PBKDF2-HMAC-SHA-256 -> SRP-2048 -> HMAC-derived AES-256-CBC key/IV.
7. Reach trusted-device or SMS 2FA when required. For hardware-only ExtractKey input, stop before
   consuming the code until the JS NAC implementation supplies fresh validation data. The config
   page must keep a start-over action available so this intentionally blocked state is recoverable.
8. Submit 2FA when needed, obtain the persistent PET, and call setup sign-in v2 for the IDS delegate.
   Dispose the first validation blob after the delegate request completes.
9. Generate an IDS authentication RSA-2048 key and CSR; exchange it for the IDS auth certificate.
10. Restore or generate the local legacy and NGM identities.
11. Generate an independent fresh NAC validation blob immediately before registering the APNs token,
    sender handles, public keys, NGM prekey, and service capabilities with IDS. Dispose it after the
    signed and gzipped registration request; never reuse delegate validation data for registration.
12. Persist push state, registrations, identities, Anisette state, and lookup/counter state. Do not
   persist the plaintext password or the 2FA code.

### 3.2 Exact current send call graph

1. Restore state and open/authenticate a fresh APNs courier connection if no active one exists.
2. Subscribe to the minimum required APNs topics and choose the first registered sender handle.
3. Create uppercase message and conversation UUIDs and a binary-plist plain-text message body.
4. Gzip the body for the simple-text representation.
5. Perform signed IDS lookup through the APNs web-tunnel command to obtain every target device's
   push token, session token, and public encryption identity.
6. For each target device, validate its NGM prekey and encrypt with `pair-ec`, or use the legacy
   `pair` fallback if the target lacks NGM material.
7. Bundle per-device ciphertexts in the APNs command-100 envelope and send it on the Madrid topic.
8. Wait for APNs acknowledgement and correlated command-255 results; return success when at least
   one non-self recipient device reports status `0` or `5008`.
9. Persist each NGM counter before using it. Target-key caching, status-`5032` refresh/retry, and
   registration renewal are M9 hardening work and are not claimed by the current offline build.

### 3.3 Crypto and codec inventory for the send-only slice

| Area | Required behavior |
|---|---|
| Account auth | SHA-256, HMAC-SHA-256, PBKDF2-HMAC-SHA-256, SRP-2048/SHA-256, AES-256-CBC/PKCS#7 |
| APNs bootstrap | RSA-1024 CSR, FairPlay/Albert activation, certificate verification, initial tokenless courier; optional legacy bootstrap import |
| APNs courier | TLS/SNI/custom trust/ALPN, raw and packed APNs framing, binary plist |
| IDS auth/register | RSA-2048 generation, PKCS#10 CSR, RSA-PKCS1-v1_5/SHA-1, gzip, signed HTTP requests |
| Legacy IDS identity | P-256 ECDSA, RSA-1280, DER/ASN.1 public identity encoding |
| NGM identity | P-256 ECDSA/ECDH, protobuf, HKDF-SHA-256, AES-256-CTR64BE |
| Legacy `pair` fallback | HMAC-SHA-256, AES-128-CTR, RSA-OAEP/SHA-1/MGF1-SHA-1, ECDSA/SHA-1 |
| Message payload | UTF-8, binary plist, gzip, UUIDs, exact Apple field names |
| Persistence | versioned JSON/base64 metadata plus host-protected asymmetric key handles |

SHA-1 and unusual RSA sizes are required for protocol compatibility in this narrow implementation;
they must not become generic defaults for new product cryptography.

## 4. Runtime findings and constraints

CoreApp does not run the same browser environment on both platforms:

- Android uses an offscreen WebView, then removes browser globals including `fetch`, native XHR,
  WebSocket, workers, timers, DOM, IndexedDB, and local storage.
- iOS uses a bare JavaScriptCore `JSContext`.
- CoreApp injects its own XHR, base64 helpers, and secure `localStorage` on both platforms.
- Action/source sessions are cold-started for one request and destroyed after the plugin responds.
  The configuration-page session remains alive only while settings are open.
- Host-interface values are currently scalar; binary values need a base64 envelope.

The current XHR bridge is insufficient for Apple account login because it flattens response headers
into a map, losing duplicate `X-Apple-GS-Token`/`X-Apple-HB-Token` values, and its shared `HttpClient`
does not provide a plugin-scoped cookie jar. Both must be fixed through a generic HTTP API.

JavaScriptCore has no raw TCP/TLS API. The APNs courier is a bidirectional TLS byte stream, not the
HTTP/2 provider API. A generic host TLS capability is therefore required. This is host plumbing,
not an iMessage implementation: the JS supplies the host, port, SNI, ALPN values, trust anchors,
bytes, timeouts, and all protocol interpretation.

Release 1 deliberately opens a transient courier connection for configure and for each send. That
fits the existing one-shot action lifetime and avoids a background JavaScript service. A later
milestone can add a resident plugin actor if measured connect latency or Apple behavior makes
transient connections unacceptable.

## 5. Architecture and ownership boundary

```text
config.html / action request
            |
            v
  iMessage PBW JavaScript
  - Apple constants and schemas
  - Anisette, GSA, 2FA
  - APNs and IDS state machines
  - message composition/encryption policy
  - retries, errors, persistence schema
            |
            | generic, parameter-driven calls only
            v
  CoreApp plugin host capabilities
  - secure random and key vault
  - generic cryptographic operations
  - HTTP/WebSocket transport
  - duplex TLS byte stream
  - bounded generic x86-64 memory/register execution
  - timers and secure key/value storage
            |
            v
  Android JCA/KeyStore/SSLSocket   iOS Security/Network.framework/Keychain
```

### 5.1 JavaScript owns

- every hostname, URL, HTTP method, header, topic, user agent, status code, and protocol version;
- all plist/protobuf/ASN.1 schemas and APNs raw/packed framing;
- Anisette v3 provisioning and its WebSocket conversation;
- GrandSlam SRP, PET, 2FA, delegate login, and cookie/token interpretation;
- ExtractKey parsing, APNs activation/bootstrap schema, FairPlay/Albert and IDS CSR composition;
- IDS request signing payload construction, registration, lookup, and renewal decisions;
- target selection, NGM-vs-legacy choice, padding, validators, counters, and send retries;
- persistent schema, migrations, user-facing status, and error mapping.

### 5.2 The generic KMP host may own

| Capability | Contract constraint |
|---|---|
| CSPRNG | `randomBytes(length)`; no protocol knowledge |
| Key vault | plugin-scoped key IDs; generic RSA/P-256 generation/import/delete/public export |
| Asymmetric operations | sign, verify, ECDH, RSA-OAEP using algorithms supplied by JS |
| Symmetric operations | hash/HMAC/HKDF/PBKDF2/AES with algorithm/mode/IV/data supplied by JS |
| HTTP | ordered duplicate headers, binary body, plugin-scoped cookies, cancel/timeout |
| WebSocket | text/binary frames; URL/subprotocol supplied by JS |
| TLS stream | host/port/SNI/ALPN/trust anchors supplied by JS; ordered binary read/write/close |
| Timer | cancellable one-shot deadline; no retry policy |
| Secure storage | existing UUID-scoped encrypted `localStorage` |
| x86-64 executor | caller-supplied memory, registers, breakpoints, timeout, and instruction limit; no binary or protocol knowledge |

The key vault should keep private asymmetric keys out of durable JavaScript state whenever the
platform supports the required key size and algorithm. A dynamically generated APNs private key
never enters JS; only a legacy combined-token PKCS#8 key passes through JS once before import and
clearing. JS persists opaque key IDs and public material, never private bytes. A software-key fallback may
wrap exported private bytes with a platform-keystore key, but it remains a generic key-vault
implementation and must not expose those bytes back to JS.

The protocol-specific choice of `SHA-1`, `RSA-1280`, P-256, signature format, padding, or IV is made
by JS and passed as data. The host exposes capability, not policy.

### 5.3 Forbidden host content and automated boundary check

Production KMP/Android/iOS files added for this port must pass a source scan that rejects Apple or
iMessage literals such as hostnames, `iMessage`, `Anisette`, `Madrid`, `APNs`, `IDS`, private plist
keys, and topic strings. Generic API documentation may describe TLS or cryptographic algorithms but
must not describe the consumer.

All domain/port permissions belong in the PBW manifest. Host code reads a generic permission object
and enforces it without compiled-in exceptions for this UUID.

### 5.4 Proposed generic JS host surface

The exact naming can change, but the semantics must be testable on Node, Android, and iOS:

```js
Pebble.host.crypto.randomBytes(length) -> base64
Pebble.host.crypto.generateKey(spec) -> keyId
Pebble.host.crypto.importKey(spec, bytesBase64) -> keyId
Pebble.host.crypto.exportPublicKey(keyId, format) -> base64
Pebble.host.crypto.sign(keyId, spec, dataBase64) -> base64
Pebble.host.crypto.verify(publicKeyBase64, spec, dataBase64, signatureBase64) -> boolean
Pebble.host.crypto.derive(keyId, spec, peerPublicBase64) -> base64
Pebble.host.crypto.transform(spec, keyBase64, ivBase64, dataBase64) -> base64
Pebble.host.crypto.digest(spec, dataBase64) -> base64
Pebble.host.crypto.deleteKey(keyId)

Pebble.host.http.request(request, callback)
Pebble.host.websocket.open(options, eventCallback) -> socketId
Pebble.host.tls.open(options, eventCallback) -> streamId
Pebble.host.tls.write(streamId, bytesBase64)
Pebble.host.tls.close(streamId)
Pebble.host.timer.after(milliseconds, callback) -> timerId
Pebble.host.timer.cancel(timerId)

Pebble.host.x86.create({ architecture: "x86_64" }) -> machineId
Pebble.host.x86.map(machineId, address, size, permissions)
Pebble.host.x86.read(machineId, address, size) -> base64
Pebble.host.x86.write(machineId, address, bytesBase64)
Pebble.host.x86.getRegisters(machineId, names) -> generic register map
Pebble.host.x86.setRegisters(machineId, genericRegisterMap)
Pebble.host.x86.run(machineId, { start, stop, breakpoints, instructionLimit, timeoutMillis })
  -> stopped | breakpoint | fault
Pebble.host.x86.destroy(machineId)
```

All asynchronous callbacks must be queued through the existing ordered JS-eval pump. A session
close cancels HTTP, WebSocket, timers, and TLS streams, destroys ephemeral keys, and destroys every
machine. The executor API must contain no binary hash, entrypoint, import name, hardware property,
Apple string, or protocol-specific status. JS handles a breakpoint by interpreting the generic stop
result, dispatching the protocol-specific hook, updating generic memory/register state, and
resuming; native code never calls protocol code reentrantly.

### 5.5 Platform implementation notes

- Android minSdk is 26, while the public `SSLParameters.setApplicationProtocols` API is 29.
  First test courier raw-mode operation without ALPN on API 26-28. If the server requires ALPN,
  use a generic Conscrypt-backed stream for those versions rather than raising minSdk.
- iOS 15.6 can use Network.framework with TLS/TCP options and caller-supplied ALPN/trust settings.
- Android uses JCA/KeyStore and iOS uses Security.framework for generic RSA/P-256 operations.
- Probe RSA-1280 generation/import and required SHA-1 operations on both minimum OS versions before
  selecting non-exportable platform keys. Fall back to an encrypted software key only when needed.
- Native ECDSA APIs may emit DER while RustPush's NGM fields use fixed-width raw `r || s`. The host
  API needs an explicit signature format, with conversion tested independently.
- BigInt SRP starts in JS. Benchmark SRP-2048 on the real JavaScriptCore and WebView runtimes. Add a
  generic unsigned-big-integer `modPow` primitive only if the measured runtime is unacceptable.

## 6. JavaScript package layout

Source remains ordinary JavaScript with JSDoc types. A deterministic bundler produces the single
PBW `plugin.js`; TypeScript is not required.

```text
imessage/
  src/
    plugin-entry.js           # production dependency assembly and Pebble registration
    plugin-controller.js      # config/action validation and public error mapping
    runtime/
      bytes.js                # Uint8Array/base64/hex/UTF-8/endian helpers
      effects.js              # injected clock, RNG, network, crypto, storage, tracing
      errors.js
    codecs/
      xml-plist.js
      binary-plist.js
      gzip.js
      asn1.js
      protobuf.js             # only the few IDS/NGM messages required
      aps-raw.js
      aps-packed.js
    state/
      state-schema.js
      durable-state-repository.js
      state-migrations.js
    anisette/
      remote-v3.js
      remote-v3-runner.js
    apple-account/
      srp.js
      login.js
      two-factor.js
      delegates.js
    aps/
      bag.js
      push-bootstrap.js
      client-runner.js
      courier-session.js
      raw-courier.js
    ids/
      request-signing.js
      authentication.js
      registration.js
      lookup.js
      identities.js
      send-envelope.js
    imessage/
      plain-text.js
      send-coordinator.js
  test/
    unit/
    differential/
    replay/
    engine/
    live/
  harness/
    js-runner/
    rust-oracle/
    fixtures/
  plugin.js                  # generated, committed PBW artifact
```

No source module may reach a global clock, RNG, network, crypto provider, or storage object directly.
It receives an injected `effects` object so tests can control every nondeterministic input.

## 7. Persistent state and security

### 7.1 Versioned state

The plugin stores a versioned envelope in secure plugin storage:

```text
version
hardware
  ExtractKey fields and optional generated/captured validation data
push
  token, certificate, generic private-key ID
anisette
  keychain identifier and provisioned adi_pb
ids
  user IDs, auth certificates/key IDs, registrations and handles
identity
  legacy signing/encryption key IDs and public identity
  NGM device/prekey key IDs and public data
cache
  recipient delivery identities, expirations, environment hashes
  NGM per-identity message counters
registration
  registered-at time, heartbeat/expiration, data-schema hash
```

The bootstrap PKCS#8 private key, pending password, password hash, SRP ephemeral, PET exchange, and
2FA code are memory-only. The finished JS state contains the APNs certificate/token and opaque host
key ID needed to restore and send, never the bootstrap private-key bytes or password.

### 7.2 Transaction rules

- Immediately after importing or generating a persistent key, synchronously stage its opaque ID as
  a durable cleanup obligation before any network await. Promote that record to active in the same
  pending/committed generation that publishes the protocol artifact. A restarted JS session deletes
  any staged key whose artifact was never published before attempting activation again.
- For APNs bootstrap, commit the certificate/token and opaque key ID only after the host import
  succeeds; clear the PKCS#8 input on every success, failure, timeout, and cancellation path.
- On failure before commit, delete newly created key IDs and only then acknowledge their durable
  cleanup records; deletion and acknowledgement are both safe to retry after interruption.
- Increment and persist an NGM counter before constructing/sending its ciphertext. A crash may skip
  a number but must never reuse one.
- Persist new APNs tokens, registrations, and refreshed recipient keys before reporting success.
- Use a pending/committed generation marker so interrupted multi-value updates recover cleanly.
- `disconnect` closes live transports, clears secure storage, and deletes every plugin-owned key ID.
- Never put credentials, tokens, private material, message text, or full network bodies in logs.

### 7.3 Credential transfer for development

Do not paste Apple credentials, 2FA codes, the combined Mac/RustPush bootstrap token, its APNs
private key, or RustPush state into a Codex chat. Put them in a mode-0600 file outside the repository,
or enter the combined token through the local app config page. The harness accepts a path supplied
through an environment variable and redacts that path and all secret values from output.

Live response recordings remain encrypted outside Git. Committed fixtures use synthetic keys and
accounts only. A secret scanner must run over the diff and built PBW before every commit.

## 8. Differential harness

The harness is the first deliverable, not cleanup after the port.

### 8.1 One operation model

Both implementations expose the same test-only operation protocol:

```text
start(operation, persistedState, deterministicInputs)
step(inputEvent) -> [observableEffect...]
snapshot() -> canonicalState
```

Observable effects are:

- random-byte request/result;
- clock read or timer deadline;
- crypto operation and non-secret result metadata;
- HTTP request/response;
- WebSocket open/frame/close;
- TLS open/negotiated-ALPN/write/read/close;
- storage read/write/delete;
- state transition;
- terminal result/error.

The controller owns real I/O in differential mode. It asks Rust and JS for their next effect,
compares them, executes one network effect, and feeds the same response bytes to both. This avoids
double-sending and makes the first divergence the test failure.

### 8.2 Rust oracle seam

The pinned Rust tree currently calls global time/RNG/network objects directly and keeps many useful
encoders private. Add a desktop-only `port-oracle` feature/overlay that:

1. exposes the send-only pure encoders/decoders and request builders;
2. substitutes injected clock, RNG, HTTP, WebSocket, TLS, storage, and software-key providers only
   when the feature is enabled;
3. emits the common observable-effect protocol;
4. imports deterministic software test keys;
5. is never compiled into Android or iOS release artifacts.

Default RustPush production behavior must remain unchanged. Oracle patches are reviewed as test
infrastructure and kept small enough to rebase onto the pinned revision reproducibly.

Where OpenSSL ECDSA randomness prevents identical signatures, the comparator verifies the decoded
fields, public-key validity, signature validity, and plaintext/ciphertext relationship rather than
requiring identical signature bytes. RSA PKCS#1 v1.5 signatures, codecs, hashes, KDF outputs, and
framing should normally compare byte-for-byte with fixed inputs.

### 8.3 Harness modes

1. **Known-answer mode:** standards vectors and synthetic vectors for individual primitives.
2. **Rust differential mode:** deterministic Rust-vs-JS pure functions and state machines.
3. **Fake-server mode:** scripted HTTP/WebSocket/APNs peer, including fragmentation and errors.
4. **Encrypted replay mode:** local credential-derived responses replayed without Apple traffic.
5. **Live lockstep mode:** one controller connection/request is observed by both implementations.
6. **Live single-writer mode:** Rust or JS alone performs the final mutating register/send step.

The harness never lets Rust and JS both submit the same message. Before the send boundary, both
produce and compare the candidate APNs payload. One selected implementation writes it.

### 8.4 Fixture taxonomy

| Fixture class | Git | Contains |
|---|---:|---|
| Standards KAT | yes | public RFC/NIST inputs and expected outputs |
| Synthetic protocol | yes | generated keys, plist/protobuf/APNs frames, fake responses |
| Structural trace | yes | redacted field names, sizes, hashes, state transitions |
| Real response replay | no | encrypted local Apple responses and credential artifacts |
| Password/2FA | never | interactive or ephemeral process memory only |

Every fixture declares oracle commit, fixture schema, deterministic seed, clock, expected phase,
and whether exact-byte or semantic comparison applies.

### 8.5 Tests at every layer

- **Bytes:** base64/hex, endian integers, UUIDs, UTF-8 including emoji and combining characters.
- **Plist:** XML and binary scalars, data, dates, dictionaries, canonical key handling, malformed data.
- **Compression:** gzip headers, deterministic timestamp behavior, fragmented input, corrupt streams.
- **ASN.1/CSR:** RSA public keys, PKCS#10 structure, X.509 extraction, odd RSA sizes.
- **Protobuf:** NGM prekey, inner message, outer message, unknown fields, truncation.
- **Crypto:** standard KAT plus Rust-generated synthetic vectors for every exact composition.
- **APNs:** raw and packed caches, fragmented frames, connect/filter/notification/ack/ping/pong.
- **Account:** SRP transcripts, cookies, duplicate token headers, trusted/SMS 2FA state transitions.
- **IDS:** signed request payloads, registration parsing, lookup tunnel, error/status mapping.
- **Message:** exact simple-text bplist/gzip, NGM and fallback encryption, bundle construction.
- **State:** crash at every commit point, counter monotonicity, corrupt/missing key, disconnect cleanup.
- **Plugin:** existing recipient/text tests plus full mocked configure/2FA/restart/send flows.
- **Engine:** execute the exact generated PBW bundle in Node, Android WebView, and iOS JavaScriptCore.
- **Live:** credential restore, fresh login, one email send, one phone send when available, cold restart.

Parsers receive fuzz/property tests with bounded input and explicit allocation limits. Network
fixtures deliberately split every possible frame boundary because TLS reads do not preserve writes.

### 8.6 Definition of “tested at every step”

A port step may merge only when:

1. it has committed synthetic fixtures;
2. the JS implementation passes unit and malformed-input tests;
3. the Rust oracle agrees byte-for-byte or via a documented semantic comparator;
4. the bundled artifact passes Node plus both mobile JS-engine tests for that surface;
5. replay/fake-server tests cover success, timeout, malformed response, and server error;
6. no secret appears in source, fixture, log, test report, or PBW;
7. the next layer consumes this implementation rather than a parallel test-only rewrite.

## 9. Roadmap and gates

These are dependency-ordered engineering milestones, not calendar promises. A milestone is complete
only at its exit gate.

### M0 — Freeze and prove the current baseline

Deliverables:

- pin the Rust oracle and nested Apple-auth revision in the harness metadata;
- document the exact send-only call graph and the local captured-validation patch;
- add structured, redacted tracing to the current wrapper;
- with real credentials, prove the existing Rust-backed APK can configure, restore after restart,
  send one sentinel message, and receive human confirmation on the destination device.

Exit gate: a reproducible baseline trace exists. If the current prototype cannot send with the
provided credentials, diagnose that before treating its operation-level behavior as the baseline.

### M1 — Build the oracle/harness skeleton

Deliverables:

- common operation/effect/trace schemas;
- Node JS harness adapter;
- desktop Rust `port-oracle` adapter;
- deterministic clock/RNG/software-key providers;
- fixture validator, redactor, secret scanner, and exact/semantic comparators;
- fake HTTP, WebSocket, and fragmented TLS peers.

Exit gate: a trivial injected HTTP/TLS workflow runs in lockstep without credentials, and an
intentional one-byte JS divergence points to the exact effect and byte offset.

### M2 — Add generic CoreApp host capabilities

Deliverables:

- generic plugin permission schema for HTTP/WSS/raw TLS domains and ports;
- ordered binary HTTP response API with duplicate headers and UUID-scoped cookies;
- generic WebSocket and duplex TLS interfaces with cancellation and backpressure;
- generic crypto/key-vault and timer interfaces;
- Node, Android, iOS implementations of the same JS contract;
- local TLS echo/ALPN/trust tests and crypto KATs on Android API 26/current and iOS 15.6/current.

Exit gate: the same Apple-free conformance bundle passes all three runtimes; host source passes the
forbidden-literal boundary scan; session teardown leaves no sockets, jobs, timers, or ephemeral keys.

### M3 — Port bytes, codecs, and cryptographic compositions

Deliverables:

- byte/UTF-8 utilities independent of browser-only APIs;
- XML/binary plist subset, deterministic gzip, ASN.1/CSR subset, protobuf subset;
- APNs raw/packed framing and incremental parser;
- account, request-signing, legacy-pair, and NGM crypto composition helpers;
- Rust-derived synthetic fixture corpus.

Exit gate: all deterministic codec and crypto outputs match the oracle; semantic signature tests
pass in Node and both mobile engines; fuzz tests terminate within limits.

### M4 — Port APNs bootstrap and courier state machine

Deliverables:

- bag parsing/cache;
- exact Corten ExtractKey parsing and legacy combined-bootstrap compatibility;
- generic persistent RSA-1024 generation plus session-only import for the shared FairPlay signing
  key; JS CSR, Albert activation, response-certificate validation, and key cleanup;
- tokenless courier bootstrap that obtains and persists the first 32-byte APNs token;
- a bounded initial authentication wait that closes the courier and deletes its unpublished key on
  timeout, plus a tested clean retry path;
- courier TLS negotiation, raw/packed connect, token restore/generation, filter, ack, ping/pong;
- request correlation and fragmented read handling;
- push state persistence and reconnect behavior within one operation.

Exit gate: fake-server tests cover activated, legacy-imported, and restored push state. With the
exact ExtractKey token, JS persists no PKCS#8 bytes and completes a live courier handshake on
Android and iOS without sending a user message.

### M5 — Bootstrap sending from imported Rust state

This milestone intentionally proves the risky IDS/message path before full Apple login is ported.

Deliverables:

- encrypted harness export/import format for a successful Rust sign-in;
- JS restoration of IDS auth registrations, local identities, and counters alongside the already
  imported product APNs bootstrap;
- sender-handle selection and lazy registration-validity checks;
- full IDS/identity state import is harness-only unless an explicit product migration is approved;
  the narrower APNs certificate/key/token bootstrap is the explicit prototype product contract.

Exit gate: JS restores the exported state, reconnects to APNs, and can perform a non-mutating IDS
lookup for the authorized test recipient on both platforms.

### M6 — Port IDS lookup, encryption, and plain-text send

Deliverables:

- signed IDS query through APNs web tunnel;
- target cache and expiration handling;
- simple-text bplist/gzip builder;
- NGM `pair-ec` encryption and legacy `pair` fallback;
- per-target bundle, command-100 submit, command-255 correlation, refresh/retry rules;
- counter-before-send persistence and current plugin error mapping.

Exit gate: live single-writer JS sends exactly one sentinel message from imported state; the receiving
device displays the exact text; the plugin returns only after correlated success. Repeat across a
cold restart and for email/phone handles when both are available.

### M7 — Port Anisette, Apple ID login, 2FA, and IDS registration

Deliverables:

- remote Anisette v3 provision/restore entirely in JS over the generic transports;
- GrandSlam SRP init/complete, cookie handling, SPD decryption, token parsing;
- trusted-device and SMS 2FA state machines;
- compatibility-first JS NAC validation-data generation from ExtractKey hardware fields by executing
  the hash-pinned x86-64 image used by historical Corten, tested against a deterministic Corten
  oracle before credentialed use; a clean-room cryptographic rewrite is explicitly deferred;
- setup v2 IDS delegate login;
- IDS auth RSA/CSR exchange;
- legacy/NGM identity generation and registration;
- lazy re-registration using persisted validation/auth material.

Exit gate: starting with empty durable plugin state and an exact ExtractKey token, the config
page reaches `needsTwoFactor` or `ready`, finishes registration, survives app restart, and completes
the M6 live send tests without importing Rust IDS/identity state. Bootstrap PKCS#8, password, and 2FA
values are absent from persisted JS state and logs.

### M8 — Integrate, cut over, and remove production Rust

Deliverables:

- PBW build bundles the modular JS implementation into the exact tested `plugin.js`;
- config UI exposes stable progress and actionable errors without protocol details;
- Android and iOS tests load the PBW through the real plugin registry;
- release/debug size and memory comparison;
- remove `_IMessageNative`, JNI/C bridge, Rust `.so`/`.a`, Gradle native module, and production Rust
  build tasks only after the rollback gate;
- retain desktop oracle/harness outside the shipped app.

Exit gate: the complete Release 1 acceptance suite passes on an Android emulator/real device and an
iOS simulator/real device. A clean build contains no RustPush native library and still sends.

### M9 — Send-only hardening after parity

Deliverables:

- registration expiration/heartbeat scenarios and forced server re-register commands;
- retry/backoff and network-transition tests;
- state corruption recovery and key-orphan cleanup;
- performance profiles for SRP, key generation, plist, reconnect, lookup, and send;
- decide from measurements whether a resident generic plugin actor is necessary.

This milestone does not add receive, sync, attachment, or group features.

## 10. Release 1 acceptance suite

Release 1 is done only when all of the following hold:

- Empty state shows disconnected; pending 2FA shows needs-two-factor; committed state shows ready.
- Invalid token, Apple credentials, 2FA, recipient, and empty message return stable non-secret errors.
- Trusted-device and SMS 2FA fixture flows pass; the available real-account path passes live.
- Disconnect removes secure state and every plugin key and causes the next send to return auth-required.
- Restart after registration needs no password and can send.
- One email and one E.164 phone recipient work when the test account makes both address types available.
- Unicode plain text, leading/trailing spaces, emoji, and line breaks arrive exactly.
- A recipient with NGM uses `pair-ec`; a synthetic legacy fixture verifies `pair` fallback.
- Recipient lookup with no valid target fails without submitting a message.
- APNs failure/timeout cannot be reported as sent.
- A counter cannot be reused after crash/retry/restart.
- No incoming message is decrypted or stored.
- Node, Android WebView, and iOS JavaScriptCore run the exact built bundle.
- KMP/platform host code contains no iMessage-specific constant or policy.
- The release APK/app has no RustPush native binary.
- Repository, build outputs selected for commit, logs, and PBW pass the secret scan.

## 11. Risks and mitigations

| Risk | Mitigation / decision gate |
|---|---|
| Private Apple protocol drift | Pin oracle and fixture provenance; isolate constants/schemas; do not follow RustPush main during the port |
| Current Rust baseline is not live-proven | M0 blocks the port's live assumptions until one confirmed send |
| Public FairPlay credential is shared and expired | Match the known-working Corten prototype only for this first non-commercial test; verify live once, keep the activation module replaceable, and retain legacy bootstrap import as an escape hatch |
| Portable APNs bootstrap leaks a private key | Mode-0600 local transfer; import PKCS#8 once into plugin-scoped generic key storage; clear input on every path; persist only opaque key ID; scan logs/state/PBW |
| Raw APNs TLS/ALPN differs by OS/API | M2 conformance and M4 no-message live handshake; API 26 raw-mode/Conscrypt gate |
| HTTP bridge loses cookies/duplicate headers | Replace with ordered, plugin-scoped generic transport before account work |
| JavaScript session is one-shot | Transient courier per operation; persist all resumable state; measure before adding a resident actor |
| SRP/crypto too slow in iOS JSC | Benchmark early; generic host acceleration only, keeping protocol composition in JS |
| RSA-1280/non-exportable key unsupported | Platform probe; encrypted generic software-key fallback |
| Binary plist/packed APNs edge cases | Differential byte fixtures, fragmentation tests, bounded fuzzing |
| NGM counter reuse after crash | Persist increment before encryption/submission and test every crash point |
| JS NAC emulation depends on a pinned Apple x86-64 image | Verify the full artifact with SHA-1 and SHA-256 plus the selected slice with SHA-256; never bundle it in the PBW; differential-test init/establish/sign against a deterministic historical Corten oracle; bound instructions, time, and memory; stop before consuming 2FA until validation is available |
| Remote Anisette service changes/fails | Encapsulate remote-v3 protocol in JS; replay tests; actionable auth error; no hidden host fallback |
| Apple throttles repeated login/registration | Reuse one test state, keep live tests manual, never run credential tests in ordinary CI |
| Live test double-sends | Harness single-writer rule and explicit send-boundary assertion |
| Secret leakage through traces | sensitivity-aware trace schema, hashing/redaction, encrypted local fixtures, pre-commit secret scan |

## 12. Inputs needed for credentialed milestones

The offline work through M3 does not need real credentials. M0/M4 and later need:

1. the exact JSON/base64 activation token emitted by the pinned Corten-Matrix `ExtractKey.app`;
2. for M5 differential work, either the rest of that successful Rust sign-in state export or
   authorization to create one locally;
3. the sender Apple ID password entered locally, plus the interactive 2FA code for the fresh-login gate;
4. one explicitly authorized recipient email or E.164 phone number and a device/person able to
   confirm receipt;
5. permission to send clearly labeled sentinel messages and the maximum number allowed;
6. for final validation, access to one supported Android device/emulator and one iOS device, with
   iOS builds run separately to respect machine-memory limits.

The recommended sentinel is a unique non-secret string such as
`CoreApp JS iMessage port test <UTC timestamp> <short nonce>`. It lets a human distinguish retries
without exposing credentials.

## 13. Decisions to settle before implementation

1. Decide whether product builds need migration from the current Rust-encrypted prototype state, or
   whether prototype users may disconnect and sign in again. Harness import remains required either way.
2. Approve the generic raw-TLS/network permission shape for third-party plugins.
3. Confirm the live recipient(s), sentinel-message budget, and whether both email and phone forms can
   be exercised.
4. Decide whether the Anisette remote service is acceptable for Release 1 or whether a full supplied
   Rust sign-in state is allowed for the first IDS bootstrap. Fresh Apple ID/IDS login parity still
   requires Anisette and NAC orchestration in JS under the current boundary.

## 14. First implementation slice after approval

The first code change should contain no iMessage port logic. It should add:

1. the common harness schemas and JS runner;
2. deterministic bytes/clock/RNG adapters;
3. a tiny Rust oracle command for one existing pure encoder;
4. one intentionally fragmented fake TLS exchange;
5. Node plus Android/iOS engine tests that prove the same generated JS consumes the same effects.

That slice proves the testing architecture and the generic boundary before any credential or protocol
work accumulates on top of it.
