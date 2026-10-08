-- COPO CHEIO – Disk Bebidas
-- 2/5 · Segurança: quem é administrador, Row Level Security e permissões.
--
-- Regra geral:
--   • visitantes (anon) leem só o que aparece no site: produtos/categorias/banners ativos e os
--     textos/configurações públicas. Não leem pedidos, clientes nem administradores;
--   • pedidos são criados só pela função create_order (preços conferidos no banco);
--   • administradores ativos (tabela admin_users) gerenciam tudo; só o owner gerencia administradores.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = (select auth.uid()) and active
  );
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users where user_id = (select auth.uid()) and active and role = 'owner'
  );
$$;

revoke execute on function public.is_admin() from public;
revoke execute on function public.is_owner() from public;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;

-- A loja nunca fica sem um owner ativo.
create or replace function public.admin_users_keep_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'DELETE' and old.role = 'owner' and old.active)
     or (tg_op = 'UPDATE' and old.role = 'owner' and old.active and (new.role <> 'owner' or not new.active)) then
    if not exists (
      select 1 from public.admin_users where role = 'owner' and active and id <> old.id
    ) then
      raise exception 'A loja precisa de pelo menos um owner ativo.' using errcode = 'P0001';
    end if;
  end if;
  return coalesce(new, old);
end;
$$;

create trigger admin_users_keep_owner before update or delete on public.admin_users
  for each row execute function public.admin_users_keep_owner();

-- ---------------------------------------------------------------------------------------------
-- Permissões das roles da API (sem nada implícito)
-- ---------------------------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from anon, authenticated, public;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.is_owner() to anon, authenticated;

-- Site público: só as colunas que o site mostra (estoque, SKU e caminhos internos ficam de fora).
grant select (id, category_id, name, description, price, promo_price, image_url, featured, sold_out, position, active)
  on public.products to anon;
grant select (id, name, position, active) on public.categories to anon;
grant select (id, title, subtitle, image_desktop_url, image_mobile_url, button_text, link, position, active)
  on public.banners to anon;
grant select (id, name, fee, position, active) on public.delivery_zones to anon;
grant select on public.store_settings, public.site_settings, public.hero_settings to anon;

-- Usuários logados (as policies limitam aos administradores).
grant select, insert, update, delete on
  public.products, public.categories, public.banners, public.delivery_zones, public.admin_users
  to authenticated;
grant select, update on public.store_settings, public.site_settings, public.hero_settings to authenticated;
grant select on public.orders, public.order_items, public.order_status_history to authenticated;
-- No pedido só mudam o status e o pagamento: itens, preços e totais ficam como o cliente fechou.
grant update (order_status, payment_status) on public.orders to authenticated;
grant select, update (full_name, phone) on public.profiles to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.store_settings enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.site_settings enable row level security;
alter table public.hero_settings enable row level security;
alter table public.banners enable row level security;

-- Perfis: cada um vê e edita o seu; administradores veem todos.
create policy "profiles: ler o próprio ou admin" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy "profiles: editar o próprio" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Administradores: cada admin vê a equipe; só o owner adiciona, altera ou remove.
create policy "admin_users: admin lê" on public.admin_users
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy "admin_users: owner cria" on public.admin_users
  for insert to authenticated
  with check ((select public.is_owner()));
create policy "admin_users: owner altera" on public.admin_users
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));
create policy "admin_users: owner remove" on public.admin_users
  for delete to authenticated
  using ((select public.is_owner()) and user_id <> (select auth.uid()));

-- Categorias
create policy "categories: público lê as ativas" on public.categories
  for select to anon, authenticated
  using (active or (select public.is_admin()));
create policy "categories: admin cria" on public.categories
  for insert to authenticated with check ((select public.is_admin()));
create policy "categories: admin altera" on public.categories
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "categories: admin remove" on public.categories
  for delete to authenticated using ((select public.is_admin()));

-- Produtos: o público vê os ativos de categorias ativas (ou sem categoria).
create policy "products: público lê os ativos" on public.products
  for select to anon, authenticated
  using (
    (select public.is_admin())
    or (
      active
      and (category_id is null or exists (
        select 1 from public.categories c where c.id = products.category_id and c.active
      ))
    )
  );
create policy "products: admin cria" on public.products
  for insert to authenticated with check ((select public.is_admin()));
create policy "products: admin altera" on public.products
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "products: admin remove" on public.products
  for delete to authenticated using ((select public.is_admin()));

-- Pedidos: só administradores. Clientes não consultam a tabela (veem o próprio pedido pela
-- função get_public_order, com o código secreto do link).
create policy "orders: admin lê" on public.orders
  for select to authenticated using ((select public.is_admin()));
create policy "orders: admin altera status" on public.orders
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "order_items: admin lê" on public.order_items
  for select to authenticated using ((select public.is_admin()));
create policy "order_status_history: admin lê" on public.order_status_history
  for select to authenticated using ((select public.is_admin()));

-- Configurações e conteúdo: leitura pública, alteração só por administradores.
create policy "store_settings: público lê" on public.store_settings
  for select to anon, authenticated using (true);
create policy "store_settings: admin altera" on public.store_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "site_settings: público lê" on public.site_settings
  for select to anon, authenticated using (true);
create policy "site_settings: admin altera" on public.site_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "hero_settings: público lê" on public.hero_settings
  for select to anon, authenticated using (true);
create policy "hero_settings: admin altera" on public.hero_settings
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "delivery_zones: público lê os ativos" on public.delivery_zones
  for select to anon, authenticated using (active or (select public.is_admin()));
create policy "delivery_zones: admin cria" on public.delivery_zones
  for insert to authenticated with check ((select public.is_admin()));
create policy "delivery_zones: admin altera" on public.delivery_zones
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "delivery_zones: admin remove" on public.delivery_zones
  for delete to authenticated using ((select public.is_admin()));

create policy "banners: público lê os ativos" on public.banners
  for select to anon, authenticated using (active or (select public.is_admin()));
create policy "banners: admin cria" on public.banners
  for insert to authenticated with check ((select public.is_admin()));
create policy "banners: admin altera" on public.banners
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "banners: admin remove" on public.banners
  for delete to authenticated using ((select public.is_admin()));
