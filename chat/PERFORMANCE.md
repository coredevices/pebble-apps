# Chat native lifecycle and Simulator measurements

Measured on 2026-09-15 in the dedicated `coredevices.coreapp.chat-test` app:
iPhone 17 Pro Simulator, iOS 26.0, arm64, Debug, with the test transport restricted
to the one authorized iMessage room. These are one cold and one warm sample.
Physical-iPhone performance remains unmeasured. Full-account directory work is
measured separately below.

## How PKJS reaches Go

```text
PBW send_message action
  → Pebble.chat.request("send", …)
  → PluginNativeJsBridge (JavaScript promise / Kotlin coroutine)
  → ChatPluginApi (account, recipient and approval checks)
  → IosChatBackend (Keychain key, application data directory)
  → coreapp_chat_request (C ABI)
  → gomuks client (SQLite, encryption, HTTPS to Beeper)
```

`chat-native/build-apple.sh` builds Go with `-buildmode=c-archive`. Kotlin/Native
links that archive into CoreApp's framework. The C entry point exchanges JSON
with Kotlin, and Kotlin frees the returned C string after decoding it. Go runs
inside the CoreApp process. The Go runtime initializes when the framework loads;
the gomuks client opens lazily on the first native request, under a mutex.

## Lifetimes

- Each plugin action gets a fresh PKJS session, which is torn down afterward.
  Configuration keeps its JS session while open.
- The native gomuks client survives those JS sessions. Later calls reuse its
  database, crypto state and HTTP connections. Native calls run on Kotlin's IO
  dispatcher and are serialized. A host session protects the complete plugin
  operation, including status preflight and session restoration.
- Directory loading runs during setup and stops when the configuration closes
  or hides. Normal gomuks background sync is disabled. Emoji verification uses
  a temporary sync that excludes rooms.
- The client closes after two minutes without an operation while foregrounded.
  Backgrounding and memory warnings request immediate cleanup once active work
  finishes. An email-code or emoji-verification flow remains protected until it
  finishes, is cancelled or expires. Stale timers and older lifecycle
  notifications cannot override newer activity.
- iOS background tasks cover each complete operation and lifecycle cleanup;
  verification also retains its existing temporary background task. A background
  operation cleans up before ending its task. The OS controls suspension and
  termination; the idle timer does not extend background execution.
- Native `close` stops directory/verification work, closes the database and idle
  HTTP connections, and drops the client. Confirmed logout also removes the
  session database; interrupted cleanup resumes before another client opens.
  Idle/background cleanup preserves all session files and asks Go to release
  unused heap pages with `debug.FreeOSMemory()`. Closing a client leaves the
  linked Go runtime loaded.
- App termination releases the process. A later launch restores the session
  from the protected database and Keychain without another sign-in.

The mobile logout cleanup was corrected while reviewing this lifecycle. Local
fake-account tests cover closing the client, removing its session files,
restarting cleanup, preserving the test-room restriction, and starting a fresh
login. The shared live test identity was not logged out.

## Latency

| Measurement | Elapsed |
| --- | ---: |
| First PKJS send after app restart | **4,659.710 ms** |
| Gomuks initialization within that first send | **2,336.500 ms** |
| Native send after initialization | 2,150.957 ms |
| Next PKJS send, reusing the client | **1,676.355 ms** |
| Native portion of that warm send | 1,630.726 ms |
| Warm native status call | 0.031 ms |

The PKJS measurements include action-session creation, bridge calls, host checks
and the result callback. The initialization measurement restores an existing
verified session; it excludes CoreApp launch and initial Go runtime setup.
Both sends used distinct operation IDs and performed real encrypted room sends.
Timing ends when Beeper accepts the request, before downstream iMessage delivery
can be confirmed.

Network latency dominated. Initial versions and key-backup-version metadata
requests took about 0.56 s and 1.77 s respectively. The warm send's six HTTP
round trips totaled about 1.61 s: bridge-account state, selected-room state,
device-key lookup, encryption-key sharing and the encrypted room send. These
transport timings end at response headers. No old messages or backup room keys
were fetched.

## Memory

Snapshot immediately after the warm send, without forcing garbage collection:

| Metric | Value |
| --- | ---: |
| Go `HeapAlloc`: allocated Go heap objects | **2.4 MiB** |
| Go `HeapInuse`: heap spans in use | 5.3 MiB |
| Go `Sys`: memory obtained by the Go runtime | **17.8 MiB** |
| Go goroutines | 6 |
| Whole CoreApp physical footprint (`TASK_VM_INFO`) | **144.3 MiB** |

Go `Sys` includes runtime-managed heap, stacks and metadata; it is not a
measurement of physical resident memory. It excludes C allocations such as
SQLite and linked code. The whole-app footprint includes Kotlin, UIKit, PKJS
and every other CoreApp component. App startup overlapped this test, so the
change in its footprint cannot be attributed solely to gomuks. There is no
separate Go process whose RSS can be measured independently.

## Reproducing the measurement

### Idle policy validation

The final idle-policy build (`0c371ec66`) was measured separately with the same
one-room Simulator session. The real two-minute foreground timer fired; the
saved verified identity reopened successfully. Posted UIKit memory-warning and
background notifications also released the client. A new send after reopening
took **2,588.191 ms** through PKJS to Beeper acceptance, and retrying its operation
ID returned the same event without another send.

| Cleanup trigger | Cleanup time | App footprint before → after | Immediate reduction |
| --- | ---: | ---: | ---: |
| Two-minute foreground idle | 18.154 ms | 146.988 → 145.941 MiB | **1.047 MiB** |
| Memory warning | 1.020 ms | 149.644 → 149.378 MiB | 0.266 MiB |
| Background notification | 4.432 ms | 157.113 → 156.347 MiB | 0.766 MiB |

These are immediate snapshots, not steady-state whole-app comparisons. The
earlier idle sample returned 0.516 MiB. The savings are modest for one room;
closing gomuks does not unload the linked Go runtime or reclaim all Go `Sys`.
Post-cleanup stacks contained only the measuring call and native-thread bridge
bookkeeping, with no retained gomuks database or network goroutines.

A separate UI test clicked **Send message**, then immediately pressed Simulator
Home. Beeper accepted that send (native send: 1,645.169 ms), and background
cleanup followed it. Returning to CoreApp showed the cleared message field.
Already queued settings refresh calls also completed and released their clients;
the background app stopped making requests afterward. Physical-device
suspension and memory-pressure behavior remain unmeasured.

Reproduce the automated portion with `--lifecycle` and a fresh operation ID on
`run-simulator-smoke.py`. It sends one message, waits for the real idle deadline,
and checks session restoration, memory/background cleanup, and deduplication.
The tested Simulator archive SHA-256 was
`26f952ae1d57872642180350d1a5d37072f586a8e7729436f5c7d100337fda5b`.

### Cold/warm send measurement

First establish the scoped session and approval using the normal Simulator
smoke test in [README.md](README.md). Add `--performance` and a new operation ID
to that runner to send two performance messages to the already approved test
room. The runner rejects IDs already present in the send journal. It restarts
the app, then runs cold and warm actions through the real bundled PBW.

Test builds write `performance-result.json`, `performance-calls.jsonl` and
`performance-network.jsonl` in the plugin's protected application directory.
The hooks record timings, memory, methods and endpoint paths, without tokens,
query strings or message bodies. Production builds omit these hooks.

The measured native archive SHA-256 was
`db891ccd9afb8e8d71fabb90b5dda17b7e29750ea6640237df04d8443b3e6dca`,
before the subsequent logout cleanup fix. Private raw results and network
audits are retained in the ignored `.local/chat/` directory.

## Full-account directory

The initial directory fetch is a single gzip-compressed metadata snapshot. It
begins immediately after sign-in, independently of emoji verification. The
parser processes one room at a time and commits batches of 25 to an indexed
SQLite cache. UI requests return at most 25 rooms and replace the previous page.
A completed snapshot is cached for 24 hours; **Refresh chat list** starts another
snapshot. Sending still refreshes only the selected room and its device keys.

A read-only Beeper probe on 2026-09-15 found **8,773 joined rooms** and **91,055
membership state events**. The gzip response completed in **66.378 seconds** and
expanded to about **122 MiB**. Wire-compressed size was not measured. Beeper
ignored some state-field filters and returned extra state and device events;
the parser discards those fields, never acknowledges device events, and observed
**zero timeline events**. There are no per-room fetches during directory loading.

Parsing that saved response locally, while the Simulator compiled, took
**22.54 seconds**, with **20.38 MiB** peak allocated Go heap (**18.80 MiB** above
baseline). The resulting indexed directory database was **36.48 MiB**. These
are desktop parser measurements, excluding network, Contacts matching and the
CoreApp UI; they are not an iPhone memory measurement.

Initial download and indexing are proportional to the number of rooms and
members. Constant network request count does not make the whole operation O(1).
Later pages use a DM/activity/room-ID cursor and indexed local search. Contact-name phone
matches share one paginated query, instead of issuing a separate query per
matching phone number.

### Installed Simulator snapshot

The dedicated Debug Simulator app loaded all **8,773 rooms in 171.206 seconds**
through one metadata request, including download and indexing. The production
Kotlin build ran concurrently, so this is a single development-machine sample,
not an isolated benchmark. There were **zero per-room state requests** for
loading, searching and next-page browsing.

Periodic native-call samples observed up to **22.49 MiB allocated Go heap** during
loading; this is a sampled maximum, not a continuous peak. At completion, Go heap
was **11.89 MiB**, Go `Sys` was **46.64 MiB**, and whole-app physical footprint was
**243.86 MiB** (before snapshot: **203.63 MiB**). Whole-app changes also include
Kotlin, SQLite, Contacts matching and WebView work. Full-directory idle-release
savings and physical-device memory remain unmeasured.

No messages were sent during this test. The native database still contained one
send-related room record and zero message events; the directory table contained
8,773 records. The original six send-journal entries were unchanged.

### Recency index

Newest-first ordering adds no network calls: the timestamp is already in the
metadata response. An 8,000-room local fixture (with timestamp ties) paginated
all 320 pages in **48.36 ms** total inside Go, excluding host/UI overhead. Query
plans confirm an indexed cursor seek for subsequent unfiltered pages.

Parsing and paging the saved 8,773-room response with the recency index took
**2.65 seconds** locally with no concurrent native build, and the test database
occupied **37.07 MiB**. This is a desktop cache check, not an iOS/network latency
measurement. The earlier parser measurement ran under build load and is not a
controlled before/after comparison.

The installed Simulator's migration refresh took **124.635 seconds** for 8,773
rooms through one request. Reopening the cached list made no further snapshot
request. Periodic native-call samples reached **11.62 MiB allocated Go heap**;
at snapshot completion the Go heap was **2.54 MiB**, Go `Sys` was **38.69 MiB**,
and whole-app physical footprint was **262.57 MiB**. These are Debug Simulator
samples, not a controlled comparison or physical-iPhone measurement.

### DM-first ordering

DM priority is cached and indexed with activity and room ID. Updating an existing
recency cache backfills that priority locally, preserving the completed snapshot.
An 8,000-room mixed DM/group fixture traversed all 320 pages in **178.77 ms** inside
Go during concurrent native compilation. This sample excludes host/UI overhead
and is not a controlled comparison with earlier timings. The query-plan test
continues to show an index seek for subsequent unfiltered pages.
