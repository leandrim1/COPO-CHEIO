import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const { maskPath } = await load('src/lib/report.ts');

test('códigos de acompanhamento e de redefinição saem mascarados do relato de erro', () => {
  assert.equal(maskPath('/pedido/ABCD-EFGH-JKMN-PQRS-TUVW'), '/pedido/:codigo');
  assert.equal(maskPath('/acompanhar-pedido/AbC123xyz_-AbC123xyz'), '/acompanhar-pedido/:codigo');
  assert.equal(maskPath('/conta/redefinir/aaaaaaaaaaaaaaaaaaaaaaaa?x=1'), '/conta/redefinir/:codigo?x=1');
  assert.equal(maskPath('/conta/verificar/aaaaaaaaaaaaaaaaaaaaaaaa'), '/conta/verificar/:codigo');
  assert.equal(maskPath('Error at https://x.test/pedido/SEGREDO123 (main.js:1)'), 'Error at https://x.test/pedido/:codigo (main.js:1)');
});

test('caminhos comuns não mudam', () => {
  for (const path of ['/', '/bebidas', '/conta', '/conta/pedidos/12', '/checkout', '/privacidade']) assert.equal(maskPath(path), path);
});
