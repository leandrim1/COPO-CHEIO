-- Recuperação de senha por e-mail.
--
-- O link de redefinição (tabela customer_password_resets, que já existia para os links gerados pela loja) passa a poder
-- ser enviado pelo sistema para a caixa de e-mail da conta. O banco guarda só o hash do link; o pedido de um link novo,
-- os limites de envio e o uso do link são decididos aqui dentro, de forma atômica.

-- Como o link chegou à pessoa: 'admin' = a loja gerou no painel e mandou por outro canal (WhatsApp); 'email' = o sistema
-- mandou para o e-mail da conta. Só o link de e-mail prova que a pessoa lê aquela caixa.
alter table customer_password_resets
  add column via text not null default 'admin' check (via in ('admin', 'email')),
  add column email text,
  add column sent_at timestamptz;
-- statement-breakpoint

create index customer_password_resets_email_idx on customer_password_resets (customer_id, sent_at desc) where via = 'email';
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedir um link por e-mail. Espera de 60 s entre pedidos, no máximo 5 por hora e 10 por dia, por conta.
-- Devolve { ok: false, reason } quando não deve enviar (conta que não pode receber, espera, limite): a rota responde
-- igual nos dois casos, então quem pergunta não descobre se o e-mail tem conta.
-- ---------------------------------------------------------------------------------------------

create or replace function begin_password_reset(p_customer uuid, p_token_hash text, p_minutes integer default 60)
returns jsonb
language plpgsql
as $$
declare
  c customers;
  v_last timestamptz;
  v_hour integer;
  v_day integer;
begin
  -- Serializa os pedidos da mesma conta.
  select * into c from customers where id = p_customer for update;
  if not found or not c.active then
    return jsonb_build_object('ok', false, 'reason', 'not_eligible');
  end if;

  select max(coalesce(sent_at, created_at)) into v_last
  from customer_password_resets
  where customer_id = c.id and via = 'email' and (sent_at is not null or created_at > now() - interval '20 seconds');
  if v_last is not null and v_last > now() - interval '60 seconds' then
    return jsonb_build_object(
      'ok', false, 'reason', 'cooldown',
      'retry_after', greatest(1, ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::integer)
    );
  end if;

  select count(*) filter (where sent_at > now() - interval '1 hour'),
         count(*) filter (where sent_at > now() - interval '24 hours')
    into v_hour, v_day
  from customer_password_resets
  where customer_id = c.id and via = 'email';
  if v_hour >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;
  if v_day >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'daily');
  end if;

  insert into customer_password_resets (token_hash, customer_id, expires_at, via, email)
  values (p_token_hash, c.id, now() + make_interval(mins => p_minutes), 'email', c.email);

  return jsonb_build_object('ok', true, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

-- Resultado do envio: enviado → vale o link novo e os anteriores (ainda não usados) deixam de valer; falhou → o link novo
-- é descartado e o que a pessoa já tinha continua valendo. Os links antigos ficam na tabela, vencidos: eles continuam
-- contando nos limites de envio.
create or replace function finish_password_reset(p_token_hash text, p_sent boolean)
returns void
language plpgsql
as $$
declare
  v_customer uuid;
begin
  select customer_id into v_customer from customer_password_resets where token_hash = p_token_hash;
  if not found then
    return;
  end if;
  if p_sent then
    update customer_password_resets set sent_at = now() where token_hash = p_token_hash and sent_at is null;
    update customer_password_resets
       set expires_at = least(expires_at, now())
     where customer_id = v_customer and token_hash <> p_token_hash and used_at is null and expires_at > now();
  else
    delete from customer_password_resets where token_hash = p_token_hash and sent_at is null;
  end if;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Usar o link: troca a senha, encerra todas as sessões da conta e invalida os outros links, tudo ou nada.
-- Link enviado para o e-mail da conta e usado = a pessoa lê aquela caixa, e isso confirma o e-mail (como o link de
-- confirmação faria). Link gerado pela loja (WhatsApp) NÃO confirma nada. Devolve null se o link não vale.
-- ---------------------------------------------------------------------------------------------

create or replace function reset_customer_password(p_token_hash text, p_password_hash text)
returns jsonb
language plpgsql
as $$
declare
  r customer_password_resets;
  c customers;
  v_verified boolean := false;
begin
  select * into r
  from customer_password_resets
  where token_hash = p_token_hash and used_at is null and expires_at > now()
  for update;
  if not found then
    return null;
  end if;
  select * into c from customers where id = r.customer_id for update;
  if not found then
    return null;
  end if;

  update customer_password_resets set used_at = now() where token_hash = p_token_hash;
  update customer_password_resets
     set expires_at = least(expires_at, now())
   where customer_id = c.id and token_hash <> p_token_hash and used_at is null and expires_at > now();
  update customers set password_hash = p_password_hash where id = c.id;
  delete from customer_sessions where customer_id = c.id;

  if r.via = 'email' and r.sent_at is not null and r.email = c.email and c.active and c.email_verified_at is null then
    update customers set email_verified_at = now() where id = c.id;
    update email_verifications
       set invalidated_at = now()
     where customer_id = c.id and used_at is null and invalidated_at is null;
    v_verified := true;
  end if;

  return jsonb_build_object('email', c.email, 'name', c.name, 'verified', v_verified, 'via', r.via, 'active', c.active, 'confirmed', c.email_verified_at is not null or v_verified);
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Limpeza: acrescenta os links de e-mail que nunca chegaram a ser enviados (o resto é igual à migration anterior).
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
end;
$$;
