## 0.5.0

- Start a new Claude Code session on a chosen computer or environment: pick it next to "… start a new task …" in settings, then say "start a new task …".
- Simpler settings: choose your organization first (skipped with only one), then one row per thing you say and where it goes. One dropdown sets where hold to speak and "Tell Claude …" go.
- Claude Duet is the default destination when your account has it and you have not chosen one yet.
- Settings show that "… tell my *session name* to …" sends to the chat or Code session with those words in its title.
- If starting a session fails, it says nothing was sent; if the first message may not have arrived, it says to check before sending again.
- Settings list chats, Code sessions and computers separately, so one failing to load doesn't hide the others, and show nicknames on older chats.
- Clearer wording: drop the "Continue with email" sign-in hint (Google sign-in works) and explain the unofficial API.

## 0.4.1

- Explain why each permission is needed, and mark which are required.

## 0.4.0

- Add Claude Duet as an opt-in message destination in settings, using its existing main conversation.
- Verify Duet availability and delivery acknowledgment without retrying uncertain sends.
- Preserve existing Claude and Claude Code defaults; Duet is disabled until explicitly selected.
- Show Claude Duet only when an existing available conversation is detected after sign-in or when settings reopen.
