# Chat connections

Chat owns connection selection, recipient approval, and routing. Each connection adapter owns its sign-in, directory, transport, and credentials.

## Connection adapters

- `beeper-android`: installed Beeper content provider on Android.
- `beeper-ios`: embedded, send-only Beeper client on iOS. Its compressed metadata snapshot, indexed search, verification, and idle release remain in `chat-native`.
- `sms-android`: Android SMS through the `SmsManager` sender from CoreApp PR #75. Hidden on iOS and devices without telephony messaging.
- `imessage`: the shared JavaScript iMessage implementation on Android and iOS, backed by the host's generic crypto, TLS, and executor APIs.

`ChatController` manages enabled connections and serializes operations per connection. Connections can be enabled together. Disabling preserves identity and approvals; deletion removes that connection's identity/settings and approvals. Unavailable or paused connections do not contribute recipients to MCP.

The previous `chat.connection.v1` selection migrates once to `chat.connections.v2`, recording enabled and previously configured connections separately so a paused account stays paused when opened. Existing sign-in storage and provider approval storage remain intact.

## Chat identity and sending

A chat reference contains connection ID, account ID, and provider room ID/address. Display names and nicknames are labels, not globally unique identifiers. Two connections to the same person produce two distinct choices.

`list_chats` exposes only approved chats. `send_message` accepts an exact `chat_id` or resolves a name against approved chats on enabled connections. An ambiguous name requires a user choice. If a connection cannot be checked, unqualified sending fails rather than guessing among the remaining results.

Account and approval checks run again immediately before sending. A durable operation journal binds each operation ID to a fingerprint of the exact chat and text, and records accepted results. Pending/uncertain sends cannot be retried automatically. Message bodies are not stored in the journal. Direct WhatsApp and Telegram providers additionally retain the latest 1,024 send records; the controller journal guards older operation IDs.

## Search and contacts

Settings search is separate from MCP's approved-chat listing. The picker searches selected connections and merges bounded pages: direct messages before groups, then available activity timestamps. Each cursor records provider positions and is tied to the query, connections, and accounts. One provider's error is displayed alongside results from the others.

CoreApp's existing `SystemContacts` service supplies phone/email address search and names. Its iOS implementation and permission support are maintained in a separate base PR. Chat injects that service; it does not maintain a second native address book. Beeper uses phone matches to enrich names and search its local metadata index. iMessage combines saved recipients with the shared contact search, and saves a selected recipient before approval. Searching never probes every contact's iMessage availability; the transport checks the selected recipient when sending. Android Beeper reads chat/contact metadata in four bounded provider queries (count + batch for each), then searches and pages the local snapshot. It never queries message previews or history. The snapshot is refreshed explicitly or after five minutes and discarded when settings release the connection. Provider identity on Android is the installed Beeper connection; its API does not expose a stable signed-in account ID.

## Settings UI

The bundled config page is built from `config.template.html` and `src/settings.js`, with connection setup views in `src/settings/connections.js`. The top-level screen shows compact Accounts and Approved Chats lists. Contact permission lives inside Add chats; nickname and removal controls live on a separate Edit page. Search updates as the user types or changes account filters, with serialized requests so slower native searches cannot overwrite newer input. Separate views provide connection setup/verification, sending identity, pause, deletion, and the filtered chat picker. Connection pages show status and useful account identity; counts and sync timestamps are omitted. Chat-list refresh lives in the picker and only appears for networks with a synced directory. SMS setup has one Connect SMS button. Approved chats, details, and search share an identity view with nickname, original name, and available phone/email address. The picker uses a labeled search bar, account filter chips, and explicit Add chat / Approved / Remove controls. Phone display uses existing metadata and never treats opaque service IDs or group members as a chat phone number.

Native permission requests use CoreApp's existing `PermissionRequester` through a Chat-only configuration capability. They run from a user action in the settings UI. Headless plugin operations cannot display permission prompts.

## Adding a network

Add a connection descriptor and an adapter implementing status, paginated chat search, approval/removal, sending, refresh, and deletion. Keep account-specific identity and approvals inside the adapter, use qualified references at the controller boundary, and add a setup view. The unified picker, MCP allow-list action, ambiguity rules, and operation journal remain shared.

## Direct WhatsApp and Telegram

`DirectAdapter` adds `whatsapp` and `telegram` to the same controller. The native API routes their requests to `chat-native/go/direct`. iOS links that package into the existing Go archive; Android packages an arm64 JNI shared library, matching the app's existing arm64 ABI. JNI passes UTF-8 byte arrays so emoji survive the Java/Go boundary.

- WhatsApp pins the `whatsmeow` library used by mautrix-whatsapp. It registers as Pebble Chat and supports linked-device QR and phone-code pairing, contact metadata sync and one joined-group request, and text sends. Refresh waits for contact metadata before reading the local directory. Initial/recent/full history requests and automatic message re-requests are disabled; setup notifications are acknowledged so the phone can finish linking. WhatsApp's protocol still handles cryptographic/session events while connected; Chat has no incoming-message handler, body store, notification, or read-receipt feature.
- Telegram uses only the MIT-licensed `pkg/gotd` fork bundled in mautrix-telegram v0.2609.0. Pebble's application ID/hash are bundled in the native provider. Users sign in with a phone code and optional two-step password; each session is encrypted separately. It supports contacts and paginated dialogs, username/phone resolution, and text sends. `NoUpdates` disables update subscriptions. The dialog API includes its latest message; only the date is retained. No history, media, or read-state API is called.

The direct host enforces account-scoped approvals again below JavaScript, and persists pending/accepted send fingerprints before/after provider calls. It never replays an uncertain send. Status and search use the saved local directory; opening settings does not connect to either service. Refresh and sending connect on demand. Clients close after two minutes idle or on background/memory pressure, retaining sign-ins and approvals. Active linking gets a short, bounded grace period. Session/configuration and directory/approval files use AES-GCM with a host Keychain/Keystore key. WhatsApp's Signal store uses a private SQLite file in the app-protected directory; it contains protocol state, not message bodies.

WhatsApp contact search includes the existing CoreApp address book without probing each number. Approving a selected address performs one WhatsApp availability lookup. Telegram phone resolution respects the account's Telegram privacy access; manual username entry is the fallback. Secret chats and broadcast creation are outside this send-only implementation.

Upstream references: [mautrix-whatsapp](https://github.com/mautrix/whatsapp), [whatsmeow](https://github.com/tulir/whatsmeow), [mautrix-telegram](https://github.com/mautrix/telegram). Library licenses are retained under `chat-native/licenses`.

## Android SMS

SMS uses the phone’s default SMS SIM and CoreApp's existing permission requester for `SEND_SMS`. It never requests SMS inbox access or receives messages. The same SystemContacts service powers search; manual international numbers work without Contacts permission. Android normalizes national-format contact numbers using the phone's country. Approval, nickname, removal, pause, and deletion use the shared Chat UI. Each reset creates a new local connection identity, invalidating old chat references.

The native SMS backend checks permission and approved recipients on every send, stores a pending fingerprint before invoking the sender, and waits up to 30 seconds for all SMS parts to report success. Partial failures and timeouts remain unconfirmed and cannot be retried automatically. The native journal retains the most recent 1,024 operations; the controller journal guards older IDs. Sending text and attachment/MMS/group support are separate features; this connection sends plain text to individuals.

### WhatsApp connection maintenance

The existing app-resume flow and background sync worker call the Chat plugin's
`connections.maintain` configuration operation. Background checks skip a busy
plugin or an open configuration session. Opening Chat settings also checks the
connection. Paused connections and other networks are skipped.

The Go backend keeps encrypted, account-bound health metadata. A successful
connection suppresses maintenance for seven days; failed attempts back off for
one hour. After ten days without observing the primary phone, a peer-only
app-state-key request is sent, with successful pings limited to once a day. After twelve days, settings
ask the user to open WhatsApp on their primary phone. These pings cannot guarantee
that WhatsApp will keep the device linked. OS background execution is best-effort.

Maintenance has a twenty-second network deadline, does not fetch chat directories
or request message history, and closes any session it opened itself. Existing
interactive sessions retain their two-minute idle timeout. Server logout is saved
so the next launch shows Reconnect and cannot use stale approvals.
