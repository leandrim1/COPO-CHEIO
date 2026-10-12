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
  local extra=0 code line note=""
  while :; do
    bash tests/fresh.sh >/dev/null 2>&1
    env "$@" node "tests/$name.cjs" > "$OUT/$name.txt" 2>&1
    code=$?
    [ $code -eq 0 ] && break
    # Navegador em máquina lenta (CI) pode perder uma corrida de tempo: E2E_RETRIES=1 repete o arquivo que falhou, e o resumo avisa.
    if [ $extra -lt "${E2E_RETRIES:-0}" ]; then
      extra=$((extra + 1))
      echo "  $name falhou (saída $code); tentando de novo ($extra/${E2E_RETRIES})"
      grep -E '^(FAIL|CRASH)' "$OUT/$name.txt" | head -5
      cp "$OUT/$name.txt" "$OUT/$name.tentativa$extra.txt"
      continue
    fi
    break
  done
  [ $extra -gt 0 ] && note=" [precisou de $extra nova(s) tentativa(s); veja $name.tentativa*.txt]"
  line="$(grep -E '^(OK|FALHOU|ALL PASSED|TUDO OK|[0-9]+ FALHA|CRASH)' "$OUT/$name.txt" | tail -1)"
  summary+="$name (saída $code)$note: ${line:-sem resumo}"$'\n'
  if [ $code -ne 0 ]; then failed=1; grep -E '^(FAIL|CRASH)' "$OUT/$name.txt" | head -10; fi
}
if [ -n "$1" ]; then run "$1" X=1; else
  for t in e2e e2e-track e2e-verify e2e-recover e2e-cover e2e-whatsapp e2e-hardening e2e-ice e2e-pix e2e-account; do run "$t" X=1; done
  bash tests/fresh.sh >/dev/null 2>&1
  MAIL_MODE=none bash tests/serve.sh >/dev/null 2>&1
  node tests/e2e-mail-off.cjs > "$OUT/e2e-mail-off.txt" 2>&1; code=$?
  summary+="e2e-mail-off (saída $code): $(grep -E '^(OK|FALHOU|CRASH)' "$OUT/e2e-mail-off.txt" | tail -1)"$'\n'
  [ $code -ne 0 ] && failed=1
fi
bash tests/serve.sh >/dev/null 2>&1
echo "$summary"
exit $failed
