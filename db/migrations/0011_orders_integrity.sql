-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 11/12 · Pedidos: sem duplicidade, sem preço trocado em silêncio, estados coerentes, estoque e dashboard honestos.
--
-- • create_order: chave de idempotência (o mesmo envio repetido devolve o mesmo pedido, não cria outro) e conferência do total
--   que o cliente viu (se mudou, o pedido NÃO é criado e o site mostra o valor novo para a pessoa confirmar). Também passa a usar o
--   preço promocional só dentro da janela de datas. A assinatura continua create_order(payload jsonb): quem não manda os campos
--   novos (a versão anterior do site, durante o deploy) segue funcionando igual.
-- • admin_set_order_status: pedido entregue ou cancelado não volta para o início e entregue não pode ser cancelado (o estoque
--   já saiu da loja); só se volta uma etapa de cada vez.
-- • admin_set_payment_status: regras do pagamento (cancelado não vira "pago"; reembolso só de pedido pago).
-- • adjust_stock: mexer na quantidade de um produto sem controle de estoque agora exige ativar o controle de propósito.
-- • admin_dashboard: "pedidos de hoje" sem cancelados, faturamento sem reembolsados e "concluídos hoje" pela data da entrega.

alter table orders
  add column idempotency_key text check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9_-]{16,64}$'),
  add column request_hash text check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
-- statement-breakpoint

create unique index orders_idempotency_key on orders (idempotency_key) where idempotency_key is not null;
-- statement-breakpoint

create index order_status_history_status_idx on order_status_history (to_status, created_at);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Criar pedido
-- ---------------------------------------------------------------------------------------------

create or replace function create_order(payload jsonb)
returns jsonb
language plpgsql
volatile
as $$
declare
  s store_settings;
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
  v_product products;
  v_unit numeric(10, 2);
  v_ids uuid[] := '{}';
  v_names text[] := '{}';
  v_qtys integer[] := '{}';
  v_units numeric[] := '{}';
  v_order orders;
  v_hash text := coalesce(payload ->> 'tracking_hash', '');
  v_customer uuid := nullif(payload ->> 'customer_id', '')::uuid;
  v_legacy uuid;
  v_key text := nullif(btrim(coalesce(payload ->> 'idempotency_key', '')), '');
  v_expected_text text := nullif(btrim(coalesce(payload ->> 'expected_total', '')), '');
  v_expected numeric(10, 2);
  v_request_hash text;
  v_existing orders;
begin
  -- Envio repetido: a mesma chave devolve o pedido que já existe (sem tocar em estoque nem em nada). Vem antes de qualquer
  -- regra da loja de propósito: se a primeira tentativa funcionou e só a resposta se perdeu, a pessoa precisa ver o pedido
  -- mesmo que a loja tenha fechado nesse meio-tempo. A trava garante que dois envios simultâneos passem um de cada vez.
  if v_key is not null then
    if v_key !~ '^[A-Za-z0-9_-]{16,64}$' then
      raise exception 'Não foi possível identificar o envio do pedido. Atualize a página e tente de novo.' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('order-key:' || v_key, 0));
    v_request_hash := encode(
      sha256(convert_to((payload - 'tracking_hash' - 'customer_id' - 'idempotency_key' - 'expected_total')::text, 'UTF8')),
      'hex'
    );
    select * into v_existing from orders where idempotency_key = v_key;
    if found then
      if v_existing.request_hash is distinct from v_request_hash then
        raise exception 'Este envio já foi usado por um pedido diferente. Atualize a página e confira o seu pedido.'
          using errcode = 'CC409', detail = '{"code":"idempotency_conflict"}';
      end if;
      return order_json(v_existing.id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  select * into s from store_settings where id = 1;
  if not found then
    raise exception 'A loja ainda não foi configurada.' using errcode = 'P0001';
  end if;
  if s.orders_paused then
    raise exception 'A loja não está recebendo pedidos agora. Tente novamente mais tarde.' using errcode = 'P0001';
  end if;
  if not store_open_now() then
    raise exception 'Estamos fechados agora. Confira nosso horário de funcionamento.' using errcode = 'P0001';
  end if;

  -- Total que o cliente viu na tela (opcional, em reais). Se não bater com o que o banco calcular, o pedido não é criado.
  if v_expected_text is not null then
    if v_expected_text !~ '^[0-9]{1,7}([.][0-9]{1,2})?$' then
      raise exception 'Não foi possível conferir o total do pedido. Atualize a página e tente de novo.' using errcode = 'P0001';
    end if;
    v_expected := v_expected_text::numeric;
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

  -- Código de acompanhamento: o servidor gera o código e manda só o hash (SHA-256 em hex).
  -- Transitório: a versão anterior do site (que pode continuar no ar durante um deploy, ou se alguém voltar
  -- para ela) não manda o hash; nesse caso o código é um UUID (formato antigo), devolvido em "token".
  if v_hash = '' then
    v_legacy := gen_random_uuid();
    v_hash := encode(sha256(convert_to(v_legacy::text, 'UTF8')), 'hex');
  end if;
  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Não foi possível gerar o código de acompanhamento. Tente novamente.' using errcode = 'P0001';
  end if;
  -- Conta do cliente: o servidor só envia o id de uma sessão válida; conta desativada ou com e-mail não confirmado é ignorada.
  if v_customer is not null and not exists (select 1 from customers c where c.id = v_customer and c.active and c.email_verified_at is not null) then
    v_customer := null;
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
  if not exists (select 1 from payment_methods m where m.code = v_payment and m.enabled) then
    raise exception 'Escolha uma forma de pagamento disponível.' using errcode = 'P0001';
  end if;
  if v_notes is not null and char_length(v_notes) > 500 then
    raise exception 'As observações podem ter até 500 caracteres.' using errcode = 'P0001';
  end if;

  -- Proteção contra envios repetidos
  if (select count(*) from orders o
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

    select * into v_product from products p where p.id = v_item.product_id for update;
    if not found or not v_product.active or (
      v_product.category_id is not null
      and not exists (select 1 from categories c where c.id = v_product.category_id and c.active)
    ) then
      raise exception 'Um produto do seu pedido não está mais disponível. Atualize a página.' using errcode = 'P0001';
    end if;
    if v_product.sold_out then
      raise exception '% está esgotado. Remova do pedido para continuar.', v_product.name using errcode = 'P0001';
    end if;
    if v_product.stock is not null and v_product.stock < v_item.qty then
      raise exception 'Temos só % unidade(s) de %.', v_product.stock, v_product.name using errcode = 'P0001';
    end if;

    -- Promoção só vale dentro da janela de datas (sem datas, vale sempre).
    v_unit := coalesce(effective_promo(v_product.promo_price, v_product.promo_starts_at, v_product.promo_ends_at), v_product.price);
    v_subtotal := v_subtotal + v_unit * v_item.qty;
    v_ids := v_ids || v_product.id;
    v_names := v_names || v_product.name;
    v_qtys := v_qtys || v_item.qty;
    v_units := v_units || v_unit;

    if v_product.stock is not null then
      update products set stock = stock - v_item.qty where id = v_product.id;
    end if;
  end loop;

  -- Taxa de entrega: por bairro (quando há bairros cadastrados) ou taxa única.
  if v_type = 'delivery' then
    if exists (select 1 from delivery_zones z where z.active) then
      select z.fee into v_fee
      from delivery_zones z
      where z.active and lower(btrim(z.name)) = lower(v_neighborhood);
      if not found then
        raise exception 'Ainda não entregamos no bairro %. Escolha um bairro da lista ou retire na loja.', v_neighborhood
          using errcode = 'P0001';
      end if;
    else
      v_fee := s.delivery_fee;
    end if;
    if v_subtotal < s.min_order then
      raise exception 'O pedido mínimo para entrega é %.', format_brl(s.min_order) using errcode = 'P0001';
    end if;
  end if;

  v_total := v_subtotal + v_fee;

  -- O valor mudou entre a tela do cliente e o envio (preço, promoção, taxa): nada é criado (o estoque reservado acima volta
  -- junto) e o site recebe o valor atual para a pessoa confirmar de olhos abertos.
  if v_expected is not null and v_expected <> v_total then
    raise exception 'Os valores do pedido mudaram. Confira o novo total antes de enviar.'
      using errcode = 'CC409',
            detail = jsonb_build_object(
              'code', 'price_changed',
              'subtotal', v_subtotal,
              'delivery_fee', v_fee,
              'total', v_total,
              'items', (
                select coalesce(jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'quantity', x.qty, 'unit_price', x.unit) order by x.name), '[]'::jsonb)
                from unnest(v_ids, v_names, v_qtys, v_units) as x (id, name, qty, unit)
              )
            )::text;
  end if;

  if v_payment = 'cash' and v_change_text is not null then
    if v_change_text !~ '^[0-9]{1,6}([.,][0-9]{1,2})?$' then
      raise exception 'Confira o valor do troco.' using errcode = 'P0001';
    end if;
    v_change := replace(v_change_text, ',', '.')::numeric;
    if v_change < v_total then
      raise exception 'O troco precisa ser para um valor igual ou maior que o total (%).', format_brl(v_total)
        using errcode = 'P0001';
    end if;
  end if;

  insert into orders (
    customer_name, customer_phone, customer_email, delivery_type,
    address, address_number, neighborhood, complement, reference, notes,
    subtotal, delivery_fee, discount, total, payment_method, change_for,
    customer_id, customer_linked_at, idempotency_key, request_hash
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash
  )
  returning * into v_order;

  insert into order_items (order_id, product_id, product_name, quantity, unit_price, total_price)
  select v_order.id, x.id, x.name, x.qty, x.unit, x.unit * x.qty
  from unnest(v_ids, v_names, v_qtys, v_units) as x (id, name, qty, unit);

  insert into order_status_history (order_id, from_status, to_status, changed_by_name)
  values (v_order.id, null, v_order.order_status, 'Cliente (site)');

  insert into order_tracking_tokens (order_id, token_hash, source)
  values (v_order.id, v_hash, 'checkout');

  return order_json(v_order.id)
    || case when v_legacy is null then '{}'::jsonb else jsonb_build_object('token', v_legacy) end;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Status do pedido (painel).
-- Fluxo: novo → confirmado → em preparo → saiu para entrega/pronto → entregue. Cancelar vale até antes da entrega.
-- Para a frente pode pular etapas (loja pequena); para trás só uma etapa de cada vez, e "entregue" só volta para "saiu para
-- entrega" (clique por engano). Entregue não cancela: a mercadoria já saiu, então o estoque não volta (para devolver o
-- dinheiro, use o pagamento "reembolsado"). Cancelado não reabre. O estoque volta ao cancelar.
-- ---------------------------------------------------------------------------------------------

create or replace function admin_set_order_status(p_order uuid, p_status text, p_admin uuid)
returns orders
language plpgsql
as $$
declare
  v_old orders;
  v_new orders;
  v_name text;
  c_flow constant text[] := array['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
  v_from integer;
  v_to integer;
begin
  if p_status not in ('new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled') then
    raise exception 'Status inválido.' using errcode = 'P0001';
  end if;

  select * into v_old from orders where id = p_order for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'P0001';
  end if;
  if v_old.order_status = p_status then
    return v_old;
  end if;
  if v_old.order_status = 'cancelled' then
    raise exception 'Este pedido foi cancelado e não pode ser reaberto.' using errcode = 'P0001';
  end if;

  if v_old.order_status = 'delivered' then
    if p_status = 'cancelled' then
      raise exception 'Este pedido já foi entregue e não pode ser cancelado. Se o dinheiro foi devolvido, marque o pagamento como reembolsado.'
        using errcode = 'P0001';
    end if;
    if p_status <> 'out_for_delivery' then
      raise exception 'Um pedido entregue só pode voltar para "Saiu para entrega" (se o clique foi por engano).' using errcode = 'P0001';
    end if;
  elsif p_status <> 'cancelled' then
    v_from := array_position(c_flow, v_old.order_status);
    v_to := array_position(c_flow, p_status);
    if v_to < v_from - 1 then
      raise exception 'O pedido só pode voltar uma etapa de cada vez.' using errcode = 'P0001';
    end if;
  end if;

  select a.name into v_name from admins a where a.id = p_admin;

  update orders set order_status = p_status where id = p_order returning * into v_new;

  insert into order_status_history (order_id, from_status, to_status, changed_by, changed_by_name)
  values (p_order, v_old.order_status, p_status, p_admin, coalesce(v_name, 'Sistema'));

  if p_status = 'cancelled' then
    update products p
    set stock = p.stock + i.qty
    from (
      select product_id, sum(quantity)::integer as qty
      from order_items
      where order_id = p_order and product_id is not null
      group by product_id
    ) i
    where p.id = i.product_id and p.stock is not null;
  end if;

  return v_new;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pagamento do pedido (painel). Pedido cancelado não vira "pago"; só se reembolsa o que estava pago.
-- ---------------------------------------------------------------------------------------------

create or replace function admin_set_payment_status(p_order uuid, p_status text, p_admin uuid)
returns orders
language plpgsql
as $$
declare
  v_old orders;
  v_new orders;
begin
  if p_status not in ('pending', 'paid', 'refunded') then
    raise exception 'Status de pagamento inválido.' using errcode = 'P0001';
  end if;
  select * into v_old from orders where id = p_order for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'P0001';
  end if;
  if v_old.payment_status = p_status then
    return v_old;
  end if;
  if p_status = 'paid' and v_old.order_status = 'cancelled' then
    raise exception 'Este pedido foi cancelado: não dá para marcá-lo como pago. Se houve pagamento, marque como reembolsado.'
      using errcode = 'P0001';
  end if;
  if p_status = 'refunded' and v_old.payment_status <> 'paid' then
    raise exception 'Só dá para reembolsar um pedido que estava marcado como pago.' using errcode = 'P0001';
  end if;
  update orders set payment_status = p_status where id = p_order returning * into v_new;
  return v_new;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Estoque: + adicionar / − retirar (atômico, não deixa ficar negativo). Produto SEM controle de estoque só passa a ter
-- controle quando se pede isso de propósito (p_enable).
-- ---------------------------------------------------------------------------------------------

create or replace function adjust_stock_v2(p_product uuid, p_delta integer, p_enable boolean)
returns integer
language plpgsql
as $$
declare
  v_current integer;
  v_stock integer;
begin
  if p_delta = 0 or abs(p_delta) > 100000 then
    raise exception 'Quantidade inválida.' using errcode = 'P0001';
  end if;
  select stock into v_current from products where id = p_product for update;
  if not found then
    raise exception 'Produto não encontrado.' using errcode = 'P0001';
  end if;
  if v_current is null and not p_enable then
    raise exception 'Este produto não controla estoque. Ative o controle para informar a quantidade.' using errcode = 'P0001';
  end if;
  if coalesce(v_current, 0) + p_delta < 0 then
    raise exception 'Não dá para retirar mais do que o estoque atual.' using errcode = 'P0001';
  end if;
  update products set stock = coalesce(stock, 0) + p_delta where id = p_product returning stock into v_stock;
  return v_stock;
end;
$$;
-- statement-breakpoint

create or replace function adjust_stock(p_product uuid, p_delta integer)
returns integer
language sql
as $$
  select adjust_stock_v2(p_product, p_delta, false);
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Dashboard: números do dia/semana/mês, séries para os gráficos e produtos mais vendidos. Datas no fuso da loja.
-- "Venda" = pedido não cancelado e não reembolsado (inclui o que ainda vai ser pago na entrega).
-- "Concluídos hoje" = entregues hoje (pela data da entrega, não a do pedido).
-- ---------------------------------------------------------------------------------------------

create or replace function admin_dashboard(p_days integer default 7)
returns jsonb
language plpgsql
stable
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
  v_delivered integer;
  v_cancelled integer;
begin
  if p_days is null or p_days not in (1, 7, 30) then
    p_days := 7;
  end if;

  select s.timezone into tz from store_settings s where s.id = 1;
  tz := coalesce(tz, 'America/Sao_Paulo');
  now_local := now() at time zone tz;
  today_local := date_trunc('day', now_local);
  today_start := today_local at time zone tz;
  week_start := date_trunc('week', now_local) at time zone tz;
  month_start := date_trunc('month', now_local) at time zone tz;
  range_start := (today_local - make_interval(days => p_days - 1)) at time zone tz;

  select count(distinct h.order_id) into v_delivered
  from order_status_history h
  join orders o on o.id = h.order_id
  where h.to_status = 'delivered' and o.order_status = 'delivered' and h.created_at >= today_start;

  select count(distinct h.order_id) into v_cancelled
  from order_status_history h
  join orders o on o.id = h.order_id
  where h.to_status = 'cancelled' and o.order_status = 'cancelled' and h.created_at >= today_start;

  select jsonb_build_object(
    'today_orders', count(*) filter (where o.created_at >= today_start and o.order_status <> 'cancelled'),
    'pending', count(*) filter (where o.order_status = 'new'),
    'confirmed', count(*) filter (where o.order_status = 'confirmed'),
    'preparing', count(*) filter (where o.order_status = 'preparing'),
    'out_for_delivery', count(*) filter (where o.order_status = 'out_for_delivery'),
    'delivered_today', v_delivered,
    'cancelled_today', v_cancelled,
    'revenue_today', coalesce(sum(o.total) filter (where o.created_at >= today_start and o.order_status <> 'cancelled' and o.payment_status <> 'refunded'), 0),
    'revenue_week', coalesce(sum(o.total) filter (where o.created_at >= week_start and o.order_status <> 'cancelled' and o.payment_status <> 'refunded'), 0),
    'revenue_month', coalesce(sum(o.total) filter (where o.created_at >= month_start and o.order_status <> 'cancelled' and o.payment_status <> 'refunded'), 0)
  ) into v_cards
  from orders o
  where o.created_at >= least(week_start, month_start)
     or o.order_status in ('new', 'confirmed', 'preparing', 'out_for_delivery');

  select jsonb_build_object(
    'days', p_days,
    'orders', count(*),
    'revenue', coalesce(sum(o.total), 0),
    'average_ticket', coalesce(round(avg(o.total), 2), 0)
  ) into v_range
  from orders o
  where o.created_at >= range_start and o.order_status <> 'cancelled' and o.payment_status <> 'refunded';

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
    left join orders o
      on o.created_at >= range_start
      and o.order_status <> 'cancelled'
      and o.payment_status <> 'refunded'
      and date_trunc(case when p_days = 1 then 'hour' else 'day' end, o.created_at at time zone tz) = g.bucket
    group by g.bucket
  ) b;

  select coalesce(jsonb_agg(t order by t.quantity desc, t.revenue desc), '[]'::jsonb) into v_top
  from (
    select
      (array_agg(i.product_name order by o.created_at desc))[1] as name,
      sum(i.quantity)::integer as quantity,
      sum(i.total_price) as revenue
    from order_items i
    join orders o on o.id = i.order_id
    where o.created_at >= range_start and o.order_status <> 'cancelled' and o.payment_status <> 'refunded'
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
