// Rotas públicas: o que o site mostra e a criação de pedidos. Nada administrativo sai daqui.
import { attempts, recordAttempt } from '../auth.js';
import { batch, one, query } from '../db.js';
import { HttpError, UUID, json, readJson } from '../http.js';
import type { Router } from '../http.js';

export function registerPublic(r: Router) {
  // Produtos e categorias ativos, só com as colunas que o site mostra (estoque e SKU ficam de fora).
  r.get('/api/products', 'public', async () => {
    const [categories, products] = await batch([
      ['select id, name, position, active from categories where active order by position, name'],
      [
        `select p.id, p.category_id, p.name, p.description, p.price, p.promo_price, p.image_url, p.featured,
                (p.sold_out or (p.stock is not null and p.stock <= 0)) as sold_out, p.position
           from products p
           left join categories c on c.id = p.category_id
          where p.active and (p.category_id is null or c.active)
          order by p.position, p.name`,
      ],
    ]);
    return json({ categories, products });
  });

  // Textos, loja, entrega, pagamento e banners.
  r.get('/api/site', 'public', async () => {
    const [store, site, hero, banners, zones, payments] = await batch([
      ['select * from store_settings where id = 1'],
      ['select * from site_settings where id = 1'],
      ['select * from hero_settings where id = 1'],
      [
        `select id, title, subtitle, image_desktop_url, image_mobile_url, button_text, link, position, active
           from banners where active order by position, created_at`,
      ],
      ['select id, name, fee, position, active from delivery_zones where active order by position, name'],
      ['select code, label, details from payment_methods where enabled order by position'],
    ]);
    if (!store[0] || !site[0] || !hero[0]) {
      throw new HttpError(503, 'O banco ainda não tem o conteúdo inicial. Rode as migrations (npm run db:migrate).');
    }
    return json({ store: store[0], site: site[0], hero: hero[0], banners, zones, payments });
  });

  r.post('/api/orders', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024);
    // Preço, estoque, taxa e regras da loja são conferidos dentro do banco (create_order): o navegador
    // só diz o que o cliente escolheu.
    // Limite por IP: só pedidos que deram certo contam (erros de preenchimento não punem o cliente).
    if ((await attempts('order', ctx.ip, 600)) >= 20) {
      throw new HttpError(429, 'Muitos pedidos em pouco tempo. Aguarde alguns minutos ou fale com a loja pelo WhatsApp.');
    }
    const row = await one<{ order: unknown }>('select create_order($1::jsonb) as "order"', [JSON.stringify(body)]);
    await recordAttempt('order', ctx.ip);
    return json({ order: row?.order }, 201);
  });

  // O cliente acompanha o pedido pelo código secreto do link (/pedido/:token).
  r.get('/api/orders/:token', 'public', async (ctx) => {
    const token = ctx.params.token;
    if (!UUID.test(token)) throw new HttpError(404, 'Pedido não encontrado.');
    const rows = await query<{ order: unknown }>('select get_public_order($1::uuid) as "order"', [token]);
    if (!rows[0]?.order) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ order: rows[0].order });
  });
}
