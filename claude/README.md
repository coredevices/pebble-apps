# Claude

*Uses claude.ai's private, cookie-authenticated web APIs; not the Anthropic API.*

Index/Pebble plugin that sends messages to existing Claude chats and Claude Code sessions, using
the same private, cookie-authenticated APIs as claude.ai. No desktop bridge or API key. The host
must support `web_sign_in` and secure storage; iOS has not been live-tested.

## Setup

1. Run `pebble build` in `claude/`, then `pebble install --phone <ip>` (or sideload
   `build/claude.pbw` through Apps → Sideload App). Web sign-in needs a store plugin or a
   debug-build sideload.
2. Open Claude plugin settings and sign in with Claude. On hosts without sign-in popup support,
   choose **Continue with email**; the Google popup flow does not complete on those hosts.
3. Select an organization (required when the account has multiple organizations).
4. Under **Where messages go**, keep **Start a new chat each time** (the default) or choose
   **Send to a default chat** and pick one: load **Claude chats** or **Claude Code**, select a
   chat, and save it as the default. Load more follows the server's pagination cursor. Filtering
   searches loaded rows.

Sign-in uses `Pebble.webSignIn` to capture `sessionKey`, verifies membership with
`GET /api/organizations`, and stores the credential in `Pebble.secureStorage`. This grants
account access, not a narrowly scoped messaging permission. Disconnect removes the plugin's saved
credential; it does not revoke the browser session.

## Contract

The plugin is an Index agent destination (see `agent` in [plugins.md](../plugins.md)).

- `send_to_agent({message, chat_id?})`: with `chat_id` omitted, starts a new Claude conversation
  for the message, or sends to the saved default chat when settings say so. `chat_id` is an
  `instanceId` from `agent/chats`; a nickname or part of a title also resolves. Exact nicknames
  take priority; ambiguous matches fail without sending. Returns a submission receipt, not
  Claude's answer.
- `agent/chats`: one instance per chat across both kinds (first page of each, most recent first).
  `instanceId` is the chat id (`chat:<uuid>` or `code:<cse_… or session_…>`), `name` is the
  nickname when one is set and otherwise the title; `title` and `url` are also served.
- `agent/configured`: true once signed in and an organization is chosen; in default-chat mode a
  default chat must be saved too. `name` is "New chat" or the default chat's nickname or title.

The plugin re-fetches an existing chat in the chosen organization before sending. The only
conversation it creates is the empty one a new-chat send starts with; it never changes a chat
branch, changes permissions, or automatically retries a send.

### Nicknames and defaults

Select a chat in settings, enter a nickname (up to 40 characters), and save it, optionally as the
default. Nicknames are case-insensitive and unique within the selected organization; assigning an
existing nickname moves it to the selected chat. Clear the field to remove a nickname. Changing
organization clears the default. Existing sign-in and default settings are preserved on upgrade.

## API behavior and limitations

- Chat list: `/api/organizations/{org}/chat_conversations`; a new chat is POSTed there with a
  fresh `uuid` and empty name, and the first message is sent under the root message id. A failed
  create sends nothing and is reported as unavailable, not as uncertain delivery.
- Chat detail: `/api/organizations/{org}/chat_conversations/{id}?tree=True&rendering_mode=messages&render_all_tools=true`.
- Chat send: POST `…/{id}/completion`, with the current leaf and fresh human/assistant UUIDs. A
  completed SSE response supplies the actual human message ID (Claude may replace the requested
  UUIDs). A subsequent read can also verify the requested human UUID. A bare HTTP 200 is
  insufficient.
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

