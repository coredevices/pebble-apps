# Dashboard (Plugin Demo)

Demo plugin: serves a demo/message source whose text is set from the config page, and a confirmation-gated action that resets it.

Demo: set the message on the settings page. Build: see the [repository README](../README.md#building).

## Functions

### `clear_message(reason)`

Reset the demo message to its default text. Use only when the user asks to clear or reset the demo message.

- `reason` (string): Note on why the message is being cleared.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `demo/message`: text
