-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 32/32 · Limite de estoque baixo configurável.
--
-- Antes o aviso "Estoque baixo" usava um número fixo (5) escrito no código do painel. Agora:
-- • store_settings.low_stock_default: o limite padrão da loja (0 a 1000; padrão 5, o mesmo de antes);
-- • products.low_stock_threshold: o limite DESTE produto (vazio = vale o da loja).
-- • store_settings.low_stock_email: avisar os donos por e-mail quando algum produto ficar com estoque baixo ou esgotar (no máximo um e-mail por dia, só quando a lista muda).
--   Nasce LIGADO; o e-mail só sai se o envio de e-mail estiver configurado. Desligue em Estoque.
-- Estoque baixo = produto com estoque controlado, acima de 0 e até o limite. Nada muda para quem não mexer: o padrão continua 5.

alter table store_settings
  add column low_stock_default integer not null default 5 check (low_stock_default between 0 and 1000),
  add column low_stock_email boolean not null default true;
-- statement-breakpoint

alter table products
  add column low_stock_threshold integer check (low_stock_threshold is null or low_stock_threshold between 0 and 100000);
