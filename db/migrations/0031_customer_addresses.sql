-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 31/31 · Mais de um endereço salvo na conta do cliente.
--
-- O endereço que a conta já tinha (colunas address, address_number… em customers) continua sendo o PRINCIPAL e nada nele muda. Esta tabela guarda os endereços EXTRAS
-- (trabalho, casa de um parente...), até 4 por conta (5 com o principal), cada um com um apelido. Apagar a conta apaga os extras (on delete cascade); a exclusão/anonimização
-- de uma pessoa (anonymize_person) já apaga a conta, então leva os extras junto. Nenhum dado existente é alterado.

create table customer_addresses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 30),
  cep text check (cep is null or cep ~ '^[0-9]{8}$'),
  address text not null check (char_length(btrim(address)) between 1 and 120),
  address_number text not null check (char_length(btrim(address_number)) between 1 and 20),
  neighborhood text not null check (char_length(btrim(neighborhood)) between 1 and 60),
  complement text check (complement is null or char_length(complement) <= 60),
  reference text check (reference is null or char_length(reference) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create index customer_addresses_customer_idx on customer_addresses (customer_id, created_at);
-- statement-breakpoint

create trigger customer_addresses_updated_at before update on customer_addresses
  for each row execute function set_updated_at();
-- statement-breakpoint

-- No máximo 4 extras por conta (a trava é do banco: duas abas ao mesmo tempo não passam do limite).
create or replace function customer_addresses_limit()
returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('addr:' || new.customer_id::text, 0));
  if (select count(*) from customer_addresses a where a.customer_id = new.customer_id) >= 4 then
    raise exception 'Você já tem 4 endereços extras salvos. Apague um para salvar outro.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
-- statement-breakpoint

create trigger customer_addresses_limit before insert on customer_addresses
  for each row execute function customer_addresses_limit();
