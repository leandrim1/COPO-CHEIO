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

// ---- Dias especiais (feriado fechado e horário especial): valem no lugar do horário da semana ----------------------------------
const week = Object.fromEntries(h.DAYS.map((d) => [d.key, { open: true, start: '10:00', end: '22:00' }]));

test('dia especial "fechado": a loja não abre naquele dia, mesmo com horário na semana', () => {
  // 2026-12-25 é sexta. 15:00 em São Paulo = 18:00 UTC.
  const at = new Date('2026-12-25T18:00:00Z');
  assert.equal(h.isOpenNow(week, 'America/Sao_Paulo', at), true);
  assert.equal(h.isOpenNow(week, 'America/Sao_Paulo', at, [{ day: '2026-12-25', kind: 'closed', start_time: null, end_time: null }]), false);
  assert.equal(h.isOpenNow(week, 'America/Sao_Paulo', at, [{ day: '2026-12-24', kind: 'closed', start_time: null, end_time: null }]), true, 'o feriado de outro dia não conta');
});

test('dia especial "horário especial": só abre naquele intervalo', () => {
  const ex = [{ day: '2026-12-24', kind: 'custom', start_time: '10:00:00', end_time: '14:00:00' }];
  assert.equal(h.isOpenNow(week, 'America/Sao_Paulo', new Date('2026-12-24T16:00:00Z'), ex), true, '13:00 está dentro');
  assert.equal(h.isOpenNow(week, 'America/Sao_Paulo', new Date('2026-12-24T18:00:00Z'), ex), false, '15:00 está fora (na semana estaria aberto)');
});

test('a madrugada de um dia fechado ainda conta se a noite anterior atravessa a meia-noite', () => {
  const night = Object.fromEntries(h.DAYS.map((d) => [d.key, { open: true, start: '18:00', end: '02:00' }]));
  // 01:00 de sábado 2026-12-26 (04:00 UTC). Se o SÁBADO é feriado fechado, a sexta 18:00-02:00 continua valendo até as 02:00.
  const at = new Date('2026-12-26T04:00:00Z');
  assert.equal(h.isOpenNow(night, 'America/Sao_Paulo', at, [{ day: '2026-12-26', kind: 'closed', start_time: null, end_time: null }]), true);
  assert.equal(h.isOpenNow(night, 'America/Sao_Paulo', at, [{ day: '2026-12-25', kind: 'closed', start_time: null, end_time: null }]), false, 'sexta fechada: sem madrugada');
});

test('nextOpening pula o dia fechado e usa o horário especial', () => {
  const now = new Date('2026-12-24T12:00:00Z'); // quinta 09:00 em SP, antes de abrir
  assert.equal(h.nextOpening(week, 'America/Sao_Paulo', now), 'Abre hoje às 10:00');
  assert.equal(h.nextOpening(week, 'America/Sao_Paulo', now, [{ day: '2026-12-24', kind: 'closed', start_time: null, end_time: null }]), 'Abre amanhã às 10:00');
  assert.equal(h.nextOpening(week, 'America/Sao_Paulo', now, [{ day: '2026-12-24', kind: 'custom', start_time: '12:00', end_time: '14:00' }]), 'Abre hoje às 12:00');
});

test('addDays: atravessa mês e ano sem depender do fuso', () => {
  assert.equal(h.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(h.addDays('2026-03-01', -1), '2026-02-28');
});
