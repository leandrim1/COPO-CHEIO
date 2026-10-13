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
