-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 10/12 · Catálogo: promoção com data de início e de fim.
--
-- O preço promocional de um produto passa a poder valer só entre duas datas. Fora da janela o produto volta ao preço normal
-- sozinho (antes a promoção ficava até alguém tirar). Quem decide é o banco: o site, o carrinho e o pedido usam a mesma
-- função, então nunca divergem. Sem datas, a promoção vale sempre, como antes.

alter table products
  add column promo_starts_at timestamptz,
  add column promo_ends_at timestamptz;
-- statement-breakpoint

alter table products
  add constraint products_promo_window check (promo_starts_at is null or promo_ends_at is null or promo_ends_at > promo_starts_at);
-- statement-breakpoint

-- Preço promocional em vigor neste instante (null quando não há promoção ou ela não está na janela).
create or replace function effective_promo(p_promo numeric, p_starts timestamptz, p_ends timestamptz, p_at timestamptz default now())
returns numeric
language sql
stable
as $$
  select case
    when p_promo is not null
     and (p_starts is null or p_starts <= p_at)
     and (p_ends is null or p_at < p_ends)
    then p_promo
  end;
$$;
