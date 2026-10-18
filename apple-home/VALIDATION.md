# Apple Home Control validation

2026-09-17, on the implementation branch based on `codex/index-plugin-mcp`.

| Check | Result |
| --- | --- |
| JavaScript plugin tests | 27 passed with `node --test apple-home/plugin.test.cjs`, including automation metadata, blocked trigger execution, and action-specific success messages |
| Shared control policy tests | 11 passed on the JVM: authorization-independent value planning, service allowlist, ranges/steps/enums, temperature conversion, and scene validation |
| Native bridge boundary tests | 2 passed on the JVM: setup restricted to configuration sessions and rejection when no native capability is injected |
| iPhoneOS compilation | Passed: production `AppleHomeControl`, `IosPluginAppleHomeApi`, `PluginNativeServices`, `PluginManifest`, and `PluginPermissions`, compiled with Kotlin/Native 2.4.10 for `ios_arm64` against the installed Apple SDK and the repository's coroutines/serialization 1.11.0 libraries |
| Info.plist and entitlements | `plutil -lint` passed |
| Packaged PBW | All three entries match source; two builds produce identical bytes |
| Whitespace/diff checks | `git diff --check` passed |
| Repository plugin JVM suite | 148 passed with `:libpebble3:jvmTest --tests 'io.rebble.libpebblecommon.plugin.*'` after merging plugin runtime commit `6c099f1f8`; zero failures or skipped tests |
| Full CoreApp simulator build | Passed: Kotlin framework link and Xcode Debug app build for arm64 iOS Simulator, bundle `coredevices.coreapp.home-test` |
| Full plugin runtime on iOS 18.5 | Passed twice: 56 recorded steps per run, comprising six configuration calls, five sources, and 45 action calls covering all 15 action types |
| Unlock authentication | Passed: explicit nonmatching-face cancellation left the lock secured; subsequent matching-face authentication unlocked it, then the suite relocked it. A separate successful run covered the 60-second authentication timeout |
| Accessory-side evidence | Each successful run produced 21 matching HAP writes, including light/color/temperature, fan, thermostat, scene, lock, and media controls |

The focused JVM harness compiled the actual production policy and bridge files and
ran the checked-in `AppleHomeControlTest` and `AppleHomeNativeBridgeTest` classes
with Kotlin 2.4.10/JUnit 4.13.2. It used the real `JsEngineInterface` declaration
and an unused Chat API test double to isolate unrelated Chat dependencies. This
verifies the bridge dispatch boundary; it does not verify a live JavaScriptCore
session or the full app's dependency-injection graph.

The native check produced a Kotlin library for **iPhoneOS**, without installing,
launching, or executing it. It validates HomeKit bindings and production source
compilation; it does not establish signing, final application linkage, permission
prompt behavior, HomeKit availability, or physical accessory behavior.

## Full CoreApp integration results

The installed app used the newly linked framework (UUID
`8C038B64-C184-31DB-8D3E-7BD288E830D4`) and the source-matching version 0.3.0 PBW.
Its embedded simulator entitlements include public HomeKit access and no private
HomeKit entitlement. Tests exercised the real plugin registry, JavaScriptCore
sessions, configuration bridge, production Kotlin HomeKit implementation, and
the simulator's paired HomeKit database.

The suite discovered one home, two rooms (including the entire-home room), nine
supported device services, six scenes, and seven scene/automation entries. It
verified brightness 58, hue 210/saturation 65, both mired and Kelvin light
temperature inputs, fan speed 60, Fahrenheit 71.6 converted to Celsius 22, room
light control, scene execution, fresh sensor reads, speaker volume 61 and mute,
play/pause/stop with current-state readbacks, and television power. Invalid
brightness, lock-as-power control, a lock-containing scene, manual execution of
a scheduled automation, and controls after disconnect were rejected.

Successful full-suite runs completed at approximately `07:22:22Z` and `07:27:10Z`
on 2026-09-17. In the explicit-cancellation run, the lock read secured at
`07:26:26.489Z` and remained secured after cancellation at `07:26:49.562Z`.
The first unlock write arrived only after the next authentication succeeded,
at `07:27:08.420Z`, followed by relocking at `07:27:08.592Z`.
Raw JSON reports and matching accessory audit excerpts are saved locally under
the ignored `simulator/.state/` directory.

Initial attempts hit first-launch calendar/notification prompts while the app
was inactive, then a delayed HomeKit consent prompt. Those attempts failed setup
as expected; they are not counted as passing runs. One later attempt cancelled
the second authentication after the first had timed out, and correctly failed
the expected-success assertion. The final explicit-cancellation run completed
both interactions within their deadlines.

The full build also exposed a pre-existing aggregate-branch Reminders reference
to nonexistent `PluginErrors.NOT_FOUND`; it now uses `INVALID_ARGS`. The local
build reused a simulator iMessage static archive whose source and Cargo.lock
matched this checkout, skipping that unchanged Rust task. All Apple Home code
and the test harness were freshly compiled.

## Google Home feature comparison

All 11 Google Home action names have Apple Home implementations: power on/off,
brightness, color temperature, volume, mute, lock/unlock, thermostat, media
control, and automation execution. Apple Home additionally exposes fresh state,
hue/saturation, fan speed, rooms, and a scene action. The shared action names and
Google argument aliases are covered by JavaScript tests; their native control
paths were exercised by the full app suite above.

Platform differences remain explicit: unlock uses foreground iPhone
authentication instead of a stored Google Home PIN; groups require explicit
room/type/all selectors; scheduled/event triggers are discoverable but cannot
be manually started through public HomeKit APIs. Media control requires exposed
HomeKit characteristics and does not imply arbitrary HomePod/AirPlay support.

## Fixture provisioning and remaining device checks

Simulator provisioning and public HomeKit control were verified on iOS 18.5 using
[the isolated fixture tooling](simulator/README.md). The bridge and separate
television paired, with nine accessory records, a room, and two custom scenes.
After removing the internal provisioning entitlement, public HomeKit calls wrote
and read lamp brightness, media playback, volume, and mute; the HAP server recorded
the matching requests. The optional internal entitlement is confined to the
simulator provisioning helper and is not used by CoreApp.

The public accessory setup UI fails on the tested 18.5 and 26.0.1 simulators; see
the fixture README for the diagnosed HomeUIService failure and tested workaround.
Physical HomeKit pairing and a plugin lock command are verified below. The remaining
device matrix is in [README.md](README.md#testing).

## Physical iPhone installation

The signed IPA from commit `85334be9c` was installed over USB on an iPhone XS
running iOS 18.7.10, preserving the existing app data. Its embedded development
profile includes the phone and the public HomeKit entitlement. Version 1.13.0,
build 2 launched successfully and remained running during USB log inspection.
The source build passed [iOS CI](https://github.com/coredevices/CoreApp/actions/runs/35235692362)
and [Android CI](https://github.com/coredevices/CoreApp/actions/runs/35235692512).

The separate `--device` fixture instance advertised its bridge and television on
the Mac's LAN interface. Both were discovered through mDNS, and unauthenticated
accessory reads were rejected as expected. The iPhone paired the bridge through
Apple Home at `18:00:54.871Z` on 2026-09-17. The accessory audit then recorded
reads from all seven bridged devices. These initial reads came from Apple Home;
the television's separate pairing remains unverified.

The installed app's Apple Home PBW matches the branch byte for byte. The first
visit to Index actions showed no plugins because **Use experimental plugins**
was disabled in the phone's saved settings. The setup instructions now include
that prerequisite. Different Apple Accounts prevent iPhone Mirroring in this
setup, so phone interactions are being performed manually.

After enabling plugins, the configuration page displayed HomeKit scenes and the
phone persisted the selected home and enabled Apple Home action. The user sent
“lock the door” through Index. The iPhone displayed “Updated QA Lock” and “Done”;
the fixture recorded `Lock Target State = 1` at `18:06:07.040Z`. This verifies
the physical iPhone's Index → plugin → native HomeKit → virtual accessory path.
The generic result text prompted the 0.3.1 update: confirmed controls now name
their action and values, including “Locked QA Lock.” The JavaScript suite covers
all control summaries and verifies rejected unlocks cannot produce a success title.

The signed 0.3.1 plugin update was subsequently installed over USB, preserving the
selected home and enabled action. The physical test session preceded the merge
of the runtime branch's OAuth and network-permission updates; the merged bridge
was validated by the 148-test JVM suite above.
