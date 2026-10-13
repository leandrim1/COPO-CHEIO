// Troca do energético dos combos (migration 0017): o preço da troca (combo + diferença) é calculado pelo banco e nunca fica abaixo do combo,
// só energéticos de 2L entram, o estoque do energético novo sai e volta, tudo vale mesmo numa requisição feita direto à API.
// usage: bash tests/fresh.sh && node tests/api-test16.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';
import { load } from './unit/load.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', [...P, '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const root = new URL('..', import.meta.url).pathname;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const combo = await load('src/lib/combo.ts');

// ------------------------------------------------------------------------------------------------
section('1. Banco de produção antes da mudança: a migration 0017 só acrescenta e já liga cada combo ao energético que vem nele');
{
  const db = 'legacy17_a';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover', '0008_store_whatsapp', '0009_security_foundations', '0010_promo_window', '0011_orders_integrity', '0012_privacy', '0013_ice_choice', '0014_online_payments', '0015_merchant_account_flow', '0016_commission_2_percent'];
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const migrate = () => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  const q = (sql) => psql(sql, db);

  q(`insert into categories (name, position) values ('Combos', 0), ('Energéticos', 1), ('Cervejas', 2), ('Copão com Energético 2L Jack Power', 3)`);
  const cat = (name) => q(`select id from categories where name = ${lit(name)}`);
  const mkp = (name, price, category) => q(`insert into products (name, price, category_id) values (${lit(name)}, ${price}, ${lit(cat(category))}) returning id`);
  const jack = mkp('Energético Jack Power 2L', 12, 'Energéticos');
  const fusion = mkp('ENERGÉTICO FUSION 2 LITROS', 13, 'Energéticos');
  const tropical = mkp('Jack Power Tropical 2L', 14, 'Energéticos');
  mkp('Energético Monster 473ml', 9.5, 'Energéticos');
  const busca = mkp('COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L )', 90, 'Combos');
  const fus = mkp('COMBO FUSION ( 4 gelos, 1 Energético Fusion 2 Litros )', 80, 'Combos');
  const whisky = mkp('COMBO WHISKY ( 4 gelos, 1 Whisky )', 120, 'Combos');
  const jt = mkp('COMBO JACK TROPICAL ( 1 Jack Power Tropical 2L )', 95, 'Combos');
  const kit = mkp('Kit festa ( Energético Jack Power 2L )', 40, 'Cervejas');
  const copao = mkp('Copão com Energético Jack Power 2L', 30, 'Copão com Energético 2L Jack Power');
  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  const oldOrder = JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Antigo', customer_phone: '34990000001', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: busca, quantity: 2 }] }))}::jsonb)`));
  check('antes: o combo é pedido normalmente', oldOrder.order_number >= 1001 && oldOrder.total === 180, oldOrder);

  const out = migrate();
  check('migrate.mjs aplica só a 0017', /aplicada: 0017_energetic_swap/.test(out) && !/aplicada: 00(0|1[0-6])/.test(out), out);
  const base = (id) => q(`select coalesce(swap_base_product_id::text, 'nenhum') from products where id = ${lit(id)}`);
  check('combo que cita "Energético Jack Power 2L" ganha o Jack Power 2L', base(busca) === jack, base(busca));
  check('combo que cita "Energético Fusion 2 Litros" ganha o Fusion (maiúsculas e "2 Litros" não atrapalham)', base(fus) === fusion, base(fus));
  check('combo que cita "Jack Power Tropical 2L" ganha o Tropical (nome mais completo vence o Jack Power)', base(jt) === tropical, base(jt));
  check('combo sem energético no nome fica SEM energético definido (não aceita troca até o painel preencher)', base(whisky) === 'nenhum');
  check('produto de outra categoria que cita o energético NÃO é ligado (só os da categoria Combos)', base(kit) === 'nenhum' && base(copao) === 'nenhum');
  check('os energéticos em si e o resto do cardápio não foram tocados', Number(q('select count(*) from products where swap_base_product_id is not null')) === 3, q('select count(*) from products where swap_base_product_id is not null'));
  check('o pedido que já existia continua igual (itens, preço, total) e sem troca', q('select string_agg(quantity || \'x \' || product_name || \' \' || unit_price, \',\') from order_items') === '2x COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L ) 90.00' && q('select count(*) from order_items where swap_to_product_id is not null') === '0');
  const old = JSON.parse(q(`select order_json(id, true) from orders`));
  check('...e o pedido antigo, como o cliente vê, não ganha campo de troca', old.items.length === 1 && !('swap_to_product_id' in old.items[0]), old.items);
  const plain = JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Novo', customer_phone: '34990000002', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: busca, quantity: 1 }, { product_id: kit, quantity: 1 }] }))}::jsonb)`));
  check('depois: pedido sem troca se comporta como antes (90 + 40 = 130)', plain.total === 130 && plain.items.length === 2, plain);

  // O painel manda: o que ele grava não é desfeito, e a migration não roda de novo.
  q(`update products set swap_base_product_id = ${lit(fusion)} where id = ${lit(busca)}`);
  const again = migrate();
  check('rodar de novo não faz nada e não desfaz o que o painel mudou', /Banco já está atualizado/.test(again) && base(busca) === fusion, again);
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('2. As regras do banco batem com as do site (src/lib/combo.ts)');
{
  const names = [
    ['Energético Jack Power 2L', 'ENERGÉTICOS'], ['Energético Fusion 2 L', 'Energéticos'], ['Energético Baly 2 Litros', 'Outros'], ['Energético Tropical 2lts', 'Cervejas'],
    ['Energético Monster 2000ml', 'Energéticos'], ['2L Energético Teste', 'Energéticos'], ['Jack Power 2L', 'Energéticos'], ['Jack Power 2L', 'Outros'],
    ['Energético Monster 473ml', 'ENERGÉTICOS'], ['Energético Red Bull 250ml', 'Energéticos'], ['Energético Gigante 2,5L', 'Energéticos'], ['Refrigerante Guaraná 2L', 'REFRIGERANTE 2L E 2,5L'],
    ['Copão com Energético Jack Power 2L', 'COPÃO COM ENERGÉTICO 2L JACK POWER'], ['COMBO ( 1 Energético Jack Power 2L )', 'COMBOS'], ['Energético 12L', 'Energéticos'], ['Energético 1,2L', 'Energéticos'],
    ['Energético 20L', 'Energéticos'], ['Energético 2 latas', 'Energéticos'], ['ENERGÉTICO JACK POWER 2L', 'energeticos'], ['Energetico Jack Power 2l', 'ENERGETICOS'],
    ['Energéticos Variados 2L', 'Outros'], ['Sem energético 2L', 'Energéticos 2L'], ['Água 2L', 'Energéticos'],
  ];
  const sql = (n, c) => psql(`select is_energetic_2l(${lit(n)}, ${lit(c)})`) === 't';
  const diff = names.filter(([n, c]) => sql(n, c) !== combo.isEnergetico2L({ name: n, category: c }));
  check(`as ${names.length} combinações de nome e categoria dão o mesmo resultado no banco e no site`, diff.length === 0, diff);
  const cats = ['Combos', 'COMBOS', ' combo ', 'Combos de cerveja', 'Meu combo', 'cÓmbos', 'Cervejas', ''];
  const diffC = cats.filter((c) => (psql(`select is_combo_category(${lit(c)})`) === 't') !== (combo.comboNote(c) !== null));
  check('"é combo?" também bate entre o banco e o site', diffC.length === 0, diffC);
}

// ------------------------------------------------------------------------------------------------
section('3. Painel e site: o energético que vem no combo');
const owner = new Client(undefined, '198.51.100.16');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client();
const mkCat = async (name, extra = {}) => (await owner.post('/api/admin/categories', { name, ...extra })).data.category;
const catCombos = await mkCat('COMBOS');
const catEnergy = await mkCat('ENERGÉTICOS');
const catBeer = await mkCat('Cervejas');
const catSoda = await mkCat('REFRIGERANTE 2L E 2,5L');
const catCopao = await mkCat('COPÃO COM ENERGÉTICO 2L JACK POWER');
const mk = async (name, price, category, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: category?.id ?? null, confirm_duplicate: true, ...extra })).data.product;
const jack = await mk('Energético Jack Power 2L', 12, catEnergy, { stock: 50 });
const tropical = await mk('Energético Tropical 2L', 14, catEnergy, { stock: 300 });
const baly = await mk('Energético Baly 2 Litros', 10, catEnergy, { stock: 30 });
const fusion = await mk('Energético Fusion 2L', 13, catEnergy, { sold_out: true });
const monster = await mk('Energético Monster 473ml', 9.5, catEnergy, { stock: 30 });
const gigante = await mk('Energético Gigante 2,5L', 15, catEnergy, { stock: 30 });
const soda = await mk('Refrigerante Guaraná 2L', 9, catSoda, { stock: 30 });
const copaoEn = await mk('Copão com Energético Jack Power 2L', 30, catCopao, { stock: 30 });
const c1 = await mk('COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L )', 90, catCombos, { stock: 40 });
const c2 = await mk('COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L )', 50, catCombos, { stock: 40 });
const c3 = await mk('COMBO SEM ENERGÉTICO ( 4 gelos, 1 Vodka )', 60, catCombos, { stock: 40 });
const beer = await mk('Heineken', 8, catBeer, { stock: 100 });
const inactive = await mk('Energético Inativo 2L', 12, catEnergy, { active: false, stock: 10 });
{
  check('produto novo nasce sem energético definido (não aceita troca)', c1.swap_base_product_id === null, c1);
  const set1 = await owner.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: jack.id });
  const set2 = await owner.patch(`/api/admin/products/${c2.id}`, { swap_base_product_id: jack.id });
  check('o painel define o energético do combo', set1.status === 200 && set1.data.product.swap_base_product_id === jack.id && set2.status === 200, set1.data);
  const self = await owner.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: c1.id });
  check('o combo não pode ser o próprio energético (400)', self.status === 400 && self.data.code === 'swap_base_self', self.data);
  const ghost = await owner.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: '00000000-0000-4000-8000-000000000000' });
  check('produto que não existe (400, em português)', ghost.status === 400 && /não encontrado/.test(ghost.data.error), ghost.data);
  check('valor que não é um id (400)', (await owner.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: 'abc' })).status === 400 && (await owner.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: 5 })).status === 400);
  check('sem login não muda (401)', (await anon.patch(`/api/admin/products/${c1.id}`, { swap_base_product_id: baly.id })).status === 401);
  const pub = (await anon.get('/api/products')).data.products;
  check('o site recebe o energético de cada produto (/api/products)', pub.find((p) => p.id === c1.id).swap_base_product_id === jack.id && pub.find((p) => p.id === c3.id).swap_base_product_id === null);
  const log = (await owner.get('/api/admin/audit?entity=product&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('a mudança fica no histórico de atividades', /energético que vem no combo/.test(log), log);
  const dup = await owner.post(`/api/admin/products/${c1.id}/duplicate`);
  check('duplicar o combo leva o energético junto', dup.status === 201 && dup.data.product.swap_base_product_id === jack.id, dup.data);
  await owner.del(`/api/admin/products/${dup.data.product.id}`);
  const clear = await owner.patch(`/api/admin/products/${c3.id}`, { swap_base_product_id: null });
  check('dá para limpar (null)', clear.status === 200 && clear.data.product.swap_base_product_id === null);
}

// ------------------------------------------------------------------------------------------------
let ip = 40;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const order = (items, extra = {}) => ({ customer_name: 'Comprador Troca', customer_phone: `3498${String(1000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items, ...extra });
const stockOf = (id) => psql(`select coalesce(stock::text, 'null') from products where id = ${lit(id)}`);
const ordersCount = () => Number(psql('select count(*) from orders'));
const lines = (number) => psql(`select coalesce(string_agg(i.quantity || ':' || i.unit_price || ':' || i.product_name, ' | ' order by i.unit_price, i.product_name), '') from order_items i join orders o on o.id = i.order_id where o.order_number = ${number}`);
const snap = () => ({ orders: ordersCount(), c1: stockOf(c1.id), jack: stockOf(jack.id), tropical: stockOf(tropical.id), baly: stockOf(baly.id) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

section('4. O preço da troca é o combo + a diferença, calculado pelo banco');
let made;
{
  const s0 = snap();
  const r = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }, { product_id: c1.id, quantity: 1 }]));
  check('um combo trocado + um combo normal: 201', r.status === 201, r.data);
  made = r.data.order;
  const [swapped] = made.items.filter((i) => /troca/.test(i.product_name));
  check('combo trocado por Tropical (R$ 14) no lugar do Jack Power (R$ 12): paga + R$ 2,00 → R$ 92,00', swapped?.unit_price === 92 && swapped.total_price === 92, made.items);
  check('a linha diz o que foi trocado e a diferença', swapped.product_name === 'COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L ) — troca do energético por Energético Tropical 2L (+ R$ 2,00)', swapped.product_name);
  check('o combo normal continua R$ 90,00 e o subtotal soma as duas linhas (182)', made.items.some((i) => i.unit_price === 90 && !/troca/.test(i.product_name)) && made.subtotal === 182 && made.total === 182, made);
  check('estoque: combo saiu 2 (as duas linhas), Tropical saiu 1 (o da troca), Jack Power não mexeu', Number(stockOf(c1.id)) === Number(s0.c1) - 2 && Number(stockOf(tropical.id)) === Number(s0.tropical) - 1 && stockOf(jack.id) === s0.jack, snap());
  check('gravado no item: o energético da troca', psql(`select count(*) from order_items i join orders o on o.id = i.order_id where o.order_number = ${made.order_number} and i.swap_to_product_id = ${lit(tropical.id)}`) === '1');

  // Mais barato: sem devolução, sem desconto
  const cheap = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 2, swap_to: baly.id }]));
  const ci = cheap.data.order?.items?.[0];
  check('trocar por um energético MAIS BARATO (Baly R$ 10 < Jack R$ 12): o preço do combo não cai (R$ 90,00 × 2) e diz "sem diferença"', cheap.status === 201 && ci.unit_price === 90 && ci.quantity === 2 && /troca do energético por Energético Baly 2 Litros \(sem diferença\)/.test(ci.product_name) && cheap.data.order.subtotal === 180, cheap.data);

  // Quantidades e energéticos diferentes na mesma linha de produto
  const multi = await buyer().post('/api/orders', order([{ product_id: c2.id, quantity: 3, swap_to: tropical.id }, { product_id: c2.id, quantity: 1, swap_to: baly.id }, { product_id: c2.id, quantity: 2 }, { product_id: beer.id, quantity: 2 }]));
  check('3 trocados por Tropical (+R$ 2 cada) + 1 por Baly (sem diferença) + 2 normais + 2 cervejas: 3 × 52 + 50 + 2 × 50 + 2 × 8 = 322', multi.status === 201 && multi.data.order.subtotal === 322, multi.data);
  check('cada combinação (combo + energético) vira uma linha própria, com a sua quantidade', lines(multi.data.order.order_number) === '2:8.00:Heineken | 2:50.00:COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L ) | 1:50.00:COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L ) — troca do energético por Energético Baly 2 Litros (sem diferença) | 3:52.00:COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L ) — troca do energético por Energético Tropical 2L (+ R$ 2,00)', lines(multi.data.order.order_number));
  check('a mesma troca repetida no envio soma numa linha só', lines((await buyer().post('/api/orders', order([{ product_id: c2.id, quantity: 1, swap_to: tropical.id }, { product_id: c2.id, quantity: 2, swap_to: tropical.id }]))).data.order.order_number).startsWith('3:52.00:'));

  // Nunca abaixo do combo sem troca
  check('em TODAS as linhas trocadas até aqui, o preço é igual ou maior que o do combo sem troca', psql(`select bool_and(i.unit_price >= p.price) from order_items i join products p on p.id = i.product_id where i.swap_to_product_id is not null`) === 't');
}

// ------------------------------------------------------------------------------------------------
section('5. Promoções valem para os dois energéticos; a troca acompanha o preço de agora');
{
  await owner.patch(`/api/admin/products/${jack.id}`, { promo_price: 11 });
  const a = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }]));
  check('Jack Power em promoção (R$ 11): a diferença para o Tropical (R$ 14) passa a ser R$ 3,00 → R$ 93,00', a.status === 201 && a.data.order.items[0].unit_price === 93 && /\(\+ R\$ 3,00\)/.test(a.data.order.items[0].product_name), a.data);
  await owner.patch(`/api/admin/products/${tropical.id}`, { promo_price: 12.5 });
  const b = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }]));
  check('Tropical também em promoção (R$ 12,50): diferença R$ 1,50 → R$ 91,50', b.data.order.items[0].unit_price === 91.5, b.data);
  await owner.patch(`/api/admin/products/${tropical.id}`, { promo_price: null });
  await owner.patch(`/api/admin/products/${jack.id}`, { promo_price: null });
  // Promoção do próprio combo
  await owner.patch(`/api/admin/products/${c1.id}`, { promo_price: 80 });
  const c = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }]));
  check('combo em promoção (R$ 80): vale o preço de agora + a diferença (R$ 2) = R$ 82,00', c.data.order.items[0].unit_price === 82, c.data);
  await owner.patch(`/api/admin/products/${c1.id}`, { promo_price: null });
}

// ------------------------------------------------------------------------------------------------
section('6. Recusas: nada é criado e nenhum estoque mexe (nem numa requisição feita direto à API)');
{
  const s0 = snap();
  const bad = async (name, item, pattern, status = 400) => {
    const r = await buyer().post('/api/orders', order([item]));
    check(`${name}`, r.status === status && pattern.test(r.data.error ?? ''), r.data);
  };
  await bad('combo sem energético definido não aceita troca', { product_id: c3.id, quantity: 1, swap_to: tropical.id }, /não aceita troca/);
  await bad('produto que não é combo (cerveja) não aceita troca', { product_id: beer.id, quantity: 1, swap_to: tropical.id }, /não aceita troca/);
  await bad('trocar pelo próprio energético que já vem no combo', { product_id: c1.id, quantity: 1, swap_to: jack.id }, /diferente do que já vem/);
  await bad('energético de 473 ml não vale (só 2L)', { product_id: c1.id, quantity: 1, swap_to: monster.id }, /energético de 2L/);
  await bad('energético de 2,5L não vale (só 2L)', { product_id: c1.id, quantity: 1, swap_to: gigante.id }, /energético de 2L/);
  await bad('refrigerante de 2L não vale (não é energético)', { product_id: c1.id, quantity: 1, swap_to: soda.id }, /energético de 2L/);
  await bad('copão com energético não vale', { product_id: c1.id, quantity: 1, swap_to: copaoEn.id }, /energético de 2L/);
  await bad('outro combo não vale como energético', { product_id: c1.id, quantity: 1, swap_to: c2.id }, /energético de 2L/);
  await bad('energético esgotado', { product_id: c1.id, quantity: 1, swap_to: fusion.id }, /esgotado/);
  await bad('energético desativado', { product_id: c1.id, quantity: 1, swap_to: inactive.id }, /não está mais disponível/);
  await bad('energético que não existe', { product_id: c1.id, quantity: 1, swap_to: '00000000-0000-4000-8000-000000000000' }, /não está mais disponível/);
  await bad('swap_to que não é um id', { product_id: c1.id, quantity: 1, swap_to: 'abc' }, /itens do pedido são inválidos/);
  await bad('swap_to número', { product_id: c1.id, quantity: 1, swap_to: 5 }, /itens do pedido são inválidos/);
  await bad('swap_to objeto', { product_id: c1.id, quantity: 1, swap_to: { id: tropical.id } }, /itens do pedido são inválidos/);
  await bad('swap_to lista', { product_id: c1.id, quantity: 1, swap_to: [tropical.id] }, /itens do pedido são inválidos/);
  const scarce = await mk('Energético Raro 2L', 20, catEnergy, { stock: 2 });
  await bad('estoque do energético da troca insuficiente (pede 3, há 2)', { product_id: c1.id, quantity: 3, swap_to: scarce.id }, /Temos só 2 unidade\(s\) de Energético Raro 2L/);
  // Categoria do energético desativada
  await owner.patch(`/api/admin/categories/${catEnergy.id}`, { name: 'ENERGÉTICOS', active: false });
  await bad('categoria do energético desativada', { product_id: c1.id, quantity: 1, swap_to: tropical.id }, /não está mais disponível/);
  await owner.patch(`/api/admin/categories/${catEnergy.id}`, { name: 'ENERGÉTICOS', active: true });
  check('nada foi criado e nenhum estoque mexeu em todas essas recusas', same(snap(), s0) && stockOf(scarce.id) === '2', [snap(), s0, stockOf(scarce.id)]);
  // Nomes escritos de outro jeito (campo inventado) são ignorados: o preço continua sendo o do combo, sem troca nenhuma
  const ignored = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap: tropical.id, swapTo: tropical.id, unit_price: 1 }]));
  check('campos inventados (swap, swapTo, unit_price) são ignorados: sem troca, preço do combo', ignored.status === 201 && ignored.data.order.items[0].unit_price === 90 && !/troca/.test(ignored.data.order.items[0].product_name), ignored.data);
}

// ------------------------------------------------------------------------------------------------
section('7. Total conferido, envio repetido e preço mudado com troca');
{
  const c = buyer();
  const key = `troca${Math.random().toString(36).slice(2)}abcdefghijkl`.slice(0, 28);
  const body = order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }], { idempotency_key: key, expected_total: '92.00' });
  const s0 = snap();
  const a = await c.post('/api/orders', body);
  check('total certo (R$ 92,00 com a troca): 201', a.status === 201 && a.data.order.total === 92, a.data);
  const again = await c.post('/api/orders', body);
  check('repetir o mesmo envio devolve o mesmo pedido, sem baixar o estoque de novo', again.status === 200 && again.data.order.order_number === a.data.order.order_number && Number(stockOf(tropical.id)) === Number(s0.tropical) - 1 && Number(stockOf(c1.id)) === Number(s0.c1) - 1, again.data);
  const other = await c.post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: baly.id }], { idempotency_key: key }));
  check('a mesma chave com outra troca: conflito (409), nada novo', other.status === 409 && other.data.code === 'idempotency_conflict', other.data);

  // O total que o cliente viu não bate (ele achava que era sem troca): 409 com o valor de agora
  const s1 = snap();
  const stale = await buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: tropical.id }], { expected_total: '90.00' }));
  check('total visto errado: 409 "price_changed" com o total de agora e a troca na lista', stale.status === 409 && stale.data.code === 'price_changed' && stale.data.total === 92 && stale.data.items[0].swap_to === tropical.id && stale.data.items[0].unit_price === 92, stale.data);
  check('...e nada foi criado nem reservado', same(snap(), s1));
}

// ------------------------------------------------------------------------------------------------
section('8. Conta, acompanhamento e painel mostram a troca; "pedir de novo" recebe o energético');
{
  const ana = new Client(undefined, '203.0.113.201');
  await registerVerified(ana, { name: 'Ana Troca', email: 'ana.troca@exemplo.com', phone: '34 95555-0016', password: 'ana-troca-senha-123' });
  const mine = await ana.post('/api/orders', order([{ product_id: c1.id, quantity: 2, swap_to: tropical.id }, { product_id: c1.id, quantity: 1 }]));
  check('pedido logado com troca: 201', mine.status === 201, mine.data);
  const n = mine.data.order.order_number;
  const det = (await ana.get(`/api/account/orders/${n}`)).data.order;
  const sw = det.items.find((i) => /troca/.test(i.product_name));
  check('conta: a linha trocada traz o id do energético escolhido e o id do combo (para "pedir de novo")', sw?.swap_to_product_id === tropical.id && sw.product_id === c1.id && !('swap_to_product_id' in det.items.find((i) => !/troca/.test(i.product_name))), det.items);
  const list = (await ana.get('/api/account/orders')).data.orders.find((o) => o.order_number === n);
  check('conta: o resumo da lista mostra o nome com a troca', /2x COMBO BUSCA BRISA .* — troca do energético por Energético Tropical 2L \(\+ R\$ 2,00\)/.test(list.summary), list.summary);
  const adm = (await owner.get(`/api/admin/orders/${n}`)).data;
  check('painel: o pedido lista a linha trocada com o preço e a quantidade', adm.items.some((i) => /troca do energético por Energético Tropical 2L/.test(i.product_name) && Number(i.unit_price) === 92 && i.quantity === 2), adm.items);
  const track = await anon.get(`/api/tracking/${mine.data.token}`);
  check('acompanhamento pelo código: o cliente vê a troca e a diferença', track.status === 200 && track.data.order.items.some((i) => /troca do energético por Energético Tropical 2L \(\+ R\$ 2,00\)/.test(i.product_name)), track.data);
  check('o total do pedido soma tudo (2 × 92 + 90 = 274)', det.total === 274 && det.subtotal === 274, det);
}

// ------------------------------------------------------------------------------------------------
section('9. Cancelar devolve o estoque do combo e do energético da troca');
{
  const c = buyer();
  const s0 = snap();
  const r = await c.post('/api/orders', order([{ product_id: c1.id, quantity: 3, swap_to: tropical.id }, { product_id: c1.id, quantity: 1, swap_to: baly.id }, { product_id: c1.id, quantity: 2 }]));
  const s1 = snap();
  check('o pedido baixou: combo 6, Tropical 3, Baly 1', r.status === 201 && Number(s1.c1) === Number(s0.c1) - 6 && Number(s1.tropical) === Number(s0.tropical) - 3 && Number(s1.baly) === Number(s0.baly) - 1, [s0, s1]);
  const id = (await owner.get(`/api/admin/orders/${r.data.order.order_number}`)).data.order.id;
  const cancelled = await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled' });
  check('cancelar devolve tudo: combo, Tropical e Baly voltam ao que eram', cancelled.status === 200 && same({ c1: stockOf(c1.id), tropical: stockOf(tropical.id), baly: stockOf(baly.id) }, { c1: s0.c1, tropical: s0.tropical, baly: s0.baly }), [snap(), s0]);
  const again = await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled' });
  check('cancelar de novo não devolve em dobro', again.status === 200 && stockOf(tropical.id) === s0.tropical && stockOf(c1.id) === s0.c1);
}

// ------------------------------------------------------------------------------------------------
section('10. Concorrência: o estoque do energético da troca não passa de zero e não há impasse');
{
  const limited = await mk('Energético Limitado 2L', 15, catEnergy, { stock: 3 });
  const s0 = Number(stockOf(c1.id));
  const results = await Promise.all(Array.from({ length: 6 }, () => buyer().post('/api/orders', order([{ product_id: c1.id, quantity: 1, swap_to: limited.id }]))));
  const ok = results.filter((r) => r.status === 201).length;
  const refused = results.filter((r) => r.status === 400 && /Temos só|esgotado/.test(r.data.error)).length;
  check('6 pedidos ao mesmo tempo para um energético com 3 em estoque: 3 entram, 3 são recusados, nenhum erro 500', ok === 3 && refused === 3, results.map((r) => r.status));
  check('o estoque do energético fica em 0 (esgotado) e o do combo caiu só os 3 pedidos que entraram', stockOf(limited.id) === '0' && Number(stockOf(c1.id)) === s0 - 3, [stockOf(limited.id), stockOf(c1.id), s0]);
  // Pedidos que misturam os mesmos produtos em ordens diferentes (risco de impasse): todos terminam
  const mix = await Promise.all(
    Array.from({ length: 12 }, (_v, i) =>
      buyer().post('/api/orders', order(i % 2 ? [{ product_id: c1.id, quantity: 1, swap_to: tropical.id }, { product_id: tropical.id, quantity: 1 }, { product_id: c2.id, quantity: 1, swap_to: baly.id }] : [{ product_id: baly.id, quantity: 1 }, { product_id: c2.id, quantity: 1, swap_to: baly.id }, { product_id: c1.id, quantity: 1, swap_to: tropical.id }])),
    ),
  );
  check('12 pedidos simultâneos que misturam combos e energéticos em ordens diferentes: todos concluem (sem impasse nem 500)', mix.every((r) => r.status === 201), mix.map((r) => `${r.status}${r.data?.error ? ' ' + r.data.error : ''}`));
}

summary();
