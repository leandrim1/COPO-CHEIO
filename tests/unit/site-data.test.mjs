import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const d = await load('src/site/data.tsx');

test('horário nulo, quebrado ou incompleto cai nos padrões, sem lançar erro', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { mon: null }, { mon: { open: 'sim', start: '9', end: '23' } }, { mon: { open: true, start: '25:00', end: '23:00' } }]) {
    const hours = d.normalizeHours(bad);
    assert.deepEqual(Object.keys(hours).sort(), ['fri', 'mon', 'sat', 'sun', 'thu', 'tue', 'wed']);
    for (const day of Object.values(hours)) assert.match(day.start, /^\d\d:\d\d$/);
  }
});

test('horário válido é mantido', () => {
  const hours = d.normalizeHours({ mon: { open: true, start: '18:00', end: '02:00' }, tue: { open: false, start: '09:00', end: '23:00' } });
  assert.deepEqual(hours.mon, { open: true, start: '18:00', end: '02:00' });
  assert.equal(hours.tue.open, false);
});

test('loja: nulos viram padrões, números chegam como número', () => {
  const s = d.normalizeStore({ store_name: null, delivery_fee: '7.50', min_order: 'abc', opening_hours: null, orders_paused: 'yes', tagline: null });
  assert.equal(s.store_name, 'Copo Cheio');
  assert.equal(s.delivery_fee, 7.5);
  assert.equal(s.min_order, 0);
  assert.equal(s.orders_paused, false);
  assert.equal(typeof s.opening_hours.mon.open, 'boolean');
  assert.equal(d.normalizeStore(null).store_name, 'Copo Cheio');
});

test('conteúdo da API com listas nulas não derruba o site', () => {
  const c = d.normalizeContent({ store: null, site: null, hero: null, banners: null, cover_banners: undefined, zones: null, payments: null });
  assert.deepEqual(c.banners, []);
  assert.deepEqual(c.coverBanners, []);
  assert.deepEqual(c.zones, []);
  assert.equal(c.payments.length, 3, 'sem formas de pagamento, vale o padrão');
  assert.deepEqual(c.hero.images, []);
  assert.ok(c.site.seo_title);
});

test('listas com itens quebrados: os bons ficam, os ruins saem', () => {
  const c = d.normalizeContent({
    banners: [null, { id: 'b1' }, 'texto', { nome: 'sem id' }],
    zones: [{ id: 'z1', name: 'Centro', fee: '6.00' }, { id: 'z2', name: '', fee: 3 }, { id: 'z3', name: 'Sem taxa' }, null],
    payments: [{ code: 'pix', label: 'PIX' }, { code: 'fiado', label: 'Fiado' }],
  });
  assert.deepEqual(c.banners.map((b) => b.id), ['b1']);
  assert.deepEqual(c.zones.map((z) => [z.name, z.fee]), [['Centro', 6]]);
  assert.deepEqual(c.payments.map((p) => p.code), ['pix']);
});

test('limite de destaques sempre fica entre 1 e 24', () => {
  assert.equal(d.normalizeSite({ featured_limit: 0 }).featured_limit, 1);
  assert.equal(d.normalizeSite({ featured_limit: 999 }).featured_limit, 24);
  assert.equal(d.normalizeSite({ featured_limit: 'abc' }).featured_limit, 4);
  assert.equal(d.normalizeSite({ featured_limit: 6 }).featured_limit, 6);
});

test('tempo de retirada: texto vira texto; vazio, nulo ou outro tipo vira nulo (a janela de informações não mostra a linha)', () => {
  assert.equal(d.normalizeStore({ pickup_time: '10 a 15 min' }).pickup_time, '10 a 15 min');
  for (const empty of [null, undefined, '', '   ', 5, {}, []]) assert.equal(d.normalizeStore({ pickup_time: empty }).pickup_time, null);
  assert.equal(d.normalizeStore(null).pickup_time, null);
});

test('formas de pagamento aceitas: as do painel; o cartão online só com a taxa conhecida (a mesma regra do checkout)', () => {
  const pay = (code, extra = {}) => ({ code, label: code, details: null, ...extra });
  assert.deepEqual(d.acceptedPayments([pay('pix'), pay('cash'), pay('card')]).map((p) => p.code), ['pix', 'cash', 'card']);
  assert.deepEqual(d.acceptedPayments([pay('pix'), pay('card_online')]).map((p) => p.code), ['pix'], 'cartão online sem taxa não aparece');
  for (const bad of [{ bps: -1, fixed_cents: 37 }, { bps: 537, fixed_cents: -1 }, { bps: 5.5, fixed_cents: 37 }, { bps: '537', fixed_cents: 37 }, null])
    assert.deepEqual(d.acceptedPayments([pay('card_online', { card_fee: bad })]), [], `taxa inválida ${JSON.stringify(bad)}`);
  assert.deepEqual(d.acceptedPayments([pay('card_online', { card_fee: { bps: 537, fixed_cents: 37 } })]).map((p) => p.code), ['card_online']);
  assert.deepEqual(d.cardFeeRates({ bps: 537, fixed_cents: 37 }), { bps: 537, fixedCents: 37 });
  assert.equal(d.cardFeeRates(undefined), null);
});
