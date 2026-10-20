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
import { kickQueue } from '../email/service.js';
import { cardFeeCents, parseMoneyToCents, parsePercentToBps } from '../payments/cardFee.js';
import { linkAccount, listCandidates, refreshProposal, submitProposal, validCnpj, validCpf } from '../payments/merchant.js';
import type { MerchantRow } from '../payments/merchant.js';
import { getProvider, providerSummary } from '../payments/provider.js';
import { cardReadiness, customerPaymentView, handleWebhook, isRefundReason, normalizePayment, onlineReadiness, reconcileRefunds, refreshPayment, refundAvailable, refundsOfPayment, requestRefund, startCardPayment, startPixPayment, sweep } from '../payments/service.js';
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
  kickQueue(undefined, { minGapMs: 15_000 });
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

// Cartão: o navegador troca o cartão por um token (SDK da operadora) e manda só o TOKEN, o identificador do dispositivo e o CPF/CNPJ de quem paga.
// O número do cartão e o CVV nunca chegam aqui. O valor cobrado não vem do navegador: é o total do pedido gravado no banco.
async function payByCard(ctx: Ctx, orderId: string): Promise<Response> {
  const body = await readJson(ctx.req, 2 * 1024);
  const cardToken = typeof body.card_token === 'string' ? body.card_token.trim() : '';
  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  const document = typeof body.document === 'string' ? body.document.replace(/\D/g, '') : '';
  // Só dígitos (13 a 19) seria um NÚMERO DE CARTÃO no lugar do token: nunca segue adiante (nem para a operadora, nem para o log ou o banco).
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(cardToken) || /^[\d\s-]{13,23}$/.test(cardToken) || !/^[A-Za-z0-9_-]{8,100}$/.test(deviceId)) {
    throw new HttpError(400, 'Não foi possível ler os dados do cartão. Digite de novo.', { code: 'card_data' });
  }
  if (!(document.length === 11 ? validCpf(document) : document.length === 14 ? validCnpj(document) : false)) {
    throw new HttpError(400, 'Confira o CPF (ou CNPJ) e tente de novo.', { code: 'document_invalid' });
  }
  await reserve('card-pay-ip', ctx.ip, 600, 20, 'Muitas tentativas de pagamento em pouco tempo. Aguarde alguns minutos e tente de novo.');
  await reserve('card-pay-order', orderId, 600, 8, 'Muitas tentativas de pagamento deste pedido. Aguarde alguns minutos ou fale com a loja.');
  await startCardPayment(orderId, { cardToken, deviceId, document });
  return json(await customerPaymentView(orderId, { refresh: false }), 200, HEADERS);
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
    customer_fee_cents: p.customer_fee_cents,
    card_attempts: p.card_attempts,
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
  const out: Row[] = [];
  for (const row of rows) out.push(owner ? { ...adminRow(row, true), refunds: await refundsOfPayment(String(row.id)), refund_available: refundAvailable(row.provider as string) } : adminRow(row, owner));
  return out;
}

// Valor digitado em reais ("12,50" ou 12.5) → centavos. Vazio = null (devolver tudo o que falta). Até R$ 999.999,99.
function refundAmountCents(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/^R\$\s*/i, '') : '';
  const match = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(text);
  if (!match) throw new HttpError(400, 'Informe o valor da devolução em reais (ex.: 12,50).');
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || 0);
  if (cents <= 0) throw new HttpError(400, 'O valor da devolução precisa ser maior que zero.');
  return cents;
}

const REASON_LABEL: Record<string, string> = {
  CUSTOMER_REQUEST: 'pedido do cliente',
  FRAUD: 'suspeita de fraude',
  BANK_ERROR: 'erro bancário',
  PIX_CHANGE_ERROR: 'erro na transação Pix',
};
const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

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

  // Cartão de crédito: o navegador manda o token do cartão (nunca o cartão); o valor sai do pedido, no banco.
  r.post('/api/tracking/:token/payment/card', 'public', async (ctx) => payByCard(ctx, await orderIdFromToken(ctx)));
  r.post('/api/account/orders/:number/payment/card', 'public', async (ctx) => payByCard(ctx, await orderIdOfCustomer(ctx)));

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
    const [rows, summary, merchant, method, rate, cardMethod, cardFee] = await batch([
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
      // A divisão atual para a master (taxa de serviço do cliente + parte do estabelecimento, 2,5% + 2,5%) vem do banco (a única fonte); cada cobrança
      // guarda a divisão de quando foi criada.
      ['select pix_customer_fee_bps, pix_store_fee_bps, pix_customer_fee_bps + pix_store_fee_bps as bps from payment_fee_settings where id = 1'],
      ["select code, label, enabled from payment_methods where code = 'card_online'"],
      ['select card_fee_bps, card_fee_fixed_cents, confirmed_at, confirmed_by_name, updated_at from payment_fee_settings where id = 1'],
    ]);
    const account = publicMerchant(merchant[0] ?? null);
    return json({
      payments: rows.slice(0, limit).map((row) => adminRow(row, true)),
      has_more: rows.length > limit,
      summary: summary[0],
      commission_bps: Number(rate[0]?.bps ?? 0),
      pix_fee: { customer_bps: Number(rate[0]?.pix_customer_fee_bps ?? 0), store_bps: Number(rate[0]?.pix_store_fee_bps ?? 0) },
      merchant: account,
      provider: providerSummary(),
      account_fee_cents: getProvider()?.merchant?.accountCreationFeeCents ?? null,
      readiness: await onlineReadiness(),
      method: method[0] ?? null,
      card: { method: cardMethod[0] ?? null, fee: cardFee[0] ?? null, readiness: await cardReadiness() },
    });
  });

  // ---- Taxa do cartão repassada ao cliente (só o owner) -----------------------------------------------------------------------------
  // O percentual e a tarifa fixa vêm do contrato com a operadora e ficam NO BANCO (nunca no navegador do cliente). Só o owner muda; o
  // banco recusa valores fora de limites sensatos e tira a "conferência" de qualquer valor que mude. O cartão online só liga conferido.
  const feeView = async () => {
    const row = await one<Row>('select card_fee_bps, card_fee_fixed_cents, confirmed_at, confirmed_by_name, updated_at from payment_fee_settings where id = 1');
    const bps = Number(row?.card_fee_bps ?? 0);
    const fixed = Number(row?.card_fee_fixed_cents ?? 0);
    return {
      bps,
      fixed_cents: fixed,
      confirmed_at: row?.confirmed_at ?? null,
      confirmed_by_name: row?.confirmed_by_name ?? null,
      updated_at: row?.updated_at ?? null,
      // Exemplos para o dono ver a conta funcionando com os valores de agora (a mesma do banco).
      examples: [1000, 5000, 10000].map((base) => ({ base_cents: base, fee_cents: cardFeeCents(base, { bps, fixedCents: fixed }), total_cents: base + cardFeeCents(base, { bps, fixedCents: fixed }) })),
      readiness: await cardReadiness(),
    };
  };

  r.get('/api/admin/payment-fees/card', 'owner', async () => json(await feeView()));

  r.patch('/api/admin/payment-fees/card', 'owner', async (ctx) => {
    const body = await readJson(ctx.req, 2 * 1024);
    const current = await one<Row>('select card_fee_bps, card_fee_fixed_cents from payment_fee_settings where id = 1');
    const bps = body.percent === undefined ? Number(current!.card_fee_bps) : parsePercentToBps(body.percent);
    const fixed = body.fixed === undefined ? Number(current!.card_fee_fixed_cents) : parseMoneyToCents(body.fixed);
    if (bps === null) throw new HttpError(400, 'Informe o percentual do cartão como em 5,37 (de 0 a 25).', { code: 'invalid_percent' });
    if (fixed === null) throw new HttpError(400, 'Informe a tarifa fixa como em 0,37 (de 0 a 10,00).', { code: 'invalid_fixed' });
    const confirmed = body.confirmed === true;
    const changed = bps !== Number(current!.card_fee_bps) || fixed !== Number(current!.card_fee_fixed_cents);
    if (!changed && !confirmed) throw new HttpError(400, 'Nada para salvar: os valores são os mesmos. Marque que conferiu com o contrato para confirmar.', { code: 'nothing_to_save' });
    // Mudar a taxa com o cartão online LIGADO sem conferir os novos valores deixaria a loja sem cartão (o banco recusa pedido sem conferência).
    if (changed && !confirmed) {
      const on = await one<{ enabled: boolean }>("select enabled from payment_methods where code = 'card_online'");
      if (on?.enabled) throw new HttpError(409, 'O cartão online está ligado. Confirme que conferiu os novos valores com o contrato, ou desligue o cartão online antes de mudar a taxa.', { code: 'confirm_required' });
    }
    const admin = ctx.admin!;
    await one(
      `update payment_fee_settings
          set card_fee_bps = $1, card_fee_fixed_cents = $2, updated_by = $3,
              confirmed_at = case when $4 then now() else confirmed_at end,
              confirmed_by = case when $4 then $3::uuid else confirmed_by end,
              confirmed_by_name = case when $4 then $5 else confirmed_by_name end
        where id = 1`,
      [bps, fixed, admin.id, confirmed, admin.name],
    );
    const pct = `${(bps / 100).toFixed(2).replace('.', ',')}%`;
    const fix = `R$ ${(fixed / 100).toFixed(2).replace('.', ',')}`;
    await audit(ctx, {
      action: 'payment.card_fee',
      summary: `Taxa do cartão repassada ao cliente: ${pct} + ${fix}${confirmed ? ' (conferida com o contrato da operadora)' : ' (ainda NÃO conferida)'}`,
      entity: 'payment',
      entityId: 'card_online',
      details: { bps, fixed_cents: fixed, confirmed },
    });
    return json(await feeView());
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
    return json({ payment: { ...adminRow(row, true), refund_available: refundAvailable(row.provider as string) }, events, refunds: await refundsOfPayment(id) });
  });

  // ---- Devolução (estorno) pelo painel: só o owner. O dinheiro só é dado como devolvido quando a operadora CONFIRMA ----------------------------
  // Pede à operadora (POST /v1/wallet/refunds) o valor (ou tudo o que falta) de um pagamento confirmado. O servidor trava pedido e pagamento no banco, impede dois
  // pedidos abertos ao mesmo tempo e, se a resposta da operadora se perder, NÃO repete: o painel manda conferir (refunds/check) antes de qualquer nova tentativa.
  r.post('/api/admin/payments/:id/refund', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const body = await readJson(ctx.req, 2 * 1024);
    if (!isRefundReason(body.reason)) throw new HttpError(400, 'Escolha o motivo da devolução.');
    const amountCents = refundAmountCents(body.amount);
    if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 200)) throw new HttpError(400, 'A anotação pode ter até 200 caracteres.');
    const note = typeof body.note === 'string' ? body.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || null : null;
    await reserve('refund-request', ctx.admin!.id, 600, 30, 'Muitos pedidos de devolução em pouco tempo. Aguarde alguns minutos.');
    const exists = await one<Row>('select o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    if (!exists) throw new HttpError(404, 'Pagamento não encontrado.');
    const result = await requestRefund({ paymentId: id, amountCents, reason: body.reason, note, adminId: ctx.admin!.id });
    await audit(ctx, {
      action: 'payment.refund_request',
      summary: `Pediu a devolução de ${brl(result.refund.amount_cents)} do pagamento do pedido #${exists.order_number} (${REASON_LABEL[body.reason]}): ${
        result.outcome === 'confirmed' ? 'confirmada pela operadora' : result.outcome === 'processing' ? 'aguardando a confirmação da operadora' : result.outcome === 'failed' ? 'falhou' : 'sem resposta da operadora'
      }`,
      entity: 'payment',
      entityId: id,
      details: { refund_id: result.refund.id, amount_cents: result.refund.amount_cents, reason: body.reason },
    });
    const row = await one<Row>('select p.*, o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    return json({ payment: adminRow(row!, true), refunds: await refundsOfPayment(id), refund: result.refund, outcome: result.outcome, message: result.message }, result.outcome === 'failed' ? 200 : 201);
  });

  // "Conferir devolução": pergunta à operadora o que ela tem desta cobrança e põe tudo em dia (confirmada, falhou, ou nunca registrada).
  r.post('/api/admin/payments/:id/refunds/check', 'owner', async (ctx) => {
    const id = uuidParam(ctx);
    const exists = await one<Row>('select o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    if (!exists) throw new HttpError(404, 'Pagamento não encontrado.');
    await reserve('refund-check', ctx.admin!.id, 600, 30, 'Muitas conferências em pouco tempo. Aguarde e tente de novo.');
    let result;
    try {
      result = await reconcileRefunds(id);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'A operadora não respondeu. Tente de novo em instantes.', { code: 'provider_unavailable' });
    }
    await audit(ctx, { action: 'payment.refund_check', summary: `Conferiu as devoluções do pagamento do pedido #${exists.order_number} na operadora`, entity: 'payment', entityId: id });
    const row = await one<Row>('select p.*, o.order_number from payments p join orders o on o.id = p.order_id where p.id = $1', [id]);
    return json({ payment: adminRow(row!, true), refunds: await refundsOfPayment(id), confirmed_cents: result.confirmedCents, changed: result.changed });
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
