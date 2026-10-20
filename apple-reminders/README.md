# Apple Reminders

Creates reminders in the native Apple Reminders app using an optionally selected default list.

iOS only. Optionally choose a default list in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a reminder in Apple Reminders. Use instanceId from the reminders/list source to choose a list; otherwise the configured list or the system default is used. due_iso is an absolute RFC3339 instant. notify_before_ms adds an early notification when a due time is supplied.

- `title` (string): Reminder title.
- `due_iso` (string, optional): absolute RFC3339 due time with Z or a numeric UTC offset.
- `timezone` (string, optional): IANA time-zone name supplied by Index for context.
- `notify_before_ms` (integer, optional): early-notification lead in milliseconds; used only with due_iso.
- `instanceId` (string, optional): Apple Reminders list identifier from the reminders/list source.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `reminders/list`: name, destination, url
