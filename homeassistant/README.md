# Home Assistant

The user's own Home Assistant: lights, rooms, switches, fans, covers, speakers, thermostats, locks, sensors (including door, window, motion and leak sensors), scenes, scripts and automations. Reads their state; turns things on and off, dims lights, sets colour, volume and temperature, locks and unlocks, and runs scenes, scripts and automations. It cannot add, change or delete anything in Home Assistant's configuration.

In plugin settings, enter Home Assistant's local address, optionally a remote address for when you're away, and a long-lived access token (Home Assistant → your profile → Security). The plugin uses whichever address answered last and falls back to the other.

The remote address can be Home Assistant Cloud (`*.ui.nabu.casa`, allowed at install) or any other domain, such as DuckDNS, your own domain or Tailscale. The first time the plugin connects to a new domain, the request is refused and the Pebble app adds "Connect to <domain>" to the plugin's Permissions. Turn it on and press Connect again. Settings keep the address and token in the meantime. On app versions without `Pebble.permissions`, the plugin can't tell a refused permission from an unreachable server, so it mentions both. Home Assistant areas are rooms; switch one off in settings to hide it and everything in it.

It serves the same items as the other home plugins, so faces and agents built for them work with it: `home/light`, `home/room_lights` and `home/home_lights` read like Hue's, and `home/device` and `home/automation` like Google Home's.

Build: see the [repository README](../README.md#building). Test: `npm test`.

## Functions

Every function but `run_automation` picks its targets the same way: either `instanceId` (with `item`) from a source below, or any of `name`, `room` and `type` together.

- `item` (string, optional): Which kind of thing instanceId names. One of `home_lights`, `room_lights`, `light`, `device`, `automation`.
- `instanceId` (string, optional): Id from the matching home/* source: an entity id, an area id, or `home`.
- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated.
- `room` (string, optional): Room (Home Assistant area) name, case-insensitive.
- `type` (string, optional): Device type such as light, switch, outlet, fan, cover, speaker, tv, thermostat or lock, or `all` for every kind.

### `toggle(selector)`

Turn a device, a room or the whole home on if it is off, or off if anything in it is on. Covers open and close.

### `set_on(selector, on)`

Turn devices, a room or the whole home on or off. Covers open and close.

A room alone means everything in it; add type `light` for just its lights. Lights stay lights: the `home` id, anything from `home/home_lights` or `home/room_lights`, type `light`, and a name like "the lights" never switch other kinds of device.

### `set_brightness(selector, percent)`

Set light brightness as a percentage. 0 turns them off.

### `set_color_temperature(selector, kelvin)`

Set white colour temperature in Kelvin on matching lights, for example 2700 warm or 6500 cool.

### `set_color(selector, color)`

Set matching colour lights to a named (CSS) colour, such as red, blue or orange.

### `set_volume(selector, percent)`

Set volume as a percentage on matching speakers and TVs.

### `set_muted(selector, muted)`

Mute or unmute matching speakers and TVs.

### `media_control(selector, command)`

Play, pause, stop or skip on matching speakers and TVs. `command` is one of `play`, `pause`, `play_pause`, `stop`, `next`, `previous`.

### `set_thermostat(selector, temperature_c?, temperature_f?, mode?)`

Set the target temperature and/or mode of matching thermostats. `mode` is one of `off`, `heat`, `cool`, `heat_cool`, `auto`, `dry`, `fan_only`.

### `lock(selector)`

Lock matching smart locks.

### `unlock(selector, code?)`

Unlock matching smart locks, only when the user explicitly asks to. Asks for confirmation.

### `run_automation(instanceId? | name?)`

Run an existing scene, script or automation by name or id. This never creates, changes or deletes one.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `home/room_lights,light`: name, on, brightness
- `home/home_lights`: name, on, brightness
- `home/device`: name, room, type, online, on, brightness, color_temperature, speed, position, volume, muted, media_title, locked, thermostat_mode, setpoint, ambient_temperature
- `home/automation`: name, type, manually_runnable, enabled, last_run
- `home/sensor`: name, room, value, kind. Every `sensor` and `binary_sensor`: numbers with their unit, binary sensors as a boolean and their state in words (`Open`/`Closed`, `Detected`/`Clear`…), timestamps, and anything else as text. `kind` is the device class, such as `door` or `temperature`.
