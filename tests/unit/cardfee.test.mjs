import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

// A conta da taxa do cartão em centavos inteiros: a cópia do servidor e a do navegador têm de dar sempre o mesmo resultado (e o banco, o mesmo:
// isso é provado nos testes de API contra o Postgres). Aqui a conta é conferida de fora, por outro caminho.
const server = await load('server/payments/cardFee.ts');
const browser = await load('src/lib/cardFee.ts');
const REF = { bps: 537, fixedCents: 37 };

test('exemplos conferidos à mão: R$ 10 → 10,96; R$ 100 → 106,07; R$ 0,01 → 0,40', () => {
  assert.equal(server.cardFeeCents(1000, REF), 96);
  assert.equal(server.cardTotalCents(1000, REF), 1096);
  assert.equal(server.cardFeeCents(10000, REF), 607);
  assert.equal(server.cardTotalCents(10000, REF), 10607);
  assert.equal(server.cardFeeCents(1, REF), 39);
});

test('o exemplo R$ 106,70 do pedido original NÃO é o resultado da fórmula (que dá R$ 106,07)', () => {
  assert.notEqual(server.cardTotalCents(10000, REF), 10670);
  // Prova: com R$ 106,70 a operadora ficaria com 5,37% de 106,70 + 0,37 = 6,10 e sobrariam R$ 100,60, não R$ 100,00.
  assert.equal(10670 - Math.round(10670 * 0.0537 + 37), 10060);
});

test('depois da tarifa da operadora sobra a base, com no máximo 1 centavo de diferença (arredondamento da operadora)', () => {
  let worst = 0;
  const seen = new Set();
  for (let base = 1; base <= 300000; base += 13) {
    const total = server.cardTotalCents(base, REF);
    const left = total - Math.round(total * 0.0537 + 37);
    const diff = left - base;
    worst = Math.max(worst, Math.abs(diff));
    seen.add(diff);
  }
  assert.ok(worst <= 1, `diferença máxima ${worst}`);
  assert.ok(seen.has(0), 'na maioria dos valores é exato');
});

test('a conta inteira bate com a conta em ponto flutuante, exceto onde cai exatamente no meio de um centavo', () => {
  let compared = 0;
  for (let base = 1; base <= 200000; base += 7) {
    const exact = (base + REF.fixedCents) / (1 - REF.bps / 10000);
    const frac = exact - Math.floor(exact);
    if (Math.abs(frac - 0.5) < 1e-6) continue; // empate de meio centavo: a regra é arredondar para cima, o ponto flutuante não decide
    assert.equal(server.cardTotalCents(base, REF), Math.round(exact), `base ${base}`);
    compared++;
  }
  assert.ok(compared > 25000);
});

test('metade do centavo arredonda para cima (regra do banco: floor((2N + D) / 2D))', () => {
  // 0% e R$ 0,005 não existe em centavos; procura um empate real com percentual: (base + fixa) * 10000 / (10000 − bps) terminando em ,5
  let tie = null;
  for (let base = 1; base < 100000 && tie === null; base++) {
    const n = (base + 37) * 10000;
    const d = 10000 - 537;
    if ((2 * n) % (2 * d) === d) tie = base;
  }
  if (tie === null) return; // sem empate exato nesta faixa: nada a conferir
  const n = (tie + 37) * 10000;
  const d = 10000 - 537;
  assert.equal(server.cardTotalCents(tie, REF), Math.floor(n / d) + 1);
});

test('o navegador e o servidor dão exatamente o mesmo resultado, para várias taxas', () => {
  for (const config of [REF, { bps: 0, fixedCents: 0 }, { bps: 299, fixedCents: 0 }, { bps: 0, fixedCents: 100 }, { bps: 2500, fixedCents: 1000 }, { bps: 1, fixedCents: 1 }]) {
    for (let base = 1; base <= 50000; base += 37) assert.equal(browser.cardTotalCents(base, config), server.cardTotalCents(base, config), `${JSON.stringify(config)} ${base}`);
  }
  for (const value of ['5,37', '5.37', '0', '25', '25,01', '', 'abc', '5,3799', ' 3 % ', 7.5, null]) assert.equal(browser.parsePercentToBps(value), server.parsePercentToBps(value), String(value));
  for (const value of ['0,37', '0.37', 'R$ 1,5', '10', '10,01', '-1', '', 'x', 0.37, null]) assert.equal(browser.parseMoneyToCents(value), server.parseMoneyToCents(value), String(value));
});

test('sem percentual e sem tarifa fixa não há taxa; a taxa nunca é negativa e o total nunca diminui', () => {
  assert.equal(server.cardFeeCents(12345, { bps: 0, fixedCents: 0 }), 0);
  let previous = 0;
  for (let base = 1; base <= 5000; base++) {
    const fee = server.cardFeeCents(base, REF);
    assert.ok(fee >= 0);
    const total = base + fee;
    assert.ok(total >= previous, 'o total cresce junto com a base');
    previous = total;
  }
});

test('entradas inválidas são recusadas (nunca viram NaN nem taxa estranha)', () => {
  for (const base of [0, -1, 1.5, NaN, Infinity, 2 ** 60]) assert.throws(() => server.cardTotalCents(base, REF), RangeError, String(base));
  for (const config of [{ bps: -1, fixedCents: 0 }, { bps: 2501, fixedCents: 0 }, { bps: 100.5, fixedCents: 0 }, { bps: 100, fixedCents: 1001 }, { bps: 100, fixedCents: -1 }]) assert.throws(() => server.cardTotalCents(1000, config), RangeError, JSON.stringify(config));
});

test('percentual e tarifa digitados: vírgula ou ponto, até duas casas, dentro dos limites', () => {
  assert.equal(server.parsePercentToBps('5,37'), 537);
  assert.equal(server.parsePercentToBps('5.37'), 537);
  assert.equal(server.parsePercentToBps('5%'), 500);
  assert.equal(server.parsePercentToBps('0'), 0);
  assert.equal(server.parsePercentToBps('25'), 2500);
  assert.equal(server.parsePercentToBps('25,01'), null);
  assert.equal(server.parsePercentToBps('5,371'), null);
  assert.equal(server.parsePercentToBps('-1'), null);
  assert.equal(server.parsePercentToBps(''), null);
  assert.equal(server.parseMoneyToCents('0,37'), 37);
  assert.equal(server.parseMoneyToCents('R$ 1,5'), 150);
  assert.equal(server.parseMoneyToCents('10'), 1000);
  assert.equal(server.parseMoneyToCents('10,01'), null);
  assert.equal(server.parseMoneyToCents('abc'), null);
});
