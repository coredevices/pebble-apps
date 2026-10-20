# Apple Home Control

An iOS-only PBW plugin for Index and Pebble, backed by the public HomeKit framework.
It uses the homes, rooms, accessories, and scenes already in Apple Home. There is
no external MCP server, account login, pairing flow, or additional dependency.

Built on `codex/index-plugin-mcp`; this branch requires that shared plugin runtime.
See [RESEARCH.md](RESEARCH.md) for the branch comparison and Apple/open-source
references that informed the implementation.

## Setup

1. Use an iPhone build with the HomeKit entitlement and a provisioning profile
   that includes the HomeKit capability for the Pebble App ID.
2. In Pebble's **Settings → Phone → Debug**, enable **Show debug options** and
   **Use experimental plugins**. The plugin catalogue is hidden until enabled.
3. Open Apple Home Control's gear page in Index actions.
4. Tap **Allow Apple Home access** and accept the iOS permission prompt.
5. Select a home and tap **Use this home**.
6. Enable Apple Home Control in Index actions.

Access starts only after explicit setup. Native setup methods require a foreground
configuration session; source/action requests cannot authorize or switch homes.
Disconnecting clears the selected home and stops the plugin's access. iOS still
owns the system permission. Revoke it in iOS Settings if desired.

Only one home is exposed at a time. If that home disappears, the plugin requires a
new selection. It never silently switches to the first or primary home. Android
and JVM do not register this bundle because they have no Apple Home bridge.

## Sources and actions

| Source | Contents |
| --- | --- |
| `home/home` | The selected home and its stable ID |
| `home/room` | Rooms and their stable IDs |
| `home/device` | Accessory services, room, type, reachability, advertised capabilities, explicitly cached state |
| `home/scene` | Existing scenes, their actions, whether they can run, and reasons for blocked scenes |
| `home/automation` | Scenes and scheduled/event automations, starters, actions, enabled state, and manual run eligibility |

| Action | Behavior |
| --- | --- |
| `get_state` | Fresh per-characteristic reads for one service; failures have no stale fallback value |
| `turn_on`, `turn_off` | Power for lights, switches, outlets, fans, and supported televisions |
| `set_brightness` | Light brightness, 0–100% |
| `set_color` | Hue in degrees and saturation in percent |
| `set_color_temperature` | Light temperature in mireds or Kelvin, within the device's advertised range |
| `set_fan_speed` | Fan rotation speed, 0–100% |
| `set_thermostat` | Target temperature with an explicit Celsius/Fahrenheit unit, and/or off/heat/cool/auto mode |
| `set_volume`, `set_muted` | Volume percentage and mute on supported HomeKit speakers |
| `media_control` | Play, pause, or stop when advertised as a writable HomeKit characteristic |
| `lock`, `unlock` | One explicitly selected lock; unlocking requires foreground device authentication |
| `run_scene`, `run_automation` | Execute an existing scene after checking every action |

Target a service with `instanceId`, or an exact `device` name and optional `room`.
Google Home argument aliases `name`, `type`, `brightness_pct`, `volume_pct`,
`temperature_c`, and `temperature_f` are also accepted; conflicting aliases fail.
Names are case-insensitive; ambiguous names require a room or service ID. A single
physical accessory may expose multiple services, each with its own ID.

For room-wide control, explicitly pass `all: true`, `room`, and `device_type` and
omit a device selector. Up to ten matching services can be controlled. Every
target is validated before the first write. Writes are sequential; stop at the
first failure and report earlier confirmations. There is no transaction or
rollback across physical devices.

Native code validates service type, writability, scalar format, range, supported
values, and value step. Brightness/color/speed changes do not implicitly change
power. Thermostat values are converted to Celsius; values that do not match a
device's advertised step are rejected, rather than silently rounded. Auto-mode
heating/cooling thresholds are not exposed.

Garages, security systems, and window coverings can provide mapped readings but
cannot be controlled. Lock/unlock commands target one lock; unlocking requires
Face ID, Touch ID, or device passcode in the foreground. No plugin PIN is stored. Scenes containing excluded controls, unknown
actions/values, or no inspectable actions are blocked. Scene contents are checked
again immediately before execution. No pairing, deletion, camera access, raw
characteristic writes, or automation editing is exposed.

HomeKit scenes supply the manually runnable automations. Scheduled/event triggers
are discoverable with their associated scenes and read-only starter/action details,
but HomeKit has no public API for starting a trigger manually. Timer and calendar
starters expose date details; characteristic starters expose their device and value.
Other event kinds are labelled `other_homekit_event`; predicate presence and end-event
counts are reported without claiming to describe those conditions completely.
Media controls require writable
HomeKit characteristics; this does not imply support for HomePod or arbitrary
AirPlay playback.

A cached HomeKit value is never proof of current state. `get_state` labels each
reading `fresh` or `unavailable`. Failed or timed-out controls may already have
changed a device; the plugin reports an unconfirmed/partial outcome and does not
retry. Check state before deciding whether to repeat a command.

## Build and checks

From the internal repository root:

```sh
node --test apple-home/plugin.test.cjs
(cd apple-home && pebble build)
./gradlew :libpebble3:jvmTest \
  --tests 'io.rebble.libpebblecommon.plugin.AppleHomeControlTest' \
  --tests 'io.rebble.libpebblecommon.plugin.AppleHomeNativeBridgeTest'
./gradlew :libpebble3:compileKotlinIosArm64
```

The public repository uses the same commands without the `public/` prefix.
`pebble build` writes `apple-home/build/apple-home.pbw`.
JavaScript source and tests stay next to this README for review and maintenance.

## Testing

The `simulator/` directory contains a local HAP bridge and an isolated HomeKit
provisioning app. The installed CoreApp plugin passed the 56-step smoke suite on
iOS 18.5 with virtual accessories; `VALIDATION.md` lists exactly what was exercised.
Physical accessories and the following signed-iPhone scenarios remain unverified:

- First-use permission, refusal, Settings revocation/regrant, disconnect/reconnect,
  and cold launch without constructing a HomeKit manager for an unconfigured user.
- Empty/loading homes, multiple homes, deleted selected homes, renamed rooms,
  duplicate accessory names, and accessories with multiple services.
- Real light/fan/thermostat capabilities, Celsius/Fahrenheit conversion, metadata
  limits, missing values, offline accessories, and partial room-control failures.
- Scenes with ordinary controls, locks/security controls, unknown actions, mixed
  devices, edits after discovery, and partial execution errors.
- Index source answers and action results in foreground/background, locked-phone
  behavior, local connectivity, and remote connectivity through an Apple home hub.

HomeKit background/remote behavior depends on iOS, home-hub availability, and the
accessory. This implementation makes no claim of verified always-on control.
