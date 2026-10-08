-- COPO CHEIO – Disk Bebidas · Neon PostgreSQL (copocheio-db)
-- 3/3 · Conteúdo inicial: exatamente os textos e dados que o site já mostrava.
-- Depois disso tudo é editado pelo painel (/admin). Nenhum produto, preço ou categoria é criado aqui.

insert into store_settings (
  id, store_name, tagline, whatsapp, instagram, address,
  opening_hours, delivery_enabled, pickup_enabled, delivery_fee, min_order, delivery_time
) values (
  1, 'Copo Cheio', 'Disk Bebidas', null, 'copocheiodisk', null,
  '{
    "mon": {"open": true,  "start": "09:00", "end": "23:00"},
    "tue": {"open": true,  "start": "09:00", "end": "23:00"},
    "wed": {"open": true,  "start": "09:00", "end": "23:00"},
    "thu": {"open": true,  "start": "09:00", "end": "23:00"},
    "fri": {"open": true,  "start": "09:00", "end": "23:00"},
    "sat": {"open": false, "start": "09:00", "end": "23:00"},
    "sun": {"open": false, "start": "09:00", "end": "23:00"}
  }'::jsonb,
  true, true, 5.00, 0, '30 a 45 min'
)
on conflict (id) do nothing;
-- statement-breakpoint

insert into site_settings (
  id, bebidas_title, bebidas_highlight, bebidas_subtitle, featured_title, featured_limit,
  contato_title, contato_highlight, contato_subtitle,
  cta_title, cta_highlight, cta_subtitle, cta_button,
  seo_title, seo_description
) values (
  1,
  'Bebidas para deixar seu momento ainda melhor', 'ainda melhor',
  'Escolha sua bebida favorita. A gente entrega gelada e rapidinho na sua casa.',
  'Os favoritos da galera', 4,
  'Fale com a Copo Cheio', 'Copo Cheio',
  'Precisa de ajuda com seu pedido? Estamos prontos para atender você.',
  'Deu sede?', 'sede?', 'Peça agora e receba sua bebida bem gelada.', 'PEDIR AGORA',
  'COPO CHEIO – Disk Bebidas',
  'COPO CHEIO – Disk Bebidas. Bebidas bem geladas, variedade e entrega rápida na sua casa.'
)
on conflict (id) do nothing;
-- statement-breakpoint

insert into hero_settings (
  id, title, title_highlight, subtitle, primary_button_text, secondary_button_text,
  show_secondary_button, badge_text, show_badge, images
) values (
  1,
  'Sua bebida gelada chega até você.', 'bebida gelada',
  'Bebidas bem geladas, variedade e rapidez para deixar qualquer momento muito melhor.',
  'Pedir agora', 'Ver bebidas', true,
  'GELADA • RÁPIDA • NA SUA CASA', true,
  '[]'::jsonb
)
on conflict (id) do nothing;
-- statement-breakpoint

insert into payment_methods (code, label, enabled, position) values
  ('pix', 'PIX', true, 0),
  ('cash', 'Dinheiro', true, 1),
  ('card', 'Cartão na entrega', true, 2)
on conflict (code) do nothing;
