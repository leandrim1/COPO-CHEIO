-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 19/19 · E-mails: registro de mensagens, fila com nova tentativa, supressão, consentimento, campanhas e alertas.
--
-- SÓ ACRESCENTA: tabelas novas, funções novas e gatilhos novos. Nenhuma tabela existente muda de forma (as únicas funções
-- existentes que são trocadas por versões iguais para tudo o que já existia são purge_expired_data e anonymize_person, que ganham
-- uma linha para cuidar das tabelas novas). Os e-mails de hoje (confirmação, senha, avisos) continuam saindo como saíam.
--
--  • email_messages: um registro por mensagem (tipo, categoria transacional/promocional, destinatário, estado, tentativas,
--    motivo de falha). NUNCA guarda corpo, código, link nem o assunto dos e-mails de código (o servidor grava só o nome do tipo).
--    `spec` é a "receita" para refazer um e-mail numa nova tentativa (ids, nunca segredo) e é apagada quando a mensagem termina.
--  • email_events: a linha do tempo de cada mensagem (tentativas e, se um dia o provedor mandar avisos, entrega/devolução/spam).
--  • email_suppressions: endereços que não devem receber nada (devolução definitiva, reclamação, pedido da loja).
--  • email_preferences: consentimento e descadastro de promoções e "não quero e-mails de pedidos" (link com chave própria).
--  • email_campaigns: campanhas promocionais enviadas pelo painel.
--  • email_alerts / email_webhook_state: alertas de entregabilidade e estado dos avisos do provedor.
--  • Gatilhos: toda mudança de status do pedido e todo pagamento online confirmado/reembolsado entra na fila de e-mails
--    (no máximo um por pedido e tipo). O gatilho NUNCA derruba o pedido: qualquer erro nele só vira aviso no log do banco.
--  • LGPD: email_forget apaga o endereço dos registros; anonymize_person passa a chamá-la; a limpeza automática guarda os registros
--    por 180 dias.

-- ---------------------------------------------------------------------------------------------
-- Campanhas (antes de email_messages, que aponta para elas)
-- ---------------------------------------------------------------------------------------------

create table email_campaigns (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references admins (id) on delete set null,
  created_by_name text check (created_by_name is null or char_length(created_by_name) <= 120),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  subject text not null check (char_length(btrim(subject)) between 2 and 150),
  preheader text check (preheader is null or char_length(preheader) <= 150),
  title text not null check (char_length(btrim(title)) between 2 and 100),
  -- Parágrafos separados por linha em branco; **negrito** é aceito. Sem HTML.
  body text not null check (char_length(btrim(body)) between 2 and 4000),
  cta_label text check (cta_label is null or char_length(btrim(cta_label)) between 2 and 40),
  cta_url text check (cta_url is null or (char_length(cta_url) <= 500 and cta_url ~* '^https://[^[:space:]"''<>]+$')),
  check ((cta_label is null) = (cta_url is null)),
  status text not null default 'draft' check (status in ('draft', 'sending', 'done', 'cancelled')),
  -- Quantos endereços entraram na fila quando o envio começou.
  audience_total integer check (audience_total is null or audience_total >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  cancelled_at timestamptz
);
-- statement-breakpoint

create trigger email_campaigns_updated_at before update on email_campaigns
  for each row execute function set_updated_at();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Mensagens
-- ---------------------------------------------------------------------------------------------

create table email_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Tipo (server/email/kinds.ts). O banco só confere o formato; quem conhece os tipos é o servidor.
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,40}$'),
  -- A separação que a lei e os provedores exigem: e-mail essencial da conta/pedido x promoção.
  category text not null check (category in ('transactional', 'promotional')),
  audience text not null default 'customer' check (audience in ('customer', 'staff')),
  -- Minúsculas. Fica vazio depois da anonimização (LGPD); o domínio continua para as estatísticas por provedor de caixa de entrada.
  recipient_email text check (recipient_email is null or (recipient_email = lower(recipient_email) and char_length(recipient_email) between 3 and 254)),
  recipient_domain text check (recipient_domain is null or char_length(recipient_domain) <= 253),
  customer_id uuid references customers (id) on delete set null,
  order_id uuid references orders (id) on delete set null,
  campaign_id uuid references email_campaigns (id) on delete set null,
  -- Assunto SEM dado sensível: nos e-mails de código o servidor grava só o nome do tipo.
  subject text check (subject is null or char_length(subject) <= 200),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'accepted', 'delivered', 'delayed', 'bounced', 'complained', 'failed', 'blocked', 'cancelled')),
  transport text check (transport is null or char_length(transport) <= 30),
  -- Message-ID que mandamos no cabeçalho (é por ele que se acha a mensagem numa devolução que chega por e-mail) e o id do provedor, se houver.
  message_id text check (message_id is null or char_length(message_id) <= 200),
  provider_id text check (provider_id is null or char_length(provider_id) <= 200),
  -- Receita para refazer a mensagem numa nova tentativa. Só ids e dados sem segredo; apagada quando a mensagem termina (enviada,
  -- bloqueada, cancelada) e 14 dias depois de falhar.
  spec jsonb,
  -- No máximo uma mensagem por esta chave (ex.: "order:<id>:order_delivered"): evita e-mail em dobro.
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) <= 200),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 6 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  last_attempt_at timestamptz,
  accepted_at timestamptz,
  delivered_at timestamptz,
  bounced_at timestamptz,
  complained_at timestamptz,
  first_opened_at timestamptz,
  first_clicked_at timestamptz,
  opens integer not null default 0 check (opens >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  bounce_type text check (bounce_type is null or bounce_type in ('hard', 'soft', 'policy', 'unknown')),
  error_kind text check (error_kind is null or error_kind in ('recipient', 'policy', 'auth', 'network', 'temporary', 'content', 'config', 'render', 'other')),
  -- Código SMTP (ex.: "550 5.1.1"), sem endereço nem segredo.
  error_code text check (error_code is null or char_length(error_code) <= 40),
  error_detail text check (error_detail is null or char_length(error_detail) <= 300),
  -- Por que NÃO foi enviada (status blocked): suppressed, no_consent, order_notices_off, recipient_limit, bad_domain...
  block_reason text check (block_reason is null or char_length(block_reason) <= 60)
);
-- statement-breakpoint

create trigger email_messages_updated_at before update on email_messages
  for each row execute function set_updated_at();
-- statement-breakpoint

create unique index email_messages_dedupe_key on email_messages (dedupe_key) where dedupe_key is not null;
-- statement-breakpoint
create index email_messages_due_idx on email_messages (next_attempt_at) where status = 'queued';
-- statement-breakpoint
create index email_messages_sending_idx on email_messages (claimed_at) where status = 'sending';
-- statement-breakpoint
create index email_messages_created_idx on email_messages (created_at desc);
-- statement-breakpoint
create index email_messages_recipient_idx on email_messages (recipient_email, created_at desc) where recipient_email is not null;
-- statement-breakpoint
create index email_messages_kind_idx on email_messages (kind, created_at desc);
-- statement-breakpoint
create index email_messages_accepted_idx on email_messages (accepted_at) where accepted_at is not null;
-- statement-breakpoint
create index email_messages_customer_idx on email_messages (customer_id) where customer_id is not null;
-- statement-breakpoint
create index email_messages_order_idx on email_messages (order_id) where order_id is not null;
-- statement-breakpoint
create index email_messages_campaign_idx on email_messages (campaign_id) where campaign_id is not null;
-- statement-breakpoint

-- Os avisos do provedor (webhook) chegam com o id que ele deu à mensagem.
create index email_messages_provider_idx on email_messages (provider_id) where provider_id is not null;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Eventos (linha do tempo de cada mensagem). Um por (provedor, chave): o mesmo evento nunca vale duas vezes.
-- ---------------------------------------------------------------------------------------------

create table email_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid references email_messages (id) on delete cascade,
  -- smtp = o que o nosso servidor viu ao enviar · admin = ação manual no painel · resend etc. = aviso do provedor
  provider text not null check (char_length(provider) between 2 and 30),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 200),
  type text not null check (type in ('queued', 'attempt', 'accepted', 'deferred', 'rejected', 'delivered', 'delayed', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'suppressed', 'blocked', 'cancelled', 'note')),
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  -- Pequeno e sem dado pessoal: motivo, código SMTP, tipo de devolução, número da tentativa. Nunca endereço, código ou link.
  detail jsonb,
  unique (provider, dedupe_key)
);
-- statement-breakpoint

create index email_events_message_idx on email_events (message_id, occurred_at);
-- statement-breakpoint
create index email_events_received_idx on email_events (received_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Supressão: endereços que não recebem mais nada (ou só por um tempo, no caso de devoluções temporárias repetidas).
-- ---------------------------------------------------------------------------------------------

create table email_suppressions (
  email text primary key check (email = lower(email) and char_length(email) between 3 and 254),
  reason text not null check (reason in ('hard_bounce', 'complaint', 'repeated_soft', 'manual')),
  source text not null check (source in ('smtp', 'webhook', 'admin')),
  message_id uuid references email_messages (id) on delete set null,
  detail text check (detail is null or char_length(detail) <= 200),
  created_at timestamptz not null default now(),
  -- Só a devolução temporária repetida expira; as demais valem até alguém do painel remover.
  expires_at timestamptz
);
-- statement-breakpoint

create index email_suppressions_created_idx on email_suppressions (created_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Preferências por endereço: promoções (consentimento) e avisos de pedido.
-- ---------------------------------------------------------------------------------------------

create table email_preferences (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email) and char_length(email) between 3 and 254),
  -- Chave secreta do link de preferências/descadastro deste endereço (o link é "<id>.<chave>"). Não depende de nenhuma variável
  -- de ambiente: trocar a senha do banco não quebra o botão "cancelar inscrição" de e-mails antigos.
  link_key text not null default replace(gen_random_uuid()::text, '-', '') check (link_key ~ '^[0-9a-f]{32}$'),
  -- Promoções: só valem com consentimento do dono do e-mail (conta confirmada).
  marketing boolean not null default false,
  marketing_consent_at timestamptz,
  marketing_consent_source text check (marketing_consent_source is null or marketing_consent_source in ('cadastro', 'conta', 'link', 'painel')),
  -- Versão do texto que a pessoa viu ao consentir (prova do consentimento).
  marketing_consent_text text check (marketing_consent_text is null or char_length(marketing_consent_text) <= 20),
  -- Pediu no cadastro, mas ainda não confirmou por e-mail: só vira consentimento quando o código/link da confirmação for usado.
  marketing_pending_at timestamptz,
  marketing_unsubscribed_at timestamptz,
  marketing_unsubscribed_via text check (marketing_unsubscribed_via is null or marketing_unsubscribed_via in ('link', 'one_click', 'painel', 'conta', 'reclamacao')),
  -- "Não quero e-mails sobre pedidos feitos com este endereço" (para quem recebe e-mails de um pedido que não fez).
  notify_orders boolean not null default true,
  notify_orders_changed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create trigger email_preferences_updated_at before update on email_preferences
  for each row execute function set_updated_at();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Alertas de entregabilidade (um por código; abre e fecha) e estado dos avisos do provedor
-- ---------------------------------------------------------------------------------------------

create table email_alerts (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  last_notified_at timestamptz,
  detail jsonb
);
-- statement-breakpoint

create table email_webhook_state (
  provider text primary key check (char_length(provider) between 2 and 30),
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 200),
  ok_count bigint not null default 0,
  error_count bigint not null default 0
);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Funções de apoio
-- ---------------------------------------------------------------------------------------------

create or replace function email_norm(p text)
returns text
language sql
immutable
as $$
  select nullif(lower(btrim(coalesce(p, ''))), '');
$$;
-- statement-breakpoint

-- Quanto mais alto, mais adiantada a mensagem. Evento atrasado ou repetido nunca faz uma mensagem voltar atrás; os estados finais
-- (failed, blocked, cancelled) não mudam por evento nenhum.
create or replace function email_status_rank(p_status text)
returns integer
language sql
immutable
as $$
  select case p_status
    when 'queued' then 0
    when 'sending' then 1
    when 'accepted' then 2
    when 'delayed' then 3
    when 'delivered' then 4
    when 'bounced' then 5
    when 'complained' then 6
    else 99
  end;
$$;
-- statement-breakpoint

-- Aplica um evento a uma mensagem (aviso de um provedor ou ação manual do painel). Atômico e idempotente: o mesmo (provedor, chave)
-- nunca vale duas vezes. Devolução definitiva e reclamação colocam o endereço na lista de supressão; devolução temporária que se
-- repete (3 em 7 dias) suprime por 7 dias; reclamação também tira a pessoa das promoções.
create or replace function email_apply_event(
  p_message uuid,
  p_provider text,
  p_key text,
  p_type text,
  p_occurred timestamptz default now(),
  p_detail jsonb default null,
  p_recipient text default null
)
returns jsonb
language plpgsql
as $$
declare
  m email_messages;
  v_msg uuid := p_message;
  v_event uuid;
  v_new text;
  v_old_rank integer;
  v_bounce text := lower(coalesce(p_detail ->> 'bounce', ''));
  v_to text := email_norm(p_recipient);
  v_soft integer;
  v_source text := case when p_provider = 'admin' then 'admin' else 'webhook' end;
  v_when timestamptz := coalesce(p_occurred, now());
begin
  if p_type not in ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'suppressed') then
    return jsonb_build_object('outcome', 'ignored');
  end if;
  if v_msg is not null and not exists (select 1 from email_messages x where x.id = v_msg) then
    v_msg := null;
  end if;

  insert into email_events (message_id, provider, dedupe_key, type, occurred_at, detail)
  values (v_msg, p_provider, p_key, p_type, v_when, p_detail)
  on conflict (provider, dedupe_key) do nothing
  returning id into v_event;
  if v_event is null then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if v_msg is not null then
    select * into m from email_messages where id = v_msg for update;
  end if;

  if m.id is null then
    -- Mensagem desconhecida: ainda assim protege o endereço quando o provedor diz que ele é ruim.
    if v_to is not null and p_type = 'complained' then
      insert into email_suppressions (email, reason, source, detail) values (v_to, 'complaint', v_source, null)
      on conflict (email) do update set reason = 'complaint', source = excluded.source, expires_at = null;
    elsif v_to is not null and p_type = 'bounced' and v_bounce = 'hard' then
      insert into email_suppressions (email, reason, source, detail) values (v_to, 'hard_bounce', v_source, left(p_detail ->> 'message', 200))
      on conflict (email) do nothing;
    end if;
    return jsonb_build_object('outcome', 'unknown_message');
  end if;

  v_to := coalesce(v_to, m.recipient_email);
  v_old_rank := email_status_rank(m.status);

  if p_type in ('opened', 'clicked') then
    update email_messages
       set opens = opens + case when p_type = 'opened' then 1 else 0 end,
           clicks = clicks + case when p_type = 'clicked' then 1 else 0 end,
           first_opened_at = case when p_type = 'opened' then coalesce(first_opened_at, v_when) else first_opened_at end,
           first_clicked_at = case when p_type = 'clicked' then coalesce(first_clicked_at, v_when) else first_clicked_at end,
           -- Abrir ou clicar prova que a mensagem chegou.
           status = case when v_old_rank < 4 then 'delivered' else status end,
           delivered_at = case when v_old_rank < 4 then coalesce(delivered_at, v_when) else delivered_at end
     where id = m.id;
    return jsonb_build_object('outcome', 'applied', 'status', case when v_old_rank < 4 then 'delivered' else m.status end);
  end if;

  v_new := case p_type
    when 'accepted' then 'accepted'
    when 'delayed' then 'delayed'
    when 'delivered' then 'delivered'
    when 'bounced' then 'bounced'
    when 'complained' then 'complained'
    else null
  end;

  if v_new is not null and v_old_rank < 99 and email_status_rank(v_new) > v_old_rank then
    update email_messages
       set status = v_new,
           accepted_at = case when v_new = 'accepted' then coalesce(accepted_at, v_when) else accepted_at end,
           delivered_at = case when v_new = 'delivered' then coalesce(delivered_at, v_when) else delivered_at end,
           bounced_at = case when v_new = 'bounced' then coalesce(bounced_at, v_when) else bounced_at end,
           complained_at = case when v_new = 'complained' then coalesce(complained_at, v_when) else complained_at end,
           bounce_type = case when v_new = 'bounced' then (case when v_bounce in ('hard', 'soft', 'policy') then v_bounce else 'unknown' end) else bounce_type end,
           spec = case when v_new in ('bounced', 'complained') then null else spec end
     where id = m.id;
  elsif p_type = 'failed' and v_old_rank < 2 then
    update email_messages set status = 'failed' where id = m.id;
  end if;

  if p_type = 'bounced' and v_bounce = 'hard' and v_to is not null then
    insert into email_suppressions (email, reason, source, message_id, detail)
    values (v_to, 'hard_bounce', v_source, m.id, left(p_detail ->> 'message', 200))
    on conflict (email) do update
      set reason = 'hard_bounce', source = excluded.source, message_id = excluded.message_id, detail = excluded.detail, expires_at = null
      where email_suppressions.reason = 'repeated_soft';
  elsif p_type = 'bounced' and v_bounce = 'soft' and v_to is not null then
    select count(*) into v_soft
      from email_events e
      join email_messages x on x.id = e.message_id
     where e.type = 'bounced' and e.occurred_at > now() - interval '7 days'
       and x.recipient_email = v_to and lower(coalesce(e.detail ->> 'bounce', '')) = 'soft';
    if v_soft >= 3 then
      insert into email_suppressions (email, reason, source, message_id, detail, expires_at)
      values (v_to, 'repeated_soft', v_source, m.id, '3 devoluções temporárias em 7 dias', now() + interval '7 days')
      on conflict (email) do nothing;
    end if;
  elsif p_type = 'complained' and v_to is not null then
    insert into email_suppressions (email, reason, source, message_id, detail)
    values (v_to, 'complaint', v_source, m.id, null)
    on conflict (email) do update set reason = 'complaint', source = excluded.source, message_id = excluded.message_id, expires_at = null;
    update email_preferences
       set marketing = false, marketing_unsubscribed_at = coalesce(marketing_unsubscribed_at, now()), marketing_unsubscribed_via = 'reclamacao'
     where email = v_to and marketing;
  end if;

  return jsonb_build_object('outcome', 'applied', 'status', (select x.status from email_messages x where x.id = m.id));
end;
$$;
-- statement-breakpoint

-- Pega as mensagens que já podem ser enviadas (na fila e com a hora chegada) e as que ficaram "enviando" por tempo demais (a função
-- que as pegou morreu no meio). Cada uma é entregue a UM só trabalhador (skip locked) e conta uma tentativa.
create or replace function email_claim_due(p_limit integer default 5, p_lease_seconds integer default 300)
returns setof email_messages
language plpgsql
as $$
begin
  return query
  with due as (
    select m.id
      from email_messages m
     where (m.status = 'queued' and (m.next_attempt_at is null or m.next_attempt_at <= now()))
        or (m.status = 'sending' and m.claimed_at < now() - make_interval(secs => p_lease_seconds))
     order by coalesce(m.next_attempt_at, m.created_at)
     limit greatest(1, least(coalesce(p_limit, 5), 50))
       for update skip locked
  )
  update email_messages m
     set status = 'sending', claimed_at = now(), attempts = m.attempts + 1, last_attempt_at = now()
    from due
   where m.id = due.id
  returning m.*;
end;
$$;
-- statement-breakpoint

-- LGPD: tira o endereço de todos os registros de e-mail (mensagens, preferências, supressão). Devolve quantas mensagens foram limpas.
create or replace function email_forget(p_email text)
returns integer
language plpgsql
as $$
declare
  v text := email_norm(p_email);
  n integer := 0;
begin
  if v is null then
    return 0;
  end if;
  -- A chave de unicidade das campanhas leva o endereço ("campaign:<id>:<e-mail>"): sai junto.
  update email_messages set recipient_email = null, spec = null, dedupe_key = null where recipient_email = v;
  get diagnostics n = row_count;
  delete from email_preferences where email = v;
  delete from email_suppressions where email = v;
  return n;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Gatilhos: o pedido avisa o cliente sozinho, sem depender de cada rota lembrar de enviar.
-- ---------------------------------------------------------------------------------------------

-- Para quem vai o e-mail do pedido: o e-mail digitado no pedido; sem ele, o da conta ligada ao pedido.
create or replace function email_order_recipient(p_order orders)
returns text
language sql
stable
as $$
  select email_norm(coalesce(nullif(btrim(p_order.customer_email), ''), (select c.email from customers c where c.id = p_order.customer_id)));
$$;
-- statement-breakpoint

create or replace function email_enqueue_order_status()
returns trigger
language plpgsql
as $$
declare
  o orders;
  v_to text;
  v_kind text;
begin
  begin
    select * into o from orders where id = new.order_id;
    if not found then
      return new;
    end if;
    v_kind := case
      -- Pedido pago pelo site: quem avisa é o e-mail de pagamento confirmado (um e-mail só, não dois).
      when new.to_status = 'new' and not is_online_payment(o.payment_method) then 'order_received'
      when new.to_status = 'confirmed' then 'order_confirmed'
      when new.to_status = 'out_for_delivery' then 'order_out_for_delivery'
      when new.to_status = 'delivered' then 'order_delivered'
      when new.to_status = 'cancelled' then 'order_cancelled'
      else null
    end;
    if v_kind is null then
      return new;
    end if;
    v_to := email_order_recipient(o);
    if v_to is null then
      return new;
    end if;
    insert into email_messages (kind, category, audience, recipient_email, recipient_domain, customer_id, order_id, status, spec, dedupe_key, next_attempt_at)
    values (v_kind, 'transactional', 'customer', v_to, split_part(v_to, '@', 2), o.customer_id, o.id, 'queued',
            jsonb_build_object('order_id', o.id), 'order:' || o.id::text || ':' || v_kind, now())
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  exception when others then
    raise warning 'email_enqueue_order_status: %', sqlerrm;
  end;
  return new;
end;
$$;
-- statement-breakpoint

create trigger order_status_history_email after insert on order_status_history
  for each row execute function email_enqueue_order_status();
-- statement-breakpoint

create or replace function email_enqueue_order_payment()
returns trigger
language plpgsql
as $$
declare
  v_to text;
  v_kind text;
begin
  begin
    if not is_online_payment(new.payment_method) then
      return new;
    end if;
    v_kind := case new.payment_status when 'paid' then 'payment_confirmed' when 'refunded' then 'payment_refunded' else null end;
    -- Pagamento que chegou depois de o pedido ser cancelado não vira "pagamento confirmado" (a loja resolve a devolução).
    if v_kind is null or (v_kind = 'payment_confirmed' and new.order_status = 'cancelled') then
      return new;
    end if;
    v_to := email_order_recipient(new);
    if v_to is null then
      return new;
    end if;
    insert into email_messages (kind, category, audience, recipient_email, recipient_domain, customer_id, order_id, status, spec, dedupe_key, next_attempt_at)
    values (v_kind, 'transactional', 'customer', v_to, split_part(v_to, '@', 2), new.customer_id, new.id, 'queued',
            jsonb_build_object('order_id', new.id), 'order:' || new.id::text || ':' || v_kind, now())
    on conflict (dedupe_key) where dedupe_key is not null do nothing;
  exception when others then
    raise warning 'email_enqueue_order_payment: %', sqlerrm;
  end;
  return new;
end;
$$;
-- statement-breakpoint

create trigger orders_payment_email after update of payment_status on orders
  for each row when (old.payment_status is distinct from new.payment_status)
  execute function email_enqueue_order_payment();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- LGPD: anonymize_person passa a limpar também os registros de e-mail (o resto é igual à migration 12).
-- ---------------------------------------------------------------------------------------------

create or replace function anonymize_person(p_phone text, p_email text)
returns jsonb
language plpgsql
as $$
declare
  v_phone text := nullif(phone_key(p_phone), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_ids uuid[];
  v_customers integer := 0;
  v_emails text[] := '{}';
  v_gone text[] := '{}';
begin
  if v_phone is not null and length(v_phone) < 10 then
    v_phone := null;
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Informe o telefone (com DDD) ou o e-mail da pessoa.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(o.id), '{}') into v_ids
  from orders o
  where (v_phone is not null and phone_key(o.customer_phone) = v_phone)
     or (v_email is not null and lower(o.customer_email) = v_email);

  -- Os e-mails que apareceram nos pedidos (antes de serem apagados deles) também saem dos registros de e-mail.
  select coalesce(array_agg(distinct lower(o.customer_email)) filter (where o.customer_email is not null), '{}') into v_emails
  from orders o
  where o.id = any (v_ids);
  if v_email is not null then
    v_emails := array_append(v_emails, v_email);
  end if;

  update orders o set
    customer_name = 'Cliente removido',
    customer_phone = '0000000000',
    customer_email = null,
    address = case when o.delivery_type = 'delivery' then 'Removido' else null end,
    address_number = case when o.delivery_type = 'delivery' then '0' else null end,
    complement = null,
    reference = null,
    notes = null,
    customer_id = null,
    customer_linked_at = null
  where o.id = any (v_ids);

  delete from order_tracking_tokens where order_id = any (v_ids);

  with gone as (
    delete from customers c
     where (v_phone is not null and phone_key(c.phone) = v_phone)
        or (v_email is not null and lower(c.email) = v_email)
    returning lower(c.email) as email
  )
  select count(*), coalesce(array_agg(email), '{}') into v_customers, v_gone from gone;

  v_emails := v_emails || v_gone;
  perform email_forget(e) from unnest(v_emails) as t (e);

  return jsonb_build_object('orders', coalesce(array_length(v_ids, 1), 0), 'customers', v_customers);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Limpeza automática: o que já existia (migration 12) + registros de e-mail por 180 dias.
-- ---------------------------------------------------------------------------------------------

create or replace function purge_expired_data()
returns void
language plpgsql
as $$
begin
  delete from customer_sessions where expires_at < now();
  delete from admin_sessions where expires_at < now();
  delete from customer_password_resets where expires_at < now() - interval '1 day' or used_at < now() - interval '7 days';
  delete from customer_password_resets where via = 'email' and sent_at is null and created_at < now() - interval '1 hour';
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
  delete from admin_login_challenges where expires_at < now();
  delete from admin_devices where last_seen_at < now() - interval '400 days';
  delete from admin_recovery_codes where used_at < now() - interval '90 days';
  delete from audit_log where created_at < now() - interval '2 years';
  delete from privacy_requests where status <> 'open' and handled_at < now() - interval '2 years';
  -- E-mails: mensagem que ficou uma semana na fila já não faz sentido; os registros ficam 180 dias; a receita de quem falhou, 14.
  update email_messages
     set status = 'failed', error_kind = coalesce(error_kind, 'other'), error_detail = coalesce(error_detail, 'expirou na fila'), spec = null, next_attempt_at = null
   where status in ('queued', 'sending') and created_at < now() - interval '7 days';
  update email_messages set spec = null where status = 'failed' and spec is not null and created_at < now() - interval '14 days';
  delete from email_events where received_at < now() - interval '180 days';
  delete from email_messages where created_at < now() - interval '180 days' and status not in ('queued', 'sending');
  delete from email_suppressions where expires_at is not null and expires_at < now();
  delete from email_alerts where resolved_at is not null and resolved_at < now() - interval '90 days';
  delete from email_preferences
   where marketing = false and marketing_consent_at is null and marketing_pending_at is null and notify_orders = true and created_at < now() - interval '1 year';
end;
$$;
-- statement-breakpoint
