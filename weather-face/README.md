# Weather Face (Plugin Demo)

Demo watchface for the plugin API. It finds a weather plugin with `Pebble.enumeratePlugins()`,
subscribes to its `weather/location` and `weather/hour` sources (MET Norway Weather provides them)
and shows the result on the watch. Needs the Pebble SDK to build; see the
[repository README](../README.md#building).

## Functions

None. It only reads other plugins' sources.
