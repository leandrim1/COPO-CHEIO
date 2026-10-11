#!/bin/bash
# Banco limpo + servidor reiniciado (o reset derruba as conexões do servidor antigo).
DIR="$(cd "$(dirname "$0")" && pwd)"
bash "$DIR/reset.sh" >/dev/null && bash "$DIR/serve.sh" >/dev/null && echo "pronto: banco limpo e servidor no ar"
