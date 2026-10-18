# Chat plugin

Chat adds the `send_message(recipient, text, operation_id?)` action to the existing
PBW plugin catalogue. Users approve individual or group rooms in Chat settings.
The host rejects unapproved or ambiguous recipients. Approval is bound to the
connected account and exact room ID; a nickname provides a unique spoken name.
Group approval follows the room's current membership.

## Connections and allow lists

Chat settings show three connection choices and enable the ones supported by the
phone. One connection is active at a time; changing it is explicit and persisted.
An unavailable or failing connection never falls back to another service.

The **All chats** list shows Beeper rooms, their names and members, with checkboxes
for the allow list. Search narrows the list; **Previous page** and **Next page**
move through 25-row pages. Selections persist when searching or paging. Optional
nicknames provide unique names for voice commands. The summary above the list
also lets users remove an approval whose room is no longer available.

- **Beeper · Android app:** duplicates the existing Beeper content-provider integration.
  Beeper owns sign-in, contacts and message encryption. Chat searches its contacts
  and rooms, and sends through `content://com.beeper.api/messages`.
- **Beeper · iPhone:** `chat-native` embeds gomuks as a Go C archive linked into CoreApp.
  There is no subprocess, remote worker or listening HTTP server. A small C ABI
  accepts JSON requests from Kotlin on an IO dispatcher. Session crypto uses a
  random wrapping key in Keychain; the private database lives in the app's
  protected Application Support directory.
- **iMessage · direct:** incorporates the working JavaScript implementation from
  `codex/imessage-js-port-implementation` (including its contacts and sender
  selection). It shares `../imessage/src/production-controller.js` with the
  standalone plugin. Authentication, APNs/IDS and encryption remain in that
  existing JavaScript implementation; the generic host APIs provide crypto,
  networking and timers. NAC x86 execution uses the bundled Blink WebAssembly interpreter
  on both platforms (see ../imessage/wasm/README.md). This connection does not
  start gomuks.

Direct iMessage reads saved Mac setup keys from the signed-in Pebble account's
`chat_activation_keys/{uid}/keys` collection. Setup loads the only saved Mac
automatically, or asks the user to choose when several are saved. Advanced keeps
manual ExtractKey entry available. With no saved Mac, setup explains how to save
one from the Pebble Mac app. Opening iMessage settings, including returning from
another app, automatically repeats the lookup.

CoreApp supplies this through the shared `ChatActivationKeys` host interface on
iOS and Android. Metadata requests exclude the key; the selected key goes straight
to the plugin's secure storage. The settings page receives only its ID and a load
confirmation. Reads and reuse are checked against the current Firebase account.
The REST client avoids putting key documents in Firestore's disk cache.

Direct iMessage settings also include Apple Account sign-in and verification code,
registered send-from addresses, and saved recipient names/addresses. Add recipients, then select their checkboxes to allow
sending. It supports individuals and plain text; it has no room directory or
group support. Its allow list is bound to the Apple account and exact address,
and removing a saved recipient revokes that approval. Chat saves the activation
token, account email and password before attempting sign-in, including failed
attempts. These use the plugin's Keychain storage on iOS and Keystore-backed
encryption on Android. Settings receive only the saved email and presence flags;
blank token/password fields reuse the saved values. Changing the account requires
a new password. “Forget saved sign-in” or disconnecting removes these saved
credentials. Verification codes are not persisted.
Chat uses its own plugin storage and key namespace;
the standalone iMessage plugin's saved sign-in is not automatically copied.

Selecting direct iMessage requests release of the Beeper client. Active
operations and protected sign-in/verification flows retain the existing idle
policy. Connection discovery itself does not open a Go client.

## Beeper behavior

iOS setup uses Beeper email/code sign-in and seven-emoji device verification.
The temporary verification sync explicitly excludes every room and only processes
same-account device traffic. Normal gomuks background sync is disabled. Immediately
after email/code sign-in, Chat starts one gzip-compressed metadata snapshot while
emoji verification remains available. It streams room names, members, phone
identifiers, bridge routing and encryption settings into a local SQLite index,
committing 25 rooms at a time so browsing can begin during loading.

The snapshot excludes timeline events, never supplies or saves a sync cursor, and
discards device events without decrypting them. Beeper currently returns extra
state despite the requested filter; the parser retains only directory metadata
and rejects responses containing timeline messages. Chat blocks message-history,
media and bulk room-key-backup endpoints at the HTTP transport.

Completed snapshots remain fresh for 24 hours. Opening settings resumes an
incomplete fetch or refreshes an expired snapshot. **Refresh chat list** forces a
new snapshot and refreshes cached bridge availability; **Show all chats** only
clears the search. Directory loading stops when settings close. Existing cached
chats remain available if loading is interrupted.

iPhone Beeper chats show direct messages before groups, with the latest known
inbox activity first within each kind, using `com.beeper.inbox.preview.origin_server_ts` from the same snapshot.
Only this timestamp is retained; any preview event payload supplied by Beeper is
discarded without decryption or storage. Beeper activity can include reactions
and deletions, so this is not guaranteed to mean the latest text message. Rooms
with no activity timestamp appear last within each kind. Each row shows the
local date and time, or says the activity date is unavailable. Newly accepted Chat sends immediately
advance their room's cached activity; retries and unconfirmed sends do not.
Incoming activity updates when the directory refreshes. Upgrading an older cache
requires one snapshot to populate the new timestamps.

Initial loading uses one HTTP snapshot request, with no per-room requests. Its
download and indexing cost scales with room/member count. Subsequent browsing
uses indexed local queries and returns at most 25 rooms; the page replaces its
visible rows instead of accumulating the account's entire directory. A direct-message,
activity and room-ID index provides stable ordering and bounded cursor pages, including
when multiple rooms have identical timestamps. Search uses
substring matching for three or more characters and word-prefix matching for
shorter queries. For example, `5551234567` matches a member identifier of
`tel:+15551234567`, including chats on later pages. Contact-name matches are
batched into the same paginated query. Adding DM-first ordering migrates the
existing cache locally without requiring another snapshot.

iPhone Contacts matching uses `tel:` member identifiers and Apple's Contacts
phone-number predicates. A unique address-book match takes precedence over the
Beeper member name. Unnamed group titles are assembled from these matched member
names; explicit group titles stay intact. Denied, limited or ambiguous contact access falls back to
available Beeper names. Address-book names and phone numbers stay on the phone.

The iOS client stays warm for two minutes after the last operation while the app
is in the foreground. Backgrounding and memory warnings request earlier cleanup;
an active operation finishes first. Email sign-in and emoji verification retain
their client until the flow finishes, is cancelled or expires. Cleanup closes
SQLite and HTTP connections, releases client objects and asks Go to return unused
heap memory. Credentials, crypto state, approvals and send-journal entries remain
available for the next request. The linked Go runtime stays loaded.

Before an iOS send, Chat refreshes the selected room's state and recipient device
keys, rotates its outbound encryption session, shares it with current joined
members and encrypts the text. A changed direct-chat recipient, unsupported bridge,
missing membership or failed key exchange stops the send. No previous messages
are downloaded or decrypted. Cloud Beeper bridges are supported; iOS cannot send
through a Beeper bridge that runs only on another device.

All connections journal operation IDs. Retrying the same accepted operation
returns the saved result. Uncertain results require checking the messaging
service before creating a new operation. Direct iMessage writes a pending entry
before sending; it stores a message fingerprint and result, not the message body.
Success means **accepted by Beeper** or **accepted by iMessage**; it does not claim
downstream device delivery. Successful Index feed summaries use the original
Beeper wording, **Sent to [name]**, preferring the saved nickname.

## Build and local checks

From the repository root:

```sh
npm --prefix imessage ci
python3 chat/build.py
node --test chat/*.test.cjs
npm --prefix imessage test
./gradlew :libpebble3:jvmTest --tests '*ChatPluginApiTest*'
./gradlew :libpebble3:compileAndroidMain
./gradlew :libpebble3:compileKotlinIosArm64
```

The normal iOS Gradle build invokes `chat-native/build-apple.sh` for the device or
simulator slice. The generated cinterop definition links the Go archive at the
final binary link, and an archive-hash header invalidates downstream builds when
native code changes. The archive is not embedded in a Kotlin/Native dependency
cache, which can otherwise retain older Go code.

The build requires Xcode, Node.js, Python 3 and Go with automatic toolchain
selection enabled. The pinned Go module and patches are prepared in an ignored
build cache. Sources derive from `plugin-manager/harness/gomuks` at `9b5f882` and
gomuks commit `06b62956efb0205ea8e6b8200d9e2f23e269f162`. The gomuks AGPL license is
included in `../../chat-native/gomuks-AGPL-3.0.txt`; the pinned upstream source and
the local patches form the corresponding native source.

Native tests use local Matrix fixtures, including real Olm/SAS exchanges, secret
validation, mismatch, cancellation, expiry and restart, plus transport and room
parsing tests. They never use a live account:

```sh
cd public/chat-native
chat_modfile=$(python3 prepare.py)
cd go
go test -modfile="$chat_modfile" -tags 'goolm sqlite_fts5 coreapp_chat_testing' ./...
```

## Scoped Simulator integration test

For the Beeper connection, the `CHAT_TEST_SCOPE=true` build includes a test-only import path and a transport
restriction. It can import account/device crypto, but no room history or bulk
Megolm room keys. An import requires a matching `test-room` file. This build
defaults to disabling room enumeration and sync and rejecting every other room
endpoint. After explicit authorization to read all room metadata, the runner's
`--read-all-metadata` option enables the metadata snapshot and room-state reads.
It preserves the exact test-room send restriction. Production builds omit the
importer, test restriction and request audit hook.

Build a Debug simulator framework with `-PCHAT_TEST_SCOPE=true`. For a shell build
of `:composeApp:syncFramework`, also set `ARCHS=arm64`, `SDK_NAME=iphonesimulator26.0`,
`PLATFORM_NAME=iphonesimulator` and `CONFIGURATION=Debug`, plus the matching
`kotlin.native.cocoapods` Gradle properties. Build the Xcode workspace using
`BUNDLE_ID=coredevices.coreapp.chat-test CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`.
Xcode's simulated entitlements are required for Keychain access. If the framework
was built separately, set `OVERRIDE_KOTLIN_BUILD_IDE_SUPPORTED=YES` for xcodebuild.

Select **Beeper · iPhone** in Chat settings before running this Beeper-specific
check. Stop the source worker before reusing any live device identity. Keep the
session export outside Git, and run:

```sh
python3 chat/run-simulator-smoke.py \
  --device SIMULATOR_UUID --app /path/to/Pebble.app \
  --session-export /private/path/to/scoped-session.json \
  --phone AUTHORIZED_TEST_NUMBER --operation STABLE_TEST_OPERATION_ID
```

The opt-in test runs inside the real Debug Simulator app. It creates the one test
contact, loads the bundled PBW, checks Contacts matching and verified-session
restoration, rejects an unapproved action, approves the exact test room, invokes
the actual plugin send action and retries its operation ID. Results and endpoint
audit paths are printed by the runner. Never resume the original worker while
the cloned device identity is in use; preserve the updated crypto state.

See [VALIDATION.md](VALIDATION.md) for the recorded Simulator results and session handoff.
See [PERFORMANCE.md](PERFORMANCE.md) for the native lifecycle, measured startup/send
latency, memory usage and the opt-in `--performance` runner.

The `--lifecycle` mode requires the same existing scoped session and approval. It
waits through the real two-minute idle deadline, checks verified-session restore,
posts the iOS memory-warning and background notifications, and sends one message
after reopening. Use a new operation ID. It writes `lifecycle-result.json` with
the memory snapshots for each release and the time to send after reopening.
