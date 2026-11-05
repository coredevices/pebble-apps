#!/usr/bin/env bash
# Build and test one app directory, then copy its pbw to dist/<dir>.pbw.
# Used by .github/workflows/publish.yml (to release) and check.yml (on pull requests).
set -euo pipefail

dir=$1
proj=$dir; [ -f "$dir/pbw/package.json" ] && proj=$dir/pbw
# Apps that are plugins or declare permissions; any other app is a legacy app, built as the SDK builds it.
uses_permissions='.pebble | has("plugin") or has("usesPermissions")'

case $dir in
  location-sharing) (npm ci --prefix chat/imessage && cd "$dir" && npm ci && node scripts/build-plugin.mjs && node --test plugin.test.cjs test/*.test.cjs) ;;
  chat) (cd "$dir" && npm ci --prefix imessage && node scripts/build-plugin.mjs && node --test *.test.cjs) ;;
  *) (cd "$dir"
      if [ -f package-lock.json ]; then npm ci; fi
      npm run build --if-present
      npm test --if-present) ;;
esac

mkdir -p dist
if jq -e "$uses_permissions" "$proj/package.json" >/dev/null; then
  python3 scripts/pack-plugin-pbw.py "$proj"
  cp "$proj/build/$(jq -r .name "$proj/package.json").pbw" "dist/$dir.pbw"
else
  # The packer marks a pbw manifestVersion 2, which drops an app's legacy implicit permissions.
  (cd "$proj" && pebble build)
  cp "$proj/build/$(basename "$proj").pbw" "dist/$dir.pbw"
fi
