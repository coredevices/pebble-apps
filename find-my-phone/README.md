# Find My Phone

Watchapp that rings the phone, even on silent. Opening it rings the phone and the app stays open: Select
stops the ringing and rings it again, and leaving the app stops it too. The phone stops by itself
after a minute.

It subscribes to the app's built-in Find My Phone source (the ringing lasts as long as the
subscription), and Select calls its `ring` and `stop` actions. Needs the `FindMyPhone` permission. Build: see
the [repository README](../README.md#building) (needs the Pebble SDK).
