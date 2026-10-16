-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 23/23 · Login do cliente com código enviado por e-mail, a CADA entrada na conta.
--
-- Pedido do dono: "toda vez que o cliente for entrar na conta precisar do código que for enviado pelo e-mail".
--
-- Como fica o login: (1) a pessoa informa e-mail e senha; (2) se a senha está certa, o servidor manda um código de 6 dígitos para o e-mail da
-- conta e abre um "desafio" de login (esta tabela), amarrado ao navegador que digitou a senha (cookie secreto HttpOnly, aqui só o hash);
-- (3) só com o código certo, vindo desse mesmo navegador, a sessão é criada. Sem o código não há sessão: quem só sabe a senha não entra, e quem
-- só leu o código (por exemplo, olhando a caixa de e-mail) também não, porque sem o cookie do navegador o código não vale nada.
--
-- • O código nunca é gravado: só um HMAC dele (com uma chave que só o servidor conhece, fora do banco). Vale 10 minutos, uso único, no máximo
--   5 erros por código (depois disso o desafio inteiro deixa de valer e é preciso informar a senha de novo), reenvio só depois de 60 s e no
--   máximo 5 envios por desafio e 10 por hora por conta.
-- • Trocar a senha (por qualquer caminho: logado, "esqueci minha senha", link gerado pela loja) derruba os desafios que estavam abertos: o
--   desafio guarda uma impressão digital do hash da senha e só vale enquanto ela for a mesma.
-- • Quem erra a senha nunca chega aqui (e portanto ninguém consegue encher a caixa de e-mail de um cliente sem saber a senha dele).
-- • Linhas com mais de 1 dia são apagadas por esta própria tabela, de passagem (sem depender da limpeza geral); excluir a conta apaga tudo.
--
-- Só acrescenta: uma tabela e cinco funções novas. Nenhuma função existente é alterada, nenhum dado é escrito ou apagado. Voltar o código para a
-- versão anterior continua funcionando contra este banco (o login antigo só pede a senha).

create table customer_login_challenges (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
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

create index customer_login_challenges_customer_idx on customer_login_challenges (customer_id, created_at desc);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Abrir um desafio (senha já conferida pelo servidor). Devolve:
--   { ok: true, id, email, name }                       desafio novo: o servidor gera o e-mail e chama finish_login_challenge
--   { ok: true, reused: true, retry_after }             o MESMO navegador acabou de pedir (menos de 60 s): vale o código já enviado
--   { ok: false, reason: 'hourly' | 'not_active' }
-- ---------------------------------------------------------------------------------------------
create or replace function begin_login_challenge(
  p_customer uuid,
  p_nonce_hash text,
  p_code_hash text,
  p_current_nonce_hash text,
  p_code_minutes integer default 10
)
returns jsonb
language plpgsql
as $$
declare
  c customers;
  v customer_login_challenges;
  v_hour integer;
  v_id uuid;
begin
  -- Serializa os pedidos de código da mesma conta.
  select * into c from customers where id = p_customer for update;
  if not found or not c.active or c.email_verified_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;

  delete from customer_login_challenges where created_at < now() - interval '1 day';

  -- Duplo clique ou "Entrar" de novo logo depois: o código que acabou de ser enviado continua valendo, sem outro e-mail.
  if p_current_nonce_hash is not null then
    select * into v
    from customer_login_challenges
    where customer_id = c.id and nonce_hash = p_current_nonce_hash
      and used_at is null and invalidated_at is null and expires_at > now() and code_expires_at > now()
      and last_sent_at is not null and last_sent_at > now() - interval '60 seconds';
    if found then
      return jsonb_build_object('ok', true, 'reused', true, 'retry_after', greatest(1, ceil(extract(epoch from (v.last_sent_at + interval '60 seconds' - now())))::integer));
    end if;
  end if;

  select coalesce(sum(sends), 0) into v_hour
  from customer_login_challenges
  where customer_id = c.id and created_at > now() - interval '1 hour';
  if v_hour >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;

  insert into customer_login_challenges (customer_id, nonce_hash, code_hash, code_expires_at, expires_at, pw_fingerprint)
  values (
    c.id, p_nonce_hash, p_code_hash,
    now() + make_interval(mins => p_code_minutes),
    now() + interval '30 minutes',
    encode(sha256(convert_to(c.password_hash, 'UTF8')), 'hex')
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

-- Resultado do envio: aceito → o desafio passa a valer; falhou → ele é descartado (nada fica pela metade).
create or replace function finish_login_challenge(p_id uuid, p_sent boolean)
returns void
language plpgsql
as $$
begin
  if p_sent then
    update customer_login_challenges set last_sent_at = now() where id = p_id and last_sent_at is null;
  else
    delete from customer_login_challenges where id = p_id and last_sent_at is null;
  end if;
end;
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedir outro código no mesmo desafio ("Reenviar código"). Duas etapas, como a confirmação de e-mail: o código novo só substitui o
-- anterior depois que o e-mail novo foi aceito (finish_login_resend); se o envio falhar, o código que a pessoa já tinha continua valendo.
-- Devolve { ok: true, id, customer_id, email, name } ou { ok: false, reason: 'expired' | 'cooldown' | 'limit' | 'hourly', retry_after? }.
-- ---------------------------------------------------------------------------------------------
create or replace function begin_login_resend(p_nonce_hash text)
returns jsonb
language plpgsql
as $$
declare
  v customer_login_challenges;
  c customers;
  v_hour integer;
begin
  select * into v from customer_login_challenges where nonce_hash = p_nonce_hash for update;
  if not found or v.used_at is not null or v.invalidated_at is not null or v.expires_at <= now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  select * into c from customers where id = v.customer_id;
  if not found or not c.active or c.email_verified_at is null
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
  if v.sends >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'limit');
  end if;
  select coalesce(sum(sends), 0) into v_hour
  from customer_login_challenges
  where customer_id = c.id and created_at > now() - interval '1 hour';
  if v_hour >= 10 then
    return jsonb_build_object('ok', false, 'reason', 'hourly');
  end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'customer_id', c.id, 'email', c.email, 'name', c.name);
end;
$$;
-- statement-breakpoint

create or replace function finish_login_resend(p_id uuid, p_code_hash text, p_code_minutes integer, p_sent boolean)
returns void
language plpgsql
as $$
begin
  if p_sent then
    update customer_login_challenges
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
-- Conferir o código. Devolve { result: 'ok', customer_id } | { result: 'invalid' } | { result: 'locked' }.
-- "invalid" cobre código errado, vencido, já usado, substituído, desafio de outro navegador, senha trocada ou conta que não existe mais:
-- quem tenta não descobre qual foi o motivo. Todos os erros contam; com 5 o desafio inteiro é invalidado ("locked").
-- ---------------------------------------------------------------------------------------------
create or replace function verify_login_code(p_nonce_hash text, p_code_hash text)
returns jsonb
language plpgsql
as $$
declare
  v customer_login_challenges;
  c customers;
begin
  select * into v from customer_login_challenges where nonce_hash = p_nonce_hash for update;
  if not found or v.last_sent_at is null or v.used_at is not null or v.invalidated_at is not null
     or v.expires_at <= now() or v.code_expires_at <= now() then
    return jsonb_build_object('result', 'invalid');
  end if;

  select * into c from customers where id = v.customer_id for update;
  if not found or not c.active or c.email_verified_at is null
     or v.pw_fingerprint <> encode(sha256(convert_to(c.password_hash, 'UTF8')), 'hex') then
    update customer_login_challenges set invalidated_at = now() where id = v.id;
    return jsonb_build_object('result', 'invalid');
  end if;

  if v.attempts >= v.max_attempts then
    update customer_login_challenges set invalidated_at = now() where id = v.id;
    return jsonb_build_object('result', 'locked');
  end if;

  if v.code_hash = p_code_hash then
    update customer_login_challenges set used_at = now() where id = v.id;
    return jsonb_build_object('result', 'ok', 'customer_id', c.id);
  end if;

  update customer_login_challenges
     set attempts = attempts + 1,
         invalidated_at = case when attempts + 1 >= max_attempts then now() else null end
   where id = v.id;
  return jsonb_build_object('result', case when v.attempts + 1 >= v.max_attempts then 'locked' else 'invalid' end);
end;
$$;
