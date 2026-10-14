# Pagamento online (Pix) com a ValidaPay — o que existe, o que falta e como ligar

> **Cartão de crédito online (com a taxa do cartão repassada ao cliente): veja [`CARTAO-ONLINE.md`](CARTAO-ONLINE.md).** Este arquivo continua sendo o guia do **Pix**.
>
> **Estado: o Pix online com a ValidaPay está escrito e testado, mas NUNCA foi testado de verdade contra a ValidaPay.**
> O adaptador (`server/payments/validapay.ts`) foi escrito **só** a partir da documentação oficial da ValidaPay (lida pelo servidor MCP da
> própria ValidaPay em 11/10/2026). Os testes automáticos usam um **servidor ValidaPay FALSO** (`tests/validapay-fake.mjs`) que segue essa
> documentação e recusa o que foge dela; ele prova a lógica da loja e do adaptador, **não** que a ValidaPay de verdade responde assim.
> **Nenhuma cobrança, subconta, transferência ou chamada à ValidaPay (sandbox ou produção) foi feita.** O próximo passo é um teste no
> **sandbox** da ValidaPay (veja "Ligar" abaixo). O cartão online existe à parte (migration 0020) e também **nunca** foi testado na ValidaPay de verdade.

## Resumo

| Parte | Estado |
| --- | --- |
| Banco (`0014_online_payments.sql`, `0015_merchant_account_flow.sql`, `0016_commission_2_percent.sql`) | tabelas `merchant_accounts` (conta/subconta), `payments` (cobranças, em centavos) e `payment_events` (avisos); pedido `awaiting_payment`; meio `pix_online` (nasce **desligado**); funções que criam a cobrança sem duplicar, aplicam o que a operadora informou sem repetir nem regredir e cancelam o que não foi pago; um cadastro de conta ativo por operadora |
| Adaptador da ValidaPay (`server/payments/validapay.ts`) | OAuth, Pix com divisão fixa para a conta master, consulta, **cancelamento**, avisos assinados (HMAC), contas e propostas. Só liga com as variáveis de ambiente (abaixo) |
| Servidor (`server/payments/*`, `server/routes/payments.ts`) | criação do Pix, consulta, webhook, conferência periódica, cancelamento do Pix vencido, rotas do cliente, da conta e do painel |
| Site | "Pix online" no checkout (só aparece ligado), tela do Pix (QR Code, copia e cola, contagem, "já paguei"), confirmação sem recarregar, Pix vencido com nova tentativa, pagar também por "Meus pedidos" |
| Painel | página **Pagamentos** (só owner): operadora e ambiente, **conta do estabelecimento (vincular uma existente ou cadastrar uma nova)**, comissão calculada × efetivada, cobranças, pendências, "Atualizar pagamento", "Conferir agora" |

## O que NÃO existe

- **3DS** no cartão online (`@validapay/3ds`) e **parcelamento**: o cartão online é só à vista e sem 3DS (veja [`CARTAO-ONLINE.md`](CARTAO-ONLINE.md)). A
  documentação da ValidaPay também **não** mostra divisão (split) para cobrança no cartão, então não há a taxa de serviço do Pix (5%) no cartão online.
- **Estorno/devolução pela API**: o sistema **registra** a devolução que a ValidaPay informar (consulta de `GET /v1/wallet/refunds` e avisos
  `refund.*`); devolver o dinheiro continua manual, pelo painel da ValidaPay (o adaptador nunca pede o escopo `wallet/write`).
- **Teste no sandbox ou na produção da ValidaPay**: nunca foi feito. Tudo que depende de como a ValidaPay realmente se comporta está listado em
  "O que a documentação não confirma".

## Como o pagamento funciona

```
checkout (Pix online) ──► POST /api/orders ──► pedido "aguardando pagamento" (estoque reservado, a loja NÃO vê como novo)
        │
        ▼
página do pedido ──► POST /api/tracking/:código/payment   (ou /api/account/orders/:nº/payment)
        │               └─ payment_begin (trava o pedido; 1 cobrança em aberto por pedido; valor e comissão saem do total do BANCO)
        │               └─ ValidaPay: POST /v1/charges/pix na SUBCONTA do estabelecimento (X-Sub-Account) com `split` fixo para a master
        ▼
cliente paga no banco ──► ValidaPay ──► POST /api/payments/webhook   (payment.success, assinado)
        │                         └─ 1) assinatura HMAC e idade  2) aviso já visto? ignora  3) CONSULTA a cobrança na ValidaPay
        │                            4) payment_apply: valor igual? → "pago" + pedido "novo" na MESMA transação
        ▼
a página consulta o servidor a cada 4 s e mostra "Pagamento confirmado!"; o painel avisa "pedido novo (Pix pago)"
```

### O que a loja manda à ValidaPay (conforme a documentação)

- `POST /v1/charges/pix` com o cabeçalho `X-Sub-Account: <conta do estabelecimento>` e o corpo
  `{ "amount": 25.00, "paymentMethod": "pix", "externalTxid": "copo-cheio-site", "metadata": { "paymentId": "<id da loja>", "orderNumber": 1005 }, "split": [{ "type": "fixed", "amount": 1.25 }] }`.
  Valores **em reais** (nunca centavos). O `split` **sem `accountNumber`** é a divisão para a **conta master** ("Split para Conta Master" na
  documentação). A comissão vai como valor **fixo** (e não percentual) para a conta da ValidaPay ser exatamente a do banco da loja.
- Esta rota **não tem idempotência** (o `externalId` é descartado): quem evita duplicidade é a loja (uma cobrança em aberto por pedido, no
  banco). O `metadata.paymentId` volta no aviso `payment.success` e é como a loja reconhece até uma cobrança cuja resposta de criação se perdeu.
- Consulta: `GET /v1/charges/{id}/status` (leve) e, se paga, `GET /v1/charges/{id}` (taxa, líquido e valor pago).
- **Cancelamento**: `DELETE /v1/charges/{id}`. A documentação diz que o QR Code deixa de aceitar pagamento. A validade de um Pix imediato
  **não é configurável em minutos**; por isso a loja usa a sua própria (15 min) e, quando vence, **confere (pode ter sido pago agora), cancela na
  ValidaPay e só então encerra**. Pagar no mesmo instante do cancelamento é tratado como pagamento (a ValidaPay recusa cancelar o que já está pago).
- Autenticação: OAuth2 `client_credentials` (`POST /auth/token`, um token por escopo, 1 h). Escopos usados:
  `charges/write`, `charges/read`, `wallet/read` (extrato da master e devoluções), `subaccounts/read` e `proposals/write`.
  **Não** use `wallet/write` nessa credencial (ele libera transferências).

### Regras que o banco garante

- **Valor e comissão nascem no banco**, do total que o próprio banco calculou para o pedido. O navegador não manda (nem consegue mudar) valor,
  total, desconto ou comissão.
- **Taxa de serviço do Pix: 5%** (migration `0020`), dividida em **2,5% pagos pelo cliente** e **2,5% pagos pelo estabelecimento**; os 5% vão inteiros para a
  conta master. A base é **itens + entrega − descontos** (o total do pedido antes da taxa), em centavos, e o dinheiro é sempre exato:
  - `service_fee_cents(base, bps) = floor((base × bps + 5000) ÷ 10000)` (metade para cima), calculada no **banco**; o TypeScript (`serviceFeeCents`) é o mesmo
    cálculo só para mostrar o total antes de o cliente confirmar, e um teste compara os dois.
  - **Cliente**: a taxa dele (2,5% da base) é somada ao total do pedido (`orders.payment_fee`, `payment_fee_bps`) e aparece como **"Taxa de serviço do Pix"** no
    checkout, no acompanhamento, no pedido do painel e no e-mail. Mudou o valor entre abrir o checkout e confirmar? O pedido é recusado com os valores novos (409), como no cartão.
  - **Divisão (split)**: a comissão enviada à conta master é a taxa total (5%) calculada **uma só vez** sobre a base (`service_fee_cents(base, 500)`), e não duas
    metades arredondadas separadamente. A parte do estabelecimento é `comissão − taxa do cliente`; a subconta fica com `valor cobrado − comissão`.
  - Exemplo, pedido de R$ 100,00 (itens + entrega): o cliente paga **R$ 102,50**; a master recebe **R$ 5,00**; a subconta do estabelecimento fica com **R$ 97,50**.
    Pedido de R$ 25,00: o cliente paga R$ 25,63 (taxa de R$ 0,63), a master recebe R$ 1,25 e a subconta fica com R$ 24,38.
  - Os percentuais (2,5% e 2,5%) ficam em `payment_fee_settings` (`pix_customer_fee_bps`, `pix_store_fee_bps`, de 0 a 10% cada). Cada pedido e cada cobrança guardam o
    percentual e o valor de quando nasceram: mudar o percentual afeta só os pedidos novos.
  - **Pedidos antigos não mudam**: um pedido de Pix online feito **antes** da migration `0020` (sem `payment_fee_bps`) continua com o total de antes e a **comissão de 2%**
    (`payment_commission_bps() = 200`, migration `0016`) sobre o total; o mesmo vale para as cobranças já criadas.
  - O **cartão online não tem essa taxa**: segue só com a taxa do cartão, sem split.
  Na **tela** do painel o nome é **"Taxa"** (e não "comissão"); no código, no banco e neste documento continua `commission_*` / "comissão".
- **Só "efetivada" com evidência**: `commission_state = 'confirmed'` exige o valor que a ValidaPay confirmou ter repassado e a cobrança paga
  (restrição `payments_commission_evidence`). A loja só considera o repasse confirmado se o **extrato da conta master** mostrar um **crédito
  ligado a esta cobrança** (mesmo `chargeId`); sem isso a comissão fica "calculada" (e a conciliação posterior, com "Atualizar pagamento",
  ainda pode confirmá-la). Comissão efetivada com valor diferente do calculado sinaliza a cobrança.
- **Pago só com o valor certo**: valor pago diferente do da cobrança não libera o pedido; a cobrança fica sinalizada.
- **Uma cobrança em aberto por pedido** (índice único): cliques repetidos, recarregar a página e requisições simultâneas dão a mesma cobrança.
  No máximo 5 tentativas por pedido.
- **Sem regressão e sem repetição**: a ordem dos status é criando < aguardando < vencido/cancelado/recusado < pago < estornado. Aviso
  repetido, atrasado, fora de ordem, ou aviso da subconta e da conta master para a mesma cobrança não duplicam pedido nem comissão.
- **Pago depois do cancelamento ou em duplicidade**: o dinheiro é registrado, o pedido **não reabre** e a cobrança fica sinalizada para o dono
  devolver o valor. **Disputa ou chargeback** informados pela ValidaPay também sinalizam a cobrança (continua "paga").
- **Pagamento online não se altera à mão**: o painel não oferece "marcar como pago" e o banco recusa.
- **Estoque**: reservado ao criar o pedido; devolvido (uma vez só) se o pedido não for pago a tempo ou for cancelado.

### Prazos

| O quê | Prazo |
| --- | --- |
| Validade do Pix | 15 minutos (da loja; ao vencer, a cobrança é cancelada na ValidaPay) |
| Nova tentativa depois de um Pix vencido | até 10 minutos depois da última tentativa; depois o pedido é cancelado e o estoque volta |
| Pedido em que ninguém gerou o Pix (página fechada) | cancelado depois de 30 minutos |
| Resposta da ValidaPay ao criar a cobrança | 6 s por chamada (8 s no total); sem resposta: erro claro, tentativa sinalizada e nova tentativa liberada |
| Consulta feita por causa de um aviso | 4 s (a ValidaPay espera a resposta do aviso por 5 s; se estourar, ela reenvia) |
| Cobrança vencida que a ValidaPay não deixa cancelar (fora do ar) | continua em aberto e é tentada de novo; depois de 30 minutos é encerrada **e sinalizada** |

Não há agendador: a conferência (`sweep`) roda de passagem quando o painel está aberto (consultando a ValidaPay), quando entra pedido novo e quando o
cliente consulta o pagamento (a tela do cliente cancela e encerra o próprio Pix vencido na hora). Sem ninguém usando o site, o que venceu fica
como está até a próxima visita. Dá para forçar em **Pagamentos → Conferir agora**. (Um *cron* chamando essa conferência a cada poucos minutos é
um bom reforço se o plano da Vercel permitir; não foi configurado.)

## Segurança

- Credenciais e segredos **só no servidor** (variáveis de ambiente da Vercel); nunca em `VITE_*`, nunca no navegador, nunca em arquivo versionado.
  O código não registra Pix, códigos de cobrança completos, tokens, segredos nem dados do pagador ou do titular da conta (há testes que conferem
  o log do servidor). O painel só mostra o **nome** das variáveis que faltam, nunca valores.
- **Webhook** (`POST /api/payments/webhook`, rota pública): **nada é gravado antes de a assinatura ser conferida** — `X-Webhook-Signature`
  `t=<ms>,v1=<hex>`, com `v1 = HMAC-SHA256(segredo, "<t>.<corpo bruto>")`, comparação em tempo constante e **janela de 5 minutos** (assinatura
  antiga ou do futuro é recusada); opcionalmente o token estático `x-access-token`. Corpo limitado a 256 KB e 100 avisos por chamada. Erro de
  autenticidade responde 401 sem detalhes; se a consulta à ValidaPay falhar, responde 503 (ela reenvia por até 72 h com `X-Webhook-Id` igual) e o aviso fica
  "não processado" para a próxima entrega. A deduplicação é pelo `X-Webhook-Id`.
- **Confirmação por canal confiável**: aviso verificado **e** consulta da cobrança na ValidaPay. O corpo do aviso sozinho nunca confirma dinheiro.
  Ver o QR Code, voltar a uma página de sucesso ou tocar em "Já paguei" **nunca** confirma nada.
- **Produção protegida**: `VALIDAPAY_ENV=production` só vale no deploy de **produção** da Vercel (nos deploys de teste ela é recusada, para um
  preview nunca criar cobrança ou subconta de verdade). Sandbox e produção são "operadoras" diferentes no banco (`validapay-sandbox` e
  `validapay`): conta, cobranças e avisos de testes nunca se misturam com os de produção.
- **Quem vê o quê**: o cliente só vê o pagamento do próprio pedido (código de acompanhamento ou a própria conta; erro igual para pedido
  inexistente e de outra pessoa). Ele vê a **própria** taxa de serviço (R$ 0,63, por exemplo) como linha do pedido, mas nunca a comissão da loja, a parte do estabelecimento, tarifas, subconta ou código da operadora. Atendente (admin) vê a situação do pagamento;
  **só o owner** vê comissão, tarifas, códigos, a página Pagamentos, gerencia a conta do estabelecimento e liga/desliga o Pix online.
- Limites: 30 tentativas de gerar Pix a cada 10 minutos por rede; cadastro de conta limitado a 8 por hora por rede.
- CSP e `Permissions-Policy` **não foram alterados** (o QR Code é desenhado no próprio site; não há script de terceiros). O cartão com SDK exigiria liberar
  endereços do SDK **só** em `/checkout` (e a documentação não os lista).

## A conta (subconta) do estabelecimento

A comissão só pode ser repassada se a cobrança nascer na **subconta** do estabelecimento (a ValidaPay divide para a master). Em **Pagamentos →
Conta do estabelecimento** o **owner** escolhe entre:

1. **Vincular uma conta que já existe**: lista as contas que a **ValidaPay informa** (`GET /v1/accounts/subaccounts`, documento sempre mascarado) e só
   deixa vincular uma conta **CONFIRMADA** por ela.
2. **Cadastrar uma conta nova** (pessoa física ou jurídica): `POST /v1/proposals`. O formulário é conferido por inteiro antes de qualquer envio
   (CPF/CNPJ com dígito verificador, telefone E.164, data DD-MM-AAAA, códigos de renda/ocupação/patrimônio/faturamento da documentação). Formulário
   inválido **nunca** chega à ValidaPay (nem custa tarifa).

Regras (nada acontece sozinho):

- **Autorização do titular** é obrigatória nas duas ações (caixa marcada pelo owner, gravada com quem e quando). **Em produção, a ciência das tarifas**
  também (a **criação de cada subconta custa R$ 15,00**, debitados da conta master quando a proposta é enviada; **no sandbox não há cobrança**). As demais
  tarifas por cobrança **não** vêm da documentação: confira no seu contrato; a loja mostra, por cobrança paga, a tarifa que a ValidaPay informar.
- **Sem duplicar**: o banco só deixa **um cadastro ativo** por operadora e o cadastro é **reservado antes** de falar com a ValidaPay; cinco envios ao
  mesmo tempo viram uma só proposta. Se a ValidaPay **não responder**, a proposta **pode** ter sido criada (e cobrada): o cadastro fica "erro" e uma nova
  tentativa exige a confirmação explícita do dono. Reprovada, com erro ou duplicada, a conta deixa de ser ativa e dá para tentar de novo.
- **O identificador definitivo da subconta só entra com a confirmação oficial**: o aviso assinado `onboarding.create` com `status: CONFIRMED` e o
  número da conta (ou a conta aparecendo `CONFIRMED` na lista oficial, no vínculo). Avisos de **etapa** (`onboarding.proposal` aprovada,
  `backgroundcheck`, `documentscopy`) só atualizam o andamento; reprovação vira "Recusada". Aviso de proposta que a loja não conhece é só registrado.
- **Dados do titular não ficam aqui**: CPF, mãe, endereço, renda etc. vão direto para a ValidaPay; o banco guarda só o tipo (PF/PJ), o status, o
  identificador do formulário e o número da conta. O endereço de envio dos documentos (que a ValidaPay devolve) é mostrado e **não** guardado.
- O Pix online só liga com a conta **aprovada** (e, em produção, com a ciência das tarifas registrada).

## O que a documentação não confirma (e o comportamento seguro adotado)

| Dúvida | O que a loja faz |
| --- | --- |
| A consulta da cobrança de uma subconta exige `X-Sub-Account`? | envia o cabeçalho e, se a ValidaPay responder 404, tenta de novo sem ele |
| Como o repasse da comissão aparece (não há campo de split na consulta da cobrança)? | só marca "efetivada" se o extrato da master tiver um **crédito com o `chargeId` da cobrança**; senão fica "calculada" |
| Validade padrão de um Pix imediato | não depende dela: cancela a cobrança quando a validade da loja (15 min) acaba |
| Como a ValidaPay recusa uma subconta duplicada | qualquer 409 vira "duplicado" com a mensagem dela (saldo insuficiente da master tem tratamento próprio) |
| Valores de `ownerType` além de `SOCIO` | envia sempre `SOCIO` |
| Divergências da documentação (o exemplo PF traz `1DINP02`; o PJ aparece com nomes diferentes nas páginas) | envia os códigos do guia ("Subcontas: dados financeiros") e o formato PJ que a ferramenta de validação da própria ValidaPay aceitou |
| Janela padrão da lista de subcontas | pede uma janela larga (`dateFrom` 2020…) |

Cada um desses pontos precisa ser conferido no **sandbox**: se algum comportamento for outro, é uma mudança pequena e localizada em `validapay.ts`.

## Cartão

A forma "Cartão" (maquininha) continua sendo **paga na entrega ou na retirada**, como sempre foi: não passa pela ValidaPay e não tem taxa nem comissão automática
(a taxa de serviço de 5% vale só para o Pix online).

O **cartão de crédito online** (o cliente paga pelo site e a taxa do cartão é repassada a ele) é outra forma de pagamento, `card_online`, que nasce **desligada** e
está descrita em [`CARTAO-ONLINE.md`](CARTAO-ONLINE.md). Ele **não** tem comissão: a documentação do cartão da ValidaPay (`POST /v1/charges`) **não traz o campo
`split`**; a divisão está documentada **só para o Pix** (`POST /v1/charges/pix`). Os dois fluxos são **separados**: o Pix continua com a subconta e a divisão de 5% (2,5% do cliente + 2,5% do estabelecimento; este guia); o cartão é cobrado na mesma subconta, mas sem divisão.

## Ligar (passo a passo, começando pelo SANDBOX)

1. Na ValidaPay (painel **sandbox**; as credenciais de sandbox e de produção são diferentes), em **Integração → API**, crie uma credencial **só com**
   os escopos `charges/read`, `charges/write`, `wallet/read`, `subaccounts/read`, `proposals/write`.
2. Em **Integração → Webhooks**, cadastre `https://<seu-domínio>/api/payments/webhook`, escolha um **segredo** (e, se quiser, um token estático) e assine os
   eventos: `payment.success`, `charge.expired`, `payment.failed`, `refund.requested`, `refund.confirmed`, `refund.failed` e os quatro `onboarding.*`
   (`create`, `backgroundcheck`, `documentscopy`, `proposal`). Eventos de assinatura, DDA e MED não são usados (são só registrados).
3. Na Vercel (*Settings → Environment Variables*; nomes sem `VITE_`): `VALIDAPAY_ENV` (`sandbox`), `VALIDAPAY_CLIENT_ID`, `VALIDAPAY_CLIENT_SECRET`,
   `VALIDAPAY_WEBHOOK_SECRET` e, se definiu, `VALIDAPAY_WEBHOOK_TOKEN`. Faça um novo deploy. Enquanto faltar alguma, **Pagamentos** mostra o **nome** dela.
4. **Pagamentos → Conta do estabelecimento**: vincule uma conta de sandbox (ou cadastre uma nova) com a autorização do titular. Só com a conta **Aprovada** o
   interruptor "Pix online no site" liga.
5. Faça um pedido de teste, pague **no sandbox** (a ValidaPay tem `POST /v1/wallet/pay/{chargeId}`, que usa o escopo `wallet/write`: use **outra**
   credencial de sandbox, por exemplo no Postman da ValidaPay, e **nunca** a da loja) e confira: pedido "novo", comissão, taxa, histórico e extrato da master.
6. **Só depois** de tudo conferido no sandbox: credenciais de **produção** (`VALIDAPAY_ENV=production`, só no ambiente *Production* da Vercel), conferir as
   tarifas no contrato, vincular/cadastrar a conta real (com a ciência das tarifas) e ligar o Pix online.
7. Depois de ligar, **recarregue o painel em todos os aparelhos** (uma aba antiga, de antes desta versão, não conhece o status "aguardando pagamento").

## Testes — o que é simulação

- `tests/payments-sim.mjs`: um **simulador genérico** de operadora (não é a ValidaPay); `api-test14` (200 verificações) e `e2e-pix` exercitam a lógica da loja.
- `tests/validapay-fake.mjs`: um **servidor ValidaPay FALSO** que segue a documentação oficial e recusa o que foge dela. O adaptador **real**
  roda contra ele em `api-test15` (112 verificações: vínculo, Pix com divisão, avisos assinados, cancelamento, valor errado, corrida pagamento × cancelamento,
  cobrança "órfã", cadastro de conta, produção × sandbox, log sem segredos), em `tests/unit/validapay.test.mjs` (29: dinheiro em reais, escopos, status,
  HMAC, formulário) e em `e2e-account` (telas do owner, celular e computador).
- Os dois substituem `server/payments/factory.ts` só no servidor **de teste**; o código de produção nunca importa nenhum deles.
- **Nada disso prova que a integração com a ValidaPay funciona.** Isso só se prova no **sandbox** da ValidaPay, com as credenciais dela.

## Passos que dependem do proprietário do Disk Bebidas

- Autorizar o cadastro da conta (subconta) do estabelecimento e fornecer à ValidaPay os dados do titular (pessoa física ou jurídica).
- Conhecer e aceitar as tarifas **antes** de qualquer cadastro em produção, e a taxa de serviço de 5% (2,5% cliente + 2,5% estabelecimento) da conta master.
- Ligar o Pix online no painel (só o owner) depois de a conta estar aprovada.
- Devolver manualmente ao cliente os pagamentos sinalizados (pago depois do cancelamento, em duplicidade, disputa) e marcar como conferido.
