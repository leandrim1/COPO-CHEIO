-- ---------------------------------------------------------------------------------------------
-- 20/20 · Cartão de crédito online (ValidaPay) com a taxa de processamento paga pelo cliente, e taxa de serviço do Pix online (2,5% + 2,5% = 5% para a master).
--
-- O que esta migration FAZ
-- • payment_methods ganha 'card_online', que nasce DESLIGADO (o "Cartão" que já existe continua sendo pago na entrega/retirada, sem mudar nada).
-- • payment_fee_settings: o percentual e a tarifa fixa do cartão (valores de referência 5,37% + R$ 0,37, que o DONO precisa conferir no contrato da
--   ValidaPay). Só o servidor lê e muda; o cartão online só liga depois de o dono marcar que conferiu, e qualquer mudança de valor tira essa conferência.
-- • card_fee_cents(): a conta da taxa, em centavos inteiros, no banco (a única conta; o site só mostra o resultado):
--       total = arredondar((base + tarifa fixa) / (1 − percentual))      taxa do cliente = total − base
--   (metade do centavo arredonda para cima). A base é o que vai no cartão: itens + entrega − descontos.
-- • orders: payment_fee (a taxa cobrada do cliente), payment_fee_bps e payment_fee_fixed (os valores usados), tudo gravado no pedido. O total do
--   pedido já inclui a taxa. Pedidos antigos têm taxa 0 e não mudam.
-- • payments: aceita method 'card'; guarda a taxa do cliente (para conferir com a tarifa que a operadora informa) e as tentativas.
-- • create_order: cartão online calcula a taxa e confere o total que o cliente viu; order_json mostra payment_fee ao cliente.
-- • payment_begin_card / payment_card_mark_charge / payment_card_stale: a tentativa de cobrança do cartão SEM duplicar. Uma tentativa em
--   andamento nunca dá lugar a outra enquanto não tiver resultado: refazer usa a MESMA tentativa (o mesmo identificador na operadora),
--   que por isso não cobra duas vezes.
--
-- • TAXA DE SERVIÇO DO PIX ONLINE (só no Pix; o cartão fica de fora): o cliente paga 2,5% sobre itens + entrega, o estabelecimento (subconta) paga 2,5% e
--   os 5% vão para a conta master por divisão (split). Substitui a comissão de 2% nos pedidos NOVOS de Pix online: pix_customer_fee_bps e pix_store_fee_bps
--   ficam em payment_fee_settings; service_fee_cents() faz a conta em centavos (metade para cima); create_order soma a taxa do cliente ao total e a grava no
--   pedido (payment_fee / payment_fee_bps); payment_begin calcula a divisão: master = 5% do valor do pedido (arredondado UMA vez), a subconta recebe o
--   valor do pedido menos a parte dela (2,5%, absorvendo o arredondamento). Pedidos de Pix online que já existiam (sem taxa de serviço) mantêm a
--   comissão com que nasceram.
--
-- O que NÃO faz
-- • Não fala com nenhuma operadora, não liga o cartão online e não altera nenhum pedido, preço, estoque ou cobrança que já existe.
--
-- Só acrescenta (tabela, colunas, funções) e amplia duas listas de valores permitidos; create_order, order_json e is_online_payment são trocadas
-- por versões que se comportam igual para tudo o que já existe.
-- ---------------------------------------------------------------------------------------------

alter table payment_methods drop constraint payment_methods_code_check;
-- statement-breakpoint

alter table payment_methods
  add constraint payment_methods_code_check check (code in ('pix', 'cash', 'card', 'pix_online', 'card_online'));
-- statement-breakpoint

insert into payment_methods (code, label, enabled, position)
values ('card_online', 'Cartão de crédito online', false, 4)
on conflict (code) do nothing;
-- statement-breakpoint

-- Meios de pagamento em que o cliente paga pelo site (e a operadora confirma). Os demais continuam sendo pagos na entrega/retirada.
create or replace function is_online_payment(p_code text)
returns boolean
language sql
immutable
as $$
  select p_code in ('pix_online', 'card_online');
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Taxa do cartão: valores de referência (a conferir) e a conta
-- ---------------------------------------------------------------------------------------------

create table payment_fee_settings (
  id integer primary key default 1 check (id = 1),
  -- Percentual em pontos-base (537 = 5,37%) e tarifa fixa por transação em centavos (37 = R$ 0,37). Limites de bom senso: até 25% e R$ 10,00.
  card_fee_bps integer not null default 537 check (card_fee_bps between 0 and 2500),
  card_fee_fixed_cents integer not null default 37 check (card_fee_fixed_cents between 0 and 1000),
  -- Pix online: quanto o CLIENTE paga (taxa de serviço) e quanto o ESTABELECIMENTO (subconta) paga, ambos em pontos-base sobre itens + entrega. Os dois
  -- somados (5%) vão para a conta master. Não dependem de conferência com a operadora (são regra do dono do sistema).
  pix_customer_fee_bps integer not null default 250 check (pix_customer_fee_bps between 0 and 1000),
  pix_store_fee_bps integer not null default 250 check (pix_store_fee_bps between 0 and 1000),
  -- O dono conferiu estes valores com o contrato/painel da operadora. Sem isso o cartão online não liga e nenhum pedido de cartão online nasce.
  confirmed_at timestamptz,
  confirmed_by uuid references admins (id) on delete set null,
  confirmed_by_name text check (confirmed_by_name is null or char_length(confirmed_by_name) <= 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references admins (id) on delete set null,
  constraint payment_fee_confirmed_has_who check (confirmed_at is null or confirmed_by_name is not null)
);
-- statement-breakpoint

insert into payment_fee_settings (id) values (1);
-- statement-breakpoint

-- Mudou o percentual ou a tarifa fixa sem uma nova conferência no MESMO comando: a conferência anterior deixa de valer.
create or replace function payment_fee_settings_guard()
returns trigger
language plpgsql
as $$
begin
  if (new.card_fee_bps is distinct from old.card_fee_bps or new.card_fee_fixed_cents is distinct from old.card_fee_fixed_cents)
     and new.confirmed_at is not distinct from old.confirmed_at then
    new.confirmed_at := null;
    new.confirmed_by := null;
    new.confirmed_by_name := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
-- statement-breakpoint

create trigger payment_fee_settings_guard before update on payment_fee_settings
  for each row execute function payment_fee_settings_guard();
-- statement-breakpoint

-- Taxa que o cliente paga, em centavos: total = arredondar((base + fixa) / (1 − percentual)); taxa = total − base. Aritmética de inteiros
-- (nada de ponto flutuante); metade do centavo arredonda para cima. Exemplo: base R$ 100,00, 5,37% e R$ 0,37 → total R$ 106,07, taxa R$ 6,07.
create or replace function card_fee_cents(p_base_cents integer, p_bps integer, p_fixed_cents integer)
returns integer
language sql
immutable
strict
as $$
  select ((((p_base_cents::bigint + p_fixed_cents) * 10000) * 2 + (10000 - p_bps)) / (2 * (10000 - p_bps)) - p_base_cents)::integer;
$$;
-- statement-breakpoint

-- Parte de um valor em pontos-base (250 = 2,5%), em centavos inteiros; metade do centavo arredonda para cima. R$ 100,00 a 250 → R$ 2,50.
create or replace function service_fee_cents(p_base_cents integer, p_bps integer)
returns integer
language sql
immutable
strict
as $$
  select ((p_base_cents::bigint * p_bps + 5000) / 10000)::integer;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- O pedido guarda a taxa cobrada do cliente e os valores com que ela foi calculada
-- ---------------------------------------------------------------------------------------------

alter table orders
  add column payment_fee numeric(10, 2) not null default 0 check (payment_fee >= 0),
  add column payment_fee_bps integer check (payment_fee_bps is null or payment_fee_bps between 0 and 2500),
  add column payment_fee_fixed numeric(10, 2) check (payment_fee_fixed is null or payment_fee_fixed >= 0);
-- statement-breakpoint

-- Pedido de cartão online ou de Pix online: o total é SEMPRE a soma das partes (itens + entrega − desconto + taxa), inclusive com taxa zero (os pedidos de
-- Pix online antigos já cumprem isto: taxa 0). Qualquer outro pedido não tem taxa. Nada existente é reavaliado de forma diferente.
alter table orders
  add constraint orders_payment_fee_total check (
    case when payment_method in ('card_online', 'pix_online') then total = subtotal + delivery_fee - discount + payment_fee else payment_fee = 0 end
  );
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Cobranças: o cartão entra ao lado do Pix
-- ---------------------------------------------------------------------------------------------

alter table payments drop constraint payments_method_check;
-- statement-breakpoint

alter table payments add constraint payments_method_check check (method in ('pix', 'card'));
-- statement-breakpoint

alter table payments
  -- A taxa do cartão que está dentro de amount_cents (cópia do pedido): é com ela que a loja confere a tarifa que a operadora informa.
  add column customer_fee_cents integer not null default 0 check (customer_fee_cents >= 0),
  add column last_attempt_at timestamptz,
  add column card_attempts integer not null default 0 check (card_attempts >= 0),
  add constraint payments_customer_fee_within_amount check (customer_fee_cents < amount_cents);
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
  -- Cartão de crédito online: a taxa de processamento paga pelo cliente (calculada aqui, em centavos) e os valores com que ela foi calculada.
  v_card_fee numeric(10, 2) := 0;
  v_fee_bps integer;
  v_fee_fixed numeric(10, 2);
  v_fs payment_fee_settings;
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
  -- Troca de energético (combos): o produto da linha é o combo; v_swaps guarda, linha a linha, o energético escolhido no lugar do que vem nele.
  v_swaps uuid[] := '{}';
  v_swap products;
  v_base products;
  v_line_unit numeric(10, 2);
  v_line_name text;
  v_diff numeric(10, 2);
  v_base_price numeric(10, 2);
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
  -- Pagamento online (Pix e cartão): sem uma conta (subconta) aprovada na operadora não há como cobrar. (O painel também não deixa ligar o meio de pagamento assim.)
  if is_online_payment(v_payment) and not exists (select 1 from merchant_accounts a where a.status = 'approved') then
    raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
  end if;
  -- Cartão online: só com a taxa conferida pelo dono (o painel não deixa ligar sem isso; aqui é a segunda trava) e com e-mail (a operadora exige).
  if v_payment = 'card_online' then
    select * into v_fs from payment_fee_settings where id = 1;
    if not found or v_fs.confirmed_at is null then
      raise exception 'O pagamento online não está disponível agora. Escolha outra forma de pagamento.' using errcode = 'P0001';
    end if;
    if v_email is null then
      raise exception 'Informe o seu e-mail para pagar com cartão de crédito.' using errcode = 'P0001';
    end if;
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
       or (nullif(e ->> 'swap_to', '') is not null and (e ->> 'swap_to') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then
    raise exception 'Os itens do pedido são inválidos. Atualize a página e tente de novo.' using errcode = 'P0001';
  end if;

  -- Trava de uma vez, sempre na ordem dos ids, todos os produtos do pedido e os energéticos escolhidos nas trocas: pedidos simultâneos
  -- seguem a mesma ordem e não ficam esperando um ao outro.
  perform 1 from products p
   where p.id in (
     select (e ->> 'product_id')::uuid from jsonb_array_elements(payload -> 'items') e
     union
     select (e ->> 'swap_to')::uuid from jsonb_array_elements(payload -> 'items') e where nullif(e ->> 'swap_to', '') is not null
   )
   order by p.id
     for update;

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
      select x.ice, x.swap_to, sum(x.qty)::integer as qty
      from (
        select case when v_requires and e ->> 'ice_choice' in ('normal', 'flavored') then e ->> 'ice_choice' end as ice,
               nullif(e ->> 'swap_to', '')::uuid as swap_to,
               (e ->> 'quantity')::integer as qty
        from jsonb_array_elements(payload -> 'items') e
        where (e ->> 'product_id')::uuid = v_item.product_id
      ) x
      group by x.ice, x.swap_to
      order by x.ice nulls first, x.swap_to nulls first
    loop
      if v_requires and v_line.ice is null then
        v_missing := v_missing || jsonb_build_object('product_id', v_product.id, 'name', v_product.name);
        continue;
      end if;

      v_line_unit := v_unit;
      v_line_name := v_product.name;
      if v_line.swap_to is not null then
        -- Troca do energético que vem no combo. O preço NUNCA cai: a linha custa o combo + a diferença (se o novo for mais caro que o que vem
        -- no combo; se for igual ou mais barato, a diferença é zero e não há devolução). O banco confere tudo: o produto precisa ter o energético
        -- do combo definido, o novo precisa ser um energético de 2L diferente dele, ativo e com estoque.
        if v_product.swap_base_product_id is null and v_product.swap_base_price is null then
          raise exception '% não aceita troca de energético.', v_product.name using errcode = 'P0001';
        end if;
        select * into v_swap from products n where n.id = v_line.swap_to;
        if not found or not v_swap.active or (
          v_swap.category_id is not null
          and not exists (select 1 from categories c where c.id = v_swap.category_id and c.active)
        ) then
          raise exception 'O energético escolhido para a troca não está mais disponível. Atualize a página.' using errcode = 'P0001';
        end if;
        if v_swap.id is not distinct from v_product.swap_base_product_id then
          raise exception 'Escolha um energético diferente do que já vem no combo.' using errcode = 'P0001';
        end if;
        -- Com uma lista de energéticos escolhida no painel para este combo, só valem os da lista; sem lista, vale qualquer energético de 2L.
        if exists (select 1 from product_swap_options o where o.product_id = v_product.id) then
          if not exists (select 1 from product_swap_options o where o.product_id = v_product.id and o.option_id = v_swap.id) then
            raise exception 'Escolha um dos energéticos oferecidos para a troca deste combo.' using errcode = 'P0001';
          end if;
        elsif not is_energetic_2l(v_swap.name, (select c.name from categories c where c.id = v_swap.category_id)) then
          raise exception 'Escolha um energético de 2L diferente do que já vem no combo.' using errcode = 'P0001';
        end if;
        if v_swap.sold_out then
          raise exception '% está esgotado. Escolha outro energético.', v_swap.name using errcode = 'P0001';
        end if;
        if v_swap.stock is not null and v_swap.stock < v_line.qty then
          raise exception 'Temos só % unidade(s) de %.', v_swap.stock, v_swap.name using errcode = 'P0001';
        end if;
        -- O valor do energético que vem no combo: o preço de agora do produto escolhido no painel ou, se o energético do combo não é um
        -- produto do cardápio, o valor digitado no painel.
        if v_product.swap_base_product_id is not null then
          select * into v_base from products b where b.id = v_product.swap_base_product_id;
          v_base_price := coalesce(effective_promo(v_base.promo_price, v_base.promo_starts_at, v_base.promo_ends_at), v_base.price);
        else
          v_base_price := v_product.swap_base_price;
        end if;
        v_diff := greatest(
          0,
          coalesce(effective_promo(v_swap.promo_price, v_swap.promo_starts_at, v_swap.promo_ends_at), v_swap.price) - v_base_price
        );
        v_line_unit := v_unit + v_diff;
        v_line_name := v_product.name || ' — troca do energético por ' || v_swap.name
                       || case when v_diff > 0 then ' (+ ' || format_brl(v_diff) || ')' else ' (sem diferença)' end;
        if v_swap.stock is not null then
          update products set stock = stock - v_line.qty where id = v_swap.id;
        end if;
      end if;

      v_subtotal := v_subtotal + v_line_unit * v_line.qty;
      v_ids := array_append(v_ids, v_product.id);
      v_names := array_append(v_names, v_line_name);
      v_qtys := array_append(v_qtys, v_line.qty);
      v_units := array_append(v_units, v_line_unit);
      v_ices := array_append(v_ices, v_line.ice);
      v_swaps := array_append(v_swaps, v_line.swap_to);
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

  -- Cartão online: o cliente paga também a taxa de processamento. A base é tudo o que vai no cartão (itens + entrega); a conta é a de
  -- card_fee_cents(), em centavos inteiros. Nada disto vem do navegador: o total que a pessoa vê é só conferido abaixo (expected_total).
  if v_payment = 'card_online' then
    v_fee_bps := v_fs.card_fee_bps;
    v_fee_fixed := v_fs.card_fee_fixed_cents / 100.0;
    v_card_fee := card_fee_cents(round(v_total * 100)::integer, v_fs.card_fee_bps, v_fs.card_fee_fixed_cents) / 100.0;
    v_total := v_total + v_card_fee;
  elsif v_payment = 'pix_online' then
    -- Pix online: taxa de serviço do cliente (2,5% de itens + entrega). A parte do estabelecimento (outros 2,5%) não entra no total: sai do valor que a
    -- subconta recebe (ver payment_begin). Também só o banco calcula; o navegador só confere o total (expected_total).
    select * into v_fs from payment_fee_settings where id = 1;
    v_fee_bps := v_fs.pix_customer_fee_bps;
    v_card_fee := service_fee_cents(round(v_total * 100)::integer, v_fs.pix_customer_fee_bps) / 100.0;
    v_total := v_total + v_card_fee;
  end if;

  -- O valor mudou entre a tela do cliente e o envio (preço, promoção, taxa): nada é criado (o estoque reservado acima volta
  -- junto) e o site recebe o valor atual para a pessoa confirmar de olhos abertos.
  if v_expected is not null and v_expected <> v_total then
    raise exception 'Os valores do pedido mudaram. Confira o novo total antes de enviar.'
      using errcode = 'CC409',
            detail = jsonb_build_object(
              'code', 'price_changed',
              'subtotal', v_subtotal,
              'delivery_fee', v_fee,
              'payment_fee', v_card_fee,
              'total', v_total,
              'items', (
                select coalesce(jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'quantity', x.qty, 'unit_price', x.unit, 'ice_choice', x.ice, 'swap_to', x.swap) order by x.name, x.ice nulls first), '[]'::jsonb)
                from unnest(v_ids, v_names, v_qtys, v_units, v_ices, v_swaps) as x (id, name, qty, unit, ice, swap)
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
    subtotal, delivery_fee, discount, total, payment_method, change_for, payment_fee, payment_fee_bps, payment_fee_fixed,
    customer_id, customer_linked_at, idempotency_key, request_hash, order_status
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, 0, v_total, v_payment, v_change, v_card_fee, v_fee_bps, v_fee_fixed,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash,
    -- Pagamento online: o pedido já reserva o estoque, mas só chega à loja ("novo") depois que o pagamento for confirmado.
    case when is_online_payment(v_payment) then 'awaiting_payment' else 'new' end
  )
  returning * into v_order;

  insert into order_items (order_id, product_id, product_name, quantity, unit_price, total_price, ice_choice, swap_to_product_id)
  select v_order.id, x.id, x.name, x.qty, x.unit, x.unit * x.qty, x.ice, x.swap
  from unnest(v_ids, v_names, v_qtys, v_units, v_ices, v_swaps) as x (id, name, qty, unit, ice, swap);

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
-- Tentativa de cobrança no cartão (sem duplicar)
-- • Trava o pedido: cliques repetidos e requisições simultâneas passam um de cada vez.
-- • Só uma tentativa em aberto por pedido (índice payments_one_open_per_order) e ela NUNCA dá lugar a outra enquanto não tiver resultado:
--   - aguardando a operadora (pending): devolve a mesma, sem cobrar de novo;
--   - criando e recente (busy): outra requisição está falando com a operadora agora;
--   - criando e sem resultado (a resposta se perdeu): devolve a MESMA tentativa para ser refeita. O identificador que a loja manda à
--     operadora é o id desta tentativa, então a operadora recusa a duplicata e devolve a cobrança original em vez de cobrar duas vezes.
-- • O valor e a taxa saem do pedido gravado no banco, nunca do navegador.
-- • O CARTÃO É UM FLUXO SEPARADO DO PIX: cobrado na SUBCONTA do estabelecimento (a mesma do Pix), mas SEM divisão (a comissão é "não se aplica").
--   O Pix continua com a divisão de sempre (payment_begin, que só aceita pedido de Pix online).
-- ---------------------------------------------------------------------------------------------

create or replace function payment_begin_card(p_order uuid, p_provider text, p_busy_seconds integer default 45)
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
  select * into v_order from orders where id = p_order for update;
  if not found then
    raise exception 'Pedido não encontrado.' using errcode = 'P0001';
  end if;
  if v_order.payment_method is distinct from 'card_online' then
    raise exception 'Este pedido não é de cartão online.' using errcode = 'P0001';
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
    if v_open.method <> 'card' then
      raise exception 'Este pedido já tem um pagamento em andamento.' using errcode = 'P0001';
    end if;
    if v_open.status = 'pending' then
      return jsonb_build_object('created', false, 'busy', false, 'retry', false, 'payment', to_jsonb(v_open), 'order_number', v_order.order_number, 'merchant_account', v_merchant.provider_account_id);
    end if;
    if coalesce(v_open.last_attempt_at, v_open.created_at) > now() - make_interval(secs => p_busy_seconds) then
      return jsonb_build_object('created', false, 'busy', true, 'retry', false, 'payment', to_jsonb(v_open), 'order_number', v_order.order_number, 'merchant_account', v_merchant.provider_account_id);
    end if;
    update payments set last_attempt_at = now(), card_attempts = card_attempts + 1 where id = v_open.id returning * into v_open;
    return jsonb_build_object('created', false, 'busy', false, 'retry', true, 'payment', to_jsonb(v_open), 'order_number', v_order.order_number, 'merchant_account', v_merchant.provider_account_id);
  end if;

  select count(*) into v_attempts from payments where order_id = p_order;
  if v_attempts >= 5 then
    raise exception 'Já foram feitas várias tentativas de pagamento para este pedido. Fale com a loja.' using errcode = 'P0001';
  end if;

  v_amount := round(v_order.total * 100)::integer;
  if v_amount <= 0 then
    raise exception 'Este pedido não tem valor a pagar.' using errcode = 'P0001';
  end if;

  insert into payments (order_id, attempt, provider, method, merchant_account_id, amount_cents, commission_bps, commission_cents, commission_state,
                        customer_fee_cents, last_attempt_at, card_attempts)
  values (p_order, v_attempts + 1, p_provider, 'card', v_merchant.id, v_amount, 0, 0, 'not_applicable',
          round(v_order.payment_fee * 100)::integer, now(), 1)
  returning * into v_new;

  return jsonb_build_object('created', true, 'busy', false, 'retry', false, 'payment', to_jsonb(v_new), 'order_number', v_order.order_number, 'merchant_account', v_merchant.provider_account_id);
end;
$$;
-- statement-breakpoint

-- A operadora respondeu com o código da cobrança: a tentativa passa a aguardar a confirmação (o resultado é aplicado por payment_apply).
-- Cartão não tem validade (expires_at fica vazio): nada aqui é cancelado por vencimento.
create or replace function payment_card_mark_charge(p_payment uuid, p_charge_id text, p_provider_status text default null)
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
       set status = 'pending',
           provider_charge_id = coalesce(provider_charge_id, p_charge_id),
           provider_status = left(p_provider_status, 80),
           checked_at = now()
     where id = p_payment
    returning * into v_pay;
    return jsonb_build_object('updated', true, 'payment', to_jsonb(v_pay));
  end if;
  -- Já encerrada (por exemplo, o pedido foi cancelado enquanto a operadora respondia): só guarda o código para conferência.
  update payments
     set provider_charge_id = coalesce(provider_charge_id, p_charge_id),
         needs_attention = needs_attention or v_pay.status in ('failed', 'expired', 'cancelled'),
         attention_reason = case when v_pay.status in ('failed', 'expired', 'cancelled') and attention_reason is null
                                 then 'A operadora criou uma cobrança no cartão depois que a tentativa já tinha sido encerrada. Confira e estorne se for o caso.'
                                 else attention_reason end
   where id = p_payment
  returning * into v_pay;
  return jsonb_build_object('updated', false, 'payment', to_jsonb(v_pay));
end;
$$;
-- statement-breakpoint

-- Tentativa de cartão sem desfecho. "Criando" (sem resposta da operadora): NUNCA é encerrada às cegas (o cartão pode ter sido cobrado): depois de
-- `p_flag_minutes` fica sinalizada para o dono; depois de `p_close_minutes` é encerrada (também sinalizada) para o estoque não ficar preso.
create or replace function payment_card_stale(p_payment uuid, p_flag_minutes integer default 5, p_close_minutes integer default 30)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_pay payments;
  v_since timestamptz;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  perform 1 from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;
  if v_pay.method <> 'card' or v_pay.status not in ('creating', 'pending') then
    return jsonb_build_object('changed', false, 'payment', to_jsonb(v_pay));
  end if;
  -- Aguardando a operadora decidir (ela devolveu o código da cobrança, mas ainda não disse "paga" nem "recusada") há mais de uma hora:
  -- só sinaliza (a cobrança existe e continua valendo; o aviso ou a conferência ainda podem concluí-la).
  if v_pay.status = 'pending' then
    if v_pay.created_at < now() - interval '60 minutes' and not v_pay.needs_attention then
      update payments
         set needs_attention = true,
             attention_reason = 'A operadora ainda não confirmou nem recusou este pagamento no cartão (mais de uma hora). Confira na ValidaPay.'
       where id = p_payment
      returning * into v_pay;
      return jsonb_build_object('changed', true, 'payment', to_jsonb(v_pay));
    end if;
    return jsonb_build_object('changed', false, 'payment', to_jsonb(v_pay));
  end if;
  v_since := coalesce(v_pay.last_attempt_at, v_pay.created_at);
  if v_since < now() - make_interval(mins => p_close_minutes) then
    update payments
       set status = 'failed',
           closed_at = now(),
           last_error = 'sem resposta da operadora',
           needs_attention = true,
           attention_reason = 'Sem resposta da operadora ao cobrar no cartão há mais de ' || p_close_minutes || ' minutos. Confira na ValidaPay se o cartão foi cobrado; se foi, estorne o valor.'
     where id = p_payment
    returning * into v_pay;
    return jsonb_build_object('changed', true, 'payment', to_jsonb(v_pay));
  end if;
  if v_since < now() - make_interval(mins => p_flag_minutes) and not v_pay.needs_attention then
    update payments
       set needs_attention = true,
           attention_reason = 'Sem resposta da operadora ao cobrar no cartão. Confira na ValidaPay se o cartão foi cobrado antes de pedir outra tentativa.'
     where id = p_payment
    returning * into v_pay;
    return jsonb_build_object('changed', true, 'payment', to_jsonb(v_pay));
  end if;
  return jsonb_build_object('changed', false, 'payment', to_jsonb(v_pay));
end;
$$;
-- statement-breakpoint

-- O Pix passa a valer só para pedido de Pix online (antes bastava ser "pagamento online", o que agora inclui o cartão). Mesma função da migration 0014,
-- com uma única mudança: a trava abaixo.
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
  v_customer_fee integer;
  v_store_bps integer;
  v_comm_bps integer;
  v_comm_cents integer;
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
  -- Só o pedido de Pix online gera Pix: o pedido de cartão tem o total com a taxa do cartão e outro fluxo (payment_begin_card). Sem esta trava,
  -- o endereço do Pix poderia fechar uma tentativa de cartão em andamento ou cobrar o total do cartão pelo Pix (e com comissão).
  if v_order.payment_method = 'card_online' then
    raise exception 'Este pedido é de cartão online: o pagamento é feito com o cartão.' using errcode = 'P0001';
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

  -- A divisão para a master. Pedido NOVO de Pix online (com taxa de serviço): a master recebe 5% do valor do pedido (2,5% pago pelo cliente + 2,5% do
  -- estabelecimento), arredondado UMA vez; a base é o valor cobrado menos a taxa do cliente. Pedido antigo (sem taxa de serviço): a comissão com que nasceu.
  v_customer_fee := round(v_order.payment_fee * 100)::integer;
  if v_order.payment_fee_bps is not null then
    select pix_store_fee_bps into v_store_bps from payment_fee_settings where id = 1;
    v_comm_bps := v_order.payment_fee_bps + v_store_bps;
    v_comm_cents := service_fee_cents(v_amount - v_customer_fee, v_comm_bps);
  else
    v_comm_bps := payment_commission_bps();
    v_comm_cents := payment_commission_cents(v_amount, v_comm_bps);
  end if;

  insert into payments (order_id, attempt, provider, method, merchant_account_id, amount_cents, commission_bps, commission_cents, customer_fee_cents)
  values (p_order, v_attempts + 1, p_provider, p_method, v_merchant.id, v_amount, v_comm_bps, v_comm_cents, v_customer_fee)
  returning * into v_new;

  return jsonb_build_object(
    'created', true,
    'payment', to_jsonb(v_new),
    'order_number', v_order.order_number,
    'merchant_account', v_merchant.provider_account_id
  );
end;
$$;
