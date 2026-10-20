# Todoist

Creates Todoist tasks as reminders and exposes active projects as reminder destinations.

Connect Todoist in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a Todoist task. Use instanceId from reminders/list to choose a project; omit it for Inbox. due_iso is an absolute ISO-8601 instant, timezone is its IANA time-zone context, and notify_before_ms is rounded to Todoist's whole-minute reminder precision.

- `title` (string): Reminder title.
- `due_iso` (string, optional): absolute due instant in ISO-8601 format.
- `timezone` (string, optional): IANA time-zone context. Required whenever due_iso is supplied.
- `notify_before_ms` (integer, optional): notification lead time in milliseconds. Todoist stores whole minutes.
- `instanceId` (string, optional): Todoist project ID from reminders/list. Omit for Inbox.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `reminders/list`: name, destination, url
- `reminders/configured`: name, configured
