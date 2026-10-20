import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const csv = await load('server/csv.ts');

test('texto digitado que começa com = + - @ TAB ou CR ganha um apóstrofo (nada vira fórmula na planilha)', () => {
  for (const evil of ['=1+1', '+1+1', '-2+3', '@SOMA(A1:A2)', '\t=1', '\r=1', '=HYPERLINK("http://x","clique")', "=cmd|' /C calc'!A0"]) {
    const out = csv.cell(evil);
    assert.ok(out.replace(/^"/, '').startsWith("'"), `${JSON.stringify(evil)} → ${out}`);
  }
});

test('o apóstrofo também vale quando a fórmula vem depois de espaços ou quebras de linha', () => {
  assert.ok(csv.cell('  =1+1').replace(/^"/, '').startsWith("'"));
  assert.ok(csv.cell(' =1+1').replace(/^"/, '').startsWith("'"));
  assert.ok(csv.cell('\n=1+1').replace(/^"/, '').startsWith("'"));
});

test('texto comum não muda; nome com hífen no meio e e-mail com @ no meio ficam como estão', () => {
  assert.equal(csv.cell('Maria da Silva'), 'Maria da Silva');
  assert.equal(csv.cell('Ana-Clara'), 'Ana-Clara');
  assert.equal(csv.cell('ana@exemplo.com'), 'ana@exemplo.com');
  assert.equal(csv.cell('2x Heineken | 1x Gelo'), '2x Heineken | 1x Gelo');
});

test('números e valores em reais saem como número (sem apóstrofo), com vírgula decimal', () => {
  assert.equal(csv.cell(1001), '1001');
  assert.equal(csv.cell(-3), '-3');
  assert.equal(csv.reais(12.5), '12,50');
  assert.equal(csv.reais('3'), '3,00');
  assert.equal(csv.reais(null), '0,00');
  assert.equal(csv.reais(undefined), '');
  assert.equal(csv.cell(csv.reais(12.5)), '12,50');
  assert.equal(csv.cell(12.5), '12,50');
  assert.equal(csv.cell(Number.NaN), '');
});

test('separador, aspas e quebra de linha: o campo vai entre aspas e as aspas de dentro dobram', () => {
  assert.equal(csv.cell('a;b'), '"a;b"');
  assert.equal(csv.cell('ele disse "oi"'), '"ele disse ""oi"""');
  assert.equal(csv.cell('linha 1\nlinha 2'), '"linha 1\nlinha 2"');
  assert.equal(csv.cell(' espaço nas pontas '), '" espaço nas pontas "');
});

test('caracteres de controle e NUL somem; booleanos e nulos', () => {
  assert.equal(csv.cell('a\u0000b\u0007c'), 'ab c');
  assert.equal(csv.cell(true), 'sim');
  assert.equal(csv.cell(false), 'não');
  assert.equal(csv.cell(null), '');
  assert.equal(csv.cell(undefined), '');
});

test('toCsv: BOM, ";" e CRLF; uma linha por registro; fórmula em qualquer coluna é neutralizada', () => {
  const out = csv.toCsv([['Pedido', 'Cliente', 'Obs'], [1001, '=1+1', 'a;b'], [1002, '@x', null]]);
  assert.ok(out.startsWith('﻿'));
  const lines = out.slice(1).split('\r\n');
  assert.deepEqual(lines, ['Pedido;Cliente;Obs', "1001;'=1+1;\"a;b\"", "1002;'@x;", '']);
});
