-- Tempo médio de retirada no balcão, mostrado na janela "ⓘ" da página Bebidas (ao lado do tempo de entrega).
--
-- Só acrescenta uma coluna opcional em store_settings: texto livre, como o tempo de entrega ("10 a 15 min"). Nasce vazia, então nada muda
-- no site até o owner preencher em Painel → Configurações → Entrega → "Tempo de retirada"; sem valor, a janela simplesmente não mostra a linha.

alter table store_settings
  add column pickup_time text check (pickup_time is null or char_length(pickup_time) <= 30);
