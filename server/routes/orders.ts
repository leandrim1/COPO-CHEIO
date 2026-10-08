// Painel: pedidos, status, dashboard e o "ao vivo" (polling) que avisa de pedido novo.
import { batch, one } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';

const STATUSES = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'] as const;
const PAYMENT_STATUSES = ['pending', 'paid', 'refunded'] as const;

export function registerOrders(r: Router) {
  r.get('/api/admin/dashboard', 'admin', async (ctx) => {
    const days = Number(ctx.url.searchParams.get('days') ?? 7);
    const [dash, recent] = await batch([
      ['select admin_dashboard($1) as dashboard', [days]],
      ['select * from orders order by created_at desc limit 8'],
    ]);
    return json({ ...dash[0].dashboard, recent });
  });

  // Lista com filtro de status, busca (número, nome ou telefone) e contagem por status.
  r.get('/api/admin/orders', 'admin', async (ctx) => {
    const q = ctx.url.searchParams;
    const status = q.get('status') ?? 'all';
    if (status !== 'all' && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, 'Status inválido.');
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 30) || 30, 1), 100);
    const term = (q.get('q') ?? '').trim().slice(0, 80);

    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') {
      params.push(status);
      where.push(`order_status = $${params.length}`);
    }
    if (term) {
      const digits = term.replace(/\D/g, '');
      const numeric = /^#?\d+$/.test(term);
      const parts: string[] = [];
      if (numeric && digits.length <= 12) {
        params.push(digits);
        parts.push(`order_number = $${params.length}::bigint`);
      }
      if (digits.length >= 3) {
        params.push(`%${digits}%`);
        parts.push(`customer_phone like $${params.length}`);
      }
      if (!numeric) {
        params.push(`%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        parts.push(`customer_name ilike $${params.length}`);
      }
      where.push(parts.length ? `(${parts.join(' or ')})` : 'false');
    }
    params.push(limit + 1);
    const [rows, counts] = await batch([
      [`select * from orders ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit $${params.length}`, params],
      ['select order_status, count(*) as n from orders group by order_status'],
    ]);
    const byStatus: Record<string, number> = {};
    for (const row of counts) byStatus[row.order_status] = row.n;
    return json({ orders: rows.slice(0, limit), has_more: rows.length > limit, counts: byStatus });
  });

  r.get('/api/admin/orders/:number', 'admin', async (ctx) => {
    const number = ctx.params.number;
    if (!/^\d{1,12}$/.test(number)) throw new HttpError(404, 'Pedido não encontrado.');
    const order = await one('select * from orders where order_number = $1::bigint', [number]);
    if (!order) throw new HttpError(404, 'Pedido não encontrado.');
    const [items, history] = await batch([
      ['select * from order_items where order_id = $1 order by created_at, product_name', [order.id]],
      ['select * from order_status_history where order_id = $1 order by created_at', [order.id]],
    ]);
    return json({ order, items, history });
  });

  // Muda o status e/ou o pagamento. Itens e valores do pedido nunca mudam por aqui.
  r.patch('/api/admin/orders/:id', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 4 * 1024);
    let order = null;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !STATUSES.includes(body.status as (typeof STATUSES)[number])) throw new HttpError(400, 'Status inválido.');
      order = await one('select * from admin_set_order_status($1::uuid, $2, $3::uuid)', [id, body.status, ctx.admin!.id]);
    }
    if (body.payment_status !== undefined) {
      if (typeof body.payment_status !== 'string' || !PAYMENT_STATUSES.includes(body.payment_status as (typeof PAYMENT_STATUSES)[number])) {
        throw new HttpError(400, 'Status de pagamento inválido.');
      }
      order = await one('update orders set payment_status = $2 where id = $1 returning *', [id, body.payment_status]);
    }
    if (body.status === undefined && body.payment_status === undefined) throw new HttpError(400, 'Nada para atualizar.');
    if (!order) throw new HttpError(404, 'Pedido não encontrado.');
    return json({ order });
  });

  // Polling inteligente: o painel pergunta de poucos em poucos segundos (e só com a aba aberta) se há
  // pedido novo. Sem `after`, só devolve o ponto de partida; com `after`, devolve o que chegou depois.
  r.get('/api/admin/live', 'admin', async (ctx) => {
    const afterParam = ctx.url.searchParams.get('after');
    const after = afterParam !== null && /^\d{1,12}$/.test(afterParam) ? afterParam : null;
    const [fresh, summary] = await batch([
      [
        after === null
          ? 'select id, order_number, customer_name, total, created_at from orders where false'
          : `select id, order_number, customer_name, total, created_at from orders where order_number > $1::bigint order by order_number limit 20`,
        after === null ? [] : [after],
      ],
      [
        `select coalesce(max(order_number), 0) as latest,
                count(*) filter (where order_status = 'new') as pending,
                coalesce(extract(epoch from max(updated_at)), 0)::text as rev
           from orders`,
      ],
    ]);
    return json({ new_orders: fresh, latest: summary[0].latest, pending: summary[0].pending, rev: summary[0].rev });
  });
}

