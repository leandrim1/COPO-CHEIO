// Painel: conteúdo do site (logo, Hero, textos, SEO), banners, loja, entrega e pagamento.
import { audit, changedFields } from '../audit.js';
import type { FieldLabels } from '../audit.js';
import { releaseImages } from '../blob.js';
import { batch, insertRow, one, query, updateRow } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { onlineReadiness } from '../payments/service.js';
import {
  bool,
  digits,
  imageList,
  imageUrl,
  instagram,
  int,
  money,
  oneOf,
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

// Onde o banner aparece: 'menu' = carrossel abaixo do título "Bebidas"; 'cover' = faixa azul do topo da página (no lugar dos gelos).
const BANNER_PLACEMENTS = ['menu', 'cover'] as const;

const bannerSpec: Spec = {
  placement: oneOf('Onde aparece', BANNER_PLACEMENTS),
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

// Rótulos do histórico de atividades: valores curtos aparecem de → para; textos longos e imagens só dizem que mudaram.
const STORE_LABELS: FieldLabels = {
  store_name: { label: 'nome da loja' },
  whatsapp: { label: 'WhatsApp' },
  instagram: { label: 'Instagram' },
  address: { label: 'endereço' },
  cep: { label: 'CEP' },
  city: { label: 'cidade' },
  state: { label: 'estado' },
  opening_hours: { label: 'horário de funcionamento', format: 'changed', json: true },
  orders_paused: { label: 'pausar pedidos pelo site', format: 'bool' },
  delivery_enabled: { label: 'entrega ativa', format: 'bool' },
  pickup_enabled: { label: 'retirada ativa', format: 'bool' },
  delivery_fee: { label: 'taxa de entrega', format: 'money' },
  min_order: { label: 'pedido mínimo', format: 'money' },
  delivery_time: { label: 'tempo de entrega' },
  tracking_retention_days: { label: 'validade do link de acompanhamento (dias)' },
};
const longLabels = (spec: Spec): FieldLabels => Object.fromEntries(Object.entries(spec).map(([key, field]) => [key, { label: field.label.toLowerCase(), format: 'changed' as const }]));
const SITE_LABELS = longLabels(siteSpec);
const HERO_LABELS = longLabels(heroSpec);

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
      // Os meios de pagamento online (o cliente paga pelo site) são ligados e conferidos em /admin/pagamentos, não nesta lista.
      ['select * from payment_methods where not is_online_payment(code) order by position'],
      ['select * from delivery_zones order by position, name'],
    ]);
    return json({ store: store[0], site: site[0], hero: hero[0], payments, zones });
  });

  // Salva as configurações da loja. Se o painel mandar `expected_updated_at` (a versão que ele tinha na tela), a gravação só vale se
  // ninguém mudou as configurações nesse meio-tempo: assim uma tela antiga (aba esquecida, outro administrador) não desfaz horários,
  // pausa de pedidos ou taxas que mudaram depois. Conferência e gravação são um único comando no banco.
  r.patch('/api/admin/store', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    const { values, cast } = parse(storeSpec, body, { partial: true });
    const expectedRaw = typeof body.expected_updated_at === 'string' ? new Date(body.expected_updated_at) : null;
    const expected = expectedRaw && !Number.isNaN(expectedRaw.getTime()) ? expectedRaw.toISOString() : null;
    const before = await one<Row>('select * from store_settings where id = 1');
    const keys = Object.keys(values);
    let store: Row | null;
    if (!keys.length) store = before;
    else {
      const sets = keys.map((key, i) => `${key} = $${i + 1}${cast[key] ? `::${cast[key]}` : ''}`).join(', ');
      const params: unknown[] = [...keys.map((key) => values[key]), expected];
      // Diferença de até 2 ms é a mesma versão (o JavaScript guarda milissegundos; o banco, microssegundos).
      store = await one<Row>(
        `update store_settings set ${sets}
          where id = 1 and ($${keys.length + 1}::timestamptz is null or abs(extract(epoch from (updated_at - $${keys.length + 1}::timestamptz))) < 0.002)
          returning *`,
        params,
      );
      if (!store) {
        throw new HttpError(409, 'Estas configurações foram alteradas por outra pessoa (ou em outra aba) depois que você abriu a tela. Recarreguei os dados atuais: confira e salve de novo.', {
          code: 'stale_settings',
          store: await one('select * from store_settings where id = 1'),
        });
      }
    }
    const diff = changedFields(before, values, STORE_LABELS);
    if (diff) await audit(ctx, { action: 'store.update', summary: `Configurações da loja: ${diff.text}`, entity: 'store', details: diff.details });
    return json({ store });
  });

  r.patch('/api/admin/site', 'admin', async (ctx) => {
    const { values } = parse(siteSpec, await readJson(ctx.req, 16 * 1024), { partial: true });
    checkHighlights(values, [
      ['bebidas_title', 'bebidas_highlight', 'Bebidas'],
      ['contato_title', 'contato_highlight', 'Contato'],
      ['cta_title', 'cta_highlight', 'Chamada final'],
    ]);
    const before = await one<Row>('select * from site_settings where id = 1');
    const site = await updateRow('site_settings', { column: 'id', value: 1 }, values);
    if (before) await releaseImages([before.logo_url, before.og_image_url, before.favicon_url]);
    const diff = changedFields(before, values, SITE_LABELS);
    if (diff) await audit(ctx, { action: 'site.update', summary: `Textos e SEO do site: ${diff.text}`, entity: 'site', details: diff.details });
    return json({ site });
  });

  r.patch('/api/admin/hero', 'admin', async (ctx) => {
    const { values, cast } = parse(heroSpec, await readJson(ctx.req, 16 * 1024), { partial: true });
    checkHighlights(values, [['title', 'title_highlight', 'Hero']]);
    const before = await one<Row>('select * from hero_settings where id = 1');
    const hero = await updateRow('hero_settings', { column: 'id', value: 1 }, values, cast);
    if (before) await releaseImages(before.images as string[]);
    const diff = changedFields(before, values, HERO_LABELS);
    if (diff) await audit(ctx, { action: 'hero.update', summary: `Hero do site: ${diff.text}`, entity: 'hero', details: diff.details });
    return json({ hero });
  });

  // ---- Pagamento ---------------------------------------------------------------------------------

  r.patch('/api/admin/payments/:code', 'admin', async (ctx) => {
    const code = ctx.params.code;
    const { values } = parse(paymentSpec, await readJson(ctx.req, 4 * 1024), { partial: true });
    // Pix online (o cliente paga pelo site): só o owner liga ou desliga, não tem chave PIX, e só liga com operadora configurada e conta
    // aprovada (sem isso o cliente escolheria uma forma de pagamento que não consegue concluir).
    if (code === 'pix_online') {
      if (ctx.admin!.role !== 'owner') throw new HttpError(403, 'Só o owner pode ligar ou desligar o pagamento online.');
      if (values.details !== undefined && values.details !== null) throw new HttpError(400, 'O pagamento online não usa chave PIX.');
      if (values.enabled === true) {
        const ready = await onlineReadiness();
        if (!ready.ready) {
          throw new HttpError(409, 'Para ligar o pagamento online é preciso ter uma conta aprovada na operadora de pagamento. Veja o status em Pagamentos online.', {
            code: 'payments_not_ready',
            provider: ready.provider,
            merchant: ready.merchant,
          });
        }
      }
    }
    if (values.enabled === false) {
      const others = await one<{ n: number }>('select count(*) as n from payment_methods where enabled and code <> $1', [code]);
      if (!others?.n) throw new HttpError(400, 'Mantenha pelo menos uma forma de pagamento ativa.');
    }
    const before = await one<Row>('select * from payment_methods where code = $1', [code]);
    const payment = await updateRow('payment_methods', { column: 'code', value: code }, values);
    if (!payment) throw new HttpError(404, 'Forma de pagamento não encontrada.');
    const diff = changedFields(before, values, { enabled: { label: 'ativa', format: 'bool' }, details: { label: 'chave PIX', format: 'changed' } });
    if (diff) await audit(ctx, { action: 'payment.update', summary: `Pagamento ${before?.label ?? code}: ${diff.text}`, entity: 'payment', entityId: code });
    return json({ payment });
  });

  // ---- Taxa de entrega por bairro -----------------------------------------------------------------

  r.get('/api/admin/zones', 'admin', async () => json({ zones: await query('select * from delivery_zones order by position, name') }));

  r.post('/api/admin/zones', 'admin', async (ctx) => {
    const { values } = parse(zoneSpec, await readJson(ctx.req, 4 * 1024));
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from delivery_zones'))?.n ?? 0;
    }
    const zone = await insertRow<{ id: string }>('delivery_zones', values);
    await audit(ctx, { action: 'zone.create', summary: `Cadastrou o bairro ${values.name} com taxa de R$ ${Number(values.fee).toFixed(2).replace('.', ',')}`, entity: 'zone', entityId: zone?.id });
    return json({ zone }, 201);
  });

  r.patch('/api/admin/zones/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(zoneSpec, await readJson(ctx.req, 4 * 1024), { partial: true });
    const before = await one<Row>('select * from delivery_zones where id = $1', [id]);
    const zone = await updateRow('delivery_zones', { column: 'id', value: id }, values);
    if (!zone) throw new HttpError(404, 'Bairro não encontrado.');
    const diff = changedFields(before, values, { name: { label: 'nome' }, fee: { label: 'taxa', format: 'money' }, active: { label: 'ativo', format: 'bool' }, position: { label: 'ordem' } });
    if (diff) await audit(ctx, { action: 'zone.update', summary: `Bairro ${before?.name}: ${diff.text}`, entity: 'zone', entityId: id, details: diff.details });
    return json({ zone });
  });

  r.delete('/api/admin/zones/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ name: string }>('delete from delivery_zones where id = $1 returning name', [id]);
    if (!removed) throw new HttpError(404, 'Bairro não encontrado.');
    await audit(ctx, { action: 'zone.delete', summary: `Removeu o bairro ${removed.name}`, entity: 'zone', entityId: id });
    return json({ ok: true });
  });

  // ---- Banners ---------------------------------------------------------------------------------------

  r.get('/api/admin/banners', 'admin', async () => json({ banners: await query('select * from banners order by position, created_at') }));

  // Cada lugar (capa e cardápio) tem a sua própria ordem.
  const nextBannerPosition = async (placement: unknown) =>
    (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from banners where placement = $1', [placement ?? 'menu']))?.n ?? 0;

  r.post('/api/admin/banners', 'admin', async (ctx) => {
    const { values } = parse(bannerSpec, await readJson(ctx.req, 8 * 1024));
    if (values.position === undefined) values.position = await nextBannerPosition(values.placement);
    const banner = await insertRow<{ id: string }>('banners', values);
    await audit(ctx, { action: 'banner.create', summary: `Criou um banner (${values.placement === 'cover' ? 'capa' : 'cardápio'})${values.title ? ` “${values.title}”` : ''}`, entity: 'banner', entityId: banner?.id });
    return json({ banner }, 201);
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
    await audit(ctx, { action: 'banner.reorder', summary: 'Mudou a ordem dos banners', entity: 'banner' });
    return json({ ok: true });
  });

  r.patch('/api/admin/banners/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(bannerSpec, await readJson(ctx.req, 8 * 1024), { partial: true });
    const before = await one<{ placement: string; image_desktop_url: string | null; image_mobile_url: string | null }>(
      'select placement, image_desktop_url, image_mobile_url from banners where id = $1',
      [id],
    );
    if (!before) throw new HttpError(404, 'Banner não encontrado.');
    // Mudou de lugar sem dizer a ordem: vai para o fim da fila do lugar novo.
    if (values.placement !== undefined && values.placement !== before.placement && values.position === undefined) {
      values.position = await nextBannerPosition(values.placement);
    }
    const banner = await updateRow('banners', { column: 'id', value: id }, values);
    await releaseImages([before.image_desktop_url, before.image_mobile_url]);
    const diff = changedFields(before, values, {
      placement: { label: 'lugar' },
      title: { label: 'título' },
      subtitle: { label: 'subtítulo', format: 'changed' },
      image_desktop_url: { label: 'imagem desktop', format: 'changed' },
      image_mobile_url: { label: 'imagem celular', format: 'changed' },
      button_text: { label: 'botão' },
      link: { label: 'link' },
      active: { label: 'ativo', format: 'bool' },
      position: { label: 'ordem' },
    });
    if (diff) await audit(ctx, { action: 'banner.update', summary: `Banner: ${diff.text}`, entity: 'banner', entityId: id, details: diff.details });
    return json({ banner });
  });

  r.delete('/api/admin/banners/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ image_desktop_url: string | null; image_mobile_url: string | null; title: string | null }>(
      'delete from banners where id = $1 returning image_desktop_url, image_mobile_url, title',
      [id],
    );
    if (!removed) throw new HttpError(404, 'Banner não encontrado.');
    await releaseImages([removed.image_desktop_url, removed.image_mobile_url]);
    await audit(ctx, { action: 'banner.delete', summary: `Excluiu um banner${removed.title ? ` “${removed.title}”` : ''}`, entity: 'banner', entityId: id });
    return json({ ok: true });
  });
}
