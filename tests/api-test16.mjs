// Troca do energético dos combos (migrations 0017 e 0018): o preço da troca (combo + diferença) é calculado pelo banco e nunca fica abaixo do combo,
// a diferença é sobre o VALOR do energético que vem no combo (produto do cardápio ou valor digitado no painel), a lista de energéticos da troca é
// a que o painel escolheu (sem lista, qualquer energético de 2L), o estoque do energético novo sai e volta, tudo vale mesmo numa requisição feita direto à API.
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
section('1. Banco de produção antes da mudança: as migrations 0017 e 0018 só acrescentam e a 0017 já liga cada combo ao energético que vem nele');
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
  const oldOrder = JSON.parse(q(`select create_order(${lit(JSON.stringify({ age_confirmed: true, customer_name: 'Cliente Antigo', customer_phone: '34990000001', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: busca, quantity: 2 }] }))}::jsonb)`));
  check('antes: o combo é pedido normalmente', oldOrder.order_number >= 1001 && oldOrder.total === 180, oldOrder);

  const out = migrate();
  check('migrate.mjs aplica a 0017 e a 0018 (e as seguintes), nessa ordem', /aplicada: 0017_energetic_swap[\s\S]*aplicada: 0018_swap_options/.test(out) && !/aplicada: 00(0|1[0-6])/.test(out), out);
  check('0018: nenhum combo ganha valor digitado nem lista (todos continuam aceitando qualquer energético de 2L)', q('select count(*) from products where swap_base_price is not null') === '0' && q('select count(*) from product_swap_options') === '0');
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
  const plain = JSON.parse(q(`select create_order(${lit(JSON.stringify({ age_confirmed: true, customer_name: 'Cliente Novo', customer_phone: '34990000002', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: busca, quantity: 1 }, { product_id: kit, quantity: 1 }] }))}::jsonb)`));
  check('depois: pedido sem troca se comporta como antes (90 + 40 = 130)', plain.total === 130 && plain.items.length === 2, plain);

  // O painel manda: o que ele grava não é desfeito, e a migration não roda de novo.
  q(`update products set swap_base_product_id = ${lit(fusion)} where id = ${lit(busca)}`);
  const again = migrate();
  check('rodar de novo não faz nada e não desfaz o que o painel mudou', /Banco já está atualizado/.test(again) && base(busca) === fusion, again);
  execFileSync('psql', [...P, '-q', '-c', `drop database ${db} with (force)`], QUIET);
}

// O banco que está no ar hoje já tem a 0017: a 0018 sozinha não pode mexer em nada do que existe.
{
  const db = 'legacy17_b';
  execFileSync('psql', [...P, '-q', '-v', 'ON_ERROR_STOP=1', '-c', `drop database if exists ${db} with (force)`, '-c', `create database ${db}`], QUIET);
  const files = ['0001_schema', '0002_functions', '0003_initial_content', '0004_order_tracking', '0005_email_verification', '0006_password_reset_email', '0007_banner_cover', '0008_store_whatsapp', '0009_security_foundations', '0010_promo_window', '0011_orders_integrity', '0012_privacy', '0013_ice_choice', '0014_online_payments', '0015_merchant_account_flow', '0016_commission_2_percent', '0017_energetic_swap'];
  for (const f of files) execFileSync('psql', [...P, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1', '-f', `${root}db/migrations/${f}.sql`], QUIET);
  execFileSync('psql', [...P, '-d', db, '-q', '-c', `create table schema_migrations (version text primary key, applied_at timestamptz not null default now()); insert into schema_migrations(version) values ${files.map((f) => `('${f}')`).join(',')}`], QUIET);
  const q = (sql) => psql(sql, db);
  q(`insert into categories (name, position) values ('Combos', 0), ('Energéticos', 1)`);
  const cat = (name) => q(`select id from categories where name = ${lit(name)}`);
  const mkp = (name, price, category, extra = '') => q(`insert into products (name, price, category_id${extra ? ', swap_base_product_id' : ''}) values (${lit(name)}, ${price}, ${lit(cat(category))}${extra}) returning id`);
  const jack = mkp('Energético Jack Power 2L', 12, 'Energéticos');
  const tropical = mkp('Energético Tropical 2L', 14, 'Energéticos');
  const combo = mkp('COMBO ( 1 Energético Jack Power 2L )', 90, 'Combos', `, ${lit(jack)}`);
  q(`update store_settings set orders_paused = false, opening_hours = ${lit(JSON.stringify(ALL_DAYS))}::jsonb`);
  let n17 = 0;
  const buy = (swap) => JSON.parse(q(`select create_order(${lit(JSON.stringify({ age_confirmed: true, customer_name: 'Cliente 17', customer_phone: `3499000${String(1000 + ++n17)}`, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: combo, quantity: 1, ...(swap ? { swap_to: tropical } : {}) }] }))}::jsonb)`));
  const before = buy(true);
  check('antes da 0018 (banco de hoje): a troca já cobra a diferença pelo produto escolhido (90 + 2 = 92)', before.total === 92, before);
  const out = execFileSync('node', ['tests/with-neon-proxy.mjs', 'scripts/migrate.mjs'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TEST_PG_URL: `postgres://postgres@127.0.0.1:5433/${db}` } });
  check('migrate.mjs aplica a 0018 e as seguintes (0019), nenhuma das antigas', /aplicada: 0018_swap_options/.test(out) && /aplicada: 0019_email_deliverability/.test(out) && !/aplicada: 00(0|1[0-7])/.test(out), out);
  // A 0019 (e-mails) sobre um banco de produção que já tem pedidos: não enfileira nada para eles e os gatilhos ficam instalados.
  check('a 0019 não cria e-mail nenhum para os pedidos que já existiam (sem retroativo)', q('select count(*) from email_messages') === '0' && q("select count(*) from pg_trigger where tgname in ('order_status_history_email', 'orders_payment_email')") === '2');
  check('o pedido que já existia, o combo e o energético escolhido para ele continuam como estavam', q(`select count(*) from order_items where swap_to_product_id = ${lit(tropical)} and unit_price = 92`) === '1' && q(`select swap_base_product_id from products where id = ${lit(combo)}`) === jack);
  const after = buy(true);
  check('depois da 0018: o mesmo pedido de troca dá o mesmo preço (combo sem lista nem valor digitado = como antes)', after.total === 92 && after.items[0].unit_price === 92, after);
  check('...e o pedido sem troca também (90)', buy(false).total === 90);
  check('pedido SEM e-mail (nem conta) não gera e-mail: a fila continua vazia', q('select count(*) from email_messages') === '0');
  const withMail = JSON.parse(q(`select create_order(${lit(JSON.stringify({ age_confirmed: true, customer_name: 'Cliente 17', customer_phone: '34990009999', customer_email: 'Cliente17@Exemplo.com', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: combo, quantity: 1 }] }))}::jsonb)`));
  check('pedido COM e-mail: um único e-mail "pedido recebido" enfileirado, para o endereço normalizado, ligado ao pedido, só com o id na receita', q(`select count(*) || ':' || min(kind) || ':' || min(recipient_email) || ':' || min(status) from email_messages where order_id = (select id from orders where order_number = ${withMail.order_number})`) === '1:order_received:cliente17@exemplo.com:queued' && q(`select jsonb_object_keys(spec) from email_messages limit 1`) === 'order_id');
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
section('3b. Painel: valor do energético do combo e lista de energéticos da troca (migration 0018)');
const eqE = await mk('Energético Baly Uva 2L', 15, catEnergy, { stock: 80 });
const proE = await mk('Energético Premium 2L', 18.5, catEnergy, { stock: 80 });
const cheapE = await mk('Energético Barato 2L', 9, catEnergy, { stock: 80 });
const lata = await mk('Energético Lata 473ml', 8, catEnergy, { stock: 80 });
const outE = await mk('Energético Fora da Lista 2L', 15, catEnergy, { stock: 80 });
const c4 = await mk('COMBO WHISKY ( 4 gelos, 1 Whisky, 1 Energético Jack Power 2L )', 100, catCombos, { stock: 60 });
const c5 = await mk('COMBO VODKA ( 4 gelos, 1 Vodka, 1 Energético Fusion 2L )', 70, catCombos, { stock: 60 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (ids) => [...ids].sort();
const adminProduct = async (id) => (await owner.get(`/api/admin/products/${id}`)).data.product;
{
  check('produto novo nasce sem valor do energético e sem lista de energéticos', c4.swap_base_price === null && Array.isArray(c4.swap_option_ids) && c4.swap_option_ids.length === 0, c4);
  const price = await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 15 });
  check('o painel guarda o valor do energético que vem no combo (R$ 15,00) sem precisar de um produto do cardápio', price.status === 200 && Number(price.data.product.swap_base_price) === 15 && price.data.product.swap_base_product_id === null, price.data);
  for (const bad of [0, -1, 'abc', true, 2_000_000]) {
    const r = await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: bad });
    check(`valor do energético inválido (${JSON.stringify(bad)}) é recusado (400)`, r.status === 400, r.data);
  }
  check('o valor continua R$ 15,00 depois das recusas', Number((await adminProduct(c4.id)).swap_base_price) === 15);
  check('sem login não muda o valor nem a lista (401)', (await anon.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 1 })).status === 401 && (await anon.patch(`/api/admin/products/${c4.id}`, { swap_option_ids: [eqE.id] })).status === 401);

  const set = await owner.patch(`/api/admin/products/${c4.id}`, { swap_option_ids: [eqE.id, proE.id, cheapE.id, lata.id] });
  check('o painel escolhe os energéticos da troca (lista de 4, inclusive um de 473 ml)', set.status === 200 && same(sorted(set.data.product.swap_option_ids), sorted([eqE.id, proE.id, cheapE.id, lata.id])), set.data);
  const dedupe = await owner.patch(`/api/admin/products/${c5.id}`, { swap_option_ids: [eqE.id, eqE.id, eqE.id.toUpperCase()] });
  check('ids repetidos (ou em maiúsculas) entram uma vez só', dedupe.status === 200 && same(dedupe.data.product.swap_option_ids, [eqE.id]), dedupe.data);
  const before = sorted((await adminProduct(c4.id)).swap_option_ids);
  const rejects = [
    ['lista que não é lista', 'abc', 'swap_options_invalid'], ['id que não é id', ['abc'], 'swap_options_invalid'], ['número no lugar do id', [5], 'swap_options_invalid'],
    ['objeto no lugar do id', [{ id: eqE.id }], 'swap_options_invalid'], ['mais de 60 energéticos', Array.from({ length: 61 }, (_v, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), 'swap_options_invalid'],
    ['o próprio combo na lista', [eqE.id, c4.id], 'swap_options_self'], ['produto que não existe', [eqE.id, '00000000-0000-4000-8000-000000000000'], 'swap_options_missing'],
  ];
  for (const [name, value, code] of rejects) {
    const r = await owner.patch(`/api/admin/products/${c4.id}`, { swap_option_ids: value });
    check(`lista recusada: ${name} (400 ${code})`, r.status === 400 && r.data.code === code, r.data);
  }
  check('...e a lista de antes continuou igual (tudo ou nada)', same(sorted((await adminProduct(c4.id)).swap_option_ids), before));
  const rename = await owner.patch(`/api/admin/products/${c4.id}`, { description: 'Whisky com energético' });
  check('editar outro campo sem mandar a lista não mexe nela', rename.status === 200 && same(sorted(rename.data.product.swap_option_ids), before));
  const listed = (await owner.get('/api/admin/products')).data.products;
  check('a lista de produtos do painel traz o valor e a lista de cada combo', same(sorted(listed.find((p) => p.id === c4.id).swap_option_ids), before) && Number(listed.find((p) => p.id === c4.id).swap_base_price) === 15 && Array.isArray(listed.find((p) => p.id === jack.id).swap_option_ids));
  const pub = (await anon.get('/api/products')).data.products;
  const pc4 = pub.find((p) => p.id === c4.id);
  check('o site recebe o valor e a lista de cada produto (/api/products)', Number(pc4.swap_base_price) === 15 && same(sorted(pc4.swap_option_ids), before) && pub.find((p) => p.id === c1.id).swap_base_price === null && same(pub.find((p) => p.id === c1.id).swap_option_ids, []), pc4);
  const log = (await owner.get('/api/admin/audit?entity=product&limit=60')).data.entries.map((e) => e.summary).join(' | ');
  check('as mudanças ficam no histórico: valor do energético e energéticos da troca', /valor do energético do combo/.test(log) && /energéticos da troca: 0|energéticos da troca: todos de 2L → 4/.test(log), log);
  const dup = await owner.post(`/api/admin/products/${c4.id}/duplicate`);
  const dupFull = await adminProduct(dup.data.product.id);
  check('duplicar o combo leva o valor e a lista junto', dup.status === 201 && Number(dupFull.swap_base_price) === 15 && same(sorted(dupFull.swap_option_ids), before), dupFull);
  await owner.del(`/api/admin/products/${dup.data.product.id}`);
  const temp = await mk('Energético Provisório 2L', 11, catEnergy, { stock: 5 });
  await owner.patch(`/api/admin/products/${c5.id}`, { swap_option_ids: [eqE.id, temp.id] });
  const del = await owner.del(`/api/admin/products/${temp.id}`);
  check('apagar um energético da lista tira ele da lista do combo (sem erro)', del.status === 200 && same((await adminProduct(c5.id)).swap_option_ids, [eqE.id]), del.data);
  const clear = await owner.patch(`/api/admin/products/${c5.id}`, { swap_option_ids: [], swap_base_price: null });
  check('lista vazia e valor null limpam (volta a valer qualquer energético de 2L)', clear.status === 200 && clear.data.product.swap_option_ids.length === 0 && clear.data.product.swap_base_price === null, clear.data);
  const nul = await owner.patch(`/api/admin/products/${c5.id}`, { swap_option_ids: null });
  check('swap_option_ids null também limpa', nul.status === 200 && nul.data.product.swap_option_ids.length === 0);
  const created = await owner.post('/api/admin/products', { name: 'COMBO CRIADO COM LISTA', price: 55, category_id: catCombos.id, swap_base_price: 13.5, swap_option_ids: [eqE.id, proE.id], confirm_duplicate: true });
  check('cadastrar um combo já com valor e lista', created.status === 201 && Number(created.data.product.swap_base_price) === 13.5 && same(sorted(created.data.product.swap_option_ids), sorted([eqE.id, proE.id])), created.data);
  const badCreate = await owner.post('/api/admin/products', { name: 'COMBO COM LISTA RUIM', price: 55, category_id: catCombos.id, swap_option_ids: ['00000000-0000-4000-8000-000000000000'], confirm_duplicate: true });
  check('cadastro com energético que não existe: 400 e nada criado', badCreate.status === 400 && !(await owner.get('/api/admin/products')).data.products.some((p) => p.name === 'COMBO COM LISTA RUIM'), badCreate.data);
  await owner.del(`/api/admin/products/${created.data.product.id}`);
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
section('6b. Valor do energético do combo e lista da troca: o preço e as recusas vêm do banco');
{
  // c4: o energético do combo (R$ 15,00) não é um produto do cardápio; o painel liberou 4 energéticos
  const priced = async (swap, qty = 1) => {
    const r = await buyer().post('/api/orders', order([{ product_id: c4.id, quantity: qty, swap_to: swap.id }]));
    return { r, item: r.data.order?.items?.[0] };
  };
  let t = await priced(eqE);
  check('mesmo valor do energético do combo (R$ 15 = R$ 15): mantém o preço do combo (R$ 100,00) e diz "sem diferença"', t.r.status === 201 && t.item.unit_price === 100 && /troca do energético por Energético Baly Uva 2L \(sem diferença\)/.test(t.item.product_name), t.r.data);
  t = await priced(proE, 2);
  check('mais caro (R$ 18,50 − R$ 15,00): paga a diferença de R$ 3,50 → R$ 103,50 por combo', t.r.status === 201 && t.item.unit_price === 103.5 && t.item.quantity === 2 && t.r.data.order.subtotal === 207 && /\(\+ R\$ 3,50\)/.test(t.item.product_name), t.r.data);
  t = await priced(cheapE);
  check('mais barato (R$ 9 < R$ 15): o preço não cai (R$ 100,00)', t.r.status === 201 && t.item.unit_price === 100 && /\(sem diferença\)/.test(t.item.product_name), t.r.data);
  t = await priced(lata);
  check('a lista do painel vale mesmo para um energético que não é de 2L (473 ml, R$ 8): R$ 100,00', t.r.status === 201 && t.item.unit_price === 100, t.r.data);

  // Promoções: a do energético novo conta; o valor digitado é o que o painel mandou
  await owner.patch(`/api/admin/products/${proE.id}`, { promo_price: 16 });
  t = await priced(proE);
  check('energético novo em promoção (R$ 16,00): a diferença é R$ 1,00 → R$ 101,00', t.item.unit_price === 101 && /\(\+ R\$ 1,00\)/.test(t.item.product_name), t.r.data);
  await owner.patch(`/api/admin/products/${proE.id}`, { promo_price: null });
  await owner.patch(`/api/admin/products/${eqE.id}`, { promo_price: 12 });
  t = await priced(eqE);
  check('promoção do energético novo abaixo do valor do combo: continua R$ 100,00 (sem desconto)', t.item.unit_price === 100, t.r.data);
  await owner.patch(`/api/admin/products/${eqE.id}`, { promo_price: null });

  // O painel muda o valor: o pedido seguinte já usa o novo
  await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 20 });
  t = await priced(proE);
  check('painel muda o valor do energético do combo para R$ 20: o Premium (R$ 18,50) passa a não ter diferença', t.item.unit_price === 100 && /\(sem diferença\)/.test(t.item.product_name), t.r.data);
  await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 10 });
  t = await priced(eqE);
  check('...e para R$ 10: o de R$ 15 passa a custar R$ 5,00 a mais (R$ 105,00)', t.item.unit_price === 105, t.r.data);
  await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 15 });

  // Paridade das contas do banco com as do site, em vários pares (base, novo, promoção do novo)
  const pairs = [[15, 15, null], [15, 18.5, null], [15, 9, null], [9.7, 9.9, null], [0.1, 0.3, null], [12.34, 12.35, null], [20, 25, 21.05], [15, 18, 14], [7.99, 8, null]];
  const bad = [];
  for (const [basePrice, newPrice, promo] of pairs) {
    await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: basePrice });
    await owner.patch(`/api/admin/products/${eqE.id}`, { price: newPrice, promo_price: promo });
    const got = await priced(eqE);
    const want = Math.round(10000 + combo.swapDifference({ price: newPrice, promoPrice: promo }, basePrice) * 100) / 100;
    if (got.item?.unit_price !== want) bad.push({ basePrice, newPrice, promo, banco: got.item?.unit_price, site: want });
  }
  check(`as ${pairs.length} contas de diferença (valor do combo × energético novo × promoção) dão o mesmo no banco e no site`, bad.length === 0, bad);
  await owner.patch(`/api/admin/products/${eqE.id}`, { price: 15, promo_price: null });
  await owner.patch(`/api/admin/products/${c4.id}`, { swap_base_price: 15 });

  // Recusas
  const s0 = snap();
  const refuse = async (name, combo_, swap, pattern) => {
    const r = await buyer().post('/api/orders', order([{ product_id: combo_.id, quantity: 1, swap_to: swap.id }]));
    check(name, r.status === 400 && pattern.test(r.data.error ?? ''), r.data);
  };
  await refuse('energético de 2L que o painel NÃO liberou para este combo', c4, outE, /um dos energéticos oferecidos/);
  await refuse('outro energético de 2L que existe, mas não está na lista', c4, tropical, /um dos energéticos oferecidos/);
  await refuse('um combo na lista de outro combo também não vale', c4, c1, /um dos energéticos oferecidos/);
  await refuse('combo sem energético definido nem valor, mesmo com lista, não aceita troca', c5, eqE, /não aceita troca/);
  await owner.patch(`/api/admin/products/${c5.id}`, { swap_option_ids: [tropical.id] });
  await refuse('lista só com o Tropical, mas sem energético definido: não aceita troca', c5, tropical, /não aceita troca/);
  // Produto escolhido + valor digitado: o produto manda; a lista pode incluir o próprio energético do combo, mas ele nunca vale como troca
  await owner.patch(`/api/admin/products/${c5.id}`, { swap_base_product_id: jack.id, swap_base_price: 99, swap_option_ids: [tropical.id, jack.id] });
  await refuse('o energético que já vem no combo, mesmo estando na lista, não vale', c5, jack, /diferente do que já vem/);
  await refuse('Baly (2L, mas fora da lista deste combo)', c5, baly, /um dos energéticos oferecidos/);
  const both = await buyer().post('/api/orders', order([{ product_id: c5.id, quantity: 1, swap_to: tropical.id }]));
  check('com o produto E o valor preenchidos, vale o preço do produto (Jack R$ 12 → Tropical R$ 14 = + R$ 2,00), não o valor digitado (R$ 99)', both.status === 201 && both.data.order.items[0].unit_price === 72, both.data);
  check('nada foi criado nas recusas (só o pedido válido acima entrou)', ordersCount() === s0.orders + 1);
  await owner.patch(`/api/admin/products/${c5.id}`, { swap_base_product_id: null, swap_base_price: null, swap_option_ids: [] });

  // Total conferido com valor digitado + estoque do energético novo
  const stock0 = Number(stockOf(proE.id));
  const sure = await buyer().post('/api/orders', order([{ product_id: c4.id, quantity: 1, swap_to: proE.id }], { expected_total: '103.50' }));
  check('total conferido bate com a troca (R$ 103,50): 201 e o estoque do energético novo desceu 1', sure.status === 201 && Number(stockOf(proE.id)) === stock0 - 1, sure.data);
  const stale = await buyer().post('/api/orders', order([{ product_id: c4.id, quantity: 1, swap_to: proE.id }], { expected_total: '100.00' }));
  check('total visto sem a diferença (R$ 100,00): 409 price_changed com o total de agora (R$ 103,50)', stale.status === 409 && stale.data.code === 'price_changed' && stale.data.total === 103.5, stale.data);
  const id = (await owner.get(`/api/admin/orders/${sure.data.order.order_number}`)).data.order.id;
  await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled' });
  check('cancelar devolve o estoque do energético da troca', Number(stockOf(proE.id)) === stock0);
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
