// Avaliação do pedido pelo cliente e moderação pela loja.
//  • O cliente avalia um pedido ENTREGUE, uma vez (nota de 1 a 5 e comentário opcional), pelo link de acompanhamento ou pela conta. A avaliação nasce "aguardando":
//    só aparece no site depois que a loja publica. Não se guarda nome nem telefone nela; no site aparecem só a nota, o comentário e a data.
//  • Painel: a loja publica, esconde ou apaga (um comentário que tenha dado pessoal, por exemplo).
import { audit } from '../audit.js';
import { reserve } from '../auth.js';
import { requireCustomer } from '../customer.js';
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { NOT_FOUND, assertNotThrottled, hashToken, normalizeToken, recordMiss } from '../tracking.js';

const HEADERS = { 'x-robots-tag': 'noindex, nofollow' };
const STATUSES = ['pending', 'published', 'hidden'] as const;
const LABEL: Record<string, string> = { pending: 'aguardando', published: 'publicada', hidden: 'escondida' };

function parseRating(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^[1-5]$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpError(400, 'Escolha uma nota de 1 a 5.');
  return n;
}
function parseComment(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'O comentário precisa ser um texto.');
  if (value.length > 500) throw new HttpError(400, 'O comentário pode ter até 500 caracteres.');
  return value;
}

// Pelo código do link: código errado vale como "pedido não encontrado" e conta nas tentativas (como o resto do acompanhamento).
async function viaToken(ctx: Ctx): Promise<string> {
  const canonical = normalizeToken(ctx.params.token);
  await assertNotThrottled(ctx);
  if (!canonical) {
    await recordMiss(ctx);
    throw new HttpError(404, NOT_FOUND);
  }
  return hashToken(canonical);
}

export function registerReviews(r: Router) {
  // ---- Cliente ---------------------------------------------------------------------------------------------------

  r.get('/api/tracking/:token/review', 'public', async (ctx) => {
    const hash = await viaToken(ctx);
    const row = await one<{ result: Row | null }>('select review_of($1, null, null) as result', [hash]);
    if (!row?.result) {
      await recordMiss(ctx);
      throw new HttpError(404, NOT_FOUND);
    }
    return json(row.result, 200, HEADERS);
  });

  r.post('/api/tracking/:token/review', 'public', async (ctx) => {
    const hash = await viaToken(ctx);
    await reserve('order-review', ctx.ip, 600, 10, 'Muitas avaliações em pouco tempo. Aguarde alguns minutos.');
    const body = await readJson(ctx.req, 2048);
    const row = await one<{ result: Row | null }>('select review_submit($1, null, null, $2::integer, $3) as result', [hash, parseRating(body.rating), parseComment(body.comment)]);
    if (!row?.result) {
      await recordMiss(ctx);
      throw new HttpError(404, NOT_FOUND);
    }
    return json({ review: row.result }, row.result.already ? 200 : 201, HEADERS);
  });

  r.get('/api/account/orders/:number/review', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    if (!/^\d{1,12}$/.test(ctx.params.number)) throw new HttpError(404, 'Pedido não encontrado.');
    const row = await one<{ result: Row | null }>('select review_of(null, $1::bigint, $2::uuid) as result', [ctx.params.number, customer.id]);
    if (!row?.result) throw new HttpError(404, 'Pedido não encontrado.');
    return json(row.result);
  });

  r.post('/api/account/orders/:number/review', 'public', async (ctx) => {
    const customer = await requireCustomer(ctx);
    if (!/^\d{1,12}$/.test(ctx.params.number)) throw new HttpError(404, 'Pedido não encontrado.');
    await reserve('order-review', customer.id, 600, 10, 'Muitas avaliações em pouco tempo. Aguarde alguns minutos.');
    const body = await readJson(ctx.req, 2048);
    const row = await one<{ result: Row | null }>('select review_submit(null, $1::bigint, $2::uuid, $3::integer, $4) as result', [ctx.params.number, customer.id, parseRating(body.rating), parseComment(body.comment)]);
    if (!row?.result) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ review: row.result }, row.result.already ? 200 : 201);
  });

  // ---- Público: só as publicadas, sem nome nem telefone ----------------------------------------------------------------

  r.get('/api/reviews', 'public', async () => {
    const [summary, reviews] = await Promise.all([
      one<Row>("select count(*)::int as count, round(avg(rating)::numeric, 1)::float as average from order_reviews where status = 'published'"),
      query<Row>("select rating, comment, created_at from order_reviews where status = 'published' order by created_at desc limit 30"),
    ]);
    return json({ summary: { count: summary?.count ?? 0, average: summary?.average ?? null }, reviews }, 200, { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' });
  });

  // ---- Painel ----------------------------------------------------------------------------------------------------

  r.get('/api/admin/reviews', 'admin', async (ctx) => {
    const status = ctx.url.searchParams.get('status');
    if (status && !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, 'Situação inválida.');
    const rows = await query<Row>(
      `select v.id, v.rating, v.comment, v.status, v.created_at, v.moderated_at, o.order_number, o.customer_name
         from order_reviews v join orders o on o.id = v.order_id
        where ($1::text is null or v.status = $1)
        order by v.created_at desc limit 200`,
      [status || null],
    );
    const summary = await one<Row>(
      `select count(*)::int as total, count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'published')::int as published,
              round(avg(rating)::numeric, 1)::float as average from order_reviews`,
    );
    return json({ reviews: rows, summary });
  });

  r.patch('/api/admin/reviews/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 512);
    if (typeof body.status !== 'string' || !(STATUSES as readonly string[]).includes(body.status)) throw new HttpError(400, 'Situação inválida.');
    const row = await one<Row>(
      `update order_reviews v set status = $2, moderated_by = $3, moderated_at = now()
         from orders o where v.id = $1 and o.id = v.order_id returning v.id, v.rating, v.status, o.order_number`,
      [id, body.status, ctx.admin!.id],
    );
    if (!row) throw new HttpError(404, 'Avaliação não encontrada.');
    await audit(ctx, { action: 'review.moderate', summary: `Avaliação do pedido #${row.order_number}: ${LABEL[body.status]}`, entity: 'review', entityId: id, details: { status: body.status } });
    return json({ review: row });
  });

  r.delete('/api/admin/reviews/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const row = await one<Row>('delete from order_reviews v using orders o where v.id = $1 and o.id = v.order_id returning o.order_number', [id]);
    if (!row) throw new HttpError(404, 'Avaliação não encontrada.');
    await audit(ctx, { action: 'review.delete', summary: `Apagou a avaliação do pedido #${row.order_number}`, entity: 'review', entityId: id });
    return json({ ok: true });
  });
}
