# Find My Phone

Watchapp that rings the phone, even on silent. Select rings the phone, and Select again stops it;
leaving the app stops it too. The phone stops by itself after a minute.

The first Select subscribes to the app's built-in Find My Phone source (subscribing starts the
ringing, and the subscription ending stops it); after that, Select calls its `ring` and `stop`
actions. Needs the `FindMyPhone` permission. Build: see
the [repository README](../README.md#building) (needs the Pebble SDK).
