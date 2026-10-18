#!/usr/bin/env python3
"""Run the real plugin integration test with an explicitly scoped test session.

The corresponding Fly worker must be stopped before invoking this script.
The app must be a Debug Simulator build linked with CHAT_TEST_SCOPE=true.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import sqlite3
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--device', required=True)
parser.add_argument('--app', required=True, type=Path)
parser.add_argument('--session-export', required=True, type=Path)
parser.add_argument('--phone', required=True)
parser.add_argument('--read-all-metadata', action='store_true', help='Allow the room directory for all rooms; sends remain locked to the test room')
parser.add_argument('--operation', required=True, help='Stable ID; reuse it when retrying this test')
mode = parser.add_mutually_exclusive_group()
mode.add_argument("--performance", action="store_true", help="Measure two real sends to the already approved scoped room")
mode.add_argument("--lifecycle", action="store_true", help="Measure idle/background/memory cleanup and send once after reopening the scoped session")
args = parser.parse_args()
uuid = '8197c57a-59c8-493e-9db1-eaab2988d010'
snapshot = json.loads(args.session_export.read_text())
room = snapshot['room']
bundle = plistlib.loads((args.app / 'Info.plist').read_bytes())['CFBundleIdentifier']
if bundle != 'coredevices.coreapp.chat-test':
    parser.error('Use the dedicated coredevices.coreapp.chat-test bundle ID to preserve other Simulator app data')
simctl = ['xcrun', 'simctl']
subprocess.run([*simctl, 'terminate', args.device, bundle], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
subprocess.run([*simctl, 'install', args.device, str(args.app)], check=True)
container = Path(subprocess.check_output([*simctl, 'get_app_container', args.device, bundle, 'data'], text=True).strip())
directory = container / 'Library/Application Support/plugins' / uuid
directory.mkdir(parents=True, exist_ok=True, mode=0o700)
restriction = directory / 'test-room'
if restriction.exists() and restriction.read_text().strip() != room:
    parser.error('The installed test session has a different room restriction')
restriction.write_text(room)
if args.read_all_metadata:
    (directory / 'test-directory-read-all').write_text('1')
report_name = 'performance-result.json' if args.performance else 'lifecycle-result.json' if args.lifecycle else 'smoke-result.json'
if args.performance or args.lifecycle:
    if not (directory / 'gomuks.sqlite').exists():
        parser.error('Run the scoped smoke test first to establish the session and approval')
    with sqlite3.connect('file:' + str(directory / 'gomuks.sqlite') + '?mode=ro', uri=True) as database:
        operations = (args.operation + '-cold', args.operation + '-warm') if args.performance else (args.operation, args.operation)
        existing = database.execute('SELECT count(*) FROM pm_send WHERE operation_id IN (?, ?)', operations).fetchone()[0]
        if existing:
            parser.error('Performance operation IDs already exist; cached retries cannot measure a new send')
    for name in ['performance-calls.jsonl', 'performance-network.jsonl']:
        (directory / name).unlink(missing_ok=True)
(directory / report_name).unlink(missing_ok=True)
if not (directory / 'gomuks.sqlite').exists():
    pending = directory / 'test-session.json'
    pending.write_text(json.dumps(snapshot))
    pending.chmod(0o600)
    preferences = container / 'Library/Preferences' / f'PKJS-{uuid}-native.plist'
    preferences.parent.mkdir(parents=True, exist_ok=True)
    preferences.write_bytes(plistlib.dumps({'encryption-key': snapshot['pickle_key']}))
    preferences.chmod(0o600)
subprocess.run([*simctl, 'privacy', args.device, 'grant', 'contacts', bundle], check=True)
environment = os.environ.copy()
environment.update({
    'SIMCTL_CHILD_COREAPP_CHAT_SMOKE': '1',
    'SIMCTL_CHILD_COREAPP_CHAT_PERF': '1' if args.performance else '0',
    'SIMCTL_CHILD_COREAPP_CHAT_LIFECYCLE': '1' if args.lifecycle else '0',
    'SIMCTL_CHILD_COREAPP_CHAT_TEST_ROOM': room,
    'SIMCTL_CHILD_COREAPP_CHAT_TEST_PHONE': args.phone,
    'SIMCTL_CHILD_COREAPP_CHAT_TEST_OPERATION': args.operation,
})
subprocess.run([*simctl, 'launch', args.device, bundle], env=environment, check=True)
print(f'Test result: {directory / report_name}')
print(f'Request audit: {directory / "network-audit.jsonl"}')
