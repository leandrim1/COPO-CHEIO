// Escolha obrigatória do gelo (migration 0013): a regra vale por categoria (marca no banco, não pelo nome), o banco recusa o pedido sem a
// escolha mesmo numa requisição feita direto à API, a escolha é gravada em cada item e aparece no acompanhamento, na conta e no painel.
// usage: bash tests/fresh.sh && node tests/api-test13.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', [...P, '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const root = new URL('..', import.meta.url).pathname;
const MESSAGE = 'Escolha o tipo de gelo para continuar.';
// "Copão" com o til "solto" (acento decomposto, como alguns teclados e sistemas gravam): tem de ser reconhecido igual.
const NFD = 'Copão'.normalize('NFD');
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

// ------------------------------------------------------------------------------------------------
section('1. Banco de produção antes da mudança: a migration 0013 marca só as duas categorias do pedido');
{
  const db = 'legacy13_a';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover', '0008_store_whatsapp', '0009_security_foundations', '0010_promo_window', '0011_orders_integrity', '0012_privacy'];
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const migrate = () => execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  const q = (sql) => psql(sql, db);

  // Nomes como a loja pode ter digitado: com acento, sem acento, maiúsculas, espaços repetidos e o acento "solto" (NFD).
  q(`insert into categories (name, position) values
      ('Copão', 0), ('Copão com Monster', 1), ('  COPAO   com   monster ', 2), (U&'Copa\\0303o', 3),
      ('Cervejas', 4), ('Copões', 5), ('Copão Infantil', 6), ('Monster', 7), ('Combo Copão com Monster', 8)`);
  const copao = q(`insert into products (name, price, category_id) select 'Copão Teste', 20, id from categories where name = 'Copão' returning id`);
  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  const oldOrder = JSON.parse(q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Antigo', customer_phone: '34990000001', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: copao, quantity: 2 }] }))}::jsonb)`));
  check('antes: o pedido de copão ainda entra sem escolher o gelo (como no site de hoje)', oldOrder.order_number >= 1001 && oldOrder.items.length === 1, oldOrder);

  const out = migrate();
  check('migrate.mjs aplica só a 0013', /aplicada: 0013_ice_choice/.test(out) && !/aplicada: 00(0|1[0-2])/.test(out), out);
  const flags = Object.fromEntries(q('select name || chr(9) || ice_choice_required from categories').split('\n').map((line) => line.split('\t')));
  check('"Copão" e "Copão com Monster" passam a pedir o gelo', flags['Copão'] === 'true' && flags['Copão com Monster'] === 'true', flags);
  check('maiúsculas, acentos soltos e espaços repetidos não atrapalham', flags['  COPAO   com   monster '] === 'true' && flags[NFD] === 'true', flags);
  check('as outras categorias NÃO são marcadas (Cervejas, Copões, Copão Infantil, Monster, Combo...)', ['Cervejas', 'Copões', 'Copão Infantil', 'Monster', 'Combo Copão com Monster'].every((n) => flags[n] === 'false'), flags);
  check('o pedido que já existia continua igual: mesmo número, mesmos itens e total, sem escolha de gelo', q("select count(*) from order_items where ice_choice is not null") === '0' && q(`select string_agg(quantity || 'x ' || product_name, ',') from order_items`) === '2x Copão Teste' && q('select total from orders') === '40.00');
  const old = JSON.parse(q(`select order_json(id) from orders`));
  check('...e o pedido antigo como o cliente vê não ganha o campo ice_choice', old.items.length === 1 && !('ice_choice' in old.items[0]), old.items);

  let refused = '';
  try {
    q(`select create_order(${lit(JSON.stringify({ customer_name: 'Cliente Novo', customer_phone: '34990000002', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: copao, quantity: 1 }] }))}::jsonb)`);
  } catch (error) {
    refused = String(error.stderr ?? error.message);
  }
  check('depois: o banco recusa copão sem escolha, com a mensagem pedida', refused.includes(MESSAGE), refused);
  check('...e nada foi criado (continua 1 pedido)', q('select count(*) from orders') === '1');

  // Uma troca feita depois no painel vale: a migration não roda de novo e não desfaz nada.
  q("update categories set ice_choice_required = false where name = 'Copão'");
  q("update categories set ice_choice_required = true where name = 'Cervejas'");
  const again = migrate();
  check('rodar de novo não faz nada e não desfaz o que o painel mudou', /Banco já está atualizado/.test(again) && q("select ice_choice_required from categories where name = 'Copão'") === 'f' && q("select ice_choice_required from categories where name = 'Cervejas'") === 't', again);
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// ------------------------------------------------------------------------------------------------
section('2. Painel e site: a marca vive na categoria (id), não no nome');
const owner = new Client(undefined, '198.51.100.13');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client();
const mkCat = async (name, extra = {}) => (await owner.post('/api/admin/categories', { name, ...extra })).data.category;
const monster = await mkCat('Copão com Monster', { ice_choice_required: true });
const copao = await mkCat('Copão', { ice_choice_required: true });
const cerv = await mkCat('Cervejas');
const mk = async (name, price, category, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: category?.id ?? null, confirm_duplicate: true, ...extra })).data.product;
const mon1 = await mk('Copão Monster Original', 25, monster, { stock: 40 });
const mon2 = await mk('Copão Monster Mango', 27, monster);
const cop1 = await mk('Copão de Gin', 18, copao, { promo_price: 15 });
const beer = await mk('Heineken', 8, cerv, { stock: 30 });
const loose = await mk('Produto sem categoria', 6, null);
{
  check('categoria nova nasce sem a regra (padrão falso)', cerv.ice_choice_required === false, cerv);
  check('criar já com a regra ligada', monster.ice_choice_required === true && copao.ice_choice_required === true);
  const pub = (await anon.get('/api/products')).data;
  const flag = Object.fromEntries(pub.categories.map((c) => [c.name, c.ice_choice_required]));
  check('o site recebe a marca de cada categoria em /api/products', flag['Copão com Monster'] === true && flag['Copão'] === true && flag['Cervejas'] === false, flag);
  check('os produtos continuam sem nenhuma coluna nova (a marca vem da categoria)', pub.products.every((p) => !('ice_choice_required' in p)));
  check('só o painel liga e desliga: valor que não é verdadeiro/falso → 400', (await owner.patch(`/api/admin/categories/${cerv.id}`, { ice_choice_required: 'sim' })).status === 400 && (await owner.post('/api/admin/categories', { name: 'X', ice_choice_required: 1 })).status === 400);
  check('sem login não liga a regra', (await anon.patch(`/api/admin/categories/${cerv.id}`, { ice_choice_required: true })).status === 401);
  const lista = (await owner.get('/api/admin/categories')).data.categories;
  check('o painel lista a marca de cada categoria', lista.find((c) => c.id === monster.id).ice_choice_required === true && lista.find((c) => c.id === cerv.id).ice_choice_required === false);

  await owner.patch(`/api/admin/categories/${cerv.id}`, { ice_choice_required: true });
  check('ligar pelo painel vale na hora para o site', (await anon.get('/api/products')).data.categories.find((c) => c.id === cerv.id).ice_choice_required === true);
  await owner.patch(`/api/admin/categories/${cerv.id}`, { ice_choice_required: false });
  const log = (await owner.get('/api/admin/audit?entity=category&limit=20')).data.entries.map((e) => e.summary).join(' | ');
  check('a mudança fica no histórico de atividades', /escolha do gelo obrigatória/.test(log), log);
}

// ------------------------------------------------------------------------------------------------
let ip = 20;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const order = (items, extra = {}) => ({ customer_name: 'Comprador Gelo', customer_phone: `3497${String(1000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items, ...extra });
const stockOf = (id) => psql(`select coalesce(stock::text, 'null') from products where id = ${lit(id)}`);
const ordersCount = () => Number(psql('select count(*) from orders'));
const rowsOf = (number) => psql(`select coalesce(string_agg(coalesce(i.ice_choice, '-') || ':' || i.quantity || ':' || i.product_name, ' | ' order by i.product_name, i.ice_choice nulls first), '') from order_items i join orders o on o.id = i.order_id where o.order_number = ${number}`);

section('3. Pedido sem a escolha é recusado no banco (requisição direta à API não contorna)');
{
  const c = buyer();
  const before = { orders: ordersCount(), stock: stockOf(mon1.id), beer: stockOf(beer.id) };
  const variants = {
    'sem o campo (como faria o site antigo ou um robô)': { product_id: mon1.id, quantity: 1 },
    'ice_choice nulo': { product_id: mon1.id, quantity: 1, ice_choice: null },
    'ice_choice vazio': { product_id: mon1.id, quantity: 1, ice_choice: '' },
    'valor inventado': { product_id: mon1.id, quantity: 1, ice_choice: 'banana' },
    'maiúscula (o código é "normal")': { product_id: mon1.id, quantity: 1, ice_choice: 'Normal' },
    'texto do rótulo': { product_id: mon1.id, quantity: 1, ice_choice: 'Gelo normal' },
    'número': { product_id: mon1.id, quantity: 1, ice_choice: 5 },
    'verdadeiro': { product_id: mon1.id, quantity: 1, ice_choice: true },
    'objeto': { product_id: mon1.id, quantity: 1, ice_choice: { value: 'normal' } },
    'lista': { product_id: mon1.id, quantity: 1, ice_choice: ['normal'] },
    'outro nome de campo (gelo)': { product_id: mon1.id, quantity: 1, gelo: 'normal' },
    'outro nome de campo (ice)': { product_id: mon1.id, quantity: 1, ice: 'normal' },
  };
  for (const [name, item] of Object.entries(variants)) {
    const r = await c.post('/api/orders', order([item]));
    check(`recusado (400, ice_required, mensagem pedida): ${name}`, r.status === 400 && r.data.code === 'ice_required' && r.data.error === MESSAGE, r.data);
  }
  const r = await c.post('/api/orders', order([{ product_id: mon1.id, quantity: 1 }]));
  check('a resposta diz qual produto está sem a escolha', r.data.products?.length === 1 && r.data.products[0].product_id === mon1.id && r.data.products[0].name === 'Copão Monster Original', r.data);
  check('copão da outra categoria (Copão) também exige', (await c.post('/api/orders', order([{ product_id: cop1.id, quantity: 1 }]))).data.code === 'ice_required');
  check('nenhum pedido foi criado e o estoque não mexeu', ordersCount() === before.orders && stockOf(mon1.id) === before.stock);

  // Um pedido com vários produtos: basta um sem a escolha para recusar tudo (e nada do que vinha certo fica reservado).
  const mixed = await c.post('/api/orders', order([{ product_id: beer.id, quantity: 3 }, { product_id: mon1.id, quantity: 2, ice_choice: 'normal' }, { product_id: cop1.id, quantity: 1 }]));
  check('com um produto certo e outro sem a escolha: tudo recusado, listando só o que falta', mixed.status === 400 && mixed.data.code === 'ice_required' && mixed.data.products.length === 1 && mixed.data.products[0].product_id === cop1.id, mixed.data);
  check('...e o estoque dos itens certos continua intacto (nada ficou reservado)', ordersCount() === before.orders && stockOf(beer.id) === before.beer && stockOf(mon1.id) === before.stock);
  const two = await c.post('/api/orders', order([{ product_id: mon1.id, quantity: 1 }, { product_id: mon2.id, quantity: 1 }, { product_id: cop1.id, quantity: 1 }]));
  check('vários sem escolha: a resposta lista todos', two.data.products?.length === 3, two.data);

  // O pedido com a escolha para UMA das duas linhas do mesmo produto: a linha sem escolha também é recusada.
  const half = await c.post('/api/orders', order([{ product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }, { product_id: mon1.id, quantity: 1 }]));
  check('mesmo produto em duas linhas, uma sem escolha: recusado', half.status === 400 && half.data.code === 'ice_required', half.data);
}

// ------------------------------------------------------------------------------------------------
section('4. Pedido com a escolha: gravada em cada item, linhas separadas por gelo');
let made;
{
  const c = buyer();
  const s0 = Number(stockOf(mon1.id));
  const a = await c.post('/api/orders', order([{ product_id: mon1.id, quantity: 1, ice_choice: 'normal' }]));
  check('gelo normal: 201', a.status === 201 && a.data.order.items[0].ice_choice === 'normal', a.data);
  check('gravado no item do pedido (banco)', rowsOf(a.data.order.order_number) === 'normal:1:Copão Monster Original', rowsOf(a.data.order.order_number));
  const b = await buyer().post('/api/orders', order([{ product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }]));
  check('gelo de sabor: 201 e gravado', b.status === 201 && b.data.order.items[0].ice_choice === 'flavored' && rowsOf(b.data.order.order_number) === 'flavored:1:Copão Monster Original');

  // Dois copões iguais com gelos diferentes: cada personalização fica separada, com a sua quantidade.
  made = await c.post('/api/orders', order([{ product_id: mon1.id, quantity: 2, ice_choice: 'normal' }, { product_id: mon1.id, quantity: 3, ice_choice: 'flavored' }, { product_id: mon2.id, quantity: 1, ice_choice: 'flavored' }]));
  check('dois gelos do mesmo copão + outro copão: 201', made.status === 201, made.data);
  const n = made.data.order.order_number;
  check('três itens no pedido, um por produto+gelo, cada um com a sua quantidade', rowsOf(n) === 'flavored:1:Copão Monster Mango | flavored:3:Copão Monster Original | normal:2:Copão Monster Original', rowsOf(n));
  check('o pedido como o cliente vê traz o gelo de cada item', made.data.order.items.map((i) => `${i.quantity}x ${i.product_name} ${i.ice_choice}`).sort().join(',') === '1x Copão Monster Mango flavored,2x Copão Monster Original normal,3x Copão Monster Original flavored', made.data.order.items);
  check('subtotal = soma de tudo (5 × 25 + 1 × 27 = 152) e total com a taxa de entrega', made.data.order.subtotal === 152 && made.data.order.total === 152, made.data.order);
  check('cada item guarda o preço do momento (total do item = unitário × quantidade)', psql(`select bool_and(total_price = unit_price * quantity) from order_items i join orders o on o.id = i.order_id where o.order_number = ${n}`) === 't');
  check('o estoque saiu uma vez, pela soma das linhas: 1 + 1 + 5 = 7 do Original', Number(stockOf(mon1.id)) === s0 - 7, stockOf(mon1.id));

  // Mesma linha repetida no envio vira uma linha só
  const m = await buyer().post('/api/orders', order([{ product_id: mon2.id, quantity: 1, ice_choice: 'normal' }, { product_id: mon2.id, quantity: 2, ice_choice: 'normal' }]));
  check('o mesmo produto com o mesmo gelo, repetido no envio, soma numa linha só', rowsOf(m.data.order.order_number) === 'normal:3:Copão Monster Mango', rowsOf(m.data.order.order_number));

  // Copão em promoção: o preço do momento vale em todas as linhas
  const p = await buyer().post('/api/orders', order([{ product_id: cop1.id, quantity: 1, ice_choice: 'normal' }, { product_id: cop1.id, quantity: 2, ice_choice: 'flavored' }]));
  check('produto em promoção: as duas linhas usam o preço promocional (3 × R$ 15,00)', p.status === 201 && p.data.order.subtotal === 45 && p.data.order.items.every((i) => i.unit_price === 15), p.data);

  // Produtos que NÃO pedem o gelo: nada muda (nem com o campo enviado).
  const plain = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 2 }, { product_id: loose.id, quantity: 1 }]));
  check('produto de outra categoria e produto sem categoria continuam sem escolha, como sempre', plain.status === 201 && plain.data.order.items.every((i) => !('ice_choice' in i)) && rowsOf(plain.data.order.order_number) === '-:2:Heineken | -:1:Produto sem categoria', plain.data);
  const extra = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 1, ice_choice: 'normal' }, { product_id: loose.id, quantity: 1, ice_choice: 'flavored' }, { product_id: beer.id, quantity: 1, ice_choice: 'banana' }]));
  check('ice_choice em produto que não pede é ignorado (não polui o pedido, não recusa)', extra.status === 201 && rowsOf(extra.data.order.order_number) === '-:2:Heineken | -:1:Produto sem categoria', rowsOf(extra.data.order?.order_number));
  const mixedOk = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 1 }, { product_id: cop1.id, quantity: 1, ice_choice: 'flavored' }]));
  check('pedido misto (cerveja + copão com gelo): 201', mixedOk.status === 201 && rowsOf(mixedOk.data.order.order_number) === 'flavored:1:Copão de Gin | -:1:Heineken', mixedOk.data);

  // Limites
  const big = await buyer().post('/api/orders', order([{ product_id: mon2.id, quantity: 60, ice_choice: 'normal' }, { product_id: mon2.id, quantity: 60, ice_choice: 'flavored' }]));
  check('mais de 99 do mesmo produto, somando os gelos: recusado', big.status === 400 && /Quantidade inválida/.test(big.data.error), big.data);
  const limited = await mk('Copão Edição Limitada', 30, monster, { stock: 3 });
  const over = await buyer().post('/api/orders', order([{ product_id: limited.id, quantity: 2, ice_choice: 'normal' }, { product_id: limited.id, quantity: 2, ice_choice: 'flavored' }]));
  check('estoque conferido pela soma das linhas (2 + 2 > 3): recusado e o estoque fica em 3', over.status === 400 && /Temos só 3/.test(over.data.error) && stockOf(limited.id) === '3', over.data);
  const exact = await buyer().post('/api/orders', order([{ product_id: limited.id, quantity: 2, ice_choice: 'normal' }, { product_id: limited.id, quantity: 1, ice_choice: 'flavored' }]));
  check('2 + 1 = 3 cabe e zera o estoque (produto passa a esgotado)', exact.status === 201 && stockOf(limited.id) === '0' && psql(`select sold_out from products where id = ${lit(limited.id)}`) === 't', exact.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Quem muda a regra: desligar, religar e renomear a categoria');
{
  const c = buyer();
  await owner.patch(`/api/admin/categories/${copao.id}`, { ice_choice_required: false });
  const free = await c.post('/api/orders', order([{ product_id: cop1.id, quantity: 1 }]));
  check('com a regra desligada, o produto da categoria volta a ser pedido sem a escolha', free.status === 201 && !('ice_choice' in free.data.order.items[0]), free.data);
  const ignored = await c.post('/api/orders', order([{ product_id: cop1.id, quantity: 1, ice_choice: 'normal' }]));
  check('...e uma escolha enviada é ignorada (a regra manda, não o navegador)', ignored.status === 201 && !('ice_choice' in ignored.data.order.items[0]), ignored.data);
  await owner.patch(`/api/admin/categories/${copao.id}`, { ice_choice_required: true });
  check('religada, volta a exigir', (await c.post('/api/orders', order([{ product_id: cop1.id, quantity: 1 }]))).data.code === 'ice_required');

  // Renomear NÃO desliga a regra: ela está presa à categoria (id), não ao nome.
  await owner.patch(`/api/admin/categories/${copao.id}`, { name: 'Copão 700ml' });
  const renamed = await c.post('/api/orders', order([{ product_id: cop1.id, quantity: 1 }]));
  check('categoria renomeada continua exigindo o gelo (a regra não depende do nome)', renamed.status === 400 && renamed.data.code === 'ice_required', renamed.data);
  // ...e uma categoria que ganha o nome "Copão" não ganha a regra sozinha
  const impostor = await mkCat('Copão Zero', {});
  const prod = await mk('Copão Zero Açúcar', 12, impostor);
  const noRule = await c.post('/api/orders', order([{ product_id: prod.id, quantity: 1 }]));
  check('categoria nova com nome parecido NÃO ganha a regra sozinha (só o painel liga)', noRule.status === 201 && !('ice_choice' in noRule.data.order.items[0]), noRule.data);
  await owner.patch(`/api/admin/categories/${copao.id}`, { name: 'Copão' });

  // Mover o produto de categoria muda a regra dele
  await owner.patch(`/api/admin/products/${prod.id}`, { category_id: monster.id });
  check('produto movido para uma categoria que pede o gelo passa a exigir', (await c.post('/api/orders', order([{ product_id: prod.id, quantity: 1 }]))).data.code === 'ice_required');
  await owner.patch(`/api/admin/products/${prod.id}`, { category_id: null });
  check('produto sem categoria não exige', (await c.post('/api/orders', order([{ product_id: prod.id, quantity: 1 }]))).status === 201);
}

// ------------------------------------------------------------------------------------------------
section('6. Repetir o envio, total conferido e preço mudado, com linhas separadas por gelo');
{
  const c = buyer();
  const key = `gelo${Math.random().toString(36).slice(2)}abcdefghij`.slice(0, 28);
  const body = order([{ product_id: mon1.id, quantity: 1, ice_choice: 'normal' }, { product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }], { idempotency_key: key, expected_total: '50.00' });
  const first = await c.post('/api/orders', body);
  const again = await c.post('/api/orders', body);
  check('o mesmo envio repetido devolve o mesmo pedido (200), com as duas linhas', first.status === 201 && again.status === 200 && again.data.order.order_number === first.data.order.order_number && again.data.order.items.length === 2, again.data);
  check('...sem criar outro pedido', psql(`select count(*) from orders where idempotency_key = ${lit(key)}`) === '1');
  const swapped = order([{ product_id: mon1.id, quantity: 2, ice_choice: 'normal' }], { idempotency_key: key, expected_total: '50.00' });
  const conflict = await c.post('/api/orders', { ...swapped, customer_phone: body.customer_phone, customer_name: body.customer_name });
  check('mesma chave com outro pedido → 409 idempotency_conflict', conflict.status === 409 && conflict.data.code === 'idempotency_conflict', conflict.data);
  const k2 = `gelo${Math.random().toString(36).slice(2)}zyxwvutsrq`.slice(0, 28);
  const base = order([{ product_id: mon1.id, quantity: 1, ice_choice: 'normal' }], { idempotency_key: k2 });
  const r1 = await buyer().post('/api/orders', base);
  const r2 = await buyer().post('/api/orders', { ...base, items: [{ product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }] });
  check('mesma chave trocando só o gelo conta como pedido diferente (409)', r1.status === 201 && r2.status === 409 && r2.data.code === 'idempotency_conflict', r2.data);

  // Total conferido: o valor mudou entre a tela e o envio
  const wrong = await buyer().post('/api/orders', order([{ product_id: mon1.id, quantity: 2, ice_choice: 'normal' }, { product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }], { expected_total: '10.00' }));
  check('total diferente do visto → 409 price_changed e nada criado', wrong.status === 409 && wrong.data.code === 'price_changed' && wrong.data.total === 75, wrong.data);
  check('...e a resposta traz o gelo de cada linha', wrong.data.items.map((i) => `${i.quantity}:${i.ice_choice}`).sort().join(',') === '1:flavored,2:normal', wrong.data.items);
  const right = await buyer().post('/api/orders', order([{ product_id: mon1.id, quantity: 2, ice_choice: 'normal' }, { product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }], { expected_total: '75.00' }));
  check('com o total certo (3 × R$ 25,00), o pedido sai', right.status === 201, right.data);
}

// ------------------------------------------------------------------------------------------------
section('7. Onde a escolha aparece: acompanhamento, conta (pedir de novo), painel, dashboard e cancelamento');
{
  const n = made.data.order.order_number;
  const tracked = (await new Client().get(`/api/tracking/${made.data.token}`)).data.order;
  check('acompanhamento por link: itens com o gelo de cada um', tracked.items.filter((i) => i.ice_choice).length === 3 && tracked.items.some((i) => i.product_name === 'Copão Monster Original' && i.quantity === 3 && i.ice_choice === 'flavored'), tracked.items);
  check('...e sem expor id de produto nem dados pessoais', tracked.items.every((i) => !('product_id' in i)) && !('customer_phone' in tracked));
  const lookup = await new Client().post('/api/tracking/lookup', { order_number: String(n), code: made.data.token });
  check('consulta por número + código também traz o gelo', lookup.status === 200 && lookup.data.order.items.some((i) => i.ice_choice === 'normal'), lookup.data);

  const detail = (await owner.get(`/api/admin/orders/${n}`)).data;
  const lines = detail.items.map((i) => `${i.product_name}|${i.ice_choice}|${i.quantity}`);
  check('painel: cada item (linha de produto+gelo) traz o gelo e a quantidade', JSON.stringify(lines) === JSON.stringify(['Copão Monster Mango|flavored|1', 'Copão Monster Original|flavored|3', 'Copão Monster Original|normal|2']), lines);

  // Conta do cliente
  const ana = new Client(undefined, '203.0.113.200');
  await registerVerified(ana, { name: 'Ana Gelo', email: 'ana.gelo@exemplo.com', phone: '34 95555-0001', password: 'ana-gelo-senha-123' });
  const mine = await ana.post('/api/orders', order([{ product_id: mon1.id, quantity: 2, ice_choice: 'normal' }, { product_id: mon1.id, quantity: 1, ice_choice: 'flavored' }, { product_id: beer.id, quantity: 4 }], { customer_phone: '34955550001' }));
  check('pedido feito logado: 201', mine.status === 201, mine.data);
  const det = await ana.get(`/api/account/orders/${mine.data.order.order_number}`);
  const byIce = det.data.order.items.map((i) => `${i.product_name}|${i.ice_choice ?? '-'}|${i.quantity}|${i.product_id ? 'id' : 'sem-id'}`).sort();
  check('conta: o detalhe traz gelo, quantidade e id do produto (para "pedir de novo")', JSON.stringify(byIce) === JSON.stringify(['Copão Monster Original|flavored|1|id', 'Copão Monster Original|normal|2|id', 'Heineken|-|4|id']), byIce);
  const list = await ana.get('/api/account/orders');
  const summary = list.data.orders.find((o) => o.order_number === mine.data.order.order_number)?.summary ?? '';
  check('conta: o resumo da lista mostra o gelo de cada item', summary === '1x Copão Monster Original (gelo de sabor), 2x Copão Monster Original (gelo normal), 4x Heineken', summary);

  // Cancelar devolve o estoque pela soma das linhas
  const id = detail.order.id;
  const before = Number(stockOf(mon1.id));
  const cancelled = await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled' });
  check('cancelar o pedido devolve ao estoque a soma das linhas (3 + 2 = 5 do Original)', cancelled.status === 200 && Number(stockOf(mon1.id)) === before + 5, stockOf(mon1.id));

  // Dashboard: o mesmo produto com gelos diferentes continua sendo um produto só
  const dash = (await owner.get('/api/admin/dashboard?days=30')).data;
  const top = dash.top_products.filter((t) => t.name === 'Copão Monster Original');
  check('dashboard: os gelos do mesmo copão somam num único item de "mais vendidos"', top.length === 1, dash.top_products);
}

summary();
