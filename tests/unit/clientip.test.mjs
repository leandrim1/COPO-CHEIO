import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const { clientIp, normalizeIp } = await load('server/clientIp.ts');
const req = (headers) => new Request('https://example.test/api/x', { headers });

test('IPv4 passa como veio; IPv4 dentro de IPv6 volta a IPv4', () => {
  assert.equal(normalizeIp('177.12.0.9'), '177.12.0.9');
  assert.equal(normalizeIp('::ffff:177.12.0.9'), '177.12.0.9');
  assert.equal(normalizeIp(' 177.12.0.9 '), '177.12.0.9');
});

test('IPv6 vira o prefixo /64: mesmo "bairro", mesma chave', () => {
  const a = normalizeIp('2001:db8:abcd:12:1:2:3:4');
  const b = normalizeIp('2001:0db8:abcd:0012:ffff:eeee:dddd:cccc');
  const c = normalizeIp('2001:db8:abcd:13::1');
  assert.equal(a, '2001:0db8:abcd:0012::/64');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(normalizeIp('::1'), '0000:0000:0000:0000::/64');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80:0000:0000:0000::/64');
});

test('lixo vira "unknown" (nunca cria uma chave de limite nova)', () => {
  for (const bad of ['', null, undefined, 'abc', '999.1.1.1', '1.2.3', '1.2.3.4.5', '<script>', '1'.repeat(80), '2001:db8::zzzz', ':::', '1:2:3:4:5:6:7:8:9']) {
    assert.equal(normalizeIp(bad), 'unknown', String(bad));
  }
});

test('fora da Vercel: x-real-ip, depois o primeiro do x-forwarded-for', () => {
  delete process.env.VERCEL;
  assert.equal(clientIp(req({ 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '9.9.9.9, 10.0.0.2' })), '10.0.0.1');
  assert.equal(clientIp(req({ 'x-forwarded-for': '9.9.9.9, 10.0.0.2' })), '9.9.9.9');
  assert.equal(clientIp(req({})), 'unknown');
});

test('na Vercel: x-vercel-forwarded-for tem prioridade (o cliente não consegue forjá-lo)', () => {
  process.env.VERCEL = '1';
  try {
    assert.equal(clientIp(req({ 'x-vercel-forwarded-for': '200.1.2.3', 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '6.6.6.6' })), '200.1.2.3');
    assert.equal(clientIp(req({ 'x-real-ip': '10.0.0.1', 'x-forwarded-for': '6.6.6.6' })), '10.0.0.1');
    // Cabeçalho prioritário com lixo: cai para o próximo válido.
    assert.equal(clientIp(req({ 'x-vercel-forwarded-for': 'lixo', 'x-forwarded-for': '6.6.6.6' })), '6.6.6.6');
  } finally {
    delete process.env.VERCEL;
  }
});
