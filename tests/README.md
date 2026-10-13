# Testes do COPO CHEIO

Três camadas, todas rodam no seu computador (ou no GitHub Actions) **sem tocar no banco, no Blob nem no e-mail de verdade**:

| Camada | O que faz | Como roda |
| ------ | --------- | --------- |
| **Unitários** (`unit/`) | Funções puras do projeto: senha, TOTP (2FA), validação de imagem, detecção de IP, URL do site, formatação, normalização dos dados da API, regras do carrinho (escolha do gelo), pagamento online (o que o cliente pode ver, prazos, conversão do que a operadora informa) e o **adaptador da ValidaPay** (dinheiro em reais, escopos, status, HMAC dos avisos, formulário de cadastro) | `npm run test:unit` (segundos) |
| **API** (`api-test*.mjs`) | A API de verdade (`api/index.ts`) contra um **PostgreSQL local**, com Blob falso, SMTP de mentira e DNS simulado | `npm run test:api` (alguns minutos) |
| **Navegador** (`e2e*.cjs`) | Site e painel num Chromium real (Playwright), de ponta a ponta | `npm run test:e2e` (alguns minutos) |

`npm test` = checagem de tipos + unitários + API. Os de navegador ficam à parte porque precisam do build e do Chromium.

## Preparar (uma vez)

1. **Node 22** ou mais novo e `npm ci` na raiz do projeto.
2. `npm ci --prefix tests` (esbuild, Playwright, driver do Postgres, servidor SMTP de teste).
3. **PostgreSQL 16** escutando em `127.0.0.1:5433`, usuário `postgres`, **sem senha** (`trust`), e o cliente `psql` no PATH.
   Em outro endereço: `TEST_PG_URL=postgres://postgres@127.0.0.1:5433/copocheio_test` e `PGPORT`/`PGHOST` conforme o caso.
   Exemplo com Docker: `docker run -d -p 5433:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`.
4. Para os de navegador: `(cd tests && npx playwright install chromium)` e `npm run build` (eles abrem o site já construído).

Os scripts são `bash`. No Windows, use o Git Bash ou o WSL.

## Rodar

```bash
npm run test:unit                 # unitários
npm run test:api                  # todas as suítes de API (cada uma começa de um banco limpo)
bash tests/run-api.sh api-test10  # só uma suíte
npm run build && npm run test:e2e # navegador (todas)
bash tests/run-e2e.sh e2e-track   # só um arquivo
```

Cada suíte imprime `OK: N checks passaram` ou lista o que falhou; o resumo no fim mostra uma linha por suíte e o comando
termina com erro se alguma falhar. A saída completa de cada uma fica em `$TMPDIR/copocheio-tests/<nome>.txt` (ou em `$TEST_OUT`).
`E2E_RETRIES=1 npm run test:e2e` repete uma vez o arquivo de navegador que falhar (o CI usa isso, porque o Chromium em máquina lenta
às vezes perde uma corrida de tempo); o resumo avisa quando precisou da segunda tentativa e guarda a saída da primeira.

## Como funciona

- `server.mjs` empacota `api/index.ts` com o esbuild e serve **site + API** em `127.0.0.1:4180`. O roteamento do `vercel.json`
  (redirecionamentos, reescritas, cabeçalhos) é aplicado com o mesmo pacote que a Vercel usa (`@vercel/routing-utils`).
- `neon-proxy.mjs` faz o driver do Neon falar com o Postgres local; `with-neon-proxy.mjs` roda `scripts/migrate.mjs` e
  `scripts/create-admin.mjs` do mesmo jeito.
- `mailsink.mjs` é o servidor SMTP de mentira (os e-mails enviados ficam acessíveis ao teste); `dnsmock.mjs` simula o DNS dos
  domínios de e-mail; o Blob é um servidor falso na porta 4181.
- `payments-sim.mjs` é um **simulador de operadora de pagamento** (NÃO é a ValidaPay nem fala com ela). O servidor de teste o liga no
  lugar de `server/payments/factory.ts` (o código de produção devolve "sem operadora" e nunca importa o simulador) e expõe controles em
  `/__pay/*` só nesse servidor: recusa, queda, demora, valor errado, falha de repasse, aviso repetido/atrasado/sem assinatura, vencimento e
  estorno. Serve para provar a **lógica da loja**, não a integração real.
- `validapay-fake.mjs` é um **servidor ValidaPay FALSO** (NÃO é a ValidaPay): segue a documentação oficial (autenticação, Pix com divisão, consulta, cancelamento,
  extrato, subcontas, propostas) e **recusa o que foge dela**. O servidor de teste, ligado com `PAYMENTS_SIM=validapay`, usa o adaptador **real**
  (`server/payments/validapay.ts`) apontado para ele (`factory-validapay.ts`). `api-test15` e `e2e-account` o usam.
- `reset.sh` recria o banco `copocheio_test`, aplica **todas** as migrations e cria o owner de teste
  (`dono@copocheio.local` / `senha-forte-123`). `fresh.sh` = `reset.sh` + reinício do servidor. `serve.sh` reinicia só o servidor.

## O que cada arquivo cobre

| Arquivo | Assunto |
| ------- | ------- |
| `api-test` · `api-test2` · `api-test3` | Rotas públicas e administrativas, login e força bruta, categorias, produtos, upload, configurações, pedidos (preço, estoque, taxa, concorrência), dashboard, administradores |
| `api-test4` | Acompanhamento permanente de pedidos e contas de clientes |
| `api-test5` · `api-test5-modes` | Confirmação do e-mail (códigos, links, limites, abuso, concorrência) e modos de falha (sem SMTP, DNS fora do ar) |
| `api-test6` | Layout e conteúdo dos e-mails |
| `api-test7` | Recuperação de senha por e-mail |
| `api-test8` | Banner da capa da página Bebidas |
| `api-test9` | WhatsApp da loja (migration 0008) |
| `api-test10` | **Segurança**: limites atômicos, senha forte, 2FA, aparelho novo, links de e-mail, cabeçalhos HTTP/CSP, anti-robô nos pedidos, pré-sequestro de cadastro, imagens, rotas e informações expostas |
| `api-test11` | **Pedidos e catálogo**: pedido repetido (idempotência), total conferido, preço, duplicados, regras de status/pagamento, estoque, promoção com datas, importação com relatório, cache das listas |
| `api-test12` | **Permissões e atividades**, edição simultânea das configurações, privacidade (LGPD), HTML para robôs (SEO) |
| `api-test13` | **Escolha do gelo**: a migration 0013 num banco de produção antigo (marca só Copão e Copão com Monster), o banco recusando pedido sem a escolha (requisição direta, valores inventados, linhas misturadas), linhas separadas por gelo, estoque e limites pela soma, regra presa à categoria (renomear não desliga), idempotência e total conferido, acompanhamento, conta, painel, dashboard e cancelamento |
| `api-test14` | **Pagamento online (Pix) com o simulador**: a migration 0014 num banco de produção antigo (nada existente muda; o Pix online nasce desligado e só liga com operadora + conta aprovada), pedido "aguardando pagamento" com o total do banco, uma só cobrança por pedido, quem pode ver e criar, confirmação só por aviso verificado + consulta, valor errado, falha de repasse da comissão e conciliação, operadora fora do ar, vencimento/nova tentativa/cancelamento e pagamento tardio, concorrência (cliques, avisos e consultas simultâneos), estorno, painel (owner × atendente), comissão de 2% em centavos (a migration 0016 não reescreve cobranças antigas), conta do cliente. Confere também que o log do servidor não guarda Pix nem segredos |
| `api-test15` | **ValidaPay (adaptador real × servidor falso)**: vínculo de conta existente (lista oficial, documento mascarado, autorização), Pix com divisão fixa de 2% na subconta (valores em reais, metadata, `X-Sub-Account`, sem `externalId`), avisos assinados (assinatura errada/antiga/adulterada recusadas, duplicados, aviso de "pago" com a cobrança ainda aberta não libera nada), consulta com e sem o cabeçalho da subconta, comissão só efetivada com o crédito no extrato da master, valor errado, disputa e estorno, **cancelamento na ValidaPay do Pix vencido** (inclusive a corrida pagamento × cancelamento e a operadora fora do ar), cobrança "órfã" achada pelo `metadata`, cadastro de conta (PF/PJ, formulário inválido nunca enviado, aprovação só pelo aviso oficial, reprovação, resposta perdida, 5 envios simultâneos = 1 proposta, produção exige ciência das tarifas) e nada sensível no log |
| `e2e` | Painel + site + checkout + pedidos ao vivo |
| `e2e-track` · `e2e-verify` · `e2e-recover` | Acompanhamento e conta; cadastro com confirmação; recuperação de senha |
| `e2e-cover` · `e2e-whatsapp` | Banner da capa; botões de WhatsApp |
| `e2e-hardening` | 2FA no painel, configurações simultâneas, atividades, produtos (promoção, importação), privacidade, página não encontrada, checkout (total conferido, envio repetido), API fora do ar, tela de erro, CSP sem bloqueios |
| `e2e-ice` | **Escolha do gelo no navegador** (celular e computador): a pergunta e a mensagem obrigatória, destaque e troca da escolha, linhas separadas, editar no pedido, guardar ao recarregar, checkout, página do pedido, WhatsApp, painel (pedido, recibo e Categorias), pedido antigo sem escolha, regra mudando no meio da compra, teclado/foco/leitor de tela e telas pequenas |
| `e2e-pix` | **Pix online no navegador** (celular e computador, com o simulador): com o Pix online desligado o checkout é o de sempre (3 formas, sem menção ao Pix online); ligado, aparece a quarta forma; tela do Pix (QR Code com descrição para leitor de tela, copia e cola somente leitura, contagem, "Já paguei" que só confere), confirmação sem recarregar, Pix vencido e nova tentativa, falha ao gerar com "Tentar de novo", pagar pelo "Meus pedidos", aviso de pedido pago e aba "Aguardando pagamento" no painel, detalhe do pedido, página Pagamentos e interruptor (só owner; o atendente não vê comissão nem a página) e ausência de erros no console |
| `e2e-account` | **Conta do estabelecimento no navegador** (celular e computador, servidor ValidaPay falso): "Não conectada" com o NOME das variáveis que faltam, vincular uma conta existente (documento mascarado, não confirmada não pode ser escolhida, exige a autorização do titular), cadastrar uma conta nova (PF/PJ, erros por campo, autorização, andamento, envio de documentos não guardado) e a conta só "Aprovada" com o aviso oficial |
| `e2e-combo` | **Combos no navegador** (celular e computador): ao adicionar um combo aparece o aviso "Obs: CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA." (fecha, some sozinho, `role="status"`, só na categoria "Combos"); a observação fica na linha do combo (gaveta e checkout); o botão "QUERO TROCAR O ENERGÉTICO" abre a lista de energéticos (só os da categoria, esgotado por último, promoção, adicionar/quantidade, Esc fecha só a lista, por cima da gaveta, no checkout) e não aparece sem energéticos |
| `e2e-mail-off` | Servidor sem SMTP: cadastro indisponível com mensagem clara |

## O que estes testes **não** provam

- O comportamento **da Vercel em produção** (cabeçalhos finais, cache da CDN, `includeFiles`, regras de `has` em redirecionamentos e
  reescritas): o `vercel.json` é validado com `@vercel/routing-utils` e um servidor local, não pela Vercel de verdade.
- O **Neon** real (latência, "dormir" sem uso, limites do plano), o **Vercel Blob** real e a **entrega de e-mail** (SPF/DKIM,
  caixa de spam) com um provedor de verdade.
- **A ValidaPay de verdade.** Os testes de pagamento online usam um simulador genérico e um servidor ValidaPay FALSO, escritos por nós a partir da
  documentação; eles provam a lógica da loja e do adaptador (banco, estados, idempotência, comissão, assinatura, telas), **não** que a ValidaPay se comporta
  exatamente assim (autenticação, divisão da comissão, extrato, assinatura do webhook). Isso só se prova no **sandbox** da ValidaPay, o que **nunca foi feito**.
- Safari, Firefox e iOS: os testes de navegador usam Chromium.
- A produção em si: nada aqui acessa `copocheio-nu.vercel.app`.

`npm audit --prefix tests` aponta 2 avisos (`path-to-regexp`, via `@vercel/routing-utils`): as dependências desta pasta só existem
para testar e nunca vão para o site publicado.

Depois de um deploy, confira `GET /api/health`, o painel (*Configurações → Painel → Estado do sistema*) e um pedido de teste
(veja `docs/OPERACAO.md`).
