## 0.4.1

- Sign-in could fail with "Could not reach Grok Bot" right after the browser said "All set" (MOB-17409). Boxes that Cursor gives a port token instead of a network token are now reached with it, as the Grok Bot desktop app does.
- More sign-in logging, so the next failure says why: each box lookup logs which fields Cursor returned and which box header was sent (names only), network errors and timeouts log their redacted message, and a failed box request logs its redacted error body.

## 0.4.0

- Simpler settings, in the style of the Claude plugin: one row per thing you say and where it goes. One dropdown sets where hold to speak and "Tell Grok …" go; choosing a bot saves it.
- Settings show nicknames as chips with "Edit names", and that "… tell my *bot name* to …" sends to the bot with those words in its name.
- Signed out, settings show only the sign-in button. Sign in again, sign out and reload bots are under Account.
- Clearer wording: drop the duplicated status lines and explain the unofficial API.
