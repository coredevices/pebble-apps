# Complication Face (Plugin Demo)

Demo watchface for the plugin API: the time and date with two slots filled from the user's preferred
readings (`preferences/complications`), each showing a bitmap or a value. The first slot takes the
first reading it can draw, as a bitmap if it has one. The second prefers the next reading of the
other kind, and otherwise takes the next reading it can draw. Needs the Pebble SDK to build; see the
[repository README](../README.md#building).

## Functions

None. It only reads other plugins' sources.
