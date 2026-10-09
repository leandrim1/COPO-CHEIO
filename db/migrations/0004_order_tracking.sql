-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 4/4 · Acompanhamento permanente de pedidos e contas de clientes.
--
-- • Cada pedido ganha um código de acompanhamento secreto. Só o HASH (SHA-256) dele fica no banco, na
--   tabela order_tracking_tokens; quem gera o código é o servidor, e ele só aparece para o cliente.
-- • Os pedidos que já existem continuam acessíveis: o UUID secreto dos links /pedido/:id já enviados
--   vira hash aqui mesmo (migração de dados) e a coluna orders.public_token deixa de existir.
-- • Contas de clientes são opcionais: orders.customer_id fica vazio para pedidos de visitantes.

-- ---------------------------------------------------------------------------------------------
-- Retenção: por quantos dias, depois da última atualização do pedido, o link continua valendo.
-- ---------------------------------------------------------------------------------------------

alter table store_settings
  add column tracking_retention_days integer not null default 180
    check (tracking_retention_days between 7 and 3650);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Clientes (login opcional), sessões e redefinição de senha
-- ---------------------------------------------------------------------------------------------

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  email text not null check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Só números (DDD + número; pode vir com 55).
  phone text not null check (phone ~ '^[0-9]{10,13}$'),
  password_hash text not null,
  active boolean not null default true,
  -- Endereço guardado para o próximo pedido (opcional).
  address text check (address is null or char_length(address) <= 120),
  address_number text check (address_number is null or char_length(address_number) <= 20),
  neighborhood text check (neighborhood is null or char_length(neighborhood) <= 60),
  complement text check (complement is null or char_length(complement) <= 60),
  reference text check (reference is null or char_length(reference) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);
-- statement-breakpoint

create unique index customers_email_key on customers (lower(email));
-- statement-breakpoint

create trigger customers_updated_at before update on customers
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Sessão do cliente: só o hash do cookie fica aqui (igual ao painel).
create table customer_sessions (
  token_hash text primary key,
  customer_id uuid not null references customers (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
-- statement-breakpoint

create index customer_sessions_customer_idx on customer_sessions (customer_id);
-- statement-breakpoint
create index customer_sessions_expires_idx on customer_sessions (expires_at);
-- statement-breakpoint

-- Link de redefinição de senha gerado pela loja (de uso único, com validade curta).
create table customer_password_resets (
  token_hash text primary key,
  customer_id uuid not null references customers (id) on delete cascade,
  created_by uuid references admins (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
-- statement-breakpoint

create index customer_password_resets_customer_idx on customer_password_resets (customer_id);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedidos: dono (conta) opcional e códigos de acompanhamento
-- ---------------------------------------------------------------------------------------------

alter table orders
  add column customer_id uuid references customers (id) on delete set null,
  add column customer_linked_at timestamptz;
-- statement-breakpoint

create index orders_customer_idx on orders (customer_id, created_at desc) where customer_id is not null;
-- statement-breakpoint

-- Vincular o pedido a uma conta não conta como "atualização" do pedido para o cliente.
create or replace function orders_touch()
returns trigger
language plpgsql
as $$
begin
  if (to_jsonb(new) - 'updated_at' - 'customer_id' - 'customer_linked_at')
     is distinct from (to_jsonb(old) - 'updated_at' - 'customer_id' - 'customer_linked_at') then
    new.updated_at = now();
  else
    new.updated_at = old.updated_at;
  end if;
  return new;
end;
$$;
-- statement-breakpoint

drop trigger orders_updated_at on orders;
-- statement-breakpoint

create trigger orders_updated_at before update on orders
  for each row execute function orders_touch();
-- statement-breakpoint

-- Um pedido pode ter vários códigos ativos: o do checkout, os gerados pelo painel e os antigos (legacy).
create table order_tracking_tokens (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  -- SHA-256 (hex) do código. O código em si nunca é gravado.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('checkout', 'admin', 'legacy')),
  created_by uuid references admins (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
-- statement-breakpoint

create index order_tracking_tokens_order_idx on order_tracking_tokens (order_id);
-- statement-breakpoint

-- Migração dos pedidos existentes: o UUID do link /pedido/:id vira hash (do texto minúsculo do UUID).
insert into order_tracking_tokens (order_id, token_hash, source, created_at)
select id, encode(sha256(convert_to(lower(public_token::text), 'UTF8')), 'hex'), 'legacy', created_at
from orders;
-- statement-breakpoint

drop function get_public_order(uuid);
-- statement-breakpoint

alter table orders drop column public_token;
-- statement-breakpoint

-- Telefone sem 55 e sem máscara, para comparar o do pedido com o da conta.
create or replace function phone_key(p text)
returns text
language sql
immutable
as $$
  select case when length(d) > 11 and left(d, 2) = '55' then substr(d, 3) else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- O pedido como o cliente vê. p_ids = true só para o dono da conta (inclui o id do produto para "pedir de novo").
-- ---------------------------------------------------------------------------------------------

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
    'total', o.total,
    'created_at', o.created_at,
    'updated_at', o.updated_at,
    'linked', o.customer_id is not null,
    'retention_days', (select s.tracking_retention_days from store_settings s where s.id = 1),
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'product_name', i.product_name,
          'quantity', i.quantity,
          'unit_price', i.unit_price,
          'total_price', i.total_price
        ) || case when p_ids then jsonb_build_object('product_id', i.product_id) else '{}'::jsonb end
        order by i.created_at, i.product_name
      )
      from order_items i
      where i.order_id = o.id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('status', h.to_status, 'at', h.created_at) order by h.created_at)
      from order_status_history h
      where h.order_id = o.id
    ), '[]'::jsonb)
  )
  from orders o
  where o.id = p_order;
$$;
-- statement-breakpoint

-- Pedido de um link/código. Vale se o código existe, não foi revogado e o pedido ainda está dentro
-- do prazo de retenção. Com p_number, o código precisa ser DAQUELE pedido (consulta por número + código).
-- Sem nada a mostrar devolve null: pedido inexistente, código errado e link vencido são indistinguíveis.
create or replace function get_public_order(p_hash text, p_number bigint default null)
returns jsonb
language sql
stable
as $$
  select order_json(o.id)
  from order_tracking_tokens t
  join orders o on o.id = t.order_id
  join store_settings s on s.id = 1
  where t.token_hash = p_hash
    and t.revoked_at is null
    and (p_number is null or o.order_number = p_number)
    and o.updated_at > now() - make_interval(days => s.tracking_retention_days);
$$;
-- statement-breakpoint

-- Pedido de uma conta (por número). Só devolve se o pedido for da conta.
create or replace function get_customer_order(p_customer uuid, p_number bigint)
returns jsonb
language sql
stable
as $$
  select order_json(o.id, true)
  from orders o
  where o.customer_id = p_customer and o.order_number = p_number;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Vincular um pedido de visitante a uma conta. Prova de posse: número + código de acompanhamento
-- (que só o cliente tem) e o telefone ou e-mail do pedido iguais aos da conta.
-- ---------------------------------------------------------------------------------------------

create or replace function claim_order(p_customer uuid, p_number bigint, p_hash text)
returns jsonb
language plpgsql
as $$
declare
  c customers;
  o orders;
begin
  select * into c from customers where id = p_customer and active;
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
-- Limpeza de dados técnicos vencidos (sessões, links de redefinição, tentativas, códigos de pedidos fora do prazo).
-- Os pedidos em si não são apagados: a loja precisa deles para o histórico e para obrigações fiscais.
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
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Criar pedido: tudo numa transação só (pedido, itens, estoque, histórico e código de acompanhamento).
-- Preços, estoque, taxa e regras da loja são conferidos aqui; o navegador só manda o que o cliente escolheu.
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
  -- Conta do cliente: o servidor só envia o id de uma sessão válida; conta desativada é ignorada.
  if v_customer is not null and not exists (select 1 from customers c where c.id = v_customer and c.active) then
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

-- ---------------------------------------------------------------------------------------------
-- Compatibilidade transitória com a versão anterior do site: ela consulta o pedido por UUID
-- (get_public_order(uuid)) e lê "token" no resultado. O site novo não usa esta função.
-- ---------------------------------------------------------------------------------------------

create or replace function get_public_order(p_token uuid)
returns jsonb
language sql
stable
as $$
  select get_public_order(encode(sha256(convert_to(lower(p_token::text), 'UTF8')), 'hex'), null)
         || jsonb_build_object('token', p_token);
$$;
-- statement-breakpoint
