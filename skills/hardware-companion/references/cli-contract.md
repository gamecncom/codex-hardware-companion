# CLI contract

Success: `{ "ok": true, "operation": string, "data": object }`.

Failure: `{ "ok": false, "operation": string, "data": object, "error": { "code": string, "message": string, "retryable": boolean } }`.

`message queue` requires exact `--thread`, message text, original `--cwd`, and caller-generated `--message-id`. Repeating the same message ID returns the ledger entry and does not invoke Codex again. A process failure after dispatch may be `QUEUE_UNCERTAIN`; do not retry automatically without reconciliation.
