# Google Home

*Uses the Google Home app's private API, reverse engineered; not the Google Home APIs for developers.*

Reads and controls existing Google Home devices and household automations. It cannot add or delete homes, devices, or automations.

Sign in with Google in plugin settings and choose a home. Build: see the [repository README](../README.md#building).

## Watchapp

The same pbw is a watchapp for emery, flint and gabbro. It lists every device: **Favorites** first, then
one section per room, each row with an icon, name and state (on/off and brightness, lock state,
thermostat temperature and mode, Offline).

- **SELECT** opens a device: Power, Brightness, Warmth, Volume, Target temperature and Mode, Lock, and
  Favorite, as its capabilities allow. Level rows open a full-screen dial: UP/DOWN change it, and it's sent
  700 ms after the last press, or on SELECT/BACK.
- **Long SELECT** on a row switches it on or off (or locks it) without opening it.
- On a locked lock, pressing SELECT twice within 3 s on the Locked row unlocks it with the PIN saved on
  the settings page.
- On emery and gabbro, touch works too: drag to scroll, tap a row to select it and tap again to open it,
  swipe right to go back. On a level dial, drag up or down to change it and tap to send it.

The phone side (`pbw/src/pkjs/index.js`) reads this plugin's own `home/device` source and calls its
actions with the device's `id`, so one row controls exactly one device. Favorites can be set on the watch
or in the plugin's settings page; the plugin publishes them as the `favorite` property.
Temperatures follow the phone's unit setting (`preferences/units`). Changes show on the watch at once
and are put back if Google refuses them. In the SDK emulator, whose phone can't sign in to Google, the
app shows sample devices.

## Functions

### `turn_on(name?, room?, type?)`

Turn on matching on/off devices. Requires at least one selector: id, name, room, or type.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix such as light, outlet, or switch.

### `turn_off(name?, room?, type?)`

Turn off matching on/off devices. Requires at least one selector: id, name, room, or type.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix such as light, outlet, or switch.

### `set_brightness(name?, room?, type?, brightness_pct)`

Set brightness from 0 to 100 percent on every matching dimmable device.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally light.
- `brightness_pct` (integer)

### `set_color_temperature(name?, room?, type?, kelvin)`

Set white color temperature in Kelvin on every matching color-temperature light.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally light.
- `kelvin` (integer): Color temperature, for example 2700 warm or 6500 cool.

### `set_volume(name?, room?, type?, volume_pct)`

Set volume from 0 to 100 percent on every matching speaker.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `volume_pct` (integer)

### `set_muted(name?, room?, type?, muted)`

Mute or unmute every matching speaker.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `muted` (boolean)

### `lock(name?, room?, type?)`

Lock matching smart locks. Requires at least one selector; locking does not use the saved PIN.

- `name` (string, optional): Lock name, exact preferred; otherwise case-insensitive substring. A trailing lock kind is tolerated.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally lock.

### `unlock(name?, room?, type?, pin?)`

PIN-gated unlock for matching smart locks after an explicit user request. Uses an explicit PIN or the PIN saved in plugin settings.

- `name` (string, optional): Lock name, exact preferred; otherwise case-insensitive substring. A trailing lock kind is tolerated.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally lock.
- `pin` (string, optional): lock PIN; settings can save it instead.

### `set_thermostat(name?, room?, type?, temperature_c?, temperature_f?, mode?)`

Set target temperature and/or mode on every matching thermostat. Supply Celsius or Fahrenheit and/or a mode.

- `name` (string, optional): Thermostat name, exact preferred; otherwise case-insensitive substring. A trailing thermostat kind is tolerated.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally thermostat.
- `temperature_c` (number, optional): Target setpoint in Celsius.
- `temperature_f` (number, optional): Target setpoint in Fahrenheit.
- `mode` (string, optional) One of `heat`, `cool`, `eco`, `off`.

### `media_control(name?, room?, type?, command)`

Play, pause, or stop media on every matching speaker or player.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing speaker, player, TV, or display kind is tolerated.
- `id` (string, optional): Exact device id (a `home/device` instanceId); targets only that device.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `command` (string) One of `play`, `pause`, `stop`.

### `run_automation(name)`

Run an existing manually-runnable Google Home household automation by name. This never creates or deletes an automation.

- `name` (string): Automation name, exact preferred; otherwise case-insensitive substring.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `home/home`: name, id
- `home/device`: name, room, type, capabilities, favorite (shown first on the watch), online, on, brightness, color_temperature, volume, muted, locked, thermostat_mode, setpoint, ambient_temperature
- `home/automation`: name, manually_runnable, starters, actions
