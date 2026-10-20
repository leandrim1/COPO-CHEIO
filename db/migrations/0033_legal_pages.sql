-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 33/33 · Páginas de termos e políticas com texto editável pelo dono.
--
-- • legal_pages: uma linha por página (termos, cancelamento e trocas, entrega, pagamento e reembolso, contato e responsável). O texto padrão descreve o que o sistema FAZ hoje, sem prazos nem valores
--   que a loja não tenha decidido, e SEM citar leis: quem decide o que vale juridicamente é a loja, com o seu advogado. `reviewed_at` / `reviewed_by` registram quando alguém marcou
--   o texto como revisado juridicamente (vazio = ainda não revisado; o painel avisa).
-- • A política de privacidade continua sendo a página /privacidade (texto no código, com o que o sistema guarda de verdade).
--
-- Só acrescenta uma tabela e cinco linhas de texto padrão. Nada existente é alterado.

create table legal_pages (
  slug text primary key check (slug in ('termos', 'trocas-e-cancelamentos', 'entrega', 'pagamento-e-reembolso', 'contato-e-responsavel')),
  title text not null check (char_length(btrim(title)) between 3 and 80),
  body text not null check (char_length(body) between 20 and 20000),
  reviewed_at timestamptz,
  reviewed_by text check (reviewed_by is null or char_length(reviewed_by) <= 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references admins (id) on delete set null
);
-- statement-breakpoint

create trigger legal_pages_updated_at before update on legal_pages
  for each row execute function set_updated_at();
-- statement-breakpoint

insert into legal_pages (slug, title, body) values
('termos', 'Termos de uso', $t$
## Quem somos
Este site é a loja virtual do Copo Cheio – Disk Bebidas. Ao fazer um pedido aqui, você concorda com as regras abaixo.

## Pedidos
- Os preços, as promoções e a disponibilidade dos produtos são os que aparecem no site no momento do pedido.
- O pedido só é aceito depois que a loja o confirma. Enquanto isso, você pode acompanhá-lo pelo link que recebe ao finalizar.
- A loja pode recusar ou cancelar um pedido quando o produto acabou, quando o endereço está fora da área atendida ou quando não for possível confirmar os dados.

## Bebidas alcoólicas
- A venda de bebida alcoólica é proibida para menores de 18 anos.
- Ao finalizar um pedido com bebida alcoólica você declara ter 18 anos ou mais. Essa declaração não substitui a conferência: na entrega ou na retirada pedimos um documento oficial com foto, e o pedido não é entregue a quem não comprovar a maioridade.
- Não guardamos cópia nem o número do seu documento.
- Beba com moderação.

## Sua conta
Criar conta é opcional. Quem cria uma conta é responsável por manter a senha em segurança e por informar dados verdadeiros.

## Privacidade
O que fazemos com os seus dados está na Política de privacidade.

## Contato
Dúvidas sobre o seu pedido: fale com a loja pelo WhatsApp que aparece no site.
$t$),
('trocas-e-cancelamentos', 'Cancelamento e trocas', $t$
## Cancelar um pedido
- Você pode cancelar o pedido pela própria página de acompanhamento enquanto a loja ainda não o confirmou e enquanto ele não tiver sido pago.
- Depois que a loja confirma, ou se o pedido já foi pago, o cancelamento é combinado com a loja pelo WhatsApp.
- Pedido cancelado devolve os produtos ao estoque.

## Problema com o produto ou com a entrega
Se algo chegou errado, faltando ou com defeito, fale com a loja pelo WhatsApp o quanto antes, com o número do pedido. A loja analisa cada caso e combina a solução com você.

## Dinheiro de volta
Quando há devolução de dinheiro de um pagamento feito pelo site, a devolução é feita pela loja pela mesma forma de pagamento. O valor só é considerado devolvido depois que a operadora de pagamento confirmar. Pagamentos feitos na entrega ou na retirada são combinados com a loja.
$t$),
('entrega', 'Entrega e retirada', $t$
## Como funciona
- Você escolhe entre receber em casa ou retirar na loja. A forma e a taxa aparecem no resumo do pedido antes de você finalizar.
- A entrega é feita nos bairros que a loja atende. Se o seu bairro não está na lista, escolha a retirada na loja.
- O tempo estimado aparece no site e é uma previsão: pode variar com o movimento.

## Pedido agendado
Quando a loja oferece o agendamento, você escolhe o dia e a faixa de horário. Pedidos agendados seguem o horário de funcionamento da loja.

## Maioridade
Na entrega ou na retirada de pedido com bebida alcoólica, pedimos um documento oficial com foto que comprove 18 anos ou mais. Sem comprovação, o pedido não é entregue.

## Acompanhe seu pedido
Use o link da página de confirmação ou entre na sua conta para ver cada etapa do pedido.
$t$),
('pagamento-e-reembolso', 'Pagamento e reembolso', $t$
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
$t$),
('contato-e-responsavel', 'Contato e responsável', $t$
## Atendimento
- O atendimento é feito pelo WhatsApp da loja, que aparece nesta página e no rodapé do site. Tenha em mãos o número do pedido.
- Você acompanha o pedido pelo link que recebe ao finalizar ou pela sua conta.

## Responsável pelo estabelecimento
Os dados da empresa responsável por esta loja (nome empresarial, CNPJ e endereço) serão informados nesta página.
$t$);
