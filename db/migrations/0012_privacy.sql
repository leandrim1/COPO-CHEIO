-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 12/12 · Privacidade (LGPD): pedidos dos titulares e anonimização de quem não tem conta.
--
-- • Quem comprou como visitante não tem conta para apagar. Agora existe um canal público para pedir acesso, correção ou
--   exclusão dos dados (privacy_requests), que a loja trata pelo painel.
-- • anonymize_person tira de todos os pedidos de uma pessoa (pelo telefone e/ou e-mail) o que a identifica, apaga a conta e
--   os códigos de acompanhamento dela e mantém só o que a loja precisa para a contabilidade (itens, valores, datas e bairro).
-- • purge_expired_data (limpeza automática) passa a cuidar também das tabelas novas.

create table privacy_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- access = ver os dados · correction = corrigir · deletion = excluir/anonimizar · other = outro assunto
  kind text not null check (kind in ('access', 'correction', 'deletion', 'other')),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  -- Telefone ou e-mail para a loja responder.
  contact text not null check (char_length(btrim(contact)) between 5 and 254),
  message text check (message is null or char_length(message) <= 1000),
  status text not null default 'open' check (status in ('open', 'done', 'rejected')),
  handled_by uuid,
  handled_by_name text check (handled_by_name is null or char_length(handled_by_name) <= 120),
  handled_at timestamptz,
  handled_note text check (handled_note is null or char_length(handled_note) <= 500)
);
-- statement-breakpoint

create index privacy_requests_status_idx on privacy_requests (status, created_at desc);
-- statement-breakpoint

-- Anonimiza os pedidos e apaga a conta de uma pessoa, pelo telefone (com DDD) e/ou e-mail. Tudo ou nada.
-- Devolve { orders, customers }. Pedidos continuam existindo (histórico e obrigações fiscais), sem dados pessoais.
create or replace function anonymize_person(p_phone text, p_email text)
returns jsonb
language plpgsql
as $$
declare
  v_phone text := nullif(phone_key(p_phone), '');
  v_email text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_ids uuid[];
  v_customers integer := 0;
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
    returning c.id
  )
  select count(*) into v_customers from gone;

  return jsonb_build_object('orders', coalesce(array_length(v_ids, 1), 0), 'customers', v_customers);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Limpeza de dados técnicos vencidos. Acrescenta: desafios de login em duas etapas, aparelhos sem uso há mais de 400 dias,
-- códigos de recuperação já usados, registro de atividades com mais de 2 anos e pedidos de titulares já resolvidos há 2 anos.
-- O resto é igual à migration 6.
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
end;
$$;
