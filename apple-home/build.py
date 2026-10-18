#!/usr/bin/env python3
"""Package Apple Home Control with deterministic ZIP metadata."""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

root = Path(__file__).resolve().parent
destination = root / 'build' / 'apple-home.pbw'
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, 'w', compression=ZIP_DEFLATED) as archive:
    for name in ('appinfo.json', 'plugin.js', 'config.html'):
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, (root / name).read_bytes())
print(destination)
