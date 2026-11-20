## 0.5.2

- A message to a ChatGPT chat is confirmed as soon as ChatGPT has it, and the confirmation no longer quotes ChatGPT's reply. Read the answer in the ChatGPT app.

## 0.5.1

- Long requests to a ChatGPT chat no longer time out with "plugin did not respond" while ChatGPT writes its reply: a message counts as sent once ChatGPT has saved it, new chats included, without waiting for the whole reply. So the receipt now rarely quotes the reply. If ChatGPT hasn't saved it within about 10 seconds, it waits for the reply as before.

## 0.5.0

- Start a new Codex session on one of your computers: pick a computer and project folder next to "… start a new task …" in settings, then say "start a new task …". A new Codex Cloud task in a chosen environment works the same way.
- Simpler settings: one Hold to speak dropdown (your Dot, a new ChatGPT chat, or any ChatGPT chat, Codex session or Cloud task), then one row per thing you say and where it goes. Sign-in and connecting computers fold under Account.
- Your Dot stays the default until you choose another destination; with no Dot, messages start a new ChatGPT chat instead of failing.
- Settings show that "… tell my *chat name* to …" sends to the chat or Codex session with those words in its title.
- If starting a session provably fails, it says nothing was sent; if the session may have started or the first message may not have arrived, it says to check before sending again.
