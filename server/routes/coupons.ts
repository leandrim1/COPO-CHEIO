// Cupons de desconto. Painel: só o owner cria, edita e apaga. Público: a prévia do carrinho (o desconto é calculado pelo banco com os preços de agora; quem decide
// o valor do pedido é o create_order). Cupom é dinheiro: o servidor confere tudo e o navegador só manda o código.
import { audit, changedFields } from '../audit.js';
import type { FieldLabels } from '../audit.js';
import { attempts, recordAttempt, reserve } from '../auth.js';
import { customerFromRequest } from '../customer.js';
import { batch, one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Router } from '../http.js';
import { bool, dateTime, int, money, oneOf, parse, text } from '../validate.js';
import type { Spec } from '../validate.js';

const KINDS = ['percent', 'fixed', 'free_delivery'] as const;
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
// A mensagem que o banco devolve para cupom inexistente, desligado ou fora da validade: igual para todos, para não revelar quais códigos existem.
const GENERIC = 'Cupom inválido ou expirado.';

const couponSpec: Spec = {
  description: text('Descrição', { max: 120, nullable: true }),
  kind: oneOf('Tipo', KINDS, { required: true }),
  value: money('Valor', { required: true }),
  max_discount: money('Desconto máximo', { nullable: true, positive: true }),
  min_order: money('Pedido mínimo'),
  starts_at: dateTime('Começa em', { nullable: true }),
  ends_at: dateTime('Termina em', { nullable: true }),
  usage_limit: int('Limite total de usos', { min: 1, max: 1_000_000, nullable: true }),
  per_customer_limit: int('Usos por cliente', { min: 1, max: 1000, nullable: true }),
  excludes_promo: bool('Não vale para itens em promoção'),
  active: bool('Ligado'),
};

const COUPON_LABELS: FieldLabels = {
  description: { label: 'descrição' },
  kind: { label: 'tipo' },
  value: { label: 'valor' },
  max_discount: { label: 'desconto máximo', format: 'money' },
  min_order: { label: 'pedido mínimo', format: 'money' },
  starts_at: { label: 'início', format: 'date' },
  ends_at: { label: 'fim', format: 'date' },
  usage_limit: { label: 'limite de usos' },
  per_customer_limit: { label: 'usos por cliente' },
  excludes_promo: { label: 'sem itens em promoção', format: 'bool' },
  active: { label: 'ligado', format: 'bool' },
};

// O código: letras sem acento, números, hífen e sublinhado; sempre em maiúsculas e sem espaços nas pontas.
function parseCode(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'Código: informe o código do cupom.');
  const code = value.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(400, 'Código: use de 3 a 30 letras (sem acento), números, hífen ou sublinhado, sem espaços.');
  return code;
}

function parseCategories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(400, 'Categorias: lista inválida.');
  const ids = [...new Set(value.map((v) => (typeof v === 'string' ? v.toLowerCase() : '')))];
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))) throw new HttpError(400, 'Categorias: lista inválida.');
  return ids;
}

// Regras que dependem de mais de um campo (o banco também confere, com os mesmos limites).
function crossCheck(v: Row) {
  if (v.kind === 'percent') {
    if (typeof v.value !== 'number' || v.value < 1 || v.value > 100) throw new HttpError(400, 'Valor: a porcentagem precisa ficar entre 1 e 100.');
  } else if (v.kind === 'fixed') {
    if (typeof v.value !== 'number' || v.value <= 0 || v.value > 100_000) throw new HttpError(400, 'Valor: informe o desconto em reais (maior que zero).');
    if (v.max_discount !== null && v.max_discount !== undefined) throw new HttpError(400, 'Desconto máximo: só vale para cupom de porcentagem.');
  } else if (v.kind === 'free_delivery') {
    if (v.value !== 0) throw new HttpError(400, 'Valor: cupom de entrega grátis não tem valor de desconto.');
  }
  if (v.starts_at && v.ends_at && new Date(String(v.ends_at)) <= new Date(String(v.starts_at))) throw new HttpError(400, 'Validade: o fim precisa ser depois do início.');
}

const SELECT = `select c.*, (select count(*)::int from orders o where o.coupon_id = c.id and o.order_status <> 'cancelled') as used,
                       coalesce((select array_agg(k.category_id order by k.category_id) from coupon_categories k where k.coupon_id = c.id), '{}') as category_ids
                  from coupons c`;

async function load(id: string): Promise<Row | null> {
  return one<Row>(`${SELECT} where c.id = $1`, [id]);
}

async function assertCategoriesExist(ids: string[]) {
  if (!ids.length) return;
  const found = await one<{ n: number }>('select count(*)::int as n from categories where id = any($1::uuid[])', [ids]);
  if ((found?.n ?? 0) !== ids.length) throw new HttpError(400, 'Categorias: alguma categoria não existe mais.');
}

export function registerCoupons(r: Router) {
  // ---- Painel (só o owner) ---------------------------------------------------------------------------------------

  r.get('/api/admin/coupons', 'owner', async () => json({ coupons: await query<Row>(`${SELECT} order by c.created_at desc, c.code`) }));

  r.post('/api/admin/coupons', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 8 * 1024);
    // Cupom de entrega grátis não tem valor: se o cliente da API não mandar, vale 0; se mandar outro número, é erro (crossCheck).
    if (body.kind === 'free_delivery' && body.value === undefined) body.value = 0;
    const { values } = parse(couponSpec, body);
    const code = parseCode(body.code);
    const categories = parseCategories(body.category_ids) ?? [];
    if (values.kind !== 'percent') values.max_discount = null;
    crossCheck(values);
    await assertCategoriesExist(categories);
    const row: Row = { ...values, code, created_by: ctx.admin!.id };
    const keys = Object.keys(row);
    const results = await batch([
      [`insert into coupons (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, keys.map((k) => row[k])],
      ...categories.map((id): [string, unknown[]] => ['insert into coupon_categories (coupon_id, category_id) select id, $2::uuid from coupons where code = $1', [code, id]]),
    ]);
    const id = String(results[0][0].id);
    await audit(ctx, { action: 'coupon.create', summary: `Criou o cupom ${code}`, entity: 'coupon', entityId: id, details: { kind: values.kind, value: values.value } });
    return json({ coupon: await load(id) }, 201);
  });

  r.patch('/api/admin/coupons/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 8 * 1024);
    const before = await load(id);
    if (!before) throw new HttpError(404, 'Cupom não encontrado.');
    const { values } = parse(couponSpec, body, { partial: true });
    if (body.code !== undefined) values.code = parseCode(body.code);
    const categories = parseCategories(body.category_ids);
    // Confere o cupom como ele ficará (campos que não vieram valem como estão).
    // Virar cupom de entrega grátis sem mandar o valor: o valor passa a 0.
    if (values.kind === 'free_delivery' && !('value' in values)) values.value = 0;
    const merged: Row = { ...before, ...values };
    if (merged.kind !== 'percent') {
      merged.max_discount = null;
      values.max_discount = null;
    }
    crossCheck(merged);
    if (categories) await assertCategoriesExist(categories);
    const keys = Object.keys(values);
    const statements: [string, unknown[]][] = [];
    if (keys.length) statements.push([`update coupons set ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} where id = $${keys.length + 1}`, [...keys.map((k) => values[k]), id]]);
    if (categories) {
      statements.push(['delete from coupon_categories where coupon_id = $1', [id]]);
      for (const categoryId of categories) statements.push(['insert into coupon_categories (coupon_id, category_id) values ($1, $2)', [id, categoryId]]);
    }
    if (statements.length) await batch(statements);
    const after = await load(id);
    const diff = changedFields(before, values, { ...COUPON_LABELS, code: { label: 'código' } });
    const catsChanged = categories && JSON.stringify([...categories].sort()) !== JSON.stringify([...(before.category_ids as string[])].sort());
    const text = [diff?.text, catsChanged ? 'categorias' : null].filter(Boolean).join('; ');
    if (text) await audit(ctx, { action: 'coupon.update', summary: `Cupom ${before.code}: ${text}`, entity: 'coupon', entityId: id, details: diff?.details });
    return json({ coupon: after });
  });

  // Apagar não mexe em pedido feito: o pedido guarda o código e o desconto (e o vínculo vira vazio).
  r.delete('/api/admin/coupons/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const removed = await one<{ code: string }>('delete from coupons where id = $1 returning code', [id]);
    if (!removed) throw new HttpError(404, 'Cupom não encontrado.');
    await audit(ctx, { action: 'coupon.delete', summary: `Apagou o cupom ${removed.code}`, entity: 'coupon', entityId: id });
    return json({ ok: true });
  });

  // ---- Prévia pública --------------------------------------------------------------------------------------------

  // O site pergunta quanto o cupom dá para este carrinho. Não reserva nada. Quem erra o código muitas vezes (tentativa de adivinhar) é barrado por rede: só
  // erros contam; quem acerta não gasta tentativa. Cupom inexistente, desligado ou vencido dá sempre a mesma resposta.
  r.post('/api/coupons/validate', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    const blocked = 'Muitas tentativas de cupom. Aguarde alguns minutos e tente de novo.';
    await reserve('coupon-check', ctx.ip, 600, 180, blocked);
    if ((await attempts('coupon-miss', ctx.ip, 600)) >= 12) throw new HttpError(429, blocked, { code: 'rate_limited', retry_after: 300 }, { 'retry-after': '300' });
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const type = body.delivery_type === 'delivery' ? 'delivery' : 'pickup';
    const phone = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '').slice(0, 13) : '';
    const customer = await customerFromRequest(ctx.req);
    const items = Array.isArray(body.items)
      ? body.items.slice(0, 60).map((item: Row) => ({
          product_id: item?.product_id,
          quantity: item?.quantity,
          ...(item?.swap_to ? { swap_to: item.swap_to } : {}),
        }))
      : [];
    const row = await one<{ result: { ok: boolean; message?: string; id?: string; code?: string; description?: string | null; kind?: string; discount?: number; free_delivery?: boolean } }>(
      'select coupon_preview($1, $2::jsonb, $3, $4::uuid, $5) as result',
      [code, JSON.stringify(items), type, customer?.id ?? null, phone],
    );
    const result = row?.result;
    if (!result?.ok) {
      const message = result?.message ?? GENERIC;
      // Só o "não existe / desligado / vencido" (o que um chute errado produz) conta como tentativa errada.
      if (message === GENERIC) await recordAttempt('coupon-miss', ctx.ip);
      throw new HttpError(400, message, { code: 'coupon_invalid' });
    }
    return json({ coupon: { code: result.code, description: result.description ?? null, kind: result.kind, discount: Number(result.discount ?? 0), free_delivery: result.free_delivery === true } });
  });
}
