---
name: hardware-companion
description: "Manage the local Codex Hardware Companion through its JSON CLI: initialize, diagnose, map confirmed local projects, discover and explicitly authorize tasks, pair devices, select tasks, and unbind devices."
---

# Hardware Companion

Use the installed `companion` CLI as the only interface. On a new Apple-silicon Mac, install this Skill from the public GitHub v0.3.10 tag, then run `scripts/bootstrap-macos-arm64.sh`. Bootstrap prefers the versioned files on `https://gamecncom.nat200.top/v1/install` and falls back to the matching GitHub Release, verifying SHA-256 before installation. It reuses a compatible arm64 Node.js 22/24 runtime when available; otherwise it installs the fixed Node.js 24.21.0 arm64 distribution in an independent per-user cache. It does not install Node globally, and a repeated verified version does not redownload or restart the service. Every command must use its JSON output and report `ok`, `operation`, `data`, and `error`; never infer success from terminal prose.

First-use flow: run the bootstrap, `service status`, `status`, and `doctor`; run the default `init`. On a fresh Mac it creates a persistent `clientId` and registers with the demo SaaS without email, demo code, or browser login. On a Mac with existing connector credentials, `init` returns the existing identity; do not claim a new registration or require a new `clientId`. Run `device list` and show any active binding before offering pairing. Preserve an existing binding until the user explicitly completes the computer-side unbind confirmation. For a new binding, use `project add` and `catalog sync` to discover real tasks, obtain user confirmation of exact TaskRefs, run `task authorize`, and only then run `device pair`, show the pairing code in Codex, guide voice pairing, and run `device list`/`device use`. Daily device speech is automatic: hold the voice key, speak, release, wait for valid ASR text, and the device sends it once to the TaskRef frozen at recording start. Do not ask for or trigger a second short press to confirm sending. Pairing-code speech remains a separate pairing path and must never become a chat message.

## Safety and scope

- Initialization, device pairing, project mapping, task discovery, grants, selection, and unbinding are separate operations. Explain which one succeeded and which remains pending.
- A project root and task must be explicitly confirmed by the user before granting it. Discovery never grants and never uploads project files or complete chat history.
- Preserve exact `threadId`, original `cwd`, and project mapping IDs; never substitute titles, list positions, or A/B/C slots.
- If no reliable task ID is available, show discovered candidates and ask the user to choose; do not send a message to a guessed task.
- Native approvals are not supported (`nativeApproval=false`). For `waiting_user` or approval-like states, instruct the user to continue in Codex on the computer; never send an approval text as a substitute.
- Never print, store in chat, or hard-code SaaS tokens, bootstrap credentials, or Codex auth data.
- A queue accepted/uncertain result is not proof of execution or completion. Surface `uncertain` and wait for a later task read.
- This skill does not read Codex private databases, control desktop windows, flash firmware, or promise real-device validation.

## Operations

Run these stable commands (append `--json` where supported):

```text
companion status --json
companion doctor --json
companion init --json
companion auth start --json
companion auth poll --json
companion device pair --json
companion device list --json
companion device use --device "<exact deviceId>" --json
# Or select by the exact binding ID returned by `device list`:
companion device use --binding "<exact bindingId>" --json
companion project add --name "<confirmed name>" --root "<confirmed absolute root>" --json
companion task discover --json
companion task read --thread "<exact threadId>" --json
companion task grant --ref '{"connectorId":"<exact connectorId>","projectId":"<exact projectId>","threadId":"<exact threadId>"}' --json
companion task select --ref '{"connectorId":"<exact connectorId>","projectId":"<exact projectId>","threadId":"<exact threadId>"}' --json
companion task authorize --refs '[...]' --preferred '{...}' --json
companion device unbind prepare --json
companion device unbind confirm --operation "<operationId>" --json
companion service install --json
companion service status --json
companion service start --json
companion service stop --json
companion service uninstall --json
```

The current connector implements anonymous persistent-client initialization, legacy email-code `init` only for local fixture compatibility, `status`, `doctor`, `project add`, `catalog sync`, `daemon start`, `task discover`, `task read`, `device list`, `device use`, computer-initiated pairing-code creation, `device rename`, connector-owned `task authorize`, binding grants, `task select`, and two-step `device unbind prepare/confirm`. After initialization, run `device list` even if pairing has already happened; run `device use` with the exact active device or binding ID if needed. `device use` verifies the active binding belongs to the current connector, stores its `bindingId` and current `selectionRevision`, then fetches and stores confirmed task grants and `grantsVersion`; it does not require or store a device token. Task discovery remains read-only; after the user confirms exact TaskRefs, use `task authorize` before voice pairing, and use `task grant` only for an already-bound binding. `task select` refreshes the binding's current selection revision immediately before posting and persists the returned revision. Unbinding always stops after `prepare` until the user explicitly confirms the exact device and impact; cancellation means no confirm call. The server owns identity for the anonymous connector; do not ask users for `--user-id`, email, demo codes, or browser approval. Device rename calls the SaaS PATCH route; the local CLI reports a server error if that route is unavailable, and must not present that case as successful.

Use `scripts/locate-companion.sh` when the executable location is unknown. It is read-only and checks `HC_COMPANION_BIN`, then `companion` on `PATH`, then the installed release `bin/companion`; it prints an executable path or a clear missing message and never installs, downloads, or starts anything. In a release package, invoke `bin/companion`; its wrapper uses the validated absolute Node path in `runtime-node-path` and `dist/cli.js`, so paths containing spaces are supported without requiring a global Node.js. If the pinned runtime path is invalid, report `RUNTIME_REPAIR_REQUIRED` and rerun bootstrap after checking the runtime; do not silently switch a background service to a different Node.

`service install|start|status|stop|uninstall` manages only the local launch agent and requires explicit user authorization for state-changing actions. `device unbind` revokes the selected cloud device binding; it does not uninstall the local service. Conversely, service uninstall does not revoke a cloud binding. The `update` command remains development-only and is not a stable workflow documented by this Skill; no GitHub or release publication is implied.

The CLI defaults to the deployed demo SaaS at `https://gamecncom.nat200.top`; do not ask the user to enter a URL. `--base-url` is for explicit development or a separately authorized deployment, not the normal demo flow.

## Initialization response

Report independent checks: CLI installed, existing or newly registered SaaS connector identity, local Codex read/list capability, background service, active device binding, and user-confirmed grants. A passing read-only probe does not mean sending is authorized. Repeat initialization safely; do not create duplicate bindings.
