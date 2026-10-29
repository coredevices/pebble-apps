# Google Home

*Uses the Google Home app's private API, reverse engineered; not the Google Home APIs for developers.*

Reads and controls existing Google Home devices and household automations. It cannot add or delete homes, devices, or automations.

Sign in with Google in plugin settings and choose a home. Build: see the [repository README](../README.md#building).

## Functions

### `turn_on(name?, room?, type?)`

Turn on matching on/off devices. Requires at least one selector: name, room, or type.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix such as light, outlet, or switch.

### `turn_off(name?, room?, type?)`

Turn off matching on/off devices. Requires at least one selector: name, room, or type.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix such as light, outlet, or switch.

### `set_brightness(name?, room?, type?, brightness_pct)`

Set brightness from 0 to 100 percent on every matching dimmable device.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally light.
- `brightness_pct` (integer)

### `set_color_temperature(name?, room?, type?, kelvin)`

Set white color temperature in Kelvin on every matching color-temperature light.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally light.
- `kelvin` (integer): Color temperature, for example 2700 warm or 6500 cool.

### `set_volume(name?, room?, type?, volume_pct)`

Set volume from 0 to 100 percent on every matching speaker.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `volume_pct` (integer)

### `set_muted(name?, room?, type?, muted)`

Mute or unmute every matching speaker.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing device kind is tolerated when it fits the action.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `muted` (boolean)

### `lock(name?, room?, type?)`

Lock matching smart locks. Requires at least one selector; locking does not use the saved PIN.

- `name` (string, optional): Lock name, exact preferred; otherwise case-insensitive substring. A trailing lock kind is tolerated.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally lock.

### `unlock(name?, room?, type?, pin?)`

PIN-gated unlock for matching smart locks after an explicit user request. Uses an explicit PIN or the PIN saved in plugin settings.

- `name` (string, optional): Lock name, exact preferred; otherwise case-insensitive substring. A trailing lock kind is tolerated.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally lock.
- `pin` (string, optional): lock PIN; settings can save it instead.

### `set_thermostat(name?, room?, type?, temperature_c?, temperature_f?, mode?)`

Set target temperature and/or mode on every matching thermostat. Supply Celsius or Fahrenheit and/or a mode.

- `name` (string, optional): Thermostat name, exact preferred; otherwise case-insensitive substring. A trailing thermostat kind is tolerated.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally thermostat.
- `temperature_c` (number, optional): Target setpoint in Celsius.
- `temperature_f` (number, optional): Target setpoint in Fahrenheit.
- `mode` (string, optional) One of `heat`, `cool`, `eco`, `off`.

### `media_control(name?, room?, type?, command)`

Play, pause, or stop media on every matching speaker or player.

- `name` (string, optional): Device name, exact preferred; otherwise case-insensitive substring. A trailing speaker, player, TV, or display kind is tolerated.
- `room` (string, optional): Exact room name, case-insensitive.
- `type` (string, optional): Device type suffix, normally speaker.
- `command` (string) One of `play`, `pause`, `stop`.

### `run_automation(name)`

Run an existing manually-runnable Google Home household automation by name. This never creates or deletes an automation.

- `name` (string): Automation name, exact preferred; otherwise case-insensitive substring.

## Data sources

Read by Index and agents; `instanceId` values in the functions above come from these.

- `home/home`: name, id
- `home/device`: name, room, type, capabilities, online, on, brightness, color_temperature, volume, muted, locked, thermostat_mode, setpoint, ambient_temperature
- `home/automation`: name, manually_runnable, starters, actions
