// Venda responsável de bebidas alcoólicas (18+) e cancelamento do pedido pelo cliente (migration 0027).
//  • produto "alcoólico" (padrão sim), declaração de maioridade exigida NO BANCO (pedido direto à API ou ao banco não contorna), nada de data de
//    nascimento ou documento guardado; entrega só concluída com a conferência do documento, registrada; entrega recusada cancela com o motivo;
//  • cancelamento pelo cliente (código de acompanhamento ou conta): só até a loja confirmar e sem dinheiro recebido, estoque devolvido UMA vez,
//    histórico com quem/quando/motivo/estado anterior, e-mail de cancelamento, sem acesso a pedido de outra pessoa, limite de tentativas.
// usage: bash tests/fresh.sh && node tests/api-test28.mjs      (BASE e TEST_DB escolhem o servidor e o banco, p. ex. numa pilha isolada)
import { execFileSync } from 'node:child_process';
import { Client, check, mailsTo, registerVerified, section, summary } from './lib.mjs';

const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const owner = new Client(undefined, '198.51.100.28');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client();

const cat = (await owner.post('/api/admin/categories', { name: 'Maioridade' })).data.category;
const mk = async (name, price, extra = {}) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, ...extra })).data.product;
const beer = await mk('Cerveja Teste 18', 8, { stock: 50 });
const soda = await mk('Refrigerante Teste', 6, { stock: 50, alcoholic: false });
const stockOf = (id) => Number(psql(`select stock from products where id = ${lit(id)}`));

let ip = 40;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const order = (items, extra = {}) => ({ customer_name: 'Comprador 18', customer_phone: `3498${String(1000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix', items, ...extra });
const idOf = (number) => psql(`select id from orders where order_number = ${number}`);
const row = (number, cols) => psql(`select ${cols} from orders where order_number = ${number}`);
const historyOf = (number) => psql(`select coalesce(string_agg(coalesce(h.from_status, '-') || '>' || h.to_status || '|' || coalesce(h.changed_by_name, '') || '|' || coalesce(h.reason, ''), ' ; ' order by h.created_at), '') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${number}`);

// ------------------------------------------------------------------------------------------------
section('1. Produto: "bebida alcoólica" (padrão sim), editável só no painel, vai para o site e para a cópia');
{
  check('produto novo nasce alcoólico (o lado seguro)', beer.alcoholic === true, beer.alcoholic);
  check('criar já sem álcool', soda.alcoholic === false);
  const pub = (await anon.get('/api/products')).data.products;
  const flag = Object.fromEntries(pub.map((p) => [p.name, p.alcoholic]));
  check('o site recebe a marca de cada produto em /api/products', flag['Cerveja Teste 18'] === true && flag['Refrigerante Teste'] === false, flag);
  check('valor que não é verdadeiro/falso → 400', (await owner.patch(`/api/admin/products/${beer.id}`, { alcoholic: 'nao' })).status === 400 && (await owner.post('/api/admin/products', { name: 'X', price: 5, alcoholic: 0 })).status === 400);
  check('sem login não muda a marca', (await anon.patch(`/api/admin/products/${beer.id}`, { alcoholic: false })).status === 401);
  const dup = await owner.post(`/api/admin/products/${soda.id}/duplicate`);
  check('duplicar copia a marca (a cópia do refrigerante continua sem álcool)', dup.status === 201 && dup.data.product.alcoholic === false, dup.data);
  const dupBeer = await owner.post(`/api/admin/products/${beer.id}/duplicate`);
  check('...e a da cerveja continua alcoólica', dupBeer.status === 201 && dupBeer.data.product.alcoholic === true);
  await owner.del(`/api/admin/products/${dup.data.product.id}`);
  await owner.del(`/api/admin/products/${dupBeer.data.product.id}`);
  const edit = await owner.patch(`/api/admin/products/${soda.id}`, { alcoholic: true });
  const log = (await owner.get('/api/admin/audit?entity=product&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('mudar a marca vale e fica no histórico de atividades', edit.status === 200 && edit.data.product.alcoholic === true && /bebida alcoólica/.test(log), log);
  await owner.patch(`/api/admin/products/${soda.id}`, { alcoholic: false });
}

// ------------------------------------------------------------------------------------------------
section('2. Declaração de maioridade: exigida no banco, uma declaração (não uma prova), nada além dela é guardado');
{
  const before = stockOf(beer.id);
  // `age_confirmed: undefined` (a chave existe, o valor some no JSON): o tests/lib.mjs não declara por padrão, então o servidor recebe o pedido SEM declaração.
  const noAge = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 2 }], { age_confirmed: undefined }));
  check('bebida alcoólica sem a declaração: 400 com o código age_required', noAge.status === 400 && noAge.data.code === 'age_required' && /18 anos/.test(noAge.data.error), noAge.data);
  check('...nada foi criado e o estoque não mexeu', Number(psql('select count(*) from orders')) === 0 && stockOf(beer.id) === before);
  for (const bad of ['true', 'sim', 1, 'on', null, false, {}]) {
    const r = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 1 }], { age_confirmed: bad }));
    check(`declaração com valor que não é o booleano verdadeiro (${JSON.stringify(bad)}) é recusada`, r.status === 400 && r.data.code === 'age_required', r.data);
  }
  check('...nenhum pedido criado por elas', Number(psql('select count(*) from orders')) === 0);

  const ok = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 2 }], { age_confirmed: true, age_text_version: 'v7' }));
  check('com a declaração (booleano verdadeiro): pedido criado', ok.status === 201 && ok.data.order.order_number >= 1001, ok.data);
  const n = ok.data.order.order_number;
  check('o pedido que o cliente vê diz que o documento será conferido', ok.data.order.age_check_required === true);
  check('o banco guarda só: exige conferência, quando declarou e a versão do texto', row(n, 'age_required') === 't' && row(n, 'age_declared_at is not null') === 't' && row(n, 'age_declaration_version') === 'v7', row(n, 'age_required, age_declared_at, age_declaration_version'));
  check('...e nada de documento ou conferência ainda', row(n, 'age_checked_at is null and age_checked_by_name is null') === 't');
  check('o estoque foi reservado (2 unidades)', stockOf(beer.id) === before - 2);
  const cols = psql("select string_agg(column_name, ',') from information_schema.columns where table_name = 'orders' and (column_name ilike '%birth%' or column_name ilike '%nascimento%' or column_name ilike '%cpf%' or column_name ilike '%document%' or column_name ilike '%rg%')");
  check('o pedido não tem nenhuma coluna de data de nascimento, CPF ou documento', cols === '', cols);

  const weird = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 1 }], { age_confirmed: true, age_text_version: 'qualquer coisa; drop table' }));
  check('versão do texto fora do formato (vN) vira "v1" e não entra no banco como veio', weird.status === 201 && row(weird.data.order.order_number, 'age_declaration_version') === 'v1');

  const sodaOnly = await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }]));
  check('pedido só de produto SEM álcool: não pede a declaração', sodaOnly.status === 201 && sodaOnly.data.order.age_check_required === false, sodaOnly.data);
  check('...e não grava declaração nem exige conferência', row(sodaOnly.data.order.order_number, 'age_required or age_declared_at is not null') === 'f');
  const mixed = await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }, { product_id: beer.id, quantity: 1 }], { age_confirmed: undefined }));
  check('refrigerante + cerveja: a cerveja decide, a declaração é exigida', mixed.status === 400 && mixed.data.code === 'age_required', mixed.data);

  const key = 'chave-de-envio-0123456789-abcdef';
  const b = buyer();
  const body = order([{ product_id: beer.id, quantity: 1 }], { age_confirmed: true, idempotency_key: key });
  const first = await b.post('/api/orders', body);
  const again = await b.post('/api/orders', body);
  check('repetir o mesmo envio (mesma chave) devolve o MESMO pedido, sem nova reserva de estoque', first.status === 201 && again.status === 200 && again.data.order.order_number === first.data.order.order_number);

  // Direto no banco, sem passar pelo servidor: a regra é do banco.
  let refused = '';
  try {
    psql(`select create_order(${lit(JSON.stringify(order([{ product_id: beer.id, quantity: 1 }])))}::jsonb)`);
  } catch (error) {
    refused = String(error.stderr ?? error.message);
  }
  check('chamando create_order direto no banco, sem a declaração: recusado também', /18 anos/.test(refused), refused);
  const viaSql = JSON.parse(psql(`select create_order(${lit(JSON.stringify(order([{ product_id: beer.id, quantity: 1 }], { age_confirmed: true })))}::jsonb)`));
  check('...e com a declaração entra', viaSql.order_number >= 1001 && viaSql.age_check_required === true);
}

// ------------------------------------------------------------------------------------------------
section('3. Entrega: só concluída com a conferência do documento (registrada); recusada = cancelada com o motivo');
{
  const b = buyer();
  const made = await b.post('/api/orders', order([{ product_id: beer.id, quantity: 3 }], { age_confirmed: true }));
  const n = made.data.order.order_number;
  const id = idOf(n);
  const stockAfterOrder = stockOf(beer.id);
  for (const s of ['confirmed', 'preparing', 'out_for_delivery']) check(`painel: ${s}`, (await owner.patch(`/api/admin/orders/${id}`, { status: s })).status === 200);
  const list = (await owner.get('/api/admin/orders?limit=100')).data.orders.find((o) => o.order_number === n);
  check('o painel recebe a marca "exige conferência" no pedido', list.age_required === true && list.age_checked_at === null);

  const noCheck = await owner.patch(`/api/admin/orders/${id}`, { status: 'delivered', age_checked: undefined });
  check('concluir a entrega SEM a conferência: 409 com o código age_check_required', noCheck.status === 409 && noCheck.data.code === 'age_check_required', noCheck.data);
  check('...e o pedido continua "saiu para entrega"', row(n, 'order_status') === 'out_for_delivery');
  const bad = await owner.patch(`/api/admin/orders/${id}`, { status: 'delivered', age_checked: 'sim' });
  check('conferência que não é verdadeiro/falso → 400', bad.status === 400);
  const falseCheck = await owner.patch(`/api/admin/orders/${id}`, { status: 'delivered', age_checked: false });
  check('age_checked: false também não conclui', falseCheck.status === 409);
  check('sem login não concluí-la nem tentar', (await anon.patch(`/api/admin/orders/${id}`, { status: 'delivered', age_checked: true })).status === 401);

  const done = await owner.patch(`/api/admin/orders/${id}`, { status: 'delivered', age_checked: true });
  check('com a conferência: entregue', done.status === 200 && done.data.order.order_status === 'delivered', done.data);
  check('fica registrado quem conferiu e quando (e só isso)', row(n, 'age_checked_at is not null') === 't' && row(n, 'age_checked_by_name') === 'Dono Teste');
  const log = (await owner.get('/api/admin/audit?entity=order&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('a conferência fica no histórico de atividades do painel', new RegExp(`Conferiu o documento.*#${n}`).test(log), log);
  check('o estoque da venda concluída não volta', stockOf(beer.id) === stockAfterOrder);

  // Pedido sem álcool: nenhuma conferência é pedida.
  const s = await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }]));
  const sid = idOf(s.data.order.order_number);
  for (const st of ['confirmed', 'preparing', 'out_for_delivery']) await owner.patch(`/api/admin/orders/${sid}`, { status: st });
  check('pedido sem bebida alcoólica conclui sem conferência', (await owner.patch(`/api/admin/orders/${sid}`, { status: 'delivered', age_checked: undefined })).status === 200);

  // Entrega recusada
  const r = await buyer().post('/api/orders', order([{ product_id: beer.id, quantity: 4 }], { age_confirmed: true }));
  const rn = r.data.order.order_number;
  const rid = idOf(rn);
  const reserved = stockOf(beer.id);
  for (const st of ['confirmed', 'preparing', 'out_for_delivery']) await owner.patch(`/api/admin/orders/${rid}`, { status: st });
  const longReason = await owner.patch(`/api/admin/orders/${rid}`, { status: 'cancelled', reason: 'x'.repeat(201) });
  check('motivo com mais de 200 caracteres → 400', longReason.status === 400);
  const refuse = await owner.patch(`/api/admin/orders/${rid}`, { status: 'cancelled', reason: 'Entrega recusada: maioridade não comprovada' });
  check('recusar a entrega = cancelar com o motivo', refuse.status === 200 && refuse.data.order.order_status === 'cancelled', refuse.data);
  check('...o estoque volta (4 unidades), uma vez', stockOf(beer.id) === reserved + 4);
  check('...o histórico guarda o estado anterior, quem e o motivo', /out_for_delivery>cancelled\|Dono Teste\|Entrega recusada: maioridade não comprovada/.test(historyOf(rn)), historyOf(rn));
  const again = await owner.patch(`/api/admin/orders/${rid}`, { status: 'cancelled' });
  check('cancelar de novo não devolve o estoque outra vez', again.status === 200 && stockOf(beer.id) === reserved + 4);
  const log2 = (await owner.get('/api/admin/audit?entity=order&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('o cancelamento com o motivo fica no histórico de atividades', new RegExp(`Cancelou o pedido #${rn}: Entrega recusada`).test(log2), log2);
  const det = (await owner.get(`/api/admin/orders/${rn}`)).data;
  check('o painel mostra o motivo no histórico do pedido', det.history.some((h) => h.to_status === 'cancelled' && h.reason === 'Entrega recusada: maioridade não comprovada'));
}

// ------------------------------------------------------------------------------------------------
section('4. Cancelamento pelo cliente (código de acompanhamento): regras, estoque, histórico e e-mail');
{
  const email = 'cliente.cancela@exemplo.com';
  const b = buyer();
  const before = stockOf(beer.id);
  const made = await b.post('/api/orders', order([{ product_id: beer.id, quantity: 5 }], { age_confirmed: true, customer_email: email }));
  const n = made.data.order.order_number;
  const token = made.data.token;
  check('pedido novo: o cliente vê que pode cancelar', made.data.order.cancel.allowed === true && made.data.order.cancel.why === null, made.data.order.cancel);
  check('o estoque foi reservado', stockOf(beer.id) === before - 5);
  const track = (await anon.get(`/api/tracking/${token}`)).data.order;
  check('o acompanhamento por código também diz que pode cancelar', track.cancel.allowed === true);

  check('código malformado: 404 igual ao de pedido que não existe', (await buyer().post('/api/tracking/abc/cancel', {})).status === 404 && (await buyer().post('/api/tracking/ABCDE-FGHJK-MNPQR-STVWX/cancel', {})).status === 404);
  check('o pedido continua intacto depois das tentativas erradas', row(n, 'order_status') === 'new' && stockOf(beer.id) === before - 5);
  check('motivo que não é texto → 400', (await buyer().post(`/api/tracking/${token}/cancel`, { reason: { x: 1 } })).status === 400);
  check('motivo com mais de 200 caracteres → 400', (await buyer().post(`/api/tracking/${token}/cancel`, { reason: 'y'.repeat(201) })).status === 400);
  check('caractere nulo no motivo: 400 (o servidor recusa o corpo)', (await buyer().post(`/api/tracking/${token}/cancel`, { reason: 'a\u0000b' })).status === 400);
  check('...e nada mudou', row(n, 'order_status') === 'new');

  const cancel = await buyer().post(`/api/tracking/${token}/cancel`, { reason: 'Pedi errado\tou quero mudar' });
  check('cancelar com o código: 200 e pedido cancelado', cancel.status === 200 && cancel.data.order.order_status === 'cancelled' && cancel.data.already_cancelled === false, cancel.data);
  check('...agora diz que não há mais o que cancelar', cancel.data.order.cancel.allowed === false && cancel.data.order.cancel.why === 'cancelled');
  check('o estoque volta (5 unidades)', stockOf(beer.id) === before);
  const history = historyOf(n);
  check('o histórico guarda o estado anterior, quem cancelou e o motivo (sem caracteres de controle)', /new>cancelled\|Cliente \(link de acompanhamento\)\|Pedi errado ou quero mudar/.test(history), history);
  const again = await buyer().post(`/api/tracking/${token}/cancel`, {});
  check('cancelar de novo (toque duplo): 200, já cancelado, sem devolver o estoque outra vez', again.status === 200 && again.data.already_cancelled === true && stockOf(beer.id) === before);
  check('...e sem uma segunda linha de histórico', historyOf(n).split(' ; ').length === 2, historyOf(n));
  const seen = (await anon.get(`/api/tracking/${token}`)).data.order;
  check('o acompanhamento mostra o pedido cancelado', seen.order_status === 'cancelled');
  const admin = (await owner.get(`/api/admin/orders/${n}`)).data;
  check('o painel vê o pedido cancelado, com o motivo', admin.order.order_status === 'cancelled' && admin.history.some((h) => h.reason === 'Pedi errado ou quero mudar'));
  let mail = [];
  for (let i = 0; i < 40 && !mail.some((m) => /cancelad/i.test(m.subject ?? '')); i++) {
    await sleep(250);
    mail = await mailsTo(email);
  }
  check('o cliente recebe o e-mail de pedido cancelado', mail.some((m) => /cancelad/i.test(m.subject ?? '')), mail.map((m) => m.subject));

  // O código de um pedido só cancela aquele pedido.
  const a = await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }]));
  const c = await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }]));
  await buyer().post(`/api/tracking/${a.data.token}/cancel`, {});
  check('o código de um pedido cancela só o dele (o outro continua novo)', row(a.data.order.order_number, 'order_status') === 'cancelled' && row(c.data.order.order_number, 'order_status') === 'new');
}

// ------------------------------------------------------------------------------------------------
section('5. Quando o cliente NÃO pode cancelar: a loja já confirmou, entregue, pagamento recebido');
{
  const make = async (extra = {}) => (await buyer().post('/api/orders', order([{ product_id: soda.id, quantity: 1 }], extra))).data;
  for (const [status, why] of [['confirmed', 'in_progress'], ['preparing', 'in_progress'], ['out_for_delivery', 'in_progress']]) {
    const m = await make();
    const id = idOf(m.order.order_number);
    const path = ['confirmed', 'preparing', 'out_for_delivery'];
    for (const s of path.slice(0, path.indexOf(status) + 1)) await owner.patch(`/api/admin/orders/${id}`, { status: s });
    const seen = (await anon.get(`/api/tracking/${m.token}`)).data.order;
    check(`${status}: o acompanhamento diz que não pode cancelar (${why})`, seen.cancel.allowed === false && seen.cancel.why === why, seen.cancel);
    const r = await buyer().post(`/api/tracking/${m.token}/cancel`, {});
    check(`${status}: cancelar é recusado com 409 e o motivo`, r.status === 409 && r.data.code === 'cancel_not_allowed' && r.data.why === why, r.data);
    check(`${status}: o pedido e o estoque não mudam`, row(m.order.order_number, 'order_status') === status);
  }
  const d = await make();
  const did = idOf(d.order.order_number);
  for (const s of ['confirmed', 'preparing', 'out_for_delivery', 'delivered']) await owner.patch(`/api/admin/orders/${did}`, { status: s });
  const rd = await buyer().post(`/api/tracking/${d.token}/cancel`, {});
  check('entregue: 409 (final)', rd.status === 409 && rd.data.why === 'final' && row(d.order.order_number, 'order_status') === 'delivered', rd.data);

  // Pagamento já recebido (dinheiro marcado como pago pela loja): o cancelamento vira conversa com a loja, não automático.
  const p = await make();
  const pid = idOf(p.order.order_number);
  await owner.patch(`/api/admin/orders/${pid}`, { payment_status: 'paid' });
  const seen = (await anon.get(`/api/tracking/${p.token}`)).data.order;
  check('pagamento recebido: o acompanhamento diz "paid" (fale com a loja)', seen.cancel.allowed === false && seen.cancel.why === 'paid', seen.cancel);
  const rp = await buyer().post(`/api/tracking/${p.token}/cancel`, {});
  check('...e o cancelamento automático é recusado (a devolução é combinada com a loja)', rp.status === 409 && rp.data.why === 'paid' && row(p.order.order_number, 'order_status') === 'new', rp.data);
  const canceledByStore = await owner.patch(`/api/admin/orders/${pid}`, { status: 'cancelled', reason: 'Combinado com o cliente' });
  check('a loja cancela esse pedido pelo painel', canceledByStore.status === 200);
  const late = await buyer().post(`/api/tracking/${p.token}/cancel`, {});
  check('depois disso, o cliente que tenta de novo recebe o pedido já cancelado (200)', late.status === 200 && late.data.already_cancelled === true);

  // Código revogado
  const rv = await make();
  const rvid = idOf(rv.order.order_number);
  await owner.post(`/api/admin/orders/${rvid}/tracking-link`, { replace: true });
  const old = await buyer().post(`/api/tracking/${rv.token}/cancel`, {});
  check('código trocado pela loja (revogado) não cancela mais', old.status === 404 && row(rv.order.order_number, 'order_status') === 'new', old.data);
}

// ------------------------------------------------------------------------------------------------
section('6. Cancelamento pela conta: só o pedido da própria conta; o número sozinho nunca basta');
{
  const ana = new Client(undefined, '203.0.113.201');
  const beto = new Client(undefined, '203.0.113.202');
  await registerVerified(ana, { name: 'Ana Cancela', email: 'ana.cancela@exemplo.com', phone: '34 95555-0281', password: 'ana-cancela-senha-123' });
  await registerVerified(beto, { name: 'Beto Cancela', email: 'beto.cancela@exemplo.com', phone: '34 95555-0282', password: 'beto-cancela-senha-123' });
  const before = stockOf(soda.id);
  const made = await ana.post('/api/orders', order([{ product_id: soda.id, quantity: 2 }]));
  const n = made.data.order.order_number;
  check('pedido feito logado fica na conta e pode ser cancelado', made.status === 201 && made.data.order.linked === true && made.data.order.cancel.allowed === true);

  check('sem login: 401', (await anon.post(`/api/account/orders/${n}/cancel`, {})).status === 401);
  const other = await beto.post(`/api/account/orders/${n}/cancel`, {});
  check('outra conta, mesmo sabendo o número: 404 (e o pedido não muda)', other.status === 404 && row(n, 'order_status') === 'new', other.data);
  check('número que não é número: 404', (await ana.post('/api/account/orders/abc/cancel', {})).status === 404);
  check('número que não existe: 404', (await ana.post('/api/account/orders/999999/cancel', {})).status === 404);
  const mine = (await ana.get(`/api/account/orders/${n}`)).data.order;
  check('em "Meus pedidos" o pedido diz que pode cancelar', mine.cancel.allowed === true);
  const ok = await ana.post(`/api/account/orders/${n}/cancel`, { reason: 'Não preciso mais' });
  check('a dona cancela: 200 e cancelado', ok.status === 200 && ok.data.order.order_status === 'cancelled' && ok.data.already_cancelled === false, ok.data);
  check('o estoque volta uma vez', stockOf(soda.id) === before);
  check('o histórico diz que foi a conta', /new>cancelled\|Cliente \(conta\)\|Não preciso mais/.test(historyOf(n)), historyOf(n));
  const twice = await ana.post(`/api/account/orders/${n}/cancel`, {});
  check('de novo: 200 já cancelado, sem devolver o estoque outra vez', twice.status === 200 && twice.data.already_cancelled === true && stockOf(soda.id) === before);
}

// ------------------------------------------------------------------------------------------------
section('7. Abuso: tentativas de cancelamento têm limite por rede');
{
  const abuser = new Client(undefined, '203.0.113.250');
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await abuser.post('/api/tracking/ABCDE-FGHJK-MNPQR-STVWX/cancel', {})).status);
  check('muitas tentativas seguidas: 404 e, depois do limite, 429', codes[0] === 404 && codes.includes(429), codes);
}

summary();
