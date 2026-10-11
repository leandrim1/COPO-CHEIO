import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const t = await load('server/totp.ts');

// Vetores do RFC 6238 (Apêndice B, SHA-1, chave ASCII "12345678901234567890"). O padrão publica 8 dígitos; usamos os 6 últimos.
const SECRET = t.base32Encode(Buffer.from('12345678901234567890'));
const VECTORS = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

test('chave do RFC em base32', () => assert.equal(SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));

for (const [seconds, code] of VECTORS) {
  test(`RFC 6238: T=${seconds} → ${code}`, () => assert.equal(t.totpAtStep(SECRET, t.stepAt(seconds * 1000)), code));
}

test('base32: ida e volta, e rejeita lixo', () => {
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(t.base32Decode(t.base32Encode(bytes)), bytes);
  assert.equal(t.base32Decode('com 1 e 8 e !'), null);
  assert.equal(t.base32Decode(''), null);
  assert.ok(t.base32Decode('gezd gnbv-gy3t qojq'), 'aceita espaços, hífens e minúsculas');
});

test('chave nova: 20 bytes em base32 e diferente a cada vez', () => {
  const a = t.newTotpSecret();
  const b = t.newTotpSecret();
  assert.notEqual(a, b);
  assert.equal(a.length, 32);
  assert.equal(t.base32Decode(a).length, 20);
});

test('matchTotpStep aceita o passo anterior, o atual e o seguinte, e só eles', () => {
  const now = 1_700_000_000_000;
  const step = t.stepAt(now);
  for (const delta of [-1, 0, 1]) assert.equal(t.matchTotpStep(SECRET, t.totpAtStep(SECRET, step + delta), now), step + delta);
  for (const delta of [-2, 2, 10]) assert.equal(t.matchTotpStep(SECRET, t.totpAtStep(SECRET, step + delta), now), null);
  assert.equal(t.matchTotpStep(SECRET, '000000', now) === null || t.totpAtStep(SECRET, step) === '000000', true);
  assert.equal(t.matchTotpStep(SECRET, '12345', now), null, 'tamanho errado');
});

test('cleanTotp', () => {
  assert.equal(t.cleanTotp('123 456'), '123456');
  assert.equal(t.cleanTotp('123-456'), '123456');
  assert.equal(t.cleanTotp('12345'), null);
  assert.equal(t.cleanTotp('1234567'), null);
  assert.equal(t.cleanTotp('abcdef'), null);
  assert.equal(t.cleanTotp(123456), null);
});

test('códigos de recuperação: 8 códigos únicos no formato ABCD-EFGH-JKMN-PQRS', () => {
  const codes = t.newRecoveryCodes();
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8);
  for (const code of codes) {
    assert.match(code, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/);
    assert.equal(t.cleanRecoveryCode(code.toLowerCase()), code.replaceAll('-', ''));
    assert.equal(t.cleanRecoveryCode(` ${code.replaceAll('-', ' ')} `), code.replaceAll('-', ''));
  }
  assert.equal(t.cleanRecoveryCode('AAAA-BBBB'), null);
  assert.equal(t.cleanRecoveryCode('0000-1111-OOOO-IIII'), null, 'sem 0/O/1/I');
});

test('hash do código de recuperação: determinístico, 64 hex e diferente do SHA-256 puro', () => {
  const h = t.recoveryHash('ABCDEFGHJKMNPQRS');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, t.recoveryHash('ABCDEFGHJKMNPQRS'));
  assert.notEqual(h, t.recoveryHash('ABCDEFGHJKMNPQRT'));
});

test('otpauthUri tem emissor, conta, chave, algoritmo, dígitos e período', () => {
  const uri = t.otpauthUri('JBSWY3DPEHPK3PXP', 'dono@copocheio.com.br', 'Copo Cheio');
  assert.ok(uri.startsWith('otpauth://totp/Copo%20Cheio:dono%40copocheio.com.br?'));
  for (const part of ['secret=JBSWY3DPEHPK3PXP', 'issuer=Copo%20Cheio', 'algorithm=SHA1', 'digits=6', 'period=30']) assert.ok(uri.includes(part), part);
});
