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
import { FEE_TOLERANCE_CENTS } from './cardFee.js';
import { applyMerchantObservation } from './merchant.js';
import { getProvider } from './provider.js';
import { ProviderError, providerErrorKind } from './types.js';
import type { CardChargeResult, ChargeSnapshot, CreatedPix, PaymentProvider, ProviderContext, WebhookEvent } from './types.js';

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
// Cobrança no cartão: o banco do cliente pode demorar para autorizar (a ValidaPay responde na hora, mas esperamos mais que nas outras chamadas).
export const CARD_TIMEOUT_MS = 28_000;

export type PaymentStatus = 'creating' | 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

// Uma linha de `payments`, com as datas em texto ISO.
export type PaymentRow = {
  id: string;
  order_id: string;
  attempt: number;
  provider: string;
  method: 'pix' | 'card';
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
  // Taxa do cartão que está dentro de amount_cents (0 no Pix) e quantas vezes esta tentativa foi enviada à operadora.
  customer_fee_cents: number;
  card_attempts: number;
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
  const what = payment.method === 'card' ? 'Cartão' : 'Pix';
  const line: Record<string, [string, string]> = {
    paid: ['payment.paid', `${what} do pedido #${n} confirmado (${brl(payment.amount_cents)})`],
    expired: ['payment.expired', `${what} do pedido #${n} venceu sem pagamento`],
    cancelled: ['payment.cancelled', `${what} do pedido #${n} cancelado`],
    failed: ['payment.failed', `${what} do pedido #${n} recusado pela operadora`],
    refunded: ['payment.refunded', `${what} do pedido #${n} estornado (${brl(payment.refunded_cents)})`],
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
  // Cartão: a tarifa que a operadora informou tem de bater com a taxa que o cliente pagou (a operadora arredonda a seu modo: até 1 centavo é
  // normal). Diferença maior é sinalizada ao dono; o pedido NÃO fica retido por isso (o cliente pagou o valor certo), mas o dono precisa saber
  // que a taxa configurada não é a do contrato (a loja estaria pagando a diferença, ou o cliente pagando a mais).
  if (result.payment.method === 'card' && result.payment.status === 'paid' && typeof snapshot.feeCents === 'number') {
    const customerFee = result.payment.customer_fee_cents;
    const diff = snapshot.feeCents - customerFee;
    if (Math.abs(diff) > FEE_TOLERANCE_CENTS) {
      const note =
        diff > 0
          ? `Tarifa da ValidaPay (${brl(snapshot.feeCents)}) MAIOR que a taxa cobrada do cliente (${brl(customerFee)}): a loja paga a diferença de ${brl(diff)}. Confira a taxa do cartão em Pagamentos.`
          : `Tarifa da ValidaPay (${brl(snapshot.feeCents)}) menor que a taxa cobrada do cliente (${brl(customerFee)}): o cliente pagou ${brl(-diff)} a mais. Confira a taxa do cartão em Pagamentos.`;
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


// ---- Cobrar no cartão ----------------------------------------------------------------------------------------------------------------

// O que o navegador manda: o TOKEN do cartão e o identificador do dispositivo (gerados pelo SDK da operadora, no navegador) e o CPF/CNPJ do pagador.
// Número do cartão e CVV nunca chegam aqui.
export type CardInput = { cardToken: string; deviceId: string; document: string };

const CARD_UNAVAILABLE = 'O pagamento por cartão não está disponível agora. Escolha outra forma de pagamento ou fale com a loja.';

// Por que a operadora recusou o pedido de cobrança (definitivo: nada foi cobrado), em português e sem repetir o que ela escreveu.
function cardRejectionMessage(code: string | undefined): { message: string; status: number } {
  switch (code) {
    case 'CARD_TOKEN_EXPIRED':
    case 'CARD_TOKEN_NOT_FOUND':
      return { message: 'O tempo para pagar acabou. Digite os dados do cartão de novo.', status: 400 };
    case 'MISSING_CARD_DATA':
    case 'CARD_DATA':
    case 'DOCUMENT':
      return { message: 'Confira os dados do cartão e o CPF e tente de novo.', status: 400 };
    case 'CUSTOMER_PHONE_REQUIRED':
      return { message: 'A operadora do cartão pediu um telefone válido. Fale com a loja.', status: 400 };
    case 'TOKEN_UNAVAILABLE':
    case 'TOKEN_REJECTED':
      return { message: CARD_UNAVAILABLE, status: 503 };
    default:
      return { message: 'Não foi possível processar o cartão agora. Tente de novo ou escolha outra forma de pagamento.', status: 502 };
  }
}

// Cobra o pedido no cartão de crédito. O valor vem do pedido gravado no banco (itens + entrega + taxa do cartão), nunca do navegador, e é o MESMO
// que o cliente viu. Sem duplicar: uma tentativa em andamento nunca dá lugar a outra enquanto não tiver resultado, e refazer a mesma tentativa
// manda à operadora o mesmo identificador (externalId), que por isso não cobra duas vezes. O pedido só é liberado pela operadora (consulta da
// cobrança + valor conferido em payment_apply): a resposta da criação sozinha não libera nada.
export async function startCardPayment(orderId: string, input: CardInput): Promise<PaymentRow> {
  const provider = getProvider();
  if (!provider || !provider.createCardCharge || !provider.cardCheckout) throw new HttpError(503, CARD_UNAVAILABLE, { code: 'payments_unavailable' });

  const order = await one<Row>('select order_number, customer_name, customer_phone, customer_email from orders where id = $1::uuid', [orderId]);
  if (!order) throw new HttpError(404, 'Pedido não encontrado.');
  const email = typeof order.customer_email === 'string' ? order.customer_email : '';
  if (!email) throw new HttpError(400, 'Este pedido não tem e-mail. Fale com a loja.', { code: 'email_required' });

  const begun = await one<{ r: { created: boolean; busy: boolean; retry: boolean; payment: Row; order_number: number; merchant_account: string } }>('select payment_begin_card($1::uuid, $2) as r', [orderId, provider.name]);
  const { created, busy, retry, payment: began, merchant_account: merchant } = begun!.r;
  if (busy) throw new HttpError(409, 'Seu pagamento está sendo processado. Aguarde alguns segundos e não pague de novo.', { code: 'payment_in_progress' });
  const paymentId = String(began.id);

  // Já aguardando a confirmação da operadora (ela ainda não decidiu): não cobra de novo, só confere.
  if (!created && !retry) {
    await refreshPayment(paymentId, 'lookup').catch(() => undefined);
    return normalizePayment((await one<Row>('select * from payments where id = $1::uuid', [paymentId]))!);
  }

  let charge: CardChargeResult;
  try {
    charge = await withTimeout(
      provider.createCardCharge({
        paymentId,
        orderNumber: Number(order.order_number),
        amountCents: Number(began.amount_cents),
        cardToken: input.cardToken,
        deviceId: input.deviceId,
        customer: { name: String(order.customer_name), email, document: input.document, phone: String(order.customer_phone) },
        merchantAccountId: String(merchant),
        description: `Pedido #${order.order_number}`,
      }),
      CARD_TIMEOUT_MS,
    );
  } catch (error) {
    const kind = providerErrorKind(error);
    if (kind === 'rejected') {
      // A operadora recusou o pedido de cobrança (token vencido, dado inválido, credencial): nada foi cobrado. Encerra esta tentativa.
      const code = (error as ProviderError).code;
      await one('select payment_mark_failed($1::uuid, $2, false)', [paymentId, `recusado pela operadora${code ? `: ${code}` : ''}`]);
      log('cartão não cobrado', { payment: paymentId, code: code ?? null });
      const { message, status } = cardRejectionMessage(code);
      throw new HttpError(status, message, { code: 'card_rejected' });
    }
    // Sem resposta (tempo esgotado ou erro da operadora): o cartão PODE ter sido cobrado. A tentativa continua aberta (nunca vira outra
    // cobrança); refazê-la usa o mesmo identificador e a operadora devolve a cobrança original em vez de cobrar de novo.
    log('cartão sem resposta', { payment: paymentId, kind: kind ?? 'erro' });
    throw new HttpError(503, 'Não conseguimos confirmar o pagamento agora. Não pague de novo ainda: aguarde um minuto nesta tela. Se o valor aparecer na sua fatura e o pedido não for confirmado, a loja confere.', { code: 'card_unconfirmed' });
  }

  // Guarda o código da cobrança (a partir daqui o aviso da operadora e a conferência a reconhecem).
  await one('select payment_card_mark_charge($1::uuid, $2, $3)', [paymentId, charge.providerChargeId, charge.providerStatus ?? null]);
  if (charge.outcome === 'declined') {
    await applySnapshot(paymentId, { providerChargeId: charge.providerChargeId, status: 'failed', providerStatus: 'FAILED', amountCents: Number(began.amount_cents), detail: charge.reason ?? 'Cartão recusado' }, 'lookup');
  } else {
    // paga, duplicada (a operadora já conhecia a tentativa) ou em processamento: quem confirma é a CONSULTA à operadora (traz também a tarifa e o
    // valor pago). Se a consulta falhar agora, a cobrança fica "aguardando" e o aviso assinado da operadora ou a conferência periódica concluem.
    await refreshPayment(paymentId, 'lookup').catch((error) => log('consulta depois da cobrança falhou', { payment: paymentId, kind: providerErrorKind(error) ?? 'erro' }));
  }
  log('cartão processado', { payment: paymentId, outcome: charge.outcome, retry });
  return normalizePayment((await one<Row>('select * from payments where id = $1::uuid', [paymentId]))!);
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

// ---- Pedido cancelado: a cobrança Pix em aberto também é cancelada na operadora ------------------------------------------------------------------------

// As cobranças Pix ainda em aberto de um pedido. A consulta vem ANTES do cancelamento: depois dele o banco já as marcou como canceladas.
export async function openPixCharges(orderId: string): Promise<{ id: string; chargeId: string }[]> {
  const rows = await query<Row>(
    `select id, provider_charge_id from payments where order_id = $1::uuid and method = 'pix' and status = 'pending' and provider_charge_id is not null`,
    [orderId],
  );
  return rows.map((row) => ({ id: String(row.id), chargeId: String(row.provider_charge_id) }));
}

// Depois de o pedido ser cancelado (pelo cliente ou pela loja): o QR Code deixa de aceitar pagamento. Melhor esforço, nunca derruba o cancelamento: se a
// operadora não cancela (fora do ar, não conhece a cobrança, ela já foi paga) o pagamento fica sinalizado no painel com o que fazer. Sem isto, quem pagasse o
// QR Code de um pedido cancelado só seria notado quando o aviso da operadora chegasse.
export async function cancelProviderCharges(charges: { id: string; chargeId: string }[]): Promise<void> {
  const provider = getProvider();
  for (const charge of charges) {
    let reason: string | null = null;
    try {
      const found = await contextOf(charge.id);
      if (!provider || !provider.cancelCharge || (found && provider.name !== found.row.provider)) {
        reason = 'Pedido cancelado com o Pix em aberto na operadora. Cancele a cobrança lá para ninguém pagar um pedido cancelado.';
      } else {
        const result = await withTimeout(provider.cancelCharge(charge.chargeId, found?.ctx));
        if (!result.cancelled) {
          reason =
            result.reason === 'not_found'
              ? 'A operadora não encontrou a cobrança deste Pix. Confira lá se ele existe e cancele-o.'
              : 'O Pix foi pago ou encerrado na operadora enquanto o pedido era cancelado. Confira lá e devolva o valor ao cliente se ele pagou.';
        }
      }
    } catch (error) {
      reason = 'Não foi possível cancelar o Pix na operadora. Cancele a cobrança lá para ninguém pagar um pedido cancelado.';
      log('cancelamento do Pix na operadora falhou', { payment: charge.id, kind: providerErrorKind(error) ?? 'erro' });
    }
    if (reason) await query('update payments set needs_attention = true, attention_reason = $2 where id = $1::uuid', [charge.id, reason]).catch(() => undefined);
  }
}

// ---- Devolução (estorno) pelo painel ------------------------------------------------------------------------------------------------------
//
// Regras: (1) o dinheiro só é "devolvido" quando a operadora CONFIRMA (consulta ou aviso); pedir não é devolver. (2) Nunca duas devoluções abertas para o
// mesmo pagamento (índice no banco). (3) Resposta perdida/tempo esgotado: o pedido fica "aguardando resposta" e NADA é repetido às cegas: antes de qualquer
// nova tentativa o servidor pergunta à operadora o que ela tem (listRefunds). (4) O estado final vem da operadora, a mesma fonte da conciliação dos avisos.

const REFUND_REASONS = ['CUSTOMER_REQUEST', 'FRAUD', 'BANK_ERROR', 'PIX_CHANGE_ERROR'] as const;
export type RefundReasonCode = (typeof REFUND_REASONS)[number];
export const isRefundReason = (value: unknown): value is RefundReasonCode => typeof value === 'string' && (REFUND_REASONS as readonly string[]).includes(value);
// Quanto esperar a operadora ao pedir uma devolução (mais que nas consultas: ela fala com o banco).
const REFUND_TIMEOUT_MS = 12_000;
// Um pedido sem resposta que a operadora não reconhece depois deste tempo é dado como não registrado (e pode ser pedido de novo).
const REFUND_UNKNOWN_MINUTES = 10;

export type RefundRow = {
  id: string;
  payment_id: string;
  order_id: string;
  provider: string;
  provider_refund_id: string | null;
  amount_cents: number;
  reason: RefundReasonCode;
  status: 'requested' | 'processing' | 'confirmed' | 'failed';
  requested_by_name: string | null;
  note: string | null;
  last_error: string | null;
  requested_at: string;
  confirmed_at: string | null;
};

export async function refundsOfPayment(paymentId: string): Promise<RefundRow[]> {
  const rows = await query<Row>(
    `select id, payment_id, order_id, provider, provider_refund_id, amount_cents, reason, status, requested_by_name, note, last_error, requested_at, confirmed_at
       from payment_refunds where payment_id = $1::uuid order by created_at`,
    [paymentId],
  );
  return rows.map((row) => ({ ...(row as unknown as RefundRow), requested_at: isoOrNull(row.requested_at) ?? new Date(0).toISOString(), confirmed_at: isoOrNull(row.confirmed_at) }));
}

function refundProvider(paymentRow: Row | undefined): PaymentProvider & Required<Pick<PaymentProvider, 'listRefunds'>> {
  const provider = getProvider();
  if (!provider || !provider.listRefunds || (paymentRow && provider.name !== paymentRow.provider)) {
    throw new HttpError(409, 'Esta operadora não permite consultar devoluções por aqui. Faça a devolução no painel dela e use “Atualizar pagamento”.', { code: 'refund_unavailable' });
  }
  return provider as PaymentProvider & Required<Pick<PaymentProvider, 'listRefunds'>>;
}

// Pergunta à operadora quais devoluções ela tem desta cobrança e põe os nossos registros em dia: reconhece o pedido cujo código não chegou até nós, marca o que
// foi confirmado ou falhou e, havendo valor devolvido a mais do que sabíamos, aplica no pagamento (e no pedido, se foi total). Quem a operadora devolveu
// pelo painel dela também entra na soma. Devolve o total confirmado pela operadora.
export async function reconcileRefunds(paymentId: string): Promise<{ confirmedCents: number; changed: boolean }> {
  const found = await contextOf(paymentId);
  if (!found || !found.row.provider_charge_id) throw new HttpError(409, 'Este pagamento ainda não tem código na operadora.', { code: 'refund_unavailable' });
  const provider = refundProvider(found.row);
  const chargeId = String(found.row.provider_charge_id);
  const items = await withTimeout(provider.listRefunds(chargeId, found.ctx));
  const rows = await query<Row>('select * from payment_refunds where payment_id = $1::uuid order by created_at', [paymentId]);
  const claimed = new Set<string>(rows.map((row) => row.provider_refund_id as string | null).filter((id): id is string => Boolean(id)));
  let changed = false;

  for (const row of rows) {
    if (row.status === 'confirmed' || row.status === 'failed') continue;
    let item = row.provider_refund_id ? items.find((it) => it.providerRefundId === row.provider_refund_id) : undefined;
    if (!item && !row.provider_refund_id) {
      // O pedido cuja resposta se perdeu: reconhecido pelo valor e por ter sido criado depois do nosso pedido.
      const since = new Date(String(row.requested_at)).getTime() - 2 * 60_000;
      item = items.find((it) => !claimed.has(it.providerRefundId) && it.amountCents === Number(row.amount_cents) && (it.createdAt === null || it.createdAt.getTime() >= since));
      if (item) claimed.add(item.providerRefundId);
    }
    if (item) {
      const updated = await one<Row>('select * from refund_update($1::uuid, $2, $3, $4)', [row.id, item.status, item.providerRefundId, item.error ?? null]);
      changed = changed || updated?.status !== row.status;
    } else if (!row.provider_refund_id && Date.now() - new Date(String(row.requested_at)).getTime() > REFUND_UNKNOWN_MINUTES * 60_000) {
      // A operadora respondeu a consulta e não tem nenhuma devolução assim: o pedido não chegou a ser registrado. Pode ser pedido de novo.
      await one('select * from refund_update($1::uuid, $2, null, $3)', [row.id, 'failed', 'A operadora não registrou este pedido de devolução.']);
      changed = true;
    }
  }

  const confirmedCents = items.filter((it) => it.status === 'confirmed').reduce((sum, it) => sum + it.amountCents, 0);
  const current = await one<Row>('select amount_cents, refunded_cents from payments where id = $1::uuid', [paymentId]);
  if (current && confirmedCents > Number(current.refunded_cents)) {
    const amount = Number(current.amount_cents);
    await applySnapshot(
      paymentId,
      { providerChargeId: chargeId, status: 'refunded', providerStatus: confirmedCents >= amount ? 'REFUNDED' : 'PARTIALLY_REFUNDED', amountCents: amount, refundedCents: Math.min(confirmedCents, amount) },
      'admin',
    );
    changed = true;
  }
  return { confirmedCents, changed };
}

// Pede a devolução à operadora. Quem chama já provou ser o owner. `amountCents` vazio = tudo o que ainda não foi devolvido.
// A devolução pelo painel está disponível para este pagamento? (a operadora é a do pagamento e a devolução pela API foi ligada de propósito)
export function refundAvailable(providerName: string | null | undefined): boolean {
  const provider = getProvider();
  return Boolean(provider && provider.createRefund && provider.listRefunds && provider.name === providerName);
}

export async function requestRefund(opts: { paymentId: string; amountCents: number | null; reason: RefundReasonCode; note: string | null; adminId: string }): Promise<{ refund: RefundRow; outcome: 'processing' | 'confirmed' | 'failed' | 'unknown'; message: string }> {
  const found = await contextOf(opts.paymentId);
  if (!found) throw new HttpError(404, 'Pagamento não encontrado.');
  const provider = getProvider();
  if (!provider || !provider.createRefund || !provider.listRefunds || provider.name !== found.row.provider) {
    throw new HttpError(409, 'A devolução pelo painel está desligada (ou a operadora não permite). Faça a devolução no painel da operadora e depois use “Atualizar pagamento”.', { code: 'refund_unavailable' });
  }
  // Antes de pedir: põe em dia o que a operadora já sabe (uma devolução feita no painel dela, um pedido anterior sem resposta). Sem conseguir conferir, não
  // pede às cegas (poderia devolver em dobro).
  try {
    await reconcileRefunds(opts.paymentId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Não foi possível conferir as devoluções na operadora agora. Tente de novo em instantes.', { code: 'provider_unavailable' });
  }

  const begun = await one<{ r: Row }>('select refund_begin($1::uuid, $2::integer, $3, $4::uuid, $5) as r', [opts.paymentId, opts.amountCents, opts.reason, opts.adminId, opts.note]);
  const draft = begun!.r;
  const refundId = String(draft.id);
  const method = draft.method === 'card' ? 'card' : 'pix';
  const fail = async (message: string): Promise<never> => {
    await one('select * from refund_update($1::uuid, $2, null, $3)', [refundId, 'failed', message]);
    throw new HttpError(422, message, { code: 'refund_rejected' });
  };

  let item;
  try {
    item = await withTimeout(
      provider.createRefund({ providerChargeId: String(draft.provider_charge_id), method, amountCents: Number(draft.amount_cents), reason: opts.reason }, found.ctx),
      REFUND_TIMEOUT_MS,
    );
  } catch (error) {
    const kind = providerErrorKind(error);
    const code = (error as { code?: string }).code;
    if (kind === 'rejected') {
      log('devolução recusada pela operadora', { payment: opts.paymentId, code: code ?? 'sem_codigo' });
      const text: Record<string, string> = {
        REFUND_AMOUNT_EXCEEDED: 'A ValidaPay diz que este valor passa do que ainda pode ser devolvido desta cobrança.',
        CHARGE_WITHOUT_END_TO_END_ID: 'A ValidaPay não encontrou o pagamento Pix desta cobrança (ainda não confirmado ou não é Pix).',
        CHARGE_NOT_FOUND: 'A ValidaPay não encontrou esta cobrança.',
        TOKEN_REJECTED: 'A ValidaPay recusou as credenciais da loja. Confira as variáveis VALIDAPAY_* na Vercel.',
        TOKEN_UNAVAILABLE: 'Não foi possível entrar na ValidaPay agora. Nada foi devolvido.',
      };
      const status = (error as { httpStatus?: number }).httpStatus;
      return fail(text[code ?? ''] ?? (status === 403 || status === 401 ? 'A ValidaPay recusou o pedido: a credencial da loja pode não ter permissão para devolver (escopo wallet/write). Nada foi devolvido.' : `A ValidaPay recusou o pedido de devolução${code ? ` (${code})` : ''}. Nada foi devolvido.`));
    }
    // Sem resposta / resposta que não dá para entender: a operadora PODE ter criado a devolução. O pedido fica "aguardando resposta" e o painel avisa.
    log('devolução sem resposta da operadora', { payment: opts.paymentId, kind: kind ?? 'erro' });
    await query('update payment_refunds set last_error = $2 where id = $1::uuid', [refundId, 'Sem resposta da operadora: a devolução pode ou não ter sido criada. Confira antes de pedir de novo.']);
    await query('update payments set needs_attention = true, attention_reason = left(coalesce(attention_reason || \' \', \'\') || $2, 300) where id = $1::uuid', [
      opts.paymentId,
      'Pedido de devolução sem resposta da operadora: confira se a devolução existe antes de pedir de novo.',
    ]);
    const refund = (await refundsOfPayment(opts.paymentId)).find((r) => r.id === refundId)!;
    await audit({ admin: null, ip: 'unknown' }, { action: 'payment.refund_unknown', summary: `Pedido de devolução do pedido #${draft.order_number} sem resposta da operadora (${brl(Number(draft.amount_cents))})`, entity: 'payment', entityId: opts.paymentId });
    return { refund, outcome: 'unknown', message: 'A ValidaPay não respondeu. A devolução pode ou não ter sido criada: use “Conferir devolução” antes de pedir de novo.' };
  }

  const updated = await one<Row>('select * from refund_update($1::uuid, $2, $3, $4)', [refundId, item.status, item.providerRefundId, item.error ?? null]);
  if (item.status === 'confirmed') {
    // O cartão pode voltar confirmado na hora: aplica no pagamento (e no pedido, se foi total) com a mesma regra dos avisos.
    await reconcileRefunds(opts.paymentId).catch(() => undefined);
  }
  const refund = (await refundsOfPayment(opts.paymentId)).find((r) => r.id === refundId)!;
  const outcome = (updated?.status ?? item.status) as 'processing' | 'confirmed' | 'failed';
  const message =
    outcome === 'confirmed'
      ? 'A ValidaPay confirmou a devolução.'
      : outcome === 'failed'
        ? 'A ValidaPay informou que a devolução falhou. Nada foi devolvido.'
        : 'Devolução pedida à ValidaPay. O valor só é dado como devolvido quando ela confirmar: atualize em alguns instantes.';
  return { refund, outcome, message };
}

// ---- O que o cliente vê ------------------------------------------------------------------------------------------------------------

export type PaymentView = {
  id: string;
  status: PaymentStatus;
  method: 'pix' | 'card';
  amount: number;
  attempt: number;
  expires_at: string | null;
  // O Pix "copia e cola": só enquanto aguarda o pagamento.
  pix: { payload: string } | null;
  can_retry: boolean;
  retry_until: string | null;
  message: string | null;
};

// `card_checkout`: o que o navegador precisa para trocar o cartão por um token (só enquanto o pedido de cartão online espera o pagamento).
export type CustomerPayment = {
  payment: PaymentView | null;
  order_status: string;
  payment_status: string;
  card_checkout: { public_id: string; environment: 'sandbox' | 'production' } | null;
};

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
  if (payment.method === 'card') {
    if (payment.status === 'creating') return 'Estamos processando o pagamento. Não feche esta tela e não pague de novo.';
    if (payment.status === 'pending') return 'Aguardando a confirmação do banco. Não pague de novo: assim que ele responder, o pedido segue para a loja.';
    if (payment.status === 'cancelled') return 'Este pagamento foi cancelado.';
    if (payment.status === 'failed') return 'O cartão não foi aprovado. Confira os dados ou use outro cartão.';
    return null;
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
    pix: payment.method === 'pix' && pending && payment.pix_payload ? { payload: payment.pix_payload } : null,
    can_retry: retryable,
    retry_until: retryable && closed !== null ? new Date(closed + RETRY_WINDOW_MINUTES * 60_000).toISOString() : null,
    message: messageFor(payment, String(order.order_status)),
  };
}

// A situação do pagamento de um pedido, para a página do cliente. Com `refresh`, pergunta à operadora enquanto aguarda o pagamento
// (cobre o aviso que atrasou ou se perdeu), no máximo a cada poucos segundos.
export async function customerPaymentView(orderId: string, opts: { refresh: boolean }): Promise<CustomerPayment> {
  let state = await loadLatest(orderId);
  // Cartão sem resposta da operadora: nunca é encerrado às cegas (o cartão pode ter sido cobrado); só sinaliza e, bem mais tarde, encerra.
  if (state.payment?.method === 'card' && (state.payment.status === 'creating' || state.payment.status === 'pending')) {
    await one('select payment_card_stale($1::uuid)', [state.payment.id]).catch(() => undefined);
    state = await loadLatest(orderId);
  }
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
  const cardOrder = state.order.payment_method === 'card_online' && state.order.order_status === 'awaiting_payment';
  const checkout = cardOrder ? getProvider()?.cardCheckout ?? null : null;
  return {
    payment: state.payment ? toView(state.order, state.payment, state.attempts) : null,
    order_status: String(state.order.order_status),
    payment_status: String(state.order.payment_status),
    card_checkout: checkout ? { public_id: checkout.publicId, environment: checkout.environment } : null,
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
    // Aviso de devolução (refund.requested / confirmed / failed): põe em dia os pedidos de devolução da loja com o que a operadora tem da cobrança.
    if (event.type.startsWith('refund.') && provider.listRefunds) await reconcileRefunds(String(payment.id));
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
  const due = await query<Row>('select id, status, method, provider, provider_charge_id, expires_at from payments_due($1)', [opts.limit ?? 5]);
  for (const payment of due) {
    try {
      if (payment.status === 'creating') {
        if (payment.method === 'card') {
          // Cartão: o cobrança PODE existir na operadora. Nunca é encerrada às cegas (ver payment_card_stale).
          const stale = await one<{ r: { changed: boolean } }>('select payment_card_stale($1::uuid) as r', [payment.id]);
          if (stale?.r.changed) out.closed += 1;
          continue;
        }
        await one('select payment_mark_failed($1::uuid, $2, true)', [payment.id, 'sem resposta da operadora']);
        out.closed += 1;
        continue;
      }
      if (payment.method === 'card' && payment.status === 'pending') await one('select payment_card_stale($1::uuid)', [payment.id]).catch(() => undefined);
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

// O cartão online está pronto para ser ligado? Além do que o Pix pede (operadora e conta do estabelecimento aprovada), precisa do identificador público
// para o SDK do navegador e da taxa do cartão conferida pelo dono. `missing` diz o que falta, sem valores.
export type CardReadiness = { ready: boolean; missing: string[] };

export async function cardReadiness(): Promise<CardReadiness> {
  const base = await onlineReadiness();
  const provider = getProvider();
  const missing: string[] = [];
  // O cartão é cobrado na SUBCONTA do estabelecimento (sem divisão): precisa da conta aprovada, como o Pix.
  if (!provider) missing.push('operadora');
  else if (!provider.createCardCharge || !provider.cardCheckout) missing.push('VALIDAPAY_PUBLIC_ID');
  if (provider && base.merchant !== 'approved') missing.push('conta aprovada');
  else if (provider && !base.ready) missing.push('ciência das tarifas');
  const fee = await one<{ confirmed: boolean }>('select confirmed_at is not null as confirmed from payment_fee_settings where id = 1');
  if (!fee?.confirmed) missing.push('taxa do cartão conferida');
  return { ready: missing.length === 0, missing };
}

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
