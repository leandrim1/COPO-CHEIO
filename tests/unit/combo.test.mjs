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
