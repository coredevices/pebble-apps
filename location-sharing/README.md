# Location Sharing plugin

Reads the latest locations of people who already share with Google Maps.
The packaged plugin (`package.json`, `config.html`, generated `plugin.js`) lives in `pbw/`.

**Apple Find My is switched off for now.** It needs host features stock CoreApp doesn't give
plugins (raw TLS sockets with pinned trust, saved Mac keys, host crypto and timers). Its wiring is
commented out in `src/plugin-entry.js` and its settings section is hidden; the notes below describe
it for when it comes back. The Google half runs on stock CoreApp: plain `fetch` with text bodies,
`Pebble.secureStorage`, and no timers (request deadlines defer to the host's action limit).

Apple sign-in reuses the iMessage plugin's JavaScript implementation in `../chat/imessage/src`: Apple
account login, Anisette, APNs activation and NAC validation. NAC x86 execution runs inline in the
bundled Blink WebAssembly interpreter, so the plugin needs no native x86 executor, `CpuEmulation`
or `JavaScriptWorker` permission.

The host only provides `fetch`, `Pebble.secureStorage`, timers, WebSocket and TLS sockets, and `_HostCrypto`
random bytes. All plugin state is one `Pebble.secureStorage` entry (`src/runtime/secure-blob-storage.js`). `src/runtime/js-host-crypto.js` implements the rest of the `_HostCrypto` request
contract in JavaScript (`@noble/*` for hashes, AES and P-256; RSA on BigInt), keeping persistent keys
in that state under `js-host-crypto:opaque-key-v1:`. `src/runtime/fetch-http-provider.js`
replaces the iMessage XHR transport.

Find My needs the `com.apple.mobileme` delegate and its `mmeFMFAppToken`, which iMessage login does
not request, so `src/apple-account`, `src/configuration/coordinator.js` and `src/state` are forks
of the iMessage modules with the Find My artifact added. All other shared authentication and runtime
modules are required from `../chat/imessage/src` directly.

```sh
npm --prefix imessage ci
npm --prefix location-sharing ci
node location-sharing/scripts/build-plugin.mjs
node --test location-sharing/plugin.test.cjs location-sharing/test/*.test.cjs
```
