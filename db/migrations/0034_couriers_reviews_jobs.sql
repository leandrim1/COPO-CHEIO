-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 34/34 · Entregadores, avaliações dos pedidos e registro das rotinas automáticas.
--
-- • couriers: quem entrega (nome e telefone). orders.courier_id / courier_name: o entregador do pedido; o NOME fica gravado no pedido (apagar ou renomear o entregador
--   depois não muda o histórico).
-- • order_reviews: uma avaliação por pedido entregue (nota de 1 a 5 e comentário opcional). Nasce "pending" (aguardando a loja): só aparece no site depois que a loja
--   publica. Não guarda nome nem telefone da pessoa: no site aparece só a nota, o comentário e a data.
-- • job_runs: a última vez que cada rotina automática (varredura de pagamentos vencidos, fila de e-mail, limpeza) rodou e se deu certo; o painel mostra isso.
--
-- Só acrescenta tabelas e colunas (com padrão vazio). Nada existente é alterado.

create table couriers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 60),
  phone text check (phone is null or phone ~ '^[0-9]{10,13}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create trigger couriers_updated_at before update on couriers
  for each row execute function set_updated_at();
-- statement-breakpoint

alter table orders
  add column courier_id uuid references couriers (id) on delete set null,
  add column courier_name text check (courier_name is null or char_length(courier_name) <= 60);
-- statement-breakpoint

create table order_reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders (id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 500),
  status text not null default 'pending' check (status in ('pending', 'published', 'hidden')),
  moderated_by uuid references admins (id) on delete set null,
  moderated_at timestamptz,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index order_reviews_status_idx on order_reviews (status, created_at desc);
-- statement-breakpoint

create table job_runs (
  name text primary key check (char_length(name) between 2 and 40),
  last_run_at timestamptz not null default now(),
  ok boolean not null default true,
  detail text check (detail is null or char_length(detail) <= 300)
);
-- statement-breakpoint

-- O pedido (pelo código de acompanhamento ou pela conta) está entregue e já foi avaliado? { delivered, review: { rating, comment, status } | null }. null = pedido não encontrado.
create or replace function review_of(p_hash text, p_number bigint, p_customer uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  o orders;
  r order_reviews;
begin
  if p_customer is not null then
    select o2.* into o from orders o2 where o2.customer_id = p_customer and o2.order_number = p_number;
  else
    select o2.* into o
      from orders o2
      join order_tracking_tokens t on t.order_id = o2.id
      join store_settings s on s.id = 1
     where t.token_hash = p_hash
       and t.revoked_at is null
       and (p_number is null or o2.order_number = p_number)
       and o2.updated_at > now() - make_interval(days => s.tracking_retention_days);
  end if;
  if not found then
    return null;
  end if;
  select * into r from order_reviews where order_id = o.id;
  return jsonb_build_object(
    'delivered', o.order_status = 'delivered',
    'review', case when r.id is null then null else jsonb_build_object('rating', r.rating, 'comment', r.comment, 'status', r.status) end
  );
end;
$$;
-- statement-breakpoint

-- O cliente avalia o pedido ENTREGUE, uma única vez (repetir devolve a avaliação que já existe). A avaliação nasce "pending": a loja decide se publica.
create or replace function review_submit(p_hash text, p_number bigint, p_customer uuid, p_rating integer, p_comment text)
returns jsonb
language plpgsql
volatile
as $$
declare
  o orders;
  r order_reviews;
  v_comment text := nullif(left(btrim(regexp_replace(coalesce(p_comment, ''), '[[:cntrl:]]', ' ', 'g')), 500), '');
begin
  if p_rating is null or p_rating < 1 or p_rating > 5 then
    raise exception 'Escolha uma nota de 1 a 5.' using errcode = 'P0001';
  end if;
  if p_customer is not null then
    select o2.* into o from orders o2 where o2.customer_id = p_customer and o2.order_number = p_number;
  else
    select o2.* into o
      from orders o2
      join order_tracking_tokens t on t.order_id = o2.id
      join store_settings s on s.id = 1
     where t.token_hash = p_hash
       and t.revoked_at is null
       and (p_number is null or o2.order_number = p_number)
       and o2.updated_at > now() - make_interval(days => s.tracking_retention_days);
  end if;
  if not found then
    return null;
  end if;
  if o.order_status <> 'delivered' then
    raise exception 'Você pode avaliar o pedido depois que ele for entregue.' using errcode = 'P0001';
  end if;
  insert into order_reviews (order_id, rating, comment) values (o.id, p_rating, v_comment)
  on conflict (order_id) do nothing
  returning * into r;
  if not found then
    select * into r from order_reviews where order_id = o.id;
    return jsonb_build_object('already', true, 'rating', r.rating, 'comment', r.comment, 'status', r.status);
  end if;
  return jsonb_build_object('already', false, 'rating', r.rating, 'comment', r.comment, 'status', r.status);
end;
$$;
-- statement-breakpoint

create or replace function order_json(p_order uuid, p_ids boolean default false)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
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
    'payment_fee', o.payment_fee,
    'total', o.total,
    'created_at', o.created_at,
    'updated_at', o.updated_at,
    'linked', o.customer_id is not null,
    -- Pedido com bebida alcoólica: o documento com foto será conferido na entrega ou na retirada.
    'age_check_required', o.age_required,
    -- Cancelamento pelo cliente: allowed = pode cancelar agora; why = por que não (ver order_cancel_why).
    'cancel', jsonb_build_object('allowed', order_cancel_why(o) is null, 'why', order_cancel_why(o)),
    'retention_days', (select s.tracking_retention_days from store_settings s where s.id = 1),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product_name', i.product_name,
          'quantity', i.quantity,
          'unit_price', i.unit_price,
          'total_price', i.total_price
        ) || case when i.ice_choice is not null then jsonb_build_object('ice_choice', i.ice_choice) else '{}'::jsonb end
          || case when p_ids then jsonb_build_object('product_id', i.product_id) else '{}'::jsonb end
          || case when p_ids and i.swap_to_product_id is not null then jsonb_build_object('swap_to_product_id', i.swap_to_product_id) else '{}'::jsonb end
        order by i.created_at, i.product_name, i.ice_choice nulls first
      )
      from order_items i
      where i.order_id = o.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from order_status_history h
      where h.order_id = o.id
    ), '[]'::jsonb)
  ) || case when o.coupon_code is not null then jsonb_build_object('coupon_code', o.coupon_code) else '{}'::jsonb end
    || case when o.delivery_fee_waived > 0 then jsonb_build_object('delivery_fee_waived', o.delivery_fee_waived) else '{}'::jsonb end
    || case when o.scheduled_for is not null then jsonb_build_object('scheduled_for', o.scheduled_for) else '{}'::jsonb end
    -- Entregador: o cliente vê só o primeiro nome, e só enquanto o pedido está a caminho.
    || case when o.courier_name is not null and o.order_status = 'out_for_delivery' then jsonb_build_object('courier_name', split_part(o.courier_name, ' ', 1)) else '{}'::jsonb end
    || case
    when exists (select 1 from payments p where p.order_id = o.id) then jsonb_build_object('payment', (
      select jsonb_build_object('method', p.method, 'status', p.status, 'expires_at', p.expires_at, 'paid_at', p.paid_at, 'attempt', p.attempt)
      from payments p
      where p.order_id = o.id
      order by p.created_at desc
      limit 1
    ))
    else '{}'::jsonb
  end
  from orders o
  where o.id = p_order;
$$;
