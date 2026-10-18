# Offline Android NAC parity harness

This test-only harness compares the production JavaScript NAC implementation with the independent
Corten oracle while the pinned x86-64 image executes through the bundled Blink WebAssembly interpreter (the same implementation used on iOS).
It does not call the production login controller or install any network interface.

The repository contains the harness code, strict vector schema, and generated test JavaScript. It
does not contain the Apple binary, a certificate chain, a session-info response, validation output,
activation material, account credentials, or Mac identifiers.

## Local inputs

Prepare a local vector conforming to `vector.schema.json`. Its ExtractKey hardware, certificate,
matching session-info response, exact `arc4random` word list, and expected outputs must come from
one deterministic run of `../corten-nac-oracle` against the same pinned image. Run the oracle twice
and require byte-identical outputs before using the vector. Apple's public session endpoint rejects
fabricated Mac identities, so real ExtractKey hardware is required for this local parity run even
though no Apple account credentials are involved.

The capture command performs that procedure without Apple ID credentials. It reads one explicit
ExtractKey file through the production JavaScript parser, then uses the production JavaScript bag,
endpoint, request, binary-plist, and response logic to fetch one public certificate and exchange one
session request. All Apple URLs and HTTP policy stay
in JavaScript; the desktop oracle has no network dependency and only retains one native NAC context
between its `initialize_nac_validation` and `complete_nac_validation` messages. The command discovers
the exact deterministic random-word prefix, repeats the local oracle transcript byte-for-byte, and
creates a new mode-0600 vector file. It never overwrites a vector and never logs protocol bytes.

Build and test the desktop oracle first, then capture to a private path outside Git:

```sh
cd imessage/harness/corten-nac-oracle
cargo test --offline --locked
cargo build --release --offline --locked

cd ../..
NAC_BINARY_FILE=/absolute/local/path/IMDAppleServices \
NAC_ORACLE_FILE=/absolute/path/to/corten-nac-oracle/target/release/corten-nac-oracle \
NAC_HARDWARE_KEY_FILE=/absolute/private/path/extract-key.txt \
NAC_PARITY_VECTOR_FILE=/absolute/private/path/local-nac-vector.json \
  node harness/android-nac-parity/capture.mjs
```

The capture intentionally makes no automatic network retry. The hardware record and all generated
bytes remain private local test artifacts and must not be committed.

Both staging input paths are mandatory, absolute paths. The staging tool rejects symlinks, unknown
fields, noncanonical base64, malformed hardware, mismatched output lengths/digests, and any image that
does not match the pinned full-file SHA-1, full-file SHA-256, and x86-64-slice SHA-256. It never
searches for or downloads either input.

```sh
cd imessage
NAC_BINARY_FILE=/absolute/local/path/IMDAppleServices \
NAC_PARITY_VECTOR_FILE=/absolute/local/path/local-nac-vector.json \
  node harness/android-nac-parity/stage.mjs check

NAC_BINARY_FILE=/absolute/local/path/IMDAppleServices \
NAC_PARITY_VECTOR_FILE=/absolute/local/path/local-nac-vector.json \
  node harness/android-nac-parity/stage.mjs stage
```

`stage` writes one ignored, mode-0600 asset at
`libpebble3/src/androidDeviceTest/assets/nac-parity/local-input.json`. Without that asset the Android
instrumentation test skips. The pinned image remains absent from production resources and the PBW;
the local bytes can only enter a developer-built test APK.

Build the committed test-only bundle after changing the entrypoint or any imported production NAC
module:

```sh
node harness/android-nac-parity/build.mjs
git diff --exit-code -- ../../libpebble3/src/androidDeviceTest/assets/nac-parity/harness.js
```

The device test must run on an `arm64-v8a` Android emulator. Invoke the repository's focused
`libpebble3` Android device-test task only after staging local inputs, with Gradle's build and
configuration caches disabled for this private run. This harness never requires an account sign-in.

```sh
ANDROID_SERIAL=emulator-5554 ./gradlew :libpebble3:connectedAndroidDeviceTest \
  -Pandroid.testInstrumentationRunnerArguments.class=io.rebble.libpebblecommon.plugin.NacParityAndroidTest \
  --no-build-cache --no-configuration-cache --no-daemon
```

Remove local bytes immediately after the run. Cleanup requires an explicit `emulator-*` serial,
checks `ro.kernel.qemu`, refuses physical devices, uninstalls the instrumentation package, deletes
the staged source asset, and removes the complete generated `libpebble3/build` tree so renamed
intermediates or APKs cannot retain the hardware record:

```sh
NAC_PARITY_ANDROID_SERIAL=emulator-5554 \
  node harness/android-nac-parity/stage.mjs clean
```

The JavaScript runner verifies the image again through the real `_HostCrypto` bridge, imports the
production image parser, hardware mapper, foundation hooks, validation context, and strict HostX86
adapter, then performs init, establish, and sign on one persistent VM. It compares both outputs
byte-for-byte and checks their lengths and SHA-256 digests. The result returned to the Kotlin test
contains only the vector ID, lengths, hashes, and consumed random-word count.

Run host-only safety tests with:

```sh
node --test harness/android-nac-parity/*.test.*
```
