import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const { describePath } = await load('server/routes/seo.ts');

test('páginas indexáveis', () => {
  for (const path of ['/', '/bebidas', '/privacidade']) assert.deepEqual([describePath(path).known, describePath(path).indexable], [true, true], path);
});

test('páginas pessoais existem mas não entram no Google', () => {
  for (const path of ['/checkout', '/pedido/ABC', '/acompanhar-pedido', '/acompanhar-pedido/ABC', '/conta', '/conta/pedidos', '/conta/pedidos/12', '/conta/recuperar', '/admin', '/admin/pedidos']) {
    const info = describePath(path);
    assert.equal(info.known, true, path);
    assert.equal(info.indexable, false, path);
  }
  assert.equal(describePath('/conta/redefinir/' + 'a'.repeat(30)).known, true);
  assert.equal(describePath('/conta/verificar/' + 'a'.repeat(30)).known, true);
});

test('endereços que não existem dão "não encontrado"', () => {
  for (const path of ['/xyz', '/bebidas/outra', '/pedido', '/pedido/a/b', '/conta/x', '/conta/redefinir/curto', '/index.php', '/wp-admin', '/api/x/../y']) {
    assert.equal(describePath(path).known, false, path);
  }
});
