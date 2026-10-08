-- COPO CHEIO – Disk Bebidas
-- 4/5 · Imagens (Supabase Storage) e pedidos em tempo real (Supabase Realtime).

-- Bucket público "media": fotos de produtos, banners, Hero, logo, imagem de compartilhamento e favicon.
-- Qualquer um vê os arquivos pelo link público; só administradores enviam, trocam ou apagam.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'media',
  'media',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "media: admin lista" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (select public.is_admin()));
create policy "media: admin envia" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (select public.is_admin()));
create policy "media: admin substitui" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (select public.is_admin()))
  with check (bucket_id = 'media' and (select public.is_admin()));
create policy "media: admin apaga" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (select public.is_admin()));

-- Pedidos novos e mudanças de status chegam ao painel sem recarregar a página.
-- O Realtime respeita o RLS: só administradores recebem esses eventos.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'orders'
     ) then
    alter publication supabase_realtime add table public.orders;
  end if;
end;
$$;
