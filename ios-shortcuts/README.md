# iOS Shortcuts

Connects Index and Pebble with Apple's Shortcuts app. Index can run allow-listed shortcuts with text or JSON input and display their textual output; Shortcuts automations can submit text to Index, control Pebble Quiet Time, or publish an event back to Index.

iOS only. Allow-list shortcuts in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `run_shortcut(shortcut, input?, payload?)`

Run one of the shortcuts allow-listed in this plugin's settings on the paired iPhone or iPad. Use the shortcut's configured label or exact Apple Shortcuts name. Pass either input for plain text or payload for structured JSON, never both. The shortcut's textual output is returned to Index and displayed in the action result.

- `shortcut` (string): Configured label or exact Apple Shortcuts name. Read shortcuts/shortcut first when the available names are unknown.
- `input` (string, optional): plain-text Shortcut Input.
- `payload` (object, optional): Optional structured Shortcut Input; serialized as JSON text before launch.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `shortcuts/shortcut`: name, shortcut_name, description
- `shortcuts/input`: name, command, input, result, status, received_at
