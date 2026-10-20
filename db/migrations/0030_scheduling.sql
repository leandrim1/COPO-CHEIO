-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 30/30 · Agendamento de entrega/retirada, feriados e horários especiais.
--
-- • store_settings.scheduling_enabled (DESLIGADO por padrão), schedule_lead_minutes (antecedência mínima), schedule_max_days (até quantos dias à frente),
--   schedule_slot_minutes (tamanho da faixa: 15, 30, 60 ou 120 min) e schedule_slot_capacity (pedidos por faixa; vazio = sem limite).
-- • store_exceptions: um dia especial por linha. closed = a loja não abre naquele dia (feriado); custom = abre naquele dia só das start_time às end_time (sem virar a meia-noite).
--   O dia especial vale para os pedidos de agora e para os agendados. Nenhum dia especial existe depois da migration.
-- • orders.scheduled_for: o horário escolhido (sempre o INÍCIO de uma faixa). Pedido sem agendamento fica com NULL e nada muda para ele.
-- • store_open_at(ts): a mesma regra de store_open_now() para um instante qualquer, com os dias especiais. store_open_now() passa a usar store_open_at(now()).
-- • schedule_check(ts) devolve o motivo (em português) de um horário não servir, ou NULL; schedule_slots(dia) lista as faixas do dia com a disponibilidade.
-- • create_order e order_json trocados por versões iguais às da 0029 em tudo o que já existe: sem `scheduled_for` o pedido sai idêntico ao de antes.
--
-- Só acrescenta colunas (com padrões que não mudam nenhum pedido), tabelas e funções. Nenhum dado é apagado ou alterado.

alter table store_settings
  add column scheduling_enabled boolean not null default false,
  add column schedule_lead_minutes integer not null default 60 check (schedule_lead_minutes between 0 and 10080),
  add column schedule_max_days integer not null default 7 check (schedule_max_days between 1 and 30),
  add column schedule_slot_minutes integer not null default 30 check (schedule_slot_minutes in (15, 30, 60, 120)),
  add column schedule_slot_capacity integer check (schedule_slot_capacity is null or schedule_slot_capacity between 1 and 1000);
-- statement-breakpoint

create table store_exceptions (
  day date primary key,
  kind text not null check (kind in ('closed', 'custom')),
  start_time time,
  end_time time,
  reason text check (reason is null or char_length(reason) <= 80),
  created_by uuid references admins (id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'closed' and start_time is null and end_time is null) or (kind = 'custom' and start_time is not null and end_time is not null and (start_time < end_time or start_time = end_time)))
);
-- statement-breakpoint

alter table orders add column scheduled_for timestamptz;
-- statement-breakpoint

create index orders_scheduled_idx on orders (scheduled_for) where scheduled_for is not null;
-- statement-breakpoint

-- A janela de abertura de uma data (no fuso da loja): { open, start, end } vinda do dia especial, se houver, ou da semana.
create or replace function store_window(p_day date, p_hours jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  x store_exceptions;
  days constant text[] := array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  d jsonb;
begin
  select * into x from store_exceptions where day = p_day;
  if found then
    if x.kind = 'closed' then
      return jsonb_build_object('open', false);
    end if;
    return jsonb_build_object('open', true, 'start', x.start_time::text, 'end', x.end_time::text);
  end if;
  d := p_hours -> days[extract(dow from p_day)::integer + 1];
  return jsonb_build_object('open', coalesce((d ->> 'open')::boolean, false), 'start', d ->> 'start', 'end', d ->> 'end');
end;
$$;
-- statement-breakpoint

-- A loja está (estaria) aberta neste instante? Mesma regra de sempre (início = fim é 24 horas; fim antes do início atravessa a meia-noite), agora com os dias especiais.
-- Não olha "pedidos pausados": isso é outra regra, conferida à parte.
create or replace function store_open_at(p_at timestamptz)
returns boolean
language plpgsql
stable
as $$
declare
  s store_settings;
  local_at timestamp;
  t time;
  today jsonb;
  yesterday jsonb;
begin
  select * into s from store_settings where id = 1;
  if not found then
    return false;
  end if;
  local_at := p_at at time zone s.timezone;
  t := local_at::time;
  today := store_window(local_at::date, s.opening_hours);
  yesterday := store_window(local_at::date - 1, s.opening_hours);

  if (today ->> 'open')::boolean then
    if (today ->> 'start')::time = (today ->> 'end')::time then
      return true;
    elsif (today ->> 'start')::time < (today ->> 'end')::time then
      if t >= (today ->> 'start')::time and t < (today ->> 'end')::time then
        return true;
      end if;
    elsif t >= (today ->> 'start')::time then
      return true;
    end if;
  end if;

  -- Madrugada de um dia que começou ontem (só a semana atravessa a meia-noite; dia especial não).
  return (yesterday ->> 'open')::boolean
    and (yesterday ->> 'start')::time > (yesterday ->> 'end')::time
    and t < (yesterday ->> 'end')::time;
end;
$$;
-- statement-breakpoint

create or replace function store_open_now()
returns boolean
language plpgsql
stable
as $$
declare
  s store_settings;
begin
  select * into s from store_settings where id = 1;
  if not found or s.orders_paused then
    return false;
  end if;
  return store_open_at(now());
end;
$$;
-- statement-breakpoint

-- Este horário serve para um pedido agendado? NULL = serve; senão, o motivo em português.
create or replace function schedule_check(p_at timestamptz)
returns text
language plpgsql
stable
as $$
declare
  s store_settings;
  local_at timestamp;
  minute_of_day integer;
  used integer;
begin
  select * into s from store_settings where id = 1;
  if not found or not s.scheduling_enabled then
    return 'O agendamento de pedidos não está disponível no momento.';
  end if;
  local_at := p_at at time zone s.timezone;
  minute_of_day := extract(hour from local_at)::integer * 60 + extract(minute from local_at)::integer;
  if extract(second from local_at) <> 0 or minute_of_day % s.schedule_slot_minutes <> 0 then
    return 'Escolha um dos horários da lista.';
  end if;
  if p_at < now() + make_interval(mins => s.schedule_lead_minutes) then
    return 'Esse horário já passou ou está muito perto. Escolha um horário mais à frente.';
  end if;
  if p_at > now() + make_interval(days => s.schedule_max_days) then
    return 'Só dá para agendar para os próximos ' || s.schedule_max_days || ' dia(s).';
  end if;
  if not store_open_at(p_at) then
    return 'A loja não abre nesse horário. Escolha outro.';
  end if;
  if s.schedule_slot_capacity is not null then
    select count(*) into used from orders o where o.scheduled_for = p_at and o.order_status <> 'cancelled';
    if used >= s.schedule_slot_capacity then
      return 'Esse horário já está lotado. Escolha outro.';
    end if;
  end if;
  return null;
end;
$$;
-- statement-breakpoint

-- As faixas de um dia (no fuso da loja) que a loja atende, com a disponibilidade: [{ at, time, available, reason }]. Só mostra o que passa da antecedência, do limite
-- de dias e do horário de funcionamento; "lotado" aparece como indisponível.
create or replace function schedule_slots(p_day date)
returns jsonb
language plpgsql
stable
as $$
declare
  s store_settings;
  n integer;
  total integer;
  at_ts timestamptz;
  err text;
  out jsonb := '[]'::jsonb;
begin
  select * into s from store_settings where id = 1;
  if not found or not s.scheduling_enabled then
    return out;
  end if;
  total := 1440 / s.schedule_slot_minutes;
  for n in 0 .. total - 1 loop
    at_ts := (p_day::timestamp + make_interval(mins => n * s.schedule_slot_minutes)) at time zone s.timezone;
    err := schedule_check(at_ts);
    if err is null then
      out := out || jsonb_build_array(jsonb_build_object('at', at_ts, 'time', to_char(p_day::timestamp + make_interval(mins => n * s.schedule_slot_minutes), 'HH24:MI'), 'available', true));
    elsif err like '%lotado%' then
      out := out || jsonb_build_array(jsonb_build_object('at', at_ts, 'time', to_char(p_day::timestamp + make_interval(mins => n * s.schedule_slot_minutes), 'HH24:MI'), 'available', false));
    end if;
  end loop;
  return out;
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
  -- Maioridade (18+): pedido com bebida alcoólica exige a declaração do cliente (age_confirmed = true, booleano; texto "true" não vale). É uma
  -- DECLARAÇÃO, não uma prova de idade: o documento com foto é conferido na entrega ou na retirada (admin_set_order_status).
  v_alcoholic boolean := false;
  v_age_ok boolean := coalesce(payload -> 'age_confirmed', 'false'::jsonb) = 'true'::jsonb;
  v_age_version text := case when coalesce(payload ->> 'age_text_version', '') ~ '^v[0-9]{1,3}$' then payload ->> 'age_text_version' else 'v1' end;
  -- Cupom e frete grátis: tudo calculado aqui, com os preços do banco. O navegador só manda o CÓDIGO do cupom (e o total que viu, para conferir).
  v_coupon_code text := upper(btrim(coalesce(payload ->> 'coupon_code', '')));
  v_coupon jsonb;
  v_discount numeric(10, 2) := 0;
  v_waived numeric(10, 2) := 0;
  v_is_promo boolean;
  -- Agendamento (opcional): data e hora de entrega/retirada escolhidas pelo cliente, conferidas aqui (horário de funcionamento, feriados, antecedência, faixas e lotação).
  v_sched_text text := nullif(btrim(coalesce(payload ->> 'scheduled_for', '')), '');
  v_sched timestamptz;
  v_sched_err text;
  v_cats uuid[] := '{}';
  v_promos boolean[] := '{}';
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
  if v_sched_text is not null then
    -- Pedido agendado: pode ser feito com a loja fechada; o que vale é a loja estar aberta NO HORÁRIO escolhido (e a loja não estar com os pedidos pausados, conferido acima).
    if not s.scheduling_enabled then
      raise exception 'O agendamento de pedidos não está disponível no momento.' using errcode = 'P0001';
    end if;
    if v_sched_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]+)?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' then
      raise exception 'Escolha um horário válido para o agendamento.' using errcode = 'P0001';
    end if;
    v_sched := v_sched_text::timestamptz;
    -- Dois pedidos para a mesma faixa, ao mesmo tempo, passam um de cada vez (a lotação não estoura).
    perform pg_advisory_xact_lock(hashtextextended('slot:' || v_sched::text, 0));
    v_sched_err := schedule_check(v_sched);
    if v_sched_err is not null then
      raise exception '%', v_sched_err using errcode = 'P0001';
    end if;
  elsif not store_open_now() then
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
    v_alcoholic := v_alcoholic or v_product.alcoholic;

    -- Promoção só vale dentro da janela de datas (sem datas, vale sempre).
    v_unit := coalesce(effective_promo(v_product.promo_price, v_product.promo_starts_at, v_product.promo_ends_at), v_product.price);
    v_is_promo := effective_promo(v_product.promo_price, v_product.promo_starts_at, v_product.promo_ends_at) is not null;

    -- Gelo: se o PRODUTO pede a escolha (marca no registro do produto, escolhida no painel; não a categoria nem o nome), cada linha
    -- precisa trazer 'normal' ou 'flavored'. Em produto que não pede, qualquer valor de ice_choice é ignorado (o pedido fica como sempre foi).
    v_requires := v_product.ice_choice_required;

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
        v_alcoholic := v_alcoholic or v_swap.alcoholic;
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
      v_cats := array_append(v_cats, v_product.category_id);
      v_promos := array_append(v_promos, v_is_promo);
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

  -- Bebida alcoólica no pedido sem a declaração de maioridade: nada é criado (o estoque reservado acima volta junto). O site recebe o código
  -- 'age_required' e pede a declaração; quem chama a API direto sem ela recebe a mesma recusa.
  if v_alcoholic and not v_age_ok then
    raise exception 'Confirme que você tem 18 anos ou mais para finalizar o pedido.'
      using errcode = 'CC400', detail = '{"code":"age_required"}';
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

  -- Cupom (opcional). Regras no banco: um cupom por pedido; só vale ativo, dentro das datas, com o pedido mínimo, dentro dos limites de uso e só para os itens elegíveis;
  -- o desconto nunca passa do valor dos itens elegíveis. O pedido mínimo da entrega (acima) e o do cupom olham o subtotal ANTES do desconto.
  if v_coupon_code <> '' then
    v_coupon := coupon_apply(v_coupon_code, v_cats, v_units, v_qtys, v_promos, v_type, v_customer, v_phone, true);
    if not (v_coupon ->> 'ok')::boolean then
      raise exception '%', v_coupon ->> 'message' using errcode = 'P0001';
    end if;
    v_discount := (v_coupon ->> 'discount')::numeric;
    if (v_coupon ->> 'free_delivery')::boolean then
      v_waived := v_fee;
      v_fee := 0;
    end if;
  end if;
  -- Frete grátis por valor: vale sobre o subtotal DEPOIS do desconto do cupom, só na entrega. Não soma com o cupom de entrega grátis (a taxa já foi zerada).
  if v_type = 'delivery' and v_fee > 0 and s.free_delivery_enabled and v_subtotal - v_discount >= s.free_delivery_min then
    v_waived := v_fee;
    v_fee := 0;
  end if;

  v_total := v_subtotal - v_discount + v_fee;

  -- Cupom que cobre o pedido inteiro (total R$ 0,00): vale para pagar na entrega ou na retirada. Pagamento online não: a operadora não cobra R$ 0,00.
  if v_total <= 0 and is_online_payment(v_payment) then
    raise exception 'Este cupom cobre o pedido inteiro. Escolha pagar na entrega ou na retirada.' using errcode = 'P0001';
  end if;

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
              'discount', v_discount,
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
    customer_id, customer_linked_at, idempotency_key, request_hash, order_status,
    age_required, age_declared_at, age_declaration_version, coupon_id, coupon_code, delivery_fee_waived, scheduled_for
  ) values (
    v_name, v_phone, v_email, v_type,
    v_address, v_number, v_neighborhood, v_complement, v_reference, v_notes,
    v_subtotal, v_fee, v_discount, v_total, v_payment, v_change, v_card_fee, v_fee_bps, v_fee_fixed,
    v_customer, case when v_customer is null then null else now() end, v_key, v_request_hash,
    -- Pagamento online: o pedido já reserva o estoque, mas só chega à loja ("novo") depois que o pagamento for confirmado.
    case when is_online_payment(v_payment) then 'awaiting_payment' else 'new' end,
    v_alcoholic, case when v_alcoholic then now() end, case when v_alcoholic then v_age_version end,
    nullif(v_coupon ->> 'id', '')::uuid, v_coupon ->> 'code', v_waived, v_sched
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
