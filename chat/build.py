#!/usr/bin/env python3
"""Bundle shared iMessage sources with esbuild, then package Chat reproducibly.

Install the pinned shared build tool first: npm --prefix public/plugins/imessage ci
"""
import pathlib
import subprocess
import zipfile

root = pathlib.Path(__file__).resolve().parent
subprocess.run(['node', str(root / 'scripts/build-plugin.mjs')], check=True)
destination = root / 'build' / 'chat.pbw'
destination.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in ('appinfo.json', 'plugin.js', 'config.html'):
        info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, (root / name).read_bytes())
print(destination)
