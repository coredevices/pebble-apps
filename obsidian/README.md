# Obsidian/Markdown Notes

Creates separate Markdown notes or safely appends to a selected existing note in a user-selected folder, with Obsidian-compatible tasks and links.

Choose the folder (your vault) and note in plugin settings; the folder is picked with the app's file picker, so the plugin declares `ReadFiles` and `WriteFiles`. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text, location?)`

Save a note as a Markdown file in the configured folder: a new timestamped note, or a block appended to the selected existing note. Use only when the user explicitly asks to save or send a note to Obsidian/Markdown. Optional location metadata is included only when the user supplied it.

- `instanceId` (string, optional) One of `markdown-notes`.
- `text` (string)
- `location` (object, optional)

### `create_reminder(instanceId?, title, due_iso?, timezone?, notify_before_ms?, location?)`

Append an Obsidian Tasks-compatible checklist item to the configured reminder file. Use only when the user explicitly asks for a reminder or task in Obsidian/Markdown. due_iso is an absolute ISO-8601 instant and timezone is the user's IANA time zone.

- `instanceId` (string, optional) One of `markdown-reminders`.
- `title` (string)
- `due_iso` (string, optional)
- `timezone` (string, optional)
- `notify_before_ms` (integer, optional)
- `location` (object, optional)

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, path
- `notes/configured`: name, configured
- `reminders/list`: name, destination, path
- `reminders/configured`: name, configured
