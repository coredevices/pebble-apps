# Find My Phone

One-click watchapp that rings the phone, even on silent. Pick it in the launcher and the phone
rings while the watch goes back to the watchface; its launcher row says "Ringing · open to stop".
Pick it again within the minute to stop the ringing. Otherwise the phone stops by itself after a
minute and the row goes back to normal. If the phone can't be reached, the app stays open and says
why.

It calls the app's built-in Find My Phone `ring` and `stop` actions, which need the `FindMyPhone`
permission. Build: see the [repository README](../README.md#building) (needs the Pebble SDK).
