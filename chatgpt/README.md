# ChatGPT

*Uses ChatGPT's private web APIs (Dot, Codex Cloud) and the undocumented Codex remote-control relay, reverse engineered from the ChatGPT and Codex apps; not the OpenAI API.*

Send messages to your ChatGPT Dot, to Codex sessions running on your computers, and to Codex Cloud tasks. With no chat named, sends to your Dot or your default Codex chat, as chosen in settings. Supports Codex chat nicknames. Sign in in settings.

Sign in to ChatGPT in plugin settings; pair a computer there to reach Codex sessions. Build: see the [repository README](../README.md#building).

## Functions

### `send_to_agent(message, chat_id?)`

Send a message to the user's ChatGPT Dot or one of their Codex chats: a Codex session running on their computer, or a Codex Cloud task. chat_id is an instanceId from agent/chats, or a Codex chat nickname or part of its title; omit it to send to the user's Dot or their default Codex chat, whichever settings choose. Never use it for notes, reminders, or messages meant for anyone else. Returns a receipt, not the reply. Do not automatically retry an uncertain delivery.

- `message` (string): What to tell the Dot or Codex, without the "tell my Dot" or "tell Codex" instruction itself.
- `chat_id` (string, optional): The chat's instanceId from agent/chats, or a Codex chat's nickname or part of its title. Omit to send to the Dot or the default Codex chat, as chosen in settings.

### `start_codex_cloud_task(prompt, environment?)`

Start a new Codex Cloud task (chatgpt.com/codex), which works in a cloud copy of one of the user's GitHub repositories. Use when the user asks for coding work in the cloud or on a repo rather than in a session on their computer. Returns a receipt; the task takes minutes to run.

- `prompt` (string): The task for Codex, without the "ask Codex Cloud" instruction itself.
- `environment` (string, optional): The Codex Cloud environment's name (usually the repository). Omit for the user's pinned or first environment.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `agent/chats`: name, title. One instance per chat: the Dot (`instanceId` `dot`, named after the
  Dot), then Codex chats most recent first (sessions on online computers, first page of Codex Cloud
  tasks), with the session or task id as `instanceId` and the nickname, else the title, as `name`.
  Codex chats come from the signed-in account's last listing when it is under 5 minutes old;
  otherwise the read lists them afresh, falling back to the last listing if neither half answers.
- `agent/configured`: name, configured. True once a send with no chat named has somewhere to go:
  the Dot is signed in, or Codex is signed in with a default chat. `name` is that destination (the
  Dot's name, or the default chat's nickname or title).

With both the Dot and a Codex default chat set up, settings choose which one gets messages with no
chat named (the Dot unless changed); if the chosen one isn't set up, the other is used.
