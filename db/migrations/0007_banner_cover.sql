-- Banner da capa da página Bebidas.
--
-- Cada banner passa a ter um lugar onde aparece:
--   'menu'  = o carrossel logo abaixo do título "Bebidas" (como sempre foi);
--   'cover' = a faixa azul do topo da página, no lugar dos gelos flutuantes.
-- Os banners que já existem continuam no cardápio ('menu'); nada muda no site até a loja cadastrar um banner de capa.
-- Sem nenhum banner de capa ativo, a página mostra a capa azul com os gelos, como antes.

alter table banners
  add column placement text not null default 'menu',
  add constraint banners_placement_valid check (placement in ('menu', 'cover'));
-- statement-breakpoint

-- O banner da capa é só imagem (o título serve de descrição para leitores de tela): sem imagem não há o que mostrar.
alter table banners
  add constraint banners_cover_needs_image check (placement <> 'cover' or image_desktop_url is not null or image_mobile_url is not null);
-- statement-breakpoint

-- A consulta do site filtra por lugar e ordena pela posição dentro do lugar.
drop index if exists banners_position_idx;
-- statement-breakpoint

create index banners_placement_position_idx on banners (placement, position) where active;
