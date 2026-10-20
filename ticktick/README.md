# TickTick

Creates reminders in TickTick and exposes the user's open TickTick lists so an agent can choose a destination.

Connect TickTick in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a TickTick reminder. Use instanceId from the reminders/list source to choose a TickTick list; omit it to create the reminder in Inbox. due_iso is an absolute RFC3339 instant and must include the requested wall time's real UTC offset (for example, 2026-08-27T14:30:00-07:00 for 2:30 PM in Los Angeles, never 14:30:00Z); timezone is the matching IANA name.

- `title` (string): Reminder title.
- `due_iso` (string, optional): RFC3339 instant. Include the requested local wall time and its real numeric UTC offset; do not append Z to a non-UTC local time.
- `timezone` (string, optional): IANA time-zone name used by TickTick. Required whenever due_iso is supplied.
- `notify_before_ms` (integer, optional): notification lead time in milliseconds. Ignored when no due time is supplied.
- `instanceId` (string, optional): TickTick project ID from the reminders/list source. Omit for Inbox.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `reminders/list`: name, destination, url
- `reminders/configured`: name, configured
