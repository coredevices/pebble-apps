# ChatGPT

Index plugin that sends messages to your ChatGPT Dot, to ChatGPT chats, to Codex sessions running on
your computers, and to Codex Cloud tasks. Every action is send-only: it returns a receipt, not the
reply (a ChatGPT chat's receipt quotes the start of the reply when it finished in time).

`plugin.js` is generated: the source is in [`..`](..)
(`npm ci && npm run build && npm test` there).

## Sign-in

One sign-in serves the Dot, ChatGPT chats and Codex Cloud (`codex-auth.js`). It uses the host's
`Pebble.webSignIn` (our-store apps, or any sideload in a debug build) to capture ChatGPT's
`__Secure-next-auth.session-token` cookie (split into `.0` and `.1`, which the settings page joins),
which the plugin trades at `chatgpt.com/api/auth/session` for an access token. Both live in
`Pebble.secureStorage`, in one copy: renewing rotates the session token, so every feature reads the
same saved session, and concurrent calls in a plugin session share one renewal. Access tokens renew
five minutes before expiry, or after a 401 from the Dot. The tokens grant broad ChatGPT account
access; the plugin uses them only for the features below. Signing in again with another account
drops the old account's Dot, paired computers and cached chats; signing out removes all of them.

Up to v0.3 the Dot and Codex each had their own sign-in. The first read after updating keeps the
more recently renewed of the two (by access-token expiry) and drops the Dot's copy, so nobody signs in
again.

## Dot

On sign-in the plugin looks for the account's primary Dot and verifies its one-to-one room belongs
to the signed-in user; only the room and the Dot's name are saved. No Dot (or no reaching it) still
signs in, and settings say why. Messages are posted to that room.

Protocol reference: [beeper/chatgpt-dots](https://github.com/beeper/chatgpt-dots) (AGPL; this
plugin is an independent implementation and contains none of its code).

## ChatGPT chats

Standard chatgpt.com conversations (`chatgpt-chats.js`) use the shared sign-in and send as the web app does: `POST /backend-api/sentinel/chat-requirements` (with a requirements
proof), the sentinel's proof of work (sha3-512 of seed + base64 browser config, at most 5 s so the
reply fits the host's 20 s action limit), `POST /backend-api/f/conversation/prepare` for the conduit
token, then `POST /backend-api/f/conversation`, whose event stream (v1 deltas) the host fetch
returns whole. Continuing a chat first reads its `current_node`. When the sentinel asks for a
turnstile or Arkose check, or the proof of work runs out of time, the send is refused: only a
browser can pass those. Recent chats come from `GET /backend-api/conversations` and join the Codex
chats in one list, with nicknames and the default chat.

Protocol reference: [gpt4free](https://github.com/xtekky/gpt4free) `g4f/Provider/needs_auth/OpenaiAccount.py`
and `g4f/Provider/openai/` (as of October 2026). Undocumented and guarded against bots; it may break.

## Codex

Codex uses the shared sign-in's access token as the bearer for both halves:

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

Both kinds show up as one list of Codex chats (`codex-chats.js`), most recent first, served with the
Dot as `agent/chats`. In settings the user gives Codex chats nicknames and picks a default chat;
`send_to_agent` takes a chat id from `agent/chats`, a nickname, or part of a title, and with none goes
to the Dot or the default Codex chat, whichever settings choose (falling back to whichever is set up).
The default chat and nicknames belong to the Codex account they were set under (v0.2.0's untagged
ones go to the first account that reads them); another account starts without them.

Protocol references: [openai/codex](https://github.com/openai/codex) (`codex-rs/app-server-protocol`,
`app-server-transport/src/transport/remote_control`), and
[0xSero/litter](https://github.com/0xSero/litter) (`shared/rust-bridge/codex-slingshot`) for the
client side of the relay. Both APIs are undocumented and may change.
