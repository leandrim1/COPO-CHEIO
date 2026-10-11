-- WhatsApp da loja: (34) 99128-3384.
--
-- Número informado pela própria loja (link https://api.whatsapp.com/send/?phone=5534991283384). É o que os botões de
-- WhatsApp do site (Contato, chamada final, pedido, acompanhamento) e o rodapé dos e-mails usam: sem número, o botão abre o
-- WhatsApp para a pessoa escolher o contato.
--
-- Só grava se o campo ainda estiver vazio: quem já preencheu outro número em Configurações → Loja não é sobrescrito, e esta
-- migration roda uma única vez. Para trocar ou tirar o número depois, é só editar em Configurações → Loja → WhatsApp da loja.

update store_settings set whatsapp = '5534991283384' where id = 1 and whatsapp is null;
