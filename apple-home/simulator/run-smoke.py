#!/usr/bin/env python3
"""Install a dedicated Debug CoreApp build and run its native Apple Home smoke test."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True, help='UUID of the isolated QA simulator')
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--unlock', action='store_true', help='Interactively cancel the first authentication, then match Face ID for the second')
args = parser.parse_args()
bundle = plistlib.loads((args.app / 'Info.plist').read_bytes())['CFBundleIdentifier']
if bundle != 'coredevices.coreapp.home-test':
    parser.error('Build with BUNDLE_ID=coredevices.coreapp.home-test TEAM_ID=')
simctl = ['xcrun', 'simctl']
subprocess.run([*simctl, 'terminate', args.device, bundle], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run([*simctl, 'install', args.device, str(args.app)], check=True)
container = Path(subprocess.check_output([*simctl, 'get_app_container', args.device, bundle, 'data'], text=True).strip())
report = container / 'Documents/apple-home-smoke.json'
report.unlink(missing_ok=True)
env = os.environ.copy()
env['SIMCTL_CHILD_COREAPP_APPLE_HOME_SMOKE'] = '1'
if args.unlock: env['SIMCTL_CHILD_COREAPP_APPLE_HOME_UNLOCK_SMOKE'] = '1'
subprocess.run([*simctl, 'launch', args.device, bundle], env=env, check=True)
print('Allow HomeKit access in the simulator when prompted.', flush=True)
print('Report:', report, flush=True)
deadline = time.monotonic() + 360
while time.monotonic() < deadline:
    if report.exists():
        try:
            result = json.loads(report.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if result.get('error') != 'Running':
            print(json.dumps(result, indent=2))
            raise SystemExit(0 if result.get('ok') else 1)
    time.sleep(1)
raise SystemExit('No completed smoke report within 360 seconds; inspect the app launch logs.')
