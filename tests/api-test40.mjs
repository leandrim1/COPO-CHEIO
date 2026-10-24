// Gelos saborizados dos combos (migration 0037). A fonte dos sabores é o cadastro de produtos (produto marcado como "gelo saborizado"); o combo diz quantos gelos traz.
//  • painel: marcar gelo saborizado / gelos do combo; as duas coisas não valem juntas, nem com a escolha "gelo normal ou de sabor";
//  • o cardápio público leva as duas informações e nenhum sabor inventado;
//  • pedido: exatamente N unidades por combo, só de gelos saborizados ativos, fora de esgotado e com estoque (o banco confere, não o navegador);
//  • o preço do combo NÃO muda; linhas do mesmo combo com sabores diferentes ficam separadas; os sabores ficam no pedido (cliente, conta, painel, CSV);
//  • estoque do gelo escolhido sai ao pedir e volta ao cancelar (uma vez); repetir o envio (chave de idempotência) não repete nada;
//  • combos sem gelos seguem como sempre; ice_flavors num produto que não pede é ignorado.
// usage: bash tests/fresh.sh && node tests/api-test40.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

const owner = new Client(undefined, '198.51.100.160');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client(undefined, '198.51.100.161');
const gelos = (await owner.post('/api/admin/categories', { name: 'Gelos' })).data.category;
const combos = (await owner.post('/api/admin/categories', { name: 'Combos' })).data.category;
const make = async (name, price, category, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: category.id, alcoholic: false, confirm_duplicate: true, ...extra })).data.product;
const morango = await make('Gelo de morango', 3, gelos, { flavored_ice: true, stock: 40 });
const limao = await make('Gelo de limão', 3, gelos, { flavored_ice: true });
const melancia = await make('Gelo de melancia', 3, gelos, { flavored_ice: true, stock: 6 });
const acabou = await make('Gelo de maracujá', 3, gelos, { flavored_ice: true, sold_out: true });
const inativo = await make('Gelo de coco', 3, gelos, { flavored_ice: true, active: false });
const tradicional = await make('Gelo tradicional 4 kg', 8, gelos);
const combo = await make('COMBO RED LABEL', 100, combos, { combo_ice_count: 4, stock: 50 });
const semGelos = await make('COMBO SEM GELOS', 90, combos);
const comum = await make('Cerveja comum', 6, combos);
const stockOf = (p) => psql(`select coalesce(stock::text, 'null') from products where id = '${p.id}'`);
let phone = 0;
let ip = 70;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
const flav = (...pairs) => pairs.map(([p, quantity]) => ({ product_id: p.id, quantity }));
const body = (items, extra = {}) => ({ customer_name: 'Comprador Gelos', customer_phone: `3497${String(4100000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'cash', items, ...extra });
const place = (items, extra = {}, client = buyer()) => client.post('/api/orders', body(items, extra));
const itemRows = (number) => JSON.parse(psql(`select coalesce(json_agg(i order by i.created_at, i.product_name), '[]') from order_items i join orders o on o.id = i.order_id where o.order_number = ${number}`));
const orders = () => Number(psql('select count(*) from orders'));

// ------------------------------------------------------------------------------------------------
section('1. Painel: as duas marcas e as regras entre elas');
{
  check('os gelos e o combo do teste nasceram com as marcas certas', morango.flavored_ice === true && combo.combo_ice_count === 4 && comum.flavored_ice === false && comum.combo_ice_count === 0, [morango.flavored_ice, combo.combo_ice_count]);
  const both = await owner.patch(`/api/admin/products/${morango.id}`, { combo_ice_count: 4 });
  check('um gelo saborizado não pode trazer gelos (400)', both.status === 400 && both.data.code === 'flavored_ice_not_combo', both.data);
  const mark = await owner.patch(`/api/admin/products/${combo.id}`, { flavored_ice: true });
  check('um combo com gelos não pode ser marcado como gelo (400)', mark.status === 400, mark.data);
  const withIce = await owner.patch(`/api/admin/products/${combo.id}`, { ice_choice_required: true });
  check('combo com gelos não pede também "gelo normal ou de sabor" (400)', withIce.status === 400 && withIce.data.code === 'combo_ice_with_ice_choice', withIce.data);
  const high = await owner.patch(`/api/admin/products/${semGelos.id}`, { combo_ice_count: 13 });
  check('mais de 12 gelos por combo: recusado', high.status === 400, high.status);
  const direct = (() => {
    try {
      psql(`update products set flavored_ice = true, combo_ice_count = 4 where id = '${comum.id}'`);
      return 'aceitou';
    } catch {
      return 'recusou';
    }
  })();
  check('o banco também recusa as duas marcas juntas', direct === 'recusou', direct);
  const staff = new Client(undefined, '198.51.100.162');
  await owner.post('/api/admin/admins', { name: 'Atendente Gelos', email: 'atendente40@copocheio.local', password: 'senha-forte-456', role: 'admin' });
  await staff.login('atendente40@copocheio.local', 'senha-forte-456');
  const byStaff = await staff.patch(`/api/admin/products/${semGelos.id}`, { combo_ice_count: 2 });
  check('atendente também pode configurar (como o resto do cadastro de produtos)', byStaff.status === 200 && byStaff.data.product.combo_ice_count === 2, byStaff.status);
  await owner.patch(`/api/admin/products/${semGelos.id}`, { combo_ice_count: 0 });
  const dup = await owner.post(`/api/admin/products/${combo.id}/duplicate`);
  check('duplicar o combo copia a quantidade de gelos', dup.status === 201 && dup.data.product.combo_ice_count === 4, dup.data);
  await owner.del(`/api/admin/products/${dup.data.product.id}`);
}

// ------------------------------------------------------------------------------------------------
section('2. O cardápio público: as marcas e só produtos que existem');
{
  const pub = (await anon.get('/api/products')).data;
  const by = (p) => pub.products.find((x) => x.id === p.id);
  check('o combo traz a quantidade de gelos; o gelo traz a marca', by(combo)?.combo_ice_count === 4 && by(morango)?.flavored_ice === true && by(comum)?.flavored_ice === false, [by(combo)?.combo_ice_count]);
  const flavored = pub.products.filter((p) => p.flavored_ice).map((p) => p.name).sort();
  check('os sabores possíveis são só os gelos saborizados cadastrados e ativos (o inativo e o tradicional não entram)', JSON.stringify(flavored) === JSON.stringify(['Gelo de limão', 'Gelo de maracujá', 'Gelo de melancia', 'Gelo de morango']), flavored);
  check('o esgotado vem marcado como esgotado (o site não deixa escolher)', by(acabou)?.sold_out === true && by(limao)?.sold_out === false);
}

// ------------------------------------------------------------------------------------------------
section('3. Pedido: exatamente 4 gelos, de produtos que são gelo saborizado');
{
  const before = { n: orders(), morango: stockOf(morango), limao: stockOf(limao), combo: stockOf(combo) };
  const ok = await place([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 1], [limao, 1], [melancia, 2]) }]);
  check('4 sabores diferentes/misturados: pedido criado (201)', ok.status === 201, ok.data);
  const n = ok.data?.order?.order_number;
  const rows = itemRows(n);
  check('o combo custa o preço do combo: nenhum acréscimo pelos gelos', Number(ok.data.order.subtotal) === 100 && Number(ok.data.order.total) === 100, [ok.data.order.subtotal, ok.data.order.total]);
  check('o pedido tem uma linha, com os sabores gravados na linha (nome da hora do pedido)', rows.length === 1 && rows[0].ice_flavors.length === 3 && rows[0].ice_flavors.map((f) => `${f.quantity}x ${f.name}`).sort().join('|') === '1x Gelo de limão|1x Gelo de morango|2x Gelo de melancia', rows[0]?.ice_flavors);
  check('o nome do combo continua o mesmo (a escolha não vai no nome nem nas observações)', rows[0].product_name === 'COMBO RED LABEL' && psql(`select coalesce(notes, '') from orders where order_number = ${n}`) === '');
  check('o estoque dos gelos escolhidos saiu (morango −1) e o do combo −1', stockOf(morango) === String(Number(before.morango) - 1) && stockOf(combo) === String(Number(before.combo) - 1) && stockOf(limao) === before.limao, [stockOf(morango), stockOf(combo)]);

  const same = await place([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 4]) }]);
  check('4 unidades do mesmo sabor: vale', same.status === 201, same.data);

  const stockMorango = stockOf(morango);
  const rejected = [
    ['menos de 4 unidades', flav([morango, 3])],
    ['sem escolha nenhuma', undefined],
    ['lista vazia', []],
    ['mais de 4 unidades', flav([morango, 3], [limao, 2])],
    ['5 do mesmo sabor', flav([morango, 5])],
  ];
  for (const [label, flavors] of rejected) {
    const r = await place([{ product_id: combo.id, quantity: 1, ...(flavors === undefined ? {} : { ice_flavors: flavors }) }]);
    check(`${label}: recusado (400, ice_flavors_required), nada criado`, r.status === 400 && r.data.code === 'ice_flavors_required' && r.data.products?.[0]?.count === 4, [r.status, r.data]);
  }
  check('as recusas não reservaram estoque', stockOf(morango) === stockMorango && orders() === before.n + 2);

  const bad = [
    ['gelo tradicional (não é gelo saborizado)', flav([tradicional, 4]), 'flavor_unavailable'],
    ['o próprio combo no lugar de um sabor', flav([comum, 4]), 'flavor_unavailable'],
    ['sabor esgotado', flav([morango, 3], [acabou, 1]), 'flavor_unavailable'],
    ['sabor inativo', flav([morango, 3], [inativo, 1]), 'flavor_unavailable'],
    ['sabor que não existe', [{ product_id: '00000000-0000-4000-8000-000000000001', quantity: 4 }], 'flavor_unavailable'],
  ];
  for (const [label, flavors, code] of bad) {
    const r = await place([{ product_id: combo.id, quantity: 1, ice_flavors: flavors }]);
    check(`${label}: recusado (400, ${code})`, r.status === 400 && r.data.code === code, [r.status, r.data]);
  }
  for (const [label, flavors] of [['formato inválido (texto)', 'morango'], ['quantidade negativa', [{ product_id: morango.id, quantity: -1 }]], ['quantidade com texto', [{ product_id: morango.id, quantity: 'dois' }]], ['id inválido', [{ product_id: 'x', quantity: 4 }]], ['mais de 12 entradas', Array.from({ length: 13 }, () => ({ product_id: morango.id, quantity: 1 }))]]) {
    const r = await place([{ product_id: combo.id, quantity: 1, ice_flavors: flavors }]);
    check(`${label}: recusado (400)`, r.status === 400, [r.status, r.data]);
  }
  check('nenhuma recusa criou pedido nem mexeu no estoque', orders() === before.n + 2 && stockOf(morango) === stockMorango);
}

// ------------------------------------------------------------------------------------------------
section('4. Vários combos, escolhas independentes; quantidade; estoque do gelo');
{
  const n0 = orders();
  const two = await place([
    { product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 2], [limao, 2]) },
    { product_id: combo.id, quantity: 1, ice_flavors: flav([limao, 1], [melancia, 3]) },
  ]);
  const rows = itemRows(two.data?.order?.order_number);
  check('dois combos com sabores diferentes: duas linhas independentes', two.status === 201 && rows.length === 2 && rows.every((r) => r.quantity === 1), rows.map((r) => JSON.stringify(r.ice_flavors)));
  check('cada linha guarda os SEUS sabores', rows.some((r) => r.ice_flavors.some((f) => f.name === 'Gelo de morango' && f.quantity === 2)) && rows.some((r) => r.ice_flavors.some((f) => f.name === 'Gelo de melancia' && f.quantity === 3)));
  check('o total é a soma dos dois combos (200)', Number(two.data.order.total) === 200, two.data.order.total);

  // Mesma escolha no mesmo combo, duas vezes: uma linha de quantidade 2 (os sabores valem por combo).
  const sameTwice = await place([
    { product_id: combo.id, quantity: 1, ice_flavors: flav([limao, 4]) },
    { product_id: combo.id, quantity: 1, ice_flavors: flav([limao, 4]) },
  ]);
  const merged = itemRows(sameTwice.data?.order?.order_number);
  check('escolhas idênticas se juntam numa linha de quantidade 2 (sabores por combo)', sameTwice.status === 201 && merged.length === 1 && merged[0].quantity === 2, merged);

  // Estoque do gelo: melancia tem 6, já saíram 2 + 3 = 5 → sobra 1; um combo com 4 melancias não cabe.
  check('o estoque de melancia caiu pelas escolhas (6 → 1)', stockOf(melancia) === '1', stockOf(melancia));
  const noStock = await place([{ product_id: combo.id, quantity: 1, ice_flavors: flav([melancia, 4]) }]);
  check('gelo sem estoque para o combo: recusado (400) com o nome do sabor', noStock.status === 400 && noStock.data.code === 'flavor_unavailable' && /melancia/i.test(noStock.data.error ?? noStock.data.message ?? ''), noStock.data);
  const stockBefore = stockOf(limao);
  const q2 = await place([{ product_id: combo.id, quantity: 2, ice_flavors: flav([morango, 4]) }]);
  const q2rows = itemRows(q2.data?.order?.order_number);
  check('quantidade 2 do combo com os mesmos sabores: 8 gelos de morango saem do estoque', q2.status === 201 && q2rows[0].quantity === 2 && stockOf(limao) === stockBefore, q2.data);
  check('o total de 2 combos é 200, sem acréscimo', Number(q2.data.order.total) === 200);
  void n0;
}

// ------------------------------------------------------------------------------------------------
section('5. Onde os sabores aparecem: cliente, conta, painel, CSV; cancelar devolve o estoque');
{
  const client = buyer();
  const email = 'ana.gelos@exemplo.com';
  await registerVerified(client, { name: 'Ana Gelos', email, phone: '34981140001', password: 'senha-forte-123' });
  const before = { morango: stockOf(morango), limao: stockOf(limao), combo: stockOf(combo) };
  const r = await client.post('/api/orders', body([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 2], [limao, 2]) }]));
  const n = r.data.order.order_number;
  check('a resposta do pedido já traz os sabores, sem o id dos produtos', r.status === 201 && r.data.order.items[0].ice_flavors.length === 2 && r.data.order.items[0].ice_flavors.every((f) => f.name && f.quantity && !('product_id' in f)), r.data.order?.items);
  const mine = await client.get(`/api/account/orders/${n}`);
  check('em "Meus pedidos" os sabores vêm com o id do produto (para pedir de novo)', mine.status === 200 && mine.data.order.items[0].ice_flavors.every((f) => typeof f.product_id === 'string'), mine.data?.order?.items);
  const list = await client.get('/api/account/orders');
  check('o resumo da lista de pedidos cita os sabores', list.status === 200 && /gelos: 2x Gelo de limão, 2x Gelo de morango/.test(JSON.stringify(list.data)), JSON.stringify(list.data).slice(0, 300));
  const adm = await owner.get(`/api/admin/orders/${n}`);
  check('o painel mostra os sabores da linha', adm.status === 200 && adm.data.items[0].ice_flavors.length === 2, adm.data?.items);
  const day = new Date().toISOString().slice(0, 10);
  const csv = await owner.get(`/api/admin/export/orders.csv?from=${day}&to=${day}`);
  check('o CSV de pedidos cita os sabores', csv.status === 200 && /gelos: 2x Gelo de limão, 2x Gelo de morango/.test(String(csv.data)), String(csv.data).slice(0, 200));
  check('o estoque saiu', stockOf(morango) === String(Number(before.morango) - 2) && stockOf(combo) === String(Number(before.combo) - 1));
  const id = psql(`select id from orders where order_number = ${n}`);
  await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled', reason: 'teste' });
  check('cancelar devolve o estoque dos gelos escolhidos e o do combo', stockOf(morango) === before.morango && stockOf(combo) === before.combo, [stockOf(morango), stockOf(combo)]);
  await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled', reason: 'de novo' });
  check('cancelar de novo não devolve duas vezes', stockOf(morango) === before.morango);
}

// ------------------------------------------------------------------------------------------------
section('6. Combos sem gelos e outros produtos seguem como sempre');
{
  const before = stockOf(morango);
  const plain = await place([{ product_id: semGelos.id, quantity: 1 }, { product_id: comum.id, quantity: 2 }]);
  check('combo sem gelos e produto comum: pedido normal (201)', plain.status === 201 && Number(plain.data.order.total) === 102, plain.data);
  check('sem sabores nas linhas', itemRows(plain.data.order.order_number).every((r) => r.ice_flavors === null));
  const ignored = await place([{ product_id: semGelos.id, quantity: 1, ice_flavors: flav([morango, 4]) }]);
  check('ice_flavors num produto que não traz gelos é ignorado (nada gravado, estoque igual)', ignored.status === 201 && itemRows(ignored.data.order.order_number)[0].ice_flavors === null && stockOf(morango) === before, ignored.data);
  const asProduct = await place([{ product_id: morango.id, quantity: 2 }]);
  check('o gelo saborizado também continua vendável sozinho', asProduct.status === 201 && Number(asProduct.data.order.total) === 6, asProduct.data);
}

// ------------------------------------------------------------------------------------------------
section('7. Repetir o envio: mesma chave devolve o mesmo pedido; escolha diferente com a mesma chave é conflito');
{
  const key = 'chave-gelos-0123456789abcdef';
  const client = buyer();
  const first = await client.post('/api/orders', body([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 1], [limao, 3]) }], { idempotency_key: key }));
  const stockAfterFirst = stockOf(morango);
  check('o primeiro envio cria o pedido', first.status === 201, first.data);
  const replay = await client.post('/api/orders', { ...body([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 1], [limao, 3]) }], { idempotency_key: key }), customer_phone: psql(`select customer_phone from orders where order_number = ${first.data.order.order_number}`) });
  check('o mesmo envio repetido devolve o mesmo pedido e não reserva mais estoque', replay.status === 200 && replay.data.order.replayed === true && replay.data.order.order_number === first.data.order.order_number && stockOf(morango) === stockAfterFirst, [replay.status, replay.data?.order?.replayed]);
  const phoneOf = psql(`select customer_phone from orders where order_number = ${first.data.order.order_number}`);
  const diff = await client.post('/api/orders', { ...body([{ product_id: combo.id, quantity: 1, ice_flavors: flav([morango, 2], [limao, 2]) }], { idempotency_key: key }), customer_phone: phoneOf });
  check('a mesma chave com outros sabores é conflito (409), nada muda', diff.status === 409 && stockOf(morango) === stockAfterFirst, [diff.status, diff.data]);
}

// ------------------------------------------------------------------------------------------------
section('8. O ponto de partida da migration (uma vez): só marca o que parece gelo saborizado e combo com "4 gelos"');
{
  const sql = readFileSync(new URL('../db/migrations/0037_combo_ice_flavors.sql', import.meta.url), 'utf8');
  const backfill = sql.slice(sql.indexOf('-- Ponto de partida (uma vez)'));
  const dry = await make('Cerveja gelada', 7, combos);
  const kg = await make('Gelo em cubos 2 kg', 8, gelos);
  const barra = await make('Gelo de barra', 9, gelos);
  const outroCombo = await make('COMBO ESPECIAL', 120, combos);
  await owner.patch(`/api/admin/products/${combo.id}`, { description: '1 Red Label + 1 Energético + 4 GELOS DE SABOR' });
  await owner.patch(`/api/admin/products/${outroCombo.id}`, { description: 'Vem com 3 gelos e um copo' });
  const reset = () => psql("update products set flavored_ice = false, combo_ice_count = 0");
  reset();
  psql(backfill);
  const flavored = psql("select string_agg(name, '|' order by name) from products where flavored_ice");
  check('marca como gelo saborizado os que começam com "Gelo" ou estão numa categoria de gelo e não são tradicionais, em kg ou de barra', flavored === 'Gelo de coco|Gelo de limão|Gelo de maracujá|Gelo de melancia|Gelo de morango', flavored);
  check('não marca cerveja, gelo em kg, gelo de barra nem o tradicional', [dry, kg, barra, tradicional].every((p) => psql(`select flavored_ice from products where id = '${p.id}'`) === 'f'));
  check('o combo que cita "4 gelos" ganha 4; o que cita 3 e o sem gelos não', psql(`select combo_ice_count from products where id = '${combo.id}'`) === '4' && psql(`select combo_ice_count from products where id = '${outroCombo.id}'`) === '0' && psql(`select combo_ice_count from products where id = '${semGelos.id}'`) === '0');
  // Sem nenhum gelo saborizado cadastrado, nenhum combo passa a exigir sabores (não travaria a venda do combo).
  psql("update products set flavored_ice = false");
  psql("update products set combo_ice_count = 0");
  psql(backfill.replace(/update products p\s+set flavored_ice = true[\s\S]*?;\s*-- statement-breakpoint/, '-- (sem marcar gelos)\n-- statement-breakpoint'));
  check('sem gelo saborizado cadastrado, o combo não passa a exigir sabores', psql('select count(*) from products where combo_ice_count > 0') === '0');
}

summary();
