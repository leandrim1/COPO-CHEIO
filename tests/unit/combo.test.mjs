import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const c = await load('src/lib/combo.ts');
const NOTE = 'CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA.';

test('o aviso dos combos tem o texto pedido pelo dono', () => {
  assert.equal(c.COMBO_NOTE, NOTE);
});

test('só a categoria "Combos" recebe o aviso (sem acento, maiúsculas ou espaços sobrando)', () => {
  for (const name of ['Combos', 'COMBOS', 'combos', '  Combos ', 'Combo', 'cÓmbos']) assert.equal(c.comboNote(name), NOTE, name);
});

test('outras categorias, mesmo parecidas, não recebem o aviso', () => {
  for (const name of ['Cervejas', 'Copão', 'COPÃO COM ENERGÉTICO 2L JACK POWER', 'Combos de cerveja', 'Meu combo', 'Outros', '', null, undefined]) assert.equal(c.comboNote(name), null, String(name));
});

test('a lista de energéticos usa a categoria "Energéticos" (e só ela)', () => {
  for (const name of ['ENERGÉTICOS', 'Energéticos', 'energetico', ' Energético ', 'Energéticos 2L']) assert.equal(c.isEnergeticoCategory(name), true, name);
  for (const name of ['COPÃO COM ENERGÉTICO 2L JACK POWER', 'Combos', 'Cervejas', 'Sem energético', 'Energia', '', null, undefined]) assert.equal(c.isEnergeticoCategory(name), false, String(name));
});

test('"2L" no nome: só 2 litros exatos', () => {
  for (const name of ['Energético Jack Power 2L', 'Energético Fusion 2 L', 'Energético Baly 2 Litros', 'Energético Tropical 2lts', 'Energético Monster 2000ml', '2L Energético', 'COMBO ( 1 Energético Jack Power 2L )']) assert.equal(c.isTwoLiters(name), true, name);
  for (const name of ['Energético Monster 473ml', 'Energético Red Bull 250ml', 'Refrigerante 2,5L', 'Guaraná 12L', 'Água 1,2L', 'Energético 2 latas', 'Energético 20L', 'Energético Jack Power', '', null, undefined]) assert.equal(c.isTwoLiters(name), false, String(name));
});

test('a lista de troca só tem energéticos de 2L (por categoria ou pelo começo do nome)', () => {
  const ok = [
    { name: 'Energético Jack Power 2L', category: 'ENERGÉTICOS' },
    { name: 'Jack Power Tropical 2L', category: 'Energéticos' },
    { name: 'Energético Baly 2 Litros', category: 'Outros' },
  ];
  const no = [
    { name: 'Energético Monster 473ml', category: 'ENERGÉTICOS' },
    { name: 'Refrigerante Guaraná 2L', category: 'REFRIGERANTE 2L E 2,5L' },
    { name: 'Copão com Energético Jack Power 2L', category: 'COPÃO COM ENERGÉTICO 2L JACK POWER' },
    { name: 'COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L )', category: 'COMBOS' },
    { name: 'Energético 2,5L', category: 'ENERGÉTICOS' },
  ];
  for (const p of ok) assert.equal(c.isEnergetico2L(p), true, p.name);
  for (const p of no) assert.equal(c.isEnergetico2L(p), false, p.name);
});

// ---- Troca do energético: preço (as mesmas contas do banco) ------------------------------------------
const P = (id, name, category, price, promoPrice = null, swapBaseId = null, soldOut = false, swapBasePrice = null, swapOptionIds = []) => ({
  id, name, category, price, promoPrice, swapBaseId, swapBasePrice, swapOptionIds, soldOut,
});
const NP = (price, promoPrice = null) => ({ price, promoPrice });

test('a diferença da troca: novo − o que vem no combo, nunca abaixo de zero, com a promoção de agora', () => {
  assert.equal(c.swapDifference(NP(14), 12), 2);
  assert.equal(c.swapDifference(NP(10), 12), 0, 'mais barato: sem desconto nem devolução');
  assert.equal(c.swapDifference(NP(12), 12), 0, 'mesmo valor: o preço do combo se mantém');
  assert.equal(c.swapDifference(NP(14), 11), 3, 'promoção do que vem no combo (valor já com a promoção)');
  assert.equal(c.swapDifference(NP(14, 12.5), 11), 1.5, 'promoção do novo');
  assert.equal(c.swapDifference(NP(9.9), 9.7), 0.2, 'sem erro de ponto flutuante (9,90 − 9,70)');
  assert.equal(c.swapDifference(NP(0.3), 0.1), 0.2);
});

test('o valor do energético que vem no combo: o produto escolhido (preço de agora) ou o valor digitado', () => {
  const jack = P('j', 'Energético Jack Power 2L', 'ENERGÉTICOS', 12, 11);
  const withProduct = P('c', 'COMBO A', 'COMBOS', 90, null, 'j', false, 99);
  const withValue = P('c2', 'COMBO B', 'COMBOS', 60, null, null, false, 13.5);
  const none = P('c3', 'COMBO C', 'COMBOS', 60);
  const all = [jack, withProduct, withValue, none];
  assert.equal(c.swapBasePrice(all, withProduct), 11, 'o produto escolhido vale mais que o valor digitado, e a promoção em vigor conta');
  assert.equal(c.swapBasePrice(all, withValue), 13.5);
  assert.equal(c.swapBasePrice(all, none), null);
  assert.equal(c.swapBasePrice([withProduct], withProduct), 99, 'se o produto sumiu do cardápio, vale o valor digitado');
  assert.equal(c.swapBaseLabel(all, withProduct), 'Energético Jack Power 2L');
  assert.match(c.swapBaseLabel(all, withValue), /energético de R\$\s*13,50/);
  assert.equal(c.swapBaseLabel(all, none), '');
});

test('quais energéticos entram na troca de um combo (sem lista: qualquer um de 2L; com lista: só os escolhidos)', () => {
  const jack = P('j', 'Energético Jack Power 2L', 'ENERGÉTICOS', 12);
  const trop = P('t', 'Energético Tropical 2L', 'ENERGÉTICOS', 14);
  const monster = P('m', 'Energético Monster 473ml', 'ENERGÉTICOS', 9.5);
  const copao = P('cp', 'Copão com Energético Jack Power 2L', 'COPÃO COM ENERGÉTICO 2L JACK POWER', 30);
  const combo = P('c', 'COMBO ( 1 Energético Jack Power 2L )', 'COMBOS', 90, null, 'j');
  const semBase = P('c2', 'COMBO SEM', 'COMBOS', 60);
  const all = [jack, trop, monster, copao, combo, semBase];
  assert.equal(c.swapBaseOf(all, combo), jack);
  assert.equal(c.swapBaseOf(all, semBase), undefined);
  assert.deepEqual(c.swapOptions(all, combo).map((p) => p.id), ['t'], 'sem lista: só energéticos de 2L, sem o que já vem no combo');
  assert.deepEqual(c.swapOptions(all, semBase), [], 'combo sem energético definido não aceita troca');
  assert.equal(c.canSwap(all, combo), true);
  assert.equal(c.canSwap(all, semBase), false);
  assert.equal(c.canSwap([jack, combo], combo), false, 'sem nenhum outro energético de 2L, não há o que escolher');
  assert.equal(c.canSwap([trop, combo], combo), false, 'o energético do combo sumiu do cardápio e não há valor digitado: não dá para calcular a diferença');
  assert.equal(c.swapStillValid(all, 'c', 't'), true);
  assert.equal(c.swapStillValid(all, 'c', 'j'), false, 'trocar pelo que já vem não vale');
  assert.equal(c.swapStillValid(all, 'c', 'm'), false, 'não é de 2L');
  assert.equal(c.swapStillValid(all, 'c', 'nao-existe'), false);
  assert.equal(c.swapStillValid(all, 'c2', 't'), false);

  // com lista escolhida no painel: só os marcados (mesmo que não sejam de 2L), nunca o combo nem o energético que já vem nele
  const chosen = { ...combo, swapOptionIds: ['t', 'm', 'j', 'c'] };
  const all2 = [jack, trop, monster, copao, chosen, semBase];
  assert.deepEqual(c.swapOptions(all2, chosen).map((p) => p.id).sort(), ['m', 't']);
  assert.equal(c.swapStillValid(all2, 'c', 'm'), true, 'o painel liberou este');
  assert.equal(c.swapStillValid(all2, 'c', 'cp'), false, 'não está na lista do painel');
  assert.equal(c.swapStillValid(all2, 'c', 'j'), false);
  assert.equal(c.swapStillValid(all2, 'c', 'c'), false);
});

test('combo com valor digitado (sem produto do cardápio): troca por qualquer energético 2L ou pela lista, com a diferença sobre o valor', () => {
  const trop = P('t', 'Energético Tropical 2L', 'ENERGÉTICOS', 15);
  const fusion = P('f', 'Energético Fusion 2L', 'ENERGÉTICOS', 18);
  const combo = P('c', 'COMBO ( 1 Energético Jack Power 2L )', 'COMBOS', 90, null, null, false, 15);
  const all = [trop, fusion, combo];
  assert.deepEqual(c.swapOptions(all, combo).map((p) => p.id), ['t', 'f'], 'o energético do combo não é um produto: todos os 2L entram');
  assert.equal(c.swapDifference(trop, c.swapBasePrice(all, combo)), 0, 'mesmo valor: mantém o preço do combo');
  assert.equal(c.swapDifference(fusion, c.swapBasePrice(all, combo)), 3, 'mais caro: paga a diferença');
  const only = { ...combo, swapOptionIds: ['f'] };
  assert.deepEqual(c.swapOptions([trop, fusion, only], only).map((p) => p.id), ['f']);
});
