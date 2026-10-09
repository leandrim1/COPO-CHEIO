// Painel: conteúdo do site (logo, Hero, textos, SEO), banners, loja, entrega e pagamento.
import { releaseImages } from '../blob.js';
import { batch, insertRow, one, query, updateRow } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import {
  bool,
  digits,
  imageList,
  imageUrl,
  instagram,
  int,
  money,
  openingHours,
  parse,
  siteLink,
  state,
  text,
} from '../validate.js';
import type { Spec } from '../validate.js';

const storeSpec: Spec = {
  store_name: text('Nome da loja', { min: 2, max: 30 }),
  tagline: text('Complemento do nome', { max: 30 }),
  whatsapp: digits('WhatsApp', { min: 10, max: 15, nullable: true }),
  instagram: instagram('Instagram'),
  address: text('Endereço', { max: 160, nullable: true }),
  cep: digits('CEP', { min: 8, max: 8, nullable: true }),
  city: text('Cidade', { max: 60, nullable: true }),
  state: state('Estado'),
  opening_hours: openingHours('Horário de funcionamento'),
  orders_paused: bool('Pausar pedidos'),
  delivery_enabled: bool('Entrega'),
  pickup_enabled: bool('Retirada'),
  delivery_fee: money('Taxa de entrega'),
  min_order: money('Pedido mínimo'),
  delivery_time: text('Tempo de entrega', { max: 30, nullable: true }),
  tracking_retention_days: int('Validade do link de acompanhamento (dias)', { min: 7, max: 3650 }),
};

const siteSpec: Spec = {
  logo_url: imageUrl('Logo'),
  bebidas_title: text('Título de Bebidas', { min: 4, max: 70 }),
  bebidas_highlight: text('Destaque do título de Bebidas', { max: 40, nullable: true }),
  bebidas_subtitle: text('Subtítulo de Bebidas', { max: 160, nullable: true }),
  featured_title: text('Título dos favoritos', { min: 2, max: 40 }),
  featured_limit: int('Quantidade de favoritos', { min: 0, max: 8 }),
  contato_title: text('Título de Contato', { min: 4, max: 60 }),
  contato_highlight: text('Destaque do título de Contato', { max: 40, nullable: true }),
  contato_subtitle: text('Subtítulo de Contato', { max: 160, nullable: true }),
  cta_title: text('Título da chamada final', { min: 2, max: 30 }),
  cta_highlight: text('Destaque da chamada final', { max: 20, nullable: true }),
  cta_subtitle: text('Subtítulo da chamada final', { max: 100, nullable: true }),
  cta_button: text('Botão da chamada final', { min: 2, max: 24 }),
  seo_title: text('Título do Google', { min: 4, max: 70 }),
  seo_description: text('Descrição do Google', { max: 170, nullable: true }),
  og_image_url: imageUrl('Imagem de compartilhamento'),
  favicon_url: imageUrl('Favicon'),
};

const heroSpec: Spec = {
  title: text('Título do Hero', { min: 4, max: 60 }),
  title_highlight: text('Destaque do título', { max: 30, nullable: true }),
  subtitle: text('Subtítulo do Hero', { max: 140, nullable: true }),
  primary_button_text: text('Botão principal', { min: 2, max: 20 }),
  secondary_button_text: text('Botão secundário', { min: 2, max: 20 }),
  show_secondary_button: bool('Mostrar botão secundário'),
  badge_text: text('Selo', { min: 2, max: 32 }),
  show_badge: bool('Mostrar selo'),
  images: imageList('Imagens do Hero', 6),
};

const bannerSpec: Spec = {
  title: text('Título', { max: 60, nullable: true }),
  subtitle: text('Subtítulo', { max: 120, nullable: true }),
  image_desktop_url: imageUrl('Imagem desktop'),
  image_mobile_url: imageUrl('Imagem celular'),
  button_text: text('Texto do botão', { max: 24, nullable: true }),
  link: siteLink('Link'),
  active: bool('Ativo'),
  position: int('Ordem', { max: 100_000 }),
};

const zoneSpec: Spec = {
  name: text('Bairro', { min: 1, max: 60, required: true }),
  fee: money('Taxa', { required: true }),
  active: bool('Ativo'),
  position: int('Ordem', { max: 100_000 }),
};

const paymentSpec: Spec = {
  enabled: bool('Ativa'),
  details: text('Chave PIX', { max: 100, nullable: true }),
};

// O trecho em destaque precisa aparecer escrito igual no título (é ele que fica azul).
function checkHighlights(values: Record<string, unknown>, pairs: [title: string, highlight: string, label: string][]) {
  for (const [title, highlight, label] of pairs) {
    const t = values[title];
    const h = values[highlight];
    if (typeof t === 'string' && typeof h === 'string' && !t.includes(h)) {
      throw new HttpError(400, `${label}: o trecho em azul precisa estar escrito igual no título.`);
    }
  }
}

export function registerContent(r: Router) {
  // Tudo que as telas Site e Configurações precisam, numa chamada.
  r.get('/api/admin/settings', 'admin', async () => {
    const [store, site, hero, payments, zones] = await batch([
      ['select * from store_settings where id = 1'],
      ['select * from site_settings where id = 1'],
      ['select * from hero_settings where id = 1'],
      ['select * from payment_methods order by position'],
      ['select * from delivery_zones order by position, name'],
    ]);
    return json({ store: store[0], site: site[0], hero: hero[0], payments, zones });
  });

  r.patch('/api/admin/store', 'admin', async (ctx) => {
    const { values, cast } = parse(storeSpec, await readJson(ctx.req, 16 * 1024), { partial: true });
    return json({ store: await updateRow('store_settings', { column: 'id', value: 1 }, values, cast) });
  });

  r.patch('/api/admin/site', 'admin', async (ctx) => {
    const { values } = parse(siteSpec, await readJson(ctx.req, 16 * 1024), { partial: true });
    checkHighlights(values, [
      ['bebidas_title', 'bebidas_highlight', 'Bebidas'],
      ['contato_title', 'contato_highlight', 'Contato'],
      ['cta_title', 'cta_highlight', 'Chamada final'],
    ]);
    const before = await one<{ logo_url: string | null; og_image_url: string | null; favicon_url: string | null }>('select logo_url, og_image_url, favicon_url from site_settings where id = 1');
    const site = await updateRow('site_settings', { column: 'id', value: 1 }, values);
    if (before) await releaseImages([before.logo_url, before.og_image_url, before.favicon_url]);
    return json({ site });
  });

  r.patch('/api/admin/hero', 'admin', async (ctx) => {
    const { values, cast } = parse(heroSpec, await readJson(ctx.req, 16 * 1024), { partial: true });
    checkHighlights(values, [['title', 'title_highlight', 'Hero']]);
    const before = await one<{ images: string[] }>('select images from hero_settings where id = 1');
    const hero = await updateRow('hero_settings', { column: 'id', value: 1 }, values, cast);
    if (before) await releaseImages(before.images);
    return json({ hero });
  });

  // ---- Pagamento ---------------------------------------------------------------------------------

  r.patch('/api/admin/payments/:code', 'admin', async (ctx) => {
    const code = ctx.params.code;
    const { values } = parse(paymentSpec, await readJson(ctx.req, 4 * 1024), { partial: true });
    if (values.enabled === false) {
      const others = await one<{ n: number }>('select count(*) as n from payment_methods where enabled and code <> $1', [code]);
      if (!others?.n) throw new HttpError(400, 'Mantenha pelo menos uma forma de pagamento ativa.');
    }
    const payment = await updateRow('payment_methods', { column: 'code', value: code }, values);
    if (!payment) throw new HttpError(404, 'Forma de pagamento não encontrada.');
    return json({ payment });
  });

  // ---- Taxa de entrega por bairro -----------------------------------------------------------------

  r.get('/api/admin/zones', 'admin', async () => json({ zones: await query('select * from delivery_zones order by position, name') }));

  r.post('/api/admin/zones', 'admin', async (ctx) => {
    const { values } = parse(zoneSpec, await readJson(ctx.req, 4 * 1024));
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from delivery_zones'))?.n ?? 0;
    }
    return json({ zone: await insertRow('delivery_zones', values) }, 201);
  });

  r.patch('/api/admin/zones/:id', 'admin', async (ctx) => {
    const { values } = parse(zoneSpec, await readJson(ctx.req, 4 * 1024), { partial: true });
    const zone = await updateRow('delivery_zones', { column: 'id', value: uuidParam(ctx) }, values);
    if (!zone) throw new HttpError(404, 'Bairro não encontrado.');
    return json({ zone });
  });

  r.delete('/api/admin/zones/:id', 'admin', async (ctx) => {
    if (!(await one('delete from delivery_zones where id = $1 returning id', [uuidParam(ctx)]))) throw new HttpError(404, 'Bairro não encontrado.');
    return json({ ok: true });
  });

  // ---- Banners ---------------------------------------------------------------------------------------

  r.get('/api/admin/banners', 'admin', async () => json({ banners: await query('select * from banners order by position, created_at') }));

  r.post('/api/admin/banners', 'admin', async (ctx) => {
    const { values } = parse(bannerSpec, await readJson(ctx.req, 8 * 1024));
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from banners'))?.n ?? 0;
    }
    return json({ banner: await insertRow('banners', values) }, 201);
  });

  r.put('/api/admin/banners/order', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    if (!Array.isArray(body.ids) || body.ids.length > 200) throw new HttpError(400, 'Lista inválida.');
    const ids = body.ids.map((id: unknown) => {
      if (typeof id !== 'string') throw new HttpError(400, 'Lista inválida.');
      return id;
    });
    await query(
      `update banners b set position = o.ord - 1
         from unnest($1::uuid[]) with ordinality as o(id, ord)
        where b.id = o.id`,
      [ids],
    );
    return json({ ok: true });
  });

  r.patch('/api/admin/banners/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(bannerSpec, await readJson(ctx.req, 8 * 1024), { partial: true });
    const before = await one<{ image_desktop_url: string | null; image_mobile_url: string | null }>('select image_desktop_url, image_mobile_url from banners where id = $1', [id]);
    if (!before) throw new HttpError(404, 'Banner não encontrado.');
    const banner = await updateRow('banners', { column: 'id', value: id }, values);
    await releaseImages([before.image_desktop_url, before.image_mobile_url]);
    return json({ banner });
  });

  r.delete('/api/admin/banners/:id', 'admin', async (ctx) => {
    const removed = await one<{ image_desktop_url: string | null; image_mobile_url: string | null }>(
      'delete from banners where id = $1 returning image_desktop_url, image_mobile_url',
      [uuidParam(ctx)],
    );
    if (!removed) throw new HttpError(404, 'Banner não encontrado.');
    await releaseImages([removed.image_desktop_url, removed.image_mobile_url]);
    return json({ ok: true });
  });
}
