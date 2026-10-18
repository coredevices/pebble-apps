#!/usr/bin/env python3
"""Build the simulator-only HomeKit provisioning app without CocoaPods."""
from pathlib import Path
import argparse
import plistlib
import subprocess
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--direct-pairing', action='store_true', help='Enable internal simulator-only provisioning when Apple setup UI fails')
args = parser.parse_args()
root = Path(__file__).resolve().parent
app = root / 'build/HomeFixture.app'
app.mkdir(parents=True, exist_ok=True)
info = {
    'CFBundleIdentifier': 'coredevices.coreapp.home-fixture',
    'CFBundleExecutable': 'HomeFixture', 'CFBundleName': 'Home Fixture',
    'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
    'UIApplicationSceneManifest': {'UIApplicationSupportsMultipleScenes': False, 'UISceneConfigurations': {}},
    'MinimumOSVersion': '18.0', 'UIDeviceFamily': [1, 2], 'UILaunchScreen': {},
    'FixtureSetupURI': 'X-HM://00249NZ8XHD7B',
    'NSHomeKitUsageDescription': 'Create and pair isolated mock accessories for Apple Home plugin simulator testing.',
    'NSFaceIDUsageDescription': 'Test device authentication for Apple Home unlock controls in the simulator.',
    'NSLocalNetworkUsageDescription': 'Discover the local mock HomeKit bridge.',
    'NSBonjourServices': ['_hap._tcp'],
}
(app / 'Info.plist').write_bytes(plistlib.dumps(info))
entitlements = root / 'build/fixture.entitlements'
permissions = {'com.apple.developer.homekit': True, 'com.apple.developer.homekit.allow-setup-payload': True}
if args.direct_pairing:
    permissions['com.apple.private.homekit'] = True
entitlements.write_bytes(plistlib.dumps(permissions))
sdk = subprocess.check_output(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-path'], text=True).strip()
subprocess.run(['xcrun', '--sdk', 'iphonesimulator', 'swiftc', '-swift-version', '5', '-parse-as-library', '-sdk', sdk,
                '-target', 'arm64-apple-ios18.0-simulator', *(['-D', 'QA_PRIVATE_PAIRING'] if args.direct_pairing else []), str(root / 'HomeFixture.swift'),
                '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', str(entitlements),
                '-o', str(app / 'HomeFixture')], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
print(app)
