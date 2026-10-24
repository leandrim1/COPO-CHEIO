// Pagamento pelo site retirado (Pix online e cartão online, ValidaPay), migration 0036. O que sobra são só as formas pagas à loja.
//  • o cardápio público nunca lista "pix_online" nem "card_online", mesmo que a linha exista no banco e esteja ligada;
//  • pedido com uma dessas formas é recusado (400, `payment_unavailable`) e nada é gravado, nem estoque reservado;
//  • o painel não consegue ligá-las (400) e a lista de formas do painel não as mostra;
//  • desligar a última forma paga à loja continua proibido (mesmo com uma forma online "ligada" no banco);
//  • as rotas da operadora (webhook, pagamento do pedido, cartão, painel de pagamentos online) não existem mais (404);
//  • a migration 0036 desliga as duas formas online que estivessem ligadas, e rodar de novo não muda nada.
// usage: bash tests/fresh.sh && node tests/api-test39.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, check, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

const owner = new Client(undefined, '198.51.100.150');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client(undefined, '198.51.100.151');
const cat = (await owner.post('/api/admin/categories', { name: 'Sem pagamento online' })).data.category;
const item = (await owner.post('/api/admin/products', { name: 'Produto sem online', price: 10, category_id: cat.id, stock: 50, alcoholic: false, confirm_duplicate: true })).data.product;
let phone = 0;
const order = (extra = {}) => ({ customer_name: 'Comprador Local', customer_phone: `3497${String(3900000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'cash', items: [{ product_id: item.id, quantity: 1 }], ...extra });
const stock = () => Number(psql(`select stock from products where id = '${item.id}'`));
const codes = (list) => list.map((p) => p.code).sort().join(',');

// ------------------------------------------------------------------------------------------------
section('1. O que o cliente vê: só as formas pagas à loja, mesmo com uma forma online ligada no banco');
{
  const pub = await anon.get('/api/site');
  check('o site lista só Pix, dinheiro e cartão na entrega', pub.status === 200 && codes(pub.data.payments) === 'card,cash,pix', codes(pub.data.payments ?? []));
  // Estado de um banco antigo: as duas formas online existiam e podiam estar ligadas.
  psql("update payment_methods set enabled = true where code in ('pix_online', 'card_online')");
  const again = await anon.get('/api/site');
  check('com as formas online ligadas no banco, o site continua sem listá-las', again.status === 200 && codes(again.data.payments) === 'card,cash,pix', codes(again.data.payments ?? []));
  check('nenhum campo de taxa do pagamento online vai para o navegador', !JSON.stringify(again.data.payments).match(/card_fee|service_fee/));
}

// ------------------------------------------------------------------------------------------------
section('2. Pedido com pagamento pelo site é recusado e não reserva nada');
{
  const before = stock();
  const orders = Number(psql('select count(*) from orders'));
  for (const method of ['pix_online', 'card_online']) {
    const res = await new Client(undefined, `203.0.113.${60 + (method === 'pix_online' ? 0 : 1)}`).post('/api/orders', order({ payment_method: method, customer_email: 'cliente@exemplo.com' }));
    check(`${method}: recusado (400) com o código payment_unavailable`, res.status === 400 && res.data.code === 'payment_unavailable', [res.status, res.data]);
  }
  check('nenhum pedido criado e o estoque não mudou', Number(psql('select count(*) from orders')) === orders && stock() === before);
  const ok = await new Client(undefined, '203.0.113.62').post('/api/orders', order());
  check('dinheiro continua funcionando (201) e o pedido nasce "novo", sem etapa de pagamento', ok.status === 201 && psql(`select order_status from orders where order_number = ${ok.data.order.order_number}`) === 'new', [ok.status, ok.data]);
}

// ------------------------------------------------------------------------------------------------
section('3. Painel: não liga o pagamento pelo site e não o mostra');
{
  for (const code of ['pix_online', 'card_online']) {
    const res = await owner.patch(`/api/admin/payments/${code}`, { enabled: true });
    check(`${code}: o painel não consegue ligar (400)`, res.status === 400, [res.status, res.data]);
  }
  const settings = await owner.get('/api/admin/settings');
  check('a lista de formas de pagamento do painel só tem as pagas à loja', settings.status === 200 && codes(settings.data.payments) === 'card,cash,pix', codes(settings.data.payments ?? []));
  // As três formas da loja desligadas, com uma online ligada no banco: o painel continua recusando deixar o cliente sem nenhuma forma.
  await owner.patch('/api/admin/payments/cash', { enabled: false });
  await owner.patch('/api/admin/payments/card', { enabled: false });
  const last = await owner.patch('/api/admin/payments/pix', { enabled: false });
  check('a última forma paga à loja não desliga (400), mesmo com uma online ligada no banco', last.status === 400, [last.status, last.data]);
  await owner.patch('/api/admin/payments/cash', { enabled: true });
  await owner.patch('/api/admin/payments/card', { enabled: true });
}

// ------------------------------------------------------------------------------------------------
section('4. As rotas da operadora não existem mais');
{
  const hash = 'a'.repeat(40);
  const gone = [
    ['POST', '/api/payments/webhook'],
    ['GET', `/api/tracking/${hash}/payment`],
    ['POST', `/api/tracking/${hash}/payment`],
    ['POST', `/api/tracking/${hash}/payment/card`],
    ['GET', '/api/admin/payments'],
    ['GET', '/api/admin/payment-fees/card'],
    ['GET', '/api/admin/payments/account/candidates'],
  ];
  for (const [method, path] of gone) {
    const res = await (method === 'GET' ? owner.get(path) : owner.post(path, {}));
    check(`${method} ${path.replace(hash, ':código')}: 404`, res.status === 404, res.status);
  }
}

// ------------------------------------------------------------------------------------------------
section('5. A migration 0036 desliga as formas online e pode rodar de novo');
{
  const sql = readFileSync(new URL('../db/migrations/0036_remove_online_payments.sql', import.meta.url), 'utf8');
  psql("update payment_methods set enabled = true where code in ('pix_online', 'card_online')");
  psql(sql);
  check('as duas formas online ficam desligadas', psql("select count(*) from payment_methods where code in ('pix_online', 'card_online') and enabled") === '0');
  const others = psql("select string_agg(code || ':' || enabled, ',' order by code) from payment_methods where code not in ('pix_online', 'card_online')");
  psql(sql);
  check('rodar de novo não muda nada (nem as outras formas)', psql("select count(*) from payment_methods where code in ('pix_online', 'card_online') and enabled") === '0' && psql("select string_agg(code || ':' || enabled, ',' order by code) from payment_methods where code not in ('pix_online', 'card_online')") === others, others);
}

// ------------------------------------------------------------------------------------------------
section('6. Políticas: o texto padrão que falava do pagamento pelo site é trocado; texto editado pela loja não é tocado');
{
  const sql = readFileSync(new URL('../db/migrations/0036_remove_online_payments.sql', import.meta.url), 'utf8');
  const seed = readFileSync(new URL('../db/migrations/0033_legal_pages.sql', import.meta.url), 'utf8');
  const original = (slug) => seed.match(new RegExp(`\\('${slug}', '[^']*', \\$t\\$([\\s\\S]*?)\\$t\\$\\)`))[1];
  const body = (slug) => psql(`select body from legal_pages where slug = '${slug}'`);
  const lit = (v) => `$x$${v}$x$`;
  const pages = ['trocas-e-cancelamentos', 'pagamento-e-reembolso'];
  check('um banco novo já tem o texto sem "operadora", "QR Code" nem "pelo site"', pages.every((slug) => !/operadora|QR Code|pelo site/i.test(body(slug))), pages.map((slug) => body(slug).slice(0, 80)));
  const publicText = (await anon.get('/api/legal/pagamento-e-reembolso')).data;
  check('a página pública mostra o texto novo', JSON.stringify(publicText).includes('Como pagar'), publicText);
  // Banco antigo: o texto padrão da 0033, já marcado como revisado.
  for (const slug of pages) psql(`update legal_pages set body = ${lit(original(slug))}, reviewed_at = now(), reviewed_by = 'Advogada' where slug = '${slug}'`);
  psql(sql);
  check('com o texto padrão antigo, a migration troca o texto e tira a marca de revisado', pages.every((slug) => !/operadora/i.test(body(slug)) && psql(`select reviewed_at is null from legal_pages where slug = '${slug}'`) === 't'));
  // A loja editou: nada é sobrescrito e a revisão fica.
  psql(`update legal_pages set body = ${lit('Texto próprio da loja, escrito pelo dono, com mais de vinte caracteres.')}, reviewed_at = now(), reviewed_by = 'Advogada' where slug = 'pagamento-e-reembolso'`);
  psql(sql);
  check('texto editado pela loja não é sobrescrito e continua revisado', body('pagamento-e-reembolso').startsWith('Texto próprio da loja') && psql("select reviewed_by from legal_pages where slug = 'pagamento-e-reembolso'") === 'Advogada');
}

summary();
