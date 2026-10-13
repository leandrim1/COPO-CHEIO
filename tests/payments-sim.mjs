// SIMULADOR de operadora de pagamento: SÓ PARA OS TESTES AUTOMATIZADOS. NÃO é a ValidaPay.
//
// Não reproduz a API da ValidaPay e nada aqui prova que a integração real funciona (a integração com a ValidaPay é exercitada, contra um
// servidor falso que segue a documentação, em tests/validapay-fake.mjs). Serve para exercitar a
// lógica da LOJA: cobrança única, confirmação só depois de conferir, aviso repetido ou fora de ordem, falha de repasse, vencimento, etc.
// O servidor de teste (tests/server.mjs) troca server/payments/factory.ts por este arquivo ao montar a API de teste; o código que vai
// para produção nunca importa este módulo.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIM_SECRET = 'segredo-do-simulador-so-para-testes';
export const SIGNATURE_HEADER = 'x-simulador-assinatura';

const fail = (kind, message) => Object.assign(new Error(message), { kind });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_MODE = {
  // 'rejected' | 'unavailable' | null: o que acontece ao criar a cobrança.
  createFail: null,
  createDelayMs: 0,
  // 'unavailable' | null: a consulta de uma cobrança falha.
  lookupFail: null,
  // Como o simulador responde sobre o repasse da comissão de uma cobrança paga: applied | failed | pending | none.
  split: 'applied',
  fee: 99,
  // false: a operadora não permite consulta (só avisos verificados valem).
  canLookup: true,
};

export const sim = {
  charges: new Map(),
  seq: 0,
  calls: { create: 0, lookup: 0, webhook: 0 },
  mode: { ...DEFAULT_MODE },
  reset() {
    this.charges.clear();
    this.seq = 0;
    this.calls = { create: 0, lookup: 0, webhook: 0 };
    this.mode = { ...DEFAULT_MODE };
  },
};

function snapshot(charge) {
  let status = charge.status;
  // Cobrança aguardando que passou da validade: a operadora a informa como vencida.
  if (status === 'pending' && Date.now() > charge.expiresAt.getTime()) status = 'expired';
  const paid = status === 'paid' || status === 'refunded';
  return {
    providerChargeId: charge.id,
    status,
    providerStatus: status.toUpperCase(),
    amountCents: charge.paidAmountCents ?? charge.amountCents,
    feeCents: paid ? sim.mode.fee : null,
    netCents: paid ? (charge.paidAmountCents ?? charge.amountCents) - sim.mode.fee : null,
    paidAt: paid ? charge.paidAt : null,
    refundedCents: charge.refundedCents ?? null,
    split: paid
      ? {
          state: sim.mode.split,
          commissionCents: sim.mode.split === 'applied' ? (charge.splitCents ?? charge.commissionCents) : null,
          detail: sim.mode.split === 'failed' ? 'saldo líquido insuficiente' : null,
        }
      : null,
  };
}

const provider = {
  name: 'simulador',
  get canLookup() {
    return sim.mode.canLookup;
  },

  async createPixCharge(input) {
    sim.calls.create += 1;
    if (sim.mode.createDelayMs) await wait(sim.mode.createDelayMs);
    if (sim.mode.createFail === 'rejected') throw fail('rejected', 'dados recusados');
    if (sim.mode.createFail === 'unavailable') throw fail('unavailable', 'fora do ar');
    const id = `sim_ch_${++sim.seq}`;
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    sim.charges.set(id, {
      id,
      reference: input.paymentId,
      orderNumber: input.orderNumber,
      amountCents: input.amountCents,
      commissionCents: input.commissionCents,
      merchant: input.merchantAccountId,
      status: 'pending',
      createdAt: new Date(),
      expiresAt,
      paidAt: null,
    });
    // Texto que não é um Pix de verdade e não pode ser pago.
    return { providerChargeId: id, qrPayload: `SIMULADO-NAO-PAGAVEL|${id}|${input.amountCents}`, expiresAt, providerStatus: 'ACTIVE' };
  },

  async getCharge(id) {
    sim.calls.lookup += 1;
    if (sim.mode.lookupFail === 'unavailable') throw fail('unavailable', 'consulta fora do ar');
    const charge = sim.charges.get(id);
    if (!charge) throw fail('rejected', 'cobrança não encontrada');
    return snapshot(charge);
  },

  async verifyWebhook(raw, headers) {
    sim.calls.webhook += 1;
    const given = Buffer.from(headers.get(SIGNATURE_HEADER) ?? '');
    const expected = Buffer.from(createHmac('sha256', SIM_SECRET).update(Buffer.from(raw)).digest('hex'));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw fail('invalid_webhook', 'assinatura inválida');
    let body;
    try {
      body = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      throw fail('malformed_webhook', 'json inválido');
    }
    const list = Array.isArray(body?.events) ? body.events : [body];
    return list.map((event) => {
      if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') throw fail('malformed_webhook', 'aviso sem id ou tipo');
      return {
        dedupeKey: event.id,
        type: event.type,
        providerChargeId: typeof event.charge_id === 'string' ? event.charge_id : null,
        reference: typeof event.reference === 'string' ? event.reference : null,
        snapshot: event.snapshot ?? null,
      };
    });
  },
};

// Chamado por server/payments/provider.ts (no lugar de factory.ts) ao montar a API de teste. PAYMENTS_SIM=off: sem operadora configurada.
export function createProvider() {
  return process.env.PAYMENTS_SIM === 'off' ? null : provider;
}

// O mesmo que factory.ts devolve para o painel: só nomes de variáveis que faltam, nunca valores.
export function describeSetup() {
  return process.env.PAYMENTS_SIM === 'off' ? { environment: null, missing: ['VALIDAPAY_ENV'], note: null } : { environment: 'sandbox', missing: [], note: null };
}

// ---- Controles dos testes (rotas /__pay/* do servidor de teste) ---------------------------------------------------------------------

export function signBody(text) {
  return createHmac('sha256', SIM_SECRET).update(Buffer.from(text)).digest('hex');
}

export function describeState() {
  return {
    calls: sim.calls,
    mode: sim.mode,
    charges: [...sim.charges.values()].map((c) => ({ ...c, snapshot: snapshot(c) })),
  };
}

// Altera uma cobrança do simulador: { status, paidAmountCents, splitCents, refundedCents, expiresInMs }.
export function updateCharge(id, patch) {
  const charge = sim.charges.get(id);
  if (!charge) return null;
  if (patch.status) {
    charge.status = patch.status;
    if (patch.status === 'paid' && !charge.paidAt) charge.paidAt = new Date();
  }
  if ('paidAmountCents' in patch) charge.paidAmountCents = patch.paidAmountCents;
  if ('splitCents' in patch) charge.splitCents = patch.splitCents;
  if ('refundedCents' in patch) charge.refundedCents = patch.refundedCents;
  if ('expiresInMs' in patch) charge.expiresAt = new Date(Date.now() + patch.expiresInMs);
  return snapshot(charge);
}
