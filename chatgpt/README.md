# ChatGPT

*Uses ChatGPT's private web APIs (Dot, Codex Cloud) and the undocumented Codex remote-control relay, reverse engineered from the ChatGPT and Codex apps; not the OpenAI API.*

Send messages to your ChatGPT Dot, to Codex sessions running on your computers, and to Codex Cloud tasks. Sign in in settings.

Sign in to ChatGPT in plugin settings; pair a computer there to reach Codex sessions. Build: see the [repository README](../README.md#building).

## Functions

### `send_to_dot(message)`

Send a message to the user's ChatGPT Dot (their existing primary Dot in ChatGPT). Do not use unless the user explicitly addresses their Dot or asks to send something to it, as "Dot" or "my Dot" or by the Dot's own name, e.g. "message my Dot …", "tell Dot …", "ask my Dot …" or "tell Taz …" when the Dot is named Taz. The Dot's name is in the 'ChatGPT: messaging/dot' source; when the user messages a name that is not clearly one of their contacts, read that source to check whether it is their Dot. Never use it for notes, reminders, or messages meant for anyone else. Returns a delivery receipt, not the Dot's answer. Do not automatically retry an uncertain delivery.

- `message` (string): The text to deliver to the Dot, without the "send to my Dot" instruction itself.

### `send_to_codex(message, chat?)`

Send a message to one of the user's Codex chats: a Codex session running on their computer, or a Codex Cloud task. Use when the user says "send … to Codex", "tell Codex …", or names one of their Codex chats or its nickname (e.g. "tell the BLE chat to run the tests"). With no chat named it goes to the default chat the user picked in settings. Returns a receipt, not Codex's answer. Do not automatically retry an uncertain delivery.

- `message` (string): What to tell Codex, without the "tell Codex" instruction itself.
- `chat` (string, optional): The chat's nickname, its id from list_codex_chats, or part of its title. Omit to use the default chat.

### `list_codex_chats(computer?)`

List the user's Codex chats, most recent first: sessions on their online computers and their Codex Cloud tasks, with nicknames, which is the default, and chat ids. Use when the user asks what Codex chats they have, or when it is unclear which chat they mean; then pass the nickname or chat id to send_to_codex.

- `computer` (string, optional): Only this computer's sessions. Omit for every online computer and Codex Cloud.

### `start_codex_cloud_task(prompt, environment?)`

Start a new Codex Cloud task (chatgpt.com/codex), which works in a cloud copy of one of the user's GitHub repositories. Use when the user asks for coding work in the cloud or on a repo rather than in a session on their computer. Returns a receipt; the task takes minutes to run.

- `prompt` (string): The task for Codex, without the "ask Codex Cloud" instruction itself.
- `environment` (string, optional): The Codex Cloud environment's name (usually the repository). Omit for the user's pinned or first environment.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `messaging/dot`: name, configured
