# What's Playing

A Pebble watchapp that identifies the music around you. The watch streams its
microphone to the phone for up to ten seconds; the phone-side JavaScript sends
the PCM to [sirensong](https://github.com/coredevices/sirensong), our proxy for
the AudD recognition API, and the watch shows the title, artist and album. The last ten matches are kept on
the phone and listed on the watch's main screen.

Targets: **emery** (Pebble Time 2), **flint** (Pebble 2 Duo), **gabbro**
(Pebble Round 2). Requires an SDK with the `MicStream` API (revision 110 or
later) and a phone app that decodes the stream into `audiostream` events.

## Controls

Main menu

| Button | Action |
|--------|--------|
| UP / DOWN | Move between **Identify** and the history rows (newest first) |
| SELECT on **Identify** | Start listening |
| SELECT on a history row | Show that match's card |
| BACK | Leave the app |

Card

| State | SELECT | UP / DOWN | BACK |
|-------|--------|-----------|------|
| Listening… (countdown) | After 3 s: stop and identify what was captured so far. Before 3 s: ignored | – | Back to the menu (the stream stops; if the phone already had 3 s it still identifies and the history updates) |
| Identifying… | – | – | Back to the menu |
| Result / No match / Error | Start a new listen | Scroll long titles | Back to the menu |

The countdown shows `10 − seconds the phone has actually received`, driven by
`SECONDS` messages from pkjs. The watch enforces the 10 s limit with its own
timer and stops the stream itself.

While streaming, the firmware draws its own "Listening" banner and shrinks the
app's unobstructed area; the card lays itself out from
`layer_get_unobstructed_bounds()` and redraws when the area changes. The app
draws no microphone indicator of its own.

## Recognition service

There is nothing to configure. pkjs posts the audio to sirensong at
`https://sirensong.cluster.repebble.com/v1/recognize` (`SIRENSONG_URL` in
`src/pkjs/index.js`). sirensong holds the AudD API token, so no token ships in
this app, and it rate-limits per client IP.

The request is JSON:

```json
{"audio": "<base64 PCM>", "format": "pcm", "sampleRate": 16000, "channels": 1, "bitsPerSample": 16}
```

sirensong wraps the PCM in a WAV header, calls AudD and answers with
`{"status":"match","title","artist","album","releaseDate","songLink",…}`,
`{"status":"no_match"}` or `{"status":"error","error":"<code>"}`, using the
same JSON shape on every HTTP status. The full contract is in the sirensong
README.

The body is plain ASCII (base64 inside JSON), so it works with any pkjs
`XMLHttpRequest`, including runtimes that cannot send binary bodies. This costs
about a third more upload: ten seconds of 16 kHz audio is a 427 KB request.
`btoa` is used when available, with a pure-JS encoder as a fallback.

**Tested:** `test/pkjs_harness.js` checks the phone-side pipeline (ArrayBuffer
PCM → base64 JSON → response → AppMessage sequence) against the built bundle,
using a fake `Pebble`, a fake audio stream and a fake `XMLHttpRequest` that
returns canned sirensong responses. The request it produces was also replayed
against a local sirensong container with a fake AudD. The app has **not** yet
been run against the deployed service or on real hardware; see the test plan
below.

## Messages

Every message carries `CMD`. Values are defined in `src/c/whatsplaying.h` and
mirrored in `src/pkjs/index.js`.

| CMD | Direction | Keys | Meaning |
|-----|-----------|------|---------|
| 1 `Hello` | watch → phone | – | Please (re)send the history |
| 2 `History` | phone → watch | `INDEX`, `TOTAL`, `TITLE`, `ARTIST`, `ALBUM` | One history row; `TOTAL = 0` clears the list |
| 3 `Progress` | phone → watch | `SECONDS` | Seconds of audio received so far |
| 4 `Identifying` | phone → watch | – | HTTP request in flight |
| 5 `Result` | phone → watch | `TITLE`, `ARTIST`, `ALBUM` | A match (the watch vibrates) |
| 6 `NoMatch` | phone → watch | – | The service found no match |
| 7 `Error` | phone → watch | `ERROR` | `Too short`, `Network error`, `Timed out`, `HTTP <status>`, `Bad response`, or a sirensong error (see below) |

pkjs queues outgoing messages and sends the next one only after the previous
one was acknowledged (or given up on after three attempts). Strings are clipped
so every payload stays well under 1 KB.

sirensong error codes are shown on the watch as follows:

| sirensong `error` | Watch text |
|-------------------|------------|
| `rate_limited` | Busy, try again in a minute |
| `bad_audio` | Could not process the audio |
| `too_large` | Recording too large |
| `no_audio` | No audio received |
| `upstream_timeout` | Timed out |
| `upstream_error`, `upstream_unavailable`, `upstream_bad_response` | Service unavailable |
| anything else (a malformed request from this app) | Error: `<code>` |

## Building

```sh
pebble build     # builds emery, flint, gabbro -> build/whatsplaying.pbw
node test/pkjs_harness.js   # optional: exercises the built pkjs bundle in Node
```

The `pebble` block in `package.json` declares `manifestVersion: 2` and:

```json
"usesPermissions": [
  "Microphone",
  { "name": "Internet", "parameters": { "domains": ["sirensong.cluster.repebble.com"] } }
]
```

`Microphone` covers watch audio streaming; the scoped `Internet` permission
covers uploads to sirensong. The phone reviews these permissions when installing
or updating the app, according to its permission policy. Permission enforcement
is currently active only when experimental plugins are enabled in the phone
app. Approve both on the app's page before identifying a song. If you change
`SIRENSONG_URL`, change the declared hostname too; an undeclared host triggers
a separate runtime approval request.

These fields must reach `appinfo.json` inside the PBW. The SDK copies the
`pebble` metadata into that file. For the first build after changing metadata,
run `pebble clean` before `pebble build` so the PBW is repackaged.

The existing `capabilities: ["microphone"]` remains, but does not grant the phone-side permissions. The SDK exposes `MicStreamStartResult`
and `MicStreamStopReason`, without an `AppPermission` service. Phone refusal,
disconnection or a phone-initiated stop is reported as
`MicStreamStopReasonPhone`. The app cannot query permission state or distinguish
permission denial from these other phone-side failures; SELECT retries after
approval on the phone.

## Project layout

```
src/c/whatsplaying.h   shared constants, CMD values, module interfaces
src/c/main.c           AppMessage in/out, history mirror
src/c/menu_window.c    main menu: Identify + history rows
src/c/card_window.c    listen / identify / result / message card; the only file using the mic API
src/pkjs/index.js      audio collection, HTTP to sirensong, history
test/pkjs_harness.js   Node smoke test for the built pkjs bundle
```

## Test plan (hardware)

1. **Sideload** `build/whatsplaying.pbw` through a phone app that supports
   microphone streaming to PebbleKit JS.
2. **Phone refusal.** If the phone refuses the stream, the card shows
   *Listen ended / MicStreamStopReasonPhone*. Press SELECT to retry after
   resolving the phone-side issue.
3. **Unavailable microphone.** On a watch without a microphone, a start
   returns `MicStreamStartErrUnavailable`; the card shows *Can't listen* with
   that diagnostic.
4. **Identify.** Play a song near the watch, press SELECT on **Identify**. The
   watch shows *Listening…*, the firmware's "Listening" banner appears at the
   bottom, the countdown falls as the phone receives audio. After 10 s (or on
   SELECT after 3 s) the card shows *Identifying…* and then the title, artist
   and album with a short vibration, within a few seconds.
   Phone log: `audiostreamstart`, `audiostreamstop after 10.0 s (320000 bytes)`,
   `POST https://sirensong.cluster.repebble.com/v1/recognize (320000 byte PCM,
   426746 byte body)`, `HTTP 200 {"status":"match",…}`, `Match: …`.
5. **History.** Press BACK: the new match is the first row under **Identify**.
   Relaunch the app: the rows are still there (sent on `ready`). Select a row:
   its card opens. After ten matches the oldest drops off.
6. **Early stop.** Start a listen and press SELECT at ~5 s: the card goes to
   *Identifying…* immediately and the phone log shows ~5 s of audio.
7. **Focus lost.** Start a listen and have a notification arrive. The watch
   log shows `Stream stopped: FocusLost`; the card reads *Listen ended /
   MicStreamStopReasonFocusLost*. If 3 s or more had been received the phone
   still identifies and the card updates to the result when you return to the
   app; otherwise the phone sends *Too short*.
8. **Too short.** Start a listen and have a notification arrive within 2 s:
    the card shows *Error – Too short*.
9. **No match / rate limit.** Listen in silence: *No match*. Identify more
    than ten times in a minute: *Error – Busy, try again in a minute*.
10. **Phone gone.** Disable Bluetooth on the phone and press **Identify**:
    within about 8 s the card shows *Listen ended / MicStreamStopReasonPhone*.

## Known limitations

- The app was built and unit-tested (pkjs) but not run on hardware or against
  the deployed sirensong service in this environment.
- History rows carry title, artist and album to the watch; `time` and
  `song_link` are stored on the phone only, as there is no message key for them.
