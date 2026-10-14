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

// ---- Taxa de serviço do Pix (2,5% do cliente + 2,5% do estabelecimento = 5% para a conta master) ------------------------------------------
// A conta é feita no banco (service_fee_cents); a cópia do navegador só mostra o total antes de o cliente confirmar. Aqui: exemplos à mão e
// as duas cópias iguais entre si e iguais a uma conta de referência.

test('Pix: exemplos conferidos à mão (R$ 100 → cliente R$ 102,50, master R$ 5,00, subconta R$ 97,50)', () => {
  const base = 10000;
  const customer = server.serviceFeeCents(base, 250);
  const commission = server.serviceFeeCents(base, 500);
  assert.equal(customer, 250);
  assert.equal(base + customer, 10250);
  assert.equal(commission, 500);
  assert.equal(base + customer - commission, 9750, 'a subconta recebe o valor do pedido menos a parte do estabelecimento');
  // R$ 25,00: 0,625 → 0,63 (metade para cima); 5% = 1,25
  assert.equal(server.serviceFeeCents(2500, 250), 63);
  assert.equal(server.serviceFeeCents(2500, 500), 125);
  assert.equal(2500 + 63 - 125, 2438);
  // R$ 10,10 e R$ 17,65 (os valores de teste do projeto)
  assert.equal(server.serviceFeeCents(1010, 250), 25);
  assert.equal(server.serviceFeeCents(1010, 500), 51);
  assert.equal(server.serviceFeeCents(1765, 250), 44);
  assert.equal(server.serviceFeeCents(1765, 500), 88);
});

test('Pix: a taxa de 5% é arredondada UMA vez (não é a soma de duas metades arredondadas)', () => {
  let different = 0;
  for (let base = 1; base <= 100000; base++) {
    const once = server.serviceFeeCents(base, 500);
    const twice = server.serviceFeeCents(base, 250) * 2;
    assert.ok(Math.abs(once - twice) <= 1, `base ${base}`);
    if (once !== twice) different++;
  }
  assert.ok(different > 0, 'existem valores em que arredondar duas vezes daria 1 centavo a mais: por isso a comissão é calculada uma vez só');
});

test('Pix: a parte do estabelecimento (5% − taxa do cliente) nunca é negativa e a soma fecha em centavos', () => {
  for (let base = 1; base <= 200000; base += 3) {
    const customer = server.serviceFeeCents(base, 250);
    const commission = server.serviceFeeCents(base, 500);
    const store = commission - customer;
    assert.ok(store >= 0 && store <= customer + 1, `base ${base}: cliente ${customer}, estabelecimento ${store}`);
    assert.equal(customer + store, commission, 'cliente + estabelecimento = o que vai para a master');
    const charged = base + customer;
    assert.ok(charged - commission === base - store, `a subconta recebe o pedido menos a parte do estabelecimento (base ${base})`);
  }
});

test('Pix: o navegador e o servidor dão o mesmo resultado, igual à conta de referência (inteiros, metade para cima)', () => {
  for (const bps of [0, 1, 250, 300, 500, 999, 1000]) {
    for (let base = 1; base <= 300000; base += 31) {
      const reference = Number((BigInt(base) * BigInt(bps) + 5000n) / 10000n);
      assert.equal(server.serviceFeeCents(base, bps), reference, `servidor ${base} ${bps}`);
      assert.equal(browser.serviceFeeCents(base, bps), reference, `navegador ${base} ${bps}`);
    }
  }
  assert.equal(server.MAX_SERVICE_BPS, 1000);
  assert.equal(browser.MAX_SERVICE_BPS, 1000);
});

test('Pix: entradas inválidas são recusadas (nunca viram NaN nem taxa estranha)', () => {
  for (const base of [-1, 1.5, NaN, Infinity, 2 ** 60]) assert.throws(() => server.serviceFeeCents(base, 250), RangeError, String(base));
  for (const bps of [-1, 1001, 2.5, NaN]) assert.throws(() => server.serviceFeeCents(1000, bps), RangeError, String(bps));
  assert.equal(server.serviceFeeCents(0, 250), 0);
  assert.equal(server.serviceFeeCents(1000, 0), 0);
});
