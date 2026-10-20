# Google Tasks & Keep

*Uses Google Keep's and Google Tasks' internal app endpoints with an Android sign-in token, reverse engineered; Keep has no public API for personal accounts.*

Saves notes to Google Keep and creates reminders in Google Tasks through one shared Google account.

Sign in with Google in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text)`

Save a note to Google Keep. Google Keep is the notes destination for this shared Google integration.

- `instanceId` (string, optional): Google Keep destination id. One of `google-keep`.
- `text` (string): The note text, preferably using the user's exact words.

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a Google Tasks reminder. Use instanceId from reminders/list for a named task list; omit it for My Tasks. due_iso is an absolute ISO-8601 instant and timezone is the user's IANA time zone. Omit due_iso for an undated task.

- `title` (string): Reminder title.
- `due_iso` (string, optional): absolute due instant in ISO-8601 format. Omit for an undated task.
- `timezone` (string, optional): IANA time-zone name used to preserve the user's local date and time. Required with due_iso.
- `notify_before_ms` (integer, optional): notification lead time. Google Tasks cannot configure this per task, so it is accepted but not applied.
- `instanceId` (string, optional): Google Tasks list ID from reminders/list. Omit for My Tasks.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, account
- `reminders/list`: name, destination, url
- `notes/configured`: name, configured
- `reminders/configured`: name, configured
