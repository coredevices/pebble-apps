# Tasks.org

Creates reminders in the tasks.org Android app and exposes the user's task lists so an agent can choose a destination.

Android only, with the tasks.org app installed. Optionally choose a default list. Build: see the [repository README](../README.md#building).

## Functions

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a task in the tasks.org app. Use instanceId from the reminders/list source to choose a list; otherwise the configured list or the user's default list is used. due_iso is an absolute RFC3339 instant and must include the requested wall time's real UTC offset (for example, 2026-08-27T14:30:00-07:00 for 2:30 PM in Los Angeles, never 14:30:00Z). notify_before_ms adds an early notification when a due time is supplied.

- `title` (string): Task title.
- `due_iso` (string, optional): absolute RFC3339 due time with Z or a numeric UTC offset.
- `timezone` (string, optional): IANA time-zone name supplied by Index for context.
- `notify_before_ms` (integer, optional): early-notification lead in milliseconds; used only with due_iso.
- `instanceId` (string, optional): tasks.org list id from the reminders/list source.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `reminders/list`: name, destination, url
