#!/bin/bash
# Roda os testes de navegador (Chromium). Precisa de `npm run build` feito antes e do Playwright (npm ci --prefix tests).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${TEST_OUT:-${TMPDIR:-/tmp}/copocheio-tests}"
mkdir -p "$OUT"
failed=0
summary=""
run() { # nome [variável=valor ...]
  local name="$1"; shift
  bash tests/fresh.sh >/dev/null 2>&1
  env "$@" node "tests/$name.cjs" > "$OUT/$name.txt" 2>&1
  local code=$?
  local line
  line="$(grep -E '^(OK|FALHOU|ALL PASSED|TUDO OK|[0-9]+ FALHA|CRASH)' "$OUT/$name.txt" | tail -1)"
  summary+="$name (saída $code): ${line:-sem resumo}"$'\n'
  if [ $code -ne 0 ]; then failed=1; grep -E '^(FAIL|CRASH)' "$OUT/$name.txt" | head -10; fi
}
if [ -n "$1" ]; then run "$1" X=1; else
  for t in e2e e2e-track e2e-verify e2e-recover e2e-cover e2e-whatsapp e2e-hardening; do run "$t" X=1; done
  bash tests/fresh.sh >/dev/null 2>&1
  MAIL_MODE=none bash tests/serve.sh >/dev/null 2>&1
  node tests/e2e-mail-off.cjs > "$OUT/e2e-mail-off.txt" 2>&1; code=$?
  summary+="e2e-mail-off (saída $code): $(grep -E '^(OK|FALHOU|CRASH)' "$OUT/e2e-mail-off.txt" | tail -1)"$'\n'
  [ $code -ne 0 ] && failed=1
fi
bash tests/serve.sh >/dev/null 2>&1
echo "$summary"
exit $failed
