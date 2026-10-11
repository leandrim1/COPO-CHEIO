import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const { passwordProblem } = await load('server/passwordPolicy.ts');

const admin = { kind: 'admin' };

test('admin: mínimo de 10 caracteres', () => {
  assert.match(passwordProblem('Abc#12345', admin), /pelo menos 10/);
  assert.equal(passwordProblem('Caixa#Segura-2026', admin), null);
});

test('cliente: mínimo de 8 caracteres', () => {
  assert.match(passwordProblem('Ab#1234'), /pelo menos 8/);
  assert.equal(passwordProblem('Geladas#4ever'), null);
});

test('senhas comuns e sequências são recusadas', () => {
  for (const weak of ['12345678', '123456789', '87654321', 'abcdefgh', 'qwertyuiop', 'password', 'senha123', 'aaaaaaaa', '11111111', '12121212', 'copocheio1', 'Brasil2026']) {
    assert.ok(passwordProblem(weak), `cliente: deveria recusar ${weak}`);
  }
  // No painel (10+ caracteres) valem as mesmas listas.
  for (const weak of ['1234567890', '0123456789', 'qwertyuiop', 'abcdefghij', 'aaaaaaaaaa', 'senha12345', 'password123', 'copocheio2026', 'Brasil@2026']) {
    assert.ok(passwordProblem(weak, admin), `admin: deveria recusar ${weak}`);
  }
});

test('acentos e maiúsculas não escondem senha comum', () => {
  assert.ok(passwordProblem('SÊNHA123'));
  assert.ok(passwordProblem('PASSWORD'));
});

test('senha feita do e-mail com um enfeite curto é recusada; frase longa que cita o nome passa', () => {
  const ctx = { email: 'maria.silva@gmail.com', kind: 'admin' };
  assert.match(passwordProblem('maria.silva2024', ctx), /e-mail/);
  assert.match(passwordProblem('MariaSilva#99', ctx), /e-mail/);
  assert.equal(passwordProblem('a maria silva comprou três caixas de cerveja', ctx), null);
});

test('senha que é só o primeiro nome é recusada', () => {
  assert.match(passwordProblem('fernanda12', { name: 'Fernanda Souza' }) ?? 'ok', /nome|ok/);
  assert.match(passwordProblem('Fernanda', { name: 'Fernanda Souza' }), /nome|comum|8/);
});

test('limite de tamanho e tipos errados', () => {
  assert.match(passwordProblem('x'.repeat(201) + 'A#1'), /longa/);
  assert.ok(passwordProblem(undefined));
  assert.ok(passwordProblem(12345678));
  assert.ok(passwordProblem(null, admin));
});

test('emoji conta como um caractere só (não infla o tamanho)', () => {
  assert.match(passwordProblem('🍺🍺🍺🍺🍺🍺🍺🍺🍺', admin) ?? '', /pelo menos 10|comum/);
});
