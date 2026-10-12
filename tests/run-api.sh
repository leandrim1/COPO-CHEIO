#!/bin/bash
# Roda as suítes de API (sem navegador). Cada uma recomeça de um banco limpo, menos api-test → api-test3, que se apoiam no que a
# anterior deixou (produtos e categorias). Resumo no fim; saída diferente de zero se alguma falhar.
#   bash tests/run-api.sh              roda tudo
#   bash tests/run-api.sh api-test10   roda só uma
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${TEST_OUT:-${TMPDIR:-/tmp}/copocheio-tests}"
mkdir -p "$OUT"
failed=0
summary=""
run() { # nome
  local name="$1"
  node "tests/$name.mjs" > "$OUT/$name.txt" 2>&1
  local code=$?
  local line
  line="$(grep -E '^(OK|FALHOU)' "$OUT/$name.txt" | tail -1)"
  summary+="$name (saída $code): ${line:-sem resumo}"$'\n'
  if [ $code -ne 0 ]; then failed=1; tail -25 "$OUT/$name.txt"; fi
}
if [ -n "$1" ]; then
  bash tests/fresh.sh >/dev/null 2>&1
  run "$1"
else
  bash tests/fresh.sh >/dev/null 2>&1
  for t in api-test api-test2 api-test3; do run "$t"; done
  for t in api-test4 api-test5 api-test5-modes api-test6 api-test7 api-test8 api-test9 api-test10 api-test11 api-test12 api-test13 api-test14 api-test15; do
    bash tests/fresh.sh >/dev/null 2>&1
    run "$t"
  done
fi
bash tests/serve.sh >/dev/null 2>&1
echo "$summary"
exit $failed
