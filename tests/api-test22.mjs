// Cartão de crédito online com a taxa repassada ao cliente: o adaptador REAL da ValidaPay (server/payments/validapay.ts) e a loja inteira contra o
// servidor ValidaPay FALSO (tests/validapay-fake.mjs), que segue a documentação oficial da rota POST /v1/charges (cartão).
//
// ATENÇÃO: o servidor falso é uma SIMULAÇÃO escrita a partir da documentação. Estes testes provam a lógica da loja e do adaptador contra o contrato
// documentado; NÃO provam que a ValidaPay de verdade responde assim, nem que a taxa 5,37% + R$ 0,37 é a do contrato. Isso só se prova no sandbox
// da ValidaPay e no painel/contrato dela (nunca foi feito).
//
// Os 12 cenários exigidos (seções 3 a 14):  1) R$ 10 no cartão  2) R$ 100 no cartão  3) R$ 100 no Pix, sem taxa  4) mudança de quantidade
// 5) desconto (promoção; a loja não tem cupom)  6) recusa/falha  7) pendente  8) aviso (webhook) duplicado  9) valor adulterado no navegador
// 10) clique repetido  11) recarregar durante o pagamento  12) valor esperado × valor da operadora divergentes.
//
// usage: bash tests/fresh.sh && node tests/api-test22.mjs   (reinicia o servidor de teste no modo "validapay" e, no fim, volta ao normal)
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, Client, check, section, summary } from './lib.mjs';
import { FAKE, paymentSuccess, paymentSuccessCard, postWebhook, signWebhook, startFakeValidaPay } from './validapay-fake.mjs';

const root = new URL('..', import.meta.url).pathname;
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const serve = (env = {}) => execSync(`bash ${root}tests/serve.sh`, { env: { ...process.env, ...env }, stdio: 'ignore' });

const fake = await startFakeValidaPay();
const startServer = (env = {}) =>
  serve({ PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500', FAKE_VALIDAPAY_CARD_TIMEOUT_MS: '2500', ...env });
startServer();

const calls = () => fake.state.calls;
const callsTo = (method, pathPart) => calls().filter((c) => c.method === method && c.path.includes(pathPart));
const cardCalls = () => callsTo('POST', '/v1/charges').filter((c) => c.path === '/v1/charges');
const clearCalls = () => fake.control('calls/clear', {});
const hook = (payload, opts) => postWebhook(BASE, payload, opts);
const serverLog = () => readFileSync(`${root}tests/server.log`, 'utf8');
const charge = (id) => fake.state.charges.get(id);
const mode = (patch) => fake.control('mode', patch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A conta do lado de cá, escrita de outro jeito de propósito (inteiros): total = round((base + fixa) / (1 − percentual)), taxa = total − base.
const feeOf = (base, bps = 537, fixed = 37) => {
  const n = (base + fixed) * 10000;
  const d = 10000 - bps;
  return Math.floor((2 * n + d) / (2 * d)) - base;
};
const cents = (reais) => Math.round(Number(reais) * 100);
const SECRET_TEXTS = ['client-secret-de-teste', FAKE.webhookSecret, 'Bearer ', 'tok.charges', 'tok.wallet', 'tok.proposals', 'tok.subaccounts'];
const PAN = '4111111111111111';

// ------------------------------------------------------------------------------------------------
section('1. Configuração: o cartão online só liga com a taxa conferida pelo dono; a taxa mora no banco, não no navegador');
const owner = new Client(undefined, '198.51.100.70');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.71');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente22@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente22@copocheio.local', 'senha-forte-456');
{
  const fees = await owner.get('/api/admin/payment-fees/card');
  check('a taxa de referência vem do banco: 5,37% + R$ 0,37, ainda NÃO conferida', fees.status === 200 && fees.data.bps === 537 && fees.data.fixed_cents === 37 && fees.data.confirmed_at === null, fees.data);
  check('exemplos do painel (R$ 10, R$ 50, R$ 100) batem com a conta: taxa 96 / 323 / 607', JSON.stringify(fees.data.examples.map((e) => e.fee_cents)) === JSON.stringify([feeOf(1000), feeOf(5000), feeOf(10000)]) && fees.data.examples[0].fee_cents === 96 && fees.data.examples[2].fee_cents === 607 && fees.data.examples[2].total_cents === 10607, fees.data.examples);
  check('sem conferir, o cartão online não está pronto e diz o que falta: a conta do estabelecimento (subconta) e a taxa conferida', fees.data.readiness.ready === false && JSON.stringify(fees.data.readiness.missing) === JSON.stringify(['conta aprovada', 'taxa do cartão conferida']), fees.data.readiness);
  const anon = new Client();
  for (const [method, path, body] of [['get', '/api/admin/payment-fees/card'], ['patch', '/api/admin/payment-fees/card', { percent: '3', confirmed: true }], ['patch', '/api/admin/payments/card_online', { enabled: true }]]) {
    const a = await anon[method](path, body);
    const s = await staff[method](path, body);
    check(`${method.toUpperCase()} ${path.replace('/api/admin/', '')}: sem login 401 e atendente 403`, a.status === 401 && s.status === 403, [a.status, s.status]);
  }
  const early = await owner.patch('/api/admin/payments/card_online', { enabled: true });
  check('ligar o cartão online sem subconta aprovada nem taxa conferida: 409 payments_not_ready, e diz o que falta', early.status === 409 && early.data.code === 'payments_not_ready' && early.data.missing.includes('conta aprovada') && early.data.missing.includes('taxa do cartão conferida'), early.data);
  const link = await owner.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  check('a subconta do estabelecimento é vinculada (o cartão é cobrado nela, como o Pix)', link.status === 201, link.data);
  const afterLink = await owner.patch('/api/admin/payments/card_online', { enabled: true });
  check('com a subconta mas sem a taxa conferida: continua 409, agora só faltando a taxa', afterLink.status === 409 && JSON.stringify(afterLink.data.missing) === JSON.stringify(['taxa do cartão conferida']), afterLink.data);
  for (const bad of ['abc', '-1', '26', '25,01', '5,3799', '']) {
    const r = await owner.patch('/api/admin/payment-fees/card', { percent: bad, confirmed: true });
    check(`percentual inválido (${JSON.stringify(bad)}): 400 e nada muda`, r.status === 400 && r.data.code === 'invalid_percent', r.data);
  }
  for (const bad of ['abc', '-0,01', '10,01']) {
    const r = await owner.patch('/api/admin/payment-fees/card', { fixed: bad, confirmed: true });
    check(`tarifa fixa inválida (${JSON.stringify(bad)}): 400`, r.status === 400 && r.data.code === 'invalid_fixed', r.data);
  }
  const same = await owner.patch('/api/admin/payment-fees/card', {});
  check('salvar sem mudar nada e sem conferir: 400 nothing_to_save', same.status === 400 && same.data.code === 'nothing_to_save', same.data);
  check('o banco recusa taxa fora dos limites mesmo por fora da API (percentual acima de 25%)', (() => { try { psql('update payment_fee_settings set card_fee_bps = 2600 where id = 1'); return false; } catch { return true; } })());

  const ok = await owner.patch('/api/admin/payment-fees/card', { percent: '5,37', fixed: '0,37', confirmed: true });
  check('o owner confere com o contrato: fica registrado quem e quando; agora o cartão online está pronto', ok.status === 200 && ok.data.confirmed_at !== null && ok.data.confirmed_by_name !== null && ok.data.readiness.ready === true, ok.data);
  const log = (await owner.get('/api/admin/audit?entity=payment&limit=10')).data.entries.map((e) => e.summary).join(' | ');
  check('a conferência fica no histórico de atividades, com os valores', /Taxa do cartão repassada ao cliente: 5,37% \+ R\$ 0,37 \(conferida/.test(log), log);
  const site0 = (await new Client().get('/api/site')).data;
  check('desligado, o cartão online NÃO aparece para o cliente', !site0.payments.some((p) => p.code === 'card_online'), site0.payments);
  const on = await owner.patch('/api/admin/payments/card_online', { enabled: true });
  check('com tudo conferido, o owner liga o cartão online', on.status === 200 && on.data.payment.enabled === true, on.data);
  const site = (await new Client().get('/api/site')).data;
  const cardOpt = site.payments.find((p) => p.code === 'card_online');
  check('o site recebe a taxa só do cartão online (para o resumo na tela); a forma "Cartão" da entrega e o Pix ficam sem taxa', cardOpt?.card_fee?.bps === 537 && cardOpt.card_fee.fixed_cents === 37 && site.payments.filter((p) => p.code !== 'card_online').every((p) => p.card_fee === null || p.card_fee === undefined), site.payments);
  const sensitive = JSON.stringify(site);
  check('o /api/site não expõe credenciais, o Id Público nem dados da operadora', !/pub_teste|client-id|secret|validapay/i.test(sensitive));

  const confirmReq = await owner.patch('/api/admin/payment-fees/card', { percent: '6' });
  check('mudar a taxa com o cartão LIGADO sem conferir: 409 confirm_required (o cartão não fica sem taxa conferida)', confirmReq.status === 409 && confirmReq.data.code === 'confirm_required', confirmReq.data);
  const direct = psql("update payment_fee_settings set card_fee_bps = 600 where id = 1 returning (confirmed_at is null)::text");
  check('mesmo por fora da API, mudar o valor no banco TIRA a conferência (gatilho)', direct === 'true', direct);
  const sitePending = (await new Client().get('/api/site')).data;
  check('sem conferência o cartão online some do site, mesmo "ligado"', !sitePending.payments.some((p) => p.code === 'card_online'), sitePending.payments);
  await owner.patch('/api/admin/payment-fees/card', { percent: '5,37', fixed: '0,37', confirmed: true });
  check('conferida de novo, volta ao site', (await new Client().get('/api/site')).data.payments.some((p) => p.code === 'card_online'));
}

// ------------------------------------------------------------------------------------------------
const cat = (await owner.post('/api/admin/categories', { name: 'Bebidas Cartão' })).data.category;
const mkProduct = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, stock: 500, confirm_duplicate: true, ...extra })).data.product;
const p10 = await mkProduct('Cerveja Dez', 10);
const p100 = await mkProduct('Garrafa Cem', 100);
const p25 = await mkProduct('Cerveja Vinte e Cinco', 25);
const pPromo = await mkProduct('Whisky Promo', 50);
let ip = 90;
const buyer = () => new Client(undefined, `203.0.114.${ip++}`);
let phone = 0;
const nextPhone = () => `3497${String(4000000 + ++phone).slice(-7)}`;
async function placeOrder(items, extra = {}) {
  const c = buyer();
  const r = await c.post('/api/orders', { customer_name: 'Cliente Cartão', customer_phone: nextPhone(), customer_email: 'cliente.cartao@exemplo.com', delivery_type: 'pickup', payment_method: 'card_online', items, ...extra });
  return { c, r, token: r.data?.token, number: r.data?.order?.order_number, order: r.data?.order };
}
const payRows = (n) => JSON.parse(psql(`select coalesce(json_agg(row_to_json(p) order by p.attempt), '[]') from payments p join orders o on o.id = p.order_id where o.order_number = ${n}`));
const payRow = (n, attempt) => {
  const rows = payRows(n);
  return attempt ? rows.find((p) => p.attempt === attempt) : rows[rows.length - 1];
};
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const history = (n) => psql(`select coalesce(string_agg(coalesce(h.from_status, '-') || '>' || h.to_status, ' | ' order by h.created_at, h.id), '') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${n}`);
const events = () => Number(psql('select count(*) from payment_events'));
const mint = (number = PAN) => fake.control('token', { number });
async function payCard(o, { number = PAN, document = '52998224725', extra = {}, token } = {}) {
  const t = token ?? (await mint(number));
  return o.c.post(`/api/tracking/${o.token}/payment/card`, { card_token: t.cardToken, device_id: t.deviceId, document, ...extra });
}
const view = (o) => o.c.get(`/api/tracking/${o.token}/payment`);
const backdate = (n, minutes) => psql(`update payments set last_attempt_at = now() - interval '${minutes} minutes', created_at = now() - interval '${minutes} minutes', checked_at = now() - interval '${minutes} minutes' where order_id = (select id from orders where order_number = ${n}) and status in ('creating', 'pending')`);

// ------------------------------------------------------------------------------------------------
section('2. Pedido no cartão online: o banco calcula a taxa (centavos inteiros) e o total gravado é o que o cliente viu');
{
  // O formulário de pedido sem e-mail ou com a forma desligada.
  const noMail = await placeOrder([{ product_id: p10.id, quantity: 1 }], { customer_email: '' });
  check('cartão online sem e-mail: 400 (a operadora exige o e-mail do pagador)', noMail.r.status === 400 && /e-mail/i.test(noMail.r.data.error), noMail.r.data);
  const A = await placeOrder([{ product_id: p10.id, quantity: 1 }], { expected_total: 10.96 });
  check('1) R$ 10,00 no cartão → taxa R$ 0,96 e total R$ 10,96 (o mesmo que a tela mostra)', A.r.status === 201 && A.order.subtotal === 10 && A.order.payment_fee === 0.96 && A.order.total === 10.96, A.r.data);
  const rowA = orderRow(A.number);
  check('no banco: subtotal, entrega, desconto, taxa, percentual e tarifa usados e total, tudo gravado', rowA.subtotal === 10 && rowA.delivery_fee === 0 && rowA.discount === 0 && rowA.payment_fee === 0.96 && rowA.payment_fee_bps === 537 && Number(rowA.payment_fee_fixed) === 0.37 && rowA.total === 10.96 && rowA.payment_method === 'card_online' && rowA.order_status === 'awaiting_payment', rowA);

  const B = await placeOrder([{ product_id: p100.id, quantity: 1 }], { expected_total: 106.07 });
  check('2) R$ 100,00 no cartão → taxa R$ 6,07 e total R$ 106,07', B.r.status === 201 && B.order.payment_fee === 6.07 && B.order.total === 106.07, B.r.data);
  check('o exemplo do pedido (R$ 106,70) é diferente do valor correto pela fórmula: 106,07 (conferido: 106,07 × 5,37% + 0,37 = 6,07)', B.order.total !== 106.7 && Math.abs(cents(106.07) - Math.round(cents(106.07) * 0.0537 + 37) - 10000) <= 1);

  const C = await placeOrder([{ product_id: p100.id, quantity: 1 }], { payment_method: 'cash', expected_total: 100 });
  check('3) R$ 100,00 em dinheiro/na entrega (forma sem taxa): total R$ 100,00, sem taxa', C.r.status === 201 && C.order.payment_fee === 0 && C.order.total === 100, C.r.data);

  // Entrega entra na base da taxa (itens + entrega).
  const D = await placeOrder([{ product_id: p100.id, quantity: 1 }], { delivery_type: 'delivery', neighborhood: 'Centro', address: 'Rua das Flores', address_number: '10', expected_total: 1 });
  check('expected_total errado no pedido de cartão: 409 price_changed com a taxa e o total ATUAIS, e NENHUM pedido é criado', D.r.status === 409 && D.r.data.code === 'price_changed' && cents(D.r.data.payment_fee) === feeOf(10500) && cents(D.r.data.total) === 10500 + feeOf(10500), D.r.data);
  const D2 = await placeOrder([{ product_id: p100.id, quantity: 1 }], { delivery_type: 'delivery', neighborhood: 'Centro', address: 'Rua das Flores', address_number: '10' });
  const base = 10000 + 500;
  check('entrega R$ 5,00 entra na base da taxa: (100 + 5) → taxa R$ ' + (feeOf(base) / 100).toFixed(2), D2.r.status === 201 && D2.order.delivery_fee === 5 && cents(D2.order.payment_fee) === feeOf(base) && cents(D2.order.total) === base + feeOf(base), D2.r.data);

  const raw = JSON.parse(psql("select json_agg(o.total) from orders o where payment_method = 'card_online'"));
  check('só existem pedidos de cartão com total = subtotal + entrega − desconto + taxa (restrição do banco)', Number(psql("select count(*) from orders where payment_fee > 0 and total <> subtotal + delivery_fee - discount + payment_fee")) === 0 && raw.length === 3);
  const sql = psql('select card_fee_cents(1000, 537, 37), card_fee_cents(10000, 537, 37), card_fee_cents(1, 537, 37), card_fee_cents(0, 537, 37), card_fee_cents(10000, 0, 0)');
  check('a conta do banco (card_fee_cents) bate com a conta independente deste teste', sql === `${feeOf(1000)}|${feeOf(10000)}|${feeOf(1)}|${feeOf(0)}|0`, sql);
  let mismatches = 0;
  for (let base = 0; base <= 2000; base += 7) if (Number(psql(`select card_fee_cents(${base}, 537, 37)`)) !== feeOf(base)) mismatches++;
  for (let base = 0; base <= 200000; base += 1993) if (Number(psql(`select card_fee_cents(${base}, 537, 37)`)) !== feeOf(base)) mismatches++;
  check('...em centenas de valores, sem uma única diferença de centavo', mismatches === 0, mismatches);
  let farOff = 0;
  for (let base = 1; base <= 100000; base += 997) {
    const total = base + feeOf(base);
    // O que sobra depois da tarifa da operadora (percentual + fixa, arredondada ao centavo) tem de ser a base, com no máximo 1 centavo de diferença.
    const left = total - Math.round(total * 0.0537 + 37);
    if (Math.abs(left - base) > 1) farOff++;
  }
  check('o que sobra para a loja depois da tarifa 5,37% + R$ 0,37 é a base, com diferença de no máximo 1 centavo (arredondamento documentado)', farOff === 0, farOff);
}

// ------------------------------------------------------------------------------------------------
section('4. Cartão aprovado: o valor cobrado é exatamente o total mostrado; só a consulta à operadora libera o pedido');
let PAID;
{
  const o = await placeOrder([{ product_id: p100.id, quantity: 1 }], { expected_total: 106.07 });
  PAID = o;
  const before = await view(o);
  check('a tela de pagamento do pedido recebe o Id Público para o SDK (e nada secreto), com o ambiente sandbox', before.status === 200 && before.data.card_checkout?.public_id === 'pub_teste_0001' && before.data.card_checkout.environment === 'sandbox' && before.data.payment === null, before.data);
  await clearCalls();
  const tok = await mint();
  const r = await o.c.post(`/api/tracking/${o.token}/payment/card`, { card_token: tok.cardToken, device_id: tok.deviceId, document: '529.982.247-25', amount: 1, total: 1, fee: 0, payment_fee: 0, customer_fee_cents: 0 });
  check('pagamento aprovado: 200 e a tela recebe "paid" com o valor de R$ 106,07', r.status === 200 && r.data.payment.status === 'paid' && r.data.payment.amount === 106.07 && r.data.order_status === 'new' && r.data.payment_status === 'paid', r.data);
  const sent = cardCalls();
  check('UMA cobrança na operadora, em REAIS: 106.07 (o total do banco, não o do navegador), cartão de crédito à vista', sent.length === 1 && sent[0].body.amount === 106.07 && sent[0].body.paymentMethod === 'creditcard' && sent[0].body.installments === 1 && sent[0].body.passFeesToCustomer === false, sent[0]?.body);
  const p = payRow(o.number);
  check('o externalId (idempotência) é o id da tentativa da loja; o CPF vai só com dígitos; telefone em E.164; token e dispositivo como o SDK gerou', sent[0].body.externalId === p.id && sent[0].body.customer.documentNumber === '52998224725' && /^\+55349\d{8}$/.test(sent[0].body.customer.phone) && sent[0].body.cardToken === tok.cardToken && sent[0].body.deviceId === tok.deviceId, sent[0].body);
  check('o cartão é cobrado na SUBCONTA do estabelecimento (X-Sub-Account) e SEM split; escopo charges/write; metadata não é enviado (a rota do cartão não o grava)', sent[0].scope === 'charges/write' && sent[0].subAccount === '4960589' && !('split' in sent[0].body) && !('metadata' in sent[0].body), sent[0]);
  check('...e no banco o pagamento do cartão aponta para a subconta aprovada', psql(`select (p.merchant_account_id = m.id)::text from payments p cross join merchant_accounts m where p.order_id = '${orderRow(o.number).id}' and m.status = 'approved'`) === 'true');
  check('a requisição à operadora NÃO leva número de cartão nem CVV (só o token)', !JSON.stringify(sent[0].body).includes(PAN) && !('number' in sent[0].body) && !('cvv' in sent[0].body), sent[0].body);
  check('no banco: pagamento no cartão pago, taxa do cliente R$ 6,07 dentro dos R$ 106,07, tarifa da operadora R$ 6,07 e líquido R$ 100,00, sem comissão', p.method === 'card' && p.status === 'paid' && p.amount_cents === 10607 && p.customer_fee_cents === 607 && p.fee_cents === 607 && p.net_cents === 10000 && p.commission_state === 'not_applicable' && p.commission_cents === 0 && p.needs_attention === false && p.card_attempts === 1 && /^cha_/.test(p.provider_charge_id), p);
  check('o valor cobrado na operadora é igual ao total do pedido gravado', charge(p.provider_charge_id).amount === orderRow(o.number).total && orderRow(o.number).total === 106.07 && charge(p.provider_charge_id).status === 'PAID');
  check('o pedido segue para a loja na mesma transação, com histórico', orderRow(o.number).order_status === 'new' && orderRow(o.number).payment_status === 'paid' && history(o.number) === '->awaiting_payment | awaiting_payment>new', history(o.number));
  const lookups = calls().filter((c) => c.method === 'GET').map((c) => c.path.replace(p.provider_charge_id, '{id}'));
  check('quem confirma é a CONSULTA à operadora (status e detalhe com tarifa), não a resposta da criação', lookups.includes('/v1/charges/{id}/status') && lookups.includes('/v1/charges/{id}'), lookups);
  const tracking = await o.c.get(`/api/tracking/${o.token}`);
  check('o cliente vê no acompanhamento a taxa do cartão e o total pago, sem percentual nem tarifa', tracking.status === 200 && tracking.data.order.payment_fee === 6.07 && tracking.data.order.total === 106.07 && !('payment_fee_bps' in tracking.data.order) && !('payment_fee_fixed' in tracking.data.order), tracking.data.order);
  const resend = await payCard(o);
  check('pagar de novo um pedido já pago: recusado (409) e NENHUMA outra cobrança é criada', resend.status >= 400 && resend.status < 500 && cardCalls().length === 1 && fake.state.cardChargeCount === 1, [resend.status, resend.data]);
  const detail = await owner.get(`/api/admin/payments/${p.id}`);
  check('o painel mostra ao owner o valor cobrado, a taxa do cliente, a tarifa da operadora, o líquido e o código da cobrança', detail.status === 200 && detail.data.payment.customer_fee_cents === 607 && detail.data.payment.fee_cents === 607 && detail.data.payment.net_cents === 10000 && detail.data.payment.provider_charge_id === p.provider_charge_id, detail.data.payment);
  const orderDetail = await owner.get(`/api/admin/orders/${o.number}`);
  const staffDetail = await staff.get(`/api/admin/orders/${o.number}`);
  check('no pedido do painel: o owner vê taxa, percentual e tarifa usados; o atendente vê só o valor da taxa cobrado do cliente', orderDetail.data.order.payment_fee === 6.07 && orderDetail.data.order.payment_fee_bps === 537 && staffDetail.data.order.payment_fee === 6.07 && !('payment_fee_bps' in staffDetail.data.order) && !('payment_fee_fixed' in staffDetail.data.order), [orderDetail.data.order, staffDetail.data.order]);
  check('o atendente não vê código de cobrança nem tarifas do pagamento', staffDetail.data.payments.every((x) => !('provider_charge_id' in x) && !('fee_cents' in x) && !('customer_fee_cents' in x)), staffDetail.data.payments);

  // Dados sensíveis: nada de cartão, token ou CPF inteiro no banco.
  const tables = psql("select string_agg(tablename, ',') from pg_tables where schemaname = 'public'").split(',');
  const leaks = [];
  for (const t of tables) {
    const hit = Number(psql(`select count(*) from ${t} x where x::text like '%${PAN}%' or x::text like '%ctk_%' or x::text like '%${tok.cardToken}%' or x::text like '%52998224725%'`));
    if (hit) leaks.push(`${t}:${hit}`);
  }
  check('nenhuma tabela guarda número do cartão, token do cartão ou o CPF do pagador', leaks.length === 0, leaks);
}

// ------------------------------------------------------------------------------------------------
section('5. Quantidade: a taxa é recalculada no servidor a cada mudança (nunca confia no que o navegador mostrou)');
{
  const totals = [];
  for (const qty of [1, 2, 3, 7]) {
    const base = qty * 2500;
    const o = await placeOrder([{ product_id: p25.id, quantity: qty }], { expected_total: (base + feeOf(base)) / 100 });
    totals.push([qty, o.r.status, cents(o.order?.payment_fee), cents(o.order?.total)]);
    check(`${qty} × R$ 25,00 → taxa R$ ${(feeOf(base) / 100).toFixed(2)} e total R$ ${((base + feeOf(base)) / 100).toFixed(2)}`, o.r.status === 201 && cents(o.order.payment_fee) === feeOf(base) && cents(o.order.total) === base + feeOf(base), o.r.data);
  }
  check('a taxa cresce junto com o valor (não é fixa)', totals[0][2] < totals[1][2] && totals[1][2] < totals[2][2] && totals[2][2] < totals[3][2], totals);
  const stale = await placeOrder([{ product_id: p25.id, quantity: 3 }], { expected_total: (2500 + feeOf(2500)) / 100 });
  check('o navegador ficou com o total de 1 unidade e enviou 3: 409 price_changed com o total certo, nada criado', stale.r.status === 409 && stale.r.data.code === 'price_changed' && cents(stale.r.data.total) === 7500 + feeOf(7500) && cents(stale.r.data.payment_fee) === feeOf(7500), stale.r.data);
  const retry = await placeOrder([{ product_id: p25.id, quantity: 3 }], { expected_total: (7500 + feeOf(7500)) / 100 });
  check('confirmando o novo total, o pedido é criado', retry.r.status === 201 && cents(retry.order.total) === 7500 + feeOf(7500), retry.r.data);
}

// ------------------------------------------------------------------------------------------------
section('6. Desconto: a taxa incide sobre o valor já com desconto (a loja não tem cupom; o desconto que existe é a promoção do produto)');
{
  const full = await placeOrder([{ product_id: pPromo.id, quantity: 1 }], { expected_total: (5000 + feeOf(5000)) / 100 });
  check('sem promoção: R$ 50,00 + taxa', full.r.status === 201 && cents(full.order.payment_fee) === feeOf(5000), full.r.data);
  const promo = await owner.patch(`/api/admin/products/${pPromo.id}`, { promo_price: 40 });
  check('o dono coloca o produto em promoção (R$ 40,00)', promo.status === 200, promo.data);
  const withPromo = await placeOrder([{ product_id: pPromo.id, quantity: 1 }], { expected_total: (5000 + feeOf(5000)) / 100 });
  check('o navegador ainda mostrava o total antigo: 409 price_changed com a taxa sobre os R$ 40,00', withPromo.r.status === 409 && cents(withPromo.r.data.payment_fee) === feeOf(4000) && cents(withPromo.r.data.total) === 4000 + feeOf(4000), withPromo.r.data);
  const ok = await placeOrder([{ product_id: pPromo.id, quantity: 1 }], { expected_total: (4000 + feeOf(4000)) / 100 });
  check('com o total novo: subtotal R$ 40,00, taxa sobre R$ 40,00, desconto de promoção já dentro do subtotal', ok.r.status === 201 && ok.order.subtotal === 40 && cents(ok.order.payment_fee) === feeOf(4000) && cents(ok.order.total) === 4000 + feeOf(4000), ok.r.data);
  const o = await placeOrder([{ product_id: pPromo.id, quantity: 1 }]);
  await payCard(o);
  check('e o cartão é cobrado exatamente por esse total', cardCalls().at(-1).body.amount === (4000 + feeOf(4000)) / 100 && payRow(o.number).status === 'paid');
}

// ------------------------------------------------------------------------------------------------
section('7. Recusa e falha: nada é liberado, nada é cobrado, o cliente pode tentar de novo');
{
  const reasons = ['4000000000000002', '4000000000000004', '4000000000000006', '4000000000000008', '4000000000000010'];
  for (const number of reasons) {
    const o = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
    const r = await payCard(o, { number });
    const p = payRow(o.number);
    check(`cartão de teste ${number}: recusado, pedido continua aguardando pagamento e pode tentar de novo`, r.status === 200 && r.data.payment.status === 'failed' && r.data.payment.can_retry === true && /não foi aprovado/.test(r.data.payment.message) && r.data.order_status === 'awaiting_payment' && p.status === 'failed' && p.needs_attention === false, [r.data, p]);
    check('...e a mensagem ao cliente não repete o texto técnico da operadora', !/card_declined|insufficient|expired_card|invalid_cvv|fraud/i.test(JSON.stringify(r.data)), r.data);
    if (number === reasons[0]) {
      const again = await payCard(o);
      const rows = payRows(o.number);
      check('tentar de novo com outro cartão: nova tentativa (attempt 2, outro externalId) e aprovada; duas cobranças na operadora, só uma paga', again.status === 200 && again.data.payment.status === 'paid' && rows.length === 2 && cardCalls().at(-1).body.externalId === rows[1].id && cardCalls().at(-2).body.externalId === rows[0].id && rows[0].id !== rows[1].id && orderRow(o.number).order_status === 'new', [again.data, rows.map((x) => x.status)]);
    }
  }

  const exp = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  const stale = await mint();
  await fake.control('token/expire', { cardToken: stale.cardToken });
  const chargesBeforeExpired = fake.state.cardChargeCount;
  const expired = await payCard(exp, { token: stale });
  check('token do cartão vencido (mais de 5 minutos): 400 pedindo para digitar de novo; nada cobrado; tentativa encerrada', expired.status === 400 && /tempo para pagar/.test(expired.data.error) && payRow(exp.number).status === 'failed' && fake.state.cardChargeCount === chargesBeforeExpired, expired.data);
  const used = await payCard(exp, { token: stale });
  check('o mesmo token de novo: continua recusado, sem cobrança', used.status === 400 && fake.state.cardChargeCount === chargesBeforeExpired, used.data);

  const wrongDoc = await payCard(exp, { document: '11111111111' });
  check('CPF inválido: 400 antes de falar com a operadora', wrongDoc.status === 400 && wrongDoc.data.code === 'document_invalid', wrongDoc.data);
  const noToken = await exp.c.post(`/api/tracking/${exp.token}/payment/card`, { device_id: 'x'.repeat(10), document: '52998224725' });
  check('sem token do cartão: 400 card_data', noToken.status === 400 && noToken.data.code === 'card_data', noToken.data);
  const callsBeforePan = cardCalls().length;
  const pan = await exp.c.post(`/api/tracking/${exp.token}/payment/card`, { card_token: PAN, device_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', document: '52998224725', number: PAN, cvv: '123' });
  check('quem manda o NÚMERO do cartão no lugar do token: 400 card_data, NADA segue para a operadora, o banco nem o log', pan.status === 400 && pan.data.code === 'card_data' && cardCalls().length === callsBeforePan && !JSON.stringify(payRows(exp.number)).includes(PAN), pan.data);
  const spaced = await exp.c.post(`/api/tracking/${exp.token}/payment/card`, { card_token: '4111 1111 1111 1111', device_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', document: '52998224725' });
  check('...com espaços também', spaced.status === 400 && cardCalls().length === callsBeforePan, spaced.data);

  const down = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  await mode({ card: 'forbidden' });
  const denied = await payCard(down);
  check('credencial sem permissão na operadora (403): recusa definitiva, mensagem genérica ao cliente e nada vaza', denied.status === 502 && !/403|forbidden|charges\/write/i.test(JSON.stringify(denied.data)) && payRow(down.number).status === 'failed', denied.data);
  await mode({ card: null });
  const authDown = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  const chargesBeforeAuth = fake.state.cardChargeCount;
  fake.state.tokens.clear(); // a operadora "esquece" os tokens OAuth que a loja guardou (vencidos antes da hora)
  await mode({ authFail: true });
  const noAuth = await payCard(authDown);
  check('token OAuth recusado (401) e sem conseguir um novo (login da operadora fora do ar): "cartão indisponível" (503), mensagem genérica, nada cobrado', noAuth.status === 503 && /não está disponível/.test(noAuth.data.error) && !/401|unauthorized|bearer|oauth/i.test(JSON.stringify(noAuth.data)) && payRow(authDown.number).status === 'failed' && fake.state.cardChargeCount === chargesBeforeAuth, noAuth.data);
  await mode({ authFail: false });
  const afterAuth = await payCard(authDown);
  check('quando a operadora volta, o MESMO pedido consegue pagar (nova tentativa, token OAuth novo) com uma única cobrança', afterAuth.status === 200 && afterAuth.data.payment.status === 'paid' && payRows(authDown.number).length === 2 && fake.state.cardChargeCount === chargesBeforeAuth + 1, afterAuth.data);
  const renew = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  fake.state.tokens.clear();
  const renewed = await payCard(renew);
  check('token OAuth vencido antes da hora, com a operadora no ar: a loja pede outro e repete UMA vez, sem o cliente perceber (e sem cobrar duas vezes)', renewed.status === 200 && renewed.data.payment.status === 'paid' && payRows(renew.number).length === 1 && [...fake.state.charges.values()].filter((c) => c.externalId === payRow(renew.number).id).length === 1, renewed.data);
}

// ------------------------------------------------------------------------------------------------
section('8. Pendente: a operadora aceitou mas ainda não decidiu; o retorno do cliente à tela NÃO marca como pago');
let PENDING;
{
  const o = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  PENDING = o;
  await mode({ card: 'processing' });
  const before = fake.state.cardChargeCount;
  const r = await payCard(o);
  const p = payRow(o.number);
  check('processando: o pagamento fica "pending" e o pedido continua aguardando pagamento', r.status === 200 && r.data.payment.status === 'pending' && r.data.order_status === 'awaiting_payment' && p.status === 'pending' && /Aguardando a confirmação do banco/.test(r.data.payment.message) && p.provider_charge_id !== null, [r.data, p]);
  const back = await view(o);
  const back2 = await view(o);
  check('o cliente volta/recarrega a página de sucesso: continua pendente (a volta ao site nunca aprova)', back.data.payment.status === 'pending' && back2.data.payment.status === 'pending' && orderRow(o.number).order_status === 'awaiting_payment' && orderRow(o.number).payment_status !== 'paid', [back.data, orderRow(o.number)]);
  const again = await payCard(o);
  check('clicar em pagar de novo enquanto pendente: confere na operadora e NÃO cria outra cobrança', again.status === 200 && again.data.payment.status === 'pending' && fake.state.cardChargeCount === before + 1 && cardCalls().length >= 1, [again.data, fake.state.cardChargeCount - before]);
  check('a tela do cliente não mostra botão de nova tentativa nem Pix enquanto pendente', again.data.payment.can_retry === false && again.data.payment.pix === null);
  await mode({ card: null });
  const sw = await owner.post('/api/admin/payments/sweep', {});
  check('a conferência periódica não encerra um cartão pendente que a operadora ainda não decidiu', sw.status === 200 && payRow(o.number).status === 'pending' && orderRow(o.number).order_status === 'awaiting_payment', sw.data);

  // A operadora conclui (paga): o aviso verificado + a consulta liberam o pedido.
  await fake.control('pay', { chargeId: p.provider_charge_id });
  const wh = await hook(paymentSuccessCard(charge(p.provider_charge_id)), { id: 'wh-cartao-pendente-pago' });
  const done = payRow(o.number);
  check('o aviso assinado de pagamento + a consulta concluem: pago, com taxa e líquido, e o pedido é liberado uma vez', wh.status === 200 && done.status === 'paid' && done.fee_cents === 607 && done.net_cents === 10000 && orderRow(o.number).order_status === 'new' && history(o.number) === '->awaiting_payment | awaiting_payment>new', [done, history(o.number)]);

  // Outro pedido: a operadora acaba recusando.
  const o2 = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'processing' });
  await payCard(o2);
  await mode({ card: null });
  const p2 = payRow(o2.number);
  await fake.control('set-status', { chargeId: p2.provider_charge_id, status: 'FAILED' });
  const refresh = await owner.post(`/api/admin/payments/${p2.id}/refresh`);
  check('pendente que a operadora depois recusa: vira "failed", o pedido segue aguardando e o cliente pode tentar de novo', refresh.status === 200 && payRow(o2.number).status === 'failed' && orderRow(o2.number).order_status === 'awaiting_payment' && (await view(o2)).data.payment.can_retry === true);
  // Pendente há mais de uma hora: só sinaliza para o dono (a cobrança existe).
  const o3 = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'processing' });
  await payCard(o3);
  await mode({ card: null });
  backdate(o3.number, 90);
  await view(o3);
  const flagged = payRow(o3.number);
  check('pendente há mais de 1 hora: continua pendente, mas sinalizado para o dono conferir na ValidaPay', flagged.status === 'pending' && flagged.needs_attention === true && /ainda não confirmou/.test(flagged.attention_reason), flagged);
}

// ------------------------------------------------------------------------------------------------
section('9. Aviso (webhook) duplicado e forjado: autenticado, idempotente, nunca confia no corpo');
{
  const o = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'processing' });
  await payCard(o);
  await mode({ card: null });
  const p = payRow(o.number);
  const id = p.provider_charge_id;
  const body = JSON.stringify(paymentSuccessCard(charge(id)));
  const before = events();
  const forged = [
    ['assinatura de outro segredo', await hook(null, { rawBody: body, signature: signWebhook(body, { secret: 'outro-segredo' }) })],
    ['assinatura de 6 minutos atrás', await hook(null, { rawBody: body, t: Date.now() - 6 * 60_000 })],
    ['corpo adulterado', await hook(null, { rawBody: body.replace('"status":"PAID"', '"status":"PAID","x":1'), signature: signWebhook(body) })],
    ['sem assinatura', await hook(null, { rawBody: body, signature: 'nada' })],
  ];
  for (const [name, r] of forged) check(`aviso ${name}: 401 e nada gravado`, r.status === 401, r);
  check('avisos recusados não gravam nada nem liberam o pedido', events() === before && orderRow(o.number).order_status === 'awaiting_payment' && payRow(o.number).status === 'pending');

  const early = await hook(paymentSuccessCard(charge(id)), { id: 'wh-cartao-cedo' });
  check('aviso assinado de "pago" com a cobrança ainda PROCESSANDO na operadora: não libera o pedido (a fonte é a consulta)', early.status === 200 && orderRow(o.number).order_status === 'awaiting_payment' && payRow(o.number).status === 'pending', [early, payRow(o.number).status]);

  await fake.control('pay', { chargeId: id });
  const ok1 = await hook(paymentSuccessCard(charge(id)), { id: 'wh-cartao-pago' });
  const after = events();
  check('aviso assinado + consulta confirmam: pago e liberado', ok1.status === 200 && payRow(o.number).status === 'paid' && orderRow(o.number).order_status === 'new');
  const dup = await hook(paymentSuccessCard(charge(id)), { id: 'wh-cartao-pago', attempt: 2 });
  check('8) o MESMO aviso (mesmo X-Webhook-Id) reenviado é deduplicado: 200, nada se repete', dup.status === 200 && events() === after && history(o.number) === '->awaiting_payment | awaiting_payment>new', history(o.number));
  const dup2 = await hook(paymentSuccessCard(charge(id)), { id: 'wh-cartao-pago-outro-id' });
  check('...e um aviso com OUTRO identificador para a mesma cobrança não duplica pedido, histórico nem pagamento', dup2.status === 200 && history(o.number) === '->awaiting_payment | awaiting_payment>new' && payRows(o.number).length === 1 && payRow(o.number).status === 'paid');
  check('um pagamento = um único registro de "pago" no histórico de atividades', Number(psql("select count(*) from audit_log where action = 'payment.paid' and entity_id = " + lit(p.id))) === 1);
  const unknown = await hook(paymentSuccessCard({ id: 'cha_desconhecida_cartao', amount: 9, metadata: null }), { id: 'wh-cartao-desconhecido' });
  check('aviso de cobrança que a loja não conhece: 200, só registrado', unknown.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'wh-cartao-desconhecido'`) === 'unknown_charge');
  const failed = await hook({ event: 'payment.failed', accountId: '4231833', status: 'FAILED', amount: 106.07 }, { id: 'wh-falha-sem-cobranca' });
  check('payment.failed sem chargeId (formato documentado da criação): 200, registrado e ignorado', failed.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'wh-falha-sem-cobranca'`) === 'ignored');
}

// ------------------------------------------------------------------------------------------------
section('10. Valor adulterado no navegador: o servidor só usa o que está gravado no banco');
{
  const o = await placeOrder([{ product_id: p100.id, quantity: 1 }], { total: 1, payment_fee: 0, payment_fee_bps: 0, discount: 99, subtotal: 1, expected_total: 106.07 });
  check('campos de valor/taxa enviados junto do pedido (total, taxa, percentual, desconto, subtotal) são ignorados', o.r.status === 201 && o.order.total === 106.07 && o.order.payment_fee === 6.07 && orderRow(o.number).payment_fee_bps === 537 && orderRow(o.number).discount === 0 && orderRow(o.number).subtotal === 100, orderRow(o.number));
  const tk = await mint();
  const tampered = await o.c.post(`/api/tracking/${o.token}/payment/card`, { card_token: tk.cardToken, device_id: tk.deviceId, document: '52998224725', amount: 0.01, total: 0.01, amount_cents: 1, fee: 0, installments: 12, pass_fees_to_customer: true });
  check('...e no pagamento: valor, taxa, parcelas e "repassar tarifas" enviados pelo navegador não mudam nada', tampered.status === 200 && cardCalls().at(-1).body.amount === 106.07 && cardCalls().at(-1).body.installments === 1 && cardCalls().at(-1).body.passFeesToCustomer === false, cardCalls().at(-1)?.body);
  const otherClient = buyer();
  const intruder = await otherClient.post(`/api/tracking/${o.token.slice(0, -3)}abc/payment/card`, { card_token: 'ctk_aaaaaaaa', device_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', document: '52998224725' });
  check('código de acompanhamento errado não paga nem descobre o pedido de ninguém (404)', intruder.status === 404, intruder.data);

  // Formas de pagamento trocadas: o Pix não paga pedido de cartão e o cartão não paga pedido de Pix/entrega.
  const cardOrder = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  const viaPix = await cardOrder.c.post(`/api/tracking/${cardOrder.token}/payment`, { method: 'pix' });
  check('pedido de CARTÃO tentando gerar PIX: recusado, e nenhuma cobrança Pix é criada', viaPix.status >= 400 && viaPix.status < 500 && callsTo('POST', '/v1/charges/pix').length === 0 && payRows(cardOrder.number).length === 0, [viaPix.status, viaPix.data]);
  const cashOrder = await placeOrder([{ product_id: p25.id, quantity: 1 }], { payment_method: 'cash' });
  const cardOnCash = await payCard(cashOrder);
  check('pedido pago na entrega tentando o endpoint do cartão: recusado, nada cobrado', cardOnCash.status >= 400 && cardOnCash.status < 500 && payRows(cashOrder.number).length === 0, [cardOnCash.status, cardOnCash.data]);
  // O banco não aceita um total que não feche com a taxa.
  const bad = (() => { try { psql(`update orders set total = total - 1 where order_number = ${cardOrder.number}`); return false; } catch { return true; } })();
  check('o banco recusa mudar o total de um pedido de cartão sem a taxa fechar (restrição)', bad);
  const noFee = (() => { try { psql(`update orders set payment_fee = 0 where order_number = ${cardOrder.number}`); return false; } catch { return true; } })();
  check('...nem zerar a taxa deixando o total como está', noFee);
}

// ------------------------------------------------------------------------------------------------
section('11. Clique repetido e pedidos simultâneos: uma única cobrança');
{
  const o = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  const before = fake.state.cardChargeCount;
  const tokens = [await mint(), await mint(), await mint(), await mint()];
  const results = await Promise.all(tokens.map((t) => o.c.post(`/api/tracking/${o.token}/payment/card`, { card_token: t.cardToken, device_id: t.deviceId, document: '52998224725' })));
  check('4 cliques ao mesmo tempo: UMA cobrança no cartão, as outras respostas são "em andamento" ou o mesmo resultado', fake.state.cardChargeCount === before + 1 && cardCalls().filter((c) => c.body.externalId === payRow(o.number).id).length === 1, [fake.state.cardChargeCount - before, results.map((r) => r.status)]);
  check('...nenhuma resposta é erro do servidor (5xx)', results.every((r) => r.status < 500), results.map((r) => [r.status, r.data?.code]));
  check('...e o pedido fica pago uma única vez', orderRow(o.number).order_status === 'new' && payRows(o.number).length === 1 && payRow(o.number).status === 'paid' && history(o.number) === '->awaiting_payment | awaiting_payment>new');
  const sequential = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await payCard(sequential);
  await payCard(sequential);
  await payCard(sequential);
  check('cliques em sequência depois de pago: nenhuma cobrança nova', cardCalls().filter((c) => c.body.externalId === payRow(sequential.number).id).length === 1 && payRows(sequential.number).length === 1);
  // Um pedido em dois aparelhos com o mesmo código (e-mail de acompanhamento aberto duas vezes).
  const limit = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  const statuses = [];
  const chargesBeforeLimit = fake.state.cardChargeCount;
  for (let i = 0; i < 10; i++) statuses.push((await payCard(limit, { number: '4000000000000002' })).status);
  check('no máximo 5 tentativas por pedido (a 6ª em diante é recusada) e depois de 8 pedidos de pagamento em 10 minutos: 429', payRows(limit.number).length === 5 && fake.state.cardChargeCount === chargesBeforeLimit + 5 && statuses.slice(0, 5).every((s) => s === 200) && statuses.slice(5, 8).every((s) => s >= 400 && s < 500) && statuses.slice(8).every((s) => s === 429), statuses);
}

// ------------------------------------------------------------------------------------------------
section('12. Recarregar durante o pagamento e resposta perdida: nunca cobra duas vezes, nunca encerra às cegas');
{
  // (a) A operadora cobra, mas a resposta se perde (a conexão cai): o cliente recarrega e tenta de novo.
  const a = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'lose' });
  const first = await payCard(a);
  const rowA = payRow(a.number);
  check('resposta perdida: 503 card_unconfirmed ("não pague de novo") e a tentativa fica ABERTA (não vira falha nem outra cobrança)', first.status === 503 && first.data.code === 'card_unconfirmed' && rowA.status === 'creating' && fake.state.cardChargeCount >= 1 && orderRow(a.number).order_status === 'awaiting_payment', [first.data, rowA.status]);
  const callsBeforeReload = cardCalls().length;
  const reload = await view(a);
  const reload2 = await view(a);
  check('o cliente recarrega a tela: vê "estamos processando, não pague de novo", sem erro e sem nova cobrança', reload.status === 200 && reload.data.payment.status === 'creating' && /não pague de novo/.test(reload.data.payment.message) && reload.data.payment.can_retry === false && reload2.status === 200 && cardCalls().length === callsBeforeReload, reload.data);
  await mode({ card: null });
  const busy = await payCard(a);
  check('tentar de novo logo em seguida (dentro da janela de 45 s): 409 payment_in_progress, sem chamar a operadora', busy.status === 409 && busy.data.code === 'payment_in_progress', busy.data);
  const chargesBefore = fake.state.cardChargeCount;
  backdate(a.number, 2);
  const retry = await payCard(a);
  const doneA = payRow(a.number);
  check('passada a janela: mesma tentativa, MESMO externalId, token novo → a operadora responde 409 DUPLICATE_CHARGE com a cobrança original e a loja a adota', retry.status === 200 && retry.data.payment.status === 'paid' && doneA.id === rowA.id && doneA.card_attempts === 2 && cardCalls().slice(-2).every((c) => c.body.externalId === rowA.id) && fake.state.cardChargeCount === chargesBefore, [retry.data, doneA]);
  check('só uma cobrança existe na operadora para o pedido e é a que a loja guardou; o pedido foi liberado uma vez', [...fake.state.charges.values()].filter((c) => c.externalId === rowA.id).length === 1 && charge(doneA.provider_charge_id).externalId === rowA.id && orderRow(a.number).order_status === 'new' && history(a.number) === '->awaiting_payment | awaiting_payment>new');

  // (b) A operadora cai ANTES de cobrar (500 sem criar): a mesma tentativa é refeita e a cobrança nasce uma vez.
  const b = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'down' });
  const downFirst = await payCard(b);
  check('operadora fora do ar antes de cobrar (500): 503 card_unconfirmed (não dá para saber), tentativa aberta', downFirst.status === 503 && downFirst.data.code === 'card_unconfirmed' && payRow(b.number).status === 'creating', downFirst.data);
  await mode({ card: null });
  backdate(b.number, 2);
  const downRetry = await payCard(b);
  check('quando volta, a mesma tentativa cobra UMA vez e o pedido é liberado', downRetry.status === 200 && downRetry.data.payment.status === 'paid' && payRows(b.number).length === 1 && [...fake.state.charges.values()].filter((c) => c.externalId === payRow(b.number).id).length === 1);

  // (c) A operadora cobra e responde erro 500 (cobrou, mas disse que falhou).
  const c = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'down_after' });
  const afterFirst = await payCard(c);
  check('operadora cobra e responde 500: tratado como "sem confirmação" (nunca como recusa)', afterFirst.status === 503 && afterFirst.data.code === 'card_unconfirmed' && payRow(c.number).status === 'creating');
  await mode({ card: null });
  backdate(c.number, 2);
  const afterRetry = await payCard(c);
  check('na nova tentativa a operadora devolve a cobrança original (duplicada) e o pedido fecha pago, sem segunda cobrança', afterRetry.status === 200 && afterRetry.data.payment.status === 'paid' && [...fake.state.charges.values()].filter((x) => x.externalId === payRow(c.number).id).length === 1);

  // (d) A operadora não responde (tempo esgotado): mesmo caminho.
  const d = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'hang' });
  const t0 = Date.now();
  const hung = await payCard(d);
  check('operadora sem responder: a loja desiste no prazo do cartão (~2,5 s no teste) com 503 card_unconfirmed, sem pendurar o cliente', hung.status === 503 && hung.data.code === 'card_unconfirmed' && Date.now() - t0 < 12_000 && payRow(d.number).status === 'creating', [hung.status, Date.now() - t0]);
  await mode({ card: null });
  backdate(d.number, 2);
  const hungRetry = await payCard(d);
  check('e a nova tentativa adota a cobrança que a operadora chegou a criar', hungRetry.status === 200 && hungRetry.data.payment.status === 'paid' && [...fake.state.charges.values()].filter((x) => x.externalId === payRow(d.number).id).length === 1);

  // (e) Sem resposta por muito tempo: o dono é avisado; depois de 30 min é encerrada (sinalizada), sem cobrar de novo.
  const e = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'lose' });
  await payCard(e);
  await mode({ card: null });
  backdate(e.number, 3);
  const sweepNow = await owner.post('/api/admin/payments/sweep', {});
  check('a conferência periódica NÃO encerra às cegas um cartão sem resposta (a cobrança pode existir na operadora): continua aberto e sem alarme antes de 5 minutos', sweepNow.status === 200 && payRow(e.number).status === 'creating' && payRow(e.number).needs_attention === false && orderRow(e.number).order_status === 'awaiting_payment', payRow(e.number));
  backdate(e.number, 6);
  await view(e);
  const flagged = payRow(e.number);
  check('sem resposta há mais de 5 minutos: continua em aberto, mas sinalizada ao dono (confira na ValidaPay)', flagged.status === 'creating' && flagged.needs_attention === true && /Confira na ValidaPay/.test(flagged.attention_reason), flagged);
  backdate(e.number, 35);
  await view(e);
  const closed = payRow(e.number);
  check('sem resposta há mais de 30 minutos: encerrada para o estoque não ficar preso, SINALIZADA para conferir/estornar; o pedido segue aguardando', closed.status === 'failed' && closed.needs_attention === true && /estorne/.test(closed.attention_reason) && orderRow(e.number).order_status === 'awaiting_payment', closed);
  const attention = await owner.get('/api/admin/payments?attention=1');
  check('a lista do painel traz esses pagamentos para o dono conferir', attention.status === 200 && attention.data.payments.some((x) => x.id === closed.id) && attention.data.summary.attention >= 1, attention.data.summary);
}

// ------------------------------------------------------------------------------------------------
section('13. Valor esperado × valor da operadora divergentes: o pedido NÃO é liberado; a tarifa diferente é sinalizada');
{
  // (a) A operadora diz que recebeu R$ 105,07 de uma cobrança de R$ 106,07.
  const a = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ cardPaidDelta: -1 });
  const r = await payCard(a);
  const pa = payRow(a.number);
  check('valor pago diferente do cobrado: o pedido NÃO é liberado e o pagamento fica sinalizado com o motivo', orderRow(a.number).order_status === 'awaiting_payment' && pa.status === 'pending' && pa.needs_attention === true && /diferente do valor da cobrança/.test(pa.attention_reason) && r.status === 200, [r.data, pa]);
  await mode({ cardPaidDelta: 0 });

  // (b) A tarifa que a operadora cobra da loja é maior que a taxa repassada: o pedido é liberado (o cliente pagou certo), o dono é avisado.
  const b = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ cardFeePct: 6.5, cardFeeFixed: 0.37 });
  await payCard(b);
  const pb = payRow(b.number);
  check('tarifa real (6,5% + R$ 0,37 = R$ 7,26) maior que a taxa cobrada do cliente (R$ 6,07): pedido liberado, pagamento SINALIZADO com os dois valores', pb.status === 'paid' && orderRow(b.number).order_status === 'new' && pb.fee_cents === 726 && pb.needs_attention === true && /MAIOR/.test(pb.attention_reason) && /7,26/.test(pb.attention_reason) && /6,07/.test(pb.attention_reason), pb);
  // (c) Menor que a taxa repassada.
  const c = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ cardFeePct: 3.5, cardFeeFixed: 0.37 });
  await payCard(c);
  const pc = payRow(c.number);
  check('tarifa real menor que a repassada: sinalizado "o cliente pagou a mais"', pc.status === 'paid' && pc.needs_attention === true && /pagou .* a mais/.test(pc.attention_reason), pc);
  // (d) Diferença de 1 centavo (arredondamento da operadora): normal, sem alarme.
  const d = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  await mode({ cardFeePct: 5.37, cardFeeFixed: 0.38 });
  await payCard(d);
  const pd = payRow(d.number);
  check('diferença de até R$ 0,01 na tarifa: aceita, sem sinalizar (arredondamento documentado)', pd.status === 'paid' && pd.needs_attention === false, pd);
  // (e) A operadora não informa a tarifa.
  const e = await placeOrder([{ product_id: p10.id, quantity: 1 }]);
  await mode({ cardFeePct: 5.37, cardFeeFixed: 0.37, cardFeeReport: 'none' });
  await payCard(e);
  const pe = payRow(e.number);
  check('a operadora não informa a tarifa: o pedido é liberado (o valor pago confere), tarifa e líquido ficam vazios, sem inventar números', pe.status === 'paid' && pe.fee_cents === null && pe.net_cents === null && orderRow(e.number).order_status === 'new', pe);
  await mode({ cardFeeReport: 'rates' });
  // (f) Aviso de pagamento com valor falso no corpo (assinado) mas a operadora diz outro valor.
  const f = await placeOrder([{ product_id: p100.id, quantity: 1 }]);
  await mode({ card: 'processing' });
  await payCard(f);
  await mode({ card: null });
  const pf = payRow(f.number);
  await fake.control('pay', { chargeId: pf.provider_charge_id, paidAmount: 50 });
  await hook(paymentSuccessCard(charge(pf.provider_charge_id), { amount: 106.07 }), { id: 'wh-cartao-valor-falso' });
  check('aviso assinado afirmando R$ 106,07 mas a operadora informa R$ 50,00 pagos: não libera, sinaliza', orderRow(f.number).order_status === 'awaiting_payment' && payRow(f.number).needs_attention === true && payRow(f.number).status === 'pending', payRow(f.number));
  const list = await owner.get('/api/admin/payments?attention=1&limit=100');
  const summary = list.data.summary;
  check('o painel do owner lista os divergentes (precisam de conferência)', list.data.payments.filter((x) => x.method === 'card').length >= 5 && Number(summary.attention) >= 5, summary);
}

// ------------------------------------------------------------------------------------------------
section('14. Pedidos antigos e outras formas de pagamento seguem iguais');
{
  const pix = await placeOrder([{ product_id: p25.id, quantity: 1 }], { payment_method: 'pix', expected_total: 25 });
  check('Pix/dinheiro/cartão na entrega: sem taxa, total = subtotal + entrega', pix.r.status === 201 && pix.order.payment_fee === 0 && pix.order.total === 25, pix.r.data);
  const old = psql("select count(*) from orders where payment_method <> 'card_online' and (payment_fee <> 0 or payment_fee_bps is not null and payment_fee_bps <> 0)");
  check('nenhum pedido que não é de cartão online tem taxa gravada', old === '0', old);
  const fresh = await owner.get('/api/admin/orders?limit=5');
  check('o painel de pedidos continua listando normalmente', fresh.status === 200 && fresh.data.orders.length > 0);
  check('a taxa de pagamento nunca é cobrada em retirada/entrega de pedidos que não são de cartão online', Number(psql("select count(*) from payments where method = 'card' and (select payment_method from orders o where o.id = order_id) <> 'card_online'")) === 0);
}

// ------------------------------------------------------------------------------------------------
section('15. Nada sensível no log do servidor nem nas respostas');
{
  const log = serverLog();
  check('credenciais, token OAuth, segredo do webhook, número do cartão e token do cartão não aparecem no log do servidor', SECRET_TEXTS.every((s) => !log.includes(s)) && !log.includes(PAN) && !/ctk_[0-9a-f]{16}/.test(log), SECRET_TEXTS.filter((s) => log.includes(s)));
  check('nem o código de acompanhamento dos pedidos', !log.includes(PAID.token) && !log.includes(PENDING.token));
  const state = JSON.stringify(calls().filter((c) => c.path.startsWith('/v1/charges')).map((c) => c.body));
  check('nenhuma chamada à operadora (cobrança) levou número de cartão ou CVV', !state.includes(PAN) && !/"cvv"/.test(state));
  const resp = await PAID.c.get(`/api/tracking/${PAID.token}/payment`);
  check('a resposta ao cliente não traz código da cobrança, tarifas, conta do estabelecimento nem credenciais', !/cha_|4960589|client-id|secret|fee_cents|provider/i.test(JSON.stringify(resp.data)), resp.data);
}

// ------------------------------------------------------------------------------------------------
section('16. Cabeçalhos de segurança: só a tela do cartão (/pagar) tem as permissões do SDK da operadora; o resto do site continua restrito');
{
  const header = (res, name) => res.headers.get(name) ?? '';
  const directive = (csp, name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
  const card = await fetch(`${BASE}/pagar/ABCDE-ABCDE-ABCDE-ABCDE`);
  const cardCsp = header(card, 'content-security-policy');
  check('/pagar abre o aplicativo (200) e a tela do cartão tem a CSP própria', card.status === 200 && cardCsp !== '', card.status);
  check('/pagar: o SDK/antifraude da ValidaPay podem carregar (script, frame e conexão), e só esses hosts', directive(cardCsp, 'script-src') === "script-src 'self' https://*.online-metrix.net" && directive(cardCsp, 'frame-src') === 'frame-src https://*.online-metrix.net' && directive(cardCsp, 'connect-src') === "connect-src 'self' https://api.validapay.com.br https://sandbox.validapay.com.br https://*.online-metrix.net", cardCsp);
  check('/pagar continua sem script inline, sem eval, sem embutir em outro site e com relatório de violações', !/unsafe-inline.*script-src|script-src[^;]*unsafe/.test(cardCsp) && !/unsafe-eval/.test(cardCsp) && /frame-ancestors 'none'/.test(cardCsp) && /object-src 'none'/.test(cardCsp) && /report-uri \/api\/csp-report/.test(cardCsp) && /default-src 'self'/.test(cardCsp), cardCsp);
  check('/pagar: sem cache, fora do Google, sem referrer, DENY, nosniff e HSTS', /no-store/.test(header(card, 'cache-control')) && /noindex/.test(header(card, 'x-robots-tag')) && header(card, 'referrer-policy') === 'no-referrer' && header(card, 'x-frame-options') === 'DENY' && header(card, 'x-content-type-options') === 'nosniff' && /max-age=63072000/.test(header(card, 'strict-transport-security')));
  for (const path of ['/', '/bebidas', '/checkout', '/pedido/ABCDE-ABCDE-ABCDE-ABCDE', '/acompanhar-pedido', '/conta/pedidos', '/admin/pedidos', '/pagar', '/api/products']) {
    const res = await fetch(`${BASE}${path}`);
    const csp = header(res, 'content-security-policy');
    check(`${path}: a CSP restrita de sempre (script e conexão só do próprio site, nada da operadora)`, directive(csp, 'script-src') === "script-src 'self'" && directive(csp, 'connect-src') === "connect-src 'self'" && !/online-metrix|validapay/i.test(csp) && /frame-ancestors 'none'/.test(csp), csp);
  }
  const pageInfo = await new Client().get('/api/__page?__from=/pagar/ABCDE-ABCDE-ABCDE-ABCDE', { headers: { 'user-agent': 'WhatsApp/2.23' } });
  check('robôs de pré-visualização: /pagar é página conhecida, fora do Google (noindex)', pageInfo.status === 200 && /noindex/i.test(typeof pageInfo.data === 'string' ? pageInfo.data : JSON.stringify(pageInfo.data)), pageInfo.status);
  check('robots.txt proíbe /pagar/', /Disallow: \/pagar\//.test(await (await fetch(`${BASE}/robots.txt`)).text()));
}

// ------------------------------------------------------------------------------------------------
section('17. Os dois fluxos de ponta a ponta, lado a lado: Pix (subconta + split de 2%) × cartão (subconta, sem split, subtotal + taxa)');
{
  const merchantBefore = psql("select status || '|' || provider_account_id from merchant_accounts");
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('o Pix online liga (mesma subconta) e o cartão online continua ligado', on.status === 200 && (await new Client().get('/api/site')).data.payments.map((p) => p.code).includes('card_online'), on.data);
  await clearCalls();
  const baseCharges = fake.state.cardChargeCount;

  // --- Pix: valor original, split habilitado, subconta ---
  const pixOrder = await placeOrder([{ product_id: p25.id, quantity: 1 }], { payment_method: 'pix_online', expected_total: 25 });
  check('pedido de Pix online: valor ORIGINAL do pedido (R$ 25,00), sem taxa de cartão', pixOrder.r.status === 201 && pixOrder.order.total === 25 && pixOrder.order.payment_fee === 0, pixOrder.r.data);
  const pixPay = await pixOrder.c.post(`/api/tracking/${pixOrder.token}/payment`, { method: 'pix' });
  const pixCalls = callsTo('POST', '/v1/charges/pix');
  check('o Pix é gerado pelo fluxo do Pix: 201 e UMA chamada a POST /v1/charges/pix', pixPay.status === 201 && pixPay.data.payment.method === 'pix' && pixCalls.length === 1, [pixPay.status, pixCalls.length]);
  check('Pix: amount 25 (o do pedido), na SUBCONTA (X-Sub-Account), com a divisão fixa de 2% para a master', pixCalls[0].body.amount === 25 && pixCalls[0].subAccount === '4960589' && JSON.stringify(pixCalls[0].body.split) === JSON.stringify([{ type: 'fixed', amount: 0.5 }]) && pixCalls[0].body.paymentMethod === 'pix', pixCalls[0]);
  check('...e nada da cobrança do cartão foi chamado para esse pedido', cardCalls().length === 0 && fake.state.cardChargeCount === baseCharges);
  const pixRow = payRow(pixOrder.number);
  check('no banco: pagamento "pix", comissão de R$ 0,50 calculada, sem taxa de cartão e ligado à subconta', pixRow.method === 'pix' && pixRow.commission_cents === 50 && pixRow.customer_fee_cents === 0 && pixRow.merchant_account_id !== null && pixRow.amount_cents === 2500, pixRow);

  // --- Cartão: subtotal + taxa, mesma subconta, sem split ---
  await clearCalls();
  const cardOrder = await placeOrder([{ product_id: p25.id, quantity: 1 }], { expected_total: (2500 + feeOf(2500)) / 100 });
  const cardPay = await payCard(cardOrder);
  check('pedido de cartão: aprovado pelo fluxo do cartão', cardPay.status === 200 && cardPay.data.payment.method === 'card' && cardPay.data.payment.status === 'paid', cardPay.data);
  const cardSent = cardCalls();
  check('cartão: UMA chamada a POST /v1/charges (e nenhuma ao Pix), amount = subtotal + taxa, na SUBCONTA, SEM split', cardSent.length === 1 && callsTo('POST', '/v1/charges/pix').length === 0 && cardSent[0].body.amount === (2500 + feeOf(2500)) / 100 && cardSent[0].subAccount === '4960589' && !('split' in cardSent[0].body) && cardSent[0].body.paymentMethod === 'creditcard', cardSent[0]);
  const cardRow = payRow(cardOrder.number);
  check('no banco: pagamento "card", sem comissão ("não se aplica"), taxa do cliente dentro do valor, ligado à MESMA subconta do Pix', cardRow.method === 'card' && cardRow.commission_state === 'not_applicable' && cardRow.commission_cents === 0 && cardRow.customer_fee_cents === feeOf(2500) && cardRow.merchant_account_id === pixRow.merchant_account_id && cardRow.merchant_account_id !== null, cardRow);

  // --- Um nunca entra no fluxo do outro ---
  await clearCalls();
  const pixInCard = await payCard(pixOrder);
  const cardInPix = await cardOrder.c.post(`/api/tracking/${cardOrder.token}/payment`, { method: 'pix' });
  check('pedido de PIX pelo fluxo do CARTÃO: recusado (4xx) e nada é enviado à operadora', pixInCard.status >= 400 && pixInCard.status < 500 && calls().filter((c) => c.method === 'POST' && c.path.startsWith('/v1/charges')).length === 0, [pixInCard.status, pixInCard.data]);
  check('pedido de CARTÃO pelo fluxo do PIX (com split): recusado (4xx) e nada é enviado à operadora', cardInPix.status >= 400 && cardInPix.status < 500 && calls().filter((c) => c.method === 'POST' && c.path.startsWith('/v1/charges')).length === 0, [cardInPix.status, cardInPix.data]);
  check('...e nenhum pagamento extra nasceu em nenhum dos dois', payRows(pixOrder.number).length === 1 && payRows(cardOrder.number).length === 1);
  const methodSwitch = psql(`select count(*) from payments p join orders o on o.id = p.order_id where (o.payment_method = 'pix_online' and p.method <> 'pix') or (o.payment_method = 'card_online' and p.method <> 'card')`);
  check('em todo o banco: pedido de Pix só tem pagamento Pix e pedido de cartão só tem pagamento de cartão', methodSwitch === '0', methodSwitch);

  // --- Os avisos (webhooks) de sempre, um para cada fluxo ---
  const pixCharge = pixRow.provider_charge_id;
  await fake.control('pay', { chargeId: pixCharge });
  const whPix = await hook(paymentSuccess(charge(pixCharge)), { id: 'wh-fluxos-pix' });
  check('o aviso do PIX (o mesmo endpoint de sempre) confirma só o pedido de Pix, com a comissão calculada', whPix.status === 200 && payRow(pixOrder.number).status === 'paid' && orderRow(pixOrder.number).order_status === 'new' && payRow(pixOrder.number).commission_cents === 50 && payRow(cardOrder.number).status === 'paid', [whPix.status, payRow(pixOrder.number).status]);
  const before = events();
  const whCard = await hook(paymentSuccessCard(charge(cardRow.provider_charge_id)), { id: 'wh-fluxos-cartao' });
  check('o aviso do CARTÃO é aceito, sem mexer no pedido de Pix (nenhuma transição repetida)', whCard.status === 200 && events() === before + 1 && history(pixOrder.number) === '->awaiting_payment | awaiting_payment>new' && history(cardOrder.number) === '->awaiting_payment | awaiting_payment>new', [history(pixOrder.number), history(cardOrder.number)]);
  check('a subconta cadastrada não foi alterada pelo cartão', psql("select status || '|' || provider_account_id from merchant_accounts") === merchantBefore && Number(psql('select count(*) from merchant_accounts')) === 1);
  const list = await owner.get('/api/admin/payments?limit=100');
  const rows = list.data.payments.filter((x) => [pixOrder.number, cardOrder.number].includes(x.order_number));
  check('o painel lista os dois, cada um com o seu método: Pix (com taxa/comissão) e cartão (com a taxa do cliente)', rows.length === 2 && rows.find((x) => x.order_number === pixOrder.number).method === 'pix' && rows.find((x) => x.order_number === cardOrder.number).method === 'card', rows.map((x) => [x.order_number, x.method]));
}

serve();
await fake.stop();
summary();
