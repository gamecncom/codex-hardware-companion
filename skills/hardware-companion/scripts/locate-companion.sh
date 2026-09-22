#!/bin/sh
set -eu

is_executable() {
  [ -f "$1" ] && [ -x "$1" ]
}

if [ "${HC_COMPANION_BIN+x}" = x ]; then
  if is_executable "$HC_COMPANION_BIN"; then
    printf '%s\n' "$HC_COMPANION_BIN"
    exit 0
  fi
  printf 'Hardware Companion executable not found or not executable: %s\n' "$HC_COMPANION_BIN" >&2
  exit 1
fi

if command -v companion >/dev/null 2>&1; then
  candidate=$(command -v companion)
  if is_executable "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for candidate in \
  "$script_dir/../../../bin/companion" \
  "$script_dir/../../../apps/connector/bin/companion"
do
  if is_executable "$candidate"; then
    printf '%s\n' "$candidate"
    exit 0
  fi
done

printf 'Hardware Companion executable not found. Set HC_COMPANION_BIN or install companion on PATH.\n' >&2
exit 1
