# Apple Home Control research

Research date: 2026-09-16. Implementation branch: `codex/index-apple-home-plugin`,
based on the shared plugin runtime at `47bc8f1f9` (`codex/index-plugin-mcp`).

## Existing CoreApp plugins

Reviewed the aggregate runtime and the Google Home, Apple Reminders, iOS Shortcuts,
Spotify, Find My/Location Sharing, Roam, Notion, Obsidian, TickTick, and Todoist
branches. Their PBWs contain `appinfo.json`, `plugin.js`, and a configuration page.
Google Home exposes `home/home`, `home/device`, `home/automation` sources and
capability-specific actions. Apple Reminders and Shortcuts use a permission-gated
native bridge. The Index adapter already supplies opt-in settings and MCP tools.

Apple Home follows that arrangement, with checked-in source and a reproducible
PBW. It requires a native bridge; there is no account token or external server.
The Android/JVM loaders skip the bundle when that bridge is unavailable.

The [proposal](https://github.com/coredevices/mobileapp/issues/334) and
[linked comment](https://github.com/coredevices/mobileapp/issues/334#issuecomment-5355076622)
describe using the existing Apple Home database through the native iOS framework.

## Apple references and implementation consequences

- [Enabling HomeKit](https://developer.apple.com/documentation/homekit/enabling-homekit-in-your-app):
  requires the HomeKit entitlement, framework, and `NSHomeKitUsageDescription`.
  Constructing the first manager can show the system permission prompt. Defer
  that to explicit foreground plugin setup; do not construct it during DI/startup.
- [HMHomeManager](https://developer.apple.com/documentation/homekit/hmhomemanager):
  retain one manager and its weak delegate. Wait for `homeManagerDidUpdateHomes`
  before treating its initially empty homes array as loaded. Authorization is a
  bitmask, and permission may be revoked after setup. Use UUIDs, not primary-home
  ordering (the primary-home API is deprecated).
- [Characteristic values](https://developer.apple.com/documentation/homekit/hmcharacteristic/value):
  `value` is cached. Discovery must label it as cached; state queries must await
  `readValue` and report failures without presenting stale values as fresh.
- [Characteristic metadata](https://developer.apple.com/documentation/homekit/hmcharacteristicmetadata):
  validate writability, format, min/max, step, and valid values before writing.
  [Target temperature](https://developer.apple.com/documentation/homekit/hmcharacteristictypetargettemperature)
  is Celsius; an explicit Fahrenheit input needs conversion.
- [Scenes](https://developer.apple.com/documentation/homekit/hmactionset): action
  sets execute in unspecified order. Inspect every characteristic-write action
  before allowing execution. Unknown actions and excluded device types block the
  entire scene. A scene can change after discovery; check again at invocation.
- [HomeKit errors](https://developer.apple.com/documentation/homekit/hmerror/code):
  distinguish denied access, unreachable devices, timeout, and partial scene
  execution. A failed or timed-out write is not proof that no physical action
  happened. Never retry writes automatically.
- [Triggers](https://developer.apple.com/documentation/homekit/hmtrigger) expose
  enabled state and associated action sets. [Timer triggers](https://developer.apple.com/documentation/homekit/hmtimertrigger)
  and [event triggers](https://developer.apple.com/documentation/homekit/hmeventtrigger)
  expose starter metadata but have no public manual-execution method. Discover
  them read-only and use inspected scenes for manual `run_automation` requests.

Also inspected the installed iPhoneOS SDK headers for HomeKit signatures,
authorization flags, service types, metadata, characteristic types, and errors.

## Open-source projects examined

- [Itsyhome](https://github.com/nickustinov/itsyhome-macos): read
  `Itsyhome/iOS/HomeKitManager.swift`, `HomeKitManager+Commands.swift`, and
  `HomeKitManager+DataFetching.swift`. Useful examples of service UUID targeting,
  multi-service accessories, characteristic formats, reachability, and scene
  execution. Its UI suppresses some partial-scene errors; this plugin must report
  those to the agent.
- [HomeClaw](https://github.com/omarshahine/HomeClaw): read
  `Sources/homeclaw/HomeKit/HomeKitManager.swift` and `CharacteristicMapper.swift`.
  Useful main-thread confinement, bounded read callbacks, freshness distinctions,
  and service/characteristic mappings. Its generic write/automation surface is
  broader than this plugin needs.
- [TimCinel/homekit-mcp](https://github.com/TimCinel/homekit-mcp): read
  `HomeKitSync/HomeKitManager.swift`; a small native HomeKit/MCP example showing
  manager delegation and UUID-based discovery.
- [HomeMCPBridge](https://github.com/coalsi/HomeMCPBridge): reviewed the native
  HomeKit/MCP architecture and feature surface. Its separate HTTP server and
  macOS process arrangement are unnecessary inside CoreApp.
- [Homebridge](https://github.com/homebridge/homebridge): accessory-side bridge,
  rather than a client of the user's existing HomeKit database; not a dependency.

These are research references, not vendored code or runtime dependencies.

## Scope and verification boundary

Discover homes, rooms, accessory services, capabilities, scenes, and automations.
Read fresh state for a precisely selected service. Control lights, switches,
outlets, fans, thermostats, supported media services, and individual locks.
Unlocking requires foreground device-owner authentication. Support exact IDs or unambiguous names qualified
by home/room; never pick an arbitrary device when a name is ambiguous. Exclude
garages, security systems, door/window controls, cameras, pairing, and automation
editing from writes. Scenes obey the control allowlist and additionally exclude locks.

Plugin setup is explicit and foreground-only; sources/actions cannot request
authorization or change the selected home. No arbitrary characteristic-write API
is exposed. Native code independently checks values and capabilities.

Use JavaScript and JVM unit tests plus an iPhoneOS compile check where local
dependencies permit. The user subsequently authorized simulator installation and
testing; the isolated fixture is documented below. Physical-device testing must cover permission grant/revoke,
multi-home and duplicate-name cases, real accessories, offline/remote access,
scene partial execution, and Index invocation while the app is backgrounded.


## Simulator provisioning follow-up

Apple's [testing guide](https://developer.apple.com/documentation/homekit/testing-your-app-with-the-homekit-accessory-simulator)
describes isolated HomeKit data in simulators without an iCloud account. A local
[HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS) fixture successfully paired
with iOS 18.5; see `simulator/README.md` for the HomeUIService failure, optional
simulator-only provisioning workaround, and verified public-API control.
Televisions are published separately, following the external-accessory pattern
used by [homebridge-sony-audio](https://github.com/kovalev-sergey/homebridge-sony-audio).
Apple's installed HomeKit SDK exposes television and current/target media state
constants from iOS 18, and speaker volume/mute from iOS 10. Discovery distinguishes
current playback state from the requested target state.
