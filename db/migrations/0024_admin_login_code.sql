-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 24/24 · Login do PAINEL com código por e-mail, a CADA entrada (segunda etapa obrigatória).
--
-- Fluxo: (1) e-mail + senha (o servidor confere a senha, a conta ativa e o papel de administrador); (2) com a senha certa o servidor manda um código de
-- 6 dígitos para o e-mail da PRÓPRIA conta administrativa e abre um "desafio" (esta tabela), amarrado ao navegador que digitou a senha por um cookie
-- secreto HttpOnly (aqui só o hash); (3) só com o código certo, vindo desse navegador, a sessão administrativa é criada. Quem tem uma conta com
-- verificação em duas etapas por aplicativo (TOTP) continua com ela como terceira etapa: o código do e-mail não a substitui.
--
-- • O código nunca é gravado: só um HMAC dele (chave que só o servidor conhece, fora do banco). Vale 5 MINUTOS, uso único, no máximo 5 erros por
--   código (depois o desafio inteiro deixa de valer e é preciso informar a senha de novo), reenvio só depois de 60 s, no máximo 4 envios por desafio
--   e 8 por hora por conta. O desafio todo vale 15 minutos.
-- • O teto de 8 por hora conta só as tentativas que NÃO terminaram em entrada (código nunca usado): quem entra de verdade, quantas vezes for, não é
--   limitado por ele; quem só pede códigos (por exemplo, sabendo a senha mas sem acesso ao e-mail) para em 8.
-- • Trocar a senha da conta, desativá-la ou excluí-la derruba o desafio aberto (o desafio guarda uma impressão digital do hash da senha).
-- • Quem erra a senha nunca chega aqui: nenhum e-mail sai, então ninguém enche a caixa de um administrador sem saber a senha dele.
-- • Linhas com mais de 1 dia são apagadas por esta própria tabela, de passagem; excluir o administrador apaga as dele.
--
-- Só acrescenta: uma tabela e cinco funções novas (sem tocar em admin_login_challenges, que continua sendo o desafio do aplicativo autenticador).
-- Nenhuma função existente é alterada, nenhum dado é escrito ou apagado. Voltar o código para a versão anterior continua funcionando contra este
-- banco (o login antigo só pede a senha e, se a conta tiver, o código do aplicativo).

create table admin_email_challenges (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admins (id) on delete cascade,
  -- SHA-256 do cookie secreto do navegador que digitou a senha; o cookie em si só existe nesse navegador.
  nonce_hash text not null unique check (nonce_hash ~ '^[0-9a-f]{64}$'),
  -- HMAC do código de 6 dígitos (o código em si nunca é gravado).
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  code_expires_at timestamptz not null,
  -- Erros com o código atual; ao chegar no máximo o desafio deixa de valer.
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  -- Quantos e-mails de código este desafio já usou (o primeiro conta) e quando o último foi aceito pelo servidor de e-mail.
  sends integer not null default 1 check (sends >= 1),
  last_sent_at timestamptz,
  -- Vida máxima do desafio (o reenvio renova o código, não este prazo).
  expires_at timestamptz not null,
  -- Impressão digital do hash da senha no momento do desafio: se a senha mudar, o desafio não vale mais.
  pw_fingerprint text not null,
  used_at timestamptz,
  invalidated_at timestamptz,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index admin_email_challenges_admin_idx on admin_email_challenges (admin_id, created_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Abrir um desafio (senha já conferida pelo servidor). Devolve:
--   { ok: true, id, email, name }                       desafio novo: o servidor gera o e-mail e chama finish_admin_email_challenge
--   { ok: true, reused: true, retry_after, expires_in } o MESMO navegador acabou de pedir (menos de 60 s): vale o código já enviado
--   { ok: false, reason: 'hourly' | 'not_active' }
-- ---------------------------------------------------------------------------------------------
create or replace function begin_admin_email_challenge(
  p_admin uuid,
  p_nonce_hash text,
  p_code_hash text,
  p_current_nonce_hash text,
  p_code_minutes integer default 5
)
returns jsonb
language plpgsql
as $$
declare
  c admins;
  v admin_email_challenges;
  v_hour integer;
  v_id uuid;
begin
  -- Serializa os pedidos de código da mesma conta.
  select * into c from admins where id = p_admin for update;
  if not found or not c.active then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;

  delete from admin_email_challenges where created_at < now() - interval '1 day';

  -- Duplo clique ou "Entrar" de novo logo depois: o código que acabou de ser enviado continua valendo, sem outro e-mail.
  if p_current_nonce_hash is not null then
    select * into v
    from admin_email_challenges
    where admin_id = c.id and nonce_hash = p_current_nonce_hash
      and used_at is null and invalidated_at is null and expires_at > now() and code_expires_at > now()
      and last_sent_at is not null and last_sent_at > now() - interval '60 seconds';
    if found then
      return jsonb_build_object('ok', true, 'reused', true, 'expires_in', greatest(1, ceil(extract(epoch from (v.code_expires_at - now())))::integer),
                              'retry_after', greatest(1, ceil(extract(epoch from (v.last_sent_at + interval '60 seconds' - now())))::integer));
    end if;
  end if;

  select coalesce(sum(sends), 0) into v_hour
  from admin_email_challenges
  where admin_id = c.id and created_at > now() - interval '1 hour' and used_at is null;
  if v_hour >= 8 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;

  insert into admin_email_challenges (admin_id, nonce_hash, code_hash, code_expires_at, expires_at, pw_fingerprint)
  values (
    c.id, p_nonce_hash, p_code_hash,
    now() + make_interval(mins => p_code_minutes),
    now() + interval '15 minutes',
    encode(sha256(convert_to(c.password_hash, 'UTF8')), 'hex')
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

-- Resultado do envio: aceito → o desafio passa a valer; falhou → ele é descartado (nada fica pela metade).
create or replace function finish_admin_email_challenge(p_id uuid, p_sent boolean)
returns void
language plpgsql
as $$
begin
  if p_sent then
    update admin_email_challenges set last_sent_at = now() where id = p_id and last_sent_at is null;
  else
    delete from admin_email_challenges where id = p_id and last_sent_at is null;
  end if;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedir outro código no mesmo desafio ("Reenviar código"). Duas etapas, como a confirmação de e-mail: o código novo só substitui o
-- anterior depois que o e-mail novo foi aceito (finish_admin_email_resend); se o envio falhar, o código que a pessoa já tinha continua valendo.
-- Devolve { ok: true, id, admin_id, email, name } ou { ok: false, reason: 'expired' | 'cooldown' | 'limit' | 'hourly', retry_after? }.
-- ---------------------------------------------------------------------------------------------
create or replace function begin_admin_email_resend(p_nonce_hash text)
returns jsonb
language plpgsql
as $$
declare
  v admin_email_challenges;
  c admins;
  v_hour integer;
begin
  select * into v from admin_email_challenges where nonce_hash = p_nonce_hash for update;
  if not found or v.used_at is not null or v.invalidated_at is not null or v.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select * into c from admins where id = v.admin_id;
  if not found or not c.active
     or v.pw_fingerprint <> encode(sha256(convert_to(c.password_hash, 'UTF8')), 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  -- O primeiro e-mail ainda não foi aceito (pedido em andamento): espera um instante em vez de mandar outro por cima. Se passou mais de 20 s
  -- e ele nunca foi confirmado como enviado (a função caiu no meio), o reenvio é liberado.
  if v.last_sent_at is null and v.created_at > now() - interval '20 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_after', 5);
  end if;
  if v.last_sent_at is not null and v.last_sent_at > now() - interval '60 seconds' then
    return jsonb_build_object('ok', false, 'reason', 'cooldown', 'retry_after', greatest(1, ceil(extract(epoch from (v.last_sent_at + interval '60 seconds' - now())))::integer));
  end if;
  if v.sends >= 4 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  select coalesce(sum(sends), 0) into v_hour
  from admin_email_challenges
  where admin_id = c.id and created_at > now() - interval '1 hour' and used_at is null;
  if v_hour >= 8 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'admin_id', c.id, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

create or replace function finish_admin_email_resend(p_id uuid, p_code_hash text, p_code_minutes integer, p_sent boolean)
returns void
language plpgsql
as $$
begin
  if p_sent then
    update admin_email_challenges
       set code_hash = p_code_hash,
           code_expires_at = now() + make_interval(mins => p_code_minutes),
           attempts = 0,
           sends = sends + 1,
           last_sent_at = now()
     where id = p_id and used_at is null and invalidated_at is null;
  end if;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Conferir o código. Devolve { result: 'ok', admin_id } | { result: 'invalid' } | { result: 'locked' }.
-- "invalid" cobre código errado, vencido, já usado, substituído, desafio de outro navegador, senha trocada ou conta que não existe mais:
-- quem tenta não descobre qual foi o motivo. Todos os erros contam; com 5 o desafio inteiro é invalidado ("locked").
-- ---------------------------------------------------------------------------------------------
create or replace function verify_admin_email_code(p_nonce_hash text, p_code_hash text)
returns jsonb
language plpgsql
as $$
declare
  v admin_email_challenges;
  c admins;
begin
  select * into v from admin_email_challenges where nonce_hash = p_nonce_hash for update;
  if not found or v.last_sent_at is null or v.used_at is not null or v.invalidated_at is not null
     or v.expires_at <= now() or v.code_expires_at <= now() then
    return jsonb_build_object('result', 'invalid');
  end if;

  select * into c from admins where id = v.admin_id for update;
  if not found or not c.active
     or v.pw_fingerprint <> encode(sha256(convert_to(c.password_hash, 'UTF8')), 'hex') then
    update admin_email_challenges set invalidated_at = now() where id = v.id;
    return jsonb_build_object('result', 'invalid');
  end if;

  if v.attempts >= v.max_attempts then
    update admin_email_challenges set invalidated_at = now() where id = v.id;
    return jsonb_build_object('result', 'locked');
  end if;

  if v.code_hash = p_code_hash then
    update admin_email_challenges set used_at = now() where id = v.id;
    return jsonb_build_object('result', 'ok', 'admin_id', c.id);
  end if;

  update admin_email_challenges
     set attempts = attempts + 1,
         invalidated_at = case when attempts + 1 >= max_attempts then now() else null end
   where id = v.id;
  return jsonb_build_object('result', case when v.attempts + 1 >= v.max_attempts then 'locked' else 'invalid' end);
end;
$$;
