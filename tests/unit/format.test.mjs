import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const f = await load('src/lib/format.ts');

test('horário de Brasília digitado vira o instante certo (e volta igual)', () => {
  // Brasília não tem horário de verão desde 2019: UTC-3 o ano todo.
  assert.equal(f.localToIso('2026-12-24T18:00'), '2026-12-24T21:00:00.000Z');
  assert.equal(f.localToIso('2026-06-30T23:30'), '2026-07-01T02:30:00.000Z');
  assert.equal(f.isoToLocal('2026-12-24T21:00:00.000Z'), '2026-12-24T18:00');
  assert.equal(f.isoToLocal('2026-07-01T02:30:00.000Z'), '2026-06-30T23:30');
  for (const value of ['2026-01-01T00:00', '2026-02-28T23:59', '2028-02-29T12:00']) assert.equal(f.isoToLocal(f.localToIso(value)), value);
});

test('o fuso do computador de quem digita não muda o resultado', () => {
  const original = process.env.TZ;
  for (const tz of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    assert.equal(f.localToIso('2026-12-24T18:00'), '2026-12-24T21:00:00.000Z', tz);
  }
  process.env.TZ = original;
});

test('entradas inválidas', () => {
  assert.equal(f.localToIso(''), null);
  assert.equal(f.localToIso('amanhã'), null);
  assert.equal(f.isoToLocal(null), '');
  assert.equal(f.isoToLocal('não é data'), '');
});

test('situação da promoção: sem preço, agendada, valendo, encerrada', () => {
  const now = Date.parse('2026-12-24T12:00:00Z');
  assert.equal(f.promoState({ promo_price: null }, now), 'none');
  assert.equal(f.promoState({ promo_price: 5 }, now), 'active');
  assert.equal(f.promoState({ promo_price: 5, promo_starts_at: '2026-12-25T00:00:00Z' }, now), 'scheduled');
  assert.equal(f.promoState({ promo_price: 5, promo_ends_at: '2026-12-24T11:00:00Z' }, now), 'expired');
  assert.equal(f.promoState({ promo_price: 5, promo_ends_at: '2026-12-24T12:00:00Z' }, now), 'expired', 'o fim é exclusivo');
  assert.equal(f.promoState({ promo_price: 5, promo_starts_at: '2026-12-24T12:00:00Z', promo_ends_at: '2026-12-25T00:00:00Z' }, now), 'active', 'o início é inclusivo');
});

test('mudança de status: as mesmas regras do banco', () => {
  const { statusMoveProblem: s } = f;
  assert.equal(s('new', 'confirmed'), null);
  assert.equal(s('new', 'delivered'), null, 'para a frente vale pular etapas');
  assert.equal(s('preparing', 'confirmed'), null, 'voltar uma etapa');
  assert.ok(s('delivered', 'new'));
  assert.ok(s('out_for_delivery', 'new'), 'voltar duas etapas');
  assert.equal(s('delivered', 'out_for_delivery'), null);
  assert.ok(s('delivered', 'cancelled'));
  assert.ok(s('cancelled', 'new'));
  assert.equal(s('preparing', 'cancelled'), null);
  assert.equal(s('new', 'new'), null);
});

test('mudança de pagamento', () => {
  const { paymentMoveProblem: p } = f;
  assert.ok(p({ order_status: 'cancelled', payment_status: 'pending' }, 'paid'));
  assert.equal(p({ order_status: 'new', payment_status: 'pending' }, 'paid'), null);
  assert.ok(p({ order_status: 'new', payment_status: 'pending' }, 'refunded'));
  assert.equal(p({ order_status: 'cancelled', payment_status: 'paid' }, 'refunded'), null);
});
