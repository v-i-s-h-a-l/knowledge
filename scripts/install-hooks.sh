#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
hooks_dir="$(git rev-parse --git-path hooks)"

mkdir -p "$hooks_dir"

for hook in "$root"/scripts/hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" "$hooks_dir/$name"
  chmod +x "$hooks_dir/$name"
  echo "installed $name"
done
