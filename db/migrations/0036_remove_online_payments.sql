-- Retirada do pagamento pelo site (Pix online e cartão online, pela ValidaPay).
--
-- O sistema não oferece mais pagamento online: sobram só as formas pagas à loja (Pix da loja pela chave, dinheiro e cartão na entrega ou na
-- retirada). O código foi removido; esta migration só garante que as duas formas online fiquem DESLIGADAS no banco (elas já nasciam desligadas
-- e o servidor nunca as lista nem as aceita).
--
-- O que NÃO muda de propósito: as tabelas e colunas que já existem (payments, payment_methods, payment_fee_settings, merchant_accounts, as colunas
-- payment_fee* de orders e as funções do banco). Apagá-las seria destrutivo e irreversível; sem o código que as usa, ficam paradas e sem efeito.
-- Se algum dia o pagamento online voltar, não é preciso recriar nada.
--
-- Também troca, só onde ainda é o texto padrão da 0033, as duas políticas que falavam do pagamento pelo site.
-- Roda uma única vez e pode rodar de novo sem efeito colateral.

update payment_methods set enabled = false where code in ('pix_online', 'card_online') and enabled;

-- statement-breakpoint

-- Textos padrão das políticas (migration 0033) que falavam do pagamento pelo site e da operadora. Só são trocados onde o texto ainda é EXATAMENTE o padrão
-- da 0033: quem já editou a página não é sobrescrito. Texto trocado perde a marca "revisado juridicamente" (a revisão valia para o texto antigo).
update legal_pages
   set body = $new$
## Cancelar um pedido
- Você pode cancelar o pedido pela própria página de acompanhamento enquanto a loja ainda não o confirmou e enquanto ele não tiver sido pago.
- Depois que a loja confirma, ou se o pedido já foi pago, o cancelamento é combinado com a loja pelo WhatsApp.
- Pedido cancelado devolve os produtos ao estoque.

## Problema com o produto ou com a entrega
Se algo chegou errado, faltando ou com defeito, fale com a loja pelo WhatsApp o quanto antes, com o número do pedido. A loja analisa cada caso e combina a solução com você.

## Dinheiro de volta
Quando há devolução de dinheiro, ela é combinada com a loja. Todo pagamento é feito à loja: na entrega ou na retirada, ou pela chave Pix da loja.
$new$, reviewed_at = null, reviewed_by = null
 where slug = 'trocas-e-cancelamentos' and body = $old$
## Cancelar um pedido
- Você pode cancelar o pedido pela própria página de acompanhamento enquanto a loja ainda não o confirmou e enquanto ele não tiver sido pago.
- Depois que a loja confirma, ou se o pedido já foi pago, o cancelamento é combinado com a loja pelo WhatsApp.
- Pedido cancelado devolve os produtos ao estoque.

## Problema com o produto ou com a entrega
Se algo chegou errado, faltando ou com defeito, fale com a loja pelo WhatsApp o quanto antes, com o número do pedido. A loja analisa cada caso e combina a solução com você.

## Dinheiro de volta
Quando há devolução de dinheiro de um pagamento feito pelo site, a devolução é feita pela loja pela mesma forma de pagamento. O valor só é considerado devolvido depois que a operadora de pagamento confirmar. Pagamentos feitos na entrega ou na retirada são combinados com a loja.
$old$;
-- statement-breakpoint

update legal_pages
   set body = $new$
## Formas de pagamento
As formas disponíveis aparecem no checkout. Podem incluir: dinheiro, cartão na entrega ou na retirada e Pix com chave da loja.

## Como pagar
- Dinheiro e cartão: o pagamento é feito na entrega ou na retirada.
- Pix: você envia o valor para a chave Pix da loja, que aparece depois do pedido. O site não cobra nem confirma o pagamento sozinho.
- O site não coleta nem guarda dados de cartão.

## Reembolso
- Se um pedido pago for cancelado, a devolução do dinheiro é combinada com a loja.
- O prazo para o dinheiro aparecer para você depende da forma de pagamento e do seu banco.
$new$, reviewed_at = null, reviewed_by = null
 where slug = 'pagamento-e-reembolso' and body = $old$
## Formas de pagamento
As formas disponíveis aparecem no checkout. Podem incluir: dinheiro, cartão na entrega ou na retirada, Pix com chave da loja, Pix pelo site e cartão de crédito pelo site.

## Pagamento pelo site
- Pix: você paga pelo QR Code ou pelo código Pix copia e cola. O pedido só chega à loja depois que o pagamento é confirmado.
- Cartão de crédito: os dados do cartão são digitados direto na operadora de pagamento; este site não guarda o número nem o código de segurança do seu cartão.
- Pode haver uma taxa do meio de pagamento, que aparece no resumo antes de você finalizar.

## Reembolso
- Se o pedido pago pelo site for cancelado, a loja faz a devolução pelo mesmo meio de pagamento.
- O valor só é considerado devolvido depois que a operadora de pagamento confirmar; até lá o pedido aparece como aguardando a devolução.
- O prazo para o dinheiro aparecer para você depende do seu banco ou da operadora do cartão.
$old$;
