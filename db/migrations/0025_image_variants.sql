-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 25/25 · Miniaturas das fotos dos produtos (desempenho do site em celular e rede lenta).
--
-- A foto do produto é guardada com até 1200 px de largura, mas o site a mostra em até 176 px (lista) ou ~290 px (favoritos): cada
-- cartão baixava e decodificava uma imagem de 7 a 13 vezes o necessário. Agora o painel também grava duas cópias menores da mesma foto
-- (400 px e 720 px de largura) e o site escolhe a que cabe no espaço (srcset + sizes), como qualquer loja de internet.
--
-- • products.image_sm_url: a cópia de 400 px (cartões da lista, linhas do pedido, miniaturas).
-- • products.image_md_url: a cópia de 720 px (cartões "Os favoritos da galera" e telas de alta densidade).
-- • As duas nascem vazias: produto sem miniatura continua mostrando a foto original, exatamente como hoje. O painel gera as miniaturas ao
--   salvar uma foto nova e, para as fotos que já existem, no botão "Gerar miniaturas" (Produtos). Nada é apagado nem alterado.
-- • O servidor garante que as miniaturas sempre pertencem à foto atual: trocar ou remover a foto zera as duas.
--
-- Só acrescenta duas colunas opcionais; nenhum produto, preço, estoque, pedido ou imagem existente é modificado.

alter table products
  add column image_sm_url text check (image_sm_url is null or char_length(image_sm_url) <= 1000),
  add column image_md_url text check (image_md_url is null or char_length(image_md_url) <= 1000);
