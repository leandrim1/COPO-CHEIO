// Pagamento online (Pix): o que o cliente usa para pagar, o aviso (webhook) da operadora e a área do dono no painel.
//
// • Cliente: com o código de acompanhamento do pedido (o mesmo link de /pedido/:código) ele gera o Pix e vê se foi pago. Só vê o próprio pedido.
// • Webhook: rota pública, mas nada é gravado antes de a operadora provar que o aviso é dela (o adaptador confere a assinatura).
// • Painel: só o owner vê valores, comissão, tarifas e códigos de cobrança.
import { audit } from '../audit.js';
import { reserve } from '../auth.js';
import { batch, one, query } from '../db.js';
import type { Row } from '../db.js';
import { requireCustomer } from '../customer.js';
import { HttpError, json, readJson, uuidParam } from '../http.js';
import type { Ctx, Router } from '../http.js';
import { linkAccount, listCandidates, refreshProposal, submitProposal } from '../payments/merchant.js';
import type { MerchantRow } from '../payments/merchant.js';
import { getProvider, providerSummary } from '../payments/provider.js';
import { customerPaymentView, handleWebhook, normalizePayment, onlineReadiness, refreshPayment, startPixPayment, sweep } from '../payments/service.js';
import { NOT_FOUND, assertNotThrottled, hashToken, missesStatement, normalizeToken, recordMiss, throttled } from '../tracking.js';

const HEADERS = { 'x-robots-tag': 'noindex, nofollow' };
const STATUS_FILTERS = ['creating', 'pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded'];

// O pedido do código de acompanhamento (a mesma regra de /api/tracking: código válido, não revogado, dentro do prazo; tentativas erradas
// são contadas e limitadas; o erro nunca diz se o pedido existe).
async function orderIdFromToken(ctx: Ctx): Promise<string> {
  const canonical = normalizeToken(ctx.params.token);
  if (!canonical) {
    await assertNotThrottled(ctx);
    await recordMiss(ctx);
    throw new HttpError(404, NOT_FOUND);
  }
  const [misses, found] = await batch([missesStatement(ctx), ['select order_id_for_token($1) as id', [hashToken(canonical)]]]);
  if (throttled(misses[0].n)) throw new HttpError(429, 'Muitas tentativas de consulta. Aguarde alguns minutos e tente de novo.');
  const id = found[0]?.id as string | null | undefined;
  if (!id) {
    await recordMiss(ctx);
    throw new HttpError(404, NOT_FOUND);
  }
  return id;
}

// O pedido de quem está logado na conta (Meus pedidos): só pedidos da própria conta, e o erro nunca diz se o pedido de outra pessoa existe.
async function orderIdOfCustomer(ctx: Ctx): Promise<string> {
  const customer = await requireCustomer(ctx);
  const number = ctx.params.number;
  if (!/^\d{1,12}$/.test(number)) throw new HttpError(404, 'Pedido não encontrado.');
  const row = await one<{ id: string }>('select id from orders where customer_id = $1 and order_number = $2::bigint', [customer.id, number]);
  if (!row) throw new HttpError(404, 'Pedido não encontrado.');
  return row.id;
}

// Os dois jeitos de chegar ao pedido (código de acompanhamento ou conta) usam a mesma lógica.
async function showPayment(orderId: string): Promise<Response> {
  const view = await customerPaymentView(orderId, { refresh: true });
  // De passagem, encerra o que venceu e cancela o pedido que não foi pago a tempo (sem agendador).
  await sweep({ lookups: false }).catch(() => undefined);
  return json(view, 200, HEADERS);
}

async function createPayment(ctx: Ctx, orderId: string): Promise<Response> {
  const body = await readJson(ctx.req, 1024);
  if (body.method !== undefined && body.method !== 'pix') throw new HttpError(400, 'Forma de pagamento inválida.');
  await reserve('pay-create', ctx.ip, 600, 30, 'Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos e tente de novo.');
  const { created } = await startPixPayment(orderId);
  const view = await customerPaymentView(orderId, { refresh: false });
  return json(view, created ? 201 : 200, HEADERS);
}

// Na lista e no detalhe do painel: nunca o Pix "copia e cola" (não é preciso para conferir nada).
function adminRow(row: Row, owner: boolean): Row {
  const p = normalizePayment(row);
  const base = {
    id: p.id,
    order_id: p.order_id,
    order_number: row.order_number,
    attempt: p.attempt,
    method: p.method,
    status: p.status,
    amount_cents: p.amount_cents,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    created_at: p.created_at,
    needs_attention: p.needs_attention,
  };
  if (!owner) return base;
  return {
    ...base,
    attention_reason: p.attention_reason,
    provider: p.provider,
    provider_charge_id: p.provider_charge_id,
    provider_status: p.provider_status,
    commission_bps: p.commission_bps,
    commission_cents: p.commission_cents,
    commission_state: p.commission_state,
    commission_confirmed_cents: p.commission_confirmed_cents,
    fee_cents: p.fee_cents,
    net_cents: p.net_cents,
    refunded_cents: p.refunded_cents,
    checked_at: p.checked_at,
    closed_at: p.closed_at,
    last_error: p.last_error,
  };
}

// Pagamentos de um pedido, para o detalhe do pedido no painel (qualquer administrador vê a situação; só o owner vê comissão e tarifas).
export async function paymentsOfOrder(orderId: string, owner: boolean): Promise<Row[]> {
  const rows = await query<Row>(
    'select p.*, o.order_number from payments p join orders o on o.id = p.order_id where p.order_id = $1::uuid order by p.created_at',
    [orderId],
  );
  return rows.map((row) => adminRow(row, owner));
}

const mask = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value) return null;
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}…${value.slice(-4)}`;
};

// A conta do estabelecimento como o painel a vê: identificadores sempre mascarados.
const publicMerchant = (row: MerchantRow | Row | null): Row | null => (row ? { ...row, proposal_id: mask(row.proposal_id), provider_account_id: mask(row.provider_account_id) } : null);
const flag = (value: unknown): boolean => value === true;

export function registerPayments(r: Router) {
  // ---- Cliente --------------------------------------------------------------------------------------------------

  r.get('/api/tracking/:token/payment', 'public', async (ctx) => showPayment(await orderIdFromToken(ctx)));

  // Gera o Pix do pedido, ou devolve o que já está em andamento (clique repetido, página recarregada e requisições simultâneas dão a mesma cobrança).
  r.post('/api/tracking/:token/payment', 'public', async (ctx) => createPayment(ctx, await orderIdFromToken(ctx)));

  // O mesmo, para quem está logado na conta (Meus pedidos não usa o código de acompanhamento).
  r.get('/api/account/orders/:number/payment', 'public', async (ctx) => showPayment(await orderIdOfCustomer(ctx)));
  r.post('/api/account/orders/:number/payment', 'public', async (ctx) => createPayment(ctx, await orderIdOfCustomer(ctx)));

  // ---- Operadora ------------------------------------------------------------------------------------------------

  // Aviso (webhook). Rota pública porque a operadora não faz login; o que vale é a prova de autenticidade que o adaptador confere.
  r.post('/api/payments/webhook', 'public', async (ctx) => json(await handleWebhook(ctx.req)));

  // ---- Painel (só o owner) ------------------------------------------------------------------------------------------

  r.get('/api/admin/payments', 'owner', async (ctx) => {
    const q = ctx.url.searchParams;
    const status = q.get('status') ?? 'all';
    if (status !== 'all' && !STATUS_FILTERS.includes(status)) throw new HttpError(400, 'Status inválido.');
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 30) || 30, 1), 100);
    const where: string[] = [];
    const params: unknown[] = [];
    if (status !== 'all') {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    }
    if (q.get('attention') === '1') where.push('p.needs_attention');
    params.push(limit + 1);
    const [rows, summary, merchant, method, rate] = await batch([
      [
        `select p.*, o.order_number from payments p join orders o on o.id = p.order_id
          ${where.length ? `where ${where.join(' and ')}` : ''} order by p.created_at desc limit $${params.length}`,
        params,
      ],
      [
        `select count(*) filter (where status = 'pending') as pending,
                count(*) filter (where status = 'paid') as paid,
                count(*) filter (where status = 'expired') as expired,
                count(*) filter (where status in ('cancelled', 'failed')) as failed,
                count(*) filter (where status = 'refunded') as refunded,
                count(*) filter (where needs_attention) as attention,
                coalesce(sum(amount_cents) filter (where status = 'paid'), 0) as paid_cents,
                coalesce(sum(commission_cents) filter (where status = 'paid'), 0) as commission_calculated_cents,
                coalesce(sum(commission_confirmed_cents) filter (where commission_state = 'confirmed' and status = 'paid'), 0) as commission_confirmed_cents,
                coalesce(sum(commission_cents) filter (where status = 'paid' and commission_state = 'calculated'), 0) as commission_waiting_cents,
                coalesce(sum(commission_cents) filter (where status = 'paid' and commission_state = 'failed'), 0) as commission_failed_cents,
                coalesce(sum(fee_cents) filter (where status in ('paid', 'refunded')), 0) as fee_cents
           from payments`,
      ],
      [
        `select id, provider, kind, status, status_detail, proposal_id, provider_account_id, ambiguous, authorized_at, fees_acknowledged_at, created_at, updated_at
           from merchant_accounts where provider = $1
          order by (status in ('draft', 'submitted', 'pending', 'approved')) desc, created_at desc limit 1`,
        [getProvider()?.name ?? ''],
      ],
      ["select code, label, enabled from payment_methods where code = 'pix_online'"],
      // A taxa atual da comissão vem do banco (a única fonte); cada cobrança guarda a taxa de quando foi criada.
      ['select payment_commission_bps() as bps'],
    ]);
    const account = publicMerchant(merchant[0] ?? null);
    return json({
      payments: rows.slice(0, limit).map((row) => adminRow(row, true)),
      has_more: rows.length > limit,
      summary: summary[0],
      commission_bps: Number(rate[0]?.bps ?? 0),
      merchant: account,
      provider: providerSummary(),
      account_fee_cents: getProvider()?.merchant?.accountCreationFeeCents ?? null,
      readiness: await onlineReadiness(),
      method: method[0] ?? null,
    });
  });

  // ---- Conta do estabelecimento na operadora (só o owner) ---------------------------------------------------------------------------
  // Registradas ANTES das rotas /api/admin/payments/:id/... (senão "account" seria lido como o :id de uma cobrança).
  // Nada aqui acontece sozinho: cada rota é uma ação explícita do owner, com a autorização do titular (e, em produção, a ciência das tarifas).

  // Contas que a operadora informa ter (documento sempre mascarado), para vincular uma que já existe.
  r.get('/api/admin/payments/account/candidates', 'owner', async () => json({ accounts: await listCandidates() }));

  r.post('/api/admin/payments/account/link', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    await reserve('merchant-link', ctx.ip, 3600, 20, 'Muitas tentativas em pouco tempo. Aguarde e tente de novo.');
    const row = await linkAccount(ctx, typeof body.account_number === 'string' ? body.account_number.trim() : '', { authorized: flag(body.authorized), feesAcknowledged: flag(body.fees_acknowledged) });
    return json({ account: publicMerchant(row) }, 201);
  });

  // Cadastra uma conta nova (PF ou PJ). Os dados pessoais vão direto para a operadora: não são gravados aqui.
  r.post('/api/admin/payments/account/proposal', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 16 * 1024);
    await reserve('merchant-proposal', ctx.ip, 3600, 8, 'Muitas tentativas de cadastro em pouco tempo. Aguarde e tente de novo.');
    if (body.kind !== 'pf' && body.kind !== 'pj') throw new HttpError(400, 'Escolha pessoa física ou pessoa jurídica.');
    const row = await submitProposal(ctx, {
      kind: body.kind,
      authorized: flag(body.authorized),
      feesAcknowledged: flag(body.fees_acknowledged),
      confirmDuplicateRisk: flag(body.confirm_duplicate_risk),
      form: body.form,
    });
    return json({ account: publicMerchant(row) }, 201);
  });

  // Atualiza o andamento do cadastro na operadora (e traz o endereço de envio dos documentos, que não é guardado).
  r.post('/api/admin/payments/account/refresh', 'owner', async (ctx) => {
    await reserve('merchant-refresh', ctx.ip, 600, 30, 'Muitas consultas em pouco tempo. Aguarde e tente de novo.');
    const { account, documentsUrl } = await refreshProposal(ctx);
    return json({ account: publicMerchant(account), documents_url: documentsUrl });
  });

  r.get('/api/admin/payments/:id', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const row = await one<Row>('select p.*, o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    if (!row) throw new HttpError(404, 'Pagamento não encontrado.');
    const events = await query<Row>(
      `select event_type, observed_status, amount_cents, outcome, detail, attempts, received_at, processed_at
         from payment_events where payment_id = $1 order by received_at desc limit 50`,
      [id],
    );
    return json({ payment: adminRow(row, true), events });
  });

  // "Atualizar pagamento": pergunta à operadora como está esta cobrança e aplica a resposta (a mesma regra dos avisos).
  r.post('/api/admin/payments/:id/refresh', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const exists = await one<Row>('select p.id, o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    if (!exists) throw new HttpError(404, 'Pagamento não encontrado.');
    if (!getProvider()?.canLookup) throw new HttpError(409, 'Não há como consultar a operadora agora.', { code: 'lookup_unavailable' });
    let result;
    try {
      result = await refreshPayment(id, 'admin');
    } catch {
      throw new HttpError(503, 'A operadora não respondeu. Tente de novo em instantes.', { code: 'provider_unavailable' });
    }
    if (!result) throw new HttpError(409, 'Esta cobrança ainda não tem código na operadora para consultar.', { code: 'lookup_unavailable' });
    await audit(ctx, { action: 'payment.refresh', summary: `Conferiu o pagamento do pedido #${exists.order_number} na operadora`, entity: 'payment', entityId: id });
    const row = await one<Row>('select p.*, o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    return json({ payment: adminRow(row!, true), outcome: result.outcome });
  });

  // "Marcar como conferido": o dono já tratou o que a cobrança tinha de errado (devolveu o valor, conferiu na operadora...). O motivo
  // continua guardado na cobrança e no histórico de atividades; só deixa de aparecer como pendência.
  r.post('/api/admin/payments/:id/ack', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const row = await one<Row>(
      `update payments p set needs_attention = false
         from orders o
        where p.id = $1 and o.id = p.order_id and p.needs_attention
        returning p.id, o.order_number, p.attention_reason`,
      [id],
    );
    if (!row) throw new HttpError(404, 'Este pagamento não tem pendência para conferir.');
    await audit(ctx, {
      action: 'payment.ack',
      summary: `Marcou como conferido o pagamento do pedido #${row.order_number}`,
      entity: 'payment',
      entityId: id,
      details: { reason: row.attention_reason },
    });
    return json({ ok: true });
  });

  // "Conferir agora": passa por tudo que está vencido ou sem notícia há tempo.
  r.post('/api/admin/payments/sweep', 'owner', async (ctx) => {
    const result = await sweep({ lookups: true, force: true, limit: 20 });
    await audit(ctx, { action: 'payment.sweep', summary: `Conferiu os pagamentos online: ${result.checked} consultado(s), ${result.closed} encerrado(s), ${result.cancelled} pedido(s) cancelado(s)`, entity: 'payment' });
    return json(result);
  });
}
