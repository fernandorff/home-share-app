#!/usr/bin/env bash
# Parity gate, end to end (spec 013): fresh twin databases, the Next app on one (TZ=UTC, like Vercel), the Rust
# server on the other, every case in cases.mjs, then everything torn down. Needs Docker and `npm ci`.
#   bash server/gate/run.sh [filter]
set -euo pipefail
cd "$(dirname "$0")/../.."

PG_PORT=38160 NEXT_PORT=38161 RUST_PORT=38162
export GATE_PG="postgresql://postgres:gate@127.0.0.1:$PG_PORT/postgres"
export NEXT_URL="http://127.0.0.1:$NEXT_PORT" RUST_URL="http://127.0.0.1:$RUST_PORT"
export JWT_SECRET="gate-secret-local-only"
SERVER_DIR="$(cd server && pwd -W 2>/dev/null || pwd)"

docker start hs-gate-pg >/dev/null 2>&1 || docker run -d --name hs-gate-pg -e POSTGRES_PASSWORD=gate -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine >/dev/null
until docker exec hs-gate-pg pg_isready -q -U postgres; do sleep 1; done
node server/gate/gate.mjs reset

MSYS_NO_PATHCONV=1 docker run --rm -v "$SERVER_DIR:/w" -v hs-cargo:/usr/local/cargo/registry -v hs-target:/w/target -w /w \
  rust:1.90-bookworm cargo build --release -q
docker rm -f hs-server-gate >/dev/null 2>&1 || true
MSYS_NO_PATHCONV=1 docker run -d --rm --name hs-server-gate -p "127.0.0.1:$RUST_PORT:8080" -v hs-target:/t \
  -e DATABASE_URL="postgresql://postgres:gate@host.docker.internal:$PG_PORT/gate_b" -e JWT_SECRET \
  debian:bookworm-slim /t/release/home-share-server >/dev/null

TZ=UTC DATABASE_URL="postgresql://postgres:gate@127.0.0.1:$PG_PORT/gate_a" node node_modules/next/dist/bin/next dev --webpack -p "$NEXT_PORT" >/tmp/gate-next.log 2>&1 &
NEXT_PID=$!
stop() {
  docker stop hs-server-gate >/dev/null 2>&1 || true
  # next dev spawns its own server process: end the whole tree.
  if [ -r "/proc/$NEXT_PID/winpid" ]; then taskkill //T //F //PID "$(cat /proc/$NEXT_PID/winpid)" >/dev/null 2>&1 || true; else kill "$NEXT_PID" 2>/dev/null || true; fi
}
trap stop EXIT
for _ in $(seq 1 120); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$NEXT_URL/api/health")" = 200 ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$RUST_URL/api/health")" = 200 ] && break
  sleep 2
done
node server/gate/gate.mjs run "${1:-}"
