# ChatGPT

*Uses ChatGPT's private web APIs (Dot, ChatGPT chats, Codex Cloud) and the undocumented Codex remote-control relay, reverse engineered from the ChatGPT and Codex apps; not the OpenAI API.*

Send messages to your ChatGPT Dot, to ChatGPT chats (a new one or a recent conversation), to Codex sessions running on your computers, and to Codex Cloud tasks. With no chat named, sends to your Dot or your default chat, as chosen in settings. Supports chat nicknames. Sign in in settings.

Sign in once with ChatGPT in plugin settings (it covers the Dot, ChatGPT chats and Codex Cloud); pair a computer there to reach Codex sessions. Build: see the [repository README](../README.md#building).

## Functions

### `send_to_agent(message, chat_id?)`

Send a message to the user's ChatGPT Dot, to a ChatGPT chat (a new one, or a recent chatgpt.com conversation), or to one of their Codex chats: a Codex session running on their computer, or a Codex Cloud task. chat_id is an instanceId from agent/chats ("new-chat" starts a new ChatGPT chat), or a chat nickname or part of its title; omit it to send to the user's Dot or their default chat, whichever settings choose. Never use it for notes, reminders, or messages meant for anyone else. Returns a receipt, not the reply; a ChatGPT chat's receipt may quote the start of the reply. Do not automatically retry an uncertain delivery.

- `message` (string): What to tell the Dot, ChatGPT or Codex, without the "tell my Dot", "ask ChatGPT" or "tell Codex" instruction itself.
- `chat_id` (string, optional): The chat's instanceId from agent/chats ("new-chat" for a new ChatGPT chat), or a chat's nickname or part of its title. Omit to send to the Dot or the default chat, as chosen in settings.

### `start_codex_cloud_task(prompt, environment?)`

Start a new Codex Cloud task (chatgpt.com/codex), which works in a cloud copy of one of the user's GitHub repositories. Use when the user asks for coding work in the cloud or on a repo rather than in a session on their computer. Returns a receipt; the task takes minutes to run.

- `prompt` (string): The task for Codex, without the "ask Codex Cloud" instruction itself.
- `environment` (string, optional): The Codex Cloud environment's name (usually the repository). Omit for the user's pinned or first environment.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `agent/chats`: name, title. One instance per chat: the Dot (`instanceId` `dot`, named after the
  Dot), `new-chat` ("New ChatGPT chat") once signed in to ChatGPT, then chats most recent first
  (sessions on online computers, first page of Codex Cloud tasks, the 20 most recent ChatGPT
  conversations), with the session, task or conversation id as `instanceId` and the nickname, else
  the title, as `name`. Chats come from the signed-in account's last listing when it is under 5
  minutes old; otherwise the read lists them afresh, falling back to the last listing if no part
  answers.
- `agent/configured`: name, configured. True once a send with no chat named has somewhere to go:
  the account has a Dot, or a default chat is chosen. `name` is that destination (the
  Dot's name, or the default chat's nickname or title).

With both the Dot and a default chat set up, settings choose which one gets messages with no
chat named (the Dot unless changed); if the chosen one isn't set up, the other is used.
