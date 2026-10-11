#!/bin/bash
# Reinicia o servidor de teste (site + /api) na porta 4180 e espera ele responder.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for pid in $(ps -eo pid,args | awk '/node tests\/server\.mjs/ && !/awk/ {print $1}'); do kill $pid 2>/dev/null; done
sleep 1
PORT=${PORT:-4180} BLOB_PORT=${BLOB_PORT:-4181} nohup node tests/server.mjs > tests/server.log 2>&1 &
for _ in $(seq 1 120); do
  if curl -s -o /dev/null "http://127.0.0.1:${PORT:-4180}/api/health"; then break; fi
  sleep 0.5
done
cat tests/server.log
