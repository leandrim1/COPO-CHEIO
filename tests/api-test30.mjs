// Cupons de desconto e frete grátis por valor mínimo (migration 0029).
//  • cupom: percentual / valor fixo / entrega grátis, teto do desconto, pedido mínimo, validade, limite total e por cliente, categorias, "sem itens em promoção",
//    um por pedido, tudo calculado e conferido NO BANCO (o navegador só manda o código e o total que viu), cancelado não conta como uso, corrida pelo último uso;
//  • o pedido guarda o que foi aplicado e NADA depois muda (editar ou apagar o cupom não mexe em pedido feito);
//  • frete grátis por valor: sobre o subtotal depois do cupom, só na entrega, desligado por padrão, nada é confiado ao navegador;
//  • painel: só o owner mexe; validações; código repetido; registro de atividades; prévia pública com limite de tentativas e sem revelar quais códigos existem.
// usage: bash tests/fresh.sh && node tests/api-test30.mjs      (BASE e TEST_DB escolhem o servidor e o banco, p. ex. numa pilha isolada)
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const DAY = 24 * 3600 * 1000;

const owner = new Client(undefined, '198.51.100.30');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true, free_delivery_enabled: false, free_delivery_min: 0 });
const staff = new Client(undefined, '198.51.100.31');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente30@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente30@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.32');

const catBeer = (await owner.post('/api/admin/categories', { name: 'Cervejas Cupom' })).data.category;
const catSoda = (await owner.post('/api/admin/categories', { name: 'Refris Cupom' })).data.category;
const mk = async (name, price, category_id, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id, stock: 500, confirm_duplicate: true, ...extra })).data.product;
const beer = await mk('Cerveja Cupom', 10, catBeer.id);
const soda = await mk('Refri Cupom', 8, catSoda.id, { alcoholic: false });
const sodaPromo = await mk('Refri Promo Cupom', 8, catSoda.id, { alcoholic: false, promo_price: 6, promo_starts_at: iso(-DAY), promo_ends_at: iso(DAY) });
const stockOf = (id) => Number(psql(`select stock from products where id = ${lit(id)}`));

let ip = 60;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const nextPhone = () => `3497${String(2000000 + ++phone).slice(-7)}`;
const order = (items, extra = {}) => ({ customer_name: 'Comprador Cupom', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix', items, ...extra });
const delivery = (items, extra = {}) => order(items, { delivery_type: 'delivery', address: 'Rua das Flores', address_number: '10', neighborhood: 'Centro', ...extra });
const row = (number, cols) => psql(`select ${cols} from orders where order_number = ${number}`);
const create = async (body, client = buyer()) => client.post('/api/orders', body);
const coupon = async (body) => owner.post('/api/admin/coupons', { kind: 'percent', value: 10, ...body });

// ------------------------------------------------------------------------------------------------
section('1. Painel: só o owner mexe nos cupons; validações; código único');
{
  check('sem login: 401', (await anon.get('/api/admin/coupons')).status === 401);
  check('atendente (admin) não lista cupons: 403', (await staff.get('/api/admin/coupons')).status === 403);
  check('atendente não cria cupom: 403', (await staff.post('/api/admin/coupons', { code: 'ATENDENTE', kind: 'percent', value: 5 })).status === 403);
  check('começa sem nenhum cupom', (await owner.get('/api/admin/coupons')).data.coupons.length === 0 && psql('select count(*) from coupons') === '0');

  const bad = async (name, body) => {
    const r = await owner.post('/api/admin/coupons', body);
    check(`recusa: ${name}`, r.status === 400, [r.status, r.data]);
  };
  await bad('código curto', { code: 'AB', kind: 'percent', value: 5 });
  await bad('código com espaço e acento', { code: 'BEM VINDO', kind: 'percent', value: 5 });
  await bad('código com acento', { code: 'AÇAÍ10', kind: 'percent', value: 5 });
  await bad('código longo demais', { code: 'A'.repeat(31), kind: 'percent', value: 5 });
  await bad('tipo desconhecido', { code: 'TIPO', kind: 'brinde', value: 5 });
  await bad('porcentagem 0', { code: 'ZERO', kind: 'percent', value: 0 });
  await bad('porcentagem 101', { code: 'CEMUM', kind: 'percent', value: 101 });
  await bad('valor fixo zero', { code: 'FIXOZERO', kind: 'fixed', value: 0 });
  await bad('valor fixo negativo', { code: 'NEGATIVO', kind: 'fixed', value: -5 });
  await bad('entrega grátis com valor', { code: 'ENTVAL', kind: 'free_delivery', value: 5 });
  await bad('fim antes do começo', { code: 'DATAS', kind: 'percent', value: 5, starts_at: iso(DAY), ends_at: iso(-DAY) });
  await bad('limite de usos zero', { code: 'LIMZERO', kind: 'percent', value: 5, usage_limit: 0 });
  await bad('limite por cliente negativo', { code: 'LIMNEG', kind: 'percent', value: 5, per_customer_limit: -1 });
  await bad('pedido mínimo negativo', { code: 'MINNEG', kind: 'percent', value: 5, min_order: -1 });
  await bad('categoria que não existe', { code: 'CATFAKE', kind: 'percent', value: 5, category_ids: ['00000000-0000-4000-8000-000000000000'] });
  await bad('categorias que não são lista', { code: 'CATTXT', kind: 'percent', value: 5, category_ids: 'todas' });
  check('nenhum cupom inválido foi gravado', psql('select count(*) from coupons') === '0');

  const made = await coupon({ code: ' bemvindo10 ', description: 'Primeira compra' });
  check('cria o cupom: 201, código em maiúsculas e sem espaços', made.status === 201 && made.data.coupon.code === 'BEMVINDO10' && made.data.coupon.active === true && made.data.coupon.kind === 'percent', made.data);
  const dup = await coupon({ code: 'bemvindo10' });
  check('código repetido (mesmo em minúsculas): 409', dup.status === 409 && /já existe/i.test(dup.data.error), dup.data);
  const listed = (await owner.get('/api/admin/coupons')).data.coupons;
  check('a lista traz o cupom com used = 0 e categorias vazias', listed.length === 1 && listed[0].used === 0 && Array.isArray(listed[0].category_ids) && listed[0].category_ids.length === 0, listed);
  check('o registro de atividades guarda quem criou', /BEMVINDO10/.test(psql("select string_agg(summary, ' | ') from audit_log where action = 'coupon.create'")));
  const patched = await owner.patch(`/api/admin/coupons/${made.data.coupon.id}`, { description: 'Boas-vindas', value: 15 });
  check('edita: 200', patched.status === 200 && Number(patched.data.coupon.value) === 15 && patched.data.coupon.description === 'Boas-vindas', patched.data);
  check('...e registra a mudança', psql("select count(*) from audit_log where action = 'coupon.update'") === '1');
  check('editar cupom que não existe: 404', (await owner.patch('/api/admin/coupons/00000000-0000-4000-8000-000000000000', { active: false })).status === 404);
  check('atendente não edita nem apaga', (await staff.patch(`/api/admin/coupons/${made.data.coupon.id}`, { active: false })).status === 403 && (await staff.del(`/api/admin/coupons/${made.data.coupon.id}`)).status === 403);
  check('apagar cupom que não existe: 404', (await owner.del('/api/admin/coupons/00000000-0000-4000-8000-000000000000')).status === 404);
  check('apaga o cupom', (await owner.del(`/api/admin/coupons/${made.data.coupon.id}`)).status === 200 && psql('select count(*) from coupons') === '0');
  check('...e registra', psql("select count(*) from audit_log where action = 'coupon.delete'") === '1');
}

// ------------------------------------------------------------------------------------------------
section('2. Prévia pública (POST /api/coupons/validate): o servidor lê os preços no banco e não revela quais códigos existem');
{
  await coupon({ code: 'DEZ', kind: 'percent', value: 10 });
  await coupon({ code: 'OFF', kind: 'percent', value: 50, active: false });
  await coupon({ code: 'VENCIDO', kind: 'percent', value: 10, starts_at: iso(-3 * DAY), ends_at: iso(-DAY) });
  await coupon({ code: 'FUTURO', kind: 'percent', value: 10, starts_at: iso(DAY), ends_at: iso(3 * DAY) });
  const items = [{ product_id: beer.id, quantity: 3 }];
  const ok = await anon.post('/api/coupons/validate', { code: 'dez', delivery_type: 'pickup', items });
  check('cupom válido (sem login): 200 com o desconto calculado pelo servidor (3 x R$ 10 = R$ 30 → R$ 3)', ok.status === 200 && ok.data.coupon.code === 'DEZ' && ok.data.coupon.discount === 3 && ok.data.coupon.free_delivery === false, ok.data);
  check('código em minúsculas e com espaços também vale', (await anon.post('/api/coupons/validate', { code: '  dez ', delivery_type: 'pickup', items })).status === 200);

  const generic = [];
  for (const code of ['NAOEXISTE', 'OFF', 'VENCIDO', 'FUTURO', '', 'a', "x'; drop table coupons;--", 'ÇÇÇ', 'A'.repeat(40)]) {
    const r = await anon.post('/api/coupons/validate', { code, delivery_type: 'pickup', items });
    generic.push([code, r.status, r.data?.error, r.data?.code]);
  }
  check('inexistente, desligado, vencido, ainda não começou e lixo: sempre 400 com a MESMA mensagem (não revela quais códigos existem)', generic.every(([, s, e, c]) => s === 400 && e === generic[0][2] && c === 'coupon_invalid') && /inválido ou expirado/i.test(generic[0][2]), generic);
  check('nada foi gravado pelas prévias', psql('select count(*) from orders') === '0');
  check('corpo sem itens: 400', (await anon.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items: [] })).status === 400);
  check('item inválido: 400', (await anon.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items: [{ product_id: 'nao-uuid', quantity: 1 }] })).status === 400);
  check('o navegador não escolhe o preço: "unit_price"/"discount" no corpo são ignorados', (await anon.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items: [{ product_id: beer.id, quantity: 3, unit_price: 0.01 }], discount: 999 })).data.coupon.discount === 3);

  // Limite de tentativas por rede: quem erra o código muitas vezes (adivinhação) é barrado, até com o código certo; quem acerta não gasta tentativa.
  const guesser = new Client(undefined, '198.51.100.99');
  const codes = [];
  for (let i = 0; i < 16; i++) codes.push((await guesser.post('/api/coupons/validate', { code: `CHUTE${i}`, delivery_type: 'pickup', items })).status);
  check('12 códigos errados passam como "inválido" (400) e a partir daí vem 429', codes.slice(0, 12).every((c) => c === 400) && codes.slice(12).every((c) => c === 429), codes);
  const stillBlocked = await guesser.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items });
  check('...e nem o código certo passa enquanto a rede está barrada (com Retry-After)', stillBlocked.status === 429 && Number(stillBlocked.headers.get('retry-after')) > 0, [stillBlocked.status, stillBlocked.data]);
  const hitter = new Client(undefined, '198.51.100.98');
  let okCount = 0;
  for (let i = 0; i < 20; i++) if ((await hitter.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items })).status === 200) okCount++;
  check('quem acerta o código não gasta tentativas de erro (20 prévias seguidas passam)', okCount === 20, okCount);
  check('...e outra rede não é afetada pelo bloqueio', (await anon.post('/api/coupons/validate', { code: 'DEZ', delivery_type: 'pickup', items })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('3. Pedido com cupom: o banco calcula, grava e o pedido nunca mais muda');
{
  const before = stockOf(beer.id);
  const sem = await create(order([{ product_id: beer.id, quantity: 3 }]));
  check('sem cupom: nada mudou (R$ 30, desconto 0)', sem.status === 201 && sem.data.order.total === 30 && sem.data.order.discount === 0 && sem.data.order.coupon_code === undefined, sem.data.order);

  const a = await create(order([{ product_id: beer.id, quantity: 3 }], { coupon_code: 'dez' }));
  check('com o cupom DEZ: 10% de R$ 30 = R$ 3, total R$ 27', a.status === 201 && a.data.order.discount === 3 && a.data.order.total === 27 && a.data.order.coupon_code === 'DEZ', a.data);
  const n = a.data.order.order_number;
  check('o pedido grava cupom, desconto e total (cupom e desconto ficam no pedido)', row(n, 'coupon_code') === 'DEZ' && row(n, 'discount') === '3.00' && row(n, 'total') === '27.00' && row(n, 'coupon_id is not null') === 't');
  check('o estoque foi reservado normalmente', stockOf(beer.id) === before - 6);
  const seen = await owner.get(`/api/admin/orders/${n}`);
  check('o painel mostra o cupom e o desconto do pedido', seen.data.order.coupon_code === 'DEZ' && Number(seen.data.order.discount) === 3, seen.data.order);
  const track = await anon.get(`/api/tracking/${a.data.token}`);
  check('a página do cliente mostra o cupom e o desconto', track.data.order.coupon_code === 'DEZ' && track.data.order.discount === 3, track.data);

  // O navegador não decide o desconto
  const forged = await create(order([{ product_id: beer.id, quantity: 3 }], { discount: 30, total: 1, subtotal: 1, delivery_fee: 0 }));
  check('"discount", "total" e "subtotal" mandados pelo navegador são ignorados', forged.status === 201 && forged.data.order.discount === 0 && forged.data.order.total === 30, forged.data.order);

  // Total que a pessoa viu
  const seenTotal = await create(order([{ product_id: beer.id, quantity: 3 }], { coupon_code: 'DEZ', expected_total: '27.00' }));
  check('expected_total igual ao calculado com o cupom: pedido criado', seenTotal.status === 201 && seenTotal.data.order.total === 27, seenTotal.data);
  const wrongTotal = await create(order([{ product_id: beer.id, quantity: 3 }], { coupon_code: 'DEZ', expected_total: '30.00' }));
  check('expected_total sem o desconto que o cupom dá: 409 price_changed com o desconto atual', wrongTotal.status === 409 && wrongTotal.data.code === 'price_changed' && Number(wrongTotal.data.discount) === 3 && Number(wrongTotal.data.total) === 27, wrongTotal.data);
  check('...e nada foi criado nem o estoque mexeu', stockOf(beer.id) === before - 12);

  // Mudar o cupom depois não altera o pedido
  const dez = (await owner.get('/api/admin/coupons')).data.coupons.find((c) => c.code === 'DEZ');
  check('o painel conta os usos (pedidos não cancelados)', dez.used === 2, dez.used);
  await owner.patch(`/api/admin/coupons/${dez.id}`, { value: 50, active: false });
  check('mudar o cupom depois NÃO altera pedido feito', row(n, 'discount') === '3.00' && row(n, 'total') === '27.00' && row(n, 'coupon_code') === 'DEZ');
  const after = await anon.get(`/api/tracking/${a.data.token}`);
  check('...nem o que o cliente vê', after.data.order.discount === 3 && after.data.order.total === 27);
  const off = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DEZ' }));
  check('cupom desligado depois: novo pedido com ele é recusado', off.status === 400 && /inválido ou expirado/i.test(off.data.error), off.data);
  await owner.patch(`/api/admin/coupons/${dez.id}`, { value: 10, active: true });
  await owner.del(`/api/admin/coupons/${dez.id}`);
  check('apagar o cupom NÃO apaga nem altera pedido feito (código e desconto ficam gravados)', row(n, 'coupon_code') === 'DEZ' && row(n, 'discount') === '3.00' && row(n, 'coupon_id is null') === 't');
  await coupon({ code: 'DEZ', kind: 'percent', value: 10 });
}

// ------------------------------------------------------------------------------------------------
section('4. Tipos e regras: valor fixo, teto, mínimo, categorias, itens em promoção, entrega grátis');
{
  await coupon({ code: 'CINCO', kind: 'fixed', value: 5 });
  await coupon({ code: 'TETO', kind: 'percent', value: 50, max_discount: 4 });
  await coupon({ code: 'MIN50', kind: 'percent', value: 10, min_order: 50 });
  await coupon({ code: 'SOCERVEJA', kind: 'percent', value: 50, category_ids: [catBeer.id] });
  await coupon({ code: 'SEMPROMO', kind: 'percent', value: 50, excludes_promo: true });
  await coupon({ code: 'FRETE', kind: 'free_delivery', value: 0 });
  const get = async (code, items, type = 'pickup') => (await anon.post('/api/coupons/validate', { code, delivery_type: type, items })).data;

  const fixed = await create(order([{ product_id: beer.id, quantity: 2 }], { coupon_code: 'CINCO' }));
  check('valor fixo: R$ 20 - R$ 5 = R$ 15', fixed.status === 201 && fixed.data.order.discount === 5 && fixed.data.order.total === 15, fixed.data.order);
  const tiny = await create(order([{ product_id: soda.id, quantity: 1 }], { coupon_code: 'CINCO' }));
  check('valor fixo nunca passa dos itens: R$ 8 com cupom de R$ 5 → desconto R$ 5', tiny.status === 201 && tiny.data.order.discount === 5 && tiny.data.order.total === 3);
  const tinier = await create(order([{ product_id: sodaPromo.id, quantity: 1 }], { coupon_code: 'CINCO' }));
  check('...e o total nunca fica negativo (R$ 6 em promoção - R$ 5)', tinier.status === 201 && tinier.data.order.total === 1);
  await coupon({ code: 'GRANDE', kind: 'fixed', value: 100 });
  const big = await create(order([{ product_id: soda.id, quantity: 1 }], { coupon_code: 'GRANDE' }));
  check('cupom de R$ 100 num pedido de R$ 8: desconto limitado a R$ 8, total R$ 0', big.status === 201 && big.data.order.discount === 8 && big.data.order.total === 0, big.data.order);

  const cap = await create(order([{ product_id: beer.id, quantity: 4 }], { coupon_code: 'TETO' }));
  check('teto do desconto: 50% de R$ 40 seria R$ 20, mas o teto é R$ 4', cap.status === 201 && cap.data.order.discount === 4 && cap.data.order.total === 36, cap.data.order);

  const low = await create(order([{ product_id: beer.id, quantity: 4 }], { coupon_code: 'MIN50' }));
  check('pedido mínimo do cupom: R$ 40 < R$ 50 → recusado com o motivo', low.status === 400 && /R\$\s?50,00/.test(low.data.error), low.data);
  const enough = await create(order([{ product_id: beer.id, quantity: 5 }], { coupon_code: 'MIN50' }));
  check('...com R$ 50 passa (mínimo conta o subtotal antes do desconto)', enough.status === 201 && enough.data.order.discount === 5, enough.data);
  check('a prévia diz o mesmo motivo', /R\$\s?50,00/.test((await get('MIN50', [{ product_id: beer.id, quantity: 4 }])).error));

  const mixedCat = await create(order([{ product_id: beer.id, quantity: 2 }, { product_id: soda.id, quantity: 2 }], { coupon_code: 'SOCERVEJA' }));
  check('categoria: 50% só sobre a cerveja (R$ 20 → R$ 10), o refri (R$ 16) fica sem desconto', mixedCat.status === 201 && mixedCat.data.order.discount === 10 && mixedCat.data.order.total === 26, mixedCat.data.order);
  const wrongCat = await create(order([{ product_id: soda.id, quantity: 1 }], { coupon_code: 'SOCERVEJA' }));
  check('categoria: pedido sem nenhum item da categoria → recusado', wrongCat.status === 400 && /não vale para os itens/i.test(wrongCat.data.error), wrongCat.data);

  const promoCart = [{ product_id: beer.id, quantity: 1 }, { product_id: sodaPromo.id, quantity: 2 }];
  const noPromo = await create(order(promoCart, { coupon_code: 'SEMPROMO' }));
  check('"sem itens em promoção": 50% só sobre a cerveja (R$ 10 → R$ 5); o refri em promoção (R$ 12) fica inteiro', noPromo.status === 201 && noPromo.data.order.discount === 5 && noPromo.data.order.total === 17, noPromo.data.order);
  const onlyPromo = await create(order([{ product_id: sodaPromo.id, quantity: 1 }], { coupon_code: 'SEMPROMO' }));
  check('...só item em promoção: recusado', onlyPromo.status === 400, onlyPromo.data);
  const withPromoOk = await create(order(promoCart, { coupon_code: 'DEZ' }));
  check('cupom comum soma com a promoção que já está no preço do produto (10% de R$ 22 = R$ 2,20)', withPromoOk.status === 201 && withPromoOk.data.order.discount === 2.2 && withPromoOk.data.order.total === 19.8, withPromoOk.data.order);

  // Entrega grátis (cupom)
  const fretePickup = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'FRETE' }));
  check('cupom de entrega grátis em pedido de RETIRADA: recusado', fretePickup.status === 400 && /só para entrega/i.test(fretePickup.data.error), fretePickup.data);
  const freteOn = await create(delivery([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'FRETE' }));
  check('cupom de entrega grátis em ENTREGA: taxa R$ 5 deixa de ser cobrada; desconto 0; total R$ 10', freteOn.status === 201 && freteOn.data.order.delivery_fee === 0 && freteOn.data.order.discount === 0 && freteOn.data.order.total === 10 && freteOn.data.order.delivery_fee_waived === 5, freteOn.data.order);
  check('...o pedido grava a taxa dispensada', row(freteOn.data.order.order_number, 'delivery_fee_waived') === '5.00');
  const freteNo = await create(delivery([{ product_id: beer.id, quantity: 1 }]));
  check('sem cupom a entrega continua R$ 5 (e a chave de taxa dispensada nem aparece)', freteNo.status === 201 && freteNo.data.order.delivery_fee === 5 && freteNo.data.order.delivery_fee_waived === undefined, freteNo.data.order);
  check('a prévia do cupom de entrega mostra free_delivery', (await get('FRETE', [{ product_id: beer.id, quantity: 1 }], 'delivery')).coupon.free_delivery === true);

  // Um cupom por pedido: o campo é um único código
  const two = await create(order([{ product_id: beer.id, quantity: 2 }], { coupon_code: ['DEZ', 'CINCO'] }));
  check('mais de um cupom por pedido (lista no lugar do código): recusado', two.status >= 400 && two.status < 500, [two.status, two.data]);
  const inject = await create(order([{ product_id: beer.id, quantity: 2 }], { coupon_code: "DEZ' or '1'='1" }));
  check('código com aspas/SQL: recusado como cupom inválido', inject.status === 400 && /inválido ou expirado/i.test(inject.data.error), inject.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Limites de uso: total, por cliente (telefone ou conta), cancelado libera, corrida pelo último uso');
{
  await coupon({ code: 'DOIS', kind: 'percent', value: 10, usage_limit: 2 });
  const o1 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DOIS' }));
  const o2 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DOIS' }));
  const o3 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DOIS' }));
  check('limite total de 2 usos: dois passam e o terceiro é recusado', o1.status === 201 && o2.status === 201 && o3.status === 400 && /já foi todo usado/i.test(o3.data.error), [o1.status, o2.status, o3.status, o3.data]);
  check('...e o terceiro não reservou estoque (nenhum pedido criado)', psql("select count(*) from orders where coupon_code = 'DOIS'") === '2');
  const cancel = await owner.patch(`/api/admin/orders/${psql(`select id from orders where order_number = ${o1.data.order.order_number}`)}`, { status: 'cancelled' });
  check('cancelar um dos pedidos', cancel.status === 200, cancel.data);
  const o4 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DOIS' }));
  check('pedido cancelado não conta como uso: o uso volta e um novo pedido passa', o4.status === 201, o4.data);
  const listed = (await owner.get('/api/admin/coupons')).data.coupons.find((c) => c.code === 'DOIS');
  check('o painel conta 2 usos (cancelado fora)', listed.used === 2, listed.used);

  await coupon({ code: 'UMPORCLIENTE', kind: 'percent', value: 10, per_customer_limit: 1 });
  const telefone = nextPhone();
  const p1 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE', customer_phone: telefone }));
  const p2 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE', customer_phone: telefone }));
  const p3 = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE' }));
  check('1 por cliente: o mesmo telefone não usa duas vezes; outro telefone usa', p1.status === 201 && p2.status === 400 && /já usou/i.test(p2.data.error) && p3.status === 201, [p1.status, p2.status, p3.status, p2.data]);
  const mascara = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE', customer_phone: `(${telefone.slice(0, 2)}) ${telefone.slice(2, 7)}-${telefone.slice(7)}` }));
  check('...o telefone com máscara é o mesmo telefone', mascara.status === 400, mascara.data);
  const prev = await anon.post('/api/coupons/validate', { code: 'UMPORCLIENTE', delivery_type: 'pickup', phone: telefone, items: [{ product_id: beer.id, quantity: 1 }] });
  check('a prévia com o telefone também avisa', prev.status === 400 && /já usou/i.test(prev.data.error), prev.data);

  // Conta do cliente: o limite vale pela conta mesmo trocando de telefone
  const acc = new Client(undefined, '203.0.113.200');
  await registerVerified(acc, { name: 'Cliente Cupom', email: 'cliente.cupom@exemplo.com', phone: '34981112222', password: 'senha-forte-123' });
  const c1 = await acc.post('/api/orders', order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE' }));
  const c2 = await acc.post('/api/orders', order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'UMPORCLIENTE' }));
  check('limite por cliente vale pela CONTA, mesmo trocando o telefone', c1.status === 201 && c2.status === 400 && /já usou/i.test(c2.data.error), [c1.status, c2.status, c2.data]);

  // Corrida: dois pedidos ao mesmo tempo pelo último uso
  await coupon({ code: 'ULTIMO', kind: 'percent', value: 10, usage_limit: 1 });
  const runs = await Promise.all(Array.from({ length: 6 }, () => create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'ULTIMO' }))));
  const winners = runs.filter((r) => r.status === 201).length;
  check('6 pedidos simultâneos pelo último uso: exatamente 1 passa', winners === 1 && psql("select count(*) from orders where coupon_code = 'ULTIMO'") === '1', runs.map((r) => r.status));
  check('...e o estoque dos que falharam voltou (nenhum pedido criado por eles)', runs.filter((r) => r.status !== 201).every((r) => r.status === 400));
}

// ------------------------------------------------------------------------------------------------
section('6. Validade: ainda não começou, vencido, desligado');
{
  await coupon({ code: 'NOFUTURO', kind: 'percent', value: 10, starts_at: iso(DAY) });
  await coupon({ code: 'NOPASSADO', kind: 'percent', value: 10, ends_at: iso(-60_000) });
  await coupon({ code: 'DENTRO', kind: 'percent', value: 10, starts_at: iso(-DAY), ends_at: iso(DAY) });
  const f = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'NOFUTURO' }));
  const p = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'NOPASSADO' }));
  const d = await create(order([{ product_id: beer.id, quantity: 1 }], { coupon_code: 'DENTRO' }));
  check('antes de começar e depois de vencer: recusado; dentro da janela: vale', f.status === 400 && p.status === 400 && d.status === 201, [f.status, p.status, d.status]);
}

// ------------------------------------------------------------------------------------------------
section('7. Frete grátis por valor mínimo: desligado por padrão, só na entrega, depois do cupom');
{
  const site0 = (await anon.get('/api/site')).data.store;
  check('o site expõe a regra (desligada por padrão, valor 0)', site0.free_delivery_enabled === false && Number(site0.free_delivery_min) === 0, site0);
  const off = await create(delivery([{ product_id: beer.id, quantity: 10 }]));
  check('desligado: entrega de R$ 100 continua com taxa de R$ 5', off.status === 201 && off.data.order.delivery_fee === 5 && off.data.order.total === 105, off.data.order);

  const setIt = await owner.patch('/api/admin/store', { free_delivery_enabled: true, free_delivery_min: 50 });
  check('owner liga o frete grátis a partir de R$ 50', setIt.status === 200 && setIt.data.store.free_delivery_enabled === true && Number(setIt.data.store.free_delivery_min) === 50, setIt.data);
  check('valor inválido recusado', (await owner.patch('/api/admin/store', { free_delivery_min: -1 })).status === 400 && (await owner.patch('/api/admin/store', { free_delivery_enabled: 'sim' })).status === 400);
  const site1 = (await anon.get('/api/site')).data.store;
  check('o site passa a mostrar a regra', site1.free_delivery_enabled === true && Number(site1.free_delivery_min) === 50);
  check('o registro de atividades guarda a mudança', /entrega gr/i.test(psql("select string_agg(summary, ' | ') from audit_log where action like 'store.%'")));

  const below = await create(delivery([{ product_id: beer.id, quantity: 4 }]));
  check('abaixo do valor (R$ 40): taxa cobrada', below.status === 201 && below.data.order.delivery_fee === 5 && below.data.order.total === 45 && below.data.order.delivery_fee_waived === undefined, below.data.order);
  const exact = await create(delivery([{ product_id: beer.id, quantity: 5 }]));
  check('no valor exato (R$ 50): entrega grátis, e o pedido grava a taxa dispensada', exact.status === 201 && exact.data.order.delivery_fee === 0 && exact.data.order.total === 50 && exact.data.order.delivery_fee_waived === 5, exact.data.order);
  const pickup = await create(order([{ product_id: beer.id, quantity: 6 }]));
  check('retirada não tem taxa nem "dispensada"', pickup.status === 201 && pickup.data.order.delivery_fee === 0 && pickup.data.order.delivery_fee_waived === undefined);

  // Depois do cupom: R$ 60 com cupom de R$ 15 → R$ 45 < 50 → paga a taxa; R$ 60 com R$ 5 → R$ 55 ≥ 50 → grátis
  await coupon({ code: 'QUINZE', kind: 'fixed', value: 15 });
  const afterCoupon = await create(delivery([{ product_id: beer.id, quantity: 6 }], { coupon_code: 'QUINZE' }));
  check('a regra olha o subtotal DEPOIS do cupom: R$ 60 - R$ 15 = R$ 45 < R$ 50 → taxa cobrada (total R$ 50)', afterCoupon.status === 201 && afterCoupon.data.order.delivery_fee === 5 && afterCoupon.data.order.discount === 15 && afterCoupon.data.order.total === 50, afterCoupon.data.order);
  const stillFree = await create(delivery([{ product_id: beer.id, quantity: 6 }], { coupon_code: 'CINCO' }));
  check('R$ 60 - R$ 5 = R$ 55 ≥ R$ 50 → entrega grátis e desconto do cupom (total R$ 55)', stillFree.status === 201 && stillFree.data.order.delivery_fee === 0 && stillFree.data.order.discount === 5 && stillFree.data.order.total === 55, stillFree.data.order);
  const both = await create(delivery([{ product_id: beer.id, quantity: 6 }], { coupon_code: 'FRETE' }));
  check('cupom de entrega grátis + regra de valor: a taxa é dispensada UMA vez (não soma nem vira crédito)', both.status === 201 && both.data.order.delivery_fee === 0 && both.data.order.delivery_fee_waived === 5 && both.data.order.total === 60, both.data.order);

  const total = await create(delivery([{ product_id: beer.id, quantity: 5 }], { expected_total: '55.00' }));
  check('o navegador achando que ainda paga a taxa (R$ 55): 409 com o total novo (R$ 50) e a taxa zerada', total.status === 409 && total.data.code === 'price_changed' && Number(total.data.total) === 50 && Number(total.data.delivery_fee) === 0, total.data);
  const forged = await create(delivery([{ product_id: beer.id, quantity: 1 }], { delivery_fee: 0, free_delivery: true, delivery_fee_waived: 99 }));
  check('o navegador não consegue frete grátis por conta própria', forged.status === 201 && forged.data.order.delivery_fee === 5 && forged.data.order.delivery_fee_waived === undefined, forged.data.order);

  // Bairros com taxa própria
  const zone = (await owner.post('/api/admin/zones', { name: 'Centro', fee: 8 })).data.zone;
  const z1 = await create(delivery([{ product_id: beer.id, quantity: 2 }]));
  const z2 = await create(delivery([{ product_id: beer.id, quantity: 5 }]));
  check('com taxa por bairro: abaixo do valor paga a do bairro (R$ 8); no valor, a do bairro é dispensada', z1.status === 201 && z1.data.order.delivery_fee === 8 && z2.status === 201 && z2.data.order.delivery_fee === 0 && z2.data.order.delivery_fee_waived === 8, [z1.data.order, z2.data.order]);
  await owner.del(`/api/admin/zones/${zone.id}`);

  // Desligar de novo
  await owner.patch('/api/admin/store', { free_delivery_enabled: false });
  const back = await create(delivery([{ product_id: beer.id, quantity: 6 }]));
  check('desligar de novo: volta a cobrar a taxa (pedidos de antes continuam como foram)', back.status === 201 && back.data.order.delivery_fee === 5 && psql(`select delivery_fee_waived from orders where order_number = ${exact.data.order.order_number}`) === '5.00');
}

// ------------------------------------------------------------------------------------------------
section('8. Direto no banco e consistência');
{
  let refused = '';
  try {
    psql(`select create_order(${lit(JSON.stringify(order([{ product_id: beer.id, quantity: 1 }], { age_confirmed: true, coupon_code: 'INEXISTENTE' })))}::jsonb)`);
  } catch (error) {
    refused = String(error.stderr ?? error.message);
  }
  check('create_order direto no banco com cupom inexistente: recusado', /inválido ou expirado/i.test(refused), refused);
  check('nenhum pedido tem desconto maior que o subtotal nem total negativo', psql('select count(*) from orders where discount > subtotal or total < 0') === '0');
  check('total = subtotal - desconto + entrega + taxa de pagamento, em todos os pedidos', psql('select count(*) from orders where total <> subtotal - discount + delivery_fee + payment_fee') === '0');
  check('todo pedido com cupom tem desconto > 0 ou taxa dispensada', psql("select count(*) from orders where coupon_code is not null and discount = 0 and delivery_fee_waived = 0") === '0');
  check('pedidos de antes (sem cupom) seguem com desconto 0', psql("select count(*) from orders where coupon_code is null and discount <> 0") === '0');
  check('o JSON público do pedido sem cupom não ganha chaves novas', !('coupon_code' in JSON.parse(psql(`select order_json(id)::text from orders where coupon_code is null order by order_number limit 1`))));
}

summary();
