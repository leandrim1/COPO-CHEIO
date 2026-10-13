// Pagamento online: costura o banco (funções payment_*, migration 0014) com a operadora configurada.
//
// O que este módulo garante:
//  • o valor da cobrança e a comissão nascem no banco, do total do pedido; nada disso vem do navegador;
//  • uma cobrança só vira "paga" por um aviso VERIFICADO pela operadora e, quando ela permite consulta, só depois de consultá-la (o corpo
//    do aviso sozinho não confirma dinheiro). Ver o QR Code, voltar para uma página de sucesso ou clicar em "já paguei" nunca confirma nada;
//  • tudo é idempotente: clique repetido, requisição simultânea, aviso repetido ou fora de ordem não duplicam cobrança, pedido nem comissão;
//  • falha ao falar com a operadora nunca confirma nem cancela dinheiro: a cobrança fica sinalizada para conferência;
//  • nenhum segredo, Pix, código completo de cobrança ou dado do pagador vai para o log.
import { createHash } from 'node:crypto';
import { audit } from '../audit.js';
import { batch, one, query } from '../db.js';
import type { Row } from '../db.js';
import { HttpError, readBytes } from '../http.js';
import { applyMerchantObservation } from './merchant.js';
import { getProvider } from './provider.js';
import { ProviderError, providerErrorKind } from './types.js';
import type { ChargeSnapshot, CreatedPix, PaymentProvider, ProviderContext, WebhookEvent } from './types.js';

// Validade do Pix pedido à operadora. A validade que vale é a que ela devolver.
export const PIX_TTL_SECONDS = 15 * 60;
// Quanto esperamos a operadora responder antes de tratar como "sem resposta".
export const PROVIDER_TIMEOUT_MS = 8000;
// Pedido com Pix vencido: o cliente ainda pode gerar outro por este tempo; depois o pedido é cancelado e o estoque volta.
export const RETRY_WINDOW_MINUTES = 10;
// Pedido em que ninguém chegou a gerar o Pix (a pessoa fechou a página): cancelado depois deste tempo.
export const NEVER_PAID_MINUTES = 30;
// Cobrança vencida que a operadora não consegue confirmar é encerrada (e sinalizada) depois deste tempo.
export const LOCAL_EXPIRY_GRACE_MINUTES = 30;
// A operadora dá poucos segundos para o aviso ser respondido: a consulta feita por causa dele tem prazo menor que a das outras.
export const WEBHOOK_LOOKUP_MS = 4000;
// Mínimo entre duas consultas à operadora sobre a mesma cobrança, quando é o cliente quem pergunta (a tela consulta de poucos em poucos segundos).
const CHECK_EVERY_MS = 6000;
// Mínimo entre duas varreduras na mesma instância do servidor.
const SWEEP_EVERY_MS = 20_000;

export type PaymentStatus = 'creating' | 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

// Uma linha de `payments`, com as datas em texto ISO.
export type PaymentRow = {
  id: string;
  order_id: string;
  attempt: number;
  provider: string;
  method: 'pix';
  merchant_account_id: string | null;
  status: PaymentStatus;
  provider_status: string | null;
  provider_charge_id: string | null;
  amount_cents: number;
  commission_bps: number;
  commission_cents: number;
  commission_state: 'calculated' | 'confirmed' | 'failed' | 'not_applicable';
  commission_confirmed_cents: number | null;
  fee_cents: number | null;
  net_cents: number | null;
  refunded_cents: number;
  pix_payload: string | null;
  expires_at: string | null;
  paid_at: string | null;
  paid_seq: number | null;
  closed_at: string | null;
  checked_at: string | null;
  last_error: string | null;
  needs_attention: boolean;
  attention_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type ApplyResult = {
  outcome: 'applied' | 'stale' | 'ignored' | 'needs_attention';
  changed: boolean;
  released: boolean;
  payment: PaymentRow;
  order_status: string;
  order_number: number;
};

const UNAVAILABLE = 'O pagamento online não está disponível agora. Fale com a loja.';
const TRY_AGAIN = 'Não foi possível gerar o Pix agora. Tente de novo em instantes.';

function log(msg: string, fields: Row = {}): void {
  console.log(JSON.stringify({ level: 'info', area: 'pagamentos', msg, ...fields }));
}

const brl = (cents: number) => `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;

const isoOrNull = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

// Linha do banco (datas como Date) ou JSON de uma função (datas como texto) → PaymentRow.
export function normalizePayment(row: Row): PaymentRow {
  return {
    ...(row as PaymentRow),
    expires_at: isoOrNull(row.expires_at),
    paid_at: isoOrNull(row.paid_at),
    closed_at: isoOrNull(row.closed_at),
    checked_at: isoOrNull(row.checked_at),
    created_at: isoOrNull(row.created_at) ?? new Date(0).toISOString(),
    updated_at: isoOrNull(row.updated_at) ?? new Date(0).toISOString(),
    paid_seq: row.paid_seq === null || row.paid_seq === undefined ? null : Number(row.paid_seq),
  };
}

function withTimeout<T>(promise: Promise<T>, ms = PROVIDER_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ProviderError('unavailable', 'tempo esgotado')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---- Do que a operadora disse para o que o banco entende ---------------------------------------------------------------------------

const STATUSES = new Set(['pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded']);
const SPLIT_STATES = new Set(['applied', 'failed', 'pending', 'none']);
const integer = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

export function toObservation(snapshot: ChargeSnapshot): Row | null {
  if (!STATUSES.has(snapshot.status)) return null;
  const split = snapshot.split && SPLIT_STATES.has(snapshot.split.state) ? snapshot.split : null;
  return {
    status: snapshot.status,
    provider_status: snapshot.providerStatus ?? null,
    amount_cents: integer(snapshot.amountCents),
    fee_cents: integer(snapshot.feeCents),
    net_cents: integer(snapshot.netCents),
    refunded_cents: integer(snapshot.refundedCents),
    paid_at: snapshot.paidAt instanceof Date && !Number.isNaN(snapshot.paidAt.getTime()) ? snapshot.paidAt.toISOString() : null,
    detail: snapshot.detail ?? null,
    split: split ? { state: split.state, commission_cents: integer(split.commissionCents), detail: split.detail ?? null } : null,
  };
}

// Registra no histórico de atividades o que o sistema fez sozinho com o dinheiro (quem leu o painel precisa poder conferir).
async function auditResult(result: ApplyResult, source: string): Promise<void> {
  if (!result.changed) return;
  const { payment, order_number: n } = result;
  const line: Record<string, [string, string]> = {
    paid: ['payment.paid', `Pix do pedido #${n} confirmado (${brl(payment.amount_cents)})`],
    expired: ['payment.expired', `Pix do pedido #${n} venceu sem pagamento`],
    cancelled: ['payment.cancelled', `Pix do pedido #${n} cancelado`],
    failed: ['payment.failed', `Pix do pedido #${n} recusado pela operadora`],
    refunded: ['payment.refunded', `Pix do pedido #${n} estornado (${brl(payment.refunded_cents)})`],
  };
  const entry = line[payment.status];
  if (entry) {
    await audit({ admin: null, ip: 'unknown' }, { action: entry[0], summary: entry[1], entity: 'payment', entityId: payment.id, details: { source, commission_state: payment.commission_state } });
  }
  if (result.outcome === 'needs_attention') {
    await audit(
      { admin: null, ip: 'unknown' },
      { action: 'payment.attention', summary: `Pagamento do pedido #${n} precisa de conferência: ${payment.attention_reason ?? 'sem detalhe'}`, entity: 'payment', entityId: payment.id },
    );
  }
}

export async function applySnapshot(paymentId: string, snapshot: ChargeSnapshot, source: 'webhook' | 'lookup' | 'admin'): Promise<ApplyResult | null> {
  const observation = toObservation(snapshot);
  if (!observation) return null;
  const row = await one<{ r: Row }>('select payment_apply($1::uuid, $2::jsonb, $3) as r', [paymentId, JSON.stringify(observation), source]);
  let result = { ...(row!.r as ApplyResult), payment: normalizePayment(row!.r.payment) };
  // Disputa ou chargeback: o dinheiro entrou (a cobrança continua "paga"), mas pode ser desfeito pelo banco. Fica sinalizado para o dono.
  if (snapshot.disputed) {
    const note = snapshot.detail ?? 'A operadora informa disputa ou devolução pelo banco nesta cobrança. Confira na operadora.';
    const flagged = await one<Row>(
      `update payments
          set needs_attention = true,
              attention_reason = left(case when attention_reason is null then $2
                                           when position($2 in attention_reason) > 0 then attention_reason
                                           else attention_reason || ' ' || $2 end, 300)
        where id = $1::uuid
        returning *`,
      [paymentId, note],
    );
    if (flagged) result = { ...result, payment: normalizePayment(flagged), outcome: result.outcome === 'applied' ? 'needs_attention' : result.outcome };
  }
  log('cobrança atualizada', { payment: paymentId, status: result.payment.status, outcome: result.outcome, released: result.released, source });
  await auditResult(result, source);
  return result;
}

// ---- Criar a cobrança --------------------------------------------------------------------------------------------------------------

export async function startPixPayment(orderId: string): Promise<{ payment: PaymentRow; created: boolean }> {
  const provider = getProvider();
  if (!provider) throw new HttpError(503, UNAVAILABLE, { code: 'payments_unavailable' });

  // Um Pix anterior do mesmo pedido que já venceu é cancelado na operadora ANTES de abrir o novo: assim só um QR Code vale por vez.
  const overdue = await query<Row>(`select id from payments where order_id = $1::uuid and status = 'pending' and expires_at < now()`, [orderId]);
  for (const old of overdue) await settleOverdue(String(old.id)).catch(() => undefined);

  // Tranca o pedido e abre a tentativa (ou devolve a que já está em andamento): é aqui que cliques repetidos viram uma só cobrança.
  const begun = await one<{ r: { created: boolean; payment: Row; order_number: number; merchant_account?: string } }>(
    'select payment_begin($1::uuid, $2, $3) as r',
    [orderId, 'pix', provider.name],
  );
  const { created, payment: began, order_number: orderNumber, merchant_account: merchant } = begun!.r;
  if (!created) return { payment: normalizePayment(began), created: false };

  let pix: CreatedPix;
  try {
    pix = await withTimeout(
      provider.createPixCharge({
        paymentId: String(began.id),
        orderNumber,
        amountCents: Number(began.amount_cents),
        commissionCents: Number(began.commission_cents),
        merchantAccountId: String(merchant),
        expiresInSeconds: PIX_TTL_SECONDS,
        description: `Pedido #${orderNumber}`,
      }),
    );
    // Resposta da operadora fora do esperado: tratada como sem resposta (a cobrança pode existir lá).
    const valid =
      typeof pix?.providerChargeId === 'string' && pix.providerChargeId.length > 0 && pix.providerChargeId.length <= 120 &&
      typeof pix.qrPayload === 'string' && pix.qrPayload.length > 0 && pix.qrPayload.length <= 2048 &&
      pix.expiresAt instanceof Date && pix.expiresAt.getTime() > Date.now();
    if (!valid) throw new ProviderError('unavailable', 'resposta inesperada');
  } catch (error) {
    const kind = providerErrorKind(error);
    const definitive = kind === 'rejected';
    await one('select payment_mark_failed($1::uuid, $2, $3)', [began.id, definitive ? 'recusado pela operadora' : 'sem resposta da operadora', !definitive]);
    log('Pix não criado', { payment: began.id, kind: kind ?? 'erro', definitive });
    throw new HttpError(definitive ? 502 : 503, TRY_AGAIN, { code: definitive ? 'provider_rejected' : 'provider_unavailable' });
  }

  const marked = await one<{ r: { updated: boolean; payment: Row } }>('select payment_mark_created($1::uuid, $2, $3, $4::timestamptz, $5) as r', [
    began.id,
    pix.providerChargeId,
    pix.qrPayload,
    pix.expiresAt.toISOString(),
    pix.providerStatus ?? null,
  ]);
  const payment = normalizePayment(marked!.r.payment);
  if (!marked!.r.updated) throw new HttpError(409, 'Este pedido não está mais aguardando pagamento.', { code: 'order_closed' });
  log('Pix criado', { payment: payment.id, attempt: payment.attempt });
  return { payment, created: true };
}

// ---- Consultar a operadora ---------------------------------------------------------------------------------------------------------

// Última vez que perguntamos à operadora sobre cada cobrança (por instância do servidor): a tela do cliente não faz a operadora ser consultada a cada piscada.
const askedAt = new Map<string, number>();
function dueToAsk(paymentId: string): boolean {
  const now = Date.now();
  if (askedAt.size > 500) for (const [id, at] of askedAt) if (now - at > 60_000) askedAt.delete(id);
  const last = askedAt.get(paymentId) ?? 0;
  if (now - last < CHECK_EVERY_MS) return false;
  askedAt.set(paymentId, now);
  return true;
}

// O que a operadora precisa saber de uma cobrança em toda consulta: a conta do estabelecimento e a comissão que a loja calculou.
async function contextOf(paymentId: string): Promise<{ row: Row; ctx: ProviderContext } | null> {
  const row = await one<Row>(
    `select p.id, p.provider, p.status, p.provider_charge_id, p.expires_at, p.amount_cents, p.commission_cents, m.provider_account_id
       from payments p left join merchant_accounts m on m.id = p.merchant_account_id
      where p.id = $1::uuid`,
    [paymentId],
  );
  if (!row) return null;
  return { row, ctx: { merchantAccountId: (row.provider_account_id as string | null) ?? null, commissionCents: Number(row.commission_cents) } };
}

// Pergunta à operadora como está a cobrança e aplica a resposta. null = não há como perguntar (sem operadora ou sem consulta).
export async function refreshPayment(paymentId: string, source: 'lookup' | 'admin' = 'lookup'): Promise<ApplyResult | null> {
  const found = await contextOf(paymentId);
  if (!found || !found.row.provider_charge_id) return null;
  const provider = getProvider();
  if (!provider || provider.name !== found.row.provider || !provider.canLookup) return null;
  const snapshot = await withTimeout(provider.getCharge(String(found.row.provider_charge_id), found.ctx));
  // A resposta precisa ser da cobrança que perguntamos.
  if (snapshot.providerChargeId !== found.row.provider_charge_id) throw new ProviderError('unavailable', 'resposta de outra cobrança');
  return applySnapshot(paymentId, snapshot, source);
}

// Pix que passou da validade da loja. A operadora pode manter o QR Code valendo por mais tempo; então, antes de encerrar aqui, confere se
// não foi pago agora mesmo, CANCELA a cobrança lá (o QR Code deixa de aceitar pagamento) e só então a encerra como vencida. Se não der
// para cancelar (operadora fora do ar), a cobrança continua em aberto e a próxima conferência tenta de novo; depois da tolerância
// (payment_expire_local) ela é encerrada aqui, sinalizada. Devolve o estado da cobrança depois da tentativa.
export async function settleOverdue(paymentId: string): Promise<PaymentStatus | null> {
  const found = await contextOf(paymentId);
  if (!found) return null;
  const { row, ctx } = found;
  const status = String(row.status) as PaymentStatus;
  const overdue = row.expires_at !== null && new Date(String(row.expires_at)).getTime() < Date.now();
  if (status !== 'pending' || !overdue || !row.provider_charge_id) return status;
  const provider = getProvider();
  if (!provider || provider.name !== row.provider || !provider.canLookup) return status;
  const chargeId = String(row.provider_charge_id);
  const current = async (): Promise<PaymentStatus> => {
    const result = await refreshPayment(paymentId, 'lookup');
    return (result?.payment.status ?? status) as PaymentStatus;
  };
  // 1) Pode ter sido pago (ou encerrado) pela própria operadora desde a última conferência.
  const first = await current();
  if (first !== 'pending') return first;
  // Operadora que não permite cancelar: só resta esperar a validade dela (ou a tolerância, que encerra aqui, sinalizada).
  if (!provider.cancelCharge) return first;
  // 2) Cancela lá. "Não está mais em aberto": a operadora mudou a cobrança no meio do caminho; ela diz o que aconteceu.
  const cancel = await withTimeout(provider.cancelCharge(chargeId, ctx));
  if (cancel.cancelled) {
    await applySnapshot(paymentId, { providerChargeId: chargeId, status: 'expired', providerStatus: 'CANCELED', amountCents: Number(row.amount_cents) }, 'lookup');
    log('Pix vencido cancelado na operadora', { payment: paymentId });
  } else if (cancel.reason === 'not_cancelable') {
    return current();
  } else {
    return 'pending';
  }
  const after = await one<{ status: PaymentStatus }>('select status from payments where id = $1::uuid', [paymentId]);
  return after?.status ?? null;
}

// ---- O que o cliente vê ------------------------------------------------------------------------------------------------------------

export type PaymentView = {
  id: string;
  status: PaymentStatus;
  method: 'pix';
  amount: number;
  attempt: number;
  expires_at: string | null;
  // O Pix "copia e cola": só enquanto aguarda o pagamento.
  pix: { payload: string } | null;
  can_retry: boolean;
  retry_until: string | null;
  message: string | null;
};

export type CustomerPayment = { payment: PaymentView | null; order_status: string; payment_status: string };

async function loadLatest(orderId: string): Promise<{ order: Row; payment: PaymentRow | null; attempts: number }> {
  const [orders, payments, counts] = await batch([
    ['select order_status, payment_status, payment_method, total from orders where id = $1::uuid', [orderId]],
    ['select * from payments where order_id = $1::uuid order by created_at desc limit 1', [orderId]],
    ['select count(*) as n from payments where order_id = $1::uuid', [orderId]],
  ]);
  if (!orders[0]) throw new HttpError(404, 'Pedido não encontrado.');
  return { order: orders[0], payment: payments[0] ? normalizePayment(payments[0]) : null, attempts: counts[0]?.n ?? 0 };
}

function messageFor(payment: PaymentRow, orderStatus: string): string | null {
  if (payment.status === 'paid' || payment.status === 'refunded') {
    if (orderStatus === 'cancelled') return 'Recebemos o pagamento, mas o pedido já tinha sido cancelado. A loja vai devolver o valor.';
    return payment.status === 'refunded' ? 'O pagamento foi estornado.' : null;
  }
  if (payment.status === 'expired') return 'O Pix venceu sem pagamento.';
  if (payment.status === 'cancelled') return 'Este Pix foi cancelado.';
  if (payment.status === 'failed') return 'Não foi possível gerar o Pix.';
  return null;
}

export function toView(order: Row, payment: PaymentRow, attempts: number): PaymentView {
  const pending = payment.status === 'pending';
  const retryable = ['expired', 'failed', 'cancelled'].includes(payment.status) && order.order_status === 'awaiting_payment' && attempts < 5;
  const closed = payment.closed_at ? new Date(payment.closed_at).getTime() : null;
  return {
    id: payment.id,
    status: payment.status,
    method: payment.method,
    amount: payment.amount_cents / 100,
    attempt: payment.attempt,
    expires_at: payment.expires_at,
    pix: pending && payment.pix_payload ? { payload: payment.pix_payload } : null,
    can_retry: retryable,
    retry_until: retryable && closed !== null ? new Date(closed + RETRY_WINDOW_MINUTES * 60_000).toISOString() : null,
    message: messageFor(payment, String(order.order_status)),
  };
}

// A situação do pagamento de um pedido, para a página do cliente. Com `refresh`, pergunta à operadora enquanto aguarda o pagamento
// (cobre o aviso que atrasou ou se perdeu), no máximo a cada poucos segundos.
export async function customerPaymentView(orderId: string, opts: { refresh: boolean }): Promise<CustomerPayment> {
  let state = await loadLatest(orderId);
  if (state.payment?.status === 'pending') {
    const overdue = state.payment.expires_at !== null && new Date(state.payment.expires_at).getTime() < Date.now();
    // Venceu: confere, cancela na operadora e encerra já (a tela do cliente passa a mostrar "O Pix venceu" na hora, sem esperar a conferência periódica).
    if (opts.refresh && (overdue || dueToAsk(state.payment.id))) {
      try {
        if (overdue) await settleOverdue(state.payment.id);
        else await refreshPayment(state.payment.id, 'lookup');
      } catch (error) {
        log('consulta à operadora falhou', { payment: state.payment.id, kind: providerErrorKind(error) ?? 'erro' });
      }
    }
    // Venceu há muito tempo e a operadora não consegue confirmar: encerra (sinalizada) para o estoque não ficar preso.
    await one('select payment_expire_local($1::uuid, $2)', [state.payment.id, LOCAL_EXPIRY_GRACE_MINUTES]).catch(() => undefined);
    state = await loadLatest(orderId);
  }
  return {
    payment: state.payment ? toView(state.order, state.payment, state.attempts) : null,
    order_status: String(state.order.order_status),
    payment_status: String(state.order.payment_status),
  };
}

// ---- Avisos (webhooks) -------------------------------------------------------------------------------------------------------------

async function processEvent(provider: PaymentProvider, event: WebhookEvent): Promise<void> {
  // Chave de deduplicação curta: avisos com identificador enorme viram um resumo.
  const key = event.dedupeKey.length > 150 ? createHash('sha256').update(event.dedupeKey).digest('hex') : event.dedupeKey;
  const begun = await one<{ r: { id: string; duplicate: boolean } }>('select payment_event_begin($1, $2, $3, $4, $5, $6) as r', [
    provider.name,
    key,
    event.type,
    event.providerChargeId,
    event.snapshot?.status ?? null,
    integer(event.snapshot?.amountCents),
  ]);
  const { id: eventId, duplicate } = begun!.r;
  if (duplicate) return;

  const finish = (paymentId: string | null, outcome: string, detail: string | null) =>
    one('select payment_event_finish($1::uuid, $2::uuid, $3, $4)', [eventId, paymentId, outcome, detail]);

  // Aviso sobre a conta do estabelecimento (cadastro da subconta): atualiza o cadastro que o dono iniciou. Nunca cria conta sozinho.
  if (event.merchant) {
    try {
      const outcome = await applyMerchantObservation(provider.name, event.merchant);
      await finish(null, outcome, null);
    } catch (error) {
      await finish(null, 'error', 'falha ao processar').catch(() => undefined);
      throw error;
    }
    return;
  }
  // Aviso que a loja só registra (assinaturas, criação de cobrança, MED...): fica no histórico e nada mais.
  if (event.informational) {
    await finish(null, 'ignored', 'aviso informativo');
    return;
  }

  const payment = await one<Row>(
    `select id, provider_charge_id from payments
      where provider = $1 and (($2::text is not null and provider_charge_id = $2) or ($3::text is not null and id::text = $3))
      order by created_at desc limit 1`,
    [provider.name, event.providerChargeId, event.reference],
  );
  if (!payment) {
    await finish(null, 'unknown_charge', 'cobrança desconhecida');
    return;
  }

  try {
    // Achou pela referência da loja (a resposta da criação se perdeu): guarda o código da cobrança para as próximas conferências.
    if (!payment.provider_charge_id && event.providerChargeId) {
      await one('update payments set provider_charge_id = $2 where id = $1::uuid and provider_charge_id is null', [payment.id, event.providerChargeId]).catch(() => undefined);
      payment.provider_charge_id = event.providerChargeId;
    }
    // A fonte do estado é a operadora: o aviso só diz "olhe a cobrança X". Se ela não permite consulta, vale o aviso verificado.
    // A operadora espera resposta em poucos segundos: a consulta tem prazo curto; se estourar, o aviso é reenviado (e a tela do cliente também confere).
    const chargeId = String(payment.provider_charge_id ?? event.providerChargeId ?? '');
    let snapshot: ChargeSnapshot | null;
    if (provider.canLookup && chargeId) {
      const found = await contextOf(String(payment.id));
      snapshot = await withTimeout(provider.getCharge(chargeId, found?.ctx), WEBHOOK_LOOKUP_MS);
      if (snapshot.providerChargeId !== chargeId) throw new ProviderError('unavailable', 'resposta de outra cobrança');
    } else {
      snapshot = event.snapshot;
    }
    if (!snapshot) {
      await finish(String(payment.id), 'ignored', 'aviso sem dados da cobrança');
      return;
    }
    const result = await applySnapshot(String(payment.id), snapshot, 'webhook');
    await finish(String(payment.id), result?.outcome ?? 'ignored', null);
  } catch (error) {
    // Não processado até o fim: o aviso volta a ser processado na próxima entrega (processed_at continua vazio).
    await finish(String(payment.id), 'error', providerErrorKind(error) ?? 'falha ao processar').catch(() => undefined);
    throw error;
  }
}

// Recebe um aviso da operadora. Autenticidade primeiro: sem ela, nada é gravado e nada muda.
export async function handleWebhook(req: Request): Promise<{ received: number }> {
  const provider = getProvider();
  if (!provider) throw new HttpError(503, UNAVAILABLE, { code: 'payments_unavailable' });
  const raw = await readBytes(req, 256 * 1024);
  let events: WebhookEvent[];
  try {
    events = await provider.verifyWebhook(raw, req.headers);
  } catch (error) {
    const kind = providerErrorKind(error);
    if (kind === 'invalid_webhook') {
      log('aviso recusado: não autêntico');
      throw new HttpError(401, 'Não autorizado.');
    }
    if (kind === 'malformed_webhook') throw new HttpError(400, 'Aviso inválido.');
    throw new HttpError(503, 'Não foi possível processar agora. Tente de novo.');
  }
  // Uma chamada com avisos demais não é de uma operadora honesta: recusa em vez de ignorar parte em silêncio.
  if (events.length > 100) throw new HttpError(400, 'Aviso inválido.');
  let failed = false;
  for (const event of events) {
    try {
      await processEvent(provider, event);
    } catch (error) {
      failed = true;
      log('aviso não processado', { kind: providerErrorKind(error) ?? 'erro' });
    }
  }
  // Algum aviso não foi até o fim (operadora ou banco fora do ar): resposta de erro para ela reenviar.
  if (failed) throw new HttpError(503, 'Não foi possível processar agora. Tente de novo.');
  return { received: events.length };
}

// ---- Conferência periódica (sem agendador) -----------------------------------------------------------------------------------------

let lastSweep = 0;

// Fecha o que venceu e cancela o pedido que não foi pago a tempo. Chamada de passagem pelas rotas (painel aberto, pedido novo, tela do
// cliente), no máximo uma vez a cada 20 s por instância. `lookups`: também pergunta à operadora (só nas chamadas do painel, para não
// pôr a espera da operadora na frente do cliente). `force`: ignora o intervalo mínimo (botão "Conferir agora" do dono).
export async function sweep(opts: { lookups?: boolean; force?: boolean; limit?: number } = {}): Promise<{ checked: number; closed: number; cancelled: number }> {
  const out = { checked: 0, closed: 0, cancelled: 0 };
  if (!opts.force && Date.now() - lastSweep < SWEEP_EVERY_MS) return out;
  lastSweep = Date.now();
  const provider = getProvider();
  const due = await query<Row>('select id, status, provider, provider_charge_id, expires_at from payments_due($1)', [opts.limit ?? 5]);
  for (const payment of due) {
    try {
      if (payment.status === 'creating') {
        await one('select payment_mark_failed($1::uuid, $2, true)', [payment.id, 'sem resposta da operadora']);
        out.closed += 1;
        continue;
      }
      if (opts.lookups && provider && provider.name === payment.provider && provider.canLookup && payment.provider_charge_id) {
        const overdue = payment.expires_at !== null && new Date(String(payment.expires_at)).getTime() < Date.now();
        if (overdue) {
          // Venceu: confere, cancela na operadora e encerra.
          const after = await settleOverdue(String(payment.id));
          out.checked += 1;
          if (after !== null && after !== 'pending') {
            out.closed += 1;
            continue;
          }
        } else {
          const result = await refreshPayment(String(payment.id), 'lookup');
          if (result) {
            out.checked += 1;
            if (result.changed) out.closed += 1;
            continue;
          }
        }
      }
    } catch (error) {
      log('conferência falhou', { payment: payment.id, kind: providerErrorKind(error) ?? 'erro' });
    }
    // Sem como confirmar na operadora: só encerra (sinalizada) o que venceu há muito tempo.
    const local = await one<{ r: { changed: boolean } }>('select payment_expire_local($1::uuid, $2) as r', [payment.id, LOCAL_EXPIRY_GRACE_MINUTES]).catch(() => null);
    if (local?.r.changed) out.closed += 1;
  }
  const cancelled = await one<{ n: number }>('select orders_cancel_unpaid($1, $2) as n', [RETRY_WINDOW_MINUTES, NEVER_PAID_MINUTES]);
  out.cancelled = cancelled?.n ?? 0;
  if (out.checked || out.closed || out.cancelled) log('conferência', out);
  return out;
}

// ---- O pagamento online está pronto para ser ligado? ---------------------------------------------------------------------------------

export type Readiness = { provider: string | null; merchant: string | null; ready: boolean };

export async function onlineReadiness(): Promise<Readiness> {
  const provider = getProvider();
  if (!provider) return { provider: null, merchant: null, ready: false };
  const merchant = await one<{ status: string; fees: string | null }>(
    `select status, fees_acknowledged_at as fees from merchant_accounts where provider = $1 order by (status = 'approved') desc, created_at desc limit 1`,
    [provider.name],
  );
  // Em produção a conta só vale se o dono declarou conhecer as tarifas (registrado ao vincular ou cadastrar a conta).
  const productionNeedsFees = provider.merchant?.environment === 'production';
  return { provider: provider.name, merchant: merchant?.status ?? null, ready: merchant?.status === 'approved' && (!productionNeedsFees || merchant.fees !== null) };
}
