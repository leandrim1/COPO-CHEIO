-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 35/35 · Programa de pontos (fidelidade) simples e configurável pelo dono. NASCE DESLIGADO e SEM VALORES: nenhuma regra comercial é inventada.
--
-- • store_settings.loyalty_*: ligado/desligado e as regras que SÓ o dono define: quantos pontos por R$ 1 gasto, quantos pontos valem uma recompensa, o valor da recompensa (R$) e
--   por quantos dias o cupom da recompensa vale. Ligar exige as quatro regras preenchidas (o banco confere).
-- • loyalty_ledger: o extrato de pontos, SÓ de acréscimo (o banco recusa alterar uma linha). Saldo = soma. Tipos: earn (pedido entregue), reverse (pedido que perdeu o direito: pagamento
--   devolvido ou pedido cancelado depois de creditado), redeem (troca por cupom), adjust (acerto manual do dono, com motivo). Um crédito e um estorno por pedido, no máximo.
-- • Pontos só para pedido de CONTA (cliente logado), calculados sobre os itens depois do desconto (sem entrega nem taxas), creditados quando o pedido vira "entregue".
-- • A troca gera um CUPOM PESSOAL de valor fixo (usa o motor de cupons que já existe): coupons.customer_id restringe o cupom a uma conta; quem não é o dono recebe a mesma mensagem
--   de "cupom inválido". A troca é atômica (trava a conta, confere o saldo, debita e cria o cupom na mesma transação): dois cliques não gastam o mesmo ponto duas vezes.
-- • Se o pagamento de um pedido é devolvido (ou o pedido é cancelado) DEPOIS de os pontos terem sido creditados, o crédito é estornado; o saldo pode ficar negativo (se os pontos já foram trocados) e
--   a troca só volta a ser possível quando o saldo cobrir de novo. Os gatilhos engolem qualquer erro: pontos nunca derrubam um pedido.
--
-- Só acrescenta (colunas com padrão que não muda nada, tabela, funções e gatilho). Troca coupon_apply por uma versão igual à da 0029, mais a restrição de cupom pessoal.

alter table store_settings
  add column loyalty_enabled boolean not null default false,
  add column loyalty_points_per_real numeric(8, 2) check (loyalty_points_per_real is null or (loyalty_points_per_real >= 0.01 and loyalty_points_per_real <= 1000)),
  add column loyalty_redeem_points integer check (loyalty_redeem_points is null or (loyalty_redeem_points >= 1 and loyalty_redeem_points <= 1000000)),
  add column loyalty_reward_value numeric(10, 2) check (loyalty_reward_value is null or (loyalty_reward_value > 0 and loyalty_reward_value <= 10000)),
  add column loyalty_coupon_days integer check (loyalty_coupon_days is null or (loyalty_coupon_days >= 1 and loyalty_coupon_days <= 365)),
  add constraint store_settings_loyalty_rules check (
    not loyalty_enabled
    or (loyalty_points_per_real is not null and loyalty_redeem_points is not null and loyalty_reward_value is not null and loyalty_coupon_days is not null)
  );
-- statement-breakpoint

alter table coupons
  add column customer_id uuid references customers (id) on delete cascade;
-- statement-breakpoint

create index coupons_customer_idx on coupons (customer_id) where customer_id is not null;
-- statement-breakpoint

create table loyalty_ledger (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  order_id uuid references orders (id) on delete set null,
  kind text not null check (kind in ('earn', 'reverse', 'redeem', 'adjust')),
  points integer not null check (points <> 0 and points between -10000000 and 10000000),
  note text check (note is null or char_length(note) <= 120),
  created_by uuid references admins (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'earn' and points > 0) or (kind in ('reverse', 'redeem') and points < 0) or kind = 'adjust')
);
-- statement-breakpoint

create index loyalty_ledger_customer_idx on loyalty_ledger (customer_id, created_at desc);
-- statement-breakpoint

-- No máximo um crédito e um estorno por pedido (repetir a mudança de status não credita de novo).
create unique index loyalty_ledger_earn_key on loyalty_ledger (order_id) where kind = 'earn';
-- statement-breakpoint

create unique index loyalty_ledger_reverse_key on loyalty_ledger (order_id) where kind = 'reverse';
-- statement-breakpoint

-- Extrato só de acréscimo: nenhuma linha muda depois de gravada. (Apagar acontece só quando a conta é excluída, em cascata.)
create or replace function loyalty_ledger_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'O extrato de pontos não pode ser alterado.' using errcode = 'P0001';
end;
$$;
-- statement-breakpoint

create trigger loyalty_ledger_no_update before update on loyalty_ledger
  for each row execute function loyalty_ledger_immutable();
-- statement-breakpoint

create or replace function loyalty_balance(p_customer uuid)
returns integer
language sql
stable
as $$
  select coalesce(sum(points), 0)::integer from loyalty_ledger where customer_id = p_customer;
$$;
-- statement-breakpoint

-- Credita os pontos de um pedido ENTREGUE (só se o programa está ligado e o pedido é de uma conta). Idempotente.
create or replace function loyalty_earn(p_order uuid)
returns integer
language plpgsql
volatile
as $$
declare
  s store_settings;
  o orders;
  v_points integer;
begin
  select * into s from store_settings where id = 1;
  if not found or not s.loyalty_enabled or s.loyalty_points_per_real is null then
    return 0;
  end if;
  select * into o from orders where id = p_order;
  if not found or o.customer_id is null or o.order_status <> 'delivered' then
    return 0;
  end if;
  v_points := floor(greatest(o.subtotal - o.discount, 0) * s.loyalty_points_per_real)::integer;
  if v_points <= 0 then
    return 0;
  end if;
  insert into loyalty_ledger (customer_id, order_id, kind, points, note)
  values (o.customer_id, o.id, 'earn', v_points, 'Pedido #' || o.order_number)
  on conflict (order_id) where kind = 'earn' do nothing;
  return v_points;
end;
$$;
-- statement-breakpoint

-- Estorna o crédito de um pedido que perdeu o direito (pagamento devolvido ou pedido cancelado depois de creditado). Idempotente.
create or replace function loyalty_reverse(p_order uuid)
returns integer
language plpgsql
volatile
as $$
declare
  e loyalty_ledger;
begin
  select * into e from loyalty_ledger where order_id = p_order and kind = 'earn';
  if not found then
    return 0;
  end if;
  insert into loyalty_ledger (customer_id, order_id, kind, points, note)
  values (e.customer_id, e.order_id, 'reverse', -e.points, 'Estorno: ' || coalesce(e.note, 'pedido'))
  on conflict (order_id) where kind = 'reverse' do nothing;
  return e.points;
end;
$$;
-- statement-breakpoint

-- Gatilho: o pedido virou "entregue" → credita; o pagamento foi devolvido ou o pedido cancelado → estorna. Nunca derruba a mudança de status.
create or replace function orders_loyalty_trigger()
returns trigger
language plpgsql
as $$
begin
  begin
    if new.customer_id is not null then
      if new.order_status = 'delivered' and old.order_status is distinct from 'delivered' then
        perform loyalty_earn(new.id);
      end if;
      if (new.payment_status = 'refunded' and old.payment_status is distinct from 'refunded')
         or (new.order_status = 'cancelled' and old.order_status is distinct from 'cancelled') then
        perform loyalty_reverse(new.id);
      end if;
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;
-- statement-breakpoint

create trigger orders_loyalty after update of order_status, payment_status on orders
  for each row execute function orders_loyalty_trigger();
-- statement-breakpoint

-- Troca de pontos por um cupom pessoal de valor fixo. Devolve { ok, code, value, expires_at, balance } ou { ok: false, message }.
create or replace function loyalty_redeem(p_customer uuid)
returns jsonb
language plpgsql
volatile
as $$
declare
  s store_settings;
  v_balance integer;
  v_code text;
  v_ends timestamptz;
begin
  select * into s from store_settings where id = 1;
  if not found or not s.loyalty_enabled then
    return jsonb_build_object('ok', false, 'message', 'O programa de pontos não está ativo.');
  end if;
  -- Trava a conta: duas trocas ao mesmo tempo esperam uma pela outra e a segunda vê o saldo já debitado.
  perform 1 from customers where id = p_customer for update;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'Conta não encontrada.');
  end if;
  v_balance := loyalty_balance(p_customer);
  if v_balance < s.loyalty_redeem_points then
    return jsonb_build_object('ok', false, 'message', 'Você ainda não tem pontos suficientes.');
  end if;
  v_ends := now() + make_interval(days => s.loyalty_coupon_days);
  loop
    v_code := 'PTS' || upper(substr(md5(random()::text || clock_timestamp()::text || p_customer::text), 1, 8));
    exit when not exists (select 1 from coupons where code = v_code);
  end loop;
  insert into coupons (code, description, kind, value, min_order, ends_at, usage_limit, per_customer_limit, customer_id)
  values (v_code, 'Troca de pontos', 'fixed', s.loyalty_reward_value, 0, v_ends, 1, 1, p_customer);
  insert into loyalty_ledger (customer_id, kind, points, note)
  values (p_customer, 'redeem', -s.loyalty_redeem_points, 'Troca por cupom ' || v_code);
  return jsonb_build_object('ok', true, 'code', v_code, 'value', s.loyalty_reward_value, 'expires_at', v_ends, 'balance', v_balance - s.loyalty_redeem_points);
end;
$$;
-- statement-breakpoint

create or replace function coupon_apply(
  p_code text, p_cats uuid[], p_units numeric[], p_qtys integer[], p_promos boolean[], p_type text, p_customer uuid, p_phone text, p_lock boolean default false
)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  c coupons;
  v_sub numeric := 0;
  v_elig numeric := 0;
  v_has_cats boolean;
  v_used integer;
  v_mine integer;
  v_disc numeric := 0;
  i integer;
  v_generic constant jsonb := jsonb_build_object('ok', false, 'message', 'Cupom inválido ou expirado.');
begin
  if v_code !~ '^[A-Z0-9][A-Z0-9_-]{2,29}$' then
    return v_generic;
  end if;
  if p_lock then
    select * into c from coupons where code = v_code for update;
  else
    select * into c from coupons where code = v_code;
  end if;
  if not found or not c.active or (c.starts_at is not null and now() < c.starts_at) or (c.ends_at is not null and now() >= c.ends_at) then
    return v_generic;
  end if;
  -- Cupom pessoal (troca de pontos): só a conta dona usa; para qualquer outra pessoa é o mesmo "inválido ou expirado".
  if c.customer_id is not null and p_customer is distinct from c.customer_id then
    return v_generic;
  end if;

  v_has_cats := exists (select 1 from coupon_categories k where k.coupon_id = c.id);
  for i in 1 .. coalesce(array_length(p_units, 1), 0) loop
    v_sub := v_sub + p_units[i] * p_qtys[i];
    if (not c.excludes_promo or not coalesce(p_promos[i], false))
       and (not v_has_cats or exists (select 1 from coupon_categories k where k.coupon_id = c.id and k.category_id = p_cats[i])) then
      v_elig := v_elig + p_units[i] * p_qtys[i];
    end if;
  end loop;

  if c.kind = 'free_delivery' and p_type is distinct from 'delivery' then
    return jsonb_build_object('ok', false, 'message', 'Este cupom vale só para entrega.');
  end if;
  if v_sub < c.min_order then
    return jsonb_build_object('ok', false, 'message', 'Este cupom vale para pedidos a partir de ' || format_brl(c.min_order) || '.');
  end if;
  if c.kind <> 'free_delivery' and v_elig <= 0 then
    return jsonb_build_object('ok', false, 'message', 'Este cupom não vale para os itens do seu pedido.');
  end if;

  if c.usage_limit is not null then
    select count(*) into v_used from orders o where o.coupon_id = c.id and o.order_status <> 'cancelled';
    if v_used >= c.usage_limit then
      return jsonb_build_object('ok', false, 'message', 'Este cupom já foi todo usado.');
    end if;
  end if;
  if c.per_customer_limit is not null then
    select count(*) into v_mine from orders o
     where o.coupon_id = c.id and o.order_status <> 'cancelled'
       and ((p_customer is not null and o.customer_id = p_customer) or (coalesce(p_phone, '') <> '' and o.customer_phone = p_phone));
    if v_mine >= c.per_customer_limit then
      return jsonb_build_object('ok', false, 'message', 'Você já usou este cupom.');
    end if;
  end if;

  if c.kind = 'percent' then
    v_disc := round(v_elig * c.value / 100, 2);
    if c.max_discount is not null then
      v_disc := least(v_disc, c.max_discount);
    end if;
  elsif c.kind = 'fixed' then
    v_disc := c.value;
  end if;
  v_disc := least(v_disc, v_elig);

  return jsonb_build_object(
    'ok', true, 'id', c.id, 'code', c.code, 'description', c.description, 'kind', c.kind,
    'discount', v_disc, 'free_delivery', c.kind = 'free_delivery', 'subtotal', v_sub
  );
end;
$$;
