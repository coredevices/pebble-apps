# Workflowy

Adds notes and todos to your Workflowy outline: notes to your Inbox or a shortcut, todos to a list or to their day in the Workflowy calendar.

Paste your [Workflowy API key](https://workflowy.com/api-key) in plugin settings and choose where notes and undated todos go (Inbox, Today, Tomorrow, Next Week or any of your Workflowy shortcuts). Workflowy sends no alerts, so todos here are not timed reminders. Build: see the [repository README](../README.md#building).

## Functions

### `create_note(instanceId?, text)`

Add plain text as a bullet at the top of the user's chosen Workflowy location (Inbox by default). The first line becomes the bullet and any further lines its note. Use only when the user explicitly asks to save or send a note to Workflowy.

- `instanceId` (string, optional): destination id from the notes/destination source. One of `workflowy`.
- `text` (string): The complete note text, preferably the user's exact words.

### `create_reminder(instanceId?, title, due_iso?, timezone?, notify_before_ms?)`

Add a todo (checkbox bullet) to Workflowy. Use instanceId from reminders/list to choose a list (Inbox, Today, Tomorrow, Next Week or one of the user's shortcuts). With due_iso and no instanceId the todo goes on that day in the Workflowy calendar, with the date and time on it; with neither it goes to the user's default list. Workflowy sends no alerts or notifications, so use it only when the user explicitly asks for a todo or reminder in Workflowy, never for a reminder that must alert them.

- `instanceId` (string, optional): list id from the reminders/list source.
- `title` (string): Todo text.
- `due_iso` (string, optional): RFC3339 instant with the requested local wall time and its real UTC offset.
- `timezone` (string, optional): IANA time-zone name used to write the date and time; defaults to the phone's zone.
- `notify_before_ms` (integer, optional): ignored.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `notes/destination`: name, configured, location
- `notes/configured`: name, configured
- `reminders/list` (multiple): name, destination, url
- `reminders/configured`: name, configured
