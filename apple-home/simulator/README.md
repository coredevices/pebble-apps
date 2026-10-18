# Isolated HomeKit simulator fixtures

This tooling creates a real HomeKit home in a dedicated iOS Simulator, paired to
an in-process HAP bridge. The devices are virtual; discovery, pairing, HomeKit
reads/writes, rooms, and scenes use the simulator's actual HomeKit service.
There is no fake HomeKit backend in CoreApp.

Use a dedicated simulator signed out of iCloud. The fixture refuses to modify a
home unless every home is named `CoreApp Simulator Home`; room/scene setup also
requires every accessory name to start with `QA `. Do not use a simulator holding
personal Home data.

## Start the mock accessories

Use Node 22 or 24 (the supported HAP-NodeJS versions):

```sh
cd apple-home/simulator
npm ci
npm start
```

The bridge binds to loopback (`lo0`) by default, uses TCP port 51827, and advertises
`QA CoreApp Bridge`. The fixed development code is **482-61-937**, and the setup
URI is `X-HM://00249NZ8XHD7B`. It contains two lights, an outlet, a fan, a thermostat,
a temperature sensor, and a lock. A separate `QA Television` accessory on port
51828 exposes playback and speaker services and must be paired separately with
the same development code. Its setup URI is `X-HM://00UQ7SRW1TV01`. The ignored `.state/` directory contains
pairing credentials, the current device state, and the JSONL read/write audit.
Keep it to preserve pairing across bridge restarts. These are test credentials.

## Test an iPhone over USB

Install a device build containing the Apple Home plugin and a HomeKit provisioning
profile that includes the iPhone. The signed `CoreApp` artifact from the iOS CI
workflow contains `CoreApp.ipa`; unzip it and install `Payload/Pebble.app` with
`xcrun devicectl device install app --device <device-id> <path-to-Pebble.app>`.
Developer Mode must be enabled on the phone.

Start a separate accessory instance on the Mac's local network interface:

```sh
HAP_BIND=en0 npm start -- --device
```

Use the interface connected to the phone's network (`en0` is usually Wi-Fi;
Ethernet adapters may use another interface). USB installs the app; HomeKit discovery
and accessory control use the local network. The phone and Mac can use different
Apple Accounts.

In the iPhone Home app, add a test home, then choose **Add Accessory → More Options**
and select **QA CoreApp Bridge**. Pair using **482-61-937**, approving the uncertified
test accessory when prompted. Pair **QA Television** separately using the same code.
The setup URIs are `X-HM://00249NZ8XHD7D` and `X-HM://00UQ7SRW1TV02`.

Device mode uses separate accessory identities, TCP ports 51837/51838, and
`.state/device/` for pairing credentials and read/write logs. It requires an
explicit `HAP_BIND`. Existing simulator pairings are preserved.

In Pebble's **Settings → Phone → Debug**, enable **Show debug options** and
**Use experimental plugins**. Then open **Index actions → Apple Home Control → gear**, allow HomeKit
access, select the test home, and enable the plugin. Compare controls and fresh
state reads with `.state/device/audit.jsonl` and `.state/device/state.json`.
The provisioning helper and automated smoke runner below remain simulator-only.

## Provision the simulator

Build from this directory with `python3 build-fixture.py`, then install and launch
`build/HomeFixture.app` using `xcrun simctl install <QA-UDID> ...` and
`xcrun simctl launch <QA-UDID> coredevices.coreapp.home-fixture`.

In the app, load HomeKit, allow access, create the test home, and use **Pair Mock
Bridge**. Approve the local uncertified accessory when prompted. The fixture uses
public HomeKit APIs by default.

### Workaround for the simulator setup UI crash

On the tested iOS 18.5 (22F77) and iOS 26.0.1 (23A8464) runtimes, the public setup
flow failed with `HMErrorDomain Code=23`. Logs showed HomeUIService's remote view
initialization failing; on 18.5 the XPC decoder rejected `_NSXPCDistantObject`.
Both modern and legacy setup APIs failed, including a standard Xcode-built app.
Native HomeKit discovery still found the bridge.

For this simulator bug, rebuild with:

```sh
python3 build-fixture.py --direct-pairing
```

Install it in the same QA simulator, load HomeKit, use **Discover QA Accessories**, then
**Pair QA Accessory with Fixture Code** and approve **Add Anyway**. This optional build
uses the internal `addAccessory:password:completionHandler:` method and the
`com.apple.private.homekit` simulator entitlement. It still authenticates with the
known fixture PIN and performs real HAP pairing. Repeat discovery/pairing for
the television after the bridge is paired. The code is compiled only with
`QA_PRIVATE_PAIRING`, and the entire fixture refuses to compile for physical
devices. **This helper is never linked into CoreApp or shipped in the plugin.**
It is an unsupported simulator provisioning workaround, not a production API.

After pairing, create rooms/scenes, rebuild **without** `--direct-pairing`, and
reinstall. The normal build must still see the paired accessories. Use **Verify
Public HomeKit Control** to write brightness 37 and read it back on `QA Color Lamp`, pause television playback, and set/read speaker
volume 35 and mute on.
The bridge's audit must contain the corresponding write and read. The internal
entitlement is required only for the provisioning workaround, not control.

The fixture creates `QA Living Room`, the runnable `QA Evening` scene, and
`QA Unsafe Lock` for testing rejection of scenes containing lock actions.
Use **Create Disabled QA Automation** after those scenes exist. It creates
`QA Scheduled Lights`, a disabled timer linked to `QA Evening`, for discovery
and rejected manual-execution tests. It does not enable scheduled controls.

## Device authentication

Use **Verify Device Authentication** to check the same public LocalAuthentication
policy used by unlock. In Simulator, enable **Features → Face ID → Enrolled**.
The fixture must report `Biometrics available=true`; error -7 means enrollment is
still off. Allow the fixture's Face ID prompt, then use **Matching Face** to succeed.
For cancellation, use **Non-matching Face**, then **Cancel** in the iOS prompt.
The fixture log records success or the cancellation error. Without enrollment,
device-owner authentication can fall back to the simulator passcode screen.

This check does not change a lock. The full CoreApp smoke runner separately checks
that a cancelled unlock leaves the lock secured and successful authentication
permits the unlock, then relocks it.

## Run the full CoreApp plugin suite

Build the current Debug CoreApp for arm64 iOS Simulator with the Xcode settings
`BUNDLE_ID=coredevices.coreapp.home-test TEAM_ID= CODE_SIGN_IDENTITY=-`.
Use the repository's normal Kotlin/CocoaPods build flow and ensure the app
contains the newly linked `ComposeApp.framework` and current Apple Home PBW.
The test harness is gated to this exact bundle ID, a debug binary, a simulator,
and an explicit launch environment variable; it cannot run in the shipping app.

After pairing both accessories and creating the room, scenes, and disabled timer:

```sh
python3 apple-home/simulator/run-smoke.py \
  --device <QA-UDID> \
  --app public/iosApp/build/Build/Products/Debug-iphonesimulator/Pebble.app \
  --unlock
```

The runner installs and launches the app and prints its JSON report path. On a
fresh app, dismiss unrelated calendar/notification prompts, allow HomeKit access,
then rerun once the app is active. A setup rejection during those prompts is the
foreground guard working; do not disable it. Allow Face ID when requested.
For the first unlock, choose **Non-matching Face → Cancel** within 60 seconds.
For the second, choose **Matching Face**. Omitting `--unlock` skips these two
interactive authentication cases. The runner succeeds only when all assertions
pass; inspect `.state/audit.jsonl` for the actual accessory writes and reads.

## Verified on this machine

- iOS 18.5: paired the bridge with the optional helper and created all eight
  accessory records (bridge plus seven devices), the room, and both scenes.
- Reinstalled the public-only build and confirmed the same eight accessories.
- Public HomeKit write/read returned brightness 37; bridge audit recorded the
  matching write at `2026-09-17T05:59:26.944Z` and read at `05:59:27.422Z`.
- Paired the separate television, then verified public playback, volume, and mute
  writes/readbacks at `2026-09-17T06:14:54Z`. The home then had nine accessory records.
- Created the disabled timer through public HomeKit APIs and confirmed
  `enabled=false` and one associated scene. HomeKit requires timer fire dates on
  a minute boundary; the fixture normalizes the timestamp accordingly.
- Public device-owner authentication succeeded with **Matching Face**. A separate
  **Non-matching Face → Cancel** attempt returned `LAError` -2, and backgrounding
  during authentication returned -4.
- Full CoreApp plugin suite passed twice with 56 recorded steps per run, including
  all 15 action types and five discovery sources. See `../VALIDATION.md` for
  authentication timing, accessory-side evidence, and the verification boundary.

## References

- [Apple's HomeKit simulator testing guide](https://developer.apple.com/documentation/homekit/testing-your-app-with-the-homekit-accessory-simulator)
- [Homebridge HAP-NodeJS](https://github.com/homebridge/HAP-NodeJS)
- [Apple device-owner authentication policy](https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication)
- [RuntimeBrowser's HMHome declarations](https://github.com/nst/iOS-Runtime-Headers/blob/master/Frameworks/HomeKit.framework/HMHome.h) (diagnostic reference for the optional internal method)
