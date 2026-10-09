// Acompanhamento público do pedido, sem login: o cliente chega com o link (código secreto) ou com
// número do pedido + código. Nada aqui devolve dados de outro pedido, e erro nenhum diz se um pedido existe.
import { customerFromRequest } from '../customer.js';
import { batch, one } from '../db.js';
import { HttpError, json, readJson } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { NOT_FOUND, assertNotThrottled, missesStatement, normalizeToken, hashToken, recordMiss, throttled } from '../tracking.js';

const HEADERS = { 'x-robots-tag': 'noindex, nofollow' };

// Procura o pedido pelo código (e, se vier, pelo número). Uma ida ao banco: tentativas recentes + pedido.
// Se quem consulta está logado, diz se o pedido já é da conta dela (para o botão "salvar na minha conta").
async function mineFlag(ctx: Ctx, number: number): Promise<boolean> {
  const customer = await customerFromRequest(ctx.req);
  if (!customer) return false;
  return Boolean(await one('select 1 as ok from orders where order_number = $1::bigint and customer_id = $2', [number, customer.id]));
}

async function find(ctx: Ctx, input: unknown, number: string | null): Promise<{ order: unknown; canonical: string }> {
  const canonical = normalizeToken(input);
  if (!canonical) {
    await assertNotThrottled(ctx);
    await recordMiss(ctx);
    throw new HttpError(404, NOT_FOUND);
  }
  const [misses, found] = await batch([missesStatement(ctx), ['select get_public_order($1, $2::bigint) as "order"', [hashToken(canonical), number]]]);
  if (throttled(misses[0].n)) throw new HttpError(429, 'Muitas tentativas de consulta. Aguarde alguns minutos e tente de novo.');
  const order = found[0]?.order;
  if (!order) {
    await recordMiss(ctx);
    throw new HttpError(404, NOT_FOUND);
  }
  return { order, canonical };
}

export function registerTracking(r: Router) {
  // Link permanente: /acompanhar-pedido/<código>
  r.get('/api/tracking/:token', 'public', async (ctx) => {
    const { order } = await find(ctx, ctx.params.token, null);
    return json({ order, mine: await mineFlag(ctx, (order as { order_number: number }).order_number) }, 200, HEADERS);
  });

  // "Acompanhar pedido" sem o link: número + código.
  r.post('/api/tracking/lookup', 'public', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const number = typeof body.order_number === 'string' || typeof body.order_number === 'number' ? String(body.order_number).trim().replace(/^#/, '') : '';
    if (!/^\d{1,12}$/.test(number)) throw new HttpError(400, 'Informe o número do pedido (só números, como #1001).');
    if (normalizeToken(body.code) === null) throw new HttpError(400, 'O código de acompanhamento não parece certo. Ele tem 20 letras e números, como 7K3M9-QX2VB-4HRD6-WTP8N.');
    const { order, canonical } = await find(ctx, body.code, number);
    return json({ order, token: canonical, mine: await mineFlag(ctx, (order as { order_number: number }).order_number) }, 200, HEADERS);
  });
}
