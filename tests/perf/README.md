# Medição de desempenho

Ferramentas para **medir** o site (não são testes que passam ou falham). Tudo roda no seu computador, contra o **site de teste** (o mesmo servidor que os
testes de navegador usam: `tests/server.mjs`, com Postgres local, Blob falso e e-mail de mentira) — **nada toca o Neon, o Blob nem o site de produção**.
O relatório da otimização, com os números de antes e depois, está em [`docs/DESEMPENHO.md`](../../docs/DESEMPENHO.md).

## O que é simulado (e o que não é)

- **Celular "android"**: tela 412 × 915 (DPR 2,625), **CPU 4× mais lenta** e **4G lento** (1,6 Mbps, 150 ms de latência) — a mesma ideia do perfil móvel do
  Lighthouse. **"weak"**: aparelho muito fraco (CPU 6× mais lenta, 0,8 Mbps, 300 ms). **"desktop"**: 1366 × 768, 10 Mbps, 40 ms. O estrangulamento é feito pelo
  protocolo do Chrome (o mesmo do painel *Network*/*Performance* do DevTools).
- O servidor de teste **não comprime** as respostas; a Vercel comprime (Brotli). `proxy.cjs` comprime texto em Brotli no caminho, para o tempo de rede
  refletir os bytes que trafegam em produção. Para medir como produção, aponte as ferramentas para a porta do proxy.
- **Não é possível medir aqui**: a internet real (latência até a Vercel e o Neon, região das funções, partida a frio), GPU e memória de aparelhos reais, o vídeo
  da página inicial (fica num endereço externo que o teste não alcança: a requisição é bloqueada, igual em todas as medições), as fotos reais da loja (usa-se um
  cardápio **sintético** de 90 produtos com fotos geradas pelo mesmo caminho do painel) e a medição de campo (usuários reais). Números daqui servem para
  **comparar versões** nas mesmas condições, não para prever o tempo exato de um cliente.

## Preparar (uma vez)

Tudo de [`tests/README.md`](../README.md#preparar-uma-vez): Node 22, `npm ci --prefix tests`, PostgreSQL local em `127.0.0.1:5433`, `psql` e o Chromium do Playwright.

```bash
node tests/perf/seed.cjs images           # gera as fotos sintéticas em tests/perf/.data (uma vez, ~20 MB)
bash tests/fresh.sh                       # banco limpo + servidor de teste na porta 4180
node tests/perf/seed.cjs sql              # cardápio sintético no banco de teste (ZERA produtos/categorias/banners/bairros do banco de TESTE)
npm run build && node tests/perf/seed.cjs install dist     # o build apaga dist/: copie as fotos de novo depois de cada build
node tests/perf/proxy.cjs 4291 4180 &     # proxy com Brotli na frente do servidor de teste (use a porta 4291 nas medições)
```

`seed.cjs sql --no-thumbs` grava o mesmo cardápio **sem** as miniaturas (como era antes da migration 0025), para comparar.

Para comparar **duas versões**, rode cada uma num servidor de teste próprio: `git worktree add /tmp/base <commit>`, `npm run build` nela, e
`PORT=4190 BLOB_PORT=4191 node tests/server.mjs` dentro da pasta (as duas compartilham o mesmo banco de teste). Atenção: `tests/serve.sh` (usado pelos testes) encerra
**todos** os `node tests/server.mjs`; depois de rodar os testes, suba o servidor de comparação de novo.

## Ferramentas

| Arquivo | O que mede |
| ------- | ---------- |
| `bench.cjs` | Carga a frio (FCP, LCP, CLS, TBT, bytes por tipo, requisições, memória do JavaScript), **rolagem do cardápio inteiro** (quadros, fotos baixadas), **interações** (adicionar, digitar na busca, abrir o pedido: duração de cada uma, como o INP), volta ao site com cache e o cenário `jump` (rola rápido e para: quanto leva para as fotos da tela carregarem). Várias execuções; mostra a mediana. |
| `interactions.cjs` | Só as interações, com a CPU do celular simulado (rede normal): duração de cada uma, CPU por toque e, para o toque em "Adicionar", de onde vem o tempo (atraso de entrada × JavaScript do site × estilo/layout/pintura). |
| `lcp.cjs` | **Quando a foto principal aparece de verdade** (candidatos a LCP até a rede assentar, 12 s) e a linha do tempo das fotos: início → fim, tamanho, prioridade; avisa foto pedida duas vezes e aviso do console (ex.: foto adiantada e não usada). É a ferramenta para ver a disputa por rede entre as fotos. |
| `scroll.cjs` | Custo de **renderização** da rolagem (sem o ruído da rede): tempo de pintura, camadas, composição e estilo na thread principal, e quadros lentos. |
| `memory.cjs` | **Memória** do navegador (PSS dos processos, lida de `/proc`) depois de rolar o cardápio inteiro, e pixels de fotos decodificados. Só Linux. |
| `cls.cjs` | Saltos de layout da carga a frio, com o elemento que se mexeu (celular, tablet, computador). |
| `shots.cjs` + `diff.cjs` | **Comparação visual**: capturas deterministicamente iguais (relógio congelado) em celular, tablet e computador; `diff.cjs` mostra a diferença por pixel (com `--heatmap` grava onde está). Duas capturas do mesmo site dão diferença **zero**. |
| `lighthouse.mjs` | Lighthouse sobre o site de teste (celular e computador). O Lighthouse não é dependência do projeto: instale numa pasta à parte (instruções no começo do arquivo). |

Exemplos:

```bash
node tests/perf/bench.cjs --url http://127.0.0.1:4291 --label depois --page /bebidas --profile android --runs 3 --scenario full --out depois.json
node tests/perf/bench.cjs --url http://127.0.0.1:4291 --label depois --page /bebidas --profile android --runs 3 --scenario jump
node tests/perf/bench.cjs --url http://127.0.0.1:4291 --label depois --page / --profile android --runs 5 --scenario load
node tests/perf/interactions.cjs http://127.0.0.1:4180 depois 3
node tests/perf/lcp.cjs http://127.0.0.1:4291 depois 3 android /bebidas
node tests/perf/scroll.cjs http://127.0.0.1:4180 depois 5
node tests/perf/memory.cjs http://127.0.0.1:4180 depois 3
node tests/perf/cls.cjs http://127.0.0.1:4180 /bebidas android
node tests/perf/shots.cjs http://127.0.0.1:4190 /tmp/antes && node tests/perf/shots.cjs http://127.0.0.1:4180 /tmp/depois && node tests/perf/diff.cjs /tmp/antes /tmp/depois
```

## Como ler os números

- **LCP** (maior elemento visível): meta do Google ≤ 2,5 s (p75 dos usuários reais). **INP** (resposta às interações): ≤ 200 ms. **CLS** (saltos de layout): ≤ 0,1.
  `bench.cjs` e `interactions.cjs` mostram a duração de cada interação com a CPU estrangulada, que é uma estimativa **conservadora** do INP de um celular fraco.
- **TBT** (tempo bloqueado depois do primeiro desenho) é a medida de laboratório mais próxima do INP.
- Compare sempre **na mesma máquina, no mesmo momento** e com a máquina quieta (a CPU simulada continua dependendo da CPU real). Rode mais de uma vez: as medianas de
  3 a 5 execuções são estáveis (a variação típica é de alguns por cento).
- Os testes de API/navegador (`npm run test:api`, `npm run test:e2e`) **reiniciam o banco**: depois deles, rode `seed.cjs sql` de novo antes de medir.
