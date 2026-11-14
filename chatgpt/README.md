# ChatGPT

*Uses ChatGPT's private web APIs (Dot, ChatGPT chats, Codex Cloud) and the undocumented Codex remote-control relay, reverse engineered from the ChatGPT and Codex apps; not the OpenAI API.*

Send messages to your ChatGPT Dot, to ChatGPT chats (a new one or a recent conversation), to Codex sessions running on your computers, and to Codex Cloud tasks. With no chat named, sends to your Dot (the default when the account has one), a new ChatGPT chat or the chat chosen in settings. Supports chat nicknames. Say "start a new task" to start a new Codex session in a project folder on one of your computers, or a new Codex Cloud task, as chosen in settings. Sign in in settings.

Sign in once with ChatGPT in plugin settings (it covers the Dot, ChatGPT chats and Codex Cloud); pair a computer there to reach Codex sessions. Build: see the [repository README](../README.md#building).

## Functions

### `send_to_agent(message, chat_id?)`

Send a message to the user's ChatGPT Dot, to a ChatGPT chat (a new one, or a recent chatgpt.com conversation), or to one of their Codex chats: a Codex session running on their computer, or a Codex Cloud task. chat_id is an instanceId from agent/chats ("new-chat" starts a new ChatGPT chat), or a chat nickname or part of its title; "new task" starts a new Codex session on the computer and project folder chosen in settings (or a new Codex Cloud task, if settings choose that), with the message as its first prompt; omit it to send where settings choose (the Dot, a new ChatGPT chat or a default chat). Never use it for notes, reminders, or messages meant for anyone else. Returns a receipt, not the reply; a ChatGPT chat's receipt may quote the start of the reply. Do not automatically retry an uncertain delivery.

- `message` (string): What to tell the Dot, ChatGPT or Codex, without the "tell my Dot", "ask ChatGPT" or "tell Codex" instruction itself.
- `chat_id` (string, optional): The chat's instanceId from agent/chats ("new-chat" for a new ChatGPT chat), or a chat's nickname or part of its title. Use "new task" when the user asks to start a new task or Codex session. Omit to send where settings choose.

### `start_codex_cloud_task(prompt, environment?)`

Start a new Codex Cloud task (chatgpt.com/codex), which works in a cloud copy of one of the user's GitHub repositories. Use when the user asks for coding work in Codex Cloud or on a named repo rather than in a session on their computer; for a plain "start a new task", use send_to_agent with chat_id "new task", which follows settings. Returns a receipt; the task takes minutes to run.

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
- `agent/configured`: name, configured. True once signed in: a send with no chat named then goes
  somewhere. `name` is that destination (the Dot's name, "New ChatGPT chat", or the chosen chat's
  nickname or title).

## Settings

- **Hold to speak** sets where hold-to-speak and "Tell ChatGPT …" go: your Dot (the default when
  the account has one, until you choose), a new ChatGPT chat (the default otherwise), or a
  ChatGPT chat, Codex session or Codex Cloud task. If the chosen one isn't set up, the Dot, then
  the default chat, then a new chat is used.
- **"… start a new task …"** picks where new tasks start: a new Codex session in a project folder
  on one of your computers (the folders of each computer's recent sessions), a new Codex Cloud task
  in an environment, or Off. `chat_id` `"new task"` (also `new session`, `new codex session`,
  `new codex task`) then starts it with the message as its first prompt; an existing nickname with
  one of those names still wins. With no `chat_id`, a message starting "start a new task/session …"
  does the same with that phrase stripped, or starts a new ChatGPT chat when Off; "start a new
  chat …" always starts a new ChatGPT chat.
- **Edit names** gives any chat a nickname to say. Naming part of a chat's title also works.
- **Account**: sign in or out, and connect and pair your computers for Codex sessions.
