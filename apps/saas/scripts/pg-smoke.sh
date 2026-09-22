#!/usr/bin/env bash
set -euo pipefail
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
DATA_DIR="$(mktemp -d /tmp/hc-pg-smoke.XXXXXX)"
PORT="${PORT:-55439}"
cleanup(){ "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DATA_DIR"; }
trap cleanup EXIT
"$PG_BIN/initdb" -A trust -U postgres -D "$DATA_DIR" >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -h 127.0.0.1" -w start >/dev/null
echo "PG smoke instance ready on 127.0.0.1:$PORT"
echo "DATABASE_URL=postgresql://postgres@127.0.0.1:$PORT/postgres"
echo "Run migration via PgBusinessRepository, seed synthetic hc_bindings/hc_grants/projects/tasks, then restart with pg_ctl."
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast stop >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -h 127.0.0.1" -w start >/dev/null
echo "PG restart completed"
