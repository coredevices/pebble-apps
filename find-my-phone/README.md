# Find My Phone

Watchapp that rings the phone, even on silent. While it is open the phone rings and the watch shows
"Back to stop"; leaving the app stops it. The phone stops by itself after a minute, and Select rings
it again.

It subscribes to the app's built-in Find My Phone source (the ringing lasts as long as the
subscription), and Select calls its `ring` action. Needs the `FindMyPhone` permission. Build: see
the [repository README](../README.md#building) (needs the Pebble SDK).
