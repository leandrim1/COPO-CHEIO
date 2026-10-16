// Painel: produtos, estoque e categorias.
import { audit, changedFields } from '../audit.js';
import type { FieldLabels } from '../audit.js';
import { releaseImages } from '../blob.js';
import { batch, insertRow, one, query, updateRow } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { bool, dateTime, imageUrl, int, money, parse, text, uuid } from '../validate.js';
import type { Spec } from '../validate.js';

const productSpec: Spec = {
  category_id: uuid('Categoria', { nullable: true }),
  name: text('Nome', { min: 1, max: 80, required: true }),
  description: text('Descrição', { max: 300, nullable: true }),
  price: money('Preço', { required: true, positive: true }),
  promo_price: money('Preço promocional', { nullable: true, positive: true }),
  promo_starts_at: dateTime('Início da promoção', { nullable: true }),
  promo_ends_at: dateTime('Fim da promoção', { nullable: true }),
  image_url: imageUrl('Imagem'),
  // Miniaturas da mesma foto (400 px e 720 px de largura; migration 0025). Sempre pertencem à foto atual: ver `keepThumbnailsInStep`.
  image_sm_url: imageUrl('Miniatura pequena'),
  image_md_url: imageUrl('Miniatura média'),
  sku: text('SKU', { max: 40, nullable: true }),
  stock: int('Estoque', { nullable: true }),
  featured: bool('Destaque'),
  active: bool('Ativo'),
  sold_out: bool('Esgotado'),
  // Combos: o energético que vem no produto (para a troca com diferença de preço). Vazio = o produto não aceita troca.
  swap_base_product_id: uuid('Energético que vem no combo', { nullable: true }),
  // Combos: o VALOR do energético que vem no combo, quando ele não é um produto do cardápio (a base da diferença de preço da troca).
  swap_base_price: money('Valor do energético que vem no combo', { nullable: true, positive: true }),
  // Quem pede este produto precisa escolher o gelo (normal ou de sabor). Cada produto liga a sua (a categoria não decide mais).
  ice_choice_required: bool('Escolha do gelo'),
  position: int('Ordem', { max: 100_000 }),
};

const categorySpec: Spec = {
  name: text('Nome', { min: 1, max: 40, required: true }),
  active: bool('Ativa'),
  position: int('Ordem', { max: 100_000 }),
};

// Linha da importação. Cada linha é validada sozinha: uma linha ruim aparece no relatório com o motivo e não derruba as outras.
const importSpec: Spec = {
  name: text('Nome', { min: 1, max: 80, required: true }),
  price: money('Preço', { required: true, positive: true }),
  promo_price: money('Preço promocional', { nullable: true, positive: true }),
  category: text('Categoria', { max: 40, nullable: true }),
  description: text('Descrição', { max: 300, nullable: true }),
  image: imageUrl('Imagem'),
  sku: text('SKU', { max: 40, nullable: true }),
  stock: int('Estoque', { nullable: true }),
  featured: bool('Destaque'),
  sold_out: bool('Esgotado'),
};

const PRODUCT_LABELS: FieldLabels = {
  name: { label: 'nome' },
  price: { label: 'preço', format: 'money' },
  promo_price: { label: 'preço promocional', format: 'money' },
  promo_starts_at: { label: 'início da promoção', format: 'date' },
  promo_ends_at: { label: 'fim da promoção', format: 'date' },
  category_id: { label: 'categoria', format: 'changed' },
  description: { label: 'descrição', format: 'changed' },
  image_url: { label: 'imagem', format: 'changed' },
  sku: { label: 'SKU' },
  stock: { label: 'estoque' },
  featured: { label: 'destaque', format: 'bool' },
  active: { label: 'ativo no site', format: 'bool' },
  sold_out: { label: 'esgotado', format: 'bool' },
  swap_base_product_id: { label: 'energético que vem no combo', format: 'changed' },
  swap_base_price: { label: 'valor do energético do combo', format: 'money' },
  ice_choice_required: { label: 'escolha do gelo obrigatória', format: 'bool' },
  position: { label: 'ordem' },
};

const CATEGORY_LABELS: FieldLabels = {
  name: { label: 'nome' },
  active: { label: 'ativa no site', format: 'bool' },
  position: { label: 'ordem' },
};

const brl = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

// Confere o preço promocional e a janela de datas com os valores FINAIS do produto (os que ficam depois de salvar), não só com o
// que veio na requisição: mexer só no preço normal para abaixo da promoção também é recusado, com a explicação certa.
function checkPromo(price: number, promo: number | null, starts: string | null, ends: string | null) {
  if (promo !== null && promo >= price) {
    throw new HttpError(400, `Preço promocional: precisa ser menor que o preço (${brl(promo)} não é menor que ${brl(price)}).`, { code: 'promo_not_lower' });
  }
  if (starts && ends && new Date(ends).getTime() <= new Date(starts).getTime()) {
    throw new HttpError(400, 'Promoção: o fim precisa ser depois do início.', { code: 'promo_window' });
  }
}

// Já existe outro produto com este nome nesta categoria? (o painel pergunta antes de cadastrar um repetido)
async function duplicateOf(name: string, categoryId: string | null, exceptId?: string): Promise<{ id: string; name: string } | null> {
  return one<{ id: string; name: string }>(
    `select id, name from products
      where lower(btrim(name)) = lower(btrim($1)) and category_id is not distinct from $2::uuid and ($3::uuid is null or id <> $3::uuid)
      limit 1`,
    [name, categoryId, exceptId ?? null],
  );
}

// O energético que vem no combo tem de ser outro produto, que exista (o banco também confere, mas aqui a mensagem sai em português).
async function checkSwapBase(baseId: unknown, productId?: string) {
  if (baseId === null || baseId === undefined) return;
  if (productId && baseId === productId) throw new HttpError(400, 'Energético que vem no combo: escolha outro produto, não o próprio combo.', { code: 'swap_base_self' });
  const found = await one<{ id: string }>('select id from products where id = $1', [baseId as string]);
  if (!found) throw new HttpError(400, 'Energético que vem no combo: produto não encontrado.', { code: 'swap_base_missing' });
}

// Energéticos que o cliente pode escolher na troca deste combo (lista opcional; sem lista vale qualquer energético de 2L).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWAP_OPTIONS_SQL = 'array(select o.option_id from product_swap_options o where o.product_id = p.id order by o.option_id) as swap_option_ids';

function swapOptionIds(body: Row, selfId?: string): string[] | undefined {
  if (!('swap_option_ids' in body)) return undefined;
  const raw = body.swap_option_ids;
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 60 || raw.some((v) => typeof v !== 'string' || !UUID.test(v))) {
    throw new HttpError(400, 'Energéticos da troca: lista inválida.', { code: 'swap_options_invalid' });
  }
  const ids = [...new Set(raw.map((v) => String(v).toLowerCase()))];
  if (selfId && ids.includes(selfId)) throw new HttpError(400, 'Energéticos da troca: o próprio combo não pode ser um deles.', { code: 'swap_options_self' });
  return ids;
}

async function checkSwapOptions(ids: string[]) {
  if (!ids.length) return;
  const found = await one<{ n: number }>('select count(*)::int as n from products where id = any($1::uuid[])', [ids]);
  if (found?.n !== ids.length) throw new HttpError(400, 'Energéticos da troca: algum produto não foi encontrado.', { code: 'swap_options_missing' });
}

// As miniaturas só valem para a foto de que foram feitas. Foto nova (ou removida) sem miniaturas novas na mesma requisição — um cliente
// antigo do painel, uma importação, a API — zera as duas, para o site nunca mostrar a miniatura da foto anterior. Sem foto, não há miniatura.
function keepThumbnailsInStep(values: Row, before?: Row) {
  const photoChanged = 'image_url' in values && (!before || values.image_url !== before.image_url);
  if (photoChanged) {
    if (!('image_sm_url' in values)) values.image_sm_url = null;
    if (!('image_md_url' in values)) values.image_md_url = null;
  }
  const finalPhoto = 'image_url' in values ? values.image_url : before?.image_url;
  if (!finalPhoto) {
    if ('image_sm_url' in values || before?.image_sm_url) values.image_sm_url = null;
    if ('image_md_url' in values || before?.image_md_url) values.image_md_url = null;
  }
}

const withOptions = (id: string) => one<Row>(`select p.*, ${SWAP_OPTIONS_SQL} from products p where p.id = $1`, [id]);

const duplicateError = (found: { id: string; name: string }) =>
  new HttpError(409, `Já existe um produto chamado “${found.name}” nesta categoria. Cadastre mesmo assim?`, { code: 'duplicate_product', existing_id: found.id });

export function registerCatalog(r: Router) {
  // ---- Produtos ------------------------------------------------------------------------------

  r.get('/api/admin/products', 'admin', async () => {
    const [products, categories, site] = await batch([
      [`select p.*, ${SWAP_OPTIONS_SQL} from products p order by p.name`],
      ['select * from categories order by position, name'],
      ['select featured_limit from site_settings where id = 1'],
    ]);
    return json({ products, categories, featured_limit: site[0]?.featured_limit ?? 4 });
  });

  r.get('/api/admin/products/:id', 'admin', async (ctx) => {
    const [products, categories] = await batch([
      [`select p.*, ${SWAP_OPTIONS_SQL} from products p where p.id = $1`, [uuidParam(ctx)]],
      ['select * from categories order by position, name'],
    ]);
    if (!products[0]) throw new HttpError(404, 'Produto não encontrado.');
    return json({ product: products[0], categories });
  });

  r.post('/api/admin/products', 'admin', async (ctx) => {
    const body = await readJson(ctx.req);
    const { values, cast } = parse(productSpec, body);
    // Sem preço promocional, as datas não têm o que controlar.
    if (values.promo_price === undefined || values.promo_price === null) {
      values.promo_starts_at = null;
      values.promo_ends_at = null;
    }
    checkPromo(values.price as number, (values.promo_price as number | null) ?? null, (values.promo_starts_at as string | null) ?? null, (values.promo_ends_at as string | null) ?? null);
    if (body.confirm_duplicate !== true) {
      const found = await duplicateOf(String(values.name), (values.category_id as string | null) ?? null);
      if (found) throw duplicateError(found);
    }
    keepThumbnailsInStep(values);
    await checkSwapBase(values.swap_base_product_id);
    const optionIds = swapOptionIds(body);
    await checkSwapOptions(optionIds ?? []);
    if (values.position === undefined) {
      values.position = (await one<{ n: number }>('select coalesce(max(position), -1) + 1 as n from products'))?.n ?? 0;
    }
    const created = await insertRow<{ id: string }>('products', values, cast);
    if (created && optionIds?.length) await query('insert into product_swap_options (product_id, option_id) select $1::uuid, unnest($2::uuid[])', [created.id, optionIds]);
    const product = created ? await withOptions(created.id) : created;
    await audit(ctx, { action: 'product.create', summary: `Cadastrou o produto “${values.name}” por ${brl(values.price as number)}`, entity: 'product', entityId: product?.id });
    return json({ product }, 201);
  });

  r.patch('/api/admin/products/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req);
    const { values, cast } = parse(productSpec, body, { partial: true });
    const before = await one<Row>('select * from products where id = $1', [id]);
    if (!before) throw new HttpError(404, 'Produto não encontrado.');
    if ('promo_price' in values && values.promo_price === null) {
      values.promo_starts_at = null;
      values.promo_ends_at = null;
    }
    // "Gerar miniaturas" manda de qual foto elas foram feitas: se a foto do produto mudou nesse meio tempo, as miniaturas não servem mais.
    if (typeof body.thumbnails_for === 'string' && body.thumbnails_for !== before.image_url) {
      throw new HttpError(409, 'A foto deste produto mudou enquanto as miniaturas eram geradas.', { code: 'photo_changed' });
    }
    keepThumbnailsInStep(values, before);
    await checkSwapBase(values.swap_base_product_id, id);
    const optionIds = swapOptionIds(body, id);
    await checkSwapOptions(optionIds ?? []);
    const final = { ...before, ...values } as Row;
    checkPromo(Number(final.price), final.promo_price === null ? null : Number(final.promo_price), final.promo_starts_at ?? null, final.promo_ends_at ?? null);
    const renamed = ('name' in values && values.name !== before.name) || ('category_id' in values && values.category_id !== before.category_id);
    if (renamed && body.confirm_duplicate !== true) {
      const found = await duplicateOf(String(final.name), (final.category_id as string | null) ?? null, id);
      if (found) throw duplicateError(found);
    }
    await updateRow('products', { column: 'id', value: id }, values, cast);
    // A lista de energéticos da troca é trocada inteira, junto (tudo ou nada).
    let optionsText = '';
    if (optionIds !== undefined) {
      const previous = (await one<{ ids: string[] }>('select array(select option_id from product_swap_options where product_id = $1) as ids', [id]))?.ids ?? [];
      const changed = previous.length !== optionIds.length || optionIds.some((x) => !previous.includes(x));
      if (changed) {
        await batch([
          ['delete from product_swap_options where product_id = $1::uuid', [id]],
          ['insert into product_swap_options (product_id, option_id) select $1::uuid, unnest($2::uuid[])', [id, optionIds]],
        ]);
        optionsText = `energéticos da troca: ${previous.length || 'todos de 2L'} → ${optionIds.length || 'todos de 2L'}`;
      }
    }
    const product = await withOptions(id);
    // O arquivo antigo (foto e miniaturas) só sai do Blob se nenhum produto o usa mais.
    if ('image_url' in values || 'image_sm_url' in values || 'image_md_url' in values) {
      await releaseImages([before.image_url as string | null, before.image_sm_url as string | null, before.image_md_url as string | null]);
    }
    const diff = changedFields(before, values, PRODUCT_LABELS);
    const summary = [diff?.text, optionsText].filter(Boolean).join('; ');
    if (summary) await audit(ctx, { action: 'product.update', summary: `Produto “${before.name}”: ${summary}`, entity: 'product', entityId: id, details: diff?.details });
    return json({ product });
  });

  r.delete('/api/admin/products/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ image_url: string | null; image_sm_url: string | null; image_md_url: string | null; name: string; price: number }>(
      'delete from products where id = $1 returning image_url, image_sm_url, image_md_url, name, price',
      [id],
    );
    if (!removed) throw new HttpError(404, 'Produto não encontrado.');
    await releaseImages([removed.image_url, removed.image_sm_url, removed.image_md_url]);
    await audit(ctx, { action: 'product.delete', summary: `Excluiu o produto “${removed.name}” (${brl(Number(removed.price))})`, entity: 'product', entityId: id });
    return json({ ok: true });
  });

  // A cópia nasce desativada (para revisar antes de aparecer no site) e compartilha a mesma imagem;
  // o arquivo só sai do Blob quando nenhum produto o usa mais.
  r.post('/api/admin/products/:id/duplicate', 'admin', async (ctx) => {
    const product = await one<{ id: string; name: string }>(
      `insert into products (category_id, name, description, price, promo_price, promo_starts_at, promo_ends_at, image_url, image_sm_url, image_md_url, stock, sold_out, featured, active, position, swap_base_product_id, swap_base_price, ice_choice_required)
       select category_id, left(name || ' (cópia)', 80), description, price, promo_price, promo_starts_at, promo_ends_at, image_url, image_sm_url, image_md_url, stock, sold_out, false, false, position + 1, swap_base_product_id, swap_base_price, ice_choice_required
         from products where id = $1
       returning *`,
      [uuidParam(ctx)],
    );
    if (!product) throw new HttpError(404, 'Produto não encontrado.');
    await query('insert into product_swap_options (product_id, option_id) select $1::uuid, option_id from product_swap_options where product_id = $2::uuid', [product.id, uuidParam(ctx)]);
    await audit(ctx, { action: 'product.duplicate', summary: `Duplicou um produto: criou “${product.name}” (desativado)`, entity: 'product', entityId: product.id });
    return json({ product }, 201);
  });

  // Estoque: + adicionar / − retirar. Chegou a 0 → ESGOTADO (trigger do banco). Produto sem controle de estoque só passa a ter
  // controle quando o painel pede de propósito (`enable_tracking`).
  r.post('/api/admin/products/:id/stock', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 4 * 1024);
    const { values } = parse({ delta: int('Quantidade', { min: -100_000, max: 100_000, required: true }) }, body);
    const enable = body.enable_tracking === true;
    const before = await one<{ name: string; stock: number | null }>('select name, stock from products where id = $1', [id]);
    await query('select adjust_stock_v2($1::uuid, $2::integer, $3::boolean)', [id, values.delta, enable]);
    const product = await one<{ name: string; stock: number | null }>('select * from products where id = $1', [id]);
    await audit(ctx, {
      action: 'product.stock',
      summary: `Estoque de “${before?.name ?? ''}”: ${before?.stock ?? 'sem controle'} → ${product?.stock ?? '—'}${enable ? ' (passou a controlar o estoque)' : ''}`,
      entity: 'product',
      entityId: id,
      details: { delta: values.delta, enable_tracking: enable },
    });
    return json({ product });
  });

  // Importa uma lista (formato do produtos.json antigo, ou planilha CSV já convertida pelo painel). Cria as categorias que faltam
  // e pula produtos que já existem (mesmo nome e categoria). Tudo ou nada no banco; o relatório diz o que aconteceu com CADA linha.
  r.post('/api/admin/products/import', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 1024 * 1024);
    if (!Array.isArray(body.rows) || body.rows.length === 0 || body.rows.length > 500) throw new HttpError(400, 'Envie de 1 a 500 produtos por vez.');

    type Status = 'created' | 'existing' | 'repeated' | 'invalid';
    const report: { index: number; name: string; status: Status; reason?: string }[] = [];
    const rows: Row[] = [];
    const seen = new Set<string>();
    const seenSku = new Set<string>();
    body.rows.forEach((raw: unknown, index: number) => {
      const name = typeof (raw as Row | null)?.name === 'string' ? String((raw as Row).name).trim().slice(0, 80) : '';
      try {
        const { values } = parse(importSpec, (raw ?? {}) as Row);
        if (values.promo_price !== undefined && values.promo_price !== null && Number(values.promo_price) >= Number(values.price)) {
          throw new HttpError(400, 'Preço promocional: precisa ser menor que o preço.');
        }
        const key = `${String(values.name).toLowerCase()}|${String(values.category ?? '').toLowerCase()}`;
        if (seen.has(key)) {
          report.push({ index, name: String(values.name), status: 'repeated', reason: 'Repetido no arquivo (mesmo nome e categoria): só a primeira linha vale.' });
          return;
        }
        const sku = values.sku ? String(values.sku).toLowerCase() : null;
        if (sku && seenSku.has(sku)) {
          report.push({ index, name: String(values.name), status: 'invalid', reason: 'SKU repetido no arquivo.' });
          return;
        }
        seen.add(key);
        if (sku) seenSku.add(sku);
        rows.push({ ord: index, ...values, featured: values.featured ?? false, sold_out: values.sold_out ?? false });
      } catch (error) {
        report.push({ index, name, status: 'invalid', reason: error instanceof HttpError ? error.message : 'Linha inválida.' });
      }
    });
    if (!rows.length) {
      throw new HttpError(400, 'Nenhum produto válido (todos precisam de nome e de preço maior que zero).', { report: report.sort((a, b) => a.index - b.index) });
    }

    // SKU que já pertence a outro produto: a linha é recusada (SKU é único), as outras seguem.
    const skus = rows.map((row) => (row.sku ? String(row.sku).toLowerCase() : null)).filter((sku): sku is string => sku !== null);
    const taken = new Set<string>();
    if (skus.length) {
      for (const found of await query<{ sku: string }>('select lower(sku) as sku from products where lower(sku) = any($1::text[])', [skus])) taken.add(found.sku);
    }
    const toInsert = rows.filter((row) => {
      if (row.sku && taken.has(String(row.sku).toLowerCase())) {
        report.push({ index: row.ord as number, name: String(row.name), status: 'invalid', reason: 'Já existe um produto com este SKU.' });
        return false;
      }
      return true;
    });

    let createdOrds: number[] = [];
    let categoriesCreated = 0;
    if (toInsert.length) {
      const result = await one<{ created_ords: number[]; categories_created: number }>(
        `with raw as (
           select x.ord, x.name, x.price, x.promo_price, x.category, x.description, x.image, x.featured, x.sold_out, x.stock, x.sku
             from jsonb_to_recordset($1::jsonb)
                  as x(ord int, name text, price numeric, promo_price numeric, category text, description text, image text, featured boolean, sold_out boolean, stock int, sku text)
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
         first_pos as (select coalesce(max(position), -1) + 1 as n from products),
         fresh as (
           select d.*, cat.id as category_id, row_number() over (order by d.ord) as rn
             from dedup d
             left join cats cat on d.category is not null and lower(btrim(cat.name)) = lower(d.category)
            where not exists (
              select 1 from products p where lower(btrim(p.name)) = lower(d.name) and p.category_id is not distinct from cat.id
            )
         ),
         new_products as (
           insert into products (category_id, name, description, price, promo_price, image_url, featured, sold_out, stock, sku, position)
           select f.category_id, f.name, f.description, f.price, f.promo_price, f.image, f.featured, f.sold_out, f.stock, f.sku, (select n from first_pos) + f.rn - 1
             from fresh f
           returning position
         )
         select coalesce((select array_agg(f.ord order by f.ord) from fresh f where exists (select 1 from new_products np where np.position = (select n from first_pos) + f.rn - 1)), '{}') as created_ords,
                (select count(*) from new_cats) as categories_created`,
        [JSON.stringify(toInsert)],
      );
      createdOrds = result?.created_ords ?? [];
      categoriesCreated = Number(result?.categories_created ?? 0);
    }
    const created = new Set(createdOrds);
    for (const row of toInsert) {
      const index = row.ord as number;
      report.push(created.has(index) ? { index, name: String(row.name), status: 'created' } : { index, name: String(row.name), status: 'existing', reason: 'Já existe um produto com este nome nesta categoria: foi mantido como estava.' });
    }
    report.sort((a, b) => a.index - b.index);
    const count = (status: Status) => report.filter((item) => item.status === status).length;
    await audit(ctx, {
      action: 'product.import',
      summary: `Importou produtos: ${count('created')} criado(s), ${count('existing')} já existiam, ${count('repeated')} repetidos no arquivo, ${count('invalid')} com problema`,
      entity: 'product',
      details: { created: count('created'), existing: count('existing'), repeated: count('repeated'), invalid: count('invalid'), categories_created: categoriesCreated },
    });
    return json({
      created: count('created'),
      categories_created: categoriesCreated,
      existing: count('existing'),
      repeated: count('repeated'),
      skipped: count('invalid'),
      report,
    });
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
    const category = await insertRow<{ id: string }>('categories', values);
    await audit(ctx, { action: 'category.create', summary: `Criou a categoria “${values.name}”`, entity: 'category', entityId: category?.id });
    return json({ category }, 201);
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
    await audit(ctx, { action: 'category.reorder', summary: 'Mudou a ordem das categorias', entity: 'category' });
    return json({ ok: true });
  });

  r.patch('/api/admin/categories/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const { values } = parse(categorySpec, await readJson(ctx.req, 8 * 1024), { partial: true });
    const before = await one<Row>('select * from categories where id = $1', [id]);
    if (!before) throw new HttpError(404, 'Categoria não encontrada.');
    const category = await updateRow('categories', { column: 'id', value: id }, values);
    if (!category) throw new HttpError(404, 'Categoria não encontrada.');
    const diff = changedFields(before, values, CATEGORY_LABELS);
    if (diff) await audit(ctx, { action: 'category.update', summary: `Categoria “${before.name}”: ${diff.text}`, entity: 'category', entityId: id, details: diff.details });
    return json({ category });
  });

  // Os produtos da categoria excluída continuam existindo, sem categoria.
  r.delete('/api/admin/categories/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ name: string }>('delete from categories where id = $1 returning name', [id]);
    if (!removed) throw new HttpError(404, 'Categoria não encontrada.');
    await audit(ctx, { action: 'category.delete', summary: `Excluiu a categoria “${removed.name}”`, entity: 'category', entityId: id });
    return json({ ok: true });
  });
}
