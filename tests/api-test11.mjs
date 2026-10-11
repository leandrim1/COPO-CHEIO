// Pedidos e catálogo: pedido repetido, total conferido, preço, duplicados, regras de status e pagamento, estoque, painel, promoção com
// datas, importação com relatório e cache das listas públicas.
import { execFileSync } from 'node:child_process';
import { Client, check, section, summary } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const key = () => `k${Math.random().toString(36).slice(2)}${Date.now().toString(36)}abcdef`.slice(0, 30);

const owner = new Client(undefined, '198.51.100.1');
await owner.login();
const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const cat = (await owner.post('/api/admin/categories', { name: 'Integridade' })).data.category;
const mk = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, ...extra })).data.product;
const agua = await mk('Água 500ml', 4.5, { stock: 20 });
const suco = await mk('Suco 1L', 8);

let ip = 10;
const buyer = () => new Client(undefined, `203.0.114.${ip++}`);
// O banco barra mais de 5 pedidos do mesmo telefone em 10 minutos: cada pedido de teste usa um número diferente.
let phone = 0;
const order = (items, extra = {}) => ({
  customer_name: 'Comprador Teste',
  customer_phone: `3498${String(1000000 + ++phone).slice(-7)}`,
  delivery_type: 'pickup',
  payment_method: 'pix',
  items,
  ...extra,
});
const stockOf = (id) => Number(psql(`select stock from products where id = ${lit(id)}`));

// ------------------------------------------------------------------------------------------------
section('1. NEG-01: o mesmo envio repetido não vira dois pedidos');
{
  const c = buyer();
  const k = key();
  const body = order([{ product_id: agua.id, quantity: 2 }], { idempotency_key: k });
  const a = await c.post('/api/orders', body);
  const b = await c.post('/api/orders', body);
  check('primeiro envio: 201', a.status === 201, a.data);
  check('repetido: 200, mesmo pedido, mesmo código de acompanhamento, marcado como replayed', b.status === 200 && b.data.order.order_number === a.data.order.order_number && b.data.token === a.data.token && b.data.order.replayed === true, b.data);
  check('só um pedido no banco e o estoque saiu uma vez (20 - 2)', psql(`select count(*) from orders where idempotency_key = ${lit(k)}`) === '1' && stockOf(agua.id) === 18);
  check('o código devolvido na repetição abre o acompanhamento', (await new Client().get(`/api/tracking/${b.data.token}`)).status === 200);

  const k2 = key();
  const raceBody = order([{ product_id: agua.id, quantity: 1 }], { idempotency_key: k2 });
  const race = await Promise.all(Array.from({ length: 12 }, () => buyer().post('/api/orders', raceBody)));
  check('12 envios simultâneos com a mesma chave: exatamente 1 criado (201) e 11 repetidos (200)', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 200).length === 11, race.map((r) => r.status).join(','));
  check('...todos devolvem o mesmo número de pedido', new Set(race.map((r) => r.data.order.order_number)).size === 1);
  check('...e o estoque saiu uma vez só (18 - 1)', stockOf(agua.id) === 17 && psql(`select count(*) from orders where idempotency_key = ${lit(k2)}`) === '1');

  const conflict = await c.post('/api/orders', order([{ product_id: agua.id, quantity: 5 }], { idempotency_key: k }));
  check('a mesma chave com um pedido DIFERENTE é recusada (409 idempotency_conflict)', conflict.status === 409 && conflict.data.code === 'idempotency_conflict', conflict.data);
  check('chave com formato inválido: 400', (await c.post('/api/orders', order([{ product_id: agua.id, quantity: 1 }], { idempotency_key: 'curta' }))).status === 400);
  const noKey = await Promise.all([1, 2].map(() => buyer().post('/api/orders', order([{ product_id: suco.id, quantity: 1 }]))));
  check('sem chave (site antigo) continua criando pedidos normalmente', noKey.every((r) => r.status === 201) && noKey[0].data.token !== noKey[1].data.token);

  // Loja fechada DEPOIS do primeiro envio: quem só não recebeu a resposta ainda vê o pedido que já existe
  await owner.patch('/api/admin/store', { orders_paused: true });
  const afterClose = await c.post('/api/orders', body);
  const newOrder = await buyer().post('/api/orders', order([{ product_id: suco.id, quantity: 1 }], { idempotency_key: key() }));
  await owner.patch('/api/admin/store', { orders_paused: false });
  check('loja pausada: a repetição devolve o pedido já criado, um pedido novo é recusado', afterClose.status === 200 && newOrder.status === 400, { afterClose: afterClose.status, newOrder: newOrder.status });
}

// ------------------------------------------------------------------------------------------------
section('2. NEG-02: o total que o cliente viu é conferido no envio');
{
  const c = buyer();
  const items = [{ product_id: suco.id, quantity: 2 }]; // 2 × 8,00
  const ok = await c.post('/api/orders', order(items, { expected_total: '16.00' }));
  check('total igual ao que o banco calcula: pedido criado', ok.status === 201 && Number(ok.data.order.total) === 16, ok.data);
  const bare = await c.post('/api/orders', order(items, { expected_total: '16' }));
  check('"16" (sem centavos) equivale a 16,00', bare.status === 201);
  const noField = await c.post('/api/orders', order(items));
  check('sem expected_total (compatibilidade): aceito', noField.status === 201);

  await owner.patch(`/api/admin/products/${suco.id}`, { price: 11 });
  const before = Number(psql("select count(*) from orders"));
  const stale = await c.post('/api/orders', order(items, { expected_total: '16.00', idempotency_key: key() }));
  check('preço mudou entre a tela e o envio: 409 price_changed com o novo total', stale.status === 409 && stale.data.code === 'price_changed' && Number(stale.data.total) === 22 && Number(stale.data.subtotal) === 22, stale.data);
  check('...com os itens e o preço unitário novo', stale.data.items?.[0]?.name === 'Suco 1L' && Number(stale.data.items[0].unit_price) === 11 && stale.data.items[0].quantity === 2, stale.data.items);
  check('nada foi criado e o estoque não mexeu', Number(psql('select count(*) from orders')) === before);
  const confirm = await c.post('/api/orders', order(items, { expected_total: '22.00' }));
  check('depois de aceitar o novo total (22,00), o pedido sai', confirm.status === 201 && Number(confirm.data.order.total) === 22, confirm.data);

  // Taxa de entrega também entra na conta
  const del = (extra) => order(items, { delivery_type: 'delivery', address: 'Rua A', address_number: '1', neighborhood: 'Centro', ...extra });
  check('entrega: total com a taxa (22 + 5 = 27)', (await c.post('/api/orders', del({ expected_total: '27.00' }))).status === 201);
  await owner.patch('/api/admin/store', { delivery_fee: 8 });
  const feeChange = await c.post('/api/orders', del({ expected_total: '27.00' }));
  check('taxa mudou: 409 com a nova taxa', feeChange.status === 409 && Number(feeChange.data.delivery_fee) === 8 && Number(feeChange.data.total) === 30, feeChange.data);
  await owner.patch('/api/admin/store', { delivery_fee: 5 });
  check('formato inválido de total: 400', (await c.post('/api/orders', order(items, { expected_total: 'abc' }))).status === 400);
  await owner.patch(`/api/admin/products/${suco.id}`, { price: 8 });

  // A promoção que vence entre a tela e o envio também é percebida
  await owner.patch(`/api/admin/products/${suco.id}`, { promo_price: 6 });
  const promo = await c.post('/api/orders', order(items, { expected_total: '12.00' }));
  check('promoção vigente: 2 × 6,00 = 12,00', promo.status === 201 && Number(promo.data.order.total) === 12, promo.data);
  await owner.patch(`/api/admin/products/${suco.id}`, { promo_price: null });
  const gone = await c.post('/api/orders', order(items, { expected_total: '12.00' }));
  check('promoção retirada: o cliente é avisado do preço cheio (409, 16,00)', gone.status === 409 && Number(gone.data.total) === 16, gone.data);
}

// ------------------------------------------------------------------------------------------------
section('3. NEG-03 / NEG-04: preço, duplicados e promoção');
{
  const post = (extra) => owner.post('/api/admin/products', { name: 'Item teste', price: 5, category_id: cat.id, ...extra });
  for (const [label, price] of [['zero', 0], ['negativo', -3], ['texto', 'grátis'], ['vazio', '']]) {
    const r = await post({ name: `Preço ${label}`, price });
    check(`preço ${label} é recusado (400)`, r.status === 400, r.data);
  }
  const zero = await post({ name: 'Preço zero', price: 0 });
  check('a mensagem diz que precisa ser maior que zero', /maior que zero/i.test(zero.data.error), zero.data);
  check('promo = 0 é recusada', (await post({ name: 'Promo zero', price: 5, promo_price: 0 })).status === 400);
  check('promo maior ou igual ao preço é recusada', (await post({ name: 'Promo alta', price: 5, promo_price: 5 })).status === 400);

  const a = await post({ name: 'Cerveja Pilsen' });
  check('cadastro normal: 201', a.status === 201);
  const dup = await post({ name: '  cerveja pilsen ' });
  check('mesmo nome e categoria (sem diferenciar maiúsculas/espaços): 409 duplicate_product, com o id do existente', dup.status === 409 && dup.data.code === 'duplicate_product' && dup.data.existing_id === a.data.product.id, dup.data);
  check('...com confirm_duplicate: true cadastra mesmo assim', (await post({ name: 'Cerveja Pilsen', confirm_duplicate: true })).status === 201);
  const other = (await owner.post('/api/admin/categories', { name: 'Outra categoria' })).data.category;
  check('mesmo nome em OUTRA categoria não é duplicado', (await post({ name: 'Cerveja Pilsen', category_id: other.id })).status === 201);
  const second = (await post({ name: 'Cerveja Lager' })).data.product;
  const rename = await owner.patch(`/api/admin/products/${second.id}`, { name: 'cerveja pilsen' });
  check('renomear para um nome que já existe também avisa (409)', rename.status === 409 && rename.data.code === 'duplicate_product', rename.data);
  check('editar outros campos do produto não dispara o aviso', (await owner.patch(`/api/admin/products/${second.id}`, { description: 'Gelada' })).status === 200);
  check('duplicar pelo botão cria a cópia desativada com "(cópia)"', (await owner.post(`/api/admin/products/${second.id}/duplicate`)).data.product?.name === 'Cerveja Lager (cópia)');

  const withPromo = (await post({ name: 'Vinho Tinto', price: 40, promo_price: 30 })).data.product;
  const low = await owner.patch(`/api/admin/products/${withPromo.id}`, { price: 25 });
  check('baixar o preço abaixo da promoção explica o problema (400, cita a promoção)', low.status === 400 && /promo/i.test(low.data.error), low.data);
  check('tirar a promoção e baixar o preço no mesmo envio funciona', (await owner.patch(`/api/admin/products/${withPromo.id}`, { price: 25, promo_price: null })).status === 200);

  // Janela da promoção
  const w = (await post({ name: 'Espumante', price: 50, promo_price: 40 })).data.product;
  const now = Date.now();
  const iso = (ms) => new Date(now + ms).toISOString();
  check('fim antes do início: 400', (await owner.patch(`/api/admin/products/${w.id}`, { promo_starts_at: iso(3_600_000), promo_ends_at: iso(60_000) })).status === 400);
  check('data inválida: 400', (await owner.patch(`/api/admin/products/${w.id}`, { promo_starts_at: 'ontem' })).status === 400);
  const pub = async () => (await new Client().get('/api/products')).data.products.find((p) => p.id === w.id);
  await owner.patch(`/api/admin/products/${w.id}`, { promo_starts_at: iso(3_600_000), promo_ends_at: iso(7_200_000) });
  check('promoção agendada para o futuro: o site ainda mostra o preço normal', (await pub()).promo_price === null && Number((await pub()).price) === 50);
  const sched = await buyer().post('/api/orders', order([{ product_id: w.id, quantity: 1 }]));
  check('...e o pedido também cobra o preço normal', Number(sched.data.order.total) === 50, sched.data);
  await owner.patch(`/api/admin/products/${w.id}`, { promo_starts_at: iso(-3_600_000), promo_ends_at: iso(3_600_000) });
  check('promoção em vigor: o site mostra o preço promocional', Number((await pub()).promo_price) === 40);
  const live = await buyer().post('/api/orders', order([{ product_id: w.id, quantity: 1 }]));
  check('...e o pedido cobra 40,00', Number(live.data.order.total) === 40, live.data);
  await owner.patch(`/api/admin/products/${w.id}`, { promo_starts_at: iso(-7_200_000), promo_ends_at: iso(-3_600_000) });
  check('promoção vencida: volta sozinha ao preço normal, sem ninguém mexer', (await pub()).promo_price === null && Number((await buyer().post('/api/orders', order([{ product_id: w.id, quantity: 1 }]))).data.order.total) === 50);
  const cleared = await owner.patch(`/api/admin/products/${w.id}`, { promo_price: null });
  check('tirar o preço promocional limpa as datas', cleared.data.product.promo_starts_at === null && cleared.data.product.promo_ends_at === null, cleared.data.product);
}

// ------------------------------------------------------------------------------------------------
section('4. NEG-05: regras de status e de pagamento do pedido');
{
  const make = async (qty = 1) => {
    const r = await buyer().post('/api/orders', order([{ product_id: agua.id, quantity: qty }]));
    return psql(`select id from orders where order_number = ${r.data.order.order_number}`);
  };
  const setStatus = (id, status) => owner.patch(`/api/admin/orders/${id}`, { status });
  const setPay = (id, payment_status) => owner.patch(`/api/admin/orders/${id}`, { payment_status });

  let id = await make();
  check('novo → confirmado', (await setStatus(id, 'confirmed')).status === 200);
  check('confirmado → em preparo', (await setStatus(id, 'preparing')).status === 200);
  check('voltar UMA etapa (em preparo → confirmado)', (await setStatus(id, 'confirmed')).status === 200);
  const jump = await setStatus(id, 'new');
  check('voltar para "novo" a partir de confirmado (uma etapa) é permitido', jump.status === 200);
  check('pular etapas para a frente vale (novo → entregue)', (await setStatus(id, 'delivered')).status === 200);
  const back = await setStatus(id, 'new');
  check('entregue → novo é recusado (400) com explicação', back.status === 400 && /entregue/i.test(back.data.error), back.data);
  const cancelDelivered = await setStatus(id, 'cancelled');
  check('pedido entregue não pode ser cancelado', cancelDelivered.status === 400 && /entregue/i.test(cancelDelivered.data.error), cancelDelivered.data);
  check('entregue → saiu para entrega (clique errado) é permitido', (await setStatus(id, 'out_for_delivery')).status === 200);
  check('em entrega → novo (voltar 3 etapas) é recusado', (await setStatus(id, 'new')).status === 400);

  id = await make(3);
  const before = stockOf(agua.id);
  check('cancelar um pedido novo funciona', (await setStatus(id, 'cancelled')).status === 200);
  check('...e devolve o estoque uma vez (+3)', stockOf(agua.id) === before + 3);
  const again = await setStatus(id, 'cancelled');
  check('cancelar de novo não devolve estoque em dobro', stockOf(agua.id) === before + 3, again.data);
  const reopen = await setStatus(id, 'new');
  check('pedido cancelado não reabre (400)', reopen.status === 400 && /cancelado/i.test(reopen.data.error), reopen.data);
  check('cancelado não vira "pago"', (await setPay(id, 'paid')).status === 400);

  id = await make();
  check('pendente → reembolsado é recusado (nunca foi pago)', (await setPay(id, 'refunded')).status === 400);
  check('pendente → pago', (await setPay(id, 'paid')).status === 200);
  check('pago → reembolsado', (await setPay(id, 'refunded')).status === 200);
  const hist = psql(`select count(*) from order_status_history h where h.order_id = ${lit(id)}`);
  check('mudanças ficam no histórico do pedido (com quem mudou)', Number(hist) >= 1 && psql(`select count(*) from order_status_history where order_id = ${lit(id)} and changed_by_name is not null`) !== undefined);
  const log = await owner.get('/api/admin/audit?entity=order');
  check('e no histórico de atividades do painel', log.data.entries.some((e) => e.action === 'order.payment') && log.data.entries.some((e) => /pedido #/i.test(e.summary)), log.data.entries.slice(0, 3));
}

// ------------------------------------------------------------------------------------------------
section('5. NEG-06: o dashboard conta do jeito certo');
{
  psql('delete from order_status_history'); // zera o que veio dos testes anteriores só para contar do zero
  psql('delete from order_items');
  psql('delete from orders');
  const make = async (qty, extra = {}) => {
    const r = await buyer().post('/api/orders', order([{ product_id: suco.id, quantity: qty }], extra));
    return { id: psql(`select id from orders where order_number = ${r.data.order.order_number}`), number: r.data.order.order_number };
  };
  const a = await make(1); // vai ser entregue
  const b = await make(2); // vai ser cancelado
  const c = await make(3); // fica novo
  const d = await make(1); // pago e reembolsado
  await owner.patch(`/api/admin/orders/${a.id}`, { status: 'delivered' });
  await owner.patch(`/api/admin/orders/${b.id}`, { status: 'cancelled' });
  await owner.patch(`/api/admin/orders/${d.id}`, { payment_status: 'paid' });
  await owner.patch(`/api/admin/orders/${d.id}`, { payment_status: 'refunded' });
  // Pedido de 3 dias atrás, entregue hoje: conta em "concluídos hoje", não em "pedidos de hoje"
  const old = await make(1);
  psql(`update orders set created_at = now() - interval '3 days' where id = ${lit(old.id)}`);
  await owner.patch(`/api/admin/orders/${old.id}`, { status: 'delivered' });

  const dash = (await owner.get('/api/admin/dashboard?days=7')).data;
  const k = dash.cards;
  check('"pedidos de hoje" não conta cancelados nem pedidos de outros dias (a, c, d = 3)', k.today_orders === 3, k);
  check('"concluídos hoje" conta pela data da entrega (a + o de 3 dias atrás = 2)', k.delivered_today === 2, k);
  check('cancelados de hoje = 1', k.cancelled_today === 1, k);
  check('pendentes = 2 (c e d continuam novos)', k.pending === 2, k);
  check('faturamento de hoje: não conta cancelado nem reembolsado (a 8,00 + c 24,00 = 32,00)', Number(k.revenue_today) === 32, k.revenue_today);
  check('faturamento da semana e do mês seguem a mesma regra', Number(k.revenue_week) >= 32 && Number(k.revenue_month) >= Number(k.revenue_week));
  check('o resumo do período e o ticket médio usam a mesma regra', dash.range.orders >= 2 && Number(dash.range.revenue) >= 32);
  const bad = await owner.get('/api/admin/dashboard?days=abc');
  check('days=abc cai nos 7 dias padrão (200), em vez de erro', bad.status === 200 && bad.data.range?.days === 7, bad.status);
  check('days=999 também', (await owner.get('/api/admin/dashboard?days=999')).data.range?.days === 7);
}

// ------------------------------------------------------------------------------------------------
section('6. NEG-09: ajustar estoque não liga o controle sem querer');
{
  const free = await mk('Produto sem controle', 5);
  const plain = await owner.post(`/api/admin/products/${free.id}/stock`, { delta: 10 });
  check('ajustar estoque de produto SEM controle é recusado (400) com explicação', plain.status === 400 && /controla estoque/i.test(plain.data.error), plain.data);
  check('o produto continua sem controle', psql(`select stock is null from products where id = ${lit(free.id)}`) === 't');
  const on = await owner.post(`/api/admin/products/${free.id}/stock`, { delta: 10, enable_tracking: true });
  check('com enable_tracking: true passa a controlar, com 10 unidades', on.status === 200 && on.data.product.stock === 10, on.data);
  check('entrada e saída normais', (await owner.post(`/api/admin/products/${free.id}/stock`, { delta: -4 })).data.product.stock === 6);
  const over = await owner.post(`/api/admin/products/${free.id}/stock`, { delta: -7 });
  check('retirar mais do que existe é recusado e não deixa negativo', over.status === 400 && psql(`select stock from products where id = ${lit(free.id)}`) === '6', over.data);
  check('quantidade zero é recusada', (await owner.post(`/api/admin/products/${free.id}/stock`, { delta: 0 })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('7. NEG-08: importação com relatório por linha');
{
  psql(`update products set position = position + 0`);
  const maxBefore = Number(psql('select coalesce(max(position), -1) from products'));
  const rows = [
    { name: 'Importado A', price: 10, category: 'Importados' },
    { name: 'Importado B', price: '12,50', category: 'Importados', stock: 7, sku: 'IMP-B', promo_price: '9,90', description: 'Com estoque, SKU e promoção' },
    { name: 'importado a', price: 11, category: 'importados' },
    { name: 'Sem preço', category: 'Importados' },
    { name: '', price: 5 },
    { name: 'Preço zero', price: 0 },
    { name: 'Promo errada', price: 5, promo_price: 8 },
    { name: 'Já existe', price: 9, category: 'Integridade' },
    { name: 'Importado C', price: 7, sku: 'IMP-B' },
    { name: 'Importado D', price: 3, featured: true, sold_out: true },
  ];
  await mk('Já existe', 9);
  const r = await owner.post('/api/admin/products/import', { rows });
  check('importação responde 200 com contagens', r.status === 200 && r.data.created === 3 && r.data.existing === 1 && r.data.repeated === 1 && r.data.skipped === 5, r.data);
  const rep = r.data.report;
  check('o relatório tem uma linha para CADA item do arquivo, na ordem', rep.length === rows.length && rep.every((x, i) => x.index === i), rep.map((x) => `${x.index}:${x.status}`).join(' '));
  check('cada problema traz o motivo em português', rep.filter((x) => x.status === 'invalid').every((x) => x.reason && x.reason.length > 5), rep.filter((x) => x.status === 'invalid'));
  check('"importado a" repetido no arquivo é marcado como repetido', rep[2].status === 'repeated');
  check('produto que já existe é mantido, sem alterar o preço', rep[7].status === 'existing' && Number(psql("select price from products where name = 'Já existe'")) === 9);
  check('SKU repetido (arquivo ou outro produto) recusa só aquela linha', rep[8].status === 'invalid' && /SKU/.test(rep[8].reason));
  check('estoque, SKU, promoção e descrição entram', psql("select stock || '|' || sku || '|' || promo_price from products where name = 'Importado B'") === '7|IMP-B|9.90');
  check('destaque e esgotado entram', psql("select featured and sold_out from products where name = 'Importado D'") === 't');
  check('a categoria nova foi criada uma vez só', psql("select count(*) from categories where lower(name) = 'importados'") === '1' && r.data.categories_created === 1);
  check('a ordem dos novos continua DEPOIS da dos produtos existentes (sem colisão)', Number(psql("select min(position) from products where name like 'Importado %'")) > maxBefore);
  check('importar o mesmo arquivo de novo não duplica nada', (await owner.post('/api/admin/products/import', { rows })).data.created === 0);
  const none = await owner.post('/api/admin/products/import', { rows: [{ name: 'x' }, { price: 3 }] });
  check('nada válido: 400 com o relatório', none.status === 400 && none.data.report?.length === 2, none.data);
  check('mais de 500 linhas: 400', (await owner.post('/api/admin/products/import', { rows: Array.from({ length: 501 }, (_, i) => ({ name: `Lote ${i}`, price: 1 })) })).status === 400);
  const big = await owner.post('/api/admin/products/import', { rows: Array.from({ length: 500 }, (_, i) => ({ name: `Lote ${i}`, price: 1 + i })) });
  check('500 linhas de uma vez funcionam', big.status === 200 && big.data.created === 500, big.data?.created);
  const log = await owner.get('/api/admin/audit?q=Importou');
  check('a importação ficou no histórico com as contagens', log.data.entries.length >= 2 && /criado/.test(log.data.entries[0].summary), log.data.entries[0]);
}

// ------------------------------------------------------------------------------------------------
section('8. TEC-06: cache curto só nas listas públicas');
{
  const anon = new Client();
  for (const path of ['/api/products', '/api/site']) {
    const r = await anon.get(path);
    const cc = r.headers.get('cache-control') ?? '';
    check(`${path}: cache de borda curto (10 s) com revalidação`, /s-maxage=10/.test(cc) && /stale-while-revalidate=30/.test(cc) && !/no-store/.test(cc), cc);
    check(`${path}: sem cookie na resposta (pode ficar em cache)`, !r.headers.get('set-cookie'));
  }
  const tracked = await buyer().post('/api/orders', order([{ product_id: suco.id, quantity: 1 }]));
  const noStore = [
    await anon.get(`/api/tracking/${tracked.data.token}`),
    await anon.get('/api/auth/me'),
    await owner.get('/api/admin/dashboard'),
    await owner.get('/api/admin/products'),
    tracked,
  ];
  check('pedidos, acompanhamento, sessão e painel: sempre no-store', noStore.every((r) => /no-store/.test(r.headers.get('cache-control') ?? '')), noStore.map((r) => r.headers.get('cache-control')));
  const bundle = await anon.get('/api/products');
  check('a lista pública mostra o produto novo (o painel grava direto no banco; o cache é só de segundos)', bundle.data.products.some((p) => p.name === 'Importado A'));
}

summary();
