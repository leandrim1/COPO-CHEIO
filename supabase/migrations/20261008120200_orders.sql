-- COPO CHEIO – Disk Bebidas
-- 3/5 · Pedidos (criação, consulta pelo cliente, status e histórico), estoque, painel e equipe.

-- ---------------------------------------------------------------------------------------------
-- Loja aberta agora? (horário no fuso da loja; "início = fim" significa 24 horas;
-- fim antes do início atravessa a meia-noite, ex.: 18:00 às 02:00)
-- ---------------------------------------------------------------------------------------------

create or replace function public.store_open_now()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.store_settings;
  local_now timestamp;
  t time;
  days constant text[] := array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  dow integer;
  d jsonb;
  y jsonb;
begin
  select * into s from public.store_settings where id = 1;
  if not found or s.orders_paused then
    return false;
  end if;
  local_now := now() at time zone s.timezone;
  t := local_now::time;
  dow := extract(dow from local_now)::integer;
  d := s.opening_hours -> days[dow + 1];
  y := s.opening_hours -> days[((dow + 6) % 7) + 1];

  if (d ->> 'open')::boolean then
    if (d ->> 'start')::time = (d ->> 'end')::time then
      return true;
    elsif (d ->> 'start')::time < (d ->> 'end')::time then
      if t >= (d ->> 'start')::time and t < (d ->> 'end')::time then
        return true;
      end if;
    elsif t >= (d ->> 'start')::time then
      return true;
    end if;
  end if;

  -- Madrugada de um dia que começou ontem.
  return (y ->> 'open')::boolean
    and (y ->> 'start')::time > (y ->> 'end')::time
    and t < (y ->> 'end')::time;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Pedido visto pelo cliente (página /pedido/:id). Só com o código secreto do link.
-- ---------------------------------------------------------------------------------------------

create or replace function public.get_public_order(token uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'token', o.public_token,
    'order_number', o.order_number,
    'order_status', o.order_status,
    'payment_status', o.payment_status,
    'payment_method', o.payment_method,
    'change_for', o.change_for,
    'delivery_type', o.delivery_type,
    'customer_name', o.customer_name,
    'address', o.address,
    'address_number', o.address_number,
    'neighborhood', o.neighborhood,
    'complement', o.complement,
    'reference', o.reference,
    'notes', o.notes,
    'subtotal', o.subtotal,
    'delivery_fee', o.delivery_fee,
    'discount', o.discount,
    'total', o.total,
    'created_at', o.created_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_name', i.product_name,
        'quantity', i.quantity,
        'unit_price', i.unit_price,
        'total_price', i.total_price
      ) order by i.created_at, i.product_name)
      from public.order_items i
      where i.order_id = o.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from public.order_status_history h
      where h.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.public_token = token;
$$;

-- ---------------------------------------------------------------------------------------------
-- Criar pedido (site público). Preços, estoque, taxa e regras da loja são conferidos aqui:
-- o navegador só manda o que o cliente escolheu.
-- ---------------------------------------------------------------------------------------------

create or replace function public.format_brl(value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'R$ ' || replace(to_char(value, 'FM999999990.00'), '.', ',');
$$;

create or replace function public.create_order(payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  s public.store_settings;
  v_name text := btrim(coalesce(payload ->> 'customer_name', ''));
  v_phone text := regexp_replace(coalesce(payload ->> 'customer_phone', ''), '\D', '', 'g');
  v_email text := nullif(lower(btrim(coalesce(payload ->> 'customer_email', ''))), '');
  v_type text := coalesce(payload ->> 'delivery_type', '');
  v_payment text := coalesce(payload ->> 'payment_method', '');
  v_address text := nullif(btrim(coalesce(payload ->> 'address', '')), '');
  v_number text := nullif(btrim(coalesce(payload ->> 'address_number', '')), '');
  v_neighborhood text := nullif(btrim(coalesce(payload ->> 'neighborhood', '')), '');
  v_complement text := nullif(btrim(coalesce(payload ->> 'complement', '')), '');
  v_reference text := nullif(btrim(coalesce(payload ->> 'reference', '')), '');
  v_notes text := nullif(btrim(coalesce(payload ->> 'notes', '')), '');
  v_change_text text := nullif(btrim(coalesce(payload ->> 'change_for', '')), '');
  v_change numeric(10, 2);
  v_fee numeric(10, 2) := 0;
  v_subtotal numeric(10, 2) := 0;
  v_total numeric(10, 2);
  v_item record;
  v_product public.products;
  v_unit numeric(10, 2);
  v_ids uuid[] := '{}';
  v_names text[] := '{}';
  v_qtys integer[] := '{}';
  v_units numeric[] := '{}';
  v_order public.orders;
begin
  select * into s from public.store_settings where id = 1;
  if not found then
    raise exception 'A loja ainda não foi configurada.' using errcode = 'P0001';
  end if;
  if s.orders_paused then
    raise exception 'A loja não está recebendo pedidos agora. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;
  if not public.store_open_now() then
    raise exception 'Estamos fechados agora. Confira nosso horário de funcionamento.' using errcode = 'P0001';
  end if;

  -- Cliente
  if char_length(v_name) < 2 or char_length(v_name) > 80 then
    raise exception 'Informe seu nome.' using errcode = 'P0001';
  end if;
  if v_phone !~ '^[0-9]{10,13}$' then
    raise exception 'Informe um telefone válido, com DDD.' using errcode = 'P0001';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Confira o e-mail informado.' using errcode = 'P0001';
  end if;

  -- Entrega ou retirada
  if v_type = 'delivery' then
    if not s.delivery_enabled then
      raise exception 'A entrega não está disponível no momento.' using errcode = 'P0001';
    end if;
    if v_address is null or v_number is null or v_neighborhood is null then
      raise exception 'Informe rua, número e bairro para a entrega.' using errcode = 'P0001';
    end if;
    if char_length(v_address) > 120 or char_length(v_number) > 20 or char_length(v_neighborhood) > 60
       or char_length(coalesce(v_complement, '')) > 60 or char_length(coalesce(v_reference, '')) > 120 then
      raise exception 'O endereço está longo demais. Confira os campos.' using errcode = 'P0001';
    end if;
  elsif v_type = 'pickup' then
    if not s.pickup_enabled then
      raise exception 'A retirada na loja não está disponível no momento.' using errcode = 'P0001';
    end if;
    v_address := null;
    v_number := null;
    v_neighborhood := null;
    v_complement := null;
    v_reference := null;
  else
    raise exception 'Escolha entrega ou retirada.' using errcode = 'P0001';
  end if;

  -- Pagamento
  if not ((v_payment = 'pix' and s.pix_enabled)
       or (v_payment = 'cash' and s.cash_enabled)
       or (v_payment = 'card' and s.card_enabled)) then
    raise exception 'Escolha uma forma de pagamento disponível.' using errcode = 'P0001';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'As observações podem ter até 500 caracteres.' using errcode = 'P0001';
  end if;

  -- Proteção contra envios repetidos
  if (select count(*) from public.orders o
      where o.customer_phone = v_phone and o.created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Muitos pedidos em pouco tempo. Aguarde alguns minutos ou fale com a loja pelo WhatsApp.'
      using errcode = 'P0001';
  end if;

  -- Itens: preço e disponibilidade vêm do banco; os produtos ficam travados até o fim do pedido
  -- (sempre na mesma ordem), então pedidos simultâneos não vendem o mesmo estoque duas vezes.
  if jsonb_typeof(payload -> 'items') is distinct from 'array' or jsonb_array_length(payload -> 'items') = 0 then
    raise exception 'Seu pedido está vazio.' using errcode = 'P0001';
  end if;
  if jsonb_array_length(payload -> 'items') > 60 or exists (
    select 1 from jsonb_array_elements(payload -> 'items') e
    where coalesce(e ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(e ->> 'quantity', '') !~ '^[0-9]{1,3}$'
  ) then
    raise exception 'Os itens do pedido são inválidos. Atualize a página e tente de novo.' using errcode = 'P0001';
  end if;

  for v_item in
    select (e ->> 'product_id')::uuid as product_id, sum((e ->> 'quantity')::integer)::integer as qty
    from jsonb_array_elements(payload -> 'items') e
    group by 1
    order by 1
  loop
    if v_item.qty < 1 or v_item.qty > 99 then
      raise exception 'Quantidade inválida no pedido.' using errcode = 'P0001';
    end if;

    select * into v_product from public.products p where p.id = v_item.product_id for update;
    if not found or not v_product.active or (
      v_product.category_id is not null
      and not exists (select 1 from public.categories c where c.id = v_product.category_id and c.active)
    ) then
      raise exception 'Um produto do seu pedido não está mais disponível. Atualize a página.' using errcode = 'P0001';
    end if;
    if v_product.sold_out then
      raise exception '% está esgotado. Remova do pedido para continuar.', v_product.name using errcode = 'P0001';
    end if;
    if v_product.stock is not null and v_product.stock < v_item.qty then
      raise exception 'Temos só % unidade(s) de %.', v_product.stock, v_product.name using errcode = 'P0001';
    end if;

    v_unit := coalesce(v_product.promo_price, v_product.price);
    v_subtotal := v_subtotal + v_unit * v_item.qty;
    v_ids := v_ids || v_product.id;
    v_names := v_names || v_product.name;
    v_qtys := v_qtys || v_item.qty;
    v_units := v_units || v_unit;

    if v_product.stock is not null then
      update public.products set stock = stock - v_item.qty where id = v_product.id;
    end if;
  end loop;

  -- Taxa de entrega: por bairro (quando há bairros cadastrados) ou taxa única.
  if v_type = 'delivery' then
    if exists (select 1 from public.delivery_zones z where z.active) then
      select z.fee into v_fee
      from public.delivery_zones z
      where z.active and lower(btrim(z.name)) = lower(v_neighborhood);
      if not found then
        raise exception 'Ainda não entregamos no bairro %. Escolha um bairro da lista ou retire na loja.', v_neighborhood
          using errcode = 'P0001';
      end if;
    else
      v_fee := s.delivery_fee;
    end if;
    if v_subtotal < s.min_order then
      raise exception 'O pedido mínimo para entrega é %.', public.format_brl(s.min_order) using errcode = 'P0001';
    end if;
  end if;

  v_total := v_subtotal + v_fee;

  if v_payment = 'cash' and v_change_text is not null then
    if v_change_text !~ '^[0-9]{1,6}([.,][0-9]{1,2})?$' then
      raise exception 'Confira o valor do troco.' using errcode = 'P0001';
    end if;
    v_change := replace(v_change_text, ',', '.')::numeric;
    if v_change < v_total then
      raise exception 'O troco precisa ser para um valor igual ou maior que o total (%).', public.format_brl(v_total)
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.orders (
    customer_name, customer_phone, customer_email, delivery_type,
    address, address_number, neighborhood, complement, reference, notes,
    subtotal, delivery_fee, discount, total, payment_method, change_for
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change
  )
  returning * into v_order;

  insert into public.order_items (order_id, product_id, product_name, quantity, unit_price, total_price)
  select v_order.id, x.id, x.name, x.qty, x.unit, x.unit * x.qty
  from unnest(v_ids, v_names, v_qtys, v_units) as x (id, name, qty, unit);

  return public.get_public_order(v_order.public_token);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Status do pedido: histórico (quem mudou e quando), estoque devolvido no cancelamento.
-- ---------------------------------------------------------------------------------------------

create or replace function public.orders_guard_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.order_status = 'cancelled' and new.order_status <> 'cancelled' then
    raise exception 'Este pedido foi cancelado e não pode ser reaberto.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger orders_guard_status before update of order_status on public.orders
  for each row execute function public.orders_guard_status();

create or replace function public.orders_log_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
begin
  if tg_op = 'INSERT' then
    insert into public.order_status_history (order_id, from_status, to_status, changed_by_name)
    values (new.id, null, new.order_status, 'Cliente (site)');
    return new;
  end if;

  if new.order_status is distinct from old.order_status then
    select a.name into v_name from public.admin_users a where a.user_id = (select auth.uid());
    insert into public.order_status_history (order_id, from_status, to_status, changed_by, changed_by_name)
    values (new.id, old.order_status, new.order_status, (select auth.uid()), coalesce(v_name, 'Sistema'));

    if new.order_status = 'cancelled' then
      update public.products p
      set stock = p.stock + i.qty
      from (
        select product_id, sum(quantity)::integer as qty
        from public.order_items
        where order_id = new.id and product_id is not null
        group by product_id
      ) i
      where p.id = i.product_id and p.stock is not null;
    end if;
  end if;
  return new;
end;
$$;

create trigger orders_log_status_insert after insert on public.orders
  for each row execute function public.orders_log_status();
create trigger orders_log_status_update after update of order_status on public.orders
  for each row execute function public.orders_log_status();

-- ---------------------------------------------------------------------------------------------
-- Estoque: + adicionar / − retirar (atômico, não deixa ficar negativo)
-- ---------------------------------------------------------------------------------------------

create or replace function public.adjust_stock(p_product uuid, p_delta integer)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_stock integer;
begin
  if not public.is_admin() then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_delta = 0 or abs(p_delta) > 100000 then
    raise exception 'Quantidade inválida.' using errcode = 'P0001';
  end if;
  update public.products
  set stock = coalesce(stock, 0) + p_delta
  where id = p_product and coalesce(stock, 0) + p_delta >= 0
  returning stock into v_stock;
  if not found then
    if exists (select 1 from public.products where id = p_product) then
      raise exception 'Não dá para retirar mais do que o estoque atual.' using errcode = 'P0001';
    end if;
    raise exception 'Produto não encontrado.' using errcode = 'P0001';
  end if;
  return v_stock;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Dashboard: números do dia/semana/mês, séries para os gráficos e produtos mais vendidos.
-- Faturamento = pedidos não cancelados. Datas no fuso da loja.
-- ---------------------------------------------------------------------------------------------

create or replace function public.admin_dashboard(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tz text;
  now_local timestamp;
  today_local timestamp;
  today_start timestamptz;
  week_start timestamptz;
  month_start timestamptz;
  range_start timestamptz;
  v_cards jsonb;
  v_range jsonb;
  v_series jsonb;
  v_top jsonb;
begin
  if not public.is_admin() then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_days is null or p_days not in (1, 7, 30) then
    p_days := 7;
  end if;

  select s.timezone into tz from public.store_settings s where s.id = 1;
  tz := coalesce(tz, 'America/Sao_Paulo');
  now_local := now() at time zone tz;
  today_local := date_trunc('day', now_local);
  today_start := today_local at time zone tz;
  week_start := date_trunc('week', now_local) at time zone tz;
  month_start := date_trunc('month', now_local) at time zone tz;
  range_start := (today_local - make_interval(days => p_days - 1)) at time zone tz;

  select jsonb_build_object(
    'today_orders', count(*) filter (where o.created_at >= today_start),
    'pending', count(*) filter (where o.order_status = 'new'),
    'confirmed', count(*) filter (where o.order_status = 'confirmed'),
    'preparing', count(*) filter (where o.order_status = 'preparing'),
    'out_for_delivery', count(*) filter (where o.order_status = 'out_for_delivery'),
    'delivered_today', count(*) filter (where o.order_status = 'delivered' and o.created_at >= today_start),
    'cancelled_today', count(*) filter (where o.order_status = 'cancelled' and o.created_at >= today_start),
    'revenue_today', coalesce(sum(o.total) filter (where o.created_at >= today_start and o.order_status <> 'cancelled'), 0),
    'revenue_week', coalesce(sum(o.total) filter (where o.created_at >= week_start and o.order_status <> 'cancelled'), 0),
    'revenue_month', coalesce(sum(o.total) filter (where o.created_at >= month_start and o.order_status <> 'cancelled'), 0)
  ) into v_cards
  from public.orders o
  where o.created_at >= least(week_start, month_start)
     or o.order_status in ('new', 'confirmed', 'preparing', 'out_for_delivery');

  select jsonb_build_object(
    'days', p_days,
    'orders', count(*),
    'revenue', coalesce(sum(o.total), 0),
    'average_ticket', coalesce(round(avg(o.total), 2), 0)
  ) into v_range
  from public.orders o
  where o.created_at >= range_start and o.order_status <> 'cancelled';

  select coalesce(jsonb_agg(jsonb_build_object(
    'bucket', to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI'),
    'orders', b.orders,
    'revenue', b.revenue
  ) order by b.bucket), '[]'::jsonb) into v_series
  from (
    select g.bucket, count(o.id) as orders, coalesce(sum(o.total), 0) as revenue
    from generate_series(
      case when p_days = 1 then today_local else today_local - make_interval(days => p_days - 1) end,
      case when p_days = 1 then today_local + interval '23 hours' else today_local end,
      case when p_days = 1 then interval '1 hour' else interval '1 day' end
    ) as g (bucket)
    left join public.orders o
      on o.created_at >= range_start
      and o.order_status <> 'cancelled'
      and date_trunc(case when p_days = 1 then 'hour' else 'day' end, o.created_at at time zone tz) = g.bucket
    group by g.bucket
  ) b;

  select coalesce(jsonb_agg(t order by t.quantity desc, t.revenue desc), '[]'::jsonb) into v_top
  from (
    select
      (array_agg(i.product_name order by o.created_at desc))[1] as name,
      sum(i.quantity)::integer as quantity,
      sum(i.total_price) as revenue
    from public.order_items i
    join public.orders o on o.id = i.order_id
    where o.created_at >= range_start and o.order_status <> 'cancelled'
    group by coalesce(i.product_id::text, i.product_name)
    order by quantity desc, revenue desc
    limit 5
  ) t;

  return jsonb_build_object(
    'timezone', tz,
    'cards', v_cards,
    'range', v_range,
    'series', v_series,
    'top_products', v_top
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Equipe: o owner adiciona um administrador pelo e-mail de uma conta já criada no Supabase Auth.
-- ---------------------------------------------------------------------------------------------

create or replace function public.add_admin(p_email text, p_name text, p_role text default 'admin')
returns public.admin_users
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_row public.admin_users;
begin
  if not public.is_owner() then
    raise exception 'Só o owner pode adicionar administradores.' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'admin') then
    raise exception 'Função inválida.' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Informe o nome.' using errcode = 'P0001';
  end if;
  select u.id into v_user from auth.users u where lower(u.email) = lower(btrim(p_email));
  if not found then
    raise exception 'Nenhuma conta com esse e-mail. Crie o usuário em Authentication → Users no Supabase e tente de novo.'
      using errcode = 'P0001';
  end if;
  insert into public.admin_users (user_id, name, email, role, active)
  values (v_user, btrim(p_name), lower(btrim(p_email)), p_role, true)
  on conflict (user_id) do update set name = excluded.name, role = excluded.role, active = true
  returning * into v_row;
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Quem pode chamar cada função pela API
-- ---------------------------------------------------------------------------------------------

revoke execute on function
  public.store_open_now(),
  public.get_public_order(uuid),
  public.format_brl(numeric),
  public.create_order(jsonb),
  public.orders_guard_status(),
  public.orders_log_status(),
  public.adjust_stock(uuid, integer),
  public.admin_dashboard(integer),
  public.add_admin(text, text, text)
from public, anon, authenticated;

grant execute on function public.store_open_now() to anon, authenticated;
grant execute on function public.get_public_order(uuid) to anon, authenticated;
grant execute on function public.create_order(jsonb) to anon, authenticated;
grant execute on function public.adjust_stock(uuid, integer) to authenticated;
grant execute on function public.admin_dashboard(integer) to authenticated;
grant execute on function public.add_admin(text, text, text) to authenticated;
-- Usada na validação de store_settings quando um administrador salva o horário.
grant execute on function public.valid_opening_hours(jsonb) to authenticated;
