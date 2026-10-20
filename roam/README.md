# Roam Research

Captures notes to today's Roam daily note using an append-only graph token.

Enter your graph name and an append-only API token in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text)`

Capture plain text to today's daily note in the configured Roam graph. Use only when the user explicitly asks to save or send a note to Roam Research.

- `instanceId` (string, optional): destination id from the notes/destination source. One of `roam`.
- `text` (string): The complete plain text to capture, preferably using the user's exact words.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, location, url
