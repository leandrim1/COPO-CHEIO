# Cartão de crédito online com a taxa repassada ao cliente (Copo Cheio + ValidaPay)

> **Estado: escrito e testado, mas NUNCA testado de verdade contra a ValidaPay (nem sandbox, nem produção).**
> O que está provado: a **lógica da loja** (conta da taxa, banco, idempotência, confirmação, painel, telas) e o **adaptador** contra um **servidor ValidaPay FALSO**
> (`tests/validapay-fake.mjs`) escrito a partir da documentação oficial lida pelo servidor MCP da ValidaPay. O que **não** está provado: que a ValidaPay de verdade responde
> exatamente assim, que a taxa de **5,37% + R$ 0,37** é a do contrato, que o SDK de tokenização funciona sob a CSP desta loja e que a cobrança do cartão aceita o cabeçalho
> `X-Sub-Account`. Isso só se prova no **sandbox** (passo a passo abaixo).
>
> **Nada foi feito em produção**: nenhum deploy, nenhum dado real alterado, nenhuma subconta criada, nenhuma cobrança, nenhuma transferência, nenhuma credencial de
> produção usada, nenhum segredo gravado em arquivo versionado. O cartão online nasce **desligado**.

## 1. O que o cliente vê

1. No checkout aparece a forma **"Cartão online"** (só se o dono a ligou). Ela é **diferente** do "Cartão" que já existia, que continua sendo pago na maquininha, na entrega/retirada.
2. O resumo do pedido mostra **Subtotal · Entrega · Taxa do cartão · Total**. Os valores mudam **na hora** quando o cliente troca a quantidade, tira ou põe itens, escolhe
   entrega ou retirada, ou muda a forma de pagamento. No **Pix** e nas formas pagas na entrega **não há taxa**.
3. Antes de confirmar, o cliente lê um aviso: o valor da taxa, o total que já a inclui e a frase "Você será cobrado(a) R$ X no cartão de crédito, à vista, com a taxa do cartão de R$ Y incluída".
   O botão também mostra o total com a taxa. O **e-mail é obrigatório** nesta forma (a ValidaPay exige o e-mail do pagador).
4. Ao finalizar, o pedido é criado **aguardando pagamento** (estoque reservado, a loja ainda não o vê como novo) e o navegador abre a tela **`/pagar/<código do pedido>`**: número do
   cartão, nome, validade, código de segurança, CPF/CNPJ de quem paga e e-mail, ao lado do resumo com a taxa e o total.
5. O cartão é trocado por um **token direto no navegador, com a ValidaPay**. A loja recebe só o token, o identificador do dispositivo e o CPF/CNPJ. **Número e CVV nunca passam
   pelo servidor da loja**, não são guardados (nem no navegador), não vão para log nem para o banco, e somem da tela assim que viram token.
6. **Aprovado** → "Pagamento aprovado!" e o pedido vai para a loja. **Recusado** → "O cartão não foi aprovado. Confira os dados ou use outro cartão." (sem o texto técnico da operadora) e dá para
   tentar de novo, com outro cartão ou o mesmo. **Em análise / sem resposta** → a tela espera sozinha e **não deixa pagar de novo**. Recarregar, voltar à página ou clicar de novo nunca cobra duas vezes.

## 2. A conta da taxa

```
total = arredondar( (subtotal + tarifa fixa) ÷ (1 − percentual) )        taxa do cliente = total − subtotal
```

Tudo em **centavos inteiros** (sem ponto flutuante); metade do centavo arredonda **para cima**. O "subtotal" aqui é tudo o que vai no cartão: **itens (já com a promoção do produto) + entrega**.
Com 5,37% e R$ 0,37:

| Pedido | Taxa do cartão | Total no cartão | Depois da tarifa da operadora sobra |
| --- | --- | --- | --- |
| R$ 10,00 | R$ 0,96 | **R$ 10,96** | R$ 10,00 |
| R$ 50,00 | R$ 3,23 | R$ 53,23 | R$ 50,00 |
| **R$ 100,00** | **R$ 6,07** | **R$ 106,07** | R$ 100,00 |
| R$ 100,00 + R$ 5,00 de entrega | R$ 6,35 | R$ 111,35 | R$ 105,00 |

> **O exemplo "R$ 106,70" do pedido original não bate com a fórmula.** Cobrando R$ 106,70 a ValidaPay ficaria com 5,37% de 106,70 + R$ 0,37 = R$ 6,10 e sobrariam **R$ 100,60**, não R$ 100,00.
> A fórmula pedida dá **R$ 106,07** (R$ 6,07 de taxa), que é o que o sistema usa. (Provado em `tests/unit/cardfee.test.mjs`.)

**Diferença de 1 centavo.** A loja arredonda o total ao centavo; a ValidaPay arredonda a parte percentual da tarifa do jeito dela (a documentação não diz como). Por isso a tarifa que ela informa
pode diferir em **até R$ 0,01** da taxa cobrada do cliente, e o líquido pode sobrar/faltar R$ 0,01 (medido: sempre dentro de ±1 centavo, `tests/unit/cardfee.test.mjs`). Até 1 centavo é aceito sem alarme;
**mais que isso** marca o pagamento como "precisa de conferência" no painel, com os dois valores (e o pedido continua liberado, porque o cliente pagou o valor certo).

**Quem calcula é o banco.** A função `card_fee_cents()` (migration 0020) é chamada por `create_order`; o navegador só faz a mesma conta para mostrar o resumo (`src/lib/cardFee.ts`) e manda o total que a pessoa viu
(`expected_total`). Se o servidor chega a outro total (preço, promoção, entrega ou taxa mudou) o pedido **não é criado** (409 `price_changed`) e o site mostra o novo valor para a pessoa confirmar.
O total gravado em `orders.total` = subtotal + entrega − desconto + taxa (restrição do banco). A **cobrança** na ValidaPay usa o total do pedido gravado no banco, nunca um valor do navegador.

### Taxa configurável (não está no navegador nem no código)

- Percentual e tarifa fixa ficam no banco (`payment_fee_settings`) e só o **owner** os muda, em **Pagamentos → Cartão de crédito online** (limites: percentual 0–25%, tarifa fixa R$ 0–10,00; validados no servidor **e** no banco).
- Os **valores de referência (5,37% + R$ 0,37) são os do pedido da loja; não foram confirmados em nenhum documento da ValidaPay.** Por isso o cartão online **só liga depois que o owner marca "Conferi estes valores no
  contrato ou painel da ValidaPay"** (fica registrado quem e quando). Qualquer mudança de valor, até por fora da API, **tira a conferência** (gatilho no banco) e o cartão some do site até conferir de novo.
- O site recebe percentual e tarifa só para montar o resumo; o pedido grava, em cada pedido, o **percentual e a tarifa usados** e a **taxa cobrada** (auditoria). Pedidos antigos não são tocados.
- **Se a ValidaPay já repassar a mesma taxa ao cliente por conta própria, não ligue as duas coisas** (o cliente pagaria duas vezes). A loja envia `passFeesToCustomer: false` (a opção da ValidaPay, segundo a documentação,
  só repassa a taxa do **parcelamento**), e compara a tarifa que a ValidaPay informa com a taxa que cobrou do cliente: se a ValidaPay passar a descontar menos, o painel acusa "o cliente pagou R$ X a mais".

## 3. Como funciona por dentro (resumo técnico)

| Parte | Como |
| --- | --- |
| Cobrança | `POST /v1/charges` com `paymentMethod: "creditcard"`, `amount` em **reais** (o total do banco), `cardToken` e `deviceId` (gerados no navegador), `customer` (nome, e-mail, CPF/CNPJ, telefone E.164), `installments: 1`, `passFeesToCustomer: false`, `externalId` = id da tentativa. Só no servidor. Credenciais só em variáveis de ambiente. |
| Idempotência | `externalId` = id da tentativa da loja. A ValidaPay recusa o mesmo `externalId` com `409 DUPLICATE_CHARGE` e devolve o `chargeId` original em `error.details.chargeId`: a loja **adota** essa cobrança e confere o resultado. Uma tentativa em andamento **nunca** é substituída por outra; refazê-la reaproveita o mesmo `externalId`. Dois cliques simultâneos: o banco trava o pedido (uma só passa, a outra recebe "em andamento"). |
| Confirmação | **Só a consulta à ValidaPay** (`GET /v1/charges/{id}/status` e `/{id}`) libera o pedido, na mesma transação do banco, **conferindo que o valor pago é igual ao cobrado**. A resposta da criação sozinha não libera nada. Voltar à página de sucesso, recarregar ou o navegador dizer "pago" não muda nada. |
| Webhook | `POST /api/payments/webhook`: assinatura HMAC (`X-Webhook-Signature`) conferida **antes** de gravar qualquer coisa; deduplicado por `X-Webhook-Id`; o aviso só diz "olhe a cobrança X": o estado vem da consulta à ValidaPay. Aviso repetido/atrasado/fora de ordem não duplica pedido nem repasse. |
| Valor diferente | Valor pago ≠ valor cobrado: **não libera**, marca o pagamento para conferência. Tarifa diferente da taxa cobrada do cliente (> R$ 0,01): libera e **sinaliza**. |
| Falhas | Recusa do banco (402): tentativa encerrada como "falhou", cliente pode tentar de novo (até 5 tentativas por pedido). Erro definitivo da ValidaPay (token vencido, dado inválido, credencial): "falhou", sem cobrança. **Sem resposta/erro 5xx/conexão perdida**: a tentativa **continua aberta** ("cartão sem confirmação"), nunca vira "recusado" nem é encerrada às cegas; passados 5 min é sinalizada ao dono; passados 30 min é encerrada **sinalizada** ("confira na ValidaPay se o cartão foi cobrado; se foi, estorne"). Pendente há mais de 1 hora: sinalizado. |
| Pedido | Nasce `awaiting_payment`; sem pagamento a tempo é cancelado e o estoque volta uma vez só (mesmo mecanismo do Pix). O pedido de cartão **não pode** gerar Pix e o de Pix não paga no cartão (trava no banco). |
| Tela `/pagar` | Página à parte, aberta por carregamento completo. O SDK da ValidaPay (`@validapay/tokenize@1.3.1`, versão fixa, MIT, sem dependências, as 156 linhas lidas por inteiro antes de instalar; só a entrada `/browser` é usada: a entrada de servidor do pacote, que receberia o cartão no servidor, **não** é usada) só é baixado ali. A CSP do `vercel.json` é **mais restrita no resto do site**: só `/pagar/*` permite `https://*.online-metrix.net` (antifraude da ValidaPay: script e iframe) e as APIs `api`/`sandbox.validapay.com.br` (conexão). Sem cache, sem referrer, fora do Google. |
| Painel | **Pagamentos**: bloco "Cartão de crédito online" (liga/desliga, o que falta, taxa com exemplos ao vivo, conferência), lista de cobranças com taxa do cliente/tarifa/líquido, cobranças que pedem conferência. **Pedido**: subtotal, entrega, desconto, taxa, total, valor cobrado, tarifa da operadora, líquido, código da cobrança e tentativas (owner); o **atendente** vê a taxa que o cliente pagou, mas não o percentual, a tarifa nem códigos. |
| E-mails | O e-mail de pedido mostra a linha "Taxa do cartão" quando existe, e o pedido de cartão só dispara os e-mails de "pago" depois da confirmação. |

## 4. Banco de dados (migration `0020_card_online.sql`)

Aditiva: nada existente é removido nem reescrito, os pedidos antigos continuam válidos.
Aplicada **só** pelo `vercel-build` em deploy de **produção** (como as anteriores); em preview e em testes ela roda contra bancos de teste.

- `payment_methods`: aceita `card_online` (nasce **desligado**). `is_online_payment()` passa a incluir o cartão online.
- `payment_fee_settings` (1 linha): percentual (pontos-base, 0–2500) e tarifa fixa (centavos, 0–1000), quem/quando conferiu; gatilho que **tira a conferência** quando o valor muda.
- `card_fee_cents(base, bps, fixa)`: a conta em inteiros (metade para cima).
- `orders`: `payment_fee`, `payment_fee_bps`, `payment_fee_fixed` (default 0/nulo, então os pedidos antigos ficam iguais) e a restrição "pedido de cartão online: total = subtotal + entrega − desconto + taxa; qualquer outro: taxa 0".
- `payments`: aceita `method = 'card'`; novas colunas `customer_fee_cents` (a taxa que está dentro do valor cobrado), `last_attempt_at`, `card_attempts`.
- `create_order` e `order_json` atualizados (cartão online exige taxa conferida e e-mail; devolve `payment_fee`; `price_changed` inclui a taxa).
- Funções novas: `payment_begin_card`, `payment_card_mark_charge`, `payment_card_stale`.
- `payment_begin` (Pix) ganhou uma trava: **só pedido de Pix online gera Pix** (sem ela, um pedido de cartão poderia ser pago por Pix, com o total do cartão e comissão).
- **Reverter**: desligue "Cartão online" em *Pagamentos* (o site deixa de oferecê-lo na hora). Não há remoção de coluna/tabela.

## 5. Variáveis de ambiente (nomes; **nunca** valores neste repositório)

| Variável | Para quê | Onde se obtém |
| --- | --- | --- |
| `VALIDAPAY_ENV` | `sandbox` (testes) ou `production` | você escolhe |
| `VALIDAPAY_CLIENT_ID`, `VALIDAPAY_CLIENT_SECRET` | OAuth da API | ValidaPay → **Integração → API** (de sandbox e de produção, são diferentes) |
| `VALIDAPAY_WEBHOOK_SECRET` (e `VALIDAPAY_WEBHOOK_TOKEN`, opcional) | assinatura dos avisos | ValidaPay → **Integração → Webhooks** |
| **`VALIDAPAY_PUBLIC_ID`** (novo) | o **Id Público** que o navegador usa para gerar o token do cartão; **não é segredo** | ValidaPay → **Gerenciamento → Minha Conta → Id Público** |
| **`VALIDAPAY_CARD_ACCOUNT`** (novo, opcional) | `merchant` (padrão: a cobrança nasce na subconta do estabelecimento, com `X-Sub-Account`) ou `master` | veja "Limitações" |

Na Vercel: *Settings → Environment Variables* (sem prefixo `VITE_`). Sem `VALIDAPAY_PUBLIC_ID` o painel mostra o **nome** da variável como faltante e o cartão online não liga.
O webhook deve assinar também `payment.success` e `payment.failed` (já usados no Pix); o cartão usa os mesmos.

## 6. Teste no SANDBOX (obrigatório antes de qualquer cartão real)

Pré-requisitos: o Pix já funcionando no sandbox (conta do estabelecimento aprovada; veja `PAGAMENTO-ONLINE.md`). **Use só um deploy de teste (preview) com `VALIDAPAY_ENV=sandbox`**; a produção da ValidaPay nunca vale em preview.

1. Defina `VALIDAPAY_PUBLIC_ID` (Id Público da conta **de sandbox**) e faça um deploy de teste. *Pagamentos → Cartão de crédito online* deve listar só "taxa do cartão conferida" como pendência.
2. **Confira os valores da taxa no contrato/painel da ValidaPay** (percentual, tarifa fixa e prazo de recebimento do seu plano). Ajuste se forem outros, marque "Conferi…" e salve. Ligue "Cartão online no site".
3. Faça um pedido com o cartão **`4111 1111 1111 1111`** (qualquer validade futura/CVV; **aprovado**). Confira: total = subtotal + taxa; a tela `/pagar` abriu **sem erro de CSP** (console do navegador; a loja registra violações em `/api/csp-report`
   → logs da Vercel: se o antifraude ou o SDK forem bloqueados, anote o endereço bloqueado e ajuste o `vercel.json`); o pedido virou "novo"; no painel o pagamento mostra **valor cobrado = total**, tarifa e líquido.
   **Compare a tarifa da ValidaPay com a taxa cobrada do cliente** (devem ficar a no máximo R$ 0,01).
4. Cartões de teste recusados do sandbox (documentação): `4000000000000002` (recusado), `…004` (saldo insuficiente), `…006` (cartão expirado), `…008` (CVV inválido), `…010` (suspeita de fraude). Cada um deve mostrar "O cartão não foi aprovado" e permitir tentar de novo.
5. Confira o que a documentação **não** confirma (lista na seção 8): a cobrança do cartão aceita `X-Sub-Account`? (se a ValidaPay recusar, defina `VALIDAPAY_CARD_ACCOUNT=master` e refaça); o detalhe da cobrança traz `fee`, `netAmount` e `paidAmount`?; o webhook `payment.success` chega
   para o cartão e é aceito (200)?; `deviceId` chega como UUID.
6. Teste uma queda: pague e, antes da resposta, recarregue a página → a tela deve mostrar "processando", sem formulário e sem nova cobrança.
7. Anote tudo o que for diferente do documentado e ajuste `server/payments/validapay.ts` (mudança pequena e localizada) antes de seguir.

## 7. Ativação em produção (só depois de tudo acima conferido)

1. Autorização **explícita** do proprietário para publicar a migration `0020` (ela altera o banco de produção no deploy).
2. Credenciais **de produção** só no ambiente *Production* da Vercel (`VALIDAPAY_ENV=production`, `VALIDAPAY_PUBLIC_ID` da conta real, as demais). Conta do estabelecimento real aprovada, com a ciência das tarifas registrada.
3. Conferir de novo, no contrato real, percentual, tarifa fixa e o prazo (D+1 ou o da sua habilitação); salvar com "Conferi…". Ligar o cartão online.
4. Primeiro pedido real **de valor baixo**, por você mesmo; confira pedido, taxa, tarifa e líquido na ValidaPay. Só então divulgue.
5. Mantenha o painel *Pagamentos → Só os que pedem conferência* na rotina: é onde caem tarifa diferente, valor diferente, "sem resposta" e disputas.

## 8. Limitações e o que a documentação não confirma

| Ponto | O que a loja faz / o que falta |
| --- | --- |
| Percentual e tarifa do cartão, **prazo D+1** | **Não aparecem na documentação da API** (são do contrato/plano da conta). A loja não calcula nem mostra prazos; as taxas são configuradas pelo owner e precisam ser conferidas. |
| `passFeesToCustomer` | Segundo a documentação, só repassa a taxa do **parcelamento**. A loja envia `false`; a taxa do cartão é somada ao `amount`. |
| Parcelamento | **Não implementado** (só à vista). Só deve ser feito depois de confirmar as tarifas por parcela. |
| Divisão (split) no cartão | **Não existe na documentação** (só no Pix). O cartão online não tem a comissão de 2%. |
| `X-Sub-Account` em `POST /v1/charges` | **Não confirmado** para o cartão. Padrão: enviado (`VALIDAPAY_CARD_ACCOUNT=merchant`); alternativa: `master`. |
| 3DS | **Desligado** (opcional na documentação; pede telefone e endereço). Sem 3DS, o risco de chargeback por fraude fica com a conta (aviso da própria documentação). |
| `metadata` na cobrança do cartão | A ValidaPay **não grava** nesta rota; a ligação com o pedido é o `externalId`/`chargeId`. Se a resposta da criação se perder e o cliente **nunca** tentar de novo, o aviso `payment.success` não tem como achar o pedido: a tentativa fica sinalizada ("sem resposta", em 5 min) para o dono conferir na ValidaPay. |
| Reembolso do cartão | A API tem `POST /v1/wallet/refunds`, mas o adaptador **nunca** pede o escopo `wallet/write`: estorno é manual, pelo painel da ValidaPay. A loja registra o que a ValidaPay informar. |
| Taxa do cartão e o Código de Defesa do Consumidor | A taxa é mostrada em reais **antes** da confirmação, em linha própria no resumo, no aviso e no botão (sem taxa escondida) e o cliente tem Pix e pagamento na entrega sem taxa. **Confirme com seu contador/advogado** se repassar a taxa do cartão é adequado ao seu caso: esta documentação não é parecer jurídico. |
| Faturamento nos relatórios | O dashboard e os relatórios somam o **total do pedido**, que no cartão online **inclui a taxa do cartão** (que a ValidaPay desconta). O valor líquido de cada cobrança está em *Pagamentos* e no detalhe do pedido. Nada nos relatórios foi alterado (decisão de preservar o que já existe); se quiser o faturamento sem a taxa, é um ajuste à parte. |
| Cupom | A loja **não tem sistema de cupom**; o desconto que existe é a **promoção do produto**, que já entra no subtotal antes da taxa. |
| Pagar um pedido de cartão pelo "Meus pedidos" | A tela `/pagar` usa o código de acompanhamento do pedido (que o cliente recebe ao finalizar); a rota do servidor para a conta existe, mas a tela de "Meus pedidos" não abre o cartão. |
| Antifraude (`online-metrix.net`) | Só carrega em `/pagar`. Se a CSP bloquear algum recurso dele no sandbox, a análise antifraude fica prejudicada (o pagamento em si não depende do script). **A confirmar no sandbox.** |

## 9. Testes e resultados

Ver a seção **10. Resultados** no fim deste arquivo (números da última execução completa).

Os **12 cenários obrigatórios** e onde cada um é provado:

| # | Cenário | Prova |
| --- | --- | --- |
| 1 | R$ 10 no cartão (R$ 10,96) | `api-test22` §2 · `cardfee.test.mjs` · `e2e-card` §3 |
| 2 | R$ 100 no cartão (R$ 106,07; cobrado e gravado iguais) | `api-test22` §2 e §4 · `e2e-card` §3–§4 |
| 3 | R$ 100 no Pix, sem taxa | `api-test22` §2 e §14 · `e2e-card` §3 (trocar para Pix tira a taxa) |
| 4 | Mudança de quantidade (recalculada no servidor) | `api-test22` §5 · `e2e-card` §3 (resumo ao vivo) |
| 5 | Desconto (promoção do produto; a loja não tem cupom) | `api-test22` §6 |
| 6 | Recusa/falha (5 cartões de teste, token vencido, credencial, OAuth) | `api-test22` §7 · `e2e-card` §5 |
| 7 | Pendente (a tela espera; só o servidor aprova) | `api-test22` §8 · `e2e-card` §8 |
| 8 | Aviso (webhook) duplicado/forjado | `api-test22` §9 |
| 9 | Valor adulterado no navegador | `api-test22` §10 · `e2e-card` (o navegador nunca manda valor) |
| 10 | Clique repetido (4 simultâneos = 1 cobrança) | `api-test22` §11 · `e2e-card` §6 |
| 11 | Recarregar durante o pagamento / resposta perdida | `api-test22` §12 · `e2e-card` §7 |
| 12 | Valor esperado × valor da operadora diferentes | `api-test22` §13 |

## 10. Resultados

Última execução completa (build, tipos, unitários, 23 suítes de API e 13 arquivos de navegador), tudo contra bancos de teste locais, o servidor ValidaPay **falso** e o SDK com as chamadas
interceptadas; **nenhum serviço real** foi acionado:

| Camada | Resultado |
| --- | --- |
| `npm run build` e `tsc -b` | sem erros |
| Unitários (`npm run test:unit`) | **212 de 212** (inclui `cardfee` 9, `cardinput` 4 e os 8 novos do adaptador no cartão e na renovação do token) |
| `api-test22` (cartão: os 12 cenários, segurança, cabeçalhos) | **166 verificações, 0 falhas** |
| Demais suítes de API (`api-test` a `api-test21`) | todas **OK** (incluindo a migração de dados antigos de `api-test14`, 200 verificações, e o "pedir de novo" de combos de `api-test16`, 133) |
| `e2e-card` (navegador, celular e computador) | **145 verificações, 0 falhas**, sem erro de console nem violação de CSP |
| Demais arquivos de navegador (`e2e`, `e2e-track`, `e2e-pix`, `e2e-account`…) | todos **OK** |

**Defeitos que a bateria completa pegou durante o desenvolvimento e já foram corrigidos** (ficam registrados porque mostram o valor de rodar tudo, e não só os testes novos):

- `order_json` na migration 0020 tinha perdido `swap_to_product_id` (quebraria "pedir de novo" de combos com troca de energético): restaurado.
- A conferência periódica não lia a coluna `method` das cobranças e, por isso, poderia encerrar às cegas um cartão "sem resposta": corrigido e coberto por teste.
- O Pix (`payment_begin`) aceitava qualquer pedido "online", inclusive o de cartão: agora só pedido de Pix online gera Pix.
- A restrição `orders_payment_fee_total` deixava zerar a taxa de um pedido de cartão mantendo o total: agora o total tem de ser exatamente a soma das partes.
- O adaptador não renovava um token OAuth recusado com 401: agora pede outro e repete uma única vez.

**O que estes números NÃO provam:** que a ValidaPay de verdade se comporta como o servidor falso, que 5,37% + R$ 0,37 é o contrato, que a CSP deixa o antifraude da ValidaPay funcionar, nem que a cobrança do cartão aceita `X-Sub-Account`.
Tudo isso depende do teste no sandbox (seção 6) e de credenciais que este ambiente não tem.
