# Apple Notes

*Uses iCloud's private Notes web service and Apple's private sign-in, reverse engineered; not an official Apple API.*

Saves plain-text input as new Apple Notes or appends it to a configured existing note through iCloud.

Sign in to iCloud in plugin settings and choose a note destination. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text)`

Save plain text to the configured Apple Notes destination, either as a new note or appended to one selected note. Use only when the user explicitly asks to save or send a note to Apple Notes.

- `instanceId` (string, optional): destination id from the notes/destination source. One of `apple-notes`.
- `text` (string): The complete note text, preferably using the user's exact words. In new-note mode its first line becomes the title; in append mode it is added at the configured placement.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, account, url
- `notes/configured`: name, configured
