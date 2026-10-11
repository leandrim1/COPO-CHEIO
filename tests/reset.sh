#!/bin/bash
# Banco de teste limpo: recria, migra e cria o owner (dono@copocheio.local / senha-forte-123).
# Precisa de um Postgres em 127.0.0.1:5433 (usuário postgres, sem senha) e do cliente psql.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
psql -q -h 127.0.0.1 -p 5433 -U postgres -d postgres -c "drop database if exists copocheio_test with (force)" -c "create database copocheio_test" >/dev/null || exit 1
node tests/with-neon-proxy.mjs scripts/migrate.mjs >/dev/null || exit 1
ADMIN_PASSWORD='senha-forte-123' node tests/with-neon-proxy.mjs scripts/create-admin.mjs dono@copocheio.local "Dono Teste" >/dev/null || exit 1
echo "banco de teste pronto"
