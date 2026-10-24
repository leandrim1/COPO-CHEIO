import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const fl = await load('src/lib/flavors.ts');
const ice = await load('src/lib/ice.ts');
const COMBO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M = '11111111-1111-4111-8111-111111111111'; // morango
const L = '22222222-2222-4222-8222-222222222222'; // limão
const W = '33333333-3333-4333-8333-333333333333'; // melancia
const E1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const E2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const keys = (cart) => Object.keys(cart);

test('textos da escolha dos gelos: título, instrução e contador (a quantidade vem do combo)', () => {
  assert.equal(fl.flavorsTitle(4), 'Escolha os 4 gelos saborizados');
  assert.equal(fl.flavorsHint(4), 'Escolha os sabores dos 4 gelos que acompanham seu combo.');
  assert.equal(fl.flavorsCounter(0, 4), 'Gelos selecionados: 0 de 4');
  assert.equal(fl.flavorsCounter(3, 4), 'Gelos selecionados: 3 de 4');
  assert.equal(fl.flavorsCounter(2, 6), 'Gelos selecionados: 2 de 6');
  assert.equal(fl.FLAVORS_REQUIRED_MESSAGE, 'Escolha os sabores dos gelos do combo para continuar.');
  assert.equal(fl.pickText(2, 'Gelo de morango'), '2 × Gelo de morango');
});

test('a escolha vira sempre o mesmo texto: sabor repetido se soma, zero some, ordem fixa', () => {
  const picks = [{ id: W, qty: 1 }, { id: M, qty: 2 }, { id: M, qty: 1 }, { id: L, qty: 0 }, { id: L, qty: -1 }];
  assert.deepEqual(fl.normalizePicks(picks), [{ id: M, qty: 3 }, { id: W, qty: 1 }]);
  assert.equal(fl.sumPicks(fl.normalizePicks(picks)), 4);
  assert.equal(fl.picksToken([{ id: W, qty: 1 }, { id: M, qty: 3 }]), fl.picksToken([{ id: M, qty: 2 }, { id: W, qty: 1 }, { id: M, qty: 1 }]));
  assert.equal(fl.samePicks([{ id: M, qty: 2 }, { id: L, qty: 2 }], [{ id: L, qty: 2 }, { id: M, qty: 2 }]), true);
  assert.equal(fl.samePicks([{ id: M, qty: 2 }, { id: L, qty: 2 }], [{ id: M, qty: 3 }, { id: L, qty: 1 }]), false);
  assert.deepEqual(fl.picksToPayload([{ id: L, qty: 1 }, { id: M, qty: 3 }]), [{ product_id: M, quantity: 3 }, { product_id: L, quantity: 1 }]);
});

test('a chave do carrinho guarda os sabores: ida e volta, e recusa o que está malformado', () => {
  const picks = [{ id: M, qty: 2 }, { id: L, qty: 1 }, { id: W, qty: 1 }];
  assert.deepEqual(fl.tokenToPicks(fl.picksToken(picks)), fl.normalizePicks(picks));
  for (const bad of ['', 'x', `${M}`, `${M}.0`, `${M}.-1`, `${M}.x`, `${M}.13`, `${M}.2+${M}.2`, 'não-é-id.2']) assert.equal(fl.tokenToPicks(bad), null, bad);
  const key = ice.lineKey(COMBO, null, null, { unit: 'abc1', picks });
  assert.deepEqual(ice.parseLineKey(key), { productId: COMBO, ice: null, swapTo: null, flavors: fl.normalizePicks(picks), unit: 'abc1' });
  const swapped = ice.lineKey(COMBO, null, E1, { unit: 'abc1', picks });
  assert.equal(ice.parseLineKey(swapped).swapTo, E1);
  for (const bad of [`${COMBO}|abc1`, `${COMBO}||${fl.picksToken(picks)}`, `${COMBO}|abc1|`, `${COMBO}|A B|${fl.picksToken(picks)}`, `${COMBO}|abc1|${fl.picksToken(picks)}|${E1}|x`, `|abc1|${fl.picksToken(picks)}`, `${COMBO}:normal|abc1|${fl.picksToken(picks)}`]) assert.equal(ice.parseLineKey(bad), null, bad);
});

test('cada unidade do combo é uma linha com a SUA escolha: duas unidades com sabores diferentes não se misturam', () => {
  let cart = ice.addFlavoredLine({}, COMBO, [{ id: M, qty: 2 }, { id: L, qty: 2 }], 'u1');
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: W, qty: 4 }], 'u2');
  assert.equal(keys(cart).length, 2);
  assert.deepEqual(Object.values(cart), [1, 1]);
  assert.equal(ice.countFor(cart, COMBO), 2);
  const parsed = keys(cart).map((k) => ice.parseLineKey(k));
  assert.deepEqual(parsed[0].flavors, [{ id: M, qty: 2 }, { id: L, qty: 2 }]);
  assert.deepEqual(parsed[1].flavors, [{ id: W, qty: 4 }]);
  // A mesma escolha duas vezes continua sendo duas linhas (cada uma com a sua unidade).
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: W, qty: 4 }], 'u3');
  assert.equal(keys(cart).length, 3);
  assert.equal(ice.countFor(cart, COMBO), 3);
  // Sem sabores não entra linha nenhuma (o combo não vai para o pedido sem escolha).
  assert.equal(ice.addFlavoredLine({}, COMBO, [], 'u9') && Object.keys(ice.addFlavoredLine({}, COMBO, [], 'u9')).length, 0);
});

test('linha de combo com gelos tem quantidade 1, mesmo vinda de um pedido guardado com outro número', () => {
  const key = ice.lineKey(COMBO, null, null, { unit: 'u1', picks: [{ id: M, qty: 4 }] });
  assert.deepEqual(ice.normalizeCart({ [key]: 5 }), { [key]: 1 });
  assert.deepEqual(ice.setLineQty({ [key]: 1 }, key, 3), { [key]: 1 });
  assert.deepEqual(ice.setLineQty({ [key]: 1 }, key, 0), {});
});

test('editar os sabores de UMA linha: a linha fica no mesmo lugar, as outras não mudam', () => {
  let cart = ice.addFlavoredLine({}, COMBO, [{ id: M, qty: 4 }], 'u1');
  cart = ice.addFlavoredLine(cart, OTHER, [], 'x'); // ignorado
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: L, qty: 4 }], 'u2');
  cart = ice.addToCart(cart, E1, null, 2);
  const [first, second] = keys(cart);
  const next = ice.setLineFlavors(cart, first, [{ id: W, qty: 3 }, { id: M, qty: 1 }]);
  const order = keys(next);
  assert.equal(order.length, 3);
  assert.deepEqual(ice.parseLineKey(order[0]).flavors, [{ id: M, qty: 1 }, { id: W, qty: 3 }]);
  assert.equal(ice.parseLineKey(order[0]).unit, 'u1', 'mantém o código da unidade');
  assert.equal(order[1], second, 'a outra unidade ficou igual');
  assert.equal(next[E1], 2);
  assert.equal(ice.setLineFlavors(cart, first, []), cart, 'sem sabores não muda nada');
  assert.equal(ice.setLineFlavors(cart, 'nao-existe', [{ id: M, qty: 4 }]), cart);
});

test('combo guardado sem escolha (pedido de antes): escolher os gelos vira UMA unidade com escolha; as outras seguem sem escolha', () => {
  const plain = ice.lineKey(COMBO, null);
  const one = ice.setLineFlavors({ [plain]: 1 }, plain, [{ id: M, qty: 4 }]);
  assert.equal(keys(one).length, 1);
  assert.equal(ice.parseLineKey(keys(one)[0]).flavors.length, 1);
  const three = ice.setLineFlavors({ [plain]: 3 }, plain, [{ id: M, qty: 4 }]);
  assert.equal(three[plain], 2, 'duas unidades continuam sem escolha');
  assert.equal(keys(three).length, 2);
  assert.equal(ice.countFor(three, COMBO), 3);
});

test('troca do energético em combo com gelos: muda só o energético da linha e a escolha de sabores fica', () => {
  let cart = ice.addFlavoredLine({}, COMBO, [{ id: M, qty: 4 }], 'u1');
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: L, qty: 4 }], 'u2');
  assert.equal(ice.plainCount(cart, COMBO), 2);
  assert.equal(ice.swappedCount(cart, COMBO, E1), 0);
  const swapped = ice.swapUnits(cart, COMBO, E1, 1);
  assert.equal(ice.plainCount(swapped, COMBO), 1);
  assert.equal(ice.swappedCount(swapped, COMBO, E1), 1);
  const lines = keys(swapped).map((k) => ice.parseLineKey(k));
  assert.deepEqual(lines.map((l) => l.swapTo), [E1, null]);
  assert.deepEqual(lines[0].flavors, [{ id: M, qty: 4 }], 'a primeira unidade guardou os SEUS sabores');
  assert.deepEqual(lines[1].flavors, [{ id: L, qty: 4 }]);
  const both = ice.swapUnits(swapped, COMBO, E2, 5);
  assert.equal(ice.swappedCount(both, COMBO, E2), 1, 'só dá para trocar o que ainda está com o energético original');
  const back = ice.swapUnits(both, COMBO, E1, -1);
  assert.equal(ice.swappedCount(back, COMBO, E1), 0);
  assert.equal(ice.plainCount(back, COMBO), 1);
  assert.equal(ice.countFor(back, COMBO), 2);
  assert.deepEqual(keys(back).map((k) => ice.parseLineKey(k).flavors), [[{ id: M, qty: 4 }], [{ id: L, qty: 4 }]]);
});

test('combo sem gelos: a troca de energético continua exatamente como era', () => {
  let cart = ice.addToCart({}, COMBO, null, 3);
  cart = ice.swapUnits(cart, COMBO, E1, 2);
  assert.equal(ice.plainCount(cart, COMBO), 1);
  assert.equal(ice.swappedCount(cart, COMBO, E1), 2);
  cart = ice.swapUnits(cart, COMBO, E1, -1);
  assert.equal(ice.plainCount(cart, COMBO), 2);
  assert.equal(ice.swappedCount(cart, COMBO, E1), 1);
});

test('depois que o cardápio chega: combo que deixou de trazer gelos volta a ser só o combo; o que ainda traz mantém a escolha', () => {
  const picks = [{ id: M, qty: 4 }];
  let cart = ice.addFlavoredLine({}, COMBO, picks, 'u1');
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: L, qty: 4 }], 'u2', E1);
  const requires = (id) => (id === COMBO ? false : undefined);
  // Ainda traz 4 gelos e a troca vale: nada muda (o mesmo objeto).
  assert.equal(ice.settleCart(cart, requires, () => true, () => 4), cart);
  // A troca deixou de valer: a linha perde o energético, mas guarda os sabores.
  const noSwap = ice.settleCart(cart, requires, () => false, () => 4);
  assert.deepEqual(keys(noSwap).map((k) => ice.parseLineKey(k).swapTo), [null, null]);
  assert.deepEqual(keys(noSwap).map((k) => ice.parseLineKey(k).flavors.length), [1, 1]);
  // O combo deixou de trazer gelos: as duas linhas viram o combo normal (a trocada continua trocada, se a troca vale).
  const noIces = ice.settleCart(cart, requires, () => true, () => 0);
  assert.deepEqual(noIces, { [COMBO]: 1, [`${COMBO}@${E1}`]: 1 });
  // Produto que saiu do cardápio some do pedido.
  assert.deepEqual(ice.settleCart(cart, () => undefined, () => true, () => 4), {});
});

test('"gelo normal / de sabor" continua funcionando e não mexe em linhas de combo', () => {
  let cart = ice.addToCart({}, M, 'normal', 2);
  cart = ice.addFlavoredLine(cart, COMBO, [{ id: L, qty: 4 }], 'u1');
  const changed = ice.changeLineIce(cart, ice.lineKey(M, 'normal'), 'flavored');
  assert.equal(changed[ice.lineKey(M, 'flavored')], 2);
  const flavoredKey = keys(cart).find((k) => k.includes('|'));
  assert.equal(ice.changeLineIce(cart, flavoredKey, 'normal'), cart, 'linha de combo com gelos não troca de gelo normal/sabor');
  assert.equal(ice.countFor(cart, M), 2);
});
