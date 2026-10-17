-- WhatsApp da loja: (34) 9244-1191.
--
-- Número novo informado pela própria loja (link https://wa.me/553492441191). Substitui o da migration 0008 ((34) 99128-3384), mas
-- só onde ele ainda é o que a 0008 gravou: quem já trocou por outro número em Configurações → Loja, ou deixou o campo vazio de
-- propósito (então o botão abre o WhatsApp para a pessoa escolher o contato), NÃO é sobrescrito. Roda uma única vez. Para trocar
-- ou tirar o número depois, é só editar em Configurações → Loja → WhatsApp da loja.

update store_settings set whatsapp = '553492441191' where id = 1 and whatsapp = '5534991283384';
