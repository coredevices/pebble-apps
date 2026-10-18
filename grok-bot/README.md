# Grok Bot Pebble plugin

Two actions:

- `send_to_grok_bot({ message })` sends to the bot chosen in settings and returns a receipt.
  It does not wait for the reply: stock CoreApp gives plugins no timers and a 20 s action limit.
- `read_grok_bot({ limit? })` returns the bot's latest replies.

Settings open Grok Bot sign-in, list the account's bots and groups, and save the
choice. The first bot is the default.

## How it reaches Grok Bot

This uses no desktop app and no bridge. It is the same private API the Grok Bot apps use.

1. **Sign-in** is the Grok Bot app's own login:
   - The settings page opens `cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=sand`
     through `Pebble.webSignIn`, which returns once Cursor's `WorkosCursorSessionToken` cookie exists.
   - The plugin then polls `api2.cursor.sh/auth/poll` until it returns a Cursor access token,
     and keeps it in `Pebble.secureStorage`.
   - Grok Bot accounts are Cursor accounts. The token lasts about 60 days and cannot be
     refreshed, so when it expires the user signs in again.
2. Each action calls `POST api2.cursor.sh/aiserver.v1.GrokBotService/EnsureSandBox` with that
   token. The reply gives the user's box (`https://…cursorvm.com`), a gateway token and
   network headers.
3. The action then calls `POST {box}/api/<method>`:
   - `listAgents` for bots and groups.
   - `sendPrompt {agentId, prompt, clientNonce}` to send.
   - `getAgentTranscriptTail {id, limit}` to read. Bot replies are
     `{kind: "send-message", message: {content}}` entries.

Delivery rules:

- A whole send is capped at 18s, below the host's 20s action limit. With under 8s left, it
  refuses to send at all. These caps need a host timer; without one the host's limit applies.
- Once Grok Bot accepts a message, the action always answers with a receipt, never a
  retryable error.
- A send that may or may not have landed reports "delivery uncertain" and is never retried.

The box URL must be https on `*.cursorvm.com`. Tokens, box URLs and server bodies never
leave the plugin in results or errors. The host's XHR logger records only the exception
type of a failed request, because exception text can carry the private host name.

This API is unofficial and undocumented, so it can change with any Grok Bot update. Method
names follow the open-source clients
[grok-bot-cli](https://github.com/ScriptedAlchemy/grok-bot-cli) and
[grokbot-sdk](https://github.com/adam91holt/grokbot-sdk).

## Build and test

`plugin.js` is plain JS with no build step and no dependencies.

```sh
cd grok-bot
npm test
cd ../../..
python3 scripts/pack-plugin-pbw.py grok-bot
```

`:androidApp:buildTestAppPbws` packages it for both apps along with the other test apps.
