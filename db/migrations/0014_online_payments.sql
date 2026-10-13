-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 14/14 · Pagamento online (Pix): a base, independente da operadora de pagamento.
--
-- O que esta migration FAZ
-- • merchant_accounts: a conta (subconta) do estabelecimento na operadora: proposta → aprovada. O identificador definitivo da subconta só
--   pode existir depois da aprovação (restrição do banco), e só uma conta aprovada por operadora.
-- • payments: uma linha por tentativa de cobrança. Todos os valores em CENTAVOS. A comissão de 5% é calculada AQUI, no banco, sobre o
--   total que o próprio banco calculou para o pedido (nada vem do navegador). "Comissão efetivada" só com a evidência do repasse: a
--   restrição payments_commission_evidence impede de marcar como efetivada sem o valor confirmado pela operadora.
-- • payment_events: os avisos (webhooks) da operadora, um por identificador, para nunca aplicar o mesmo efeito duas vezes.
-- • Pedido novo: orders.order_status ganha 'awaiting_payment' (pagamento online ainda não confirmado). O pedido já reserva o estoque,
--   mas só vira "novo" para a loja depois que o pagamento é confirmado; não pago a tempo, é cancelado e o estoque volta.
-- • payment_methods ganha 'pix_online', que nasce DESLIGADO. O painel só deixa ligá-lo com uma subconta aprovada.
-- • Funções: criar a tentativa de cobrança (sem duplicar), aplicar o que a operadora informou (sem regredir nem repetir efeitos),
--   encerrar o que venceu e cancelar o pedido que não foi pago.
--
-- O que NÃO faz
-- • Não fala com nenhuma operadora e não liga nada: com 'pix_online' desligado, o site e os pedidos continuam exatamente como estavam
--   (Pix com chave, dinheiro e cartão na entrega). O adaptador de cada operadora fica no servidor, fora do banco.
-- • Não apaga nem altera nenhum pedido, produto, preço ou estoque que já existe.
--
-- Só acrescenta (tabelas, funções, um meio de pagamento desligado) e amplia duas listas de valores permitidos; as funções
-- create_order, order_json, admin_set_order_status, admin_set_payment_status e admin_dashboard são trocadas por versões que se comportam
-- igual para tudo que já existe.

-- ---------------------------------------------------------------------------------------------
-- Meio de pagamento e status do pedido
-- ---------------------------------------------------------------------------------------------

alter table payment_methods drop constraint payment_methods_code_check;
-- statement-breakpoint

alter table payment_methods
  add constraint payment_methods_code_check check (code in ('pix', 'cash', 'card', 'pix_online'));
-- statement-breakpoint

insert into payment_methods (code, label, enabled, position)
values ('pix_online', 'Pix online', false, 3)
on conflict (code) do nothing;
-- statement-breakpoint

alter table orders drop constraint orders_order_status_check;
-- statement-breakpoint

alter table orders
  add constraint orders_order_status_check
  check (order_status in ('awaiting_payment', 'new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'));
-- statement-breakpoint

-- Meios de pagamento em que o cliente paga pelo site (e a operadora confirma). Os demais continuam sendo pagos na entrega/retirada.
create or replace function is_online_payment(p_code text)
returns boolean
language sql
immutable
as $$
  select p_code in ('pix_online');
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Comissão: 5% do total do pedido, em centavos, arredondada ao centavo mais próximo (metade para cima).
-- Fica no banco para existir uma única conta: pedido de R$ 100,00 → R$ 5,00; R$ 10,10 → R$ 0,51.
-- ---------------------------------------------------------------------------------------------

create or replace function payment_commission_bps()
returns integer
language sql
immutable
as $$
  select 500;
$$;
-- statement-breakpoint

create or replace function payment_commission_cents(p_amount_cents integer, p_bps integer)
returns integer
language sql
immutable
strict
as $$
  select ((p_amount_cents::bigint * p_bps + 5000) / 10000)::integer;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Conta (subconta) do estabelecimento na operadora de pagamento
-- ---------------------------------------------------------------------------------------------

create table merchant_accounts (
  id uuid primary key default gen_random_uuid(),
  -- Nome interno da operadora (ex.: 'validapay'). Cada operadora tem as suas contas.
  provider text not null check (char_length(provider) between 2 and 30),
  -- Tipo de cadastro: pessoa física ou jurídica. Os dados do cadastro em si ficam na operadora, não aqui.
  kind text check (kind is null or kind in ('pf', 'pj')),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'pending', 'approved', 'rejected', 'duplicate', 'error', 'suspended')),
  status_detail text check (status_detail is null or char_length(status_detail) <= 500),
  -- Identificador da proposta de cadastro, devolvido pela operadora.
  proposal_id text check (proposal_id is null or char_length(proposal_id) <= 120),
  -- Identificador DEFINITIVO da subconta: só existe depois da confirmação oficial (status 'approved').
  provider_account_id text check (provider_account_id is null or char_length(provider_account_id) <= 120),
  -- Autorização do proprietário e ciência das tarifas, registradas antes de qualquer cadastro.
  authorized_by uuid references admins (id) on delete set null,
  authorized_at timestamptz,
  fees_acknowledged_at timestamptz,
  fees_snapshot jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_accounts_id_only_when_approved check (provider_account_id is null or status in ('approved', 'suspended')),
  constraint merchant_accounts_approved_has_id check (status <> 'approved' or provider_account_id is not null)
);
-- statement-breakpoint

create unique index merchant_accounts_one_approved on merchant_accounts (provider) where status = 'approved';
-- statement-breakpoint
create unique index merchant_accounts_proposal_key on merchant_accounts (provider, proposal_id) where proposal_id is not null;
-- statement-breakpoint
create unique index merchant_accounts_account_key on merchant_accounts (provider, provider_account_id) where provider_account_id is not null;
-- statement-breakpoint

create trigger merchant_accounts_updated_at before update on merchant_accounts
  for each row execute function set_updated_at();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Cobranças (uma linha por tentativa)
-- ---------------------------------------------------------------------------------------------

create sequence payment_paid_seq;
-- statement-breakpoint

create table payments (
  id uuid primary key default gen_random_uuid(),
  -- Sem "on delete cascade": registro financeiro não some junto com o pedido.
  order_id uuid not null references orders (id),
  -- Número da tentativa dentro do pedido (1, 2, ...).
  attempt integer not null default 1 check (attempt between 1 and 20),
  provider text not null check (char_length(provider) between 2 and 30),
  method text not null check (method in ('pix')),
  -- Conta (subconta) que recebe a venda.
  merchant_account_id uuid references merchant_accounts (id),
  -- creating: criando na operadora · pending: aguardando o cliente pagar · paid: confirmado · expired: venceu sem pagar ·
  -- cancelled: cancelado · failed: a operadora recusou ou a criação falhou · refunded: devolvido.
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded')),
  -- Último status que a operadora informou, como ela escreve (só para diagnóstico).
  provider_status text check (provider_status is null or char_length(provider_status) <= 80),
  provider_charge_id text check (provider_charge_id is null or char_length(provider_charge_id) <= 120),
  amount_cents integer not null check (amount_cents > 0),
  -- Comissão da conta master: percentual (em pontos-base, 500 = 5%) e valor calculados no momento da cobrança.
  commission_bps integer not null check (commission_bps between 0 and 10000),
  commission_cents integer not null check (commission_cents >= 0),
  -- calculated: só calculada · confirmed: a operadora confirmou o repasse · failed: o repasse falhou ·
  -- not_applicable: esta cobrança não tem divisão.
  commission_state text not null default 'calculated'
    check (commission_state in ('calculated', 'confirmed', 'failed', 'not_applicable')),
  -- Valor que a operadora confirmou ter repassado à conta master (a evidência).
  commission_confirmed_cents integer check (commission_confirmed_cents is null or commission_confirmed_cents >= 0),
  -- Tarifas e líquido, como a operadora informou (vazio enquanto ela não informar).
  fee_cents integer check (fee_cents is null or fee_cents >= 0),
  net_cents integer check (net_cents is null or net_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  -- Pix "copia e cola" (o QR Code é desenhado a partir dele).
  pix_payload text check (pix_payload is null or char_length(pix_payload) <= 2048),
  expires_at timestamptz,
  paid_at timestamptz,
  -- Ordem de confirmação (alimenta o aviso de pedido pago do painel).
  paid_seq bigint unique,
  closed_at timestamptz,
  checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  needs_attention boolean not null default false,
  attention_reason text check (attention_reason is null or char_length(attention_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_commission_within_amount check (commission_cents <= amount_cents),
  constraint payments_refund_within_amount check (refunded_cents <= amount_cents),
  -- Sem evidência, sem "efetivada": a comissão só vira confirmed com o valor que a operadora confirmou e com o pagamento confirmado.
  constraint payments_commission_evidence check (
    commission_state <> 'confirmed' or (commission_confirmed_cents is not null and status in ('paid', 'refunded'))
  ),
  constraint payments_paid_has_time check (status not in ('paid', 'refunded') or paid_at is not null)
);
-- statement-breakpoint

-- Um pedido tem, no máximo, uma tentativa em andamento: cliques repetidos e requisições simultâneas não geram duas cobranças.
create unique index payments_one_open_per_order on payments (order_id) where status in ('creating', 'pending');
-- statement-breakpoint
create unique index payments_charge_key on payments (provider, provider_charge_id) where provider_charge_id is not null;
-- statement-breakpoint
create index payments_order_idx on payments (order_id, created_at desc);
-- statement-breakpoint
create index payments_open_idx on payments (expires_at) where status in ('creating', 'pending');
-- statement-breakpoint
create index payments_attention_idx on payments (created_at desc) where needs_attention;
-- statement-breakpoint

create trigger payments_updated_at before update on payments
  for each row execute function set_updated_at();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Avisos (webhooks) da operadora: um por identificador. Guarda só o necessário (nada de documento ou dado do pagador).
-- ---------------------------------------------------------------------------------------------

create table payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (char_length(provider) between 2 and 30),
  -- Identificador do evento na operadora; sem ele, um resumo (hash) do conteúdo.
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  event_type text not null check (char_length(event_type) <= 80),
  provider_charge_id text check (provider_charge_id is null or char_length(provider_charge_id) <= 120),
  payment_id uuid references payments (id),
  observed_status text check (observed_status is null or char_length(observed_status) <= 40),
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  received_at timestamptz not null default now(),
  -- Vazio enquanto o evento não foi processado até o fim: se o processamento falhou, a próxima entrega do mesmo evento processa de novo.
  processed_at timestamptz,
  attempts integer not null default 1,
  outcome text check (outcome is null or outcome in ('applied', 'stale', 'ignored', 'needs_attention', 'unknown_charge', 'error')),
  detail text check (detail is null or char_length(detail) <= 300),
  unique (provider, dedupe_key)
);
-- statement-breakpoint

create index payment_events_payment_idx on payment_events (payment_id, received_at desc);
-- statement-breakpoint
create index payment_events_pending_idx on payment_events (received_at) where processed_at is null;
-- statement-breakpoint

-- Pedido que o cliente pode acompanhar com o código: o mesmo critério de get_public_order (código válido e dentro do prazo).
create or replace function order_id_for_token(p_hash text)
returns uuid
language sql
stable
as $$
  select o.id
  from order_tracking_tokens t
  join orders o on o.id = t.order_id
  join store_settings s on s.id = 1
  where t.token_hash = p_hash
    and t.revoked_at is null
    and o.updated_at > now() - make_interval(days => s.tracking_retention_days);
$$;
-- statement-breakpoint

-- Devolve ao estoque o que o pedido reservou (cancelamento). Produto sem controle de estoque não é tocado.
create or replace function restore_order_stock(p_order uuid)
returns void
language sql
volatile
as $$
  update products p
  set stock = p.stock + i.qty
  from (
    select product_id, sum(quantity)::integer as qty
    from order_items
    where order_id = p_order and product_id is not null
    group by product_id
  ) i
  where p.id = i.product_id and p.stock is not null;
$$;
-- statement-breakpoint
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Funções que já existiam, trocadas por versões que se comportam igual para tudo que existe hoje e entendem o pedido de pagamento online.
--  • order_json: o pedido que o cliente vê ganha 'payment' (resumo da cobrança) quando existe cobrança.
--  • create_order: pagamento online exige conta aprovada; o pedido nasce 'awaiting_payment'. O resto é igual (preço, estoque, taxa,
--    escolha do gelo, total conferido e idempotência).
--  • admin_set_order_status: pedido aguardando pagamento só pode ser cancelado (o estoque volta e a cobrança em aberto é encerrada).
--  • admin_set_payment_status: o pagamento de um pedido online não se altera à mão.
--  • admin_dashboard: pedido aguardando pagamento não conta como venda; o cancelamento por falta de pagamento não entra em "cancelados hoje".
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
        ) || case when i.ice_choice is not null then jsonb_build_object('ice_choice', i.ice_choice) else '{}'::jsonb end
          || case when p_ids then jsonb_build_object('product_id', i.product_id) else '{}'::jsonb end
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
  ) || case
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
-- statement-breakpoint

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
  -- Escolha do gelo de cada linha (nula nos produtos que não pedem) e os produtos que pedem e vieram sem a escolha.
  v_ices text[] := '{}';
  v_line record;
  v_requires boolean;
  v_missing jsonb := '[]'::jsonb;
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
  -- Pagamento online: sem uma conta aprovada na operadora não há como cobrar. (O painel também não deixa ligar o meio de pagamento assim.)
  if is_online_payment(v_payment) and not exists (select 1 from merchant_accounts a where a.status = 'approved') then
    raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
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

    -- Gelo: se a categoria do produto pede a escolha (marca no registro da categoria, não o nome), cada linha precisa trazer
    -- 'normal' ou 'flavored'. Em produto que não pede, qualquer valor de ice_choice é ignorado (o pedido fica como sempre foi).
    v_requires := v_product.category_id is not null
      and exists (select 1 from categories c where c.id = v_product.category_id and c.ice_choice_required);

    -- Uma linha por gelo: o mesmo produto com gelos diferentes vira linhas separadas, cada uma com a sua quantidade.
    for v_line in
      select x.ice, sum(x.qty)::integer as qty
      from (
        select case when v_requires and e ->> 'ice_choice' in ('normal', 'flavored') then e ->> 'ice_choice' end as ice,
               (e ->> 'quantity')::integer as qty
        from jsonb_array_elements(payload -> 'items') e
        where (e ->> 'product_id')::uuid = v_item.product_id
      ) x
      group by x.ice
      order by x.ice nulls first
    loop
      if v_requires and v_line.ice is null then
        v_missing := v_missing || jsonb_build_object('product_id', v_product.id, 'name', v_product.name);
        continue;
      end if;
      v_subtotal := v_subtotal + v_unit * v_line.qty;
      v_ids := array_append(v_ids, v_product.id);
      v_names := array_append(v_names, v_product.name);
      v_qtys := array_append(v_qtys, v_line.qty);
      v_units := array_append(v_units, v_unit);
      v_ices := array_append(v_ices, v_line.ice);
    end loop;

    if v_product.stock is not null then
      update products set stock = stock - v_item.qty where id = v_product.id;
    end if;
  end loop;

  -- Algum produto que pede o gelo veio sem a escolha: nada é criado (o estoque reservado acima volta junto). O site recebe quais
  -- produtos faltam para mostrar a pergunta de novo.
  if jsonb_array_length(v_missing) > 0 then
    raise exception 'Escolha o tipo de gelo para continuar.'
      using errcode = 'CC400',
            detail = jsonb_build_object('code', 'ice_required', 'products', (select jsonb_agg(distinct m) from jsonb_array_elements(v_missing) m))::text;
  end if;

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
                select coalesce(jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'quantity', x.qty, 'unit_price', x.unit, 'ice_choice', x.ice) order by x.name, x.ice nulls first), '[]'::jsonb)
                from unnest(v_ids, v_names, v_qtys, v_units, v_ices) as x (id, name, qty, unit, ice)
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
    customer_id, customer_linked_at, idempotency_key, request_hash, order_status
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash,
    -- Pagamento online: o pedido já reserva o estoque, mas só chega à loja ("novo") depois que o pagamento for confirmado.
    case when is_online_payment(v_payment) then 'awaiting_payment' else 'new' end
  )
  returning * into v_order;

  insert into order_items (order_id, product_id, product_name, quantity, unit_price, total_price, ice_choice)
  select v_order.id, x.id, x.name, x.qty, x.unit, x.unit * x.qty, x.ice
  from unnest(v_ids, v_names, v_qtys, v_units, v_ices) as x (id, name, qty, unit, ice);

  insert into order_status_history (order_id, from_status, to_status, changed_by_name)
  values (v_order.id, null, v_order.order_status, 'Cliente (site)');

  insert into order_tracking_tokens (order_id, token_hash, source)
  values (v_order.id, v_hash, 'checkout');

  return order_json(v_order.id)
    || case when v_legacy is null then '{}'::jsonb else jsonb_build_object('token', v_legacy) end;
end;
$$;
-- statement-breakpoint

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
  -- Pagamento online ainda não confirmado: o pedido só segue para a loja quando a operadora confirmar. Cancelar pode.
  if v_old.order_status = 'awaiting_payment' and p_status <> 'cancelled' then
    raise exception 'Este pedido está aguardando o pagamento online. Ele só segue para a loja depois que o pagamento for confirmado.' using errcode = 'P0001';
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
    perform restore_order_stock(p_order);
    -- Pagamento online: a cobrança em aberto deixa de valer; se já estava paga, fica sinalizada para devolver o valor ao cliente.
    update payments
       set status = case when status = 'pending' then 'cancelled' else 'failed' end,
           closed_at = now(),
           needs_attention = needs_attention or status = 'creating',
           attention_reason = case when status = 'creating'
                                   then 'O pedido foi cancelado enquanto o Pix era criado. Confira na operadora se a cobrança existe e cancele-a.'
                                   else attention_reason end
     where order_id = p_order and status in ('creating', 'pending');
    update payments
       set needs_attention = true,
           attention_reason = 'Pedido cancelado depois de pago. Devolva o valor ao cliente.'
     where order_id = p_order and status = 'paid';
  end if;

  return v_new;
end;
$$;
-- statement-breakpoint

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
  -- Pagamento online: quem confirma é a operadora (aviso verificado ou consulta), nunca um clique no painel.
  if is_online_payment(v_old.payment_method) then
    raise exception 'O pagamento deste pedido é online: quem confirma é a operadora de pagamento, então não dá para alterar à mão. Use "Atualizar pagamento" para consultar.'
      using errcode = 'P0001';
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
  where h.to_status = 'cancelled' and o.order_status = 'cancelled' and h.created_at >= today_start
    and h.changed_by_name is distinct from 'Sistema (pagamento não realizado)';

  select jsonb_build_object(
    'today_orders', count(*) filter (where o.created_at >= today_start and o.order_status not in ('cancelled', 'awaiting_payment')),
    'pending', count(*) filter (where o.order_status = 'new'),
    'awaiting_payment', count(*) filter (where o.order_status = 'awaiting_payment'),
    'confirmed', count(*) filter (where o.order_status = 'confirmed'),
    'preparing', count(*) filter (where o.order_status = 'preparing'),
    'out_for_delivery', count(*) filter (where o.order_status = 'out_for_delivery'),
    'delivered_today', v_delivered,
    'cancelled_today', v_cancelled,
    'revenue_today', coalesce(sum(o.total) filter (where o.created_at >= today_start and o.order_status not in ('cancelled', 'awaiting_payment') and o.payment_status <> 'refunded'), 0),
    'revenue_week', coalesce(sum(o.total) filter (where o.created_at >= week_start and o.order_status not in ('cancelled', 'awaiting_payment') and o.payment_status <> 'refunded'), 0),
    'revenue_month', coalesce(sum(o.total) filter (where o.created_at >= month_start and o.order_status not in ('cancelled', 'awaiting_payment') and o.payment_status <> 'refunded'), 0)
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
  where o.created_at >= range_start and o.order_status not in ('cancelled', 'awaiting_payment') and o.payment_status <> 'refunded';

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
      and o.order_status not in ('cancelled', 'awaiting_payment')
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
    where o.created_at >= range_start and o.order_status not in ('cancelled', 'awaiting_payment') and o.payment_status <> 'refunded'
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
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Criar a tentativa de cobrança de um pedido de pagamento online.
-- • Trava o pedido: dois cliques (ou duas requisições ao mesmo tempo) passam um de cada vez. Se já existe uma tentativa em andamento,
--   devolve a MESMA (created = false) em vez de criar outra; só uma tentativa em andamento por pedido (índice payments_one_open_per_order).
-- • O valor e a comissão saem do total do pedido gravado no banco, nunca do navegador.
-- • Tentativa antiga sem resposta (a criação ficou pendurada) ou cobrança vencida são encerradas antes de abrir a próxima.
-- ---------------------------------------------------------------------------------------------

create or replace function payment_begin(p_order uuid, p_method text, p_provider text, p_stale_seconds integer default 90)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order orders;
  v_merchant merchant_accounts;
  v_open payments;
  v_new payments;
  v_attempts integer;
  v_amount integer;
begin
  if p_method is distinct from 'pix' then
    raise exception 'Forma de pagamento inválida.' using errcode = 'P0001';
  end if;

  select * into v_order from orders where id = p_order for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'P0001';
  end if;
  if not is_online_payment(v_order.payment_method) then
    raise exception 'Este pedido não é de pagamento online.' using errcode = 'P0001';
  end if;
  if v_order.order_status <> 'awaiting_payment' then
    raise exception 'Este pedido não está aguardando pagamento.' using errcode = 'P0001';
  end if;

  select * into v_merchant from merchant_accounts where provider = p_provider and status = 'approved';
  if not found then
    raise exception 'O pagamento online não está disponível agora. Fale com a loja.' using errcode = 'P0001';
  end if;

  select * into v_open from payments where order_id = p_order and status in ('creating', 'pending') order by created_at desc limit 1;
  if found then
    if v_open.status = 'pending' and v_open.expires_at > now() then
      return jsonb_build_object('created', false, 'payment', to_jsonb(v_open), 'order_number', v_order.order_number);
    end if;
    if v_open.status = 'creating' and v_open.created_at > now() - make_interval(secs => p_stale_seconds) then
      return jsonb_build_object('created', false, 'payment', to_jsonb(v_open), 'order_number', v_order.order_number);
    end if;
    -- A tentativa anterior não vale mais: a cobrança venceu sem pagamento, ou a criação ficou sem resposta (não dá para saber se a
    -- operadora chegou a criar a cobrança; o cliente nunca viu o QR Code dela, então ninguém a paga, mas fica sinalizada para conferência).
    update payments
       set status = case when status = 'pending' then 'expired' else 'failed' end,
           closed_at = now(),
           needs_attention = needs_attention or status = 'creating',
           attention_reason = case when status = 'creating'
                                   then 'A criação do Pix ficou sem resposta. Confira na operadora se a cobrança foi criada.'
                                   else attention_reason end
     where id = v_open.id;
  end if;

  select count(*) into v_attempts from payments where order_id = p_order;
  if v_attempts >= 5 then
    raise exception 'Já foram feitas várias tentativas de pagamento para este pedido. Fale com a loja.' using errcode = 'P0001';
  end if;

  v_amount := round(v_order.total * 100)::integer;
  if v_amount <= 0 then
    raise exception 'Este pedido não tem valor a pagar.' using errcode = 'P0001';
  end if;

  insert into payments (order_id, attempt, provider, method, merchant_account_id, amount_cents, commission_bps, commission_cents)
  values (p_order, v_attempts + 1, p_provider, p_method, v_merchant.id, v_amount, payment_commission_bps(),
          payment_commission_cents(v_amount, payment_commission_bps()))
  returning * into v_new;

  return jsonb_build_object(
    'created', true,
    'payment', to_jsonb(v_new),
    'order_number', v_order.order_number,
    'merchant_account', v_merchant.provider_account_id
  );
end;
$$;
-- statement-breakpoint

-- A operadora criou a cobrança: guarda o código dela, o Pix "copia e cola" e a validade, e a tentativa passa a aguardar o pagamento.
create or replace function payment_mark_created(p_payment uuid, p_charge_id text, p_payload text, p_expires timestamptz, p_provider_status text default null)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_pay payments;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  perform 1 from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;

  if v_pay.status <> 'creating' then
    -- A tentativa já tinha sido encerrada (o pedido foi cancelado, ou a criação demorou demais): só guarda o código para conferência.
    update payments
       set provider_charge_id = coalesce(provider_charge_id, p_charge_id),
           needs_attention = true,
           attention_reason = 'Uma cobrança foi criada na operadora depois que a tentativa já tinha sido encerrada. Confira e cancele se for o caso.'
     where id = p_payment
    returning * into v_pay;
    return jsonb_build_object('updated', false, 'payment', to_jsonb(v_pay));
  end if;

  update payments
     set status = 'pending',
         provider_charge_id = p_charge_id,
         pix_payload = p_payload,
         expires_at = coalesce(p_expires, now() + interval '15 minutes'),
         provider_status = left(p_provider_status, 80),
         checked_at = now()
   where id = p_payment
  returning * into v_pay;
  return jsonb_build_object('updated', true, 'payment', to_jsonb(v_pay));
end;
$$;
-- statement-breakpoint

-- A criação da cobrança falhou. `p_ambiguous`: não dá para saber se a operadora criou a cobrança (tempo esgotado, erro do servidor dela).
create or replace function payment_mark_failed(p_payment uuid, p_error text, p_ambiguous boolean default false)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_pay payments;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  perform 1 from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;
  if v_pay.status = 'creating' then
    update payments
       set status = 'failed',
           closed_at = now(),
           last_error = left(p_error, 300),
           needs_attention = p_ambiguous,
           attention_reason = case when p_ambiguous then 'Sem resposta da operadora ao criar o Pix. Confira se a cobrança foi criada.' else null end
     where id = p_payment
    returning * into v_pay;
  end if;
  return jsonb_build_object('payment', to_jsonb(v_pay));
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Aplicar o que a operadora informou sobre uma cobrança (vindo de um aviso verificado ou de uma consulta direta a ela).
--
-- • Idempotente e sem regressão. A ordem dos status é: criando < aguardando < vencido/cancelado/recusado < pago < estornado. Uma
--   informação só muda a cobrança se levar a um status mais adiantado (pago vale mesmo depois de vencido: o dinheiro entrou). Avisos
--   repetidos, fora de ordem ou atrasados não desfazem nem repetem efeito.
-- • "Pago" só vale se o valor informado for IGUAL ao da cobrança; senão a cobrança fica sinalizada e o pedido NÃO é liberado.
-- • Pagamento confirmado libera o pedido ('awaiting_payment' → 'new') na mesma transação; pagamento que chega depois do cancelamento,
--   ou em duplicidade, não reabre nada: fica sinalizado para devolver o valor.
-- • A comissão fica como "só calculada" até a operadora confirmar o valor repassado (commission_state = 'confirmed'); falha de repasse
--   é registrada e sinalizada, e uma confirmação posterior (conciliação) ainda pode completá-la.
-- Tranca primeiro o pedido e depois a cobrança, sempre nessa ordem (como as demais funções), para não haver impasse entre elas.
-- ---------------------------------------------------------------------------------------------

create or replace function payment_apply(p_payment uuid, p_obs jsonb, p_source text default 'lookup')
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_order orders;
  v_pay payments;
  v_status text := nullif(p_obs ->> 'status', '');
  v_amount integer := nullif(p_obs ->> 'amount_cents', '')::integer;
  v_fee integer := nullif(p_obs ->> 'fee_cents', '')::integer;
  v_net integer := nullif(p_obs ->> 'net_cents', '')::integer;
  v_refunded integer := nullif(p_obs ->> 'refunded_cents', '')::integer;
  v_paid_at timestamptz := nullif(p_obs ->> 'paid_at', '')::timestamptz;
  v_provider_status text := left(nullif(p_obs ->> 'provider_status', ''), 80);
  v_detail text := left(nullif(p_obs ->> 'detail', ''), 300);
  v_split_state text := nullif(p_obs #>> '{split,state}', '');
  v_split_cents integer := nullif(p_obs #>> '{split,commission_cents}', '')::integer;
  v_split_detail text := left(nullif(p_obs #>> '{split,detail}', ''), 200);
  v_released boolean := false;
  v_changed boolean := false;
  v_outcome text := 'stale';
  v_note text;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  select * into v_order from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;

  if v_status is null or v_status not in ('pending', 'expired', 'cancelled', 'failed', 'paid', 'refunded') then
    return jsonb_build_object('outcome', 'ignored', 'changed', false, 'released', false, 'payment', to_jsonb(v_pay), 'order_status', v_order.order_status, 'order_number', v_order.order_number);
  end if;

  if v_status = 'paid' then
    if v_pay.status in ('paid', 'refunded') then
      -- Confirmação repetida (aviso + consulta, ou avisos da subconta e da conta master): o pedido não muda; só completa o que faltava saber.
      update payments
         set fee_cents = coalesce(fee_cents, v_fee),
             net_cents = coalesce(net_cents, v_net),
             provider_status = coalesce(v_provider_status, provider_status),
             checked_at = now()
       where id = p_payment
      returning * into v_pay;
    else
      if v_amount is distinct from v_pay.amount_cents then
        update payments
           set needs_attention = true,
               attention_reason = case
                 when v_amount is null then 'A operadora não informou o valor pago. Confira antes de liberar o pedido.'
                 else format('Valor pago (%s centavos) diferente do valor da cobrança (%s centavos). Confira antes de liberar o pedido.', v_amount, amount_cents)
               end,
               checked_at = now()
         where id = p_payment
        returning * into v_pay;
        return jsonb_build_object('outcome', 'needs_attention', 'changed', true, 'released', false, 'payment', to_jsonb(v_pay), 'order_status', v_order.order_status, 'order_number', v_order.order_number);
      end if;

      update payments
         set status = 'paid',
             paid_at = coalesce(v_paid_at, now()),
             paid_seq = nextval('payment_paid_seq'),
             closed_at = coalesce(closed_at, now()),
             fee_cents = coalesce(v_fee, fee_cents),
             net_cents = coalesce(v_net, net_cents),
             provider_status = coalesce(v_provider_status, provider_status),
             checked_at = now()
       where id = p_payment
      returning * into v_pay;
      v_changed := true;
      v_outcome := 'applied';

      if v_order.order_status = 'awaiting_payment'
         and not exists (select 1 from payments x where x.order_id = v_order.id and x.id <> v_pay.id and x.status in ('paid', 'refunded')) then
        update orders set order_status = 'new', payment_status = 'paid' where id = v_order.id returning * into v_order;
        insert into order_status_history (order_id, from_status, to_status, changed_by_name)
        values (v_order.id, 'awaiting_payment', 'new', 'Pagamento online');
        v_released := true;
      elsif v_order.order_status = 'cancelled' then
        v_note := 'Pagamento recebido depois que o pedido foi cancelado. Devolva o valor ao cliente.';
      elsif exists (select 1 from payments x where x.order_id = v_order.id and x.id <> v_pay.id and x.status in ('paid', 'refunded')) then
        v_note := 'Pagamento em duplicidade: este pedido já estava pago. Devolva um dos valores ao cliente.';
      else
        v_note := 'Pagamento confirmado para um pedido que não estava aguardando pagamento. Confira.';
      end if;
      if v_note is not null then
        update payments set needs_attention = true, attention_reason = v_note where id = p_payment returning * into v_pay;
        v_outcome := 'needs_attention';
      end if;
    end if;

    -- Repasse da comissão. Só "efetivada" com o valor que a operadora confirmou; "confirmed" nunca volta atrás por um aviso antigo.
    if v_split_state = 'applied' and v_split_cents is not null and v_pay.commission_state in ('calculated', 'failed') then
      update payments set commission_state = 'confirmed', commission_confirmed_cents = v_split_cents where id = p_payment returning * into v_pay;
      v_changed := true;
      if v_outcome = 'stale' then v_outcome := 'applied'; end if;
      if v_split_cents <> v_pay.commission_cents then
        update payments
           set needs_attention = true,
               attention_reason = left(coalesce(attention_reason || ' ', '')
                 || format('Comissão efetivada (%s centavos) diferente da calculada (%s).', v_split_cents, commission_cents), 300)
         where id = p_payment
        returning * into v_pay;
        v_outcome := 'needs_attention';
      end if;
    elsif v_split_state = 'failed' and v_pay.commission_state not in ('confirmed', 'failed') then
      update payments
         set commission_state = 'failed',
             needs_attention = true,
             attention_reason = left(coalesce(attention_reason || ' ', '') || 'Falha no repasse da comissão' || coalesce(': ' || v_split_detail, '.'), 300)
       where id = p_payment
      returning * into v_pay;
      v_changed := true;
      v_outcome := 'needs_attention';
    end if;

  elsif v_status in ('expired', 'cancelled', 'failed') then
    if v_pay.status in ('creating', 'pending') then
      update payments
         set status = v_status,
             closed_at = now(),
             provider_status = coalesce(v_provider_status, provider_status),
             last_error = case when v_status = 'failed' then coalesce(v_detail, last_error) else last_error end,
             checked_at = now()
       where id = p_payment
      returning * into v_pay;
      v_changed := true;
      v_outcome := 'applied';
    else
      update payments set checked_at = now() where id = p_payment returning * into v_pay;
    end if;

  elsif v_status = 'pending' then
    update payments
       set provider_status = case when status = 'pending' then coalesce(v_provider_status, provider_status) else provider_status end,
           checked_at = now()
     where id = p_payment
    returning * into v_pay;

  elsif v_status = 'refunded' then
    if v_pay.status = 'refunded' then
      update payments set checked_at = now() where id = p_payment returning * into v_pay;
    elsif v_pay.status = 'paid' then
      v_refunded := least(coalesce(v_refunded, v_pay.amount_cents), v_pay.amount_cents);
      update payments
         set refunded_cents = greatest(refunded_cents, v_refunded),
             status = case when greatest(refunded_cents, v_refunded) >= amount_cents then 'refunded' else status end,
             needs_attention = true,
             attention_reason = left(coalesce(attention_reason || ' ', '') || 'Estorno registrado. Confira se a comissão também foi devolvida.', 300),
             checked_at = now()
       where id = p_payment
      returning * into v_pay;
      if v_pay.status = 'refunded' then
        update orders set payment_status = 'refunded' where id = v_order.id and payment_status = 'paid' returning * into v_order;
      end if;
      v_changed := true;
      v_outcome := 'applied';
    else
      -- Estorno de uma cobrança que nunca vimos paga: o aviso do pagamento se perdeu. O pedido não é liberado; fica para conferência.
      update payments
         set status = 'refunded',
             paid_at = coalesce(paid_at, v_paid_at, now()),
             paid_seq = coalesce(paid_seq, nextval('payment_paid_seq')),
             closed_at = coalesce(closed_at, now()),
             refunded_cents = amount_cents,
             needs_attention = true,
             attention_reason = 'Estorno recebido sem a confirmação do pagamento (aviso perdido?). Confira na operadora.',
             checked_at = now()
       where id = p_payment
      returning * into v_pay;
      v_changed := true;
      v_outcome := 'needs_attention';
    end if;
  end if;

  return jsonb_build_object('outcome', v_outcome, 'changed', v_changed, 'released', v_released, 'payment', to_jsonb(v_pay), 'order_status', v_order.order_status, 'order_number', v_order.order_number);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Avisos da operadora: o mesmo aviso (mesmo identificador) é registrado uma vez. Se a primeira tentativa de processá-lo falhou
-- (processed_at vazio), a próxima entrega processa de novo; se já foi processado, é duplicado e nada se repete.
-- ---------------------------------------------------------------------------------------------

create or replace function payment_event_begin(p_provider text, p_key text, p_type text, p_charge text, p_status text, p_amount integer)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_id uuid;
  v_done timestamptz;
begin
  insert into payment_events (provider, dedupe_key, event_type, provider_charge_id, observed_status, amount_cents)
  values (p_provider, p_key, left(p_type, 80), left(p_charge, 120), left(p_status, 40), p_amount)
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'duplicate', false);
  end if;
  select e.id, e.processed_at into v_id, v_done from payment_events e where e.provider = p_provider and e.dedupe_key = p_key;
  if v_done is null then
    update payment_events set attempts = attempts + 1 where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', v_done is not null);
end;
$$;
-- statement-breakpoint

create or replace function payment_event_finish(p_event uuid, p_payment uuid, p_outcome text, p_detail text default null)
returns void
language sql
volatile
as $$
  update payment_events
     set payment_id = coalesce(p_payment, payment_id),
         outcome = p_outcome,
         detail = left(p_detail, 300),
         processed_at = case when p_outcome = 'error' then null else now() end
   where id = p_event;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Rotina de conferência (sem agendador): quais cobranças precisam ser consultadas na operadora agora.
-- • aguardando e já vencidas: confirmar com a operadora antes de encerrar;
-- • aguardando há mais de 2 minutos sem consulta recente: o aviso pode ter se perdido;
-- • "criando" há mais de 2 minutos: a criação ficou sem resposta.
-- ---------------------------------------------------------------------------------------------

create or replace function payments_due(p_limit integer default 5)
returns setof payments
language sql
stable
as $$
  select *
  from payments p
  where (p.status = 'pending' and p.expires_at is not null and p.expires_at < now())
     or (p.status = 'pending' and coalesce(p.checked_at, p.created_at) < now() - interval '2 minutes')
     or (p.status = 'creating' and p.created_at < now() - interval '2 minutes')
  order by coalesce(p.checked_at, p.created_at)
  limit greatest(p_limit, 1);
$$;
-- statement-breakpoint

-- Cobrança vencida que a operadora não conseguiu confirmar (fora do ar, ou sem adaptador): depois de `p_grace_minutes` do vencimento
-- ela é encerrada aqui mesmo, SINALIZADA, para o estoque não ficar preso. Se o cliente tiver pago, o aviso/consulta posterior ainda vale
-- (pago vence vencido) e o pedido cancelado fica sinalizado para devolver o valor.
create or replace function payment_expire_local(p_payment uuid, p_grace_minutes integer default 30)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_pay payments;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  perform 1 from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;
  if v_pay.status = 'pending' and v_pay.expires_at is not null and v_pay.expires_at < now() - make_interval(mins => p_grace_minutes) then
    update payments
       set status = 'expired',
           closed_at = now(),
           needs_attention = true,
           attention_reason = 'Venceu sem que a operadora pudesse confirmar o pagamento. Se o cliente pagou, devolva o valor.'
     where id = p_payment
    returning * into v_pay;
    return jsonb_build_object('changed', true, 'payment', to_jsonb(v_pay));
  end if;
  return jsonb_build_object('changed', false, 'payment', to_jsonb(v_pay));
end;
$$;
-- statement-breakpoint

-- Pedido de pagamento online que não foi pago a tempo: cancela e devolve o estoque.
-- • Com alguma tentativa já encerrada: o cliente ainda pode gerar outro Pix por `p_retry_minutes` depois da última;
-- • Sem nenhuma tentativa (a pessoa fechou a página): espera `p_never_minutes` desde o pedido.
create or replace function orders_cancel_unpaid(p_retry_minutes integer default 10, p_never_minutes integer default 30)
returns integer
language plpgsql
volatile
as $$
declare
  v_row record;
  v_n integer := 0;
  v_hit integer;
begin
  for v_row in
    select o.id
    from orders o
    where o.order_status = 'awaiting_payment'
      and not exists (select 1 from payments p where p.order_id = o.id and p.status in ('creating', 'pending', 'paid', 'refunded'))
      and coalesce((select max(p.closed_at) from payments p where p.order_id = o.id), o.created_at)
          < now() - make_interval(mins => case when exists (select 1 from payments p where p.order_id = o.id) then p_retry_minutes else p_never_minutes end)
    order by o.created_at
    limit 20
    for update of o skip locked
  loop
    update orders set order_status = 'cancelled' where id = v_row.id and order_status = 'awaiting_payment';
    get diagnostics v_hit = row_count;
    if v_hit > 0 then
      insert into order_status_history (order_id, from_status, to_status, changed_by_name)
      values (v_row.id, 'awaiting_payment', 'cancelled', 'Sistema (pagamento não realizado)');
      perform restore_order_stock(v_row.id);
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;
-- statement-breakpoint
