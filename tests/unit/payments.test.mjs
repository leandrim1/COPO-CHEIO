import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

// Aqui vale o código de PRODUÇÃO (a fábrica de operadoras de verdade); o simulador só existe no servidor de teste.
const provider = await load('server/payments/provider.ts');
const service = await load('server/payments/service.ts');

test('em produção não há operadora de pagamento: nada é simulado (a ValidaPay ainda não tem adaptador)', () => {
  assert.equal(provider.getProvider(), null);
  assert.deepEqual(provider.providerSummary(), { configured: false, name: null });
});

test('só "pix_online" é pagamento online (os outros são pagos na entrega/retirada)', () => {
  assert.equal(provider.isOnlineMethod('pix_online'), true);
  for (const other of ['pix', 'cash', 'card', '', 'PIX_ONLINE', 'pix_online ', null, undefined, 5, {}]) assert.equal(provider.isOnlineMethod(other), false, String(other));
});

test('toObservation: status desconhecido não vira observação', () => {
  assert.equal(service.toObservation({ providerChargeId: 'c1', status: 'banana', amountCents: 100 }), null);
  assert.equal(service.toObservation({ providerChargeId: 'c1', status: undefined, amountCents: 100 }), null);
  for (const status of ['pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded']) assert.equal(service.toObservation({ providerChargeId: 'c1', status, amountCents: 100 }).status, status);
});

test('toObservation: só números inteiros e não negativos passam; o resto vira nulo (nunca NaN, decimal ou texto)', () => {
  const obs = service.toObservation({
    providerChargeId: 'c1',
    status: 'paid',
    amountCents: 5000,
    feeCents: 99.5,
    netCents: -1,
    refundedCents: '10',
    paidAt: new Date('2026-01-02T03:04:05Z'),
    split: { state: 'applied', commissionCents: 250 },
  });
  assert.equal(obs.amount_cents, 5000);
  assert.equal(obs.fee_cents, null);
  assert.equal(obs.net_cents, null);
  assert.equal(obs.refunded_cents, null);
  assert.equal(obs.paid_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(obs.split, { state: 'applied', commission_cents: 250, detail: null });
  for (const bad of [Number.NaN, Infinity, 2 ** 60, '5000', null, undefined]) assert.equal(service.toObservation({ providerChargeId: 'c1', status: 'paid', amountCents: bad }).amount_cents, null, String(bad));
});

test('toObservation: divisão com estado inventado é descartada; data inválida vira nula', () => {
  assert.equal(service.toObservation({ providerChargeId: 'c1', status: 'paid', amountCents: 1, split: { state: 'quase', commissionCents: 1 } }).split, null);
  assert.equal(service.toObservation({ providerChargeId: 'c1', status: 'paid', amountCents: 1, paidAt: new Date('lixo') }).paid_at, null);
  assert.equal(service.toObservation({ providerChargeId: 'c1', status: 'paid', amountCents: 1 }).split, null);
});

const payment = (over = {}) => ({
  id: 'p1',
  order_id: 'o1',
  attempt: 1,
  provider: 'x',
  method: 'pix',
  status: 'pending',
  amount_cents: 5000,
  pix_payload: 'PIX-COPIA-E-COLA',
  expires_at: '2026-01-01T00:15:00.000Z',
  closed_at: null,
  ...over,
});

test('toView: o Pix "copia e cola" só aparece enquanto aguarda o pagamento, e o valor vem em reais', () => {
  const pending = service.toView({ order_status: 'awaiting_payment' }, payment(), 1);
  assert.deepEqual(pending.pix, { payload: 'PIX-COPIA-E-COLA' });
  assert.equal(pending.amount, 50);
  assert.equal(pending.can_retry, false);
  for (const status of ['paid', 'expired', 'failed', 'cancelled', 'refunded', 'creating']) {
    assert.equal(service.toView({ order_status: 'awaiting_payment' }, payment({ status, closed_at: '2026-01-01T00:16:00.000Z' }), 1).pix, null, status);
  }
});

test('toView: não traz comissão, tarifas, subconta nem código da operadora', () => {
  const view = service.toView({ order_status: 'awaiting_payment' }, payment({ commission_cents: 250, fee_cents: 99, provider_charge_id: 'ch_secreto', merchant_account_id: 'm1' }), 1);
  assert.deepEqual(Object.keys(view).sort(), ['amount', 'attempt', 'can_retry', 'expires_at', 'id', 'message', 'method', 'pix', 'retry_until', 'status']);
  assert.doesNotMatch(JSON.stringify({ ...view, pix: null }), /ch_secreto|commission|fee|merchant/i);
});

test('toView: nova tentativa só em pedido que ainda aguarda, até 5 tentativas, com prazo de 10 minutos', () => {
  const closed = payment({ status: 'expired', closed_at: '2026-01-01T00:20:00.000Z' });
  const retry = service.toView({ order_status: 'awaiting_payment' }, closed, 2);
  assert.equal(retry.can_retry, true);
  assert.equal(retry.retry_until, '2026-01-01T00:30:00.000Z');
  assert.equal(service.toView({ order_status: 'awaiting_payment' }, closed, 5).can_retry, false, 'quinta tentativa foi a última');
  assert.equal(service.toView({ order_status: 'cancelled' }, closed, 1).can_retry, false, 'pedido cancelado não aceita novo Pix');
  assert.equal(service.toView({ order_status: 'new' }, closed, 1).can_retry, false);
});

test('toView: pagamento recebido depois do cancelamento avisa que a loja devolve', () => {
  const view = service.toView({ order_status: 'cancelled' }, payment({ status: 'paid', paid_at: '2026-01-01T00:10:00.000Z' }), 1);
  assert.match(view.message, /devolver/);
  assert.equal(service.toView({ order_status: 'new' }, payment({ status: 'paid', paid_at: '2026-01-01T00:10:00.000Z' }), 1).message, null);
});

test('normalizePayment: datas viram texto ISO, inválidas viram nulo, bigint vira número', () => {
  const row = service.normalizePayment({ id: 'p1', expires_at: new Date('2026-01-01T00:15:00Z'), paid_at: null, closed_at: 'lixo', checked_at: undefined, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', paid_seq: '12' });
  assert.equal(row.expires_at, '2026-01-01T00:15:00.000Z');
  assert.equal(row.paid_at, null);
  assert.equal(row.closed_at, null);
  assert.equal(row.checked_at, null);
  assert.equal(row.paid_seq, 12);
});

test('prazos: Pix de 15 minutos, janela de nova tentativa de 10, pedido sem Pix cancelado em 30', () => {
  assert.equal(service.PIX_TTL_SECONDS, 15 * 60);
  assert.equal(service.RETRY_WINDOW_MINUTES, 10);
  assert.equal(service.NEVER_PAID_MINUTES, 30);
  assert.equal(service.PROVIDER_TIMEOUT_MS, 8000);
});
