#!/bin/sh
set -eu
case "$(uname -s):$(uname -m)" in Darwin:arm64) ;; *) echo 'hardware-companion supports Apple-silicon macOS only in v0.3' >&2; exit 2;; esac
release_url='https://github.com/gamecncom/codex-hardware-companion/releases/download/v0.3.0/hardware-companion-macos-arm64-v0.3.0.tar.gz'
checksum_url="$release_url.sha256"
work="$(mktemp -d "${TMPDIR:-/tmp}/hardware-companion.XXXXXX")"; trap 'rm -rf "$work"' EXIT INT TERM
archive="$work/hardware-companion-macos-arm64.tar.gz"
checksum="$work/release.sha256"
curl --fail --location --proto '=https' --tlsv1.2 "$release_url" --output "$archive"
curl --fail --location --proto '=https' --tlsv1.2 "$checksum_url" --output "$checksum"
(cd "$work" && shasum -a 256 -c release.sha256) || { echo 'release checksum mismatch' >&2; exit 3; }
mkdir "$work/release"; tar -xzf "$archive" -C "$work/release" --strip-components=1
install_root="${HC_INSTALL_ROOT:-$HOME/Library/Application Support/HardwareCompanion/connector}"
"$work/release/runtime/node" "$work/release/scripts/install-package.mjs" --from "$work/release" --install-root "$install_root"
"$install_root/current/bin/companion" service install --install-root "$install_root"
printf '%s\n' '{"ok":true,"operation":"bootstrap","architecture":"arm64","service":"installed"}'
