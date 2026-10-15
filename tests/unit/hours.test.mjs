import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const h = await load('src/lib/hours.ts');

test('dia de hoje no fuso da loja (não no do navegador)', () => {
  // 2026-10-15 01:30 UTC = quarta 22:30 em São Paulo (UTC−3), mas já é quinta em UTC.
  assert.equal(h.todayKey('America/Sao_Paulo', new Date('2026-10-15T01:30:00Z')), 'wed');
  assert.equal(h.todayKey('UTC', new Date('2026-10-15T01:30:00Z')), 'thu');
  assert.equal(h.todayKey('America/Sao_Paulo', new Date('2026-10-18T12:00:00Z')), 'sun');
  assert.equal(h.todayKey('America/Sao_Paulo', new Date('2026-10-17T12:00:00Z')), 'sat');
});

test('fuso inválido não derruba: cai no fuso do navegador e ainda devolve um dia', () => {
  assert.ok(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].includes(h.todayKey('Nao/Existe', new Date('2026-10-15T12:00:00Z'))));
});

test('texto do dia: horário, 24 horas e fechado', () => {
  assert.equal(h.dayHoursText({ open: true, start: '10:00', end: '23:00' }), '10:00 às 23:00');
  assert.equal(h.dayHoursText({ open: true, start: '10:00', end: '02:00' }), '10:00 às 02:00', 'passa da meia-noite');
  assert.equal(h.dayHoursText({ open: true, start: '00:00', end: '00:00' }), '24 horas');
  assert.equal(h.dayHoursText({ open: false, start: '10:00', end: '23:00' }), 'Fechado');
  assert.equal(h.dayHoursText(undefined), 'Fechado');
});

test('a ordem da lista do painel (segunda primeiro) é a de hoursLines; a janela reordena de domingo a sábado', () => {
  assert.deepEqual(h.DAYS.map((d) => d.key), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  const hours = Object.fromEntries(h.DAYS.map((d) => [d.key, { open: d.key !== 'tue', start: '10:00', end: '00:00' }]));
  assert.ok(h.hoursLines(hours).some((line) => line === 'Terça: fechado'));
});
