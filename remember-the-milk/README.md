# Remember The Milk

Creates Remember The Milk tasks as reminders and exposes the user's lists as reminder destinations.

Connect Remember The Milk in plugin settings with your own [API key and shared secret](https://www.rememberthemilk.com/services/api/keys.rtm); every API call is signed with them. Build: see the [repository README](../README.md#building).

## Functions

### `create_reminder(title, due_iso?, timezone?, notify_before_ms?, instanceId?)`

Create a Remember The Milk task. Use instanceId from reminders/list to choose a list; omit it for Inbox. The title is added as is, without Smart Add parsing.

- `title` (string): Reminder title.
- `due_iso` (string, optional): absolute ISO-8601 instant with Z or a numeric offset.
- `timezone` (string, optional): IANA time-zone name. Required whenever due_iso is supplied.
- `notify_before_ms` (integer, optional): accepted but not stored; Remember The Milk reminds by the account's reminder settings.
- `instanceId` (string, optional): list ID from the reminders/list source. Omit for Inbox.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `reminders/list`: name, destination, url (smart, archived and deleted lists are left out)
- `reminders/configured`: name, configured
