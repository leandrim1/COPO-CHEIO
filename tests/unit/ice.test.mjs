import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const ice = await load('src/lib/ice.ts');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('os dois gelos e os textos do pedido', () => {
  assert.deepEqual([...ice.ICE_CHOICES], ['normal', 'flavored']);
  assert.equal(ice.ICE_INFO.normal.label, 'Gelo normal');
  assert.equal(ice.ICE_INFO.flavored.label, 'Gelo de sabor');
  assert.equal(ice.ICE_INFO.normal.emoji, '🧊');
  assert.equal(ice.ICE_INFO.flavored.emoji, '🍓');
  assert.equal(ice.ICE_QUESTION, 'Qual gelo você prefere?');
  assert.equal(ice.ICE_REQUIRED_MESSAGE, 'Escolha o tipo de gelo para continuar.');
});

test('só "normal" e "flavored" valem como escolha', () => {
  assert.equal(ice.isIceChoice('normal'), true);
  assert.equal(ice.isIceChoice('flavored'), true);
  for (const bad of ['Normal', 'sabor', '', null, undefined, 1, true, {}, ['normal']]) assert.equal(ice.isIceChoice(bad), false, String(bad));
  assert.equal(ice.iceLabel('flavored'), 'Gelo de sabor');
  assert.equal(ice.iceLabel(null), '');
  assert.equal(ice.iceLabel('banana'), '');
});

test('chave da linha: produto sem gelo é só o id (o formato de sempre); com gelo, id:gelo', () => {
  assert.equal(ice.lineKey(A, null), A);
  assert.equal(ice.lineKey(A, 'normal'), `${A}:normal`);
  assert.deepEqual(ice.parseLineKey(A), { productId: A, ice: null, swapTo: null, flavors: null, unit: null });
  assert.deepEqual(ice.parseLineKey(`${A}:flavored`), { productId: A, ice: 'flavored', swapTo: null, flavors: null, unit: null });
  for (const bad of ['', ':normal', `${A}:banana`, `${A}:`]) assert.equal(ice.parseLineKey(bad), null, bad);
  for (const choice of [null, 'normal', 'flavored']) assert.deepEqual(ice.parseLineKey(ice.lineKey(B, choice)), { productId: B, ice: choice, swapTo: null, flavors: null, unit: null });
});

test('o pedido guardado de antes continua valendo e o lixo é descartado', () => {
  assert.deepEqual(ice.normalizeCart({ [A]: 2, [B]: 1 }), { [A]: 2, [B]: 1 }, 'formato antigo: { produto: quantidade }');
  assert.deepEqual(ice.normalizeCart({ [`${A}:normal`]: 1, [`${A}:flavored`]: 2 }), { [`${A}:normal`]: 1, [`${A}:flavored`]: 2 });
  assert.deepEqual(ice.normalizeCart({ [A]: 500 }), { [A]: 99 }, 'passou do limite: fica em 99');
  assert.deepEqual(ice.normalizeCart({ [A]: 0, [B]: -1, x: 1.5, y: '2', z: null, [`${A}:banana`]: 1, ':normal': 1 }), {}, 'quantidade inválida e chave inválida');
  for (const bad of [null, undefined, 'texto', 42, [], [1, 2]]) assert.deepEqual(ice.normalizeCart(bad), {});
});

test('adicionar: o mesmo copão com gelos diferentes são linhas separadas', () => {
  let cart = ice.addToCart({}, A, 'normal');
  cart = ice.addToCart(cart, A, 'flavored');
  assert.deepEqual(cart, { [`${A}:normal`]: 1, [`${A}:flavored`]: 1 });
  cart = ice.addToCart(cart, A, 'normal');
  assert.deepEqual(cart, { [`${A}:normal`]: 2, [`${A}:flavored`]: 1 }, 'o mesmo gelo soma na mesma linha');
  assert.equal(ice.countFor(cart, A), 3, 'a contagem do produto soma os gelos');
  assert.equal(ice.countFor(cart, B), 0);
  cart = ice.addToCart(cart, B, null, 4);
  assert.deepEqual(cart, { [`${A}:normal`]: 2, [`${A}:flavored`]: 1, [B]: 4 }, 'produto sem gelo: linha só com o id');
  assert.equal(ice.countFor(cart, B), 4);
  const before = { [A]: 1 };
  ice.addToCart(before, A, null);
  assert.deepEqual(before, { [A]: 1 }, 'não altera o objeto original');
});

test('limite de 99 por produto vale somando todos os gelos (o servidor recusa mais que isso)', () => {
  let cart = ice.addToCart({}, A, 'normal', 99);
  assert.equal(cart[`${A}:normal`], 99);
  cart = ice.addToCart(cart, A, 'flavored', 5);
  assert.equal(ice.countFor(cart, A), 99, 'não passa de 99 no total');
  assert.equal(cart[`${A}:flavored`], undefined, 'sem lugar: a linha nova nem entra');
  cart = ice.setLineQty({ [`${A}:normal`]: 60, [`${A}:flavored`]: 10 }, `${A}:flavored`, 80);
  assert.equal(ice.countFor(cart, A), 99);
  assert.equal(cart[`${A}:flavored`], 39);
  assert.equal(ice.countFor(ice.addToCart({ [`${A}:normal`]: 99 }, B, 'normal', 99), B), 99, 'outro produto tem o seu próprio limite');
});

test('quantidade da linha: zero ou menos tira a linha, só aquela', () => {
  const cart = { [`${A}:normal`]: 2, [`${A}:flavored`]: 1, [B]: 3 };
  assert.deepEqual(ice.setLineQty(cart, `${A}:normal`, 0), { [`${A}:flavored`]: 1, [B]: 3 });
  assert.deepEqual(ice.setLineQty(cart, `${A}:flavored`, -4), { [`${A}:normal`]: 2, [B]: 3 });
  assert.deepEqual(ice.setLineQty(cart, B, 5), { [`${A}:normal`]: 2, [`${A}:flavored`]: 1, [B]: 5 });
  assert.deepEqual(ice.setLineQty(cart, `${A}:normal`, 7), { [`${A}:normal`]: 7, [`${A}:flavored`]: 1, [B]: 3 });
});

test('trocar o gelo de uma linha leva a quantidade junto, e soma se o outro gelo já estiver no pedido', () => {
  assert.deepEqual(ice.changeLineIce({ [`${A}:normal`]: 2 }, `${A}:normal`, 'flavored'), { [`${A}:flavored`]: 2 });
  assert.deepEqual(ice.changeLineIce({ [`${A}:normal`]: 2, [`${A}:flavored`]: 3 }, `${A}:normal`, 'flavored'), { [`${A}:flavored`]: 5 }, 'junta com a linha que já existia');
  const same = { [`${A}:normal`]: 2 };
  assert.equal(ice.changeLineIce(same, `${A}:normal`, 'normal'), same, 'mesma escolha: nada muda');
  assert.equal(ice.changeLineIce(same, `${B}:normal`, 'flavored'), same, 'linha que não existe: nada muda');
  // Linha antiga, sem escolha, que a pessoa escolhe agora
  assert.deepEqual(ice.changeLineIce({ [A]: 3, [B]: 1 }, A, 'normal'), { [`${A}:normal`]: 3, [B]: 1 });
});

test('depois de carregar o cardápio: sai o que não existe mais e o gelo acompanha o que o produto pede agora', () => {
  const requires = (id) => ({ [A]: true, [B]: false })[id];
  const cart = { [`${A}:normal`]: 2, [`${A}:flavored`]: 1, [B]: 3, ['33333333-3333-4333-8333-333333333333']: 1 };
  const settled = ice.settleCart(cart, requires);
  assert.deepEqual(settled, { [`${A}:normal`]: 2, [`${A}:flavored`]: 1, [B]: 3 }, 'produto desconhecido sai; o resto fica');
  assert.equal(ice.settleCart(settled, requires), settled, 'nada para acertar: devolve o mesmo objeto (sem nova renderização)');

  // A categoria deixou de pedir o gelo: as linhas viram uma só, somando
  assert.deepEqual(ice.settleCart({ [`${A}:normal`]: 2, [`${A}:flavored`]: 1 }, () => false), { [A]: 3 });
  assert.deepEqual(ice.settleCart({ [`${A}:normal`]: 60, [`${A}:flavored`]: 60 }, () => false), { [A]: 99 }, 'e respeita o limite');
  // A categoria passou a pedir o gelo: a linha sem escolha continua no pedido (o site pede a escolha)
  assert.deepEqual(ice.settleCart({ [A]: 2 }, () => true), { [A]: 2 });
  // Produto de categoria que não pede, vindo com gelo de um pedido antigo, volta a ser o produto puro
  assert.deepEqual(ice.settleCart({ [`${B}:normal`]: 2 }, requires), { [B]: 2 });
  assert.deepEqual(ice.settleCart({ [A]: 1 }, () => undefined), {}, 'cardápio sem o produto: tudo sai');
});

// ---- Troca de energético (combos) ------------------------------------------------------------------
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // combo
const E1 = 'e1e1e1e1-e1e1-e1e1-e1e1-e1e1e1e1e1e1'; // energético
const E2 = 'e2e2e2e2-e2e2-e2e2-e2e2-e2e2e2e2e2e2';

test('chave da linha trocada: id-do-combo@id-do-energético', () => {
  assert.equal(ice.lineKey(C, null, E1), `${C}@${E1}`);
  assert.deepEqual(ice.parseLineKey(`${C}@${E1}`), { productId: C, ice: null, swapTo: E1, flavors: null, unit: null });
  for (const bad of [`${C}@`, `@${E1}`, `${C}@${E1}@${E2}`, `${C}@${E1}:normal`, `${C}:normal@${E1}`]) assert.equal(ice.parseLineKey(bad), null, bad);
  assert.deepEqual(ice.normalizeCart({ [`${C}@${E1}`]: 2, [C]: 1, [`${C}@`]: 3 }), { [`${C}@${E1}`]: 2, [C]: 1 }, 'a linha trocada sobrevive ao recarregar; a chave quebrada é descartada');
});

test('trocar e voltar: cada unidade trocada é uma unidade do combo (o total do produto não muda)', () => {
  const start = { [C]: 3 };
  const one = ice.swapUnits(start, C, E1, 1);
  assert.deepEqual(one, { [C]: 2, [`${C}@${E1}`]: 1 });
  assert.equal(ice.countFor(one, C), 3, 'o contador do cartão do combo continua 3');
  const two = ice.swapUnits(one, C, E2, 2);
  assert.deepEqual(two, { [`${C}@${E1}`]: 1, [`${C}@${E2}`]: 2 }, 'a linha normal some quando zera');
  assert.deepEqual(ice.swapUnits(two, C, E1, 1), two, 'não há mais unidade normal para trocar: nada muda');
  const back = ice.swapUnits(two, C, E2, -1);
  assert.deepEqual(back, { [C]: 1, [`${C}@${E1}`]: 1, [`${C}@${E2}`]: 1 });
  assert.deepEqual(ice.swapUnits(back, C, E2, -5), { [C]: 2, [`${C}@${E1}`]: 1 }, 'voltar mais do que há só devolve o que há');
  assert.deepEqual(ice.swapUnits(start, C, E1, -1), start, 'nada trocado para voltar');
  assert.deepEqual(ice.swapUnits(start, C, E1, 5), { [`${C}@${E1}`]: 3 }, 'trocar mais do que há só troca o que há');
  assert.equal(ice.plainCount(one, C), 2);
  assert.equal(ice.swappedCount(one, C, E1), 1);
  assert.equal(ice.swappedCount(one, C, E2), 0);
});

test('o contador do cartão (total do produto): aumentar entra na linha normal; diminuir tira primeiro dela', () => {
  const cart = { [C]: 1, [`${C}@${E1}`]: 2 };
  assert.deepEqual(ice.setProductTotal(cart, C, 4), { [C]: 2, [`${C}@${E1}`]: 2 });
  assert.deepEqual(ice.setProductTotal(cart, C, 2), { [`${C}@${E1}`]: 2 }, 'a linha normal sai primeiro');
  assert.deepEqual(ice.setProductTotal(cart, C, 1), { [`${C}@${E1}`]: 1 }, 'depois as trocadas');
  assert.deepEqual(ice.setProductTotal(cart, C, 0), {});
  assert.equal(ice.setProductTotal(cart, C, 3), cart, 'sem mudança devolve o mesmo objeto');
  assert.deepEqual(ice.setProductTotal({ [`${A}:normal`]: 1, [`${A}:flavored`]: 2, [A]: 1 }, A, 3), { [`${A}:normal`]: 1, [`${A}:flavored`]: 2 }, 'com gelos: tira primeiro a linha sem escolha, depois os gelos');
  assert.equal(ice.countFor(ice.setProductTotal({ [`${A}:normal`]: 1 }, A, 99), A), 99);
});

test('depois que o cardápio chega: a troca que não vale mais volta a ser o combo normal', () => {
  const cart = { [C]: 1, [`${C}@${E1}`]: 2, [`${C}@${E2}`]: 1 };
  const known = (id) => (id === C ? false : undefined);
  const keep = ice.settleCart(cart, known, () => true);
  assert.equal(keep, cart, 'tudo vale: o mesmo objeto');
  const dropE2 = ice.settleCart(cart, known, (_id, to) => to === E1);
  assert.deepEqual(dropE2, { [C]: 2, [`${C}@${E1}`]: 2 }, 'a troca para o energético que sumiu volta ao combo normal (soma na linha normal)');
  assert.deepEqual(ice.settleCart(cart, known, () => false), { [C]: 4 }, 'combo sem energético definido: todas voltam');
  assert.deepEqual(ice.settleCart({ [`${C}@${E1}`]: 1 }, () => undefined, () => true), {}, 'combo que saiu do cardápio: a linha sai');
});
