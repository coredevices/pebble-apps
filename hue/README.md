# Hue

Philips Hue lights on the user's local bridge. Reads whether a light, a room or the whole home is on and how bright it is; turns them on and off and dims them.

Pair with the Hue bridge on your network in plugin settings. Build: see the [repository README](../README.md#building).

## Functions

### `set_on(item, instanceId, on)`

Turn a light, a room or the whole home on or off.

- `item` (string): Which kind of thing instanceId names. One of `home_lights`, `room_lights`, `light`.
- `instanceId` (string): Id from the matching home/* source.
- `on` (boolean)

### `set_brightness(item, instanceId, percent)`

Set brightness as a percentage. 0 turns it off.

- `item` (string): Which kind of thing instanceId names. One of `home_lights`, `room_lights`, `light`.
- `instanceId` (string): Id from the matching home/* source.
- `percent` (integer)

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `home/room_lights,light`: name, on, brightness
- `home/home_lights`: name, on, brightness
