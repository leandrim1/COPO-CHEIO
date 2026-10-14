import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const mod = await load('src/lib/cardInput.ts');
const server = await load('server/payments/merchant.ts');

test('máscaras: número, validade e documento', () => {
  assert.equal(mod.maskCardNumber('4111111111111111'), '4111 1111 1111 1111');
  assert.equal(mod.maskCardNumber('4111 1111-1111 1111 99999'), '4111 1111 1111 1111 999');
  assert.equal(mod.maskCardNumber('abc'), '');
  assert.equal(mod.maskExpiry('1230'), '12/30');
  assert.equal(mod.maskExpiry('5'), '05');
  assert.equal(mod.maskExpiry('1'), '1');
  assert.equal(mod.maskExpiry('12/3'), '12/3');
  assert.equal(mod.maskDocument('52998224725'), '529.982.247-25');
  assert.equal(mod.maskDocument('5299822'), '529.982.2');
  assert.equal(mod.maskDocument('11222333000181'), '11.222.333/0001-81');
});

test('Luhn: cartões de teste valem, número trocado não', () => {
  for (const ok of ['4111111111111111', '5555555555554444', '4000000000000002', '4000 0000 0000 0010']) assert.equal(mod.luhnOk(ok), true, ok);
  for (const bad of ['4111111111111112', '1234567890123456', '', '411', '41111111111111111111']) assert.equal(mod.luhnOk(bad), false, bad);
});

test('validade: vale até o fim do mês; passada, mal escrita ou longe demais não', () => {
  const now = new Date(2026, 9, 14); // 14/10/2026
  assert.equal(mod.expiryForProvider('10/26', now), '10/2026');
  assert.equal(mod.expiryForProvider('09/26', now), null);
  assert.equal(mod.expiryForProvider('12/30', now), '12/2030');
  assert.equal(mod.expiryForProvider('13/30', now), null);
  assert.equal(mod.expiryForProvider('00/30', now), null);
  assert.equal(mod.expiryForProvider('1/30', now), null);
  assert.equal(mod.expiryForProvider('12/99', now), null);
  assert.equal(mod.expiryForProvider('12/2030', now), null);
});

test('CPF e CNPJ do navegador dão o mesmo resultado que os do servidor', () => {
  const samples = ['52998224725', '11111111111', '12345678909', '11222333000181', '11222333000182', '00000000000000', '123', ''];
  for (let i = 0; i < 300; i++) samples.push(String(10000000000 + i * 7919).padStart(11, '0'), String(10000000000000 + i * 104729).padStart(14, '0'));
  for (const sample of samples) {
    assert.equal(mod.validCpf(sample), server.validCpf(sample), sample);
    assert.equal(mod.validCnpj(sample), server.validCnpj(sample), sample);
  }
  assert.equal(mod.validDocument('529.982.247-25'), true);
  assert.equal(mod.validDocument('11.222.333/0001-81'), true);
  assert.equal(mod.validDocument('111.111.111-11'), false);
});
