#!/usr/bin/env bash
set -euo pipefail

support_dir="$(cd "$(dirname "$0")" && pwd)"
source_dir="$support_dir/rustpush"
generated_dir="$support_dir/generated/rustpush"
expected_commit="a7fab473e7a33325a760635285db2860de8e1cb0"

if [[ ! -f "$source_dir/Cargo.toml" ]]; then
  echo "rustpush submodule is missing; run git submodule update --init --recursive" >&2
  exit 1
fi

actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "rustpush is at $actual_commit; expected $expected_commit" >&2
  exit 1
fi
if [[ -n "$(git -C "$source_dir" status --short --untracked-files=no)" ]]; then
  echo "rustpush has tracked local changes; add them as an overlay patch instead" >&2
  exit 1
fi

mkdir -p "$generated_dir"
rsync -a --delete --exclude target --exclude .git "$source_dir/" "$generated_dir/"
for patch_file in "$support_dir"/patches/*.patch; do
  patch --silent -p1 -d "$generated_dir" < "$patch_file"
done
