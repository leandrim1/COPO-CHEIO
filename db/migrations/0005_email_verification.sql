-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 5/5 · Confirmação obrigatória do e-mail das contas de clientes.
--
-- • A conta nasce "pending_verification" e só passa a "active" quando o cliente prova que lê aquela caixa de
--   e-mail (código de 6 dígitos ou link enviados pelo servidor). Antes disso não há login nem acesso autenticado.
-- • Códigos e links ficam no banco só como hash, com validade, uso único, limite de tentativas e de reenvios.
-- • Contas criadas antes desta migration NÃO foram confirmadas: viram "pending_verification", perdem as sessões
--   abertas e confirmam no próximo login. Têm 30 dias; sem pedidos e sem confirmar, depois disso são apagadas.

alter table customers add column email_verified_at timestamptz;
-- statement-breakpoint

-- Prazo para confirmar o e-mail; passado o prazo, conta pendente e sem pedidos é apagada (purge_expired_data).
alter table customers add column verify_by timestamptz not null default now() + interval '7 days';
-- statement-breakpoint

-- Contas que já existiam ganham mais prazo.
update customers set verify_by = now() + interval '30 days';
-- statement-breakpoint

-- Status legível, sempre coerente com os dois campos que o definem (não dá para ficar fora de sincronia).
alter table customers add column status text generated always as (
  case
    when not active then 'disabled'
    when email_verified_at is null then 'pending_verification'
    else 'active'
  end
) stored;
-- statement-breakpoint

-- Sessões abertas antes da migration não valem mais.
delete from customer_sessions;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Códigos e links de confirmação
-- ---------------------------------------------------------------------------------------------

create table email_verifications (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  -- Endereço (normalizado) para o qual o código foi enviado: o código só vale para ele.
  email text not null,
  -- HMAC do código de 6 dígitos e SHA-256 do token do link: os valores em si nunca são gravados.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  link_hash text not null unique check (link_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz not null,
  link_expires_at timestamptz not null,
  -- Tentativas erradas com este código; ao chegar no máximo ele deixa de valer.
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  used_at timestamptz,
  invalidated_at timestamptz,
  -- Preenchido quando o servidor de e-mail aceita a mensagem. Só linhas enviadas contam para o limite de reenvios.
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index email_verifications_customer_idx on email_verifications (customer_id, created_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedir um código novo. Tudo dentro do banco para valer mesmo com pedidos simultâneos:
-- espera de 60 s entre envios, no máximo 5 por hora e 10 por dia por conta.
-- Os códigos anteriores só são invalidados depois que o novo e-mail foi realmente enviado (finish_email_verification).
-- ---------------------------------------------------------------------------------------------

create or replace function begin_email_verification(
  p_customer uuid,
  p_code_hash text,
  p_link_hash text,
  p_code_minutes integer default 15,
  p_link_hours integer default 24
)
returns jsonb
language plpgsql
as $$
declare
  c customers;
  v_last timestamptz;
  v_hour integer;
  v_day integer;
  v_id uuid;
begin
  -- Serializa os pedidos de código da mesma conta.
  select * into c from customers where id = p_customer for update;
  if not found or c.email_verified_at is not null or not c.active then
    return jsonb_build_object('ok', false, 'reason', 'not_pending');
  end if;

  select max(coalesce(sent_at, created_at)) into v_last
  from email_verifications
  where customer_id = c.id and (sent_at is not null or created_at > now() - interval '20 seconds');
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object(
      'ok', false, 'reason', 'cooldown',
      'retry_after', greatest(1, ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::integer)
    );
  end if;

  select count(*) filter (where sent_at > now() - interval '1 hour'),
         count(*) filter (where sent_at > now() - interval '24 hours')
    into v_hour, v_day
  from email_verifications
  where customer_id = c.id;
  if v_hour >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;
  if v_day >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'daily');
  end if;

  insert into email_verifications (customer_id, email, code_hash, link_hash, code_expires_at, link_expires_at)
  values (c.id, c.email, p_code_hash, p_link_hash, now() + make_interval(mins => p_code_minutes), now() + make_interval(hours => p_link_hours))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

-- Resultado do envio: enviado → vale o código novo e os anteriores deixam de valer; falhou → o código novo é descartado
-- e o que a pessoa já tinha continua valendo.
create or replace function finish_email_verification(p_id uuid, p_sent boolean)
returns void
language plpgsql
as $$
declare
  v_customer uuid;
begin
  select customer_id into v_customer from email_verifications where id = p_id;
  if not found then
    return;
  end if;
  if p_sent then
    update email_verifications set sent_at = now() where id = p_id and sent_at is null;
    update email_verifications
       set invalidated_at = now()
     where customer_id = v_customer and id <> p_id and used_at is null and invalidated_at is null;
    update customers set verify_by = greatest(verify_by, now() + interval '7 days') where id = v_customer;
  else
    delete from email_verifications where id = p_id and sent_at is null;
  end if;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Confirmar com o código de 6 dígitos. Devolve 'ok', 'invalid' ou 'locked' (tentativas esgotadas).
-- "invalid" cobre código errado, vencido, já usado, substituído, de outro e-mail ou conta que não existe:
-- quem tenta não descobre qual foi o motivo.
-- ---------------------------------------------------------------------------------------------

create or replace function verify_email_code(p_email text, p_hash text)
returns text
language plpgsql
as $$
declare
  c customers;
  v email_verifications;
begin
  select * into c from customers where lower(email) = lower(p_email);
  if not found or c.email_verified_at is not null or not c.active then
    return 'invalid';
  end if;

  select * into v
  from email_verifications
  where customer_id = c.id and sent_at is not null and used_at is null and invalidated_at is null
  order by created_at desc
  limit 1
  for update;
  if not found or v.code_expires_at <= now() or v.email <> c.email then
    return 'invalid';
  end if;

  if v.attempts >= v.max_attempts then
    update email_verifications set invalidated_at = now() where id = v.id;
    return 'locked';
  end if;

  if v.code_hash = p_hash then
    update email_verifications set used_at = now() where id = v.id;
    update email_verifications
       set invalidated_at = now()
     where customer_id = c.id and id <> v.id and used_at is null and invalidated_at is null;
    update customers set email_verified_at = now() where id = c.id;
    return 'ok';
  end if;

  update email_verifications
     set attempts = attempts + 1,
         invalidated_at = case when attempts + 1 >= max_attempts then now() else null end
   where id = v.id;
  return case when v.attempts + 1 >= v.max_attempts then 'locked' else 'invalid' end;
end;
$$;
-- statement-breakpoint

-- Confirmar pelo link do e-mail (token de 256 bits; o banco só tem o hash). Devolve o e-mail confirmado ou null.
create or replace function verify_email_link(p_hash text)
returns text
language plpgsql
as $$
declare
  v email_verifications;
  c customers;
begin
  select * into v
  from email_verifications
  where link_hash = p_hash and sent_at is not null and used_at is null and invalidated_at is null and link_expires_at > now()
  for update;
  if not found then
    return null;
  end if;

  select * into c from customers where id = v.customer_id for update;
  if not found or c.email_verified_at is not null or not c.active or v.email <> c.email then
    return null;
  end if;

  update email_verifications set used_at = now() where id = v.id;
  update email_verifications
     set invalidated_at = now()
   where customer_id = c.id and id <> v.id and used_at is null and invalidated_at is null;
  update customers set email_verified_at = now() where id = c.id;
  return c.email;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Funções de conta que só valem para e-mail confirmado (defesa extra: o servidor já confere).
-- ---------------------------------------------------------------------------------------------

create or replace function get_customer_order(p_customer uuid, p_number bigint)
returns jsonb
language sql
stable
as $$
  select order_json(o.id, true)
  from orders o
  where o.customer_id = p_customer
    and o.order_number = p_number
    and exists (select 1 from customers c where c.id = p_customer and c.active and c.email_verified_at is not null);
$$;
-- statement-breakpoint

create or replace function claim_order(p_customer uuid, p_number bigint, p_hash text)
returns jsonb
language plpgsql
as $$
declare
  c customers;
  o orders;
begin
  select * into c from customers where id = p_customer and active and email_verified_at is not null;
  if not found then
    raise exception 'Faça login para vincular o pedido à sua conta.' using errcode = 'P0001';
  end if;

  select o2.* into o
  from orders o2
  join order_tracking_tokens t on t.order_id = o2.id
  join store_settings s on s.id = 1
  where o2.order_number = p_number
    and t.token_hash = p_hash
    and t.revoked_at is null
    and o2.updated_at > now() - make_interval(days => s.tracking_retention_days)
  for update of o2;

  -- Pedido inexistente, código errado, vencido ou de outra conta: a mesma resposta.
  if not found or (o.customer_id is not null and o.customer_id <> p_customer) then
    raise exception 'Não encontramos um pedido com esses dados. Confira o número e o código.' using errcode = 'P0001';
  end if;
  if o.customer_id = p_customer then
    return order_json(o.id, true);
  end if;

  if phone_key(o.customer_phone) <> phone_key(c.phone)
     and (o.customer_email is null or lower(o.customer_email) <> lower(c.email)) then
    raise exception 'Esse pedido foi feito com outro telefone e e-mail. Para vinculá-lo, o telefone ou o e-mail da sua conta precisa ser o mesmo do pedido.'
      using errcode = 'P0001';
  end if;

  update orders set customer_id = p_customer, customer_linked_at = now() where id = o.id;
  return order_json(o.id, true);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Limpeza de dados técnicos vencidos. Agora também: códigos de confirmação já usados/vencidos e contas que
-- nunca confirmaram o e-mail (sem pedidos) depois do prazo.
-- ---------------------------------------------------------------------------------------------

create or replace function purge_expired_data()
returns void
language plpgsql
as $$
begin
  delete from customer_sessions where expires_at < now();
  delete from admin_sessions where expires_at < now();
  delete from customer_password_resets where expires_at < now() - interval '1 day' or used_at < now() - interval '7 days';
  delete from rate_limits where created_at < now() - interval '1 day';
  delete from order_tracking_tokens where revoked_at < now() - interval '30 days';
  delete from order_tracking_tokens t
  using orders o, store_settings s
  where o.id = t.order_id and s.id = 1
    and o.updated_at < now() - make_interval(days => s.tracking_retention_days + 30);
  delete from email_verifications
  where created_at < now() - interval '2 days'
    and (used_at is not null or invalidated_at is not null or link_expires_at < now() or sent_at is null);
  delete from customers c
  where c.email_verified_at is null
    and c.verify_by < now()
    and not exists (select 1 from orders o where o.customer_id = c.id);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Criar pedido: só liga o pedido a uma conta ativa com e-mail confirmado (o resto é igual à migration anterior).
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
begin
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

    v_unit := coalesce(v_product.promo_price, v_product.price);
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
    customer_id, customer_linked_at
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change,
    v_customer, case when v_customer is null then null else now() end
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
