# Obsidian/Markdown Notes

Creates separate Markdown notes or safely appends to a selected existing note in a user-selected folder, with Obsidian-compatible tasks and links.

Choose the folder (your vault) and note in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text, location?)`

Save a note as Markdown in the configured folder. Optional location metadata is included only when the user supplied it.

- `instanceId` (string, optional) One of `markdown-notes`.
- `text` (string)
- `location` (object, optional)

### `create_reminder(instanceId?, title, due_iso?, timezone?, notify_before_ms?, location?)`

Append an Obsidian Tasks-compatible Markdown reminder. due_iso is an absolute ISO-8601 instant and timezone is the user's IANA time zone.

- `instanceId` (string, optional) One of `markdown-reminders`.
- `title` (string)
- `due_iso` (string, optional)
- `timezone` (string, optional)
- `notify_before_ms` (integer, optional)
- `location` (object, optional)

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, path
- `reminders/list`: name, destination, path
