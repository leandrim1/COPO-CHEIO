// Exportação em CSV (planilha). Pedidos e clientes têm DADOS PESSOAIS (nome, telefone, e-mail, endereço): só o owner exporta, cada exportação fica no registro de
// atividades (quem, quando, filtros, quantas linhas) e a resposta nunca vai para cache. Estoque não tem dado pessoal: qualquer administrador exporta.
import { audit } from '../audit.js';
import { reserve } from '../auth.js';
import { reais, toCsv } from '../csv.js';
import type { Cell } from '../csv.js';
import { query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError } from '../http.js';
import type { Router } from '../http.js';

const MAX_ROWS = 20_000;
const MAX_DAYS = 400;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const STATUS: Record<string, string> = {
  awaiting_payment: 'Aguardando pagamento',
  new: 'Novo',
  confirmed: 'Confirmado',
  preparing: 'Em preparo',
  out_for_delivery: 'Saiu para entrega',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
};
const PAYMENT_STATUS: Record<string, string> = { pending: 'Pendente', paid: 'Pago', refunded: 'Reembolsado', failed: 'Falhou' };
const METHOD: Record<string, string> = { pix: 'Pix (chave)', cash: 'Dinheiro', card: 'Cartão na entrega', pix_online: 'Pix online', card_online: 'Cartão online' };

function csv(name: string, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

const dayOf = (value: string | null, label: string): string | null => {
  if (value === null || value === '') return null;
  if (!DAY.test(value) || Number.isNaN(new Date(`${value}T12:00:00Z`).getTime())) throw new HttpError(400, `${label}: use o formato AAAA-MM-DD.`);
  return value;
};

// "dd/mm/aaaa hh:mm" no fuso da loja.
const stamp = (value: unknown, tz: string) =>
  value
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(String(value))).replace(',', '')
    : '';

export function registerExports(r: Router) {
  r.get('/api/admin/export/orders.csv', 'owner', async (ctx) => {
    const from = dayOf(ctx.url.searchParams.get('from'), 'De');
    const to = dayOf(ctx.url.searchParams.get('to'), 'Até');
    const status = ctx.url.searchParams.get('status');
    if (!from || !to) throw new HttpError(400, 'Informe o período (de e até).');
    if (to < from) throw new HttpError(400, 'O fim do período precisa ser depois do início.');
    if ((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86_400_000 > MAX_DAYS) throw new HttpError(400, `Escolha um período de até ${MAX_DAYS} dias.`);
    if (status && !STATUS[status]) throw new HttpError(400, 'Situação inválida.');
    await reserve('export', ctx.admin!.id, 3600, 20, 'Muitas exportações em pouco tempo. Aguarde alguns minutos.');

    const rows = await query<Row>(
      `with tz as (select timezone as name from store_settings where id = 1)
       select o.order_number, o.created_at, o.order_status, o.payment_status, o.payment_method, o.delivery_type, o.customer_name, o.customer_phone, o.customer_email,
              o.address, o.address_number, o.neighborhood, o.subtotal, o.delivery_fee, o.discount, o.coupon_code, o.payment_fee, o.total, o.age_required, o.age_checked_at,
              (select string_agg(i.quantity || 'x ' || i.product_name, ' | ' order by i.created_at, i.product_name) from order_items i where i.order_id = o.id) as items,
              (select name from tz) as tz
         from orders o
        where o.created_at >= (($1::date)::timestamp at time zone (select name from tz))
          and o.created_at < ((($2::date) + 1)::timestamp at time zone (select name from tz))
          and ($3::text is null or o.order_status = $3)
        order by o.created_at, o.order_number
        limit ${MAX_ROWS + 1}`,
      [from, to, status || null],
    );
    if (rows.length > MAX_ROWS) throw new HttpError(400, `Esse período tem mais de ${MAX_ROWS} pedidos. Escolha um período menor.`);

    const header: Cell[] = [
      'Pedido', 'Data', 'Situação', 'Pagamento', 'Forma de pagamento', 'Tipo', 'Cliente', 'Telefone', 'E-mail', 'Endereço', 'Bairro',
      'Subtotal (R$)', 'Entrega (R$)', 'Desconto (R$)', 'Cupom', 'Taxa do pagamento (R$)', 'Total (R$)', 'Documento conferido (18+)', 'Itens',
    ];
    const body: Cell[][] = rows.map((o) => [
      o.order_number,
      stamp(o.created_at, String(o.tz ?? 'America/Sao_Paulo')),
      STATUS[o.order_status] ?? o.order_status,
      PAYMENT_STATUS[o.payment_status] ?? o.payment_status,
      METHOD[o.payment_method] ?? o.payment_method,
      o.delivery_type === 'delivery' ? 'Entrega' : 'Retirada',
      o.customer_name,
      o.customer_phone,
      o.customer_email,
      o.address ? `${o.address}, ${o.address_number ?? 's/n'}` : '',
      o.neighborhood,
      reais(o.subtotal),
      reais(o.delivery_fee),
      reais(o.discount),
      o.coupon_code,
      reais(o.payment_fee),
      reais(o.total),
      o.age_required ? (o.age_checked_at ? 'sim' : 'não') : 'não se aplica',
      o.items,
    ]);
    await audit(ctx, {
      action: 'export.orders',
      summary: `Exportou ${rows.length} pedido(s) em CSV (${from} a ${to}${status ? `, ${STATUS[status]}` : ''}); contém dados pessoais dos clientes`,
      entity: 'export',
      details: { from, to, status: status || null, rows: rows.length },
    });
    return csv(`pedidos-${from}_a_${to}.csv`, toCsv([header, ...body]));
  });

  r.get('/api/admin/export/customers.csv', 'owner', async (ctx) => {
    await reserve('export', ctx.admin!.id, 3600, 20, 'Muitas exportações em pouco tempo. Aguarde alguns minutos.');
    const rows = await query<Row>(
      `select c.name, c.email, c.phone, c.created_at, (c.email_verified_at is not null) as verified, c.active,
              (select count(*)::int from orders o where o.customer_id = c.id) as orders,
              (select coalesce(sum(o.total), 0) from orders o where o.customer_id = c.id and o.order_status <> 'cancelled') as spent,
              (select max(o.created_at) from orders o where o.customer_id = c.id) as last_order,
              (select timezone from store_settings where id = 1) as tz
         from customers c
        order by c.created_at, c.id
        limit ${MAX_ROWS + 1}`,
    );
    if (rows.length > MAX_ROWS) throw new HttpError(400, `Há mais de ${MAX_ROWS} clientes; a exportação foi limitada.`);
    const header: Cell[] = ['Nome', 'E-mail', 'Telefone', 'Cadastro em', 'E-mail confirmado', 'Conta ativa', 'Pedidos', 'Total gasto (R$)', 'Último pedido'];
    const body: Cell[][] = rows.map((c) => [c.name, c.email, c.phone, stamp(c.created_at, String(c.tz ?? 'America/Sao_Paulo')), c.verified, c.active, c.orders, reais(c.spent), stamp(c.last_order, String(c.tz ?? 'America/Sao_Paulo'))]);
    await audit(ctx, { action: 'export.customers', summary: `Exportou ${rows.length} cliente(s) em CSV; contém dados pessoais`, entity: 'export', details: { rows: rows.length } });
    return csv(`clientes-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([header, ...body]));
  });

  r.get('/api/admin/export/stock.csv', 'admin', async (ctx) => {
    await reserve('export', ctx.admin!.id, 3600, 20, 'Muitas exportações em pouco tempo. Aguarde alguns minutos.');
    const rows = await query<Row>(
      `select p.name, p.sku, coalesce(c.name, 'Outros') as category, p.price, p.stock, p.active, p.sold_out
         from products p left join categories c on c.id = p.category_id
        order by c.position nulls last, c.name nulls last, p.position, p.name
        limit ${MAX_ROWS + 1}`,
    );
    const header: Cell[] = ['Produto', 'SKU', 'Categoria', 'Preço (R$)', 'Estoque', 'Ativo', 'Marcado como esgotado'];
    const body: Cell[][] = rows.slice(0, MAX_ROWS).map((p) => [p.name, p.sku, p.category, reais(p.price), p.stock === null ? 'sem controle' : p.stock, p.active, p.sold_out]);
    await audit(ctx, { action: 'export.stock', summary: `Exportou o estoque (${body.length} produto(s)) em CSV`, entity: 'export', details: { rows: body.length } });
    return csv(`estoque-${new Date().toISOString().slice(0, 10)}.csv`, toCsv([header, ...body]));
  });
}
