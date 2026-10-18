# Chat validation

Validated on 2026-09-15 from `codex/index-chat-plugin`.

## Automated checks

- Go fixture suite: real Olm/Megolm encryption, SAS verification and secret
  exchange, cancellation/restart/expiry, fresh email/code login and identity
  restoration, partial directory loading while a room is slow, bridge parsing, changing
  group membership, transport restrictions, and durable send deduplication.
- Kotlin common tests: account-bound approvals, removal, ambiguity, telephone
  aliases, forwarding approved-group semantics, and contact-derived names for
  unnamed groups while preserving explicit titles.
- JavaScript tests: literal send arguments, operation IDs, action failures,
  configuration method restrictions and configuration script syntax.
- Android and iOS arm64 Kotlin compilation, plus the complete iOS arm64 device
  framework link with the production Go backend.
- Signed iOS Simulator app build and native Go archive linkage.

## Live iOS Simulator integration

Device: iPhone 17 Pro, iOS 26.0, arm64. Dedicated app bundle:
`coredevices.coreapp.chat-test`. Existing normal CoreApp app data was preserved.
The unrelated iMessage Rust module used its existing simulator archive; its
source was unchanged. The device Rust archive was built from source.

The Fly Beeper worker was stopped and its startup executable disabled before
importing the existing verified account/device crypto. The test build restricts
all room requests to the single authorized iMessage test room. No other room
was enumerated, read or sent to during implementation testing.

The test ran the bundled PBW's real configuration and action runtimes inside the
signed Simulator app. It passed:

1. Restore the verified Beeper session without another sign-in.
2. Match the authorized telephone identifier to the synthetic iPhone contact
   `Chat Test Device`.
3. Reject the action while its room is unapproved.
4. Approve the exact room and send one encrypted test message through the plugin.
5. Retry the same operation and receive the identical accepted event ID.
6. Reinstall/relaunch the app and repeat the operation without another send.

After repeated runs, the request audit contained **one room-send request**. The native
database contained one room record, one directory entry, one send-journal record,
and **zero message events**. There were no `/sync`, `/joined_rooms`, message
history, media, or room-key-history requests. Only the chosen room's state was
read. Account/device metadata and encryption key exchange were also required.

Beeper accepted the encrypted message, and the user confirmed that it arrived
on the authorized iMessage test device. This verifies end-to-end delivery from
the Simulator plugin through Beeper to iMessage. A separate, narrowly scoped
diagnostic queried only the new test event's delivery-status relation; the
bridge reports that relation lookup is unimplemented. The plugin continues to
report Beeper acceptance, while this test's downstream delivery was confirmed
by the recipient-device check.

## Remaining manual checks and session handoff

After the Mac was unlocked, the real Simulator setup page was reviewed through
the app's bundled-plugin settings. It displayed the verified account, matched
the authorized number to `Chat Test Device`, showed its approval and restricted
the test-send selector to that approved chat. Emoji cryptography was exercised against local Matrix fixtures;
the live Simulator test reused the already verified Fly identity. Physical-phone
UI and background/suspension behavior have not been exercised on hardware.

The Fly worker remains stopped. Do not resume that worker with its old crypto
state while the Simulator uses the same Matrix device identity. The updated
state remains in the dedicated Simulator app's protected Application Support
`plugins/8197c57a-59c8-493e-9db1-eaab2988d010` directory. Resolve its current path
with `xcrun simctl get_app_container DEVICE coredevices.coreapp.chat-test data`.
Private exports and build/test logs are kept in the ignored `.local/chat/`
directory and are not part of the commit.

A subsequent Simulator run after the group-name correction reused the original
operation ID and returned the same accepted event ID. It made no additional
room-send request. The native test suite now also covers fresh email/code login
and partial directory loading using local Matrix fixtures.

## Performance follow-up

After the original receipt confirmation, a cold/warm performance test sent two
additional messages to the same authorized test room. Both were accepted by
Beeper; separate downstream receipt confirmations were not collected. See
[PERFORMANCE.md](PERFORMANCE.md) for timings and memory measurements. Fly was
confirmed stopped with its startup executable disabled before this test.

The updated audit contains three room sends, all to the authorized room. The
database still contains one room, one directory entry and zero message events;
the send journal now has three entries. There are still no history, room-key
history, sync, media or joined-room-enumeration requests. The private session
backup was updated after both performance sends.

The lifecycle review also found and fixed missing local cleanup after mobile
logout. Local fake-account tests verify session removal and a fresh login. The
live account was not logged out.

## Idle-policy follow-up

The final policy commit is `0c371ec66`. The full native fixture suite and targeted
race tests passed, including active-operation protection, login/SAS expiry,
stale timers and lifecycle notifications, cancellation cleanup, and retained
session/send-journal state. Common Kotlin operation-bracketing tests, Android
compilation, production iOS arm64 compilation, and the signed Simulator build
also passed.

Two idle-policy runs each sent one new message after reopening the verified
session. The final run passed the actual two-minute timer, posted UIKit
memory-warning/background notifications, and an identical-operation retry.
A separate real UI test sent while pressing Simulator Home; Beeper accepted it
and the worker released afterward. See [PERFORMANCE.md](PERFORMANCE.md) for
timings and measured memory reductions. These additional sends have Beeper
acceptance records; downstream receipt was only confirmed for the original
test message.

The cumulative audit now contains six sends, all to the authorized test room.
The database contains one room, one directory entry, six send-journal entries,
and zero message events. The private session backup was updated. Fly remains
stopped with its startup executable disabled.

## Room picker and direct iMessage integration

Chat now shares the existing iMessage JavaScript production controller from
`codex/imessage-js-port-implementation`. The standalone plugin remains functional
and keeps its own saved identity. The Chat UI offers three connection choices,
disables the platform-incompatible Beeper choice, and persists one active
connection. Each account and connection retains its own approvals.

Checks passed:

- 16 Chat JavaScript tests covering routing, account-scoped approvals, local
  contacts, ambiguous/unapproved recipients, accepted and uncertain operation
  retries, storage failure before transport, and stale UI responses.
- All 374 existing iMessage JavaScript tests after extracting the shared factory.
- Five Chat host JVM tests, including connection discovery without opening Go
  and release without restoring an idle client.
- Android and production iOS arm64 Kotlin compilation, Simulator Kotlin
  framework link, and signed Simulator app build. The bundled PBW matches the
  generated source bundle.
- Four real iOS Simulator x86 runtime conformance tests from the iMessage
  branch: large transfers, traps/registers, instruction/time limits, and execution
  in read/execute-only regions at high addresses without JIT.
- Browser UI fixture checks with 32 fake rooms: pagination, search, checkbox
  changes, separate connection approvals, and the direct Apple sign-in,
  verification, sender-selection and contact-entry forms.

In the real Simulator, the new page restored the verified Beeper identity and
existing approval, switched to the empty direct iMessage sign-in screen, and
returned to Beeper with its identity and approval intact. The switch released
the native Beeper client; direct-mode status polling made no further Go calls.
The authorized test room was unchecked and checked again in the real room list;
reopening settings retained the restored approval.
The full multiroom picker was exercised only against fake fixtures; the live
test build still exposes only the authorized test room.

The latest real PBW smoke run reused the original operation ID and returned its
original accepted event ID. The cumulative audit remains six sends, all to the
authorized room, with one room, one directory entry and zero stored messages.

Live Apple authentication and direct-iMessage delivery from Chat require fresh
user sign-in in its separate key namespace and have not yet been verified.
Physical-iPhone execution remains untested. The direct connection supports
individual recipients and plain text; it does not enumerate iMessage rooms or
support groups.

The native x86 tests ran via `:libpebble3:iosSimulatorArm64Test` with the
`*HostX86BridgeIosSimulatorTest*` filter. A local Gradle init script selected the
booted Simulator and excluded the pre-existing `PKJSRunnerTests.ios.kt` file,
whose constructor arguments are out of date. All other test sources compiled;
this was a targeted runtime check, not a clean full iOS test-suite result.

## Full-account directory and explicit refresh

After the one-room picker test, the user authorized read-only room names and
membership across the Beeper account while retaining the existing test-number
send restriction. The test build's `test-directory-read-all` flag now permits a
metadata snapshot and room-state reads. A separate send guard rejects any other
room before network or encryption-key work; the exact `test-room` lock remains.

The implementation starts a gzip metadata snapshot immediately after successful
email/code sign-in, while emoji verification is still pending. **Refresh chat
list** forces another snapshot. **Show all chats** and pagination use the local
index. Settings retain at most 25 room rows, with previous/next navigation and
indexed substring/contact-phone search. A completed snapshot is cached for 24
hours. See [PERFORMANCE.md](PERFORMANCE.md) for the initial-download cost and the
distinction between one network request and O(n) metadata processing.

Local checks passed:

- Full Go fixture suite, including gzip sign-in bootstrap, manual refresh,
  invalidation of cached bridge availability, interrupted responses, forbidden
  timeline data, and rejection of non-test sends before any network request.
- Targeted race tests for directory loading, search, login and refresh.
- An 8,000-room fixture fetched in one snapshot with zero per-room hydration
  requests, then browsed through all 320 bounded pages. Reopening a fresh cache
  made no additional snapshot request. No timeline messages were stored and the
  crypto sync cursor remained unchanged.
- The saved real 8,773-room metadata response parsed successfully, including its
  legacy room formats and largest 8,052-state-event room.
- 20 Chat JavaScript tests, including bounded paging, preserved approvals,
  stale-response rejection, refresh on the current page, and the refresh button's
  explicit force argument.
- In-app browser checks against an 8,000-room fixture: next/previous navigation,
  search, retained checkboxes and the refresh button.

The repository's pre-commit review passed for the directory implementation and
for the subsequent UI race correction. The first review reached its prompt cap
before the UI files; those files also received manual review and focused tests.

Android compilation, Chat host JVM tests, production iOS arm64 compilation,
Simulator framework linking and the signed app build passed. The installed
Beeper test app preserved the verified account, existing crypto state and the
single test-chat approval. Its bundled Chat PBW matched the generated asset.

The real Simulator loaded **8,773 directory records**, displayed the full count,
searched member phone identifiers and displayed the next 25-room page. The audit
contained **one metadata snapshot request**, **zero per-room state reads** from
these directory operations, and **zero new sends**. The database retained one
send-related room, zero message events and the original six send-journal entries.
The private session backup was refreshed. Fly was confirmed stopped with startup
disabled before the test.

The user took over the Simulator for testing before the planned live manual
refresh and cached-reopen checks. Those paths passed local fixtures; they have
not yet received a separate live UI check. A small subsequent pagination change
scrolls to the start of each new page and preserves position during background
refresh. It passed the UI tests and was packaged separately; installation was
left pending to avoid interrupting the user's test session.

The installed native archive SHA-256 is
`7530b75e315874a1dde86e213c1ceabdb83e5648ba98ccbf25fefa4bd052433d`.

## Recent-activity ordering

The room snapshot already contains Beeper's
`com.beeper.inbox.preview.origin_server_ts`, also exposed by the upstream
[mautrix response type](https://github.com/mautrix/go/blob/main/responses.go).
The saved real response supplied 6,204 positive timestamps across 8,773 rooms.
The same field can describe reactions, redactions or send-status activity, so
this is **Beeper inbox activity**, not a guaranteed last-text-message date.
Only the timestamp is retained; any server-supplied preview payload is skipped
without being decrypted, indexed or stored as an event.

Directory pages now use `(last_activity DESC, room_id DESC)` with an index and an
opaque timestamp/room cursor. Unknown dates sort last. State-only hydration and
an older snapshot cannot lower a room's known activity date. New accepted sends
advance the cached date; unconfirmed sends and operation-ID retries do not.
Incoming activity is reflected on directory refresh. The older cache schema
migrates without dropping rooms, and invalidates its completed snapshot once to
populate the new field.

Checks passed:

- Full native fixture suite and targeted race tests.
- All 8,000 fixture rooms paginated exactly once in recency order, including
  equal timestamps and unknown dates, with one snapshot and zero per-room reads.
- SQLite query plans use the activity index and seek directly to subsequent
  pages, without a temporary sorting table for unfiltered browsing.
- Legacy-cache migration, malformed-cursor rejection, ignored preview content,
  retained activity after state-only hydration, and accepted/uncertain/retried
  send behavior.
- The saved real snapshot parsed and paginated all 8,773 rooms in order, with
  6,204 usable dates. This local run made no live Beeper request.
- 21 Chat JavaScript tests, including reordering the visible cached page after
  an accepted send, without another directory fetch.
- The production iPhone Go archive compiled successfully.

The updated signed Simulator app was installed and its embedded native build
hash and bundled Chat asset matched the current outputs. The legacy directory
migrated in place and completed its one refresh in **124.635 seconds**. It held
**8,773 rooms**, now with **6,205 positive activity dates**. The first displayed
room matched the newest indexed timestamp. Reopening Chat settings displayed
the saved list without another snapshot request.

The live audit recorded **one snapshot**, **zero per-room state reads**, **zero
history requests** and **zero new sends**. The original six send-journal entries,
one send-related room and zero stored message events remained unchanged. The
verified sign-in, allow list and test-room send lock were preserved. The private
session backup was updated. The earlier pagination scroll adjustment is also
included in this installed build. Live manual refresh remains fixture-tested;
this run exercised automatic cache migration and cached reopening.

The Simulator framework link passed after retrying an invalid generated Kotlin
cache. The signed app build passed. Its installed native archive SHA-256 is
`fddad9731372e3f06dcbe9a2be0aab4883c909bf62f56b7d7b9a4f2045dd7b48`.

## DM-first search and activity dates

The directory now sorts by direct-message status, then descending activity and
room ID. The corresponding three-column index and cursor preserve that order
across pages. Migration derives DM status from the cached recipient, preserving
timestamps and the completed snapshot without a network refresh. Each Beeper
row displays a local date/time (Today, Yesterday, or a calendar date); unknown
dates are explicitly unavailable. The date retains the existing Beeper inbox
activity semantics, including possible reactions or deletions.

The existing trigram search already matched the user's national-number query
against its international `tel:` identifier. A read-only check of the installed cache found 186 matching
rooms: 14 DMs and 172 groups. The new ordering brings those DMs before the groups.
Regression tests use reserved fixture numbers to cover a national-number
substring, the full international number,
an interior phone substring and an interior name substring across three pages.

Checks passed before installation:

- Full native suite: 35.211 seconds.
- 8,000 mixed DM/group rooms across all 320 pages, including activity ties, with
  one snapshot, no per-room reads, and no duplicate or missing rooms.
- Indexed cursor seek and cache migration without invalidating the snapshot.
- All 22 Chat JavaScript tests, including readable/unknown dates.
- Android compilation and host allow-list tests.
- Production iPhone Go archive build.
- Repository pre-commit review.

The simulator's saved conversation result contained the exact error
`sending is restricted to the authorized test room`. The test-only `test-room`
file was still present after the user selected another chat in the allow list.
The native send check rejects that room before sending or creating a send-journal
entry. Production builds do not have this test restriction. The host's existing
account-bound allow-list enforcement remains in place.

The signed update was installed in the existing Simulator app. Following the
user's request to fix the failed manual send, its test-only room lock was
removed; the selected settings allow list now controls sends. The existing
verified account and the checked WhatsApp approval with nickname “Wife” were
confirmed in the UI. The failed processing task remained Failed and was not
retried. No live messages were sent during this work.

The real UI searched the user's national-number substring successfully, with
DMs first and readable dates (including Today and a month/day/time). The cache
retained 8,773 rooms, 6,205 activity dates and the completed snapshot, and locally
classified 7,168 DMs and 1,605 groups. The live audit showed zero snapshot requests,
zero per-room state reads and zero sends during validation. The native database
still held the original six send-journal entries and zero message events.
The private session backup was refreshed. Android's provider changes compiled;
a live Android provider runtime check was not performed.

The Simulator framework and signed app builds passed. The embedded native build
hash and Chat PBW were verified before installation. Installed native archive
SHA-256: `49e96643b967fca50f57ab99468ce5eaaec8694e21e764d6c92b61b784774c88`.

## Original Beeper feed wording

Successful Chat actions now return `Sent to [name]`, matching the original
Beeper message chip in `IndexFeedViewModel`. The resolved allow-list nickname
wins over the contact name for Beeper and direct iMessage. The native acceptance
status remains in the structured result. Unconfirmed and failed sends continue
to report failure. Older host results fall back to the requested recipient.

All 25 Chat JavaScript tests and the five Chat host tests passed, covering saved
nicknames, older hosts, failed/unconfirmed sends and direct iMessage retry results.
The Simulator framework build and repository pre-commit review passed. This
summary change was validated with fixture sends; no live messages were sent.

The signed app update was installed in the existing Simulator app. Its embedded
framework UUID matches the linked output and its Chat PBW matches the current
bundle. Existing sign-in and settings were preserved.

## Direct iMessage sign-in socket crash

Two Simulator crash reports identified an Objective-C interop abort in the
first TLS write: `NW_CONNECTION_DEFAULT_MESSAGE_CONTEXT` could not be converted
to Kotlin `Any` (a native block with a void return). The provider now owns one
explicit Network.framework content context per connection and reuses it for
successive stream writes. Certificate validation and the pending-write budget
are unchanged.

A local TLS echo fixture exercised the real iOS provider in a signed Simulator
test app: custom-root certificate validation, ALPN negotiation, a write queued
before connection readiness, a second 32 KB write, exact echoed bytes and close.
The test passed in 77 ms. The bare Kotlin command-line runner could not evaluate
trust (`OSStatus -26276`); running the same test in an app bundle resolved that
test-environment limitation. Temporary diagnostics were removed before the
passing test. The fixture used a generated localhost certificate and no Apple
credentials or live messages.

## Apple Push trust chain and saved sign-in

The September 16 sign-in reached Apple's activation endpoint successfully, then
failed the courier TLS handshake with `CERTIFICATE_VERIFY_FAILED`. Apple's SSL
policy reported “Certificate authority pinning mismatch” with only the pinned
intermediate. Courier requests now also supply Apple Root CA, verified against
the certificate published at Apple's PKI site. Both plugin manifests permit its
exact SHA-256. The existing intermediate remains available to Android; the
native hostname and certificate checks are unchanged.

Three live TLS-only checks passed in a signed iOS Simulator test app: the full
chain connected (164 ms), the old intermediate-only request reproduced the
failure, and an incorrect server identity remained rejected. An Android emulator
also completed TLS 1.3 with the same two anchors and hostname verification. These
checks used no account credentials, APNs authentication or live messages.

Chat saves sign-in credentials through its existing secure plugin storage before
attempting network setup. Tests cover failure/restart reuse, replacing credentials,
requiring a new password for a changed account, storage failures, forgetting,
disconnect failures and the settings page. Page replies never contain the saved
password or activation token. The Chat suite passed 32 tests and the shared
iMessage suite passed 375, including both manifests' exact courier trust pins.
Completing Apple account authentication still requires a user sign-in retry.


## Android SMS (2026-09-16)

- Reused the `SmsManager` sender from CoreApp PR #75, including multipart send callbacks and a 30-second confirmation timeout. Added the pre-Android-13 telephony feature fallback and coroutine cancellation propagation.
- 39 Chat JavaScript tests pass, including SMS routing, approval listing, pause/delete behavior, and absence from iOS connections.
- Five SMS backend tests and eight Chat API tests pass on JVM. Coverage includes permission and approval checks, malformed destinations, contact pagination, manual numbers without Contacts access, restart-safe duplicate protection, and disconnect invalidation.
- The opt-in `SmsChatAndroidTest` passed on emulator-5558 through the real Android sender and Chat API: a short message and a multipart Unicode message to the fixed virtual modem number `+15555215558`, plus repeat-operation checks. No carrier/physical-phone delivery was tested. Run only on an emulator with `chatSmsEmulator=true` and `SEND_SMS` granted to the isolated test package.
- Android debug APK and iOS simulator framework built successfully. The updated Android APK and iOS test app are installed, preserving existing connections.
- Browser verification covered Connect SMS, approved-chat selection, the compact connected screen, removal of redundant connection statistics, and completed chat refresh from the picker. SMS is absent from the iOS connection list.

## Saved Mac keys (2026-09-17)

- A temporary in-app check on the iPhone 17 Pro simulator used the existing signed-in Pebble account to list the real Firebase key metadata and load the selected key through the Chat plugin's configuration API and secure storage.
- The single saved Mac, **MacBook Air (2)**, loaded successfully. Its 1,300-byte setup key matched the desktop extractor output byte for byte by length and SHA-256. Settings replies contained no key material. The check sent no messages and performed no Apple sign-in or disconnect.
- Fixed the iOS Firebase configuration lookup: GitLive's aggregate options getter requires a Realtime Database URL even when the app only uses Firestore. The iOS implementation now reads the configured project ID directly.
- Fixed the settings textarea helper assigning to the read-only `type` property, which had interrupted rendering before the connection's Disconnect control appeared.
- All 53 Chat JavaScript tests and 10 native Chat API tests passed. Coverage includes automatic single-key selection, multiple-key choice, manual override, account changes, private key exclusion from settings replies, removing locally saved credentials and key selection on disconnect, and the connected screen retaining its Disconnect control when a key lookup fails. Android compilation and the iOS simulator framework build passed.
- Temporary readback instrumentation was removed after verification. The account's saved Firebase key and existing iMessage connection were preserved.

### Connection settings cleanup

- Removed the Mac-key Check again button. Opening or returning to iMessage settings performs a fresh lookup automatically.
- Pause, Resume, and Disconnect are shown only for connected accounts across Beeper, iMessage, WhatsApp, Telegram, and Android SMS. A paused connection without a signed-in account offers Connect instead. Unfinished Apple verification retains Cancel sign-in / Start again.
- All 56 Chat JavaScript tests passed, including reconnecting the settings view after a Mac key becomes available, signed-out and paused states for all six connectors, and restarting expired Apple verification.
- Rebuilt the bundled plugin and installed it in the iPhone 17 Pro iOS 26 simulator, preserving app data. The installed plugin and native framework match the signed build.
