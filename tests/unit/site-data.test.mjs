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

test('formas de pagamento aceitas: as que a loja ativou no painel, todas pagas à loja (o pagamento pelo site não existe mais)', () => {
  const pay = (code) => ({ code, label: code, details: null });
  assert.deepEqual(d.acceptedPayments([pay('pix'), pay('cash'), pay('card')]).map((p) => p.code), ['pix', 'cash', 'card']);
  assert.deepEqual(d.acceptedPayments([]), []);
});

// ---- Miniaturas das fotos (srcset) ---------------------------------------------------------------------------------------------------------

test('srcset das miniaturas: 400w e 720w, só com endereço simples (https ou do próprio site)', () => {
  assert.equal(d.imageSrcSet('https://x.blob.vercel-storage.com/products/a.webp', 'https://x.blob.vercel-storage.com/products/b.webp'), 'https://x.blob.vercel-storage.com/products/a.webp 400w, https://x.blob.vercel-storage.com/products/b.webp 720w');
  assert.equal(d.imageSrcSet('https://x.test/a.webp', null), 'https://x.test/a.webp 400w', 'só a pequena');
  assert.equal(d.imageSrcSet(undefined, 'https://x.test/b.webp'), 'https://x.test/b.webp 720w', 'só a média');
  assert.equal(d.imageSrcSet('/img/bench/p-01-400.webp', '/img/bench/p-01-720.webp'), '/img/bench/p-01-400.webp 400w, /img/bench/p-01-720.webp 720w', 'caminho do próprio site');
});

test('srcset das miniaturas: sem miniatura (ou com endereço que quebraria o atributo) não há srcset', () => {
  assert.equal(d.imageSrcSet(null, null), undefined);
  assert.equal(d.imageSrcSet(undefined, undefined), undefined);
  assert.equal(d.imageSrcSet('', ''), undefined);
  for (const bad of ['http://x.test/a.webp', 'javascript:alert(1)', '//x.test/a.webp', 'https://x.test/a b.webp', 'https://x.test/a,b.webp', 'https://x.test/a.webp 2x, https://evil.test/x.webp', 42, {}, [], true]) {
    assert.equal(d.imageSrcSet(bad, bad), undefined, String(bad));
  }
  assert.equal(d.imageSrcSet('https://x.test/a,b.webp', 'https://x.test/b.webp'), 'https://x.test/b.webp 720w', 'um endereço ruim não derruba o outro');
});

test('miniatura das listas (imageSm): só aceita o mesmo tipo de endereço simples; qualquer outra coisa cai na foto original', () => {
  assert.equal(d.simpleImageUrl('https://x.blob.vercel-storage.com/products/a.webp'), 'https://x.blob.vercel-storage.com/products/a.webp');
  assert.equal(d.simpleImageUrl('/img/bench/p-01-400.webp'), '/img/bench/p-01-400.webp', 'caminho do próprio site');
  for (const bad of [null, undefined, '', 'http://x.test/a.webp', 'javascript:alert(1)', '//x.test/a.webp', 'https://x.test/a b.webp', 'https://x.test/a,b.webp', 'data:image/png;base64,AAAA', 42, {}, [], true])
    assert.equal(d.simpleImageUrl(bad), undefined, String(bad));
});

// ---- Dados que não mudaram continuam sendo os mesmos objetos (a tela só redesenha o que mudou) ----------------------------------------------

const prod = (id, extra = {}) => ({ id, name: `Produto ${id}`, category: 'Cervejas', categoryPosition: 0, price: 5, promoPrice: null, featured: false, soldOut: false, position: 0, iceRequired: false, swapBaseId: null, swapBasePrice: null, swapOptionIds: [], ...extra });
const shop = (products, extra = {}) => ({ store: { store_name: 'Copo Cheio', delivery_fee: 5 }, site: { seo_title: 'x' }, hero: { title: 'y', images: [] }, banners: [], coverBanners: [], zones: [], payments: [], products, ...extra });

test('buscar de novo com dados iguais devolve exatamente os mesmos objetos', () => {
  const before = shop([prod('a'), prod('b', { swapOptionIds: ['x'] })]);
  const after = shop([prod('a'), prod('b', { swapOptionIds: ['x'] })]);
  const merged = d.reuseUnchanged(before, after);
  assert.equal(merged.products, before.products, 'a lista inteira é a mesma');
  assert.equal(merged.products[0], before.products[0]);
  assert.equal(merged.store, before.store);
  assert.equal(merged.site, before.site);
  assert.equal(merged.hero, before.hero);
  assert.equal(merged.banners, before.banners);
});

test('mudou um produto: só ele é objeto novo; os outros continuam os mesmos', () => {
  const before = shop([prod('a'), prod('b'), prod('c')]);
  const after = shop([prod('a'), prod('b', { price: 7.5 }), prod('c')]);
  const merged = d.reuseUnchanged(before, after);
  assert.notEqual(merged.products, before.products, 'a lista é nova (um item mudou)');
  assert.equal(merged.products[0], before.products[0]);
  assert.notEqual(merged.products[1], before.products[1]);
  assert.equal(merged.products[1].price, 7.5, 'o valor novo vale');
  assert.equal(merged.products[2], before.products[2]);
});

test('produto novo, removido ou fora de ordem: a lista nova vale, com o que não mudou reaproveitado', () => {
  const before = shop([prod('a'), prod('b')]);
  const added = d.reuseUnchanged(before, shop([prod('a'), prod('b'), prod('c')]));
  assert.deepEqual(added.products.map((p) => p.id), ['a', 'b', 'c']);
  assert.equal(added.products[0], before.products[0]);
  const removed = d.reuseUnchanged(before, shop([prod('b')]));
  assert.deepEqual(removed.products.map((p) => p.id), ['b']);
  assert.equal(removed.products[0], before.products[1]);
  const reordered = d.reuseUnchanged(before, shop([prod('b'), prod('a')]));
  assert.deepEqual(reordered.products.map((p) => p.id), ['b', 'a']);
  assert.notEqual(reordered.products, before.products);
  assert.equal(reordered.products[0], before.products[1]);
});

test('o que mudou na loja (preço de entrega, esgotado, miniatura) aparece: nada fica velho', () => {
  const before = shop([prod('a', { image: 'https://x.test/a.webp' })]);
  const store = d.reuseUnchanged(before, shop([prod('a', { image: 'https://x.test/a.webp' })], { store: { store_name: 'Copo Cheio', delivery_fee: 8 } }));
  assert.equal(store.store.delivery_fee, 8);
  assert.equal(store.products, before.products, 'os produtos iguais seguem iguais');
  const sold = d.reuseUnchanged(before, shop([prod('a', { image: 'https://x.test/a.webp', soldOut: true })]));
  assert.equal(sold.products[0].soldOut, true);
  const thumb = d.reuseUnchanged(before, shop([prod('a', { image: 'https://x.test/a.webp', imageSrcSet: 'https://x.test/a-400.webp 400w' })]));
  assert.equal(thumb.products[0].imageSrcSet, 'https://x.test/a-400.webp 400w');
  const none = d.reuseUnchanged(before, shop([]));
  assert.deepEqual(none.products, [], 'cardápio vazio vale (loja tirou tudo do ar)');
});
