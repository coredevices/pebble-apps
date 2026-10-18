# Bundled x86 interpreter

The iMessage JavaScript runtime executes the pinned Apple validation image through
Blink compiled to Wasm. Android and iOS use the same JS/Wasm artifacts; there is no
native x86 bridge or fallback. Android executes in its existing WebView runtime.
iOS delegates validation to a temporary WebKit JavaScript worker; JavaScriptCore
still handles the rest of the plugin.

## Build

Use Emscripten **4.0.11**, initialize the pinned Blink submodule, then run:

```sh
npm run build:wasm -- --test
npm run check:wasm
npm test
```

Run these commands from `imessage`. The checked-in single-file
artifacts avoids an Emscripten dependency in ordinary CI/mobile builds. Both plugin
bundlers verify source/output hashes before packaging. Rebuild after changing
the interpreter, patch, headers, or build settings. Blink is ISC licensed;
see `LICENSE.blink`. Its source revision and all build-input hashes are in
`manifest.json`.

The old x86executor directories retain pinned source and C conformance fixtures
for this build, but are no longer Gradle modules or app dependencies.

Modern engines use Wasm exception handling for guest-fault recovery. Engines
without `WebAssembly.Tag` use the compatibility build with JavaScript exception
handling; it is slower. Both builds run the C conformance suite with `--test`.
The optimized builds use `-O3` and link-time optimization.

## Boundaries and lifecycle

- One Wasm instance per validation context, at most two live per provider.
- 64 MiB mapped guest memory; 256 MiB maximum Wasm linear memory.
- Read/write/execute permissions, bounded instruction/time/trap counts.
- Guest syscalls cannot access the host.
- Entropy comes from the existing generic host crypto API.
- Destroy zeroes Wasm linear memory and drops the instance for garbage collection.
- The Apple image is fetched and hash-verified separately; it is not packaged.
- Normal message sends do not allocate an interpreter.

## iOS worker

The generic `_HostJsWorker` bridge only opens an isolated JavaScript context,
passes JSON messages, and closes it. It contains no Apple/iMessage code.
Each worker uses an ephemeral WebKit data store, denies network resources with
CSP, and blocks navigation. A noninteractive, 1-pixel view stays attached while
the worker runs because iOS suspends detached WebKit views. It is removed when
validation finishes. Each bridge allows two workers and one request per worker;
requests time out after 210 seconds. Session shutdown closes every worker.

Hardware parsing, emulated macOS APIs, Apple validation, and the x86 interpreter
all run in bundled JS/Wasm. The parent validates the downloaded image hashes
before passing it to the worker.

## Verification

Unit tests exercise register arithmetic, trap/resume, memory transfer and guest
permissions, budgets, invalid instructions, and syscall containment. The NAC
parity harness compares the complete output with Corten using private local input
(no credentials or hardware tokens in source control).

Physical-device qualification on iPhone XS / iOS 18.7.10:
- Full Corten oracle parity in WebKit: 22–25 seconds, request and validation
  bytes exactly equal, including worker destruction.
- Full generated worker plus JSON transport parity on Node: 13 seconds.
- Plain JavaScriptCore arithmetic/conformance passes, but full validation is too
  slow there; production iOS therefore uses the WebKit worker.
- Android/iOS Kotlin compilation and signed physical-device app build pass.

This validates NAC computation, not a fresh Apple sign-in or message delivery.
Older OS releases still need device qualification.

To repeat the full generated-worker parity test with a private staged oracle vector:

```sh
node harness/wasm-worker-parity.cjs /path/to/private/local-input.json
```

The test checks both outputs byte for byte, random consumption, JSON transport,
and worker cleanup. Never commit its input.
