# ChatGPT

Index plugin that sends messages to your ChatGPT Dot, to Codex sessions running on your computers,
and to Codex Cloud tasks. Every action is send-only: it returns a receipt, not the reply.

`plugin.js` is generated: the source is in [`..`](..)
(`npm ci && npm run build && npm test` there).

## Dot

Sign-in uses the host's `Pebble.webSignIn` (our-store apps, or any sideload in a debug build) to
capture ChatGPT's `__Secure-next-auth.session-token` cookie (split into `.0` and `.1`, which the
settings page joins), which the plugin trades at
`chatgpt.com/api/auth/session` for an access token. Both live in `Pebble.secureStorage`. They grant
broad ChatGPT account access, not a Dots-only scope; the plugin uses them only to find the primary
Dot, verify its one-to-one room belongs to the signed-in user, and post messages to that room.
Access tokens renew from the session token five minutes before expiry or after a 401.

Protocol reference: [beeper/chatgpt-dots](https://github.com/beeper/chatgpt-dots) (AGPL; this
plugin is an independent implementation and contains none of its code).

## Codex

Codex signs in the same way as the Dot (its own `webSignIn` of the chatgpt.com session cookie, traded
at `chatgpt.com/api/auth/session`), and that access token is the bearer for both halves:

- **Codex Cloud** (`chatgpt.com/backend-api/wham/tasks`): new tasks in an environment's default
  branch, and follow-ups on an existing task's latest turn. Environment objects carry the user's
  secrets, so only ids, labels and branches leave `codex-cloud.js`.
- **Sessions on your computers**, through the ChatGPT remote-control relay the Codex mobile app
  uses. Enrolling this phone takes a step-up token from the Codex CLI's OAuth client
  (`codex.remote_control.enroll`, `max_age=0`), which only redirects to `localhost:1455`: the
  settings page shows the sign-in link to open in a browser and takes back the address the browser
  ends on. The settings page also supplies the PKCE and P-256 device-key randomness, since plugins
  on iOS have no `crypto`. Each send opens `wss://chatgpt.com/backend-api/codex/remote/control/client`
  (handshake headers need the host's non-standard `WebSocket(url, protocols, { headers })`), signs
  the relay's device-key challenge, and speaks the Codex app-server's JSON-RPC through the relay's
  envelopes: `initialize`, `thread/list`, then `thread/queue/add`, which runs at once on an idle
  session. The computer needs remote control on: the Codex app, or `codex remote-control start`.

Both kinds show up as one list of Codex chats (`codex-chats.js`), most recent first. In settings the
user picks a default chat and gives chats nicknames; `send_to_codex` takes a nickname, a chat id from
`list_codex_chats`, or part of a title, and with none goes to the default.

Protocol references: [openai/codex](https://github.com/openai/codex) (`codex-rs/app-server-protocol`,
`app-server-transport/src/transport/remote_control`), and
[0xSero/litter](https://github.com/0xSero/litter) (`shared/rust-bridge/codex-slingshot`) for the
client side of the relay. Both APIs are undocumented and may change.
