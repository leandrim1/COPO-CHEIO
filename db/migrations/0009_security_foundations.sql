-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 9/12 · Segurança: contador de tentativas atômico, registro de atividades do painel, verificação em duas etapas,
--        aparelhos conhecidos e cadastro de cliente preso ao navegador de quem se cadastrou.
--
-- Esta migration só ACRESCENTA (tabelas, colunas e funções novas). Nada que já existe muda de significado, então a
-- versão anterior do site, que continua no ar durante o deploy, segue funcionando com este banco.

-- ---------------------------------------------------------------------------------------------
-- Limite de tentativas ATÔMICO. Antes o servidor contava as tentativas e só depois registrava a nova, então 40 tentativas
-- simultâneas liam "0" ao mesmo tempo e passavam todas. Agora a conferência e o registro acontecem juntos, dentro do
-- banco, numa fila por chave (trava de aconselhamento): a 9ª tentativa simultânea já é barrada.
-- Devolve { allowed, count, retry_after } (retry_after em segundos).
-- ---------------------------------------------------------------------------------------------

create or replace function rate_limit_hit(p_bucket text, p_key text, p_window_seconds integer, p_max integer)
returns jsonb
language plpgsql
as $$
declare
  v_count integer;
  v_oldest timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('rate:' || p_bucket || E'\n' || p_key, 0));
  select count(*), min(created_at) into v_count, v_oldest
    from rate_limits
   where bucket = p_bucket and key = p_key and created_at > now() - make_interval(secs => p_window_seconds);
  if v_count >= p_max then
    return jsonb_build_object(
      'allowed', false,
      'count', v_count,
      'retry_after', greatest(1, ceil(extract(epoch from (v_oldest + make_interval(secs => p_window_seconds) - now())))::integer)
    );
  end if;
  insert into rate_limits (bucket, key) values (p_bucket, p_key);
  return jsonb_build_object('allowed', true, 'count', v_count + 1, 'retry_after', 0);
end;
$$;
-- statement-breakpoint

-- Devolve a vaga da tentativa mais recente (uma tentativa que deu certo não deve contar como erro).
create or replace function rate_limit_refund(p_bucket text, p_key text)
returns void
language sql
as $$
  delete from rate_limits
   where id = (select r.id from rate_limits r where r.bucket = p_bucket and r.key = p_key order by r.id desc limit 1);
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Registro de atividades do painel: quem fez o quê e quando. Só se acrescenta: não dá para alterar uma linha e só se
-- apaga o que tem mais de 2 anos (pela rotina de limpeza). Sem chave estrangeira de propósito: remover um
-- administrador não pode apagar o rastro das ações dele (o nome e o e-mail ficam gravados na linha).
-- ---------------------------------------------------------------------------------------------

create table audit_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_id uuid,
  actor_name text check (actor_name is null or char_length(actor_name) <= 120),
  actor_email text check (actor_email is null or char_length(actor_email) <= 254),
  -- Ex.: product.update, store.update, customer.reset_link, auth.login_new_device
  action text not null check (char_length(action) between 3 and 60),
  entity text check (entity is null or char_length(entity) <= 40),
  entity_id text check (entity_id is null or char_length(entity_id) <= 80),
  -- Frase pronta, em português ("Alterou o preço de Heineken de R$ 8,00 para R$ 9,00").
  summary text not null check (char_length(summary) between 1 and 400),
  details jsonb,
  ip text check (ip is null or char_length(ip) <= 64)
);
-- statement-breakpoint

create index audit_log_created_idx on audit_log (created_at desc, id desc);
-- statement-breakpoint
create index audit_log_actor_idx on audit_log (actor_id, created_at desc);
-- statement-breakpoint
create index audit_log_entity_idx on audit_log (entity, entity_id, created_at desc);
-- statement-breakpoint

create or replace function audit_log_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'O registro de atividades não pode ser alterado.' using errcode = 'P0001';
  end if;
  if old.created_at > now() - interval '2 years' then
    raise exception 'O registro de atividades só pode ser apagado depois de 2 anos.' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
-- statement-breakpoint

create trigger audit_log_guard before update or delete on audit_log
  for each row execute function audit_log_guard();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Verificação em duas etapas (TOTP) do painel, opcional por administrador.
-- • totp_secret guarda a chave do aplicativo autenticador; só vale quando totp_enabled_at está preenchido.
-- • totp_last_step impede reaproveitar o mesmo código de 30 s (aceito uma única vez, de forma atômica).
-- • Códigos de recuperação: só o hash fica no banco, uso único.
-- ---------------------------------------------------------------------------------------------

alter table admins
  add column totp_secret text check (totp_secret is null or char_length(totp_secret) between 16 and 64),
  add column totp_enabled_at timestamptz,
  add column totp_last_step bigint;
-- statement-breakpoint

create table admin_recovery_codes (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admins (id) on delete cascade,
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  used_at timestamptz,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index admin_recovery_codes_key on admin_recovery_codes (admin_id, code_hash);
-- statement-breakpoint

-- Entre a senha certa e o código de 6 dígitos existe um "desafio" curto: uso único e no máximo 5 erros.
create table admin_login_challenges (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  admin_id uuid not null references admins (id) on delete cascade,
  attempts integer not null default 0 check (attempts >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index admin_login_challenges_expires_idx on admin_login_challenges (expires_at);
-- statement-breakpoint

-- Aparelhos conhecidos de cada administrador (cookie próprio, só o hash fica aqui): um acesso de aparelho novo gera aviso
-- por e-mail, e quem usa um aparelho conhecido não é barrado quando alguém erra a senha dele de outro lugar.
create table admin_devices (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admins (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text check (label is null or char_length(label) <= 120),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
-- statement-breakpoint

create index admin_devices_admin_idx on admin_devices (admin_id, last_seen_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Cadastro de cliente preso ao navegador de quem se cadastrou.
-- Quem se cadastra recebe um cookie secreto (guardamos o hash). Ao confirmar o e-mail (código ou link), se o cookie bater, a
-- conta fica com a senha escolhida no cadastro. Se NÃO bater (a confirmação veio de outro aparelho, ou alguém cadastrou o
-- e-mail de outra pessoa), a senha do cadastro é descartada e a pessoa define uma nova: quem não lê aquela caixa de e-mail
-- nunca fica com uma conta confirmada.
-- ---------------------------------------------------------------------------------------------

alter table customers add column reg_nonce_hash text check (reg_nonce_hash is null or reg_nonce_hash ~ '^[0-9a-f]{64}$');
-- statement-breakpoint

-- Confirma com o código e, na mesma transação, descarta a senha do cadastro se a confirmação veio de outro navegador.
-- Devolve { result: 'ok' | 'invalid' | 'locked', bound, customer_id, email }.
create or replace function verify_email_code_bound(p_email text, p_hash text, p_nonce_hash text)
returns jsonb
language plpgsql
as $$
declare
  v_result text;
  c customers;
  v_bound boolean;
begin
  v_result := verify_email_code(p_email, p_hash);
  if v_result <> 'ok' then
    return jsonb_build_object('result', v_result);
  end if;
  select * into c from customers where lower(email) = lower(p_email) for update;
  v_bound := c.reg_nonce_hash is not null and p_nonce_hash is not null and c.reg_nonce_hash = p_nonce_hash;
  if not v_bound then
    update customers set password_hash = 'locked$' || gen_random_uuid()::text where id = c.id;
  end if;
  update customers set reg_nonce_hash = null where id = c.id;
  return jsonb_build_object('result', 'ok', 'bound', v_bound, 'customer_id', c.id, 'email', c.email);
end;
$$;
-- statement-breakpoint

-- Mesma coisa para o link do e-mail. Devolve null quando o link não vale.
create or replace function verify_email_link_bound(p_hash text, p_nonce_hash text)
returns jsonb
language plpgsql
as $$
declare
  v_email text;
  c customers;
  v_bound boolean;
begin
  v_email := verify_email_link(p_hash);
  if v_email is null then
    return null;
  end if;
  select * into c from customers where lower(email) = lower(v_email) for update;
  v_bound := c.reg_nonce_hash is not null and p_nonce_hash is not null and c.reg_nonce_hash = p_nonce_hash;
  if not v_bound then
    update customers set password_hash = 'locked$' || gen_random_uuid()::text where id = c.id;
  end if;
  update customers set reg_nonce_hash = null where id = c.id;
  return jsonb_build_object('bound', v_bound, 'customer_id', c.id, 'email', c.email);
end;
$$;
-- statement-breakpoint

-- Link de uso único para a pessoa que confirmou o e-mail de outro aparelho definir a senha (vale 30 minutos). Como o link de
-- "esqueci minha senha", é guardado só o hash e vale como prova de posse da caixa de e-mail.
create or replace function issue_set_password_link(p_customer uuid, p_token_hash text, p_minutes integer default 30)
returns void
language plpgsql
as $$
declare
  c customers;
begin
  select * into c from customers where id = p_customer for update;
  if not found or not c.active then
    return;
  end if;
  update customer_password_resets
     set expires_at = least(expires_at, now())
   where customer_id = c.id and used_at is null and expires_at > now();
  insert into customer_password_resets (token_hash, customer_id, expires_at, via, email, sent_at)
  values (p_token_hash, c.id, now() + make_interval(mins => p_minutes), 'email', c.email, now());
end;
$$;
