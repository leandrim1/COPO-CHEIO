-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 28/28 · Devolução (estorno) de pagamentos online pela API da operadora, com registro de cada pedido de devolução.
--
-- Antes: "reembolsado" de um pagamento online só aparecia quando a operadora informava que a cobrança foi estornada (a devolução era feita no painel dela).
-- Agora o dono (owner) também pode PEDIR a devolução pelo painel da loja. O dinheiro só é dado como devolvido quando a operadora CONFIRMA; até lá o pedido
-- fica "aguardando". Nada aqui muda um pagamento ou pedido existente.
--
-- • payment_refunds: um registro por pedido de devolução (quem pediu, quanto, por quê, em que estado está, o código da operadora).
--     requested  → a loja decidiu pedir e AINDA NÃO SABE se a operadora recebeu (resposta perdida, tempo esgotado): ambíguo, conferir antes de repetir
--     processing → a operadora recebeu e está devolvendo
--     confirmed  → a operadora confirmou que o valor voltou ao pagador
--     failed     → a operadora recusou ou a devolução falhou (nada foi devolvido)
--   Um índice impede DOIS pedidos abertos (requested/processing) para o mesmo pagamento: duplo clique e nova tentativa depois de uma resposta perdida
--   nunca devolvem em dobro. Confirmado e falho são finais (um aviso atrasado ou repetido não desfaz nem repete nada).
-- • refund_begin: confere (travando pedido e pagamento) se o pagamento está confirmado, se há valor a devolver e se não há outro pedido aberto; grava o pedido.
-- • refund_update: muda o estado de um pedido sem nunca voltar atrás.
--
-- Registro financeiro: sem "on delete cascade" e fora da limpeza automática (como a tabela payments).

create table payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments (id),
  order_id uuid not null references orders (id),
  provider text not null check (char_length(provider) between 2 and 30),
  provider_refund_id text check (provider_refund_id is null or char_length(provider_refund_id) <= 120),
  amount_cents integer not null check (amount_cents > 0),
  reason text not null check (reason in ('CUSTOMER_REQUEST', 'FRAUD', 'BANK_ERROR', 'PIX_CHANGE_ERROR')),
  status text not null default 'requested' check (status in ('requested', 'processing', 'confirmed', 'failed')),
  requested_by uuid references admins (id) on delete set null,
  requested_by_name text check (requested_by_name is null or char_length(requested_by_name) <= 120),
  note text check (note is null or char_length(note) <= 200),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  requested_at timestamptz not null default now(),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index payment_refunds_provider_refund_key on payment_refunds (provider, provider_refund_id) where provider_refund_id is not null;
-- statement-breakpoint

create unique index payment_refunds_one_open_idx on payment_refunds (payment_id) where status in ('requested', 'processing');
-- statement-breakpoint

create index payment_refunds_payment_idx on payment_refunds (payment_id, created_at);
-- statement-breakpoint

create trigger payment_refunds_updated_at before update on payment_refunds
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Pede uma devolução. Devolve o registro criado (e os dados da cobrança que o servidor precisa para falar com a operadora). Erros em português (P0001).
create or replace function refund_begin(p_payment uuid, p_amount integer, p_reason text, p_admin uuid, p_note text default null)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_order_id uuid;
  v_order orders;
  v_pay payments;
  v_name text;
  v_left integer;
  v_amount integer;
  v_row payment_refunds;
begin
  select order_id into v_order_id from payments where id = p_payment;
  if not found then
    raise exception 'Pagamento não encontrado.' using errcode = 'P0001';
  end if;
  -- Mesma ordem de trava das outras funções de pagamento: pedido primeiro, depois a cobrança.
  select * into v_order from orders where id = v_order_id for update;
  select * into v_pay from payments where id = p_payment for update;

  if p_reason is null or p_reason not in ('CUSTOMER_REQUEST', 'FRAUD', 'BANK_ERROR', 'PIX_CHANGE_ERROR') then
    raise exception 'Escolha o motivo da devolução.' using errcode = 'P0001';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Este pagamento já foi devolvido por completo.' using errcode = 'P0001';
  end if;
  if v_pay.status <> 'paid' then
    raise exception 'Só dá para devolver um pagamento que foi confirmado pela operadora.' using errcode = 'P0001';
  end if;
  if v_pay.provider_charge_id is null then
    raise exception 'Este pagamento não tem o código da cobrança na operadora.' using errcode = 'P0001';
  end if;
  if exists (select 1 from payment_refunds r where r.payment_id = p_payment and r.status in ('requested', 'processing')) then
    raise exception 'Já existe uma devolução em andamento para este pagamento. Aguarde a confirmação da operadora ou confira o andamento antes de pedir outra.'
      using errcode = 'CC409', detail = '{"code":"refund_open"}';
  end if;

  v_left := v_pay.amount_cents - v_pay.refunded_cents;
  v_amount := coalesce(p_amount, v_left);
  if v_left <= 0 then
    raise exception 'Não há valor a devolver neste pagamento.' using errcode = 'P0001';
  end if;
  if v_amount <= 0 or v_amount > v_left then
    raise exception 'O valor da devolução precisa ficar entre R$ 0,01 e R$ % (o que ainda não foi devolvido).', replace(to_char(v_left / 100.0, 'FM999999990.00'), '.', ',')
      using errcode = 'P0001';
  end if;

  select a.name into v_name from admins a where a.id = p_admin;
  insert into payment_refunds (payment_id, order_id, provider, amount_cents, reason, requested_by, requested_by_name, note)
  values (p_payment, v_order_id, v_pay.provider, v_amount, p_reason, p_admin, left(v_name, 120), nullif(left(btrim(coalesce(p_note, '')), 200), ''))
  returning * into v_row;

  return to_jsonb(v_row) || jsonb_build_object(
    'provider_charge_id', v_pay.provider_charge_id,
    'method', v_pay.method,
    'order_number', v_order.order_number,
    'payment_amount_cents', v_pay.amount_cents
  );
end;
$$;
-- statement-breakpoint

-- Muda o estado de um pedido de devolução, sem nunca voltar atrás: confirmado e falho são finais; "aguardando resposta" não volta de "devolvendo".
create or replace function refund_update(p_refund uuid, p_status text, p_provider_refund_id text default null, p_error text default null)
returns payment_refunds
language plpgsql
volatile
as $$
declare
  v_r payment_refunds;
begin
  if p_status not in ('requested', 'processing', 'confirmed', 'failed') then
    raise exception 'Estado de devolução inválido.' using errcode = 'P0001';
  end if;
  select * into v_r from payment_refunds where id = p_refund for update;
  if not found then
    raise exception 'Devolução não encontrada.' using errcode = 'P0001';
  end if;
  if v_r.status in ('confirmed', 'failed') then
    return v_r;
  end if;
  if v_r.status = 'processing' and p_status = 'requested' then
    return v_r;
  end if;
  update payment_refunds
     set status = p_status,
         provider_refund_id = coalesce(p_provider_refund_id, provider_refund_id),
         last_error = case when p_status = 'failed' then left(coalesce(p_error, last_error), 300) else last_error end,
         confirmed_at = case when p_status = 'confirmed' then now() else confirmed_at end
   where id = p_refund
  returning * into v_r;
  return v_r;
end;
$$;
