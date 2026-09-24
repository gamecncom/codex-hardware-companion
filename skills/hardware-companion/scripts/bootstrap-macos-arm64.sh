#!/bin/sh
set -eu
case "$(uname -s):$(uname -m)" in Darwin:arm64) ;; *) echo 'hardware-companion supports Apple-silicon macOS only' >&2; exit 2;; esac

version='0.3.10'
node_version='24.21.0'
asset="hardware-companion-macos-arm64-v$version.tar.gz"
runtime_asset="node-v$node_version-darwin-arm64.tar.xz"
runtime_sha256='6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe'
own='https://gamecncom.nat200.top/v1/install'
github="https://github.com/gamecncom/codex-hardware-companion/releases/download/v$version"
install_root="${HC_INSTALL_ROOT:-$HOME/Library/Application Support/HardwareCompanion/connector}"
runtime_root="${HC_RUNTIME_ROOT:-$HOME/Library/Application Support/HardwareCompanion/runtime}"
runtime_dir="$runtime_root/node-v$node_version-darwin-arm64"
work=''
cleanup() { if [ -n "$work" ] && [ -d "$work" ]; then rm -rf -- "$work"; fi; }
trap cleanup EXIT INT TERM

probe_node() {
  [ -x "$1" ] || return 1
  "$1" -e 'const major=Number(process.versions.node.split(".")[0]);if(process.platform!=="darwin"||process.arch!=="arm64"||![22,24].includes(major)||!process.versions.openssl)process.exit(78);Promise.all([import("node:crypto"),import("node:fs/promises"),import("node:net"),import("node:tls")]).then(()=>console.log(require("node:fs").realpathSync(process.execPath))).catch(()=>process.exit(78));' 2>/dev/null
}

download_verified() {
  name="$1"; primary="$2"; fallback="$3"
  if curl --fail --location --retry 2 --connect-timeout 10 --max-time 600 --proto '=https' --tlsv1.2 "$primary" --output "$work/$name" &&
     curl --fail --location --retry 2 --connect-timeout 10 --max-time 60 --proto '=https' --tlsv1.2 "$primary.sha256" --output "$work/$name.sha256" &&
     (cd "$work" && shasum -a 256 -c "$name.sha256" >/dev/null 2>&1); then
    printf 'own-source:%s\n' "$name" >&2
    return 0
  fi
  echo "own-source unavailable or checksum invalid for $name; trying GitHub" >&2
  if curl --fail --location --retry 2 --connect-timeout 10 --max-time 600 --proto '=https' --tlsv1.2 "$fallback" --output "$work/$name" &&
     curl --fail --location --retry 2 --connect-timeout 10 --max-time 60 --proto '=https' --tlsv1.2 "$fallback.sha256" --output "$work/$name.sha256" &&
     (cd "$work" && shasum -a 256 -c "$name.sha256" >/dev/null 2>&1); then
    printf 'github-fallback:%s\n' "$name" >&2
    return 0
  fi
  echo "DOWNLOAD_OR_CHECKSUM_FAILED:$name" >&2
  return 1
}

node=''
if [ -f "$install_root/current/runtime-node-path" ]; then
  saved=$(sed -n '1p' "$install_root/current/runtime-node-path")
  node=$(probe_node "$saved" || true)
  if [ -z "$node" ] && [ -f "$install_root/current/VERSION" ] && [ "$(sed -n '1p' "$install_root/current/VERSION")" = "$version" ]; then
    echo 'RUNTIME_REPAIR_REQUIRED: installed runtime path is invalid; rerun bootstrap after checking the path' >&2
    exit 78
  fi
fi

if [ -n "$node" ] && [ -f "$install_root/current/VERSION" ] &&
   [ "$(sed -n '1p' "$install_root/current/VERSION")" = "$version" ] &&
   (cd "$install_root/current" && shasum -a 256 -c checksums.sha256 >/dev/null 2>&1); then
  status=$("$install_root/current/bin/companion" service status --install-root "$install_root" --json || true)
  case "$status" in
    *'"running":true'*) printf '%s\n' '{"ok":true,"operation":"bootstrap","reused":true,"downloaded":false,"service":"running"}'; exit 0 ;;
  esac
  "$install_root/current/bin/companion" service start --install-root "$install_root" --json
  printf '%s\n' '{"ok":true,"operation":"bootstrap","reused":true,"downloaded":false,"service":"started"}'
  exit 0
fi

if [ -z "$node" ]; then node=$(probe_node "$runtime_dir/bin/node" || true); fi
if [ -z "$node" ] && [ -n "${HC_BOOTSTRAP_NODE:-}" ]; then
  node=$(probe_node "$HC_BOOTSTRAP_NODE" || true)
elif [ -z "$node" ]; then
  if command -v node >/dev/null 2>&1; then node=$(probe_node "$(command -v node)" || true); fi
  if [ -z "$node" ]; then node=$(probe_node '/opt/homebrew/bin/node' || true); fi
  if [ -z "$node" ]; then node=$(probe_node '/usr/local/bin/node' || true); fi
fi
if [ -z "$node" ] && [ -x "$install_root/current/runtime/node" ]; then
  old=$(probe_node "$install_root/current/runtime/node" || true)
  if [ -n "$old" ]; then
    migrated="$runtime_root/migrated-v$("$old" -p 'process.versions.node')-darwin-arm64"
    mkdir -p "$migrated/bin"
    if [ ! -x "$migrated/bin/node" ]; then cp "$old" "$migrated/bin/node"; chmod 755 "$migrated/bin/node"; fi
    node=$(probe_node "$migrated/bin/node" || true)
  fi
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/hardware-companion.XXXXXX")
if [ -z "$node" ]; then
  if [ -e "$runtime_dir" ]; then echo 'RUNTIME_REPAIR_REQUIRED: private runtime cache is invalid' >&2; exit 78; fi
  download_verified "$runtime_asset" "$own/runtime/$runtime_asset" "$github/$runtime_asset"
  actual_runtime_sha256=$(shasum -a 256 "$work/$runtime_asset" | awk '{print $1}')
  [ "$actual_runtime_sha256" = "$runtime_sha256" ] || { echo 'RUNTIME_OFFICIAL_CHECKSUM_MISMATCH' >&2; exit 78; }
  mkdir -p "$runtime_root"
  staged=$(mktemp -d "$runtime_root/.node-staging.XXXXXX")
  tar -xJf "$work/$runtime_asset" -C "$staged" --strip-components=1
  [ -f "$staged/LICENSE" ] || { echo 'RUNTIME_LICENSE_MISSING' >&2; exit 78; }
  node=$(probe_node "$staged/bin/node" || true)
  [ -n "$node" ] || { echo 'RUNTIME_NODE_INCOMPATIBLE' >&2; exit 78; }
  mv "$staged" "$runtime_dir"
  node=$(probe_node "$runtime_dir/bin/node")
fi

download_verified "$asset" "$own/v$version/$asset" "$github/$asset"
mkdir "$work/release"
tar -xzf "$work/$asset" -C "$work/release" --strip-components=1
printf '%s\n' "$node" > "$work/release/runtime-node-path"
if [ -e "$install_root/current" ]; then
  [ -x "$install_root/current/bin/companion" ] || { echo 'INSTALL_REPAIR_REQUIRED: incomplete current release' >&2; exit 78; }
  update_result=$(HC_COMPANION_NODE="$node" "$work/release/bin/companion" update --from "$work/release" --install-root "$install_root" --json)
  case "$update_result" in
    *'"updated":true'*) printf '%s\n' "$update_result" ;;
    *) echo 'UPDATE_NOT_APPLIED: previous Connector remains installed' >&2; exit 78 ;;
  esac
else
  "$node" "$work/release/scripts/install-package.mjs" --from "$work/release" --install-root "$install_root" --node "$node"
fi
"$install_root/current/bin/companion" service install --install-root "$install_root" --json
printf '%s\n' '{"ok":true,"operation":"bootstrap","reused":false,"downloaded":true,"service":"installed"}'
