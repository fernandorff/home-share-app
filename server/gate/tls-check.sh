#!/usr/bin/env bash
# Database TLS with channel binding, like Neon (sslmode=require&channel_binding=require): a throwaway Postgres with
# TLS (its own CA, ECDSA P-256 / SHA-256) and SCRAM, then the ignored test in server/src/main.rs against it.
#   bash server/gate/tls-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER_DIR="$(pwd -W 2>/dev/null || pwd)"
NET=hs-tls-net PG=hs-tls-pg CERTS=hs-tls-certs
stop() { docker rm -f "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; docker volume rm "$CERTS" >/dev/null 2>&1 || true; }
trap stop EXIT
stop
docker network create "$NET" >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm -v "$CERTS:/c" rust:1.90-bookworm sh -c '
  cd /c &&
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -sha256 -nodes -days 1 -subj "/CN=hs-tls-ca" -keyout ca.key -out ca.pem 2>/dev/null &&
  openssl x509 -in ca.pem -outform der -out ca.der &&
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=hs-tls-pg" -keyout server.key -out server.csr 2>/dev/null &&
  printf "subjectAltName=DNS:hs-tls-pg\n" > ext &&
  openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -sha256 -days 1 -extfile ext -out server.crt 2>/dev/null &&
  chown 70:70 server.key server.crt && chmod 600 server.key'
MSYS_NO_PATHCONV=1 docker run -d --name "$PG" --network "$NET" -v "$CERTS:/c:ro" -e POSTGRES_PASSWORD=tls-check \
  postgres:16-alpine -c ssl=on -c ssl_cert_file=/c/server.crt -c ssl_key_file=/c/server.key >/dev/null
until docker exec "$PG" pg_isready -q -U postgres -h 127.0.0.1; do sleep 1; done
MSYS_NO_PATHCONV=1 docker run --rm --network "$NET" -v "$SERVER_DIR:/w" -v "$CERTS:/c:ro" -v hs-cargo:/usr/local/cargo/registry -v hs-target:/w/target -w /w \
  -e TLS_TEST_URL="postgresql://postgres:tls-check@hs-tls-pg:5432/postgres?sslmode=require&channel_binding=require" -e TLS_TEST_CA=/c/ca.der \
  rust:1.90-bookworm cargo test -q connects_with_channel_binding_required -- --ignored
