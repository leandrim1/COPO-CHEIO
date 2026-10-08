-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 1/3 · Tabelas, relacionamentos e índices.
--
-- Cada comando termina com a linha "-- statement-breakpoint": o script scripts/migrate.mjs roda um por vez,
-- todos dentro de uma única transação por arquivo.
-- Valores em reais usam numeric(10,2). Textos têm limite de tamanho para que nada do que o painel
-- salva consiga quebrar o layout do site. Imagens ficam no Vercel Blob: aqui só a URL.

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
-- statement-breakpoint

-- Horário de funcionamento: {"mon": {"open": true, "start": "09:00", "end": "23:00"}, ... "sun": {...}}
create or replace function valid_opening_hours(hours jsonb)
returns boolean
language sql
immutable
as $$
  select jsonb_typeof(hours) = 'object'
    and (
      select bool_and(
        jsonb_typeof(hours -> d) = 'object'
        and jsonb_typeof(hours -> d -> 'open') = 'boolean'
        and coalesce(hours -> d ->> 'start', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        and coalesce(hours -> d ->> 'end', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      )
      from unnest(array['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) as d
    );
$$;
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Administradores e sessões do painel
-- ---------------------------------------------------------------------------------------------

create table admins (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  email text not null check (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- scrypt$N$r$p$salt$hash (nunca a senha).
  password_hash text not null,
  role text not null default 'admin' check (role in ('owner', 'admin')),
  active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index admins_email_key on admins (lower(email));
-- statement-breakpoint

-- A loja nunca fica sem um owner ativo.
create or replace function admins_keep_owner()
returns trigger
language plpgsql
as $$
begin
  if (tg_op = 'DELETE' and old.role = 'owner' and old.active)
     or (tg_op = 'UPDATE' and old.role = 'owner' and old.active and (new.role <> 'owner' or not new.active)) then
    if not exists (select 1 from admins where role = 'owner' and active and id <> old.id) then
      raise exception 'A loja precisa de pelo menos um owner ativo.' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;
-- statement-breakpoint

create trigger admins_keep_owner before update or delete on admins
  for each row execute function admins_keep_owner();
-- statement-breakpoint

-- Só o hash do código da sessão fica no banco; o código em si vive no cookie HttpOnly do navegador.
create table admin_sessions (
  token_hash text primary key,
  admin_id uuid not null references admins (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
-- statement-breakpoint

create index admin_sessions_admin_idx on admin_sessions (admin_id);
-- statement-breakpoint
create index admin_sessions_expires_idx on admin_sessions (expires_at);
-- statement-breakpoint

-- Limite de tentativas (login do painel e criação de pedidos): uma linha por tentativa.
create table rate_limits (
  id bigint generated always as identity primary key,
  bucket text not null,
  key text not null,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index rate_limits_lookup_idx on rate_limits (bucket, key, created_at);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------------------------

create table categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 40),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index categories_name_key on categories (lower(btrim(name)));
-- statement-breakpoint
create index categories_position_idx on categories (position, name);
-- statement-breakpoint

create trigger categories_updated_at before update on categories
  for each row execute function set_updated_at();
-- statement-breakpoint

create table products (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references categories (id) on delete set null,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 300),
  price numeric(10, 2) not null check (price >= 0),
  -- Preço promocional: quando preenchido, é o que o cliente paga (e precisa ser menor que o preço).
  promo_price numeric(10, 2) check (promo_price is null or (promo_price >= 0 and promo_price < price)),
  -- URL pública da imagem no Vercel Blob (ou, em produtos importados, o link que veio no arquivo).
  image_url text check (image_url is null or char_length(image_url) <= 1000),
  sku text check (sku is null or char_length(sku) between 1 and 40),
  -- null = estoque não controlado (sempre disponível, a menos que marcado como esgotado).
  stock integer check (stock is null or stock >= 0),
  featured boolean not null default false,
  -- active = aparece no site. sold_out = aparece como ESGOTADO e não pode ser pedido.
  active boolean not null default true,
  sold_out boolean not null default false,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index products_sku_key on products (lower(sku)) where sku is not null;
-- statement-breakpoint
create index products_category_idx on products (category_id, position, name);
-- statement-breakpoint
create index products_featured_idx on products (position) where featured and active;
-- statement-breakpoint

create trigger products_updated_at before update on products
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Estoque chegou a 0 → ESGOTADO. Voltou a ter estoque depois de zerado → disponível de novo.
create or replace function products_stock_status()
returns trigger
language plpgsql
as $$
begin
  if new.stock is not null and new.stock = 0 then
    new.sold_out = true;
  elsif tg_op = 'UPDATE' and old.stock is not null and old.stock = 0
        and new.stock is not null and new.stock > 0
        and new.sold_out is not distinct from old.sold_out then
    new.sold_out = false;
  end if;
  return new;
end;
$$;
-- statement-breakpoint

create trigger products_stock_status before insert or update of stock, sold_out on products
  for each row execute function products_stock_status();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Formas de pagamento (sem gateway: o pagamento acontece na entrega/retirada)
-- ---------------------------------------------------------------------------------------------

create table payment_methods (
  code text primary key check (code in ('pix', 'cash', 'card')),
  label text not null check (char_length(btrim(label)) between 2 and 40),
  enabled boolean not null default true,
  -- PIX: a chave que o cliente vê depois do pedido (opcional).
  details text check (details is null or char_length(details) <= 100),
  position integer not null default 0,
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create trigger payment_methods_updated_at before update on payment_methods
  for each row execute function set_updated_at();
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Pedidos
-- ---------------------------------------------------------------------------------------------

create sequence order_number_seq start with 1001;
-- statement-breakpoint

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint not null unique default nextval('order_number_seq'),
  -- Código secreto da página /pedido/:id do cliente (nunca é o id interno).
  public_token uuid not null unique default gen_random_uuid(),
  customer_name text not null check (char_length(btrim(customer_name)) between 2 and 80),
  customer_phone text not null check (customer_phone ~ '^[0-9]{10,13}$'),
  customer_email text check (customer_email is null or (char_length(customer_email) <= 254 and customer_email like '%_@_%')),
  delivery_type text not null check (delivery_type in ('delivery', 'pickup')),
  address text check (address is null or char_length(address) <= 120),
  address_number text check (address_number is null or char_length(address_number) <= 20),
  neighborhood text check (neighborhood is null or char_length(neighborhood) <= 60),
  complement text check (complement is null or char_length(complement) <= 60),
  reference text check (reference is null or char_length(reference) <= 120),
  notes text check (notes is null or char_length(notes) <= 500),
  subtotal numeric(10, 2) not null check (subtotal >= 0),
  delivery_fee numeric(10, 2) not null default 0 check (delivery_fee >= 0),
  discount numeric(10, 2) not null default 0 check (discount >= 0),
  total numeric(10, 2) not null check (total >= 0),
  payment_method text not null references payment_methods (code),
  -- Troco para (pagamento em dinheiro).
  change_for numeric(10, 2) check (change_for is null or change_for > 0),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid', 'refunded')),
  order_status text not null default 'new'
    check (order_status in ('new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_delivery_address check (
    delivery_type = 'pickup' or (address is not null and address_number is not null and neighborhood is not null)
  )
);
-- statement-breakpoint

alter sequence order_number_seq owned by orders.order_number;
-- statement-breakpoint

create index orders_created_at_idx on orders (created_at desc);
-- statement-breakpoint
create index orders_status_idx on orders (order_status, created_at desc);
-- statement-breakpoint
create index orders_phone_idx on orders (customer_phone, created_at desc);
-- statement-breakpoint

create trigger orders_updated_at before update on orders
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Nome e preço ficam gravados no item: mudar o produto depois não altera pedidos antigos.
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  product_id uuid references products (id) on delete set null,
  product_name text not null,
  quantity integer not null check (quantity between 1 and 99),
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  total_price numeric(10, 2) not null check (total_price >= 0),
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index order_items_order_idx on order_items (order_id);
-- statement-breakpoint
create index order_items_product_idx on order_items (product_id);
-- statement-breakpoint

create table order_status_history (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references admins (id) on delete set null,
  -- Nome de quem mudou, gravado na hora ("Cliente (site)" quando o pedido nasce).
  changed_by_name text,
  created_at timestamptz not null default now()
);
-- statement-breakpoint

create index order_status_history_order_idx on order_status_history (order_id, created_at);
-- statement-breakpoint

-- ---------------------------------------------------------------------------------------------
-- Conteúdo do site e configurações (uma linha cada, id = 1)
-- ---------------------------------------------------------------------------------------------

create table store_settings (
  id smallint primary key default 1 check (id = 1),
  store_name text not null default 'Copo Cheio' check (char_length(btrim(store_name)) between 2 and 30),
  tagline text not null default 'Disk Bebidas' check (char_length(tagline) <= 30),
  -- Só números, com 55 + DDD. Ex.: 5534999999999
  whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$'),
  instagram text check (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$'),
  address text check (address is null or char_length(address) <= 160),
  cep text check (cep is null or cep ~ '^[0-9]{8}$'),
  city text check (city is null or char_length(city) <= 60),
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  opening_hours jsonb not null check (valid_opening_hours(opening_hours)),
  timezone text not null default 'America/Sao_Paulo',
  -- Pausa manual: o site mostra a loja fechada e não aceita pedidos.
  orders_paused boolean not null default false,
  delivery_enabled boolean not null default true,
  pickup_enabled boolean not null default true,
  delivery_fee numeric(10, 2) not null default 0 check (delivery_fee >= 0),
  min_order numeric(10, 2) not null default 0 check (min_order >= 0),
  delivery_time text check (delivery_time is null or char_length(delivery_time) <= 30),
  updated_at timestamptz not null default now(),
  constraint store_settings_some_delivery check (delivery_enabled or pickup_enabled)
);
-- statement-breakpoint

create trigger store_settings_updated_at before update on store_settings
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Taxa por bairro. Sem bairros ativos, vale a taxa única de store_settings.
create table delivery_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  fee numeric(10, 2) not null check (fee >= 0),
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create unique index delivery_zones_name_key on delivery_zones (lower(btrim(name)));
-- statement-breakpoint

create trigger delivery_zones_updated_at before update on delivery_zones
  for each row execute function set_updated_at();
-- statement-breakpoint

-- Textos fora do Hero, SEO e destaques. "highlight" = trecho do título pintado de azul.
create table site_settings (
  id smallint primary key default 1 check (id = 1),
  logo_url text check (logo_url is null or char_length(logo_url) <= 1000),
  bebidas_title text not null check (char_length(btrim(bebidas_title)) between 4 and 70),
  bebidas_highlight text check (bebidas_highlight is null or char_length(bebidas_highlight) <= 40),
  bebidas_subtitle text check (bebidas_subtitle is null or char_length(bebidas_subtitle) <= 160),
  featured_title text not null check (char_length(btrim(featured_title)) between 2 and 40),
  featured_limit smallint not null default 4 check (featured_limit between 0 and 8),
  contato_title text not null check (char_length(btrim(contato_title)) between 4 and 60),
  contato_highlight text check (contato_highlight is null or char_length(contato_highlight) <= 40),
  contato_subtitle text check (contato_subtitle is null or char_length(contato_subtitle) <= 160),
  cta_title text not null check (char_length(btrim(cta_title)) between 2 and 30),
  cta_highlight text check (cta_highlight is null or char_length(cta_highlight) <= 20),
  cta_subtitle text check (cta_subtitle is null or char_length(cta_subtitle) <= 100),
  cta_button text not null check (char_length(btrim(cta_button)) between 2 and 24),
  seo_title text not null check (char_length(btrim(seo_title)) between 4 and 70),
  seo_description text check (seo_description is null or char_length(seo_description) <= 170),
  og_image_url text check (og_image_url is null or char_length(og_image_url) <= 1000),
  favicon_url text check (favicon_url is null or char_length(favicon_url) <= 1000),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create trigger site_settings_updated_at before update on site_settings
  for each row execute function set_updated_at();
-- statement-breakpoint

create table hero_settings (
  id smallint primary key default 1 check (id = 1),
  title text not null check (char_length(btrim(title)) between 4 and 60),
  title_highlight text check (title_highlight is null or char_length(title_highlight) <= 30),
  subtitle text check (subtitle is null or char_length(subtitle) <= 140),
  primary_button_text text not null check (char_length(btrim(primary_button_text)) between 2 and 20),
  secondary_button_text text not null check (char_length(btrim(secondary_button_text)) between 2 and 20),
  show_secondary_button boolean not null default true,
  badge_text text not null check (char_length(btrim(badge_text)) between 2 and 32),
  show_badge boolean not null default true,
  -- URLs (Vercel Blob) das imagens do carrossel do Hero. Vazio = as bebidas que já vêm com o site.
  images jsonb not null default '[]'::jsonb
    check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 6),
  updated_at timestamptz not null default now()
);
-- statement-breakpoint

create trigger hero_settings_updated_at before update on hero_settings
  for each row execute function set_updated_at();
-- statement-breakpoint

create table banners (
  id uuid primary key default gen_random_uuid(),
  title text check (title is null or char_length(title) <= 60),
  subtitle text check (subtitle is null or char_length(subtitle) <= 120),
  image_desktop_url text check (image_desktop_url is null or char_length(image_desktop_url) <= 1000),
  image_mobile_url text check (image_mobile_url is null or char_length(image_mobile_url) <= 1000),
  button_text text check (button_text is null or char_length(button_text) <= 24),
  -- Link interno ("/bebidas") ou externo (https://...).
  link text check (link is null or (char_length(link) <= 500 and (link ~ '^/' or link ~ '^https://'))),
  active boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint banners_has_content check (
    image_desktop_url is not null or image_mobile_url is not null or title is not null
  )
);
-- statement-breakpoint

create index banners_position_idx on banners (position) where active;
-- statement-breakpoint

create trigger banners_updated_at before update on banners
  for each row execute function set_updated_at();
