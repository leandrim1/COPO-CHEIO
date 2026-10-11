// Painel: pedidos, status, dashboard e o "ao vivo" (polling) que avisa de pedido novo.
import { audit } from '../audit.js';
import { batch, one } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { hashToken, newTrackingToken } from '../tracking.js';

const STATUSES = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'] as const;
const PAYMENT_STATUSES = ['pending', 'paid', 'refunded'] as const;

export function registerOrders(r: Router) {
  r.get('/api/admin/dashboard', 'admin', async (ctx) => {
    // Valor que não é um número inteiro (days=abc) cai nos 7 dias padrão; o banco ainda aceita só 1, 7 ou 30.
    const asked = Number(ctx.url.searchParams.get('days') ?? 7);
    const days = Number.isInteger(asked) ? asked : 7;
    const [dash, recent, privacy] = await batch([
      ['select admin_dashboard($1) as dashboard', [days]],
      ['select * from orders order by created_at desc limit 8'],
      ["select count(*) as n from privacy_requests where status = 'open'"],
    ]);
    return json({ ...dash[0].dashboard, recent, privacy_open: privacy[0]?.n ?? 0 });
  });

  // Lista com filtro de status, busca (número, nome ou telefone) e contagem por status.
  r.get('/api/admin/orders', 'admin', async (ctx) => {
    const q = ctx.url.searchParams;
    const status = q.get('status') ?? 'all';
    if (status !== 'all' && !STATUSES.includes(status as (typeof STATUSES)[number])) throw new HttpError(400, 'Status inválido.');
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 30) || 30, 1), 100);
    const term = (q.get('q') ?? '').trim().slice(0, 80);
    const account = q.get('account') ?? 'all';
    if (!['all', 'account', 'guest'].includes(account)) throw new HttpError(400, 'Filtro de cliente inválido.');

    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') {
      params.push(status);
      where.push(`order_status = $${params.length}`);
    }
    if (account === 'account') where.push('customer_id is not null');
    if (account === 'guest') where.push('customer_id is null');
    // Datas (AAAA-MM-DD) no fuso da loja: do começo do dia inicial ao fim do dia final.
    for (const [key, op] of [['from', '>= ($N::date)::timestamp at time zone'], ['to', '< ($N::date + 1)::timestamp at time zone']] as const) {
      const value = q.get(key);
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, 'Data inválida.');
      params.push(value);
      where.push(`created_at ${op.replace('$N', `$${params.length}`)} (select timezone from store_settings where id = 1)`);
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
        parts.push(`customer_email ilike $${params.length}`);
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
    const [items, history, links, accounts] = await batch([
      ['select * from order_items where order_id = $1 order by created_at, product_name, ice_choice nulls first', [order.id]],
      ['select * from order_status_history where order_id = $1 order by created_at', [order.id]],
      // Só metadados: o código em si não existe no banco (guardamos o hash).
      [
        `select t.id, t.source, t.created_at, t.revoked_at, a.name as created_by_name
           from order_tracking_tokens t left join admins a on a.id = t.created_by
          where t.order_id = $1 order by t.created_at`,
        [order.id],
      ],
      ['select id, name, email, phone, status from customers where id = $1', [order.customer_id]],
    ]);
    const retention = await one<{ days: number }>('select tracking_retention_days as days from store_settings where id = 1');
    return json({ order, items, history, tracking_links: links, account: accounts[0] ?? null, retention_days: retention?.days ?? 180 });
  });

  // Gera um link novo de acompanhamento para mandar ao cliente. O código só aparece nesta resposta (no banco
  // fica o hash). Sem `replace`, os links que o cliente já tem continuam valendo; com `replace`, os anteriores
  // são invalidados (use se o link vazou ou foi parar na mão errada).
  r.post('/api/admin/orders/:id/tracking-link', 'admin', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 1024);
    const replace = body.replace === true;
    const token = newTrackingToken();
    const [, revoked, created] = await batch([
      ['select 1 from orders where id = $1 for update', [id]],
      [replace ? 'update order_tracking_tokens set revoked_at = now() where order_id = $1 and revoked_at is null returning id' : 'select id from order_tracking_tokens where false and order_id = $1', [id]],
      [
        `insert into order_tracking_tokens (order_id, token_hash, source, created_by)
         select o.id, $2, 'admin', $3 from orders o
          where o.id = $1 and (select count(*) from order_tracking_tokens t where t.order_id = o.id and t.revoked_at is null) < 20
         returning id`,
        [id, hashToken(token), ctx.admin!.id],
      ],
    ]);
    if (!created.length) {
      const exists = await one('select 1 as ok from orders where id = $1', [id]);
      if (!exists) throw new HttpError(404, 'Pedido não encontrado.');
      throw new HttpError(409, 'Este pedido já tem muitos links ativos. Use "Trocar link" para invalidar os anteriores.');
    }
    const numbered = await one<{ order_number: number }>('select order_number from orders where id = $1', [id]);
    await audit(ctx, {
      action: 'order.tracking_link',
      summary: `Gerou um link de acompanhamento do pedido #${numbered?.order_number ?? ''}${replace ? ' e invalidou os anteriores' : ''}`,
      entity: 'order',
      entityId: id,
    });
    return json({ token, replaced: revoked.length }, 201);
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
      // As regras (cancelado não vira "pago"; só se reembolsa o que estava pago) ficam no banco.
      order = await one<{ order_number: number; payment_status: string }>('select * from admin_set_payment_status($1::uuid, $2, $3::uuid)', [id, body.payment_status, ctx.admin!.id]);
      if (order) {
        const label = { pending: 'pendente', paid: 'pago', refunded: 'reembolsado' }[body.payment_status as 'pending' | 'paid' | 'refunded'];
        await audit(ctx, { action: 'order.payment', summary: `Marcou o pagamento do pedido #${order.order_number} como ${label}`, entity: 'order', entityId: id });
      }
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

