// Rotina automática (cron) que encerra o Pix vencido SEM depender de alguém estar com o painel aberto, contra o servidor ValidaPay FALSO (simulação escrita a
// partir da documentação; nenhum dinheiro é movido). O que se garante:
//  • Pix que venceu e não foi pago: a rotina cancela a cobrança NA operadora e encerra o pagamento; o cliente tem 10 minutos para tentar de novo e, passada a janela, a rotina cancela o
//    pedido e devolve o estoque (uma única vez);
//  • Pix pago na operadora mas com o aviso perdido: a rotina descobre pela consulta, NÃO cancela e libera o pedido (corrida pagamento × vencimento);
//  • operadora fora do ar: nada é encerrado às cegas; a rotina responde e tenta de novo na vez seguinte;
//  • rodar de novo não repete nada.
// usage: bash tests/fresh.sh && node tests/api-test35.mjs   (reinicia o servidor de teste no modo "validapay" e, no fim, volta ao normal)
import { execFileSync, execSync } from 'node:child_process';
import { Client, check, section, summary } from './lib.mjs';
import { FAKE, startFakeValidaPay } from './validapay-fake.mjs';

const root = new URL('..', import.meta.url).pathname;
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const serve = (env = {}) => execSync(`bash ${process.env.SERVE_SCRIPT ?? `${root}tests/serve.sh`}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const CRON = { authorization: 'Bearer segredo-do-cron-so-de-teste-0123456789' };

const fake = await startFakeValidaPay();
serve({ PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500' });
const calls = () => fake.state.calls;

const owner = new Client(undefined, '198.51.100.95');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client(undefined, '198.51.100.96');
await owner.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
await owner.patch('/api/admin/payments/pix_online', { enabled: true });
const cat = (await owner.post('/api/admin/categories', { name: 'Cron' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Cerveja Cron', price: 25, category_id: cat.id, stock: 100, alcoholic: false, confirm_duplicate: true })).data.product;
const stock = () => Number(psql(`select stock from products where id = '${beer.id}'`));
let ip = 20;
let phone = 0;
const payRow = (n) => JSON.parse(psql(`select row_to_json(p) from payments p join orders o on o.id = p.order_id where o.order_number = ${n} order by p.created_at desc limit 1`));
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const sweep = () => anon.get('/api/cron/sweep', { headers: CRON });
const expire = (n) => psql(`update payments set expires_at = now() - interval '5 minutes' where order_id = (select id from orders where order_number = ${n})`);
// O Pix venceu e foi encerrado; o cliente ainda tem uma janela de 10 minutos para gerar outro (RETRY_WINDOW_MINUTES). Passada a janela, o pedido é cancelado e o estoque volta.
const closeWindowPassed = (n) => psql(`update payments set closed_at = now() - interval '11 minutes' where order_id = (select id from orders where order_number = ${n}) and closed_at is not null`);

async function pixOrder() {
  const c = new Client(undefined, `203.0.113.${ip++}`);
  const r = await c.post('/api/orders', { customer_name: 'Cliente Cron', customer_phone: `3497${String(6000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: beer.id, quantity: 2 }] });
  if (r.status !== 201) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  const made = await c.post(`/api/tracking/${r.data.token}/payment`, { method: 'pix' });
  if (made.status !== 201) throw new Error(`Pix não criado: ${JSON.stringify(made.data)}`);
  return { c, number: r.data.order.order_number, token: r.data.token, chargeId: payRow(r.data.order.order_number).provider_charge_id };
}

// ------------------------------------------------------------------------------------------------
section('1. Pix vencido e não pago: a rotina encerra sozinha (ninguém abre o painel)');
{
  const before = stock();
  const A = await pixOrder();
  check('pedido de Pix online reserva o estoque (2 unidades) e fica aguardando o pagamento', stock() === before - 2 && orderRow(A.number).order_status === 'awaiting_payment' && payRow(A.number).status === 'pending');
  const early = await sweep();
  check('a rotina antes do vencimento não mexe em nada', early.status === 200 && orderRow(A.number).order_status === 'awaiting_payment' && stock() === before - 2 && payRow(A.number).status === 'pending', early.data);
  expire(A.number);
  const run = await sweep();
  check('vencido: a rotina responde 200 e encerra o pagamento', run.status === 200 && run.data.swept.closed >= 1, run.data);
  check('o pagamento deixou de estar pendente', ['expired', 'cancelled'].includes(payRow(A.number).status), payRow(A.number).status);
  check('a cobrança foi cancelada NA operadora (o QR Code deixa de valer)', calls().some((c) => c.method === 'DELETE' && c.path.includes(A.chargeId)), calls().map((c) => `${c.method} ${c.path}`).slice(-6));
  check('o cliente ainda tem a janela de nova tentativa: o pedido segue aguardando e o estoque reservado', orderRow(A.number).order_status === 'awaiting_payment' && stock() === before - 2, [orderRow(A.number).order_status, stock(), before]);
  closeWindowPassed(A.number);
  const second = await sweep();
  check('passada a janela: a rotina cancela o pedido e devolve o estoque (uma única vez)', second.status === 200 && second.data.swept.cancelled === 1 && orderRow(A.number).order_status === 'cancelled' && stock() === before, [second.data, orderRow(A.number).order_status, stock(), before]);
  check('o histórico diz quem cancelou: o sistema, por pagamento não realizado', /Sistema \(pagamento não realizado\)/.test(psql(`select string_agg(changed_by_name, ' | ') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${A.number}`)));
  const again = await sweep();
  check('rodar de novo não repete nada (estoque igual, sem novo cancelamento nem nova chamada à operadora)', again.status === 200 && again.data.swept.cancelled === 0 && stock() === before && calls().filter((c) => c.method === 'DELETE' && c.path.includes(A.chargeId)).length === 1, again.data);
  const track = await A.c.get(`/api/tracking/${A.token}`);
  check('o cliente vê o pedido cancelado', track.data.order.order_status === 'cancelled');
}

// ------------------------------------------------------------------------------------------------
section('2. Pix PAGO na operadora com o aviso perdido: a rotina não cancela');
{
  const before = stock();
  const B = await pixOrder();
  await fake.control('pay', { chargeId: B.chargeId, fee: 1.5 });
  expire(B.number);
  const run = await sweep();
  check('a rotina consulta a operadora, vê que foi pago e libera o pedido (não cancela)', run.status === 200 && orderRow(B.number).order_status === 'new' && payRow(B.number).status === 'paid', [run.data, orderRow(B.number).order_status, payRow(B.number).status]);
  check('o estoque continua reservado e a cobrança NÃO foi cancelada na operadora', stock() === before - 2 && !calls().some((c) => c.method === 'DELETE' && c.path.includes(B.chargeId)));
}

// ------------------------------------------------------------------------------------------------
section('3. Operadora fora do ar: nada é encerrado às cegas');
{
  const before = stock();
  const C = await pixOrder();
  expire(C.number);
  await fake.control('mode', { statusFail: true });
  const run = await sweep();
  check('a rotina responde (não derruba) e o pedido continua aguardando', run.status === 200 && orderRow(C.number).order_status === 'awaiting_payment' && stock() === before - 2, [run.status, orderRow(C.number).order_status]);
  check('...e a cobrança NÃO foi cancelada às cegas', !calls().some((c) => c.method === 'DELETE' && c.path.includes(C.chargeId)));
  await fake.control('mode', { statusFail: false });
  const retry = await sweep();
  check('operadora de volta: na rodada seguinte a cobrança é cancelada lá e o pagamento é encerrado', retry.status === 200 && ['expired', 'cancelled'].includes(payRow(C.number).status) && calls().some((c) => c.method === 'DELETE' && c.path.includes(C.chargeId)), [payRow(C.number).status, retry.data]);
  closeWindowPassed(C.number);
  const last = await sweep();
  check('e passada a janela de nova tentativa o pedido é cancelado e o estoque volta', last.status === 200 && orderRow(C.number).order_status === 'cancelled' && stock() === before, [orderRow(C.number).order_status, stock(), before]);
}

section('4. O registro da rotina');
{
  const st = (await anon.get('/api/cron/status', { headers: CRON })).data.sweep;
  check('a última execução foi registrada com sucesso, há poucos segundos', st && st.ok === true && st.age < 60, st);
  check('o resumo não leva dado de cliente nem segredo', !/Cliente Cron|segredo|Bearer|3497/.test(psql("select detail from job_runs where name = 'sweep'")));
}

serve({});
summary();
