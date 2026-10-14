// Pagamento online (migration 0014): Pix com comissão de 2%, confirmação só por canal confiável, avisos repetidos, falhas e conciliação.
//
// ATENÇÃO: aqui NÃO existe a ValidaPay. A operadora é um SIMULADOR (tests/payments-sim.mjs) que cumpre o contrato da loja
// (server/payments/types.ts). Estes testes provam a lógica da loja (banco, estados, idempotência, segurança, painel), e não que a
// integração com a ValidaPay funciona: isso só se prova no sandbox da ValidaPay, com o adaptador real.
//
// usage: bash tests/fresh.sh && node tests/api-test14.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { BASE, Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', [...P, '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const root = new URL('..', import.meta.url).pathname;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Controles do simulador (rotas /__pay/* do servidor de teste) ----------------------------------------------------------------------
const simPost = (path, body) => fetch(`${BASE}/__pay/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
const sim = {
  reset: () => simPost('reset'),
  mode: (m) => simPost('mode', m),
  state: () => fetch(`${BASE}/__pay/state`).then((r) => r.json()),
  charge: (id, patch) => simPost(`charge/${id}`, patch),
  hook: (body) => simPost('webhook', body),
};

// ------------------------------------------------------------------------------------------------
section('1. Banco de produção antes da mudança: a migration 0014 só acrescenta');
{
  const db = 'legacy14_a';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover', '0008_store_whatsapp', '0009_security_foundations', '0010_promo_window', '0011_orders_integrity', '0012_privacy', '0013_ice_choice'];
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const migrate = () => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  const q = (sql) => psql(sql, db);
  const create = (extra) => JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Antigo', customer_phone: `3499000${String(Math.floor(Math.random() * 9000) + 1000)}`, delivery_type: 'pickup', items: [{ product_id: prod, quantity: 1 }], ...extra }))}::jsonb)`));
  const refusal = (extra) => {
    try {
      create(extra);
      return '';
    } catch (error) {
      return String(error.stderr ?? error.message);
    }
  };

  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  const prod = q(`insert into products (name, price, stock) values ('Produto Antigo', 20, 10) returning id`);
  const before = create({ payment_method: 'pix' });
  const beforeCash = create({ payment_method: 'cash', change_for: '50' });
  const dashBefore = JSON.parse(q('select admin_dashboard(7)'));

  const out = migrate();
  check('migrate.mjs aplica as novas (0014 em diante), nenhuma das antigas', /aplicada: 0014_online_payments/.test(out) && /aplicada: 0016_commission_2_percent/.test(out) && !/aplicada: 00(0|1[0-3])/.test(out), out);
  check('os pedidos que já existiam continuam iguais (status, pagamento, total)', q(`select string_agg(order_number || ':' || order_status || ':' || payment_status || ':' || payment_method || ':' || total, ',' order by order_number) from orders`) === `${before.order_number}:new:pending:pix:20.00,${beforeCash.order_number}:new:pending:cash:20.00`);
  check('o estoque reservado antes da mudança continua o mesmo', q(`select stock from products where id = ${lit(prod)}`) === '8');
  check('nasce o meio "pix_online", DESLIGADO', q(`select enabled::text from payment_methods where code = 'pix_online'`) === 'false');
  check('os meios de pagamento de antes não mudaram', q(`select string_agg(code || ':' || enabled, ',' order by position) from payment_methods where code not in ('pix_online', 'card_online')`) === 'pix:true,cash:true,card:true');
  check('nenhuma cobrança, subconta ou aviso criados', q('select (select count(*) from payments) + (select count(*) from merchant_accounts) + (select count(*) from payment_events)') === '0');
  const dashAfter = JSON.parse(q('select admin_dashboard(7)'));
  check('o painel mostra os mesmos números de antes (pedidos, receita, em andamento)', dashAfter.cards.today_orders === dashBefore.cards.today_orders && dashAfter.cards.revenue_today === dashBefore.cards.revenue_today && dashAfter.cards.pending === dashBefore.cards.pending && dashAfter.cards.awaiting_payment === 0, { antes: dashBefore.cards, depois: dashAfter.cards });
  const old = JSON.parse(q(`select order_json(id) from orders where order_number = ${before.order_number}`));
  check('o pedido de antes, como o cliente vê, não ganha o campo "payment"', !('payment' in old), Object.keys(old));

  const next = create({ payment_method: 'cash' });
  check('depois da migration, pedido em dinheiro/pix com chave continua entrando como "novo"', next.order_status === 'new' && create({ payment_method: 'pix' }).order_status === 'new');
  check('"pix_online" desligado: o banco recusa', refusal({ payment_method: 'pix_online' }).includes('Escolha uma forma de pagamento disponível'));
  q(`update payment_methods set enabled = true where code = 'pix_online'`);
  check('ligado, mas SEM conta aprovada: o banco recusa com aviso claro', refusal({ payment_method: 'pix_online' }).includes('O pagamento online não está disponível agora'));

  // A conta (subconta): o identificador definitivo só existe depois da aprovação.
  const bad = (sql) => {
    try {
      q(sql);
      return false;
    } catch {
      return true;
    }
  };
  check('subconta aprovada sem identificador definitivo: recusada pelo banco', bad(`insert into merchant_accounts (provider, status) values ('simulador', 'approved')`));
  check('identificador definitivo numa proposta ainda pendente: recusado', bad(`insert into merchant_accounts (provider, status, provider_account_id) values ('simulador', 'pending', 'sub-x')`));
  q(`insert into merchant_accounts (provider, kind, status, proposal_id) values ('simulador', 'pj', 'pending', 'prop-1')`);
  check('proposta repetida (mesmo identificador) é recusada', bad(`insert into merchant_accounts (provider, status, proposal_id) values ('simulador', 'duplicate', 'prop-1')`));
  q(`update merchant_accounts set status = 'approved', provider_account_id = 'sub-legacy' where proposal_id = 'prop-1'`);
  check('só uma subconta aprovada por operadora', bad(`insert into merchant_accounts (provider, status, provider_account_id) values ('simulador', 'approved', 'sub-outra')`));

  const online = create({ payment_method: 'pix_online', items: [{ product_id: prod, quantity: 2 }] });
  check('com conta aprovada, o pedido online nasce "aguardando pagamento" e reserva o estoque (10 − 2 de antes − 2 − 2)', online.order_status === 'awaiting_payment' && online.payment_status === 'pending' && q(`select stock from products where id = ${lit(prod)}`) === '4', q(`select stock from products where id = ${lit(prod)}`));
  check('...e fica registrado no histórico como aguardando pagamento', q(`select to_status from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${online.order_number}`) === 'awaiting_payment');
  const again = migrate();
  check('rodar de novo não faz nada', /Banco já está atualizado/.test(again), again);
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('1b. Migration 0016 (comissão de 5% → 2%): só vale para cobranças novas; as antigas mantêm a taxa de quando nasceram');
{
  const db = 'legacy16_a';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover', '0008_store_whatsapp', '0009_security_foundations', '0010_promo_window', '0011_orders_integrity', '0012_privacy', '0013_ice_choice', '0014_online_payments', '0015_merchant_account_flow'];
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const migrate = () => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  const q = (sql) => psql(sql, db);
  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  const prod = q(`insert into products (name, price, stock) values ('Produto 0016', 25, 50) returning id`);
  q(`insert into merchant_accounts (provider, kind, status, proposal_id) values ('simulador', 'pj', 'pending', 'prop-16')`);
  q(`update merchant_accounts set status = 'approved', provider_account_id = 'sub-16' where proposal_id = 'prop-16'`);
  q(`update payment_methods set enabled = true where code = 'pix_online'`);
  const begin = (n) => {
    const order = JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Dezesseis', customer_phone: `3499111${String(1000 + n)}`, delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: prod, quantity: 1 }] }))}::jsonb)`));
    const id = q(`select id from orders where order_number = ${order.order_number}`);
    return JSON.parse(q(`select payment_begin(${lit(id)}::uuid, 'pix', 'simulador')`)).payment;
  };
  check('antes da 0016 a taxa ainda é a da 0014 (5%)', q('select payment_commission_bps()') === '500');
  const old = begin(1);
  check('uma cobrança criada nessa época guarda 5%: R$ 25,00 → comissão 125 (500 pontos-base)', old.commission_bps === 500 && old.commission_cents === 125 && old.amount_cents === 2500, old);
  const out = migrate();
  check('migrate.mjs aplica a 0016 e as seguintes, nenhuma das antigas', /aplicada: 0016_commission_2_percent/.test(out) && !/aplicada: 00(0|1[0-5])/.test(out), out);
  check('a taxa vigente passa a ser 2% (200 pontos-base)', q('select payment_commission_bps()') === '200');
  const kept = JSON.parse(q(`select to_jsonb(p) from payments p where id = ${lit(old.id)}::uuid`));
  check('a cobrança de antes NÃO é reescrita: segue com 500 pontos-base e comissão 125', kept.commission_bps === 500 && kept.commission_cents === 125 && kept.status === old.status, kept);
  const fresh = begin(2);
  check('a cobrança nova (já na regra de taxa de serviço da 0020) usa 5%: R$ 25,00 → cliente paga R$ 25,63, comissão 125 (500 pontos-base)', fresh.commission_bps === 500 && fresh.commission_cents === 125 && fresh.amount_cents === 2563 && fresh.customer_fee_cents === 63, fresh);
  check('rodar de novo não faz nada', /Banco já está atualizado/.test(migrate()));
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('1c. Migration 0020 (taxa de serviço do Pix: 2,5% cliente + 2,5% estabelecimento = 5%): pedidos de antes mantêm total e comissão de 2%');
{
  const db = 'legacy20_a';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = readdirSync(`${root}db/migrations`).filter((f) => f.endsWith('.sql')).map((f) => f.replace(/\.sql$/, '')).sort().filter((f) => f < '0020');
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const migrate = () => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  const q = (sql) => psql(sql, db);
  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  const prod = q(`insert into products (name, price, stock) values ('Produto 0020', 25, 50) returning id`);
  q(`insert into merchant_accounts (provider, kind, status, proposal_id) values ('simulador', 'pj', 'pending', 'prop-20')`);
  q(`update merchant_accounts set status = 'approved', provider_account_id = 'sub-20' where proposal_id = 'prop-20'`);
  q(`update payment_methods set enabled = true where code = 'pix_online'`);
  const place = (n) => JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Vinte', customer_phone: `3499222${String(1000 + n)}`, delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: prod, quantity: 1 }] }))}::jsonb)`));
  const begin = (order) => JSON.parse(q(`select payment_begin((select id from orders where order_number = ${order.order_number}), 'pix', 'simulador')`)).payment;
  const orderOf = (order) => JSON.parse(q(`select to_jsonb(o) from orders o where order_number = ${order.order_number}`));

  check('antes da 0020 não existe taxa de serviço do Pix', q(`select count(*) from information_schema.columns where table_name = 'orders' and column_name = 'payment_fee'`) === '0');
  const orderWithPayment = place(1);
  const payAntes = begin(orderWithPayment);
  const orderWithoutPayment = place(2);
  check('pedido de antes: total R$ 25,00 e comissão de 2% (50)', payAntes.amount_cents === 2500 && payAntes.commission_bps === 200 && payAntes.commission_cents === 50, payAntes);

  const out = migrate();
  check('migrate.mjs aplica só a 0020', /aplicada: 0020_card_online/.test(out) && !/aplicada: 00(0|1)/.test(out), out);
  const kept = JSON.parse(q(`select to_jsonb(p) from payments p where id = ${lit(payAntes.id)}::uuid`));
  check('a cobrança de antes NÃO é reescrita: 2500, 200 pontos-base, comissão 50, sem taxa do cliente', kept.amount_cents === 2500 && kept.commission_bps === 200 && kept.commission_cents === 50 && kept.customer_fee_cents === 0 && kept.status === payAntes.status, kept);
  const o1 = orderOf(orderWithPayment);
  const o2 = orderOf(orderWithoutPayment);
  check('os pedidos de antes seguem com o mesmo total (25,00), sem taxa de serviço e sem percentual gravado', Number(o1.total) === 25 && Number(o1.payment_fee) === 0 && o1.payment_fee_bps === null && Number(o2.total) === 25 && Number(o2.payment_fee) === 0 && o2.payment_fee_bps === null, [o1, o2]);
  const late = begin(orderWithoutPayment);
  check('pedido feito antes, cobrança aberta depois da 0020: continua com o total de antes e a comissão de 2%', late.amount_cents === 2500 && late.commission_bps === 200 && late.commission_cents === 50 && late.customer_fee_cents === 0, late);

  const fresh = place(3);
  const freshOrder = orderOf(fresh);
  check('pedido novo: o total já traz a taxa do cliente (R$ 25,00 + R$ 0,63) e grava o percentual de 2,5%', Number(freshOrder.total) === 25.63 && Number(freshOrder.payment_fee) === 0.63 && freshOrder.payment_fee_bps === 250, freshOrder);
  const freshPay = begin(fresh);
  check('cobrança nova: 2563, comissão de 5% = 125 (500 pontos-base), cliente 63 e estabelecimento 62', freshPay.amount_cents === 2563 && freshPay.commission_bps === 500 && freshPay.commission_cents === 125 && freshPay.customer_fee_cents === 63 && freshPay.commission_cents - freshPay.customer_fee_cents === 62, freshPay);
  check('a subconta fica com o valor cobrado menos a comissão: 2563 − 125 = 2438', freshPay.amount_cents - freshPay.commission_cents === 2438);

  q(`update payment_fee_settings set pix_customer_fee_bps = 300, pix_store_fee_bps = 200 where id = 1`);
  const changed = place(4);
  check('mudar o percentual do cliente vale só para pedidos NOVOS (3% de 25,00 = 0,75)', Number(orderOf(changed).total) === 25.75 && orderOf(changed).payment_fee_bps === 300 && Number(orderOf(fresh).total) === 25.63, orderOf(changed));
  const changedPay = begin(changed);
  check('...e a comissão passa a somar os dois percentuais (3% + 2% = 5% = 125)', changedPay.commission_bps === 500 && changedPay.commission_cents === 125 && changedPay.customer_fee_cents === 75, changedPay);
  q(`update payment_fee_settings set pix_customer_fee_bps = 0, pix_store_fee_bps = 0 where id = 1`);
  const zero = place(5);
  check('com os dois percentuais em zero não há taxa nem comissão: total 25,00', Number(orderOf(zero).total) === 25 && Number(orderOf(zero).payment_fee) === 0, orderOf(zero));
  const zeroPay = begin(zero);
  check('...e a cobrança sai sem comissão (a divisão fixa nunca é de R$ 0,00)', zeroPay.amount_cents === 2500 && zeroPay.commission_cents === 0 && zeroPay.customer_fee_cents === 0, zeroPay);
  let rejected = false;
  try {
    q(`update payment_fee_settings set pix_customer_fee_bps = 1001 where id = 1`);
  } catch {
    rejected = true;
  }
  check('o banco recusa percentual do Pix acima de 10%', rejected);
  check('rodar de novo não faz nada', /Banco já está atualizado/.test(migrate()));
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('2. Instalação nova: o pagamento online nasce desligado e só liga com operadora + conta aprovada');
const owner = new Client(undefined, '198.51.100.14');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
await sim.reset();
const anon = new Client();
const staff = new Client(undefined, '198.51.100.15');
{
  const settings = (await owner.get('/api/admin/settings')).data;
  check('a tela de Configurações continua só com os meios de sempre (o online é gerenciado em Pagamentos)', settings.payments.length === 3 && !settings.payments.some((p) => p.code === 'pix_online'), settings.payments);
  const overview = (await owner.get('/api/admin/payments')).data;
  check('a página Pagamentos mostra o Pix online DESLIGADO, sem operadora de conta aprovada e sem cobranças', overview.method?.enabled === false && overview.merchant === null && overview.payments.length === 0 && overview.summary.paid === 0, overview);
  check('o site (público) não oferece o pagamento online', !(await anon.get('/api/site')).data.payments.some((p) => p.code === 'pix_online'));
}
const await_site_codes = (await anon.get('/api/site')).data.payments.map((p) => p.code);
check('Pix com chave, dinheiro e cartão na entrega continuam no site', ['pix', 'cash', 'card'].every((c) => await_site_codes.includes(c)), await_site_codes);

const mkCat = async (name) => (await owner.post('/api/admin/categories', { name })).data.category;
const cat = await mkCat('Bebidas Pix');
const mk = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, ...extra })).data.product;
const p25 = await mk('Cerveja Artesanal', 25, { stock: 200 });
const p1010 = await mk('Água Gourmet', 10.1, { stock: 200 });
const p1765 = await mk('Drink da Casa', 17.65, { stock: 200 });
const stockOf = (id) => Number(psql(`select stock from products where id = ${lit(id)}`));
const SKIP = stockOf(p25.id);
check('produtos de teste criados', SKIP === 200, SKIP);

// Operadora configurada (o simulador) mas SEM conta aprovada: não dá para ligar.
{
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('sem conta aprovada, ligar o Pix online é recusado (409, payments_not_ready)', on.status === 409 && on.data.code === 'payments_not_ready' && /conta aprovada/.test(on.data.error), on.data);
  const refused = await new Client(undefined, '203.0.113.9').post('/api/orders', { customer_name: 'Teste', customer_phone: '34970000001', delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: p25.id, quantity: 1 }] });
  check('o pedido com pagamento online é recusado enquanto está desligado (400)', refused.status === 400 && /forma de pagamento disponível/.test(refused.data.error), refused.data);
  check('...sem criar pedido nem mexer no estoque', stockOf(p25.id) === 200 && Number(psql('select count(*) from orders')) === 0);
}

// Administrador comum (não owner)
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente@copocheio.local', 'senha-forte-456');
{
  const r = await staff.patch('/api/admin/payments/pix_online', { enabled: true });
  check('administrador comum não liga o pagamento online (403)', r.status === 403, r.data);
  check('o owner não pode pôr "chave PIX" no pagamento online (400)', (await owner.patch('/api/admin/payments/pix_online', { details: 'chave@x.com' })).status === 400);
}

// Conta (subconta) aprovada: vem de fora (cadastro + aprovação da operadora); aqui o teste a cria direto no banco.
psql(`insert into merchant_accounts (provider, kind, status, provider_account_id, proposal_id, authorized_at) values ('simulador', 'pj', 'approved', 'sim-sub-123', 'sim-prop-1', now())`);
{
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('com operadora e conta aprovada, o owner liga o Pix online', on.status === 200 && on.data.payment.enabled === true, on.data);
  const site = (await anon.get('/api/site')).data.payments;
  check('...e o site passa a oferecer', site.some((p) => p.code === 'pix_online'));
  const log = (await owner.get('/api/admin/audit?entity=payment&limit=10')).data.entries.map((e) => e.summary).join(' | ');
  check('a mudança fica no histórico de atividades', /Pix online/.test(log) && /ativa/.test(log), log);
  const health = (await owner.get('/api/admin/health')).data;
  check('o estado do sistema mostra operadora e conta (sem valores)', health.payments?.provider === 'simulador' && health.payments?.merchant === 'approved' && health.payments?.ready === true, health.payments);
}

// ------------------------------------------------------------------------------------------------
let ip = 30;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const nextPhone = () => `3497${String(2000000 + ++phone).slice(-7)}`;
async function placeOrder(items, extra = {}, method = 'pix_online') {
  const c = buyer();
  const r = await c.post('/api/orders', { customer_name: 'Cliente Pix', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: method, items, ...extra });
  if (r.status !== 201) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  return { c, token: r.data.token, order: r.data.order, number: r.data.order.order_number };
}
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const orderId = (n) => orderRow(n).id;
const payRow = (n, attempt) => JSON.parse(psql(`select row_to_json(p) from payments p join orders o on o.id = p.order_id where o.order_number = ${n} ${attempt ? `and p.attempt = ${attempt}` : ''} order by p.created_at desc limit 1`));
const payCount = (n) => Number(psql(`select count(*) from payments p join orders o on o.id = p.order_id where o.order_number = ${n}`));
const history = (n) => psql(`select coalesce(string_agg(coalesce(h.from_status, '-') || '>' || h.to_status || '@' || coalesce(h.changed_by_name, '?'), ' | ' order by h.created_at, h.id), '') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${n}`);
const events = (key) => Number(psql(`select count(*) from payment_events where dedupe_key = ${lit(key)}`));
const eventsTotal = () => Number(psql('select count(*) from payment_events'));
const pay = (c, token) => c.post(`/api/tracking/${token}/payment`, { method: 'pix' });
const view = (c, token) => c.get(`/api/tracking/${token}/payment`);
const refresh = (id) => owner.post(`/api/admin/payments/${id}/refresh`);
const sweepNow = async () => (await owner.post('/api/admin/payments/sweep')).data;
const chargeId = (n) => payRow(n).provider_charge_id;
const paidHook = (id, charge, extra = {}) => sim.hook({ id, type: 'charge.paid', chargeId: charge, ...extra });

// ------------------------------------------------------------------------------------------------
section('3. Pedido com Pix online: nasce aguardando pagamento, com o total do banco');
const live0 = (await owner.get('/api/admin/live')).data;
const dash0 = (await owner.get('/api/admin/dashboard')).data;
const A = await placeOrder([{ product_id: p25.id, quantity: 2 }], { total: '1.00', commission_cents: 1, amount_cents: 100, subtotal: '1.00' });
{
  check('o pedido nasce "aguardando pagamento", pagamento pendente, meio Pix online', A.order.order_status === 'awaiting_payment' && A.order.payment_status === 'pending' && A.order.payment_method === 'pix_online', A.order);
  check('o total é o do banco (2 × R$ 25,00 + taxa de serviço do Pix de R$ 1,25), não o que o navegador mandou', A.order.total === 51.25 && A.order.subtotal === 50 && A.order.payment_fee === 1.25, A.order);
  check('o estoque já ficou reservado', stockOf(p25.id) === 198);
  check('o histórico começa em "aguardando pagamento"', history(A.number) === '->awaiting_payment@Cliente (site)');
  const list = (await owner.get('/api/admin/orders?status=new')).data;
  check('NÃO aparece em "Novos" do painel', !list.orders.some((o) => o.order_number === A.number));
  const awaiting = (await owner.get('/api/admin/orders?status=awaiting_payment')).data;
  check('aparece no filtro "Aguardando pagamento"', awaiting.orders.some((o) => o.order_number === A.number) && awaiting.counts.awaiting_payment >= 1, awaiting.counts);
  const dash = (await owner.get('/api/admin/dashboard')).data;
  check('não conta como venda nem como "novo" no painel', dash.cards.revenue_today === dash0.cards.revenue_today && dash.cards.pending === dash0.cards.pending && dash.cards.today_orders === dash0.cards.today_orders && dash.cards.awaiting_payment === 1, dash.cards);
  check('...e não entra nos pedidos recentes', !dash.recent.some((o) => o.order_number === A.number));
  const live = (await owner.get(`/api/admin/live?after=${live0.latest}&paid_after=${live0.paid_cursor}`)).data;
  check('o aviso de "pedido novo" do painel NÃO dispara para pedido não pago', !live.new_orders.some((o) => o.order_number === A.number) && live.pending === live0.pending && live.paid_orders.length === 0, live);
  const track = (await A.c.get(`/api/tracking/${A.token}`)).data.order;
  check('o cliente acompanha o pedido como "aguardando pagamento"', track.order_status === 'awaiting_payment' && !('payment' in track), track.order_status);
  check('o pedido não vira "confirmado" por clique no painel (400)', (await owner.patch(`/api/admin/orders/${orderId(A.number)}`, { status: 'confirmed' })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('4. Criar o Pix: uma só cobrança, valor e comissão do banco');
let chargeA;
{
  const r = await pay(A.c, A.token);
  check('gera o Pix (201): aguardando, com "copia e cola"', r.status === 201 && r.data.payment.status === 'pending' && /^SIMULADO-NAO-PAGAVEL/.test(r.data.payment.pix?.payload ?? ''), r.data);
  const row = payRow(A.number);
  chargeA = row.provider_charge_id;
  check('valor da cobrança = total do pedido em centavos (R$ 50,00 + R$ 1,25 de taxa = 5125)', row.amount_cents === 5125 && r.data.payment.amount === 51.25, row);
  check('comissão calculada no banco: 5% de R$ 50,00 = 250 centavos (R$ 2,50), snapshot de 500 pontos-base; o cliente paga 125 e o estabelecimento 125', row.commission_cents === 250 && row.commission_bps === 500 && row.customer_fee_cents === 125 && row.commission_state === 'calculated' && row.commission_confirmed_cents === null, row);
  check('a subconta do estabelecimento é a vinculada à cobrança', psql(`select a.provider_account_id from merchant_accounts a join payments p on p.merchant_account_id = a.id where p.id = ${lit(row.id)}`) === 'sim-sub-123');
  const st = await sim.state();
  const charge = st.charges.find((c) => c.id === chargeA);
  check('a operadora recebeu a cobrança com o valor, a comissão e a subconta certos', charge && charge.amountCents === 5125 && charge.commissionCents === 250 && charge.merchant === 'sim-sub-123' && st.calls.create === 1, charge);
  check('a referência enviada à operadora é o id da tentativa (chave de idempotência)', charge.reference === row.id);

  const second = await pay(A.c, A.token);
  check('clicar de novo devolve a MESMA cobrança (200, sem criar outra)', second.status === 200 && second.data.payment.id === r.data.payment.id && (await sim.state()).calls.create === 1 && payCount(A.number) === 1, second.data);
  const keys = Object.keys(r.data.payment).sort().join(',');
  check('o que o cliente recebe não traz comissão, tarifas, subconta nem código da operadora', keys === 'amount,attempt,can_retry,expires_at,id,message,method,pix,retry_until,status' && !/commission|fee|merchant|provider|sim_ch/i.test(JSON.stringify({ ...r.data.payment, pix: null })), keys);
  const v = await view(A.c, A.token);
  check('consultar o pagamento não confirma nada: continua aguardando, pedido aguardando', v.data.payment.status === 'pending' && v.data.order_status === 'awaiting_payment' && orderRow(A.number).order_status === 'awaiting_payment', v.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Quem pode ver e criar o pagamento de um pedido');
{
  const other = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  const x = await pay(other.c, other.token);
  check('o código de outro pedido mostra só o pagamento DELE', x.status === 201 && x.data.payment.id !== (await view(A.c, A.token)).data.payment.id);
  const intruder = new Client(undefined, '203.0.113.200');
  const notFound = async (path, method = 'GET') => (method === 'GET' ? await intruder.get(path) : await intruder.post(path, { method: 'pix' }));
  for (const bad of ['7K3M9-QX2VB-4HRD6-WTP8N', 'codigo-invalido', '12345', 'a'.repeat(80)]) {
    const g = await notFound(`/api/tracking/${bad}/payment`);
    const p = await notFound(`/api/tracking/${bad}/payment`, 'POST');
    check(`código inexistente/inválido (${bad.slice(0, 12)}…): 404 igual para ver e para criar`, g.status === 404 && p.status === 404 && g.data.error === p.data.error, [g.status, p.status]);
  }
  const rep = await owner.post(`/api/admin/orders/${orderId(other.number)}/tracking-link`, { replace: true });
  check('link trocado pelo painel: o código antigo deixa de dar acesso ao pagamento (404)', rep.status === 201 && (await view(other.c, other.token)).status === 404 && (await pay(other.c, other.token)).status === 404);
  check('...e o código novo dá acesso', (await view(other.c, rep.data.token)).status === 200);
  check('pagamento de pedido que não é online: recusado (400)', await (async () => {
    const cash = await placeOrder([{ product_id: p25.id, quantity: 1 }], {}, 'cash');
    const r = await pay(cash.c, cash.token);
    return r.status === 400 && /não é de pagamento online/.test(r.data.error);
  })());
  const m = await buyer().post(`/api/tracking/${A.token}/payment`, { method: 'cartao' });
  check('forma de pagamento que não existe: 400', m.status === 400);
  const hammer = new Client(undefined, '203.0.113.201');
  let limited = 0;
  for (let i = 0; i < 40; i++) if ((await hammer.post(`/api/tracking/${A.token}/payment`, { method: 'pix' })).status === 429) limited++;
  check('tentativas demais de gerar Pix na mesma rede: 429', limited > 0, limited);
}

// ------------------------------------------------------------------------------------------------
section('6. Confirmação só por canal confiável (aviso verificado + consulta à operadora)');
{
  const base = eventsTotal();
  const noSign = await sim.hook({ id: 'evt-A0', type: 'charge.paid', chargeId: chargeA, sign: false });
  const wrong = await sim.hook({ id: 'evt-A0', type: 'charge.paid', chargeId: chargeA, sign: 'wrong' });
  check('aviso SEM assinatura é recusado (401) e nada é gravado', noSign.status === 401 && eventsTotal() === base);
  check('aviso com assinatura ERRADA é recusado (401) e nada é gravado', wrong.status === 401 && eventsTotal() === base);
  const junk = await sim.hook({ raw: 'isto não é json' });
  check('aviso assinado mas sem sentido: 400, nada gravado', junk.status === 400 && eventsTotal() === base, junk);
  check('o pedido continua aguardando depois dessas tentativas', orderRow(A.number).order_status === 'awaiting_payment' && payRow(A.number).status === 'pending');

  // O aviso diz "pago", mas a operadora (consulta) diz que a cobrança ainda está aguardando: não confirma.
  const claim = await sim.hook({ id: 'evt-A1', type: 'charge.paid', chargeId: chargeA, snapshot: { providerChargeId: chargeA, status: 'paid', amountCents: 5125 } });
  check('aviso assinado dizendo "pago" mas a consulta à operadora diz "aguardando": NÃO confirma', claim.status === 200 && payRow(A.number).status === 'pending' && orderRow(A.number).order_status === 'awaiting_payment', [claim, payRow(A.number).status]);
  check('o aviso fica registrado como já tratado (sem efeito)', psql(`select outcome from payment_events where dedupe_key = 'evt-A1'`) === 'stale');

  // O cliente paga de verdade (no simulador) e o aviso chega.
  await sim.charge(chargeA, { status: 'paid' });
  const live1 = (await owner.get(`/api/admin/live?after=${live0.latest}&paid_after=${live0.paid_cursor}`)).data;
  check('antes do aviso, o painel ainda não sabe (nada de pedido novo)', live1.paid_orders.length === 0);
  const dashBeforePay = (await owner.get('/api/admin/dashboard')).data.cards;
  const ok = await paidHook('evt-A2', chargeA);
  check('aviso verificado + consulta confirma: 200', ok.status === 200 && ok.body.received === 1, ok);
  const o = orderRow(A.number);
  const p = payRow(A.number);
  check('o pedido é liberado para a loja: "novo" e pagamento "pago"', o.order_status === 'new' && o.payment_status === 'paid', o);
  check('o histórico registra: aguardando → novo, por "Pagamento online"', history(A.number) === '->awaiting_payment@Cliente (site) | awaiting_payment>new@Pagamento online', history(A.number));
  check('cobrança paga, com tarifa e líquido informados pela operadora', p.status === 'paid' && p.fee_cents === 99 && p.net_cents === 5026 && p.paid_at && p.paid_seq > 0, p);
  check('comissão EFETIVADA só agora, com o valor confirmado pela operadora (250)', p.commission_state === 'confirmed' && p.commission_confirmed_cents === 250 && p.commission_cents === 250, p);
  check('nada precisa de conferência', p.needs_attention === false);
  const live2 = (await owner.get(`/api/admin/live?after=${live0.latest}&paid_after=${live0.paid_cursor}`)).data;
  check('o painel avisa do pedido pago (paid_orders) com o novo ponto de partida', live2.paid_orders.length === 1 && live2.paid_orders[0].order_number === A.number && live2.paid_cursor > live0.paid_cursor, live2);
  const dash = (await owner.get('/api/admin/dashboard')).data;
  check('agora conta como "novo" e como venda no painel', dash.cards.pending === dashBeforePay.pending + 1 && Math.abs(dash.cards.revenue_today - (dashBeforePay.revenue_today + 51.25)) < 0.005 && dash.cards.awaiting_payment === dashBeforePay.awaiting_payment - 1, [dashBeforePay, dash.cards]);
  const v = await view(A.c, A.token);
  check('o cliente vê pago, sem Pix, pedido "novo"', v.data.payment.status === 'paid' && v.data.payment.pix === null && v.data.order_status === 'new', v.data);
  check('o pedido que o cliente acompanha traz o resumo do pagamento', (await A.c.get(`/api/tracking/${A.token}`)).data.order.payment?.status === 'paid');
  const audit = (await owner.get('/api/admin/audit?entity=payment&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('o histórico de atividades registra a confirmação feita pelo sistema', new RegExp(`Pix do pedido #${A.number} confirmado`).test(audit), audit);

  // Repetições
  const dup = await paidHook('evt-A2', chargeA);
  check('MESMO aviso de novo: 200, sem efeito algum', dup.status === 200 && history(A.number).split(' | ').length === 2 && events('evt-A2') === 1 && payRow(A.number).paid_seq === p.paid_seq);
  const twin = await paidHook('evt-A2-master', chargeA);
  check('aviso da conta master para a MESMA cobrança (outro id): nenhum efeito repetido', twin.status === 200 && history(A.number).split(' | ').length === 2 && payRow(A.number).commission_confirmed_cents === 250 && payRow(A.number).paid_seq === p.paid_seq);
  await sim.mode({ split: 'failed' });
  await refresh(p.id);
  await sim.mode({ split: 'applied' });
  check('consulta posterior dizendo "repasse falhou" NÃO desfaz a evidência já confirmada da comissão', payRow(A.number).commission_state === 'confirmed' && payRow(A.number).commission_confirmed_cents === 250 && payRow(A.number).needs_attention === false, payRow(A.number));
  const late = await sim.hook({ id: 'evt-A3', type: 'charge.created', chargeId: chargeA, snapshot: { providerChargeId: chargeA, status: 'pending', amountCents: 5125 } });
  check('aviso ATRASADO ("criada/aguardando") depois do pago: não regride', late.status === 200 && payRow(A.number).status === 'paid' && orderRow(A.number).order_status === 'new');
  const unknown = await sim.hook({ id: 'evt-X1', type: 'charge.paid', chargeId: 'sim_ch_999999' });
  check('aviso de cobrança que não é nossa: 200 (a operadora não reenvia) e registrado como desconhecido', unknown.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'evt-X1'`) === 'unknown_charge');
  const byRef = await sim.hook({ id: 'evt-A4', type: 'charge.updated', reference: p.id });
  check('aviso que traz só a nossa referência também acha a cobrança', byRef.status === 200 && psql(`select payment_id from payment_events where dedupe_key = 'evt-A4'`) === p.id);
  const manual = await owner.patch(`/api/admin/orders/${orderId(A.number)}`, { payment_status: 'refunded' });
  check('pagamento online não se altera à mão pelo painel (400)', manual.status === 400 && /online/.test(manual.data.error), manual.data);
}

// ------------------------------------------------------------------------------------------------
section('7. Valor pago diferente do da cobrança: não libera o pedido');
{
  const B = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(B.c, B.token);
  const id = chargeId(B.number);
  await sim.charge(id, { status: 'paid', paidAmountCents: 2400 });
  const r = await paidHook('evt-B1', id);
  const p = payRow(B.number);
  check('valor pago (R$ 24,00) ≠ cobrança (R$ 25,00): pedido NÃO é liberado', r.status === 200 && orderRow(B.number).order_status === 'awaiting_payment' && p.status === 'pending', [orderRow(B.number).order_status, p.status]);
  check('...a cobrança fica sinalizada para conferência, com o motivo', p.needs_attention === true && /diferente/.test(p.attention_reason), p.attention_reason);
  await sim.charge(id, { status: 'paid', paidAmountCents: null });
  const ok = await refresh(p.id);
  check('conferida depois com o valor certo (consulta do dono), confirma', ok.status === 200 && payRow(B.number).status === 'paid' && orderRow(B.number).order_status === 'new', ok.data);
}

// ------------------------------------------------------------------------------------------------
section('8. Falha no repasse da comissão, saldo insuficiente e conciliação');
{
  await sim.mode({ split: 'failed' });
  const C = await placeOrder([{ product_id: p1010.id, quantity: 1 }]);
  await pay(C.c, C.token);
  const id = chargeId(C.number);
  await sim.charge(id, { status: 'paid' });
  await paidHook('evt-C1', id);
  const p = payRow(C.number);
  check('o pagamento é confirmado e o pedido liberado, mesmo com o repasse falhando', p.status === 'paid' && orderRow(C.number).order_status === 'new');
  check('R$ 10,10: cliente paga R$ 10,35 e a comissão de 5% calculada = 51 centavos (0,505 arredonda para cima)', p.amount_cents === 1035 && p.commission_cents === 51 && p.customer_fee_cents === 25, p);
  check('a comissão NÃO fica como efetivada: estado "failed", sem valor confirmado, sinalizada', p.commission_state === 'failed' && p.commission_confirmed_cents === null && p.needs_attention && /saldo líquido insuficiente/.test(p.attention_reason), p);
  const list = (await owner.get('/api/admin/payments?attention=1')).data;
  check('o owner vê a pendência na lista (e o resumo separa comissão calculada, confirmada e com falha)', list.payments.some((x) => x.id === p.id) && list.summary.commission_failed_cents >= 51 && list.summary.attention >= 1, list.summary);
  // Operadora conciliou depois
  await sim.mode({ split: 'applied' });
  await refresh(p.id);
  const after = payRow(C.number);
  check('conciliação posterior: a comissão passa a efetivada, com o valor confirmado (51)', after.commission_state === 'confirmed' && after.commission_confirmed_cents === 51, after);
  const ack = await owner.post(`/api/admin/payments/${p.id}/ack`);
  check('o owner marca como conferido (a pendência sai da lista, o motivo continua guardado)', ack.status === 200 && payRow(C.number).needs_attention === false && /saldo/.test(payRow(C.number).attention_reason) && !(await owner.get('/api/admin/payments?attention=1')).data.payments.some((x) => x.id === p.id));
  check('...e conferir de novo o que já está conferido: 404', (await owner.post(`/api/admin/payments/${p.id}/ack`)).status === 404);

  await sim.mode({ split: 'pending' });
  const D = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(D.c, D.token);
  await sim.charge(chargeId(D.number), { status: 'paid' });
  await paidHook('evt-D1', chargeId(D.number));
  const d = payRow(D.number);
  check('repasse ainda pendente na operadora: pago, mas a comissão segue só "calculada" (nunca presumida)', d.status === 'paid' && d.commission_state === 'calculated' && d.commission_confirmed_cents === null && d.needs_attention === false, d);
  await sim.mode({ split: 'none' });
  await refresh(d.id);
  check('operadora sem informação de divisão: continua só "calculada"', payRow(D.number).commission_state === 'calculated');
  await sim.mode({ split: 'applied' });
  const sum = (await owner.get('/api/admin/payments')).data.summary;
  check('o resumo soma: comissão calculada ≥ confirmada, e a "à espera" não é contada como recebida', sum.commission_calculated_cents >= sum.commission_confirmed_cents && sum.commission_waiting_cents >= 50, sum);
  // Estado da comissão não pode ser "efetivada" sem evidência: restrição do banco.
  let rejected = false;
  try {
    psql(`update payments set commission_state = 'confirmed', commission_confirmed_cents = null where id = ${lit(d.id)}`);
  } catch {
    rejected = true;
  }
  check('o banco recusa "comissão efetivada" sem o valor confirmado', rejected);
  rejected = false;
  try {
    psql(`update payments set commission_state = 'confirmed', commission_confirmed_cents = 100 where id = (select id from payments where status = 'pending' limit 1)`);
  } catch {
    rejected = true;
  }
  check('...nem em cobrança que ainda não foi paga', rejected);
}

// ------------------------------------------------------------------------------------------------
section('9. Operadora fora do ar na hora do aviso: nada se perde, nada se repete');
{
  const E = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(E.c, E.token);
  const id = chargeId(E.number);
  await sim.charge(id, { status: 'paid' });
  await sim.mode({ lookupFail: 'unavailable' });
  const down = await paidHook('evt-E1', id);
  check('sem conseguir consultar a operadora: responde 503 (ela reenvia) e NÃO confirma', down.status === 503 && orderRow(E.number).order_status === 'awaiting_payment' && payRow(E.number).status === 'pending', down);
  check('o aviso fica registrado como NÃO processado (erro), para a próxima entrega', psql(`select outcome || '/' || coalesce(processed_at::text, 'aberto') from payment_events where dedupe_key = 'evt-E1'`) === 'error/aberto');
  const v = await view(E.c, E.token);
  check('a tela do cliente continua funcionando (200, aguardando) mesmo com a consulta falhando', v.status === 200 && v.data.payment.status === 'pending');
  const adminRefresh = await refresh(payRow(E.number).id);
  check('"Atualizar pagamento" do owner com a operadora fora do ar: 503 claro', adminRefresh.status === 503 && adminRefresh.data.code === 'provider_unavailable', adminRefresh.data);
  await sim.mode({ lookupFail: null });
  const again = await paidHook('evt-E1', id);
  check('a operadora reenvia o MESMO aviso e ele é processado: pedido liberado', again.status === 200 && orderRow(E.number).order_status === 'new' && payRow(E.number).status === 'paid');
  check('...e o aviso passa a constar como processado, com mais de uma tentativa', Number(psql(`select attempts from payment_events where dedupe_key = 'evt-E1'`)) >= 2 && psql(`select (processed_at is not null)::text from payment_events where dedupe_key = 'evt-E1'`) === 'true');
  check('...uma só vez no histórico do pedido', history(E.number).split(' | ').length === 2);

  // Operadora que não permite consulta: só vale o aviso verificado.
  await sim.mode({ canLookup: false });
  const F = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(F.c, F.token);
  const fid = chargeId(F.number);
  const noSnap = await sim.hook({ id: 'evt-F0', type: 'charge.updated', chargeId: fid });
  check('sem consulta e aviso sem dados da cobrança: ignorado, nada muda', noSnap.status === 200 && orderRow(F.number).order_status === 'awaiting_payment' && psql(`select outcome from payment_events where dedupe_key = 'evt-F0'`) === 'ignored');
  const wrongAmount = await sim.hook({ id: 'evt-F1', type: 'charge.paid', chargeId: fid, snapshot: { providerChargeId: fid, status: 'paid', amountCents: 1 } });
  check('sem consulta, aviso verificado com valor errado: não libera, sinaliza', wrongAmount.status === 200 && orderRow(F.number).order_status === 'awaiting_payment' && payRow(F.number).needs_attention === true);
  const fine = await sim.hook({ id: 'evt-F2', type: 'charge.paid', chargeId: fid, snapshot: { providerChargeId: fid, status: 'paid', amountCents: 2563, feeCents: 50, netCents: 2513, split: { state: 'applied', commissionCents: 125 } } });
  check('sem consulta, aviso verificado com os dados certos: confirma e registra o repasse', fine.status === 200 && orderRow(F.number).order_status === 'new' && payRow(F.number).commission_state === 'confirmed' && payRow(F.number).commission_confirmed_cents === 125 && payRow(F.number).fee_cents === 50);
  const nope = await refresh(payRow(F.number).id);
  check('"Atualizar pagamento" sem consulta disponível: 409 claro', nope.status === 409 && nope.data.code === 'lookup_unavailable', nope.data);
  await sim.mode({ canLookup: true });
}

// ------------------------------------------------------------------------------------------------
section('10. Falhas ao criar o Pix: recusa, operadora fora do ar, demora, tentativas');
{
  const G = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await sim.mode({ createFail: 'rejected' });
  const rej = await pay(G.c, G.token);
  const g1 = payRow(G.number, 1);
  check('operadora recusa: 502 claro, tentativa "failed", sem alerta (recusa é definitiva)', rej.status === 502 && rej.data.code === 'provider_rejected' && g1.status === 'failed' && g1.needs_attention === false, [rej.status, rej.data, g1.status]);
  check('...o cliente pode tentar de novo (tentativa 2) e o pedido continua aguardando', (await view(G.c, G.token)).data.payment.can_retry === true && orderRow(G.number).order_status === 'awaiting_payment');
  await sim.mode({ createFail: 'unavailable' });
  const down = await pay(G.c, G.token);
  const g2 = payRow(G.number, 2);
  check('operadora fora do ar: 503 claro; a tentativa é encerrada e SINALIZADA (pode ter sido criada lá)', down.status === 503 && down.data.code === 'provider_unavailable' && g2.status === 'failed' && g2.needs_attention === true, [down.status, g2]);
  await sim.mode({ createFail: null });
  const okay = await pay(G.c, G.token);
  check('voltou: a tentativa 3 gera o Pix', okay.status === 201 && payRow(G.number).attempt === 3 && payRow(G.number).status === 'pending');
  check('as respostas de erro não vazam detalhes da operadora', !/fora do ar|dados recusados|simulador/i.test(JSON.stringify([rej.data, down.data])));

  // Limite de tentativas por pedido
  const H = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await sim.mode({ createFail: 'rejected' });
  const cl = buyer();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await cl.post(`/api/tracking/${H.token}/payment`, { method: 'pix' })).status);
  check('no máximo 5 tentativas por pedido (a sexta é recusada com 400)', codes.slice(0, 5).every((c) => c === 502) && codes[5] === 400 && payCount(H.number) === 5, codes);
  await sim.mode({ createFail: null });

  // Demora: três cliques enquanto a operadora ainda responde — uma só cobrança
  const I = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  const callsBefore = (await sim.state()).calls.create;
  await sim.mode({ createDelayMs: 1500 });
  const rs = await Promise.all([pay(I.c, I.token), pay(I.c, I.token), pay(I.c, I.token)]);
  await sim.mode({ createDelayMs: 0 });
  const created = rs.filter((r) => r.status === 201).length;
  check('3 cliques seguidos com a operadora devagar: 1 cobrança criada, os outros recebem a mesma tentativa', created === 1 && rs.every((r) => [200, 201].includes(r.status)) && new Set(rs.map((r) => r.data.payment.id)).size === 1 && (await sim.state()).calls.create === callsBefore + 1 && payCount(I.number) === 1, rs.map((r) => [r.status, r.data.payment?.status]));
  check('...quem chegou durante a criação vê "criando" e depois "aguardando"', rs.some((r) => r.data.payment.status === 'creating') && (await view(I.c, I.token)).data.payment.status === 'pending');

  // Tempo esgotado (a operadora não responde dentro do limite do servidor)
  const J = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await sim.mode({ createDelayMs: 9500 });
  const t0 = Date.now();
  const slow = await pay(J.c, J.token);
  const took = Date.now() - t0;
  await sim.mode({ createDelayMs: 0 });
  check('sem resposta dentro do limite (8 s): 503, tentativa encerrada e sinalizada', slow.status === 503 && took >= 7500 && took < 9400 && payRow(J.number).status === 'failed' && payRow(J.number).needs_attention === true, [slow.status, took]);
  check('...e uma nova tentativa funciona', (await pay(J.c, J.token)).status === 201);
}

// ------------------------------------------------------------------------------------------------
section('11. Concorrência: cliques, avisos e consultas ao mesmo tempo');
{
  const K = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  const callsBefore = (await sim.state()).calls.create;
  const rs = await Promise.all(Array.from({ length: 10 }, () => pay(K.c, K.token)));
  check('10 cliques simultâneos: exatamente 1 cobrança (1 resposta 201, 9 com a mesma tentativa)', rs.filter((r) => r.status === 201).length === 1 && new Set(rs.map((r) => r.data.payment.id)).size === 1 && payCount(K.number) === 1 && (await sim.state()).calls.create === callsBefore + 1, rs.map((r) => r.status));

  const id = chargeId(K.number);
  await sim.charge(id, { status: 'paid' });
  const hooks = await Promise.all(Array.from({ length: 8 }, () => paidHook('evt-K1', id)));
  check('o MESMO aviso entregue 8 vezes ao mesmo tempo: todos 200 e UM só efeito', hooks.every((h) => h.status === 200) && history(K.number).split(' | ').length === 2 && events('evt-K1') === 1 && payRow(K.number).commission_confirmed_cents === 125, [hooks.map((h) => h.status), history(K.number), events('evt-K1'), payRow(K.number).commission_confirmed_cents]);
  const L = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(L.c, L.token);
  const lid = chargeId(L.number);
  await sim.charge(lid, { status: 'paid' });
  const mixed = await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => paidHook(`evt-L-${i}`, lid)),
    refresh(payRow(L.number).id),
    view(L.c, L.token),
    sweepNow(),
  ]);
  check('6 avisos diferentes + conferência do dono + tela do cliente ao mesmo tempo: um só pagamento, uma só liberação', mixed.slice(0, 6).every((h) => h.status === 200) && history(L.number).split(' | ').length === 2 && Number(psql(`select count(*) from payments p join orders o on o.id = p.order_id where o.order_number = ${L.number} and p.status = 'paid'`)) === 1);
  check('...com a comissão contada uma única vez (a cobrança tem uma linha só)', payRow(L.number).commission_confirmed_cents === 125 && payCount(L.number) === 1);

  // Cancelar o pedido (painel) e gerar o Pix ao mesmo tempo: o estado final precisa ser coerente.
  const M = await placeOrder([{ product_id: p25.id, quantity: 3 }]);
  const stockAfterOrder = stockOf(p25.id);
  const [cancelled, created] = await Promise.all([owner.patch(`/api/admin/orders/${orderId(M.number)}`, { status: 'cancelled' }), pay(M.c, M.token)]);
  check('cancelar e gerar o Pix ao mesmo tempo: pedido cancelado, nenhuma cobrança em aberto', cancelled.status === 200 && orderRow(M.number).order_status === 'cancelled' && Number(psql(`select count(*) from payments p join orders o on o.id = p.order_id where o.order_number = ${M.number} and p.status in ('creating', 'pending')`)) === 0, [cancelled.status, created.status]);
  check('...e o estoque voltou uma só vez (+3)', stockOf(p25.id) === stockAfterOrder + 3);
  if (created.status === 400) check('...(o Pix perdeu a corrida: recusado com aviso claro)', /não está aguardando pagamento/.test(created.data.error), created.data);
  else if (created.status === 409) check('...(o pedido foi cancelado enquanto o Pix era criado: 409 e a cobrança sinalizada para conferência)', created.data.code === 'order_closed' && payRow(M.number).needs_attention === true && payRow(M.number).status === 'failed', [created.data, payRow(M.number)]);
  else check('...(o Pix saiu antes do cancelamento: a cobrança foi encerrada junto com o pedido)', created.status === 201 && payRow(M.number).status === 'cancelled', [created.status, payRow(M.number)]);
}

// ------------------------------------------------------------------------------------------------
section('12. Vencimento, nova tentativa, cancelamento por falta de pagamento e pagamento tardio');
{
  const N = await placeOrder([{ product_id: p25.id, quantity: 2 }]);
  const stockBefore = stockOf(p25.id) + 2;
  await pay(N.c, N.token);
  const id1 = chargeId(N.number);
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(N.number).id)}`);
  await sim.charge(id1, { status: 'expired' });
  const v = await view(N.c, N.token);
  check('a operadora diz que venceu: a tela mostra "venceu", com opção de gerar outro Pix', v.data.payment.status === 'expired' && v.data.payment.can_retry === true && v.data.payment.pix === null && /venceu/.test(v.data.payment.message) && v.data.order_status === 'awaiting_payment', v.data);
  check('...o pedido continua reservando o estoque durante a janela de nova tentativa', orderRow(N.number).order_status === 'awaiting_payment' && stockOf(p25.id) === stockBefore - 2);
  const second = await pay(N.c, N.token);
  check('gerar outro Pix: nova tentativa (2), nova cobrança', second.status === 201 && payRow(N.number).attempt === 2 && chargeId(N.number) !== id1);
  const id2 = chargeId(N.number);
  await sim.charge(id2, { status: 'expired' });
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(N.number).id)}`);
  await refresh(payRow(N.number).id);
  check('segunda cobrança também vence', payRow(N.number).status === 'expired');
  const s0 = await sweepNow();
  check('conferir agora, DENTRO da janela de 10 min: o pedido ainda não é cancelado', s0.cancelled === 0 && orderRow(N.number).order_status === 'awaiting_payment', s0);
  const cancelBefore = (await owner.get('/api/admin/dashboard')).data.cards.cancelled_today;
  psql(`update payments set closed_at = now() - interval '11 minutes' where order_id = ${lit(orderId(N.number))}`);
  const s1 = await sweepNow();
  check('passada a janela: o pedido é cancelado e o estoque VOLTA', s1.cancelled >= 1 && orderRow(N.number).order_status === 'cancelled' && stockOf(p25.id) === stockBefore, [s1, stockOf(p25.id), stockBefore]);
  check('...o histórico diz que foi o sistema, por falta de pagamento', /awaiting_payment>cancelled@Sistema \(pagamento não realizado\)/.test(history(N.number)), history(N.number));
  const s2 = await sweepNow();
  check('conferir de novo: nada acontece (estoque não volta duas vezes)', s2.cancelled === 0 && stockOf(p25.id) === stockBefore);
  check('"cancelados hoje" do painel não conta o cancelamento por falta de pagamento', (await owner.get('/api/admin/dashboard')).data.cards.cancelled_today === cancelBefore);
  const vc = await view(N.c, N.token);
  check('a tela do cliente do pedido cancelado não oferece novo Pix', vc.data.payment.can_retry === false && vc.data.order_status === 'cancelled');
  check('gerar Pix de pedido cancelado: recusado (400)', (await pay(N.c, N.token)).status === 400);

  // Pagamento que chega depois do cancelamento
  await sim.charge(id2, { status: 'paid' });
  const stockNow = stockOf(p25.id);
  const lateHook = await paidHook('evt-N-late', id2);
  const p = payRow(N.number);
  check('pagamento TARDIO (pedido já cancelado): registrado, sinalizado para devolver, pedido NÃO reabre, estoque não mexe', lateHook.status === 200 && p.status === 'paid' && p.needs_attention && /depois que o pedido foi cancelado/.test(p.attention_reason) && orderRow(N.number).order_status === 'cancelled' && stockOf(p25.id) === stockNow, p);
  const lv = await view(N.c, N.token);
  check('...o cliente é avisado de que a loja vai devolver o valor', lv.data.payment.status === 'paid' && /devolver/.test(lv.data.payment.message), lv.data);
  check('...e o dono vê a pendência', (await owner.get('/api/admin/payments?attention=1')).data.payments.some((x) => x.id === p.id));

  // Ninguém gerou o Pix (a pessoa fechou a página)
  const O = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  const stockO = stockOf(p25.id);
  psql(`update orders set created_at = now() - interval '29 minutes' where order_number = ${O.number}`);
  await sweepNow();
  check('pedido sem Pix há 29 min: ainda espera', orderRow(O.number).order_status === 'awaiting_payment');
  psql(`update orders set created_at = now() - interval '31 minutes' where order_number = ${O.number}`);
  await sweepNow();
  check('pedido sem Pix há 31 min: cancelado e estoque devolvido', orderRow(O.number).order_status === 'cancelled' && stockOf(p25.id) === stockO + 1);

  // Operadora fora do ar na hora de conferir um Pix vencido há muito tempo
  const Q = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(Q.c, Q.token);
  psql(`update payments set expires_at = now() - interval '29 minutes' where id = ${lit(payRow(Q.number).id)}`);
  await sim.mode({ lookupFail: 'unavailable' });
  await sweepNow();
  check('vencido há 29 min e sem como consultar a operadora: ainda aguarda (não cancela dinheiro no escuro)', payRow(Q.number).status === 'pending');
  psql(`update payments set expires_at = now() - interval '31 minutes' where id = ${lit(payRow(Q.number).id)}`);
  await sweepNow();
  check('vencido há 31 min e sem como consultar: encerrado SINALIZADO, para o estoque não ficar preso', payRow(Q.number).status === 'expired' && payRow(Q.number).needs_attention === true && /Venceu sem que a operadora/.test(payRow(Q.number).attention_reason), payRow(Q.number));
  await sim.mode({ lookupFail: null });

  // Tentativa "criando" sem resposta há mais de 2 min
  const R = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  psql(`insert into payments (order_id, attempt, provider, method, merchant_account_id, amount_cents, commission_bps, commission_cents, customer_fee_cents, created_at)
        select id, 1, 'simulador', 'pix', (select id from merchant_accounts limit 1), 2563, 500, 125, 63, now() - interval '3 minutes' from orders where order_number = ${R.number}`);
  await sweepNow();
  check('tentativa "criando" sem resposta há 3 min: encerrada e sinalizada', payRow(R.number).status === 'failed' && payRow(R.number).needs_attention === true);
}

// ------------------------------------------------------------------------------------------------
section('13. Estorno');
{
  const S = await placeOrder([{ product_id: p25.id, quantity: 2 }]);
  await pay(S.c, S.token);
  const id = chargeId(S.number);
  await sim.charge(id, { status: 'paid' });
  await paidHook('evt-S1', id);
  const dashPaid = (await owner.get('/api/admin/dashboard')).data.cards.revenue_today;
  await sim.charge(id, { status: 'refunded', refundedCents: 2000 });
  const part = await sim.hook({ id: 'evt-S2', type: 'charge.refunded', chargeId: id });
  const p1 = payRow(S.number);
  check('estorno PARCIAL: a cobrança segue paga, registra o valor devolvido e fica sinalizada (conferir a comissão)', part.status === 200 && p1.status === 'paid' && p1.refunded_cents === 2000 && p1.needs_attention && orderRow(S.number).payment_status === 'paid', p1);
  await sim.charge(id, { status: 'refunded', refundedCents: 5125 });
  await sim.hook({ id: 'evt-S3', type: 'charge.refunded', chargeId: id });
  const p2 = payRow(S.number);
  check('estorno TOTAL: cobrança "refunded" e pedido com pagamento "estornado"', p2.status === 'refunded' && p2.refunded_cents === 5125 && orderRow(S.number).payment_status === 'refunded', [p2.status, orderRow(S.number).payment_status]);
  check('o pedido estornado deixa de contar como venda no painel', Math.abs((await owner.get('/api/admin/dashboard')).data.cards.revenue_today - (dashPaid - 51.25)) < 0.005);
  const back = await sim.hook({ id: 'evt-S4', type: 'charge.paid', chargeId: id });
  check('um "pago" atrasado depois do estorno não desfaz o estorno', back.status === 200 && payRow(S.number).status === 'refunded');
}

// ------------------------------------------------------------------------------------------------
section('14. Painel: quem vê o quê');
{
  const T = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(T.c, T.token);
  const pid = payRow(T.number).id;
  const asOwner = (await owner.get(`/api/admin/orders/${T.number}`)).data;
  const asStaff = (await staff.get(`/api/admin/orders/${T.number}`)).data;
  check('o dono vê a cobrança do pedido com comissão, tarifas e código na operadora', asOwner.payments.length === 1 && asOwner.payments[0].commission_cents === 125 && 'provider_charge_id' in asOwner.payments[0] && 'fee_cents' in asOwner.payments[0], asOwner.payments);
  check('o atendente vê a situação do pagamento, SEM comissão, tarifas nem código da operadora', asStaff.payments.length === 1 && asStaff.payments[0].status === 'pending' && !('commission_cents' in asStaff.payments[0]) && !('fee_cents' in asStaff.payments[0]) && !('provider_charge_id' in asStaff.payments[0]) && !/commission|sim_ch/.test(JSON.stringify(asStaff.payments)), asStaff.payments);
  check('...e o Pix "copia e cola" nunca sai nas telas do painel', !JSON.stringify(asOwner).includes('SIMULADO-NAO-PAGAVEL') && !JSON.stringify((await owner.get('/api/admin/payments')).data).includes('SIMULADO-NAO-PAGAVEL'));
  for (const [name, call] of [
    ['lista', () => staff.get('/api/admin/payments')],
    ['detalhe', () => staff.get(`/api/admin/payments/${pid}`)],
    ['conferir um', () => staff.post(`/api/admin/payments/${pid}/refresh`)],
    ['conferir tudo', () => staff.post('/api/admin/payments/sweep')],
    ['marcar conferido', () => staff.post(`/api/admin/payments/${pid}/ack`)],
  ]) check(`atendente (não owner) não acessa: ${name} → 403`, (await call()).status === 403);
  for (const [name, call] of [
    ['lista', () => anon.get('/api/admin/payments')],
    ['detalhe', () => anon.get(`/api/admin/payments/${pid}`)],
    ['conferir', () => anon.post(`/api/admin/payments/${pid}/refresh`)],
    ['conferir tudo', () => anon.post('/api/admin/payments/sweep')],
  ]) check(`sem login: ${name} → 401`, (await call()).status === 401);
  const detail = (await owner.get(`/api/admin/payments/${pid}`)).data;
  check('o detalhe traz a cobrança e os avisos recebidos', detail.payment.id === pid && Array.isArray(detail.events));
  const list = (await owner.get('/api/admin/payments')).data;
  check('a lista traz a conta (identificadores mascarados), a operadora e o preparo para ligar', list.merchant?.status === 'approved' && /…/.test(list.merchant.provider_account_id) && !list.merchant.provider_account_id.includes('sim-sub-123') && list.provider.name === 'simulador' && list.readiness.ready === true, list.merchant);
  check('cancelar pelo painel um pedido que aguarda o pagamento: encerra a cobrança em aberto e devolve o estoque', await (async () => {
    const before = stockOf(p25.id);
    const r = await owner.patch(`/api/admin/orders/${orderId(T.number)}`, { status: 'cancelled' });
    return r.status === 200 && payRow(T.number).status === 'cancelled' && stockOf(p25.id) === before + 1;
  })());
  check('pedido pago cancelado depois no painel: cobrança sinalizada para devolver o valor', await (async () => {
    const U = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
    await pay(U.c, U.token);
    await sim.charge(chargeId(U.number), { status: 'paid' });
    await paidHook(`evt-U1`, chargeId(U.number));
    await owner.patch(`/api/admin/orders/${orderId(U.number)}`, { status: 'cancelled' });
    return payRow(U.number).needs_attention === true && /Devolva o valor/.test(payRow(U.number).attention_reason);
  })());
}

// ------------------------------------------------------------------------------------------------
section('15. Comissão: a conta certa, sempre em centavos (2% nos pedidos antigos; taxa de serviço de 5% nos novos)');
{
  const table = [
    [10000, 200], [1010, 20], [1, 0], [9, 0], [24, 0], [25, 1], [49, 1], [50, 1], [74, 1], [75, 2], [4999, 100], [5050, 101], [2500, 50], [1765, 35], [8825, 177], [123456, 2469], [2147483647, 42949673],
  ];
  const got = psql(`select string_agg(a || ':' || payment_commission_cents(a, payment_commission_bps()), ',' order by a) from unnest(array[${table.map((t) => t[0]).join(',')}]) a`);
  const want = [...table].sort((x, y) => x[0] - y[0]).map(([a, c]) => `${a}:${c}`).join(',');
  check('valores conhecidos (R$ 100,00 → R$ 2,00; R$ 0,25 → R$ 0,01 e R$ 88,25 → R$ 1,77, metade para cima; ...)', got === want, { got, want });
  const random = Array.from({ length: 400 }, () => 1 + Math.floor(Math.random() * 5_000_000));
  const sqlOut = psql(`select string_agg(a || ':' || payment_commission_cents(a, 200), ',' order by a) from unnest(array[${random.join(',')}]) a`).split(',');
  const bad = sqlOut.filter((entry) => {
    const [a, c] = entry.split(':').map(Number);
    return BigInt(c) !== (BigInt(a) * 200n + 5000n) / 10000n || c > a;
  });
  check('400 valores aleatórios batem com a conta de referência (arredonda a metade para cima) e nunca passam do valor', bad.length === 0, bad.slice(0, 3));
  check('a taxa é 2% (200 pontos-base) e vem do banco', psql('select payment_commission_bps()') === '200');
  // Taxa de serviço do Pix (0020): service_fee_cents(base, bps) = floor((base × bps + 5000) ÷ 10000), a mesma conta de serviceFeeCents() do site.
  const svcTable = [[0, 250, 0], [1, 250, 0], [10000, 250, 250], [10000, 500, 500], [2500, 250, 63], [2500, 500, 125], [1010, 250, 25], [1010, 500, 51], [1765, 250, 44], [1765, 500, 88], [6510, 250, 163], [6510, 500, 326], [10000, 0, 0]];
  const svcGot = psql(`select string_agg(a || ':' || b || ':' || service_fee_cents(a, b), ',' order by ord) from unnest(array[${svcTable.map((t) => t[0]).join(',')}], array[${svcTable.map((t) => t[1]).join(',')}]) with ordinality as t(a, b, ord)`);
  check('taxa de serviço do Pix: valores conhecidos (R$ 100 → 2,50 e 5,00; R$ 25 → 0,63 e 1,25; R$ 10,10 → 0,25 e 0,51; R$ 17,65 → 0,44 e 0,88; R$ 65,10 → 1,63 e 3,26)', svcGot === svcTable.map(([a, b, c]) => `${a}:${b}:${c}`).join(','), svcGot);
  const svcBad = [];
  for (const bps of [1, 250, 300, 500, 1000]) {
    const sample = Array.from({ length: 300 }, () => Math.floor(Math.random() * 5_000_000));
    for (const entry of psql(`select string_agg(a || ':' || service_fee_cents(a, ${bps}), ',') from unnest(array[${sample.join(',')}]) a`).split(',')) {
      const [a, c] = entry.split(':').map(Number);
      if (BigInt(c) !== (BigInt(a) * BigInt(bps) + 5000n) / 10000n) svcBad.push([a, bps, c]);
    }
  }
  check('1.500 valores aleatórios (5 percentuais): service_fee_cents bate com a conta de referência em inteiros (metade para cima)', svcBad.length === 0, svcBad.slice(0, 3));
  const V = await placeOrder([{ product_id: p1010.id, quantity: 1 }]);
  await pay(V.c, V.token);
  check('pedido de R$ 10,10: cobrança de 1035 centavos (taxa do cliente 25) e comissão 51 (5% de 1010 = 50,5 arredonda para cima)', payRow(V.number).amount_cents === 1035 && payRow(V.number).customer_fee_cents === 25 && payRow(V.number).commission_cents === 51);
  const W = await placeOrder([{ product_id: p1765.id, quantity: 1 }]);
  await pay(W.c, W.token);
  check('pedido de R$ 17,65: cobrança de 1809 centavos (taxa do cliente 44) e comissão 88 (88,25 arredonda para baixo)', payRow(W.number).amount_cents === 1809 && payRow(W.number).customer_fee_cents === 44 && payRow(W.number).commission_cents === 88);
  const X = await placeOrder([{ product_id: p25.id, quantity: 2 }, { product_id: p1010.id, quantity: 1 }], { delivery_type: 'delivery', address: 'Rua A', address_number: '10', neighborhood: 'Centro' });
  await pay(X.c, X.token);
  check('com taxa de entrega (R$ 5,00): a base é itens + entrega, R$ 65,10 → cliente paga R$ 66,73 (taxa 163) e a comissão é 326', X.order.total === 66.73 && payRow(X.number).amount_cents === 6673 && payRow(X.number).customer_fee_cents === 163 && payRow(X.number).commission_cents === 326, payRow(X.number));
  check('total errado vindo do navegador (expected_total) continua barrando o pedido (409)', (await buyer().post('/api/orders', { customer_name: 'X Y', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix_online', expected_total: '1.00', items: [{ product_id: p25.id, quantity: 1 }] })).status === 409);
  const cents = Number(psql(`select count(*) from payments p join orders o on o.id = p.order_id
                              where p.commission_cents > p.amount_cents
                                 or p.amount_cents <> round(o.total * 100)
                                 or p.commission_bps <> 500
                                 or p.customer_fee_cents <> round(o.payment_fee * 100)
                                 or p.commission_cents <> service_fee_cents(p.amount_cents - p.customer_fee_cents, 500)`));
  check('em TODAS as cobranças criadas: valor = total do pedido, taxa do cliente = a do pedido e comissão = 5% da base (500 pontos-base)', cents === 0, cents);
}

// ------------------------------------------------------------------------------------------------
section('16. Pedido repetido, outros meios e o que ficou de fora');
{
  const body = { customer_name: 'Repetido Pix', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: p25.id, quantity: 1 }], idempotency_key: 'chave-de-teste-pix-0001' };
  const c = buyer();
  const stock0 = stockOf(p25.id);
  const first = await c.post('/api/orders', body);
  const again = await c.post('/api/orders', body);
  check('enviar o mesmo pedido online duas vezes devolve o mesmo pedido (sem reservar estoque de novo)', first.status === 201 && again.status === 200 && again.data.order.order_number === first.data.order.order_number && again.data.token === first.data.token && stockOf(p25.id) === stock0 - 1);
  const cash = await placeOrder([{ product_id: p25.id, quantity: 1 }], {}, 'cash');
  const pix = await placeOrder([{ product_id: p25.id, quantity: 1 }], {}, 'pix');
  check('dinheiro e Pix com chave seguem como sempre: pedido "novo", sem cobrança', cash.order.order_status === 'new' && pix.order.order_status === 'new' && payCount(cash.number) === 0 && payCount(pix.number) === 0);
  check('o dono ainda marca à mão o pagamento desses pedidos', (await owner.patch(`/api/admin/orders/${orderId(cash.number)}`, { payment_status: 'paid' })).status === 200);
  const conta = new Client(undefined, '203.0.113.150');
  check('as rotas de pagamento não aceitam outros métodos HTTP', (await conta.del(`/api/tracking/${first.data.token}/payment`)).status === 405);

  // Nada sensível nos registros do servidor
  const log = readFileSync(new URL('./server.log', import.meta.url), 'utf8');
  check('o log do servidor não tem o Pix "copia e cola" nem o segredo do simulador', !log.includes('SIMULADO-NAO-PAGAVEL') && !log.includes('segredo-do-simulador') && !log.includes('sim-sub-123'));
  check('...nem o código de acompanhamento do cliente', !log.includes(A.token));
}

// ------------------------------------------------------------------------------------------------
section('17. Conta do cliente: pagar pelo "Meus pedidos", sem o código de acompanhamento');
{
  const maria = new Client(undefined, '203.0.113.180');
  await registerVerified(maria, { name: 'Maria Conta', email: 'maria.conta@exemplo.com.br', phone: '34998887766', password: 'senha-forte-789' });
  const r = await maria.post('/api/orders', { customer_name: 'Maria Conta', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: p25.id, quantity: 1 }] });
  const n = r.data.order.order_number;
  check('o pedido de quem está logado nasce vinculado à conta e aguardando pagamento', r.status === 201 && r.data.order.linked === true && r.data.order.order_status === 'awaiting_payment', r.data);
  const g0 = await maria.get(`/api/account/orders/${n}/payment`);
  check('pela conta: ainda sem Pix (payment nulo), pedido aguardando', g0.status === 200 && g0.data.payment === null && g0.data.order_status === 'awaiting_payment', g0.data);
  const created = await maria.post(`/api/account/orders/${n}/payment`, { method: 'pix' });
  const again = await maria.post(`/api/account/orders/${n}/payment`, { method: 'pix' });
  check('pela conta: gera o Pix (201) e repetir devolve o MESMO (200)', created.status === 201 && created.data.payment.status === 'pending' && created.data.payment.pix?.payload && again.status === 200 && again.data.payment.id === created.data.payment.id && payCount(n) === 1, [created.status, again.status]);
  const byCode = await view(buyer(), r.data.token);
  check('pelo código de acompanhamento o mesmo pagamento aparece (as duas portas dão no mesmo)', byCode.status === 200 && byCode.data.payment.id === created.data.payment.id);

  const other = new Client(undefined, '203.0.113.181');
  await registerVerified(other, { name: 'Outra Conta', email: 'outra.conta@exemplo.com.br', phone: '34998887755', password: 'senha-forte-789' });
  const mine = await other.get(`/api/account/orders/${n}/payment`);
  const nobody = await other.get('/api/account/orders/999999/payment');
  check('outra conta NÃO acessa o pagamento (404, a mesma resposta de um pedido que não existe)', mine.status === 404 && nobody.status === 404 && mine.data.error === nobody.data.error, [mine.data, nobody.data]);
  check('...nem cria cobrança no pedido alheio', (await other.post(`/api/account/orders/${n}/payment`, { method: 'pix' })).status === 404 && payCount(n) === 1);
  check('sem login: 401 para ver e para criar', (await anon.get(`/api/account/orders/${n}/payment`)).status === 401 && (await anon.post(`/api/account/orders/${n}/payment`, { method: 'pix' })).status === 401);
  check('número que não é número: 404', (await maria.get('/api/account/orders/abc/payment')).status === 404);

  await sim.charge(chargeId(n), { status: 'paid' });
  await paidHook('evt-conta-1', chargeId(n));
  const paid = await maria.get(`/api/account/orders/${n}/payment`);
  check('depois de pago, a conta vê "pago", sem Pix, pedido "novo"', paid.data.payment.status === 'paid' && paid.data.payment.pix === null && paid.data.order_status === 'new', paid.data);
  check('"Meus pedidos" mostra o resumo do pagamento no pedido', (await maria.get(`/api/account/orders/${n}`)).data.order.payment?.status === 'paid');
}

summary();
