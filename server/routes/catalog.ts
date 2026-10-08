// Painel: produtos, estoque e categorias.
import { releaseImages } from '../blob.js';
import { batch, insertRow, one, query, updateRow } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { bool, imageUrl, int, money, parse, text, uuid } from '../validate.js';
import type { Spec } from '../validate.js';

const productSpec: Spec = {
  category_id: uuid('Categoria', { nullable: true }),
  name: text('Nome', { min: 1, max: 80, required: true }),
  description: text('Descrição', { max: 300, nullable: true }),
  price: money('Preço', { required: true }),
  promo_price: money('Preço promocional', { nullable: true }),
  image_url: imageUrl('Imagem'),
  sku: text('SKU', { max: 40, nullable: true }),
  stock: int('Estoque', { nullable: true }),
  featured: bool('Destaque'),
  active: bool('Ativo'),
  sold_out: bool('Esgotado'),
  position: int('Ordem', { max: 100_000 }),
};

const categorySpec: Spec = {
  name: text('Nome', { min: 1, max: 40, required: true }),
  active: bool('Ativa'),
  position: int('Ordem', { max: 100_000 }),
};

const importSpec: Spec = {
  name: text('Nome', { min: 1, max: 80, required: true }),
  price: money('Preço', { required: true }),
  category: text('Categoria', { max: 40, nullable: true }),
  description: text('Descrição', { max: 300, nullable: true }),
  image: imageUrl('Imagem'),
  featured: bool('Destaque'),
  sold_out: bool('Esgotado'),
};

function checkPromo(price: unknown, promo: unknown) {
  if (typeof price === 'number' && typeof promo === 'number' && promo >= price) {
    throw new HttpError(400, 'Preço promocional: precisa ser menor que o preço.');
  }
}

export function registerCatalog(r: Router) {
  // ---- Produtos ------------------------------------------------------------------------------

  r.get('/api/admin/products', 'admin', async () => {
    const [products, categories, site] = await batch([
      ['select * from products order by name'],
      ['select * from categories order by position, name'],
      ['select featured_limit from site_settings where id = 1'],
    ]);
    return json({ products, categories, featured_limit: site[0]?.featured_limit ?? 4 });
  });

  r.get('/api/admin/products/:id', 'admin', async (ctx) => {
    const [products, categories] = await batch([
      ['select * from products where id = $1', [uuidParam(ctx)]],
      ['select * from categories order by position, name'],
    ]);
    if (!products[0]) throw new HttpError(404, 'Produto não encontrado.');
    return json({ product: products[0], categories });
  });

  r.post('/api/admin/products', 'admin', async (ctx) => {
    const { values, cast } = parse(productSpec, await readJson(ctx.req));
    checkPromo(values.price, values.promo_price);
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from products'))?.n ?? 0;
    }
    return json({ product: await insertRow('products', values, cast) }, 201);
  });

  r.patch('/api/admin/products/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values, cast } = parse(productSpec, await readJson(ctx.req), { partial: true });
    checkPromo(values.price, values.promo_price);
    const before = await one<{ image_url: string | null }>('select image_url from products where id = $1', [id]);
    if (!before) throw new HttpError(404, 'Produto não encontrado.');
    const product = await updateRow('products', { column: 'id', value: id }, values, cast);
    if ('image_url' in values) await releaseImages([before.image_url]);
    return json({ product });
  });

  r.delete('/api/admin/products/:id', 'admin', async (ctx) => {
    const removed = await one<{ image_url: string | null }>('delete from products where id = $1 returning image_url', [uuidParam(ctx)]);
    if (!removed) throw new HttpError(404, 'Produto não encontrado.');
    await releaseImages([removed.image_url]);
    return json({ ok: true });
  });

  // A cópia nasce desativada (para revisar antes de aparecer no site) e compartilha a mesma imagem;
  // o arquivo só sai do Blob quando nenhum produto o usa mais.
  r.post('/api/admin/products/:id/duplicate', 'admin', async (ctx) => {
    const product = await one(
      `insert into products (category_id, name, description, price, promo_price, image_url, stock, sold_out, featured, active, position)
       select category_id, left(name || ' (cópia)', 80), description, price, promo_price, image_url, stock, sold_out, false, false, position + 1
         from products where id = $1
       returning *`,
      [uuidParam(ctx)],
    );
    if (!product) throw new HttpError(404, 'Produto não encontrado.');
    return json({ product }, 201);
  });

  // Estoque: + adicionar / − retirar. Chegou a 0 → ESGOTADO (trigger do banco).
  r.post('/api/admin/products/:id/stock', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse({ delta: int('Quantidade', { min: -100_000, max: 100_000, required: true }) }, await readJson(ctx.req, 4 * 1024));
    await query('select adjust_stock($1::uuid, $2::integer)', [id, values.delta]);
    return json({ product: await one('select * from products where id = $1', [id]) });
  });

  // Importa uma lista (formato do produtos.json antigo, já normalizado pelo painel). Cria as categorias
  // que faltam e pula produtos que já existem (mesmo nome e categoria). Tudo ou nada.
  r.post('/api/admin/products/import', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 1024 * 1024);
    if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 500) throw new HttpError(400, 'Envie de 1 a 500 produtos por vez.');
    const rows: Record<string, unknown>[] = [];
    let skipped = 0;
    body.rows.forEach((raw: unknown, ord: number) => {
      try {
        const { values } = parse(importSpec, (raw ?? {}) as Record<string, unknown>);
        rows.push({ ord, ...values, featured: values.featured ?? false, sold_out: values.sold_out ?? false });
      } catch {
        skipped += 1;
      }
    });
    if (!rows.length) throw new HttpError(400, 'Nenhum produto válido (todos precisam de nome e preço).');

    const result = await one<{ created: number; categories_created: number; total: number }>(
      `with raw as (
         select x.ord, x.name, x.price, x.category, x.description, x.image, x.featured, x.sold_out
           from jsonb_to_recordset($1::jsonb)
                as x(ord int, name text, price numeric, category text, description text, image text, featured boolean, sold_out boolean)
       ),
       dedup as (
         select distinct on (lower(name), lower(coalesce(category, ''))) *
           from raw
          order by lower(name), lower(coalesce(category, '')), ord
       ),
       base as (select coalesce(max(position), -1) as n from categories),
       new_cats as (
         insert into categories (name, position)
         select c.category, (select n from base) + row_number() over (order by c.first_ord)
           from (
             select min(d.category) as category, min(d.ord) as first_ord
               from dedup d
              where d.category is not null
                and not exists (select 1 from categories e where lower(btrim(e.name)) = lower(d.category))
              group by lower(d.category)
           ) c
         returning id, name
       ),
       cats as (select id, name from categories union all select id, name from new_cats),
       new_products as (
         insert into products (category_id, name, description, price, image_url, featured, sold_out, position)
         select cat.id, d.name, d.description, d.price, d.image, d.featured, d.sold_out, d.ord
           from dedup d
           left join cats cat on d.category is not null and lower(btrim(cat.name)) = lower(d.category)
          where not exists (
            select 1 from products p where lower(btrim(p.name)) = lower(d.name) and p.category_id is not distinct from cat.id
          )
         returning id
       )
       select (select count(*) from new_products) as created,
              (select count(*) from new_cats) as categories_created,
              (select count(*) from dedup) as total`,
      [JSON.stringify(rows)],
    );
    const created = result?.created ?? 0;
    return json({ created, categories_created: result?.categories_created ?? 0, existing: (result?.total ?? 0) - created, skipped });
  });

  // ---- Categorias ------------------------------------------------------------------------------

  r.get('/api/admin/categories', 'admin', async () => {
    const categories = await query(
      `select c.*, (select count(*) from products p where p.category_id = c.id) as product_count
         from categories c order by c.position, c.name`,
    );
    return json({ categories });
  });

  r.post('/api/admin/categories', 'admin', async (ctx) => {
    const { values } = parse(categorySpec, await readJson(ctx.req, 8 * 1024));
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from categories'))?.n ?? 0;
    }
    return json({ category: await insertRow('categories', values) }, 201);
  });

  // Define a ordem de todas as categorias de uma vez: { ids: [...] } na ordem desejada.
  r.put('/api/admin/categories/order', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    if (!Array.isArray(body.ids) || body.ids.length > 500) throw new HttpError(400, 'Lista inválida.');
    const ids = body.ids.map((id: unknown) => uuid('Categoria', { required: true }).parse(id));
    await query(
      `update categories c set position = o.ord - 1
         from unnest($1::uuid[]) with ordinality as o(id, ord)
        where c.id = o.id`,
      [ids],
    );
    return json({ ok: true });
  });

  r.patch('/api/admin/categories/:id', 'admin', async (ctx) => {
    const { values } = parse(categorySpec, await readJson(ctx.req, 8 * 1024), { partial: true });
    const category = await updateRow('categories', { column: 'id', value: uuidParam(ctx) }, values);
    if (!category) throw new HttpError(404, 'Categoria não encontrada.');
    return json({ category });
  });

  // Os produtos da categoria excluída continuam existindo, sem categoria.
  r.delete('/api/admin/categories/:id', 'admin', async (ctx) => {
    const removed = await one('delete from categories where id = $1 returning id', [uuidParam(ctx)]);
    if (!removed) throw new HttpError(404, 'Categoria não encontrada.');
    return json({ ok: true });
  });
}
