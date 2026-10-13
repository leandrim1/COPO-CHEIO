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
const P = (id, name, category, price, promoPrice = null, swapBaseId = null, soldOut = false) => ({ id, name, category, price, promoPrice, swapBaseId, soldOut });

test('a diferença da troca: novo − o que vem no combo, nunca abaixo de zero, com a promoção de agora', () => {
  assert.equal(c.swapDifference({ price: 14, promoPrice: null }, { price: 12, promoPrice: null }), 2);
  assert.equal(c.swapDifference({ price: 10, promoPrice: null }, { price: 12, promoPrice: null }), 0, 'mais barato: sem desconto nem devolução');
  assert.equal(c.swapDifference({ price: 12, promoPrice: null }, { price: 12, promoPrice: null }), 0);
  assert.equal(c.swapDifference({ price: 14, promoPrice: null }, { price: 12, promoPrice: 11 }), 3, 'promoção do que vem no combo');
  assert.equal(c.swapDifference({ price: 14, promoPrice: 12.5 }, { price: 12, promoPrice: 11 }), 1.5, 'promoção dos dois');
  assert.equal(c.swapDifference({ price: 9.9, promoPrice: null }, { price: 9.7, promoPrice: null }), 0.2, 'sem erro de ponto flutuante (9,90 − 9,70)');
  assert.equal(c.swapDifference({ price: 0.3, promoPrice: null }, { price: 0.1, promoPrice: null }), 0.2);
});

test('quais energéticos entram na troca de um combo', () => {
  const jack = P('j', 'Energético Jack Power 2L', 'ENERGÉTICOS', 12);
  const trop = P('t', 'Energético Tropical 2L', 'ENERGÉTICOS', 14);
  const monster = P('m', 'Energético Monster 473ml', 'ENERGÉTICOS', 9.5);
  const copao = P('cp', 'Copão com Energético Jack Power 2L', 'COPÃO COM ENERGÉTICO 2L JACK POWER', 30);
  const combo = P('c', 'COMBO ( 1 Energético Jack Power 2L )', 'COMBOS', 90, null, 'j');
  const semBase = P('c2', 'COMBO SEM', 'COMBOS', 60);
  const all = [jack, trop, monster, copao, combo, semBase];
  assert.equal(c.swapBaseOf(all, combo), jack);
  assert.equal(c.swapBaseOf(all, semBase), undefined);
  assert.deepEqual(c.swapOptions(all, combo).map((p) => p.id), ['t'], 'só energéticos de 2L, sem o que já vem no combo');
  assert.deepEqual(c.swapOptions(all, semBase), [], 'combo sem energético definido não aceita troca');
  assert.equal(c.canSwap(all, combo), true);
  assert.equal(c.canSwap(all, semBase), false);
  assert.equal(c.canSwap([jack, combo], combo), false, 'sem nenhum outro energético de 2L, não há o que escolher');
  assert.equal(c.canSwap([trop, combo], combo), false, 'o energético do combo sumiu do cardápio: não dá para calcular a diferença');
  assert.equal(c.swapStillValid(all, 'c', 't'), true);
  assert.equal(c.swapStillValid(all, 'c', 'j'), false, 'trocar pelo que já vem não vale');
  assert.equal(c.swapStillValid(all, 'c', 'm'), false, 'não é de 2L');
  assert.equal(c.swapStillValid(all, 'c', 'nao-existe'), false);
  assert.equal(c.swapStillValid(all, 'c2', 't'), false);
});
