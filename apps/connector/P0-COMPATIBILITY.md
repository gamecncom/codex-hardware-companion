# P0 compatibility evidence

- Binary: `/Applications/ChatGPT.app/Contents/Resources/codex`
- Version: `codex-cli 0.154.0-alpha.6.2`
- SHA-256: `a1d2f191e70023ed7afd619bc70530f26067a085926e03bae50cf5c0f8298bcf`
- Read-only calls: `codex app-server --stdio` with `initialize`, `thread/list`; real task summaries and cwd were returned.
- Queue discovery: `codex queue --help` exposes `--thread` and `--message`.
- Not run: queue, resume, fork, start, archive, delete, title/state mutations.
- Boundary: `accountContextDetection=false`; app-server identity metadata is fingerprinted only and no auth/token is emitted.
