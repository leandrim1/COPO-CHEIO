# Pagamento online (Pix) — o que existe, o que falta e como funciona

> **Estado: a base da loja está pronta e testada; a operadora (ValidaPay) NÃO está conectada.**
> A documentação oficial da ValidaPay não pôde ser consultada (o conector estava sem autorização e a rede do ambiente bloqueava o site da
> operadora), então **nenhum endpoint, escopo, campo, evento ou regra da ValidaPay foi usado ou presumido**. Tudo o que aparece aqui sobre
> a operadora é **requisito da loja**, não fato confirmado. Sem adaptador, o Pix online fica **indisponível e desligado**: o painel não deixa
> ligá-lo, o servidor recusa pedidos com esse meio e o site continua exatamente como era (Pix com chave, dinheiro e cartão na entrega).

## O que já funciona (testado com um SIMULADOR de operadora)

| Parte | O que faz |
| --- | --- |
| Banco (`0014_online_payments.sql`) | tabelas `merchant_accounts` (subconta), `payments` (cobranças, em centavos) e `payment_events` (avisos); pedido novo `awaiting_payment`; meio de pagamento `pix_online` (nasce **desligado**); funções que criam a cobrança sem duplicar, aplicam o que a operadora informou sem repetir nem regredir e cancelam o que não foi pago |
| Servidor (`server/payments/*`, `server/routes/payments.ts`) | contrato da operadora (`types.ts`), criação do Pix, consulta, webhook, conferência periódica, rotas do cliente, da conta e do painel |
| Site | "Pix online" no checkout (só aparece ligado), tela do Pix na página do pedido (QR Code, copia e cola, contagem, "já paguei"), confirmação sem recarregar, Pix vencido com nova tentativa, pagar também por "Meus pedidos" |
| Painel | página **Pagamentos** (só owner): operadora, conta, comissão calculada × efetivada, cobranças, pendências, "Atualizar pagamento", "Conferir agora"; detalhe do pedido com o pagamento; aba "Aguardando pagamento"; aviso sonoro de pedido pago |

## O que NÃO existe (depende da documentação da ValidaPay)

- O **adaptador da ValidaPay** (`server/payments/factory.ts` devolve `null` em produção): autenticação OAuth, criar a cobrança Pix **com a
  divisão da comissão**, consultar a cobrança, verificar a assinatura do webhook, traduzir os eventos.
- **Cadastro da subconta** (proposta, aprovação, eventos de onboarding, PF/PJ, tarifas): hoje a tabela só guarda o resultado; ninguém cria a
  proposta. O identificador definitivo da subconta só pode existir com a conta **aprovada** (restrição do banco).
- **Cartão de crédito** (tokenização pelo SDK, 3DS, cobrança, split no cartão): não há tela nem rota. O método `card_online` nem existe ainda.
- **Reembolso/estorno pela API**: o sistema **registra** o estorno que a operadora informar; devolver o dinheiro continua manual.
- Nenhuma operação no sandbox ou em produção da ValidaPay foi feita. **Nada foi cobrado, transferido ou cadastrado.**

## Como o pagamento funciona

```
checkout (Pix online) ──► POST /api/orders ──► pedido "aguardando pagamento" (estoque reservado, a loja NÃO vê como novo)
        │
        ▼
página do pedido ──► POST /api/tracking/:código/payment   (ou /api/account/orders/:nº/payment)
        │               └─ payment_begin (trava o pedido; 1 cobrança em aberto por pedido; valor e comissão saem do total do BANCO)
        │               └─ operadora.createPixCharge (limite de 8 s)  →  payment_mark_created
        ▼
cliente paga no banco ──► operadora ──► POST /api/payments/webhook
        │                         └─ 1) autenticidade (adaptador)  2) aviso já visto? ignora  3) consulta a cobrança na operadora
        │                            4) payment_apply: valor igual? → "pago" + pedido "novo" na MESMA transação
        ▼
a página consulta o servidor a cada 4 s e mostra "Pagamento confirmado!"; o painel avisa "pedido novo (Pix pago)"
```

### Regras que o banco garante

- **Valor e comissão nascem no banco**, do total que o próprio banco calculou para o pedido. O navegador não manda (nem consegue mudar) valor,
  total, desconto ou comissão.
- **Comissão: 5%** (`payment_commission_bps() = 500`) do **total do pedido** (itens + entrega − descontos), em centavos, arredondada ao
  centavo mais próximo (metade para cima): R$ 100,00 → R$ 5,00; R$ 10,10 → R$ 0,51; R$ 65,10 → R$ 3,26. Mudar a taxa exige uma migration.
- **Só "efetivada" com evidência**: `commission_state = 'confirmed'` exige o valor que a operadora confirmou ter repassado e a cobrança paga
  (restrição `payments_commission_evidence`). Antes disso a comissão é só "calculada". Falha de repasse vira `failed`, sinaliza e
  **não impede** a liberação do pedido; uma conciliação posterior ainda pode confirmá-la.
- **Pago só com o valor certo**: valor pago diferente do da cobrança não libera o pedido; a cobrança fica sinalizada.
- **Uma cobrança em aberto por pedido** (índice único): cliques repetidos, recarregar a página e requisições simultâneas dão a mesma cobrança.
  No máximo 5 tentativas por pedido.
- **Sem regressão e sem repetição**: a ordem dos status é criando < aguardando < vencido/cancelado/recusado < pago < estornado. Aviso
  repetido, atrasado, fora de ordem, ou aviso da subconta e da conta master para a mesma cobrança não duplicam pedido nem comissão (a
  comissão é uma coluna da cobrança, não uma linha por aviso).
- **Pago depois do cancelamento ou em duplicidade**: o dinheiro é registrado, o pedido **não reabre** e a cobrança fica sinalizada para o dono
  devolver o valor.
- **Pagamento online não se altera à mão**: o painel não oferece "marcar como pago" e o banco recusa.
- **Estoque**: reservado ao criar o pedido; devolvido (uma vez só) se o pedido não for pago a tempo ou for cancelado.

### Prazos

| O quê | Prazo |
| --- | --- |
| Validade do Pix pedido à operadora | 15 minutos (vale a que ela devolver) |
| Nova tentativa depois de um Pix vencido | até 10 minutos depois da última tentativa; depois o pedido é cancelado e o estoque volta |
| Pedido em que ninguém gerou o Pix (página fechada) | cancelado depois de 30 minutos |
| Resposta da operadora ao criar a cobrança | 8 segundos; sem resposta: erro claro, tentativa sinalizada e nova tentativa liberada |
| Cobrança vencida que a operadora não consegue confirmar | depois de 30 minutos é encerrada **e sinalizada** (para o estoque não ficar preso) |

Não há agendador: a conferência (`sweep`) roda de passagem quando o painel está aberto (consultando a operadora), quando entra pedido novo e
quando o cliente consulta o pagamento. Sem ninguém usando o site, o que venceu fica como está até a próxima visita; em loja aberta isso não
acontece. Dá para forçar em **Pagamentos → Conferir agora**. (Se o plano da Vercel permitir, um *cron* chamando essa conferência a cada poucos
minutos é um bom reforço; não foi configurado.)

## Segurança

- Credenciais e tokens da operadora ficarão **só no servidor** (variáveis de ambiente do projeto na Vercel); nunca em `VITE_*`, nunca no
  navegador, nunca em arquivo versionado. O código não registra Pix, códigos de cobrança completos, tokens nem dados do pagador (há teste que
  confere o log do servidor).
- **Webhook**: rota pública, mas **nada é gravado antes de a operadora provar que o aviso é dela** (o adaptador confere a assinatura em tempo
  constante); corpo limitado a 256 KB; no máximo 100 avisos por chamada (mais que isso é recusado); erro de autenticidade responde 401 sem detalhes. Se a consulta à
  operadora falhar, o servidor responde 503 (ela reenvia) e o aviso fica "não processado" para ser tratado na próxima entrega.
- **Confirmação por canal confiável**: aviso verificado **e**, quando a operadora permite consulta (`canLookup`), consulta da cobrança. Ver o
  QR Code, voltar a uma página de sucesso ou tocar em "Já paguei" **nunca** confirma nada.
- **Quem vê o quê**: o cliente só vê o pagamento do próprio pedido (código de acompanhamento ou a própria conta; erro igual para pedido
  inexistente e de outra pessoa) e nunca vê comissão, tarifas, subconta ou código da operadora. Atendente (admin) vê a situação do pagamento;
  **só o owner** vê comissão, tarifas, códigos, a página Pagamentos e liga/desliga o Pix online.
- Limites: 30 tentativas de gerar Pix a cada 10 minutos por rede; consultas com código errado contam como as de acompanhamento.
- CSP e `Permissions-Policy` **não foram alterados** (o QR Code é desenhado no próprio site; não há script de terceiros). O formulário de
  cartão com SDK exigirá liberar os endereços do SDK **só** em `/checkout`, depois de confirmados na documentação.

## Contrato do adaptador (para quem for ligar a ValidaPay)

`server/payments/types.ts` define o que a loja precisa da operadora (valores em centavos):

- `createPixCharge({ paymentId, orderNumber, amountCents, commissionCents, merchantAccountId, expiresInSeconds, description })` →
  `{ providerChargeId, qrPayload, expiresAt }`. `paymentId` é a referência da loja e deve servir de chave de idempotência.
- `getCharge(providerChargeId)` → `{ status: pending|paid|expired|cancelled|failed|refunded, amountCents, feeCents?, netCents?, paidAt?,
  refundedCents?, split?: { state: applied|failed|pending|none, commissionCents? } }`.
- `verifyWebhook(rawBody, headers)` → lista de `{ dedupeKey, type, providerChargeId?, reference?, snapshot? }`; lança erro `invalid_webhook` se
  o aviso não for autêntico.
- Erros com `kind`: `rejected` (definitivo), `unavailable` (ambíguo: pode ter criado a cobrança), `invalid_webhook`, `malformed_webhook`.
- `canLookup`: `true` se a cobrança puder ser consultada (é assim que se confirma um pagamento); `false`: só valem os avisos verificados.

O adaptador entra em `server/payments/factory.ts`. **Antes de escrevê-lo, confirmar na documentação oficial da ValidaPay** (e anotar a fonte):
autenticação e escopos OAuth; como se cria e se aprova a subconta (PF/PJ, eventos, tarifas); como se cria a cobrança Pix **com a divisão
da comissão**; se há chave de idempotência; como consultar a cobrança e como o resultado do repasse aparece; lista oficial de eventos de
webhook, mecanismo de assinatura, política de reenvio e resposta esperada, e se subconta e master recebem avisos separados; estorno; endereço e
dados do sandbox; limites de requisição; se o pagador precisa informar CPF/CNPJ (o checkout hoje não coleta); e, para o cartão, SDK de
tokenização, 3DS e **se existe split no cartão** (se não existir, o cartão só entra com um fluxo de recebimento oficialmente suportado, sem
prometer repasse automático de 5%).

## Ligar o Pix online (quando houver adaptador)

1. Subconta aprovada pela operadora (o registro em `merchant_accounts` passa a `approved` com o identificador definitivo).
2. Variáveis da operadora cadastradas na Vercel (nomes definidos junto com o adaptador; ver `.env.example`).
3. Webhook cadastrado no painel da operadora apontando para `https://<seu-domínio>/api/payments/webhook` (e os eventos que a documentação indicar).
4. **Painel → Pagamentos**: conferir "Operadora: Conectada" e "Conta: Aprovada"; ligar **Pix online no site**.
5. Fazer um pedido de teste, pagar no **sandbox** e conferir pedido, comissão e histórico. Só depois liberar para clientes.
6. Depois de ligar, **recarregue o painel em todos os aparelhos** (uma aba antiga, de antes desta versão, não conhece o status "aguardando pagamento").

## Testes — o que é simulação

- `tests/payments-sim.mjs` é um **simulador** da operadora (não é a ValidaPay): cumpre o contrato acima e permite provocar recusa, queda,
  demora, valor errado, falha de repasse, aviso repetido/atrasado/sem assinatura, vencimento e estorno. Ele só é ligado ao servidor **de teste**
  (substitui `factory.ts` ao montar a API de teste); o código de produção nunca o importa.
- `tests/api-test14.mjs` (193 verificações), `tests/e2e-pix.cjs` (navegador, celular e computador) e `tests/unit/payments.test.mjs`
  provam a **lógica da loja**: banco, estados, idempotência, concorrência, segurança, telas e painel. Foram verificados também por
  **mutação** (quebrando de propósito oito proteções; a suíte acusou todas).
- **Nada disso prova que a integração com a ValidaPay funciona.** Isso só se prova no **sandbox** da ValidaPay, com o adaptador real.

## Passos que dependem do proprietário do Disk Bebidas

- Autorizar o cadastro da conta (subconta) do estabelecimento e fornecer à operadora os dados que ela pedir (PF ou PJ).
- Conhecer e aceitar as tarifas antes de qualquer cadastro em produção, e a comissão de 5% da conta master.
- Ligar o Pix online no painel (só o owner) depois de a conta estar aprovada.
- Devolver manualmente ao cliente os pagamentos sinalizados (pago depois do cancelamento ou em duplicidade) e marcar como conferido.
