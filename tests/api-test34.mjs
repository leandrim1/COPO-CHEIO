// Avaliações dos pedidos, entregadores e a rotina automática (migration 0034).
//  • avaliação: só de pedido ENTREGUE, uma vez, pelo link ou pela conta (pedido de outra pessoa dá 404); nasce "aguardando", só vai para o site depois que a loja publica; o
//    público nunca recebe nome, telefone nem número do pedido; moderação pelo painel, registro de atividades, limites de abuso;
//  • entregadores: cadastro, escolha por pedido de ENTREGA, nome gravado no pedido, o cliente vê só o primeiro nome enquanto o pedido está a caminho;
//  • rotina automática (cron): só com o segredo, varre o que venceu, registra a execução.
// usage: bash tests/fresh.sh && node tests/api-test34.mjs      (BASE e TEST_DB escolhem o servidor e o banco)
import { execFileSync } from 'node:child_process';
import { Client, check, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const CRON_SECRET = 'segredo-do-cron-so-de-teste-0123456789';

const owner = new Client(undefined, '198.51.100.70');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.71');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente34@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente34@copocheio.local', 'senha-forte-456');
const anon = new Client(undefined, '198.51.100.72');
const cat = (await owner.post('/api/admin/categories', { name: 'Avaliações' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Cerveja Avaliação', price: 10, category_id: cat.id, stock: 500, alcoholic: false, confirm_duplicate: true })).data.product;
let ip = 80;
let phone = 0;
const place = (client, extra = {}) =>
  client.post('/api/orders', { customer_name: 'Maria Silva Santos', customer_phone: `3495${String(5000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: beer.id, quantity: 1 }], ...extra });
const idOf = (n) => psql(`select id from orders where order_number = ${n}`);
const setStatus = (n, status) => owner.patch(`/api/admin/orders/${idOf(n)}`, { status });
const deliver = async (n) => {
  for (const s of ['confirmed', 'preparing', 'out_for_delivery', 'delivered']) await setStatus(n, s);
};

// ------------------------------------------------------------------------------------------------
section('1. Avaliação: só depois de entregue, uma vez, pelo link');
const buyer = new Client(undefined, `203.0.113.${ip++}`);
const o1 = await place(buyer);
const n1 = o1.data.order.order_number;
const t1 = o1.data.token;
let review;
{
  const before = await anon.get(`/api/tracking/${t1}/review`);
  check('antes de entregar: delivered = false e sem avaliação', before.status === 200 && before.data.delivered === false && before.data.review === null, before.data);
  const early = await anon.post(`/api/tracking/${t1}/review`, { rating: 5 });
  check('avaliar antes de entregar: 400 ("depois que ele for entregue")', early.status === 400 && /depois que ele for entregue/.test(early.data.error), early.data);
  await deliver(n1);
  const bad = async (name, body) => check(`recusa: ${name}`, (await anon.post(`/api/tracking/${t1}/review`, body)).status === 400, body);
  await bad('sem nota', {});
  await bad('nota 0', { rating: 0 });
  await bad('nota 6', { rating: 6 });
  await bad('nota decimal', { rating: 2.5 });
  await bad('nota em texto', { rating: 'cinco' });
  await bad('comentário que não é texto', { rating: 4, comment: { x: 1 } });
  await bad('comentário com mais de 500 letras', { rating: 4, comment: 'x'.repeat(501) });
  check('nenhuma avaliação inválida foi gravada', psql('select count(*) from order_reviews') === '0');

  const ok = await anon.post(`/api/tracking/${t1}/review`, { rating: 5, comment: '  Chegou geladinha! <b>top</b>\u0007  ' });
  review = ok.data.review;
  check('avaliar o pedido entregue: 201, nasce "aguardando"', ok.status === 201 && review.rating === 5 && review.status === 'pending' && review.already === false, ok.data);
  check('o comentário é texto puro (sem controle) e fica como veio', review.comment === 'Chegou geladinha! <b>top</b>', review.comment);
  const again = await anon.post(`/api/tracking/${t1}/review`, { rating: 1, comment: 'mudei de ideia' });
  check('avaliar de novo: 200 e devolve a avaliação que já existe (não troca)', again.status === 200 && again.data.review.already === true && again.data.review.rating === 5, again.data);
  check('o banco tem uma única avaliação', psql('select count(*) from order_reviews') === '1');
  const read = await anon.get(`/api/tracking/${t1}/review`);
  check('GET devolve a avaliação do próprio pedido', read.data.delivered === true && read.data.review.rating === 5);

  {
    // Cliente com outra rede: o anon acima já gastou o limite de avaliações (10 em 10 minutos por rede) com os pedidos inválidos deste teste.
    const stranger = new Client(undefined, `203.0.113.${ip++}`);
    check('código de acompanhamento errado: 404 (mesma resposta de "pedido não encontrado")', (await stranger.get('/api/tracking/AAAAA-BBBBB-CCCCC-DDDDD/review')).status === 404 && (await stranger.post('/api/tracking/AAAAA-BBBBB-CCCCC-DDDDD/review', { rating: 5 })).status === 404);
  }
  const other = await place(new Client(undefined, `203.0.113.${ip++}`));
  check('o código de OUTRO pedido não mostra a avaliação deste', (await anon.get(`/api/tracking/${other.data.token}/review`)).data.review === null);
}

// ------------------------------------------------------------------------------------------------
section('2. Avaliação pela conta (pedido de outra pessoa dá 404)');
{
  const ana = new Client(undefined, `203.0.113.${ip++}`);
  const bia = new Client(undefined, `203.0.113.${ip++}`);
  await registerVerified(ana, { name: 'Ana Avalia', email: 'ana.avalia@exemplo.com', phone: '34981120001', password: 'senha-forte-123' });
  await registerVerified(bia, { name: 'Bia Avalia', email: 'bia.avalia@exemplo.com', phone: '34981120002', password: 'senha-forte-123' });
  const mine = await place(ana);
  const n = mine.data.order.order_number;
  check('antes de entregar, pela conta: 400', (await ana.post(`/api/account/orders/${n}/review`, { rating: 4 })).status === 400);
  await deliver(n);
  check('a Bia não vê nem avalia o pedido da Ana (404)', (await bia.get(`/api/account/orders/${n}/review`)).status === 404 && (await bia.post(`/api/account/orders/${n}/review`, { rating: 1 })).status === 404);
  const r = await ana.post(`/api/account/orders/${n}/review`, { rating: 4, comment: 'Bom' });
  check('a Ana avalia o seu pedido pela conta: 201', r.status === 201 && r.data.review.rating === 4, r.data);
  check('sem login: 401', (await anon.post(`/api/account/orders/${n}/review`, { rating: 4 })).status === 401);
}

// ------------------------------------------------------------------------------------------------
section('3. Moderação: só o que a loja publica chega ao site, sem dado pessoal');
{
  check('sem login: 401; o público não vê nada ainda', (await anon.get('/api/admin/reviews')).status === 401 && (await anon.get('/api/reviews')).data.reviews.length === 0);
  const list = (await staff.get('/api/admin/reviews?status=pending')).data;
  check('atendente (admin) vê as 2 aguardando e o resumo', list.reviews.length === 2 && list.summary.pending === 2 && list.summary.total === 2 && list.summary.published === 0, list.summary);
  check('...com o número do pedido (para a loja conversar) e sem exigir mais nada', list.reviews.every((v) => v.order_number > 0 && v.status === 'pending'));
  check('situação inválida no filtro: 400', (await staff.get('/api/admin/reviews?status=banana')).status === 400);
  const id = list.reviews.find((v) => v.order_number === n1).id;
  check('situação inválida ao moderar: 400', (await staff.patch(`/api/admin/reviews/${id}`, { status: 'qualquer' })).status === 400);
  check('sem login não modera: 401', (await anon.patch(`/api/admin/reviews/${id}`, { status: 'published' })).status === 401);
  const pub = await staff.patch(`/api/admin/reviews/${id}`, { status: 'published' });
  check('publicar: 200', pub.status === 200 && pub.data.review.status === 'published', pub.data);
  const open = (await anon.get('/api/reviews')).data;
  check('o público vê 1 avaliação, média 5 e contagem 1', open.reviews.length === 1 && open.summary.count === 1 && open.summary.average === 5, open);
  const leak = JSON.stringify(open);
  check('o público NÃO recebe nome, telefone, e-mail nem número do pedido', !/Maria|Silva|3495|order_number|customer|phone|@/.test(leak), leak);
  check('...só nota, comentário e data', Object.keys(open.reviews[0]).sort().join() === 'comment,created_at,rating');
  check('a página do cliente mostra a situação "publicada" da própria avaliação', (await anon.get(`/api/tracking/${t1}/review`)).data.review.status === 'published');
  const hide = await staff.patch(`/api/admin/reviews/${id}`, { status: 'hidden' });
  check('esconder: some do site', hide.status === 200 && (await anon.get('/api/reviews')).data.reviews.length === 0);
  check('o registro de atividades guarda a moderação', /Avaliação do pedido #\d+: (publicada|escondida)/.test(psql("select string_agg(summary, ' | ') from audit_log where action = 'review.moderate'")));
  const del = await staff.del(`/api/admin/reviews/${id}`);
  check('apagar: 200 e depois 404', del.status === 200 && (await staff.del(`/api/admin/reviews/${id}`)).status === 404 && psql('select count(*) from order_reviews') === '1');
  check('...e fica no registro', psql("select count(*) from audit_log where action = 'review.delete'") === '1');
  check('o pedido apagado da avaliação pode ser avaliado de novo (a avaliação sumiu)', (await new Client(undefined, `203.0.113.${ip++}`).post(`/api/tracking/${t1}/review`, { rating: 3 })).status === 201);
}

section('4. Limite de abuso nas avaliações');
{
  const spam = new Client(undefined, '198.51.100.99');
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await spam.post(`/api/tracking/${t1}/review`, { rating: 5 })).status);
  check('muitas tentativas pela mesma rede: 429 depois de 10', codes.slice(0, 10).every((c) => c !== 429) && codes.slice(10).some((c) => c === 429), codes);
}

// ------------------------------------------------------------------------------------------------
section('5. Entregadores');
let joao;
{
  check('sem login: 401', (await anon.get('/api/admin/couriers')).status === 401);
  const bad = async (name, body) => check(`recusa: ${name}`, (await staff.post('/api/admin/couriers', body)).status === 400, body);
  await bad('nome curto', { name: 'J' });
  await bad('nome longo', { name: 'x'.repeat(61) });
  await bad('telefone inválido', { name: 'João', phone: '123' });
  const made = await staff.post('/api/admin/couriers', { name: 'João da Moto Silva', phone: '(34) 99999-1111' });
  joao = made.data.courier;
  check('atendente cadastra o entregador (telefone só com números)', made.status === 201 && joao.phone === '34999991111' && joao.active === true, made.data);
  const maria = (await staff.post('/api/admin/couriers', { name: 'Maria Entregas' })).data.courier;
  check('a lista traz os dois', (await staff.get('/api/admin/couriers')).data.couriers.length === 2);

  const d = await place(new Client(undefined, `203.0.113.${ip++}`), { delivery_type: 'delivery', address: 'Rua A', address_number: '1', neighborhood: 'Centro' });
  const nd = d.data.order.order_number;
  const idd = idOf(nd);
  check('pedido de entrega criado', d.status === 201, d.data);
  const asg = await staff.patch(`/api/admin/orders/${idd}/courier`, { courier_id: joao.id });
  check('escolher o entregador do pedido: 200 e o nome fica gravado no pedido', asg.status === 200 && asg.data.order.courier_name === 'João da Moto Silva' && psql(`select courier_name from orders where order_number = ${nd}`) === 'João da Moto Silva', asg.data);
  check('antes de sair para entrega o cliente NÃO vê o entregador', (await anon.get(`/api/tracking/${d.data.token}`)).data.order.courier_name === undefined);
  for (const s of ['confirmed', 'preparing', 'out_for_delivery']) await setStatus(nd, s);
  const mid = (await anon.get(`/api/tracking/${d.data.token}`)).data.order;
  check('a caminho: o cliente vê só o PRIMEIRO nome ("João")', mid.courier_name === 'João', mid.courier_name);
  check('...e nada do telefone', !JSON.stringify(mid).includes('34999991111'));
  const list = (await staff.get('/api/admin/couriers')).data.couriers.find((c) => c.id === joao.id);
  check('a lista mostra 1 entrega a caminho com ele', list.on_route === 1, list);
  await setStatus(nd, 'delivered');
  check('depois de entregue o cliente deixa de ver o entregador', (await anon.get(`/api/tracking/${d.data.token}`)).data.order.courier_name === undefined);
  check('o painel continua mostrando o nome no pedido', (await owner.get(`/api/admin/orders/${nd}`)).data.order.courier_name === 'João da Moto Silva');

  const pickup = await place(new Client(undefined, `203.0.113.${ip++}`));
  check('pedido de RETIRADA não tem entregador: 409', (await staff.patch(`/api/admin/orders/${idOf(pickup.data.order.order_number)}/courier`, { courier_id: joao.id })).status === 409);
  const canc = await place(new Client(undefined, `203.0.113.${ip++}`), { delivery_type: 'delivery', address: 'Rua B', address_number: '2', neighborhood: 'Centro' });
  const idc = idOf(canc.data.order.order_number);
  await owner.patch(`/api/admin/orders/${idc}`, { status: 'cancelled' });
  check('pedido cancelado não tem entregador: 409', (await staff.patch(`/api/admin/orders/${idc}/courier`, { courier_id: joao.id })).status === 409);
  const off = await staff.patch(`/api/admin/couriers/${maria.id}`, { active: false });
  const open = await place(new Client(undefined, `203.0.113.${ip++}`), { delivery_type: 'delivery', address: 'Rua C', address_number: '3', neighborhood: 'Centro' });
  check('entregador desativado não pode ser escolhido: 409', off.status === 200 && (await staff.patch(`/api/admin/orders/${idOf(open.data.order.order_number)}/courier`, { courier_id: maria.id })).status === 409);
  check('entregador que não existe: 404; id inválido: 400', (await staff.patch(`/api/admin/orders/${idOf(open.data.order.order_number)}/courier`, { courier_id: '00000000-0000-4000-8000-000000000000' })).status === 404 && (await staff.patch(`/api/admin/orders/${idOf(open.data.order.order_number)}/courier`, { courier_id: 'x' })).status === 400);
  check('tirar o entregador do pedido (courier_id nulo)', (await staff.patch(`/api/admin/orders/${idd}/courier`, { courier_id: null })).data.order.courier_name === null);

  await staff.patch(`/api/admin/orders/${idd}/courier`, { courier_id: joao.id });
  const rm = await staff.del(`/api/admin/couriers/${joao.id}`);
  check('remover o entregador: 200, mas o pedido antigo mantém o NOME gravado', rm.status === 200 && psql(`select courier_name || '|' || coalesce(courier_id::text, 'sem-id') from orders where order_number = ${nd}`) === 'João da Moto Silva|sem-id');
  check('o registro de atividades guarda cadastro, escolha e remoção', Number(psql("select count(*) from audit_log where action in ('courier.create', 'order.courier', 'courier.delete')")) >= 5);
}

// ------------------------------------------------------------------------------------------------
section('6. Rotina automática (cron): só com o segredo, varre o vencido e registra');
{
  check('sem segredo: 401; segredo errado ou em outro formato: 401', (await anon.get('/api/cron/sweep')).status === 401 && (await anon.get('/api/cron/sweep', { headers: { authorization: 'Bearer errado' } })).status === 401 && (await anon.get('/api/cron/sweep', { headers: { authorization: CRON_SECRET } })).status === 401);
  check('o status também exige o segredo', (await anon.get('/api/cron/status')).status === 401);
  check('antes de rodar, não há registro da rotina', (await anon.get('/api/cron/status', { headers: { authorization: `Bearer ${CRON_SECRET}` } })).data.sweep === null);
  const run = await anon.get('/api/cron/sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check('com o segredo: 200 e o resultado da varredura', run.status === 200 && run.data.ok === true && run.data.swept && typeof run.data.swept.closed === 'number', run.data);
  const st = (await anon.get('/api/cron/status', { headers: { authorization: `Bearer ${CRON_SECRET}` } })).data.sweep;
  check('a execução ficou registrada (ok, há poucos segundos)', st && st.ok === true && st.age < 30, st);
  check('o registro guarda um resumo e nenhum segredo', !/segredo|Bearer/.test(psql("select detail from job_runs where name = 'sweep'")));
  const again = await anon.get('/api/cron/sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check('rodar de novo é seguro (idempotente)', again.status === 200 && psql("select count(*) from job_runs where name = 'sweep'") === '1');
}

void lit;
summary();
