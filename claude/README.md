# Claude

*Uses claude.ai's private, cookie-authenticated web APIs; not the Anthropic API.*

Index/Pebble plugin that sends messages to existing Claude chats and Claude Code sessions, using
the same private, cookie-authenticated APIs as claude.ai. No desktop bridge or API key. The host
must support `web_sign_in` and secure storage; iOS has not been live-tested.

## Setup

1. Run `pebble build` in `claude/`, then `pebble install --phone <ip>` (or sideload
   `build/claude.pbw` through Apps → Sideload App). Web sign-in needs a store plugin or a
   debug-build sideload.
2. Open Claude plugin settings and sign in with Claude.
3. With more than one organization, pick one; that is the only step shown until you do. It can be
   changed later under **Account**.
4. **Hold to speak** sets where hold-to-speak and "Tell Claude …" go: Claude Duet (the default
   when your account has it), a new Claude chat (the default otherwise), or a specific Claude chat
   or Code session (the latest 100 of each).
5. **"… start a new task …"** picks the computer or environment new Code sessions start on, or Off.
6. Optionally, under **Edit names**, give any chat or Code session a short name to say.

Sign-in uses `Pebble.webSignIn` to capture `sessionKey`, verifies membership with
`GET /api/organizations`, and stores the credential in `Pebble.secureStorage`. This grants
account access, not a narrowly scoped messaging permission. Disconnect removes the plugin's saved
credential; it does not revoke the browser session.

## Claude Duet

After sign-in, organization changes, and reopening settings, the plugin checks for an existing
Duet conversation. **Claude Duet** appears in the **Hold to speak** dropdown only when that check succeeds.
Choose it to send messages there. The plugin verifies that your
account already has an available Duet main conversation before saving the choice. Messages
without a named chat then go there; `duet`, `Claude Duet`, and `duet:main` target the same
conversation. This release supports Duet's main conversation, not its rooms or task threads.
Regular chat IDs, Code IDs, and `new` keep their existing meanings.

When the check succeeds and no destination has ever been chosen (no saved kind, mode or
default), Duet becomes the default. A destination you already chose is never changed. Switching
away disables Duet routing; changing organization switches it back to a new Claude chat. Existing regular-chat/Code defaults are preserved when switching
to Duet and back. `agent/chats` includes `duet:main` only while Duet is selected.

The plugin reads `GET /v1/code/aibo/project?omit_timeline=true` with
`anthropic-client-app: com.anthropic.aibo.web` to discover the main channel, then sends
`{body, client_message_id}` to `POST /v1/code/channels/{id}/messages`. A valid `message_id`
is required for the receipt. It rechecks availability before each send and never retries a POST,
creates a Duet project, or changes connector access, routines, or permissions.

Verified November 5, 2026 in signed-in Chrome: main-channel discovery with the client-app header,
a plain-text UI send, its server acknowledgment, and Duet's reply. Also verified on a simlock
Android emulator using the existing CoreApp debug APK from the main checkout: sign-in,
organization-specific Duet detection (shown for the personal organization, hidden for the team
organization), selection, and persistence after reopening settings. Android sending and iOS
remain unverified. Duet uses the existing securely stored Claude session cookie.

## Contract

The plugin is an Index agent destination (see `agent` in [plugins.md](../plugins.md)).

- `send_to_agent({message, chat_id?})`: with `chat_id` omitted, Claude + new chat starts a new
  Claude conversation for the message; Claude + default chat sends to the default conversation;
  Claude Code sends to the default Code session. Without a default of the chosen kind it fails
  without sending. `chat_id` `"new"` or `"new chat"` (any case) always starts a new Claude
  conversation, whatever the settings. `chat_id` is an
  `instanceId` from `agent/chats`; a nickname or part of a title also resolves. Exact nicknames
  take priority; ambiguous matches fail without sending. Returns a submission receipt, not
  Claude's answer.
- New Code sessions: in the **"… start a new task …"** row, pick an environment (active Remote
  Control machines, shown as "directory · machine", and cloud environments). `chat_id`
  `"new task"` (also `new code`, `new session`, `new code session`) then creates a Code session
  there and sends the message as its first prompt; an existing nickname with one of those names
  still wins. With no `chat_id`, a message starting "start a new task/session …" does the same
  with that phrase stripped, or starts a regular Claude chat when no environment is chosen;
  "start a new chat …" always starts a regular Claude chat. Changing organization clears the
  environment.
- `agent/chats`: one instance per chat across Claude and Code (plus Duet when selected) (first page of each, most recent first).
  `instanceId` is the chat id (`chat:<uuid>` or `code:<cse_… or session_…>`), `name` is the
  nickname when one is set and otherwise the title; `title` and `url` are also served.
- `agent/configured`: true when a send without `chat_id` would work: for Claude + new chat, signed
  in with an organization chosen; otherwise a default of the chosen kind is saved. `name` is
  "New chat" or the default's nickname or title. Served from saved settings, without a network call.

The plugin re-fetches an existing chat in the chosen organization before sending. The only
conversations it creates are the empty chat a new-chat send starts with and the empty Code
session a new-task send starts with; it never changes a chat
branch, changes permissions, or automatically retries a send.

### Nicknames and defaults

Nicknames are set under **Edit names**: pick a chat or Code session, enter a nickname
(up to 40 characters), and save. Naming a nickname always sends to that chat, whatever the
default settings. Nicknames are case-insensitive and unique within the selected organization;
assigning an existing nickname moves it to the selected chat. Clear the field to remove one. "new", "new chat", "new task",
"new code", "new session" and "new code session" are reserved and cannot be new nicknames.

One default is saved; choosing it also sets the kind. A default of the other kind is kept but
unused until the kind is switched back or another default is chosen. Changing organization clears
the default. On upgrade from 0.2, sign-in, nicknames, mode and default are kept; the kind is
Claude Code only when the plugin was already sending to a default Code session.

## API behavior and limitations

- Chat list: `/api/organizations/{org}/chat_conversations`; a new chat is POSTed there with a
  fresh `uuid` and empty name, and the first message is sent under the root message id. A failed
  create sends nothing and is reported as unavailable, not as uncertain delivery.
- Chat detail: `/api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true`.
- Chat send: POST `…/{id}/completion`, with the current leaf and fresh human/assistant UUIDs. A
  completed SSE response supplies the actual human message ID (Claude may replace the requested
  UUIDs). A subsequent read can also verify the requested human UUID. A bare HTTP 200 is
  insufficient.
- Environments: `GET /v1/environment_providers/private/organizations/{org}/environments?limit=1000`
  (`state: "active"` only). New session: `POST /v1/code/sessions`
  `{environment_id, config:{sources:[],outcomes:[]}, events:[]}` returns `{session:{id:"cse_…"}}`; the
  prompt then goes to `…/{id}/events`, as claude.ai/code does. A failed create sends nothing; a
  failed event post is uncertain delivery. Verified November 12, 2026 in signed-in Chrome by
  starting a session on a Remote Control environment from claude.ai/code.
- Code list/detail/send: `/v1/code/sessions`, `…/{id}`, `…/{id}/events` on **claude.ai**. Sends
  wrap stream-json user events in `{session_id, events:[{payload:…}]}` and require an event
  acknowledgment. No permission-changing control events are implemented.
- Only Code sessions exposed through Claude's web service are reachable. Local-only CLI sessions
  need Remote Control enabled; disconnected bridge sessions are rejected.
- These APIs are unofficial and can change. Authentication, Cloudflare challenges, organization
  policy, and rate limits are reported separately. No challenge bypass or third-party credential
  relay is implemented.
- CoreApp's fetch buffers the entire response and has no streaming body. Web chat completions can
  outlast the host action timeout. A timeout or disconnected send must be treated as **uncertain
  delivery**: check the chat before sending again. The action description prohibits automatic
  retries. Code's event POST returns a separate acknowledgment without waiting for generation.
- Empty chats without a verifiable current leaf and chats with an unfinished human turn are
  rejected; open/finish them in Claude before using this plugin.
- HTTP 409 conflicts require inspecting the chat before another send; they are never retried.
- Code sending and physical Android/iOS networking are not yet live-verified. Browser success does
  not establish that native networking will pass Cloudflare.

## Build and test

No npm dependencies or JavaScript build step.

```sh
cd claude
npm test
pebble build
```

## Research, checked October 18, 2026

The following are protocol references, not dependencies. This implementation does
not embed their source. Stars measure repository interest, not verified active users
or the number using the exact feature we need.

| Project | Adoption snapshot | Recent relevant evidence | Applicability |
| --- | --- | --- | --- |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | 77,909 stars; 11,291 forks | Claude-web attachment fix [merged Oct 8](https://github.com/diegosouzapw/OmniRoute/pull/15720); [Sept 24 user report](https://github.com/diegosouzapw/OmniRoute/issues/14742) says basic web-cookie prompts work, while reporting attachment/tool failures | Strongest adopted chat protocol reference; its browser transport and Cloudflare handling are not portable wholesale to CoreApp |
| [agent-sessions](https://github.com/jazzyalex/agent-sessions) | 905 stars; 65 forks | Repository pushed Oct 17; [native cloud list client](https://github.com/jazzyalex/agent-sessions/blob/main/AgentSessions/ClaudeCloud/ClaudeCloudAPIClient.swift) records live verification July 31 | Corroborates same-origin session-cookie Code listing, headers, cursors, and native-networking caveats; read-only, not proof of sends |
| [claude-rc-api](https://github.com/ThatCrispyToast/claude-rc-api) | 2 stars; 3 forks | [Controller update Oct 16](https://github.com/ThatCrispyToast/claude-rc-api/commit/0c4f384205); [Oct 12 PR](https://github.com/ThatCrispyToast/claude-rc-api/pull/2) reports live event reads with trusted-device enrollment | Most direct send-envelope/receipt reference, but small adoption and its auth is OAuth on api.anthropic.com; cookie-authenticated sending on claude.ai still needs our own verification |
| [Happy](https://github.com/slopus/happy) | 24,197 stars; 2,069 forks | Pushed Oct 18 | Substantial adoption, but wraps the CLI with its own transport; does not meet the direct Claude-web API requirement |
| [Happier](https://github.com/happier-dev/happier) | 1,984 stars; 185 forks | Pushed Oct 18 | Likewise uses a managed CLI/terminal session; useful comparison, not the chosen backend |
| [claude-explorer](https://github.com/rpeck/claude-explorer) | 17 stars; 2 forks | Pushed Oct 14 | Chat list/detail shapes and selected-branch reconstruction; read-only |

Older/smaller candidates were not treated as evidence of current reliability:
`st1vms/unofficial-claude-api` (204 stars, last push March 16),
`Adithyan-Defender/claude-ai-re-client` (39 stars, April 25), and
`androbwebb/claude-web-self-caller` (0 stars, May 11).

Additional references:

- [OmniRoute's existing-conversation payload](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/open-sse/executors/claude-web/payload.ts)
- [Claude RC protocol reference](https://github.com/ThatCrispyToast/claude-rc-api/blob/main/API_REFERENCE.md)
- [Independent first-hand web endpoint map](https://life.xlrd.org/claude-web-api/)
- [Claude Channels](https://code.claude.com/docs/en/channels-reference): supports
  live CLI injection, but requires a channel server and session opt-in, so does not
  satisfy the requested web-API-only workflow.

No widely adopted project found demonstrates the entire combination of arbitrary
existing web chats, Code sessions, cookie-only sign-in, and sending on mobile native
HTTP. The references establish pieces; our live checks establish browser behavior
for the operations listed above, not full mobile readiness.

