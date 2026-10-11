// Acompanhamento permanente de pedidos + contas de clientes (API real contra Postgres).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client, check, lastCode, mailsTo, registerVerified, section, summary } from './lib.mjs';

const psql = (sql) =>
  execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const sha = (s) => createHash('sha256').update(s).digest('hex');
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/;

const owner = new Client();
await owner.login();

// ---- Preparação: loja aberta 24h, uma categoria, produtos --------------------------------------------
const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0 });
const cat = (await owner.post('/api/admin/categories', { name: 'Acompanhamento teste' })).data.category;
const coca = (await owner.post('/api/admin/products', { name: 'Coca 2L', price: 12, category_id: cat.id })).data.product;
const gelo = (await owner.post('/api/admin/products', { name: 'Gelo 5kg', price: 10, category_id: cat.id })).data.product;

const body = (extra = {}) => ({
  customer_name: 'Ana Souza',
  customer_phone: '(34) 98888-1111',
  delivery_type: 'pickup',
  payment_method: 'pix',
  items: [{ product_id: coca.id, quantity: 2 }, { product_id: gelo.id, quantity: 1 }],
  ...extra,
});
const place = async (client, extra) => {
  const r = await client.post('/api/orders', body(extra));
  return { ...r, order: r.data?.order, token: r.data?.token };
};

// ------------------------------------------------------------------------------------------------
section('1. Pedido sem login e código de acompanhamento');
const visitor = new Client();
const A = await place(visitor, { customer_email: 'ana@exemplo.com' });
check('pedido de visitante criado (201)', A.status === 201, A.data);
check('código no formato XXXXX-XXXXX-XXXXX-XXXXX (alfabeto sem O/I/L/U)', TOKEN.test(A.token ?? ''), A.token);
check('o pedido devolvido não traz o código, ids, telefone nem e-mail', !('token' in A.order) && !('id' in A.order) && !('customer_phone' in A.order) && !('customer_email' in A.order) && !('public_token' in A.order), Object.keys(A.order));
check('número público ≥ 1001', A.order.order_number >= 1001, A.order.order_number);
check('pedido de visitante: linked = false', A.order.linked === false);
check('mostra a retenção ao cliente (dias)', A.order.retention_days === 180, A.order.retention_days);
const many = await Promise.all(Array.from({ length: 12 }, (_, i) => place(new Client(), { customer_phone: `3499900${String(1000 + i)}` })));
const tokens = new Set([A.token, ...many.map((m) => m.token)]);
check('códigos são únicos entre pedidos', tokens.size === 13 && many.every((m) => m.status === 201 && TOKEN.test(m.token)));

section('2. Persistência: só o hash do código fica no banco');
{
  const rows = psql(`select token_hash, source from order_tracking_tokens t join orders o on o.id = t.order_id where o.order_number = ${A.order.order_number}`);
  check('banco tem o SHA-256 do código (source checkout)', rows === `${sha(A.token)}|checkout`, rows);
  const dump = execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '--data-only'], { encoding: 'utf8' });
  check('o código em texto puro não existe em nenhuma tabela do banco', !dump.includes(A.token) && !dump.includes(A.token.replace(/-/g, '')), 'achou o código no dump');
  const cols = psql(`select count(*) from information_schema.columns where table_name = 'orders' and column_name = 'public_token'`);
  check('orders.public_token (texto puro) não existe mais', cols === '0');
  const saved = psql(`select order_status, payment_status, subtotal, delivery_fee, discount, total, payment_method, customer_phone, customer_id is null from orders where order_number = ${A.order.order_number}`);
  check('pedido gravado com valores, pagamento, status e sem conta', saved === 'new|pending|34.00|0.00|0.00|34.00|pix|34988881111|t', saved);
  check('itens gravados com preço do momento', psql(`select string_agg(product_name || ':' || quantity || ':' || unit_price, ',' order by product_name) from order_items i join orders o on o.id = i.order_id where o.order_number = ${A.order.order_number}`) === 'Coca 2L:2:12.00,Gelo 5kg:1:10.00');
  check('histórico inicial gravado', psql(`select count(*) from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${A.order.order_number} and h.to_status = 'new'`) === '1');
}

section('3. Acompanhar pelo link, em outro aparelho, e por número + código');
{
  const device2 = new Client(); // sem cookies, outro IP
  const r = await device2.get(`/api/tracking/${A.token}`);
  check('outro aparelho abre o link (sem cookie nem login)', r.status === 200 && r.data.order.order_number === A.order.order_number, r.data);
  check('link é privado: no-store e noindex', /no-store/.test(r.headers.get('cache-control')) && /noindex/.test(r.headers.get('x-robots-tag') ?? ''));
  const variants = [A.token.toLowerCase(), A.token.replace(/-/g, ''), ` ${A.token.replace(/-/g, ' ')} `, A.token.replace(/0/g, 'O').replace(/1/g, 'l')];
  const results = await Promise.all(variants.map((v) => device2.get(`/api/tracking/${encodeURIComponent(v)}`)));
  check('aceita minúsculas, sem hífen, com espaços e O/l no lugar de 0/1', results.every((x) => x.status === 200 && x.data.order.order_number === A.order.order_number), results.map((x) => x.status));
  const l = await device2.post('/api/tracking/lookup', { order_number: `#${A.order.order_number}`, code: A.token.toLowerCase() });
  check('consulta por número (#1001) + código', l.status === 200 && l.data.token === A.token && l.data.order.order_number === A.order.order_number, l.data);
  const l2 = await device2.post('/api/tracking/lookup', { order_number: String(A.order.order_number), code: A.token });
  check('consulta por número sem # também', l2.status === 200);
}

section('4. Código inválido, pedido de outra pessoa, número sozinho');
{
  const B = many[0];
  const x = new Client();
  const wrong = await x.post('/api/tracking/lookup', { order_number: A.order.order_number, code: '00000-00000-00000-00000' });
  const noOrder = await x.post('/api/tracking/lookup', { order_number: 987654, code: A.token });
  const otherPerson = await x.post('/api/tracking/lookup', { order_number: A.order.order_number, code: B.token });
  check('código errado → 404', wrong.status === 404, wrong.data);
  check('código de OUTRO pedido com o número deste → 404', otherPerson.status === 404, otherPerson.data);
  check('pedido inexistente → 404', noOrder.status === 404);
  check('as três respostas são idênticas (não revelam se o pedido existe)', JSON.stringify(wrong.data) === JSON.stringify(noOrder.data) && JSON.stringify(wrong.data) === JSON.stringify(otherPerson.data), [wrong.data, noOrder.data, otherPerson.data]);
  check('número do pedido sozinho não dá acesso (GET /api/tracking/1001 → 404)', (await x.get(`/api/tracking/${A.order.order_number}`)).status === 404);
  check('rota antiga /api/orders/:código não existe mais', [404, 405].includes((await x.get(`/api/orders/${A.token}`)).status));
  check('consulta sem código → 400', (await x.post('/api/tracking/lookup', { order_number: A.order.order_number })).status === 400);
  check('consulta sem número → 400', (await x.post('/api/tracking/lookup', { code: A.token })).status === 400);
  check('número com letras → 400', (await x.post('/api/tracking/lookup', { order_number: '10x1', code: A.token })).status === 400);
  check('código com tamanho errado → 400 (formato, sem contar tentativa)', (await x.post('/api/tracking/lookup', { order_number: A.order.order_number, code: 'ABC' })).status === 400);
  const inj = await x.post('/api/tracking/lookup', { order_number: A.order.order_number, code: "'; drop table orders; --" });
  check('texto de ataque no código → 400, tabela intacta', inj.status === 400 && Number(psql('select count(*) from orders')) > 0);
  const inj2 = await x.get(`/api/tracking/${encodeURIComponent("' or '1'='1")}`);
  check("' or '1'='1 como link → 404", inj2.status === 404);
  check('método errado → 405', (await x.req('PUT', `/api/tracking/${A.token}`, {})).status === 405);
  check('corpo que não é JSON → 415', (await x.req('POST', '/api/tracking/lookup', 'x', { raw: true, headers: { 'content-type': 'text/plain' } })).status === 415);
}

section('5. Limite de tentativas contra força bruta');
{
  const brute = new Client(undefined, '198.51.100.77');
  const statuses = [];
  for (let i = 0; i < 33; i++) statuses.push((await brute.get(`/api/tracking/AAAAA-BBBBB-CCCCC-${String(10000 + i).slice(0, 5).replace(/0/g, '2')}`)).status);
  const first429 = statuses.indexOf(429);
  check('30 erros seguidos do mesmo IP → bloqueia com 429', first429 >= 30 && statuses.slice(0, 30).every((s) => s === 404), statuses.join());
  const hit = await brute.get(`/api/tracking/${A.token}`);
  check('durante o bloqueio, nem o código certo responde (quem chuta não descobre acertos)', hit.status === 429, hit.status);
  check('o bloqueio é por IP: outro cliente continua normal', (await new Client().get(`/api/tracking/${A.token}`)).status === 200);
  const polling = new Client(undefined, '198.51.100.88');
  const polled = [];
  for (let i = 0; i < 40; i++) polled.push((await polling.get(`/api/tracking/${A.token}`)).status);
  check('consultas certas (polling da página) nunca são bloqueadas', polled.every((s) => s === 200));
}

section('6. Admin muda o status → a página do cliente muda (e o cliente não consegue mudar)');
{
  const detail = (await owner.get(`/api/admin/orders/${A.order.order_number}`)).data;
  const id = detail.order.id;
  const before = (await new Client().get(`/api/tracking/${A.token}`)).data.order;
  check('começa em NOVO com 1 evento', before.order_status === 'new' && before.history.length === 1);
  await new Promise((r) => setTimeout(r, 1100));
  await owner.patch(`/api/admin/orders/${id}`, { status: 'confirmed' });
  const after = (await new Client().get(`/api/tracking/${A.token}`)).data.order;
  check('cliente vê CONFIRMADO na hora', after.order_status === 'confirmed' && after.history.length === 2 && after.history[1].status === 'confirmed');
  check('updated_at avança com a mudança', new Date(after.updated_at) > new Date(before.updated_at), [before.updated_at, after.updated_at]);
  for (const s of ['preparing', 'out_for_delivery', 'delivered']) await owner.patch(`/api/admin/orders/${id}`, { status: s });
  const done = (await new Client().get(`/api/tracking/${A.token}`)).data.order;
  check('ciclo completo refletido: 5 eventos em ordem', done.order_status === 'delivered' && done.history.map((h) => h.status).join() === 'new,confirmed,preparing,out_for_delivery,delivered', done.history);
  await owner.patch(`/api/admin/orders/${id}`, { payment_status: 'paid' });
  check('pagamento pago aparece para o cliente', (await new Client().get(`/api/tracking/${A.token}`)).data.order.payment_status === 'paid');

  const anon = new Client();
  check('cliente NÃO consegue mudar status (sem login → 401)', (await anon.patch(`/api/admin/orders/${id}`, { status: 'cancelled' })).status === 401);
  check('cliente NÃO consegue mudar pagamento (401)', (await anon.patch(`/api/admin/orders/${id}`, { payment_status: 'paid' })).status === 401);
  check('não existe rota pública para alterar o pedido', [404, 405].includes((await anon.patch(`/api/tracking/${A.token}`, { order_status: 'delivered' })).status) && [404, 405].includes((await anon.post(`/api/tracking/${A.token}`, { order_status: 'delivered' })).status));
  const forged = await place(new Client(), { order_status: 'delivered', payment_status: 'paid', total: 0.01, subtotal: 0.01, discount: 999, delivery_fee: 0, tracking_hash: sha('FALSO'), customer_id: '00000000-0000-4000-8000-000000000000', order_number: 1 });
  check('pedido forjado: status, pagamento, total, desconto e hash enviados pelo cliente são ignorados', forged.order.order_status === 'new' && forged.order.payment_status === 'pending' && forged.order.total === 34 && forged.order.discount === 0 && forged.order.order_number > 1001, forged.order);
  check('o hash injetado não virou código válido', (await anon.get('/api/tracking/FALSO')).status === 404 && psql(`select count(*) from order_tracking_tokens where token_hash = '${sha('FALSO')}'`) === '0');
  check('conta injetada (customer_id) é ignorada', psql(`select customer_id is null from orders where order_number = ${forged.order.order_number}`) === 't');

  const C = await place(new Client(), { customer_phone: '34977776666' });
  const cid = (await owner.get(`/api/admin/orders/${C.order.order_number}`)).data.order.id;
  await owner.patch(`/api/admin/orders/${cid}`, { status: 'cancelled' });
  const cancelled = (await new Client().get(`/api/tracking/${C.token}`)).data.order;
  check('pedido cancelado aparece como cancelado para o cliente', cancelled.order_status === 'cancelled' && cancelled.history.at(-1).status === 'cancelled');
}

section('7. Painel: lista com filtros, tipo de cliente, links de acompanhamento');
{
  const list = await owner.get('/api/admin/orders?limit=100');
  check('lista traz customer_id (visitante = null) e não traz hash/código', list.status === 200 && list.data.orders.every((o) => o.customer_id === null) && !JSON.stringify(list.data).includes(A.token));
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const yesterday = new Date(Date.now() - 86400_000 * 2).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  check('filtro por data (hoje → todos)', (await owner.get(`/api/admin/orders?from=${today}&to=${today}&limit=100`)).data.orders.length === list.data.orders.length);
  check('filtro por data passada → nenhum', (await owner.get(`/api/admin/orders?from=${yesterday}&to=${yesterday}`)).data.orders.length === 0);
  check('data inválida → 400', (await owner.get('/api/admin/orders?from=ontem')).status === 400);
  check('filtro por status + data', (await owner.get(`/api/admin/orders?status=delivered&from=${today}`)).data.orders.length === 1);
  check('filtro visitantes', (await owner.get('/api/admin/orders?account=guest&limit=100')).data.orders.length === list.data.orders.length);
  check('filtro contas → vazio por enquanto', (await owner.get('/api/admin/orders?account=account')).data.orders.length === 0);
  check('filtro de cliente inválido → 400', (await owner.get('/api/admin/orders?account=xx')).status === 400);
  check('busca por e-mail', (await owner.get('/api/admin/orders?q=ana@exemplo')).data.orders.some((o) => o.order_number === A.order.order_number));
  check('busca por telefone', (await owner.get('/api/admin/orders?q=98888-1111')).data.orders.length >= 1);
  check('busca por número', (await owner.get(`/api/admin/orders?q=${A.order.order_number}`)).data.orders.some((o) => o.order_number === A.order.order_number));

  const det = await owner.get(`/api/admin/orders/${A.order.order_number}`);
  check('detalhe lista os links só como metadados (sem código)', det.data.tracking_links.length === 1 && det.data.tracking_links[0].source === 'checkout' && !('token_hash' in det.data.tracking_links[0]) && !JSON.stringify(det.data).includes(A.token));
  check('detalhe diz que é visitante e a retenção', det.data.account === null && det.data.retention_days === 180);

  const id = det.data.order.id;
  check('gerar link sem login → 401', (await new Client().post(`/api/admin/orders/${id}/tracking-link`, {})).status === 401);
  const extra = await owner.post(`/api/admin/orders/${id}/tracking-link`, {});
  check('admin gera link adicional', extra.status === 201 && TOKEN.test(extra.data.token) && extra.data.replaced === 0, extra.data);
  check('link novo funciona e o do cliente continua valendo', (await new Client().get(`/api/tracking/${extra.data.token}`)).status === 200 && (await new Client().get(`/api/tracking/${A.token}`)).status === 200);
  check('detalhe mostra 2 links ativos, um criado por admin com o nome', (await owner.get(`/api/admin/orders/${A.order.order_number}`)).data.tracking_links.filter((l) => !l.revoked_at).length === 2);
  const swap = await owner.post(`/api/admin/orders/${id}/tracking-link`, { replace: true });
  check('"trocar link" invalida os anteriores', swap.status === 201 && swap.data.replaced === 2 && (await new Client().get(`/api/tracking/${A.token}`)).status === 404 && (await new Client().get(`/api/tracking/${extra.data.token}`)).status === 404 && (await new Client().get(`/api/tracking/${swap.data.token}`)).status === 200);
  check('pedido inexistente → 404', (await owner.post('/api/admin/orders/11111111-1111-4111-8111-111111111111/tracking-link', {})).status === 404);
  A.token = swap.data.token; // daqui em diante, o link vigente
  const flood = [];
  for (let i = 0; i < 20; i++) flood.push((await owner.post(`/api/admin/orders/${id}/tracking-link`, {})).status);
  check('limite de links ativos por pedido (20) → 409', flood.slice(0, 19).every((s) => s === 201) && flood[19] === 409, flood.join());
  await owner.post(`/api/admin/orders/${id}/tracking-link`, { replace: true }).then((r) => (A.token = r.data.token));
}

section('8. Retenção: link vence depois do prazo; pedido de conta continua no histórico');
{
  const E = await place(new Client(), { customer_phone: '34966665555' });
  check('link novo vale', (await new Client().get(`/api/tracking/${E.token}`)).status === 200);
  const backdate = (num, days) => psql(`alter table orders disable trigger orders_updated_at; update orders set updated_at = now() - interval '${days} days' where order_number = ${num}; alter table orders enable trigger orders_updated_at;`);
  backdate(E.order.order_number, 181);
  const gone = await new Client().get(`/api/tracking/${E.token}`);
  check('depois de 181 dias sem atualização o link expira (mesma resposta de "não encontrado")', gone.status === 404 && gone.data.error.includes('Não encontramos'), gone.data);
  await owner.patch('/api/admin/store', { tracking_retention_days: 365 });
  check('aumentar a validade nas configurações reabre links dentro do novo prazo', (await new Client().get(`/api/tracking/${E.token}`)).status === 200);
  check('validade fora do permitido → 400', (await owner.patch('/api/admin/store', { tracking_retention_days: 3 })).status === 400);
  await owner.patch('/api/admin/store', { tracking_retention_days: 180 });
  psql('select purge_expired_data()');
  check('limpeza apaga o hash do código vencido (+30 dias) — o pedido fica', psql(`select count(*) from order_tracking_tokens t join orders o on o.id = t.order_id where o.order_number = ${E.order.order_number}`) === '1');
  backdate(E.order.order_number, 220);
  psql('select purge_expired_data()');
  check('passados prazo + 30 dias o hash é removido; o pedido continua no banco', psql(`select count(*) from order_tracking_tokens t join orders o on o.id = t.order_id where o.order_number = ${E.order.order_number}`) === '0' && psql(`select count(*) from orders where order_number = ${E.order.order_number}`) === '1');
}

section('9. Pedidos antigos (migração): o UUID do link /pedido/:id continua valendo');
{
  const L = await place(new Client(), { customer_phone: '34955554444' });
  const uuid = '3f2a9c1e-5b7d-4e8a-9c01-aa11bb22cc33';
  psql(`insert into order_tracking_tokens (order_id, token_hash, source) select id, encode(sha256(convert_to('${uuid}','UTF8')),'hex'), 'legacy' from orders where order_number = ${L.order.order_number}`);
  const x = new Client();
  const r1 = await x.get(`/api/tracking/${uuid}`);
  check('link antigo (UUID) abre o pedido', r1.status === 200 && r1.data.order.order_number === L.order.order_number, r1.data);
  check('UUID em maiúsculas também', (await x.get(`/api/tracking/${uuid.toUpperCase()}`)).status === 200);
  check('número + UUID antigo na consulta', (await x.post('/api/tracking/lookup', { order_number: L.order.order_number, code: uuid })).status === 200);
  check('UUID de outro pedido não abre este por número', (await x.post('/api/tracking/lookup', { order_number: A.order.order_number, code: uuid })).status === 404);

  // Versão anterior do site ainda no ar durante um deploy (ou rollback): create_order sem hash devolve "token" UUID
  const old = JSON.parse(
    psql(`select create_order(jsonb_build_object('customer_name','Compat Antigo','customer_phone','34955553333','delivery_type','pickup','payment_method','pix','items', jsonb_build_array(jsonb_build_object('product_id','${coca.id}','quantity',1))))`),
  );
  check('compat: create_order sem hash (site anterior) devolve token UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(old.token), old.token);
  check('compat: esse UUID abre o pedido na rota nova', (await x.get(`/api/tracking/${old.token}`)).data?.order?.order_number === old.order_number);
  check('compat: get_public_order(uuid) segue respondendo ao site anterior', psql(`select get_public_order('${old.token}'::uuid) ->> 'order_number'`) === String(old.order_number));
  check('o site novo nunca usa o caminho de compatibilidade (o POST sempre devolve código no formato novo)', TOKEN.test((await place(new Client(), { customer_phone: '34955554455' })).token));
}

// ------------------------------------------------------------------------------------------------
section('10. Conta do cliente: cadastro, login e sessão');
const ana = new Client();
let anaProfile;
{
  const reg = (extra = {}) => ({ name: 'Ana Souza', email: 'Ana@Exemplo.com', phone: '(34) 98888-1111', password: 'ana-senha-123', ...extra });
  check('senha curta → 400', (await ana.post('/api/account/register', reg({ password: '123' }))).status === 400);
  check('e-mail inválido → 400', (await ana.post('/api/account/register', reg({ email: 'ana' }))).status === 400);
  check('telefone inválido → 400', (await ana.post('/api/account/register', reg({ phone: '123' }))).status === 400);
  check('nome vazio → 400', (await ana.post('/api/account/register', reg({ name: ' ' }))).status === 400);
  check('sem telefone → 400', (await ana.post('/api/account/register', { name: 'Ana', email: 'x@x.com', password: '12345678' })).status === 400);
  const ok = await ana.post('/api/account/register', reg());
  check('cadastro com nome, e-mail e telefone → 202 pendente (sem sessão; só o cookie secreto do cadastro)', ok.status === 202 && ok.data.status === 'pending_verification' && !ok.data.customer && !ana.cookie.includes('copocheio_cliente='), ok.data);
  const confirm = await ana.post('/api/account/verify-email', { email: 'ana@exemplo.com', code: await lastCode('ana@exemplo.com') });
  check('e-mail confirmado com o código recebido', confirm.status === 200, confirm.data);
  const loginFirst = await ana.post('/api/account/login', { email: 'Ana@Exemplo.com', password: 'ana-senha-123' });
  anaProfile = loginFirst.data.customer;
  check('depois de confirmar, o login abre a conta (nome, e-mail e telefone certos)', loginFirst.status === 200 && anaProfile.email === 'ana@exemplo.com' && anaProfile.phone === '34988881111' && anaProfile.name === 'Ana Souza', loginFirst.data);
  check('resposta nunca traz hash de senha', !JSON.stringify(loginFirst.data).includes('scrypt') && !('password_hash' in anaProfile));
  check('cookie da conta é HttpOnly + SameSite=Lax, separado do painel', /copocheio_cliente=/.test(ana.lastSetCookie) && /HttpOnly/i.test(ana.lastSetCookie) && /SameSite=Lax/i.test(ana.lastSetCookie));
  check('senha guardada com scrypt (nunca em texto)', psql(`select left(password_hash, 7) from customers where lower(email) = 'ana@exemplo.com'`) === 'scrypt$');
  check('e-mail confirmado fica registrado no banco (data) com status active', psql(`select email_verified_at is not null, status from customers where lower(email) = 'ana@exemplo.com'`) === 't|active');
  check('me devolve o perfil', (await ana.get('/api/account/me')).data.customer?.email === 'ana@exemplo.com');
  const again = await new Client().post('/api/account/register', reg({ email: 'ANA@exemplo.COM', password: 'outra-senha-999' }));
  check('cadastrar de novo um e-mail que já tem conta: mesma resposta 202 (não revela que existe)', again.status === 202 && again.data.status === 'pending_verification', again.data);
  check('…e a conta existente não foi alterada (a senha antiga continua valendo)', (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'ana-senha-123' })).status === 200 && (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'outra-senha-999' })).status === 401);
  check('sem cookie, me → customer null (sem erro)', (await new Client().get('/api/account/me')).data.customer === null);
  check('a conta do cliente NÃO abre o painel (401)', (await ana.get('/api/admin/orders')).status === 401);
  check('o login do painel NÃO vira conta de cliente', (await owner.get('/api/account/me')).data.customer === null && (await owner.get('/api/account/orders')).status === 401);

  const oldCookie = ana.cookie;
  const out = await ana.post('/api/account/logout');
  check('logout encerra a sessão', out.status === 200 && (await ana.get('/api/account/me')).data.customer === null);
  const replay = new Client();
  replay.cookie = oldCookie;
  check('cookie antigo não vale mais depois do logout (sessão apagada no servidor)', (await replay.get('/api/account/me')).data.customer === null);

  const bad = await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'errada' });
  const ghost = await new Client().post('/api/account/login', { email: 'ninguem@exemplo.com', password: 'errada' });
  check('senha errada e e-mail desconhecido: mesma resposta 401', bad.status === 401 && ghost.status === 401 && bad.data.error === ghost.data.error, [bad.data, ghost.data]);
  const login = await ana.post('/api/account/login', { email: 'ANA@exemplo.com', password: 'ana-senha-123' });
  check('login (e-mail em qualquer caixa)', login.status === 200 && login.data.customer.name === 'Ana Souza');
  const lock = new Client(undefined, '198.51.100.55');
  const tries = [];
  for (let i = 0; i < 10; i++) tries.push((await lock.post('/api/account/login', { email: 'ana@exemplo.com', password: 'x' + i })).status);
  check('8 erros no mesmo e-mail → 429', tries.slice(0, 8).every((s) => s === 401) && tries[8] === 429, tries.join());
  check('com bloqueio ativo, a rede que errou nem com a senha certa entra', (await lock.post('/api/account/login', { email: 'ana@exemplo.com', password: 'ana-senha-123' })).status === 429);
  check('a dona da conta, em outra rede, continua entrando (o bloqueio é de quem errou, não dela)', (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'ana-senha-123' })).status === 200);
  psql(`delete from rate_limits where bucket like 'cust-%'`);
  check('origem estranha (CSRF) → 403', (await new Client().post('/api/account/login', { email: 'a@a.com', password: 'x' }, { headers: { origin: 'https://evil.example' } })).status === 403);
}

section('11. Pedidos da conta: associação segura e "Meus pedidos"');
const bia = new Client();
{
  // pedido feito já logada → vinculado
  const mine = await place(ana, { customer_phone: '(34) 98888-1111' });
  check('pedido com login fica vinculado à conta', mine.status === 201 && mine.order.linked === true, mine.order);
  check('banco guarda customer_id da sessão', psql(`select customer_id is not null from orders where order_number = ${mine.order.order_number}`) === 't');
  const list = await ana.get('/api/account/orders');
  check('"Meus pedidos" lista o pedido', list.status === 200 && list.data.orders.length === 1 && list.data.orders[0].order_number === mine.order.order_number && /Coca 2L/.test(list.data.orders[0].summary), list.data);
  const det = await ana.get(`/api/account/orders/${mine.order.order_number}`);
  check('detalhe do pedido da conta (com ids dos produtos para "pedir de novo")', det.status === 200 && det.data.order.items[0].product_id, det.data);
  check('lista de pedidos sem login → 401', (await new Client().get('/api/account/orders')).status === 401);
  check('detalhe sem login → 401', (await new Client().get(`/api/account/orders/${mine.order.order_number}`)).status === 401);

  // outra cliente
  const regB = await registerVerified(bia, { name: 'Bia Lima', email: 'bia@exemplo.com', phone: '34 97777-0000', password: 'bia-senha-123' });
  check('segunda cliente cadastrada e confirmada', regB.status === 200);
  check('Bia não vê pedido da Ana (404)', (await bia.get(`/api/account/orders/${mine.order.order_number}`)).status === 404);
  check('lista da Bia vazia', (await bia.get('/api/account/orders')).data.orders.length === 0);
  check('Bia não consegue vincular pedido já vinculado à Ana, mesmo com o número (código desconhecido)', (await bia.post('/api/account/orders/claim', { order_number: mine.order.order_number, code: '00000-00000-00000-00000' })).status === 400);
  const mineToken = (await owner.post(`/api/admin/orders/${(await owner.get(`/api/admin/orders/${mine.order.order_number}`)).data.order.id}/tracking-link`, {})).data.token;
  const taken = await bia.post('/api/account/orders/claim', { order_number: mine.order.order_number, code: mineToken });
  check('nem com o código certo se rouba pedido de outra conta (mesma resposta genérica)', taken.status === 400 && /Não encontramos/.test(taken.data.error), taken.data);

  // visitante → conta
  const guest = await place(new Client(), { customer_phone: '(34) 98888-1111', customer_email: 'ana@exemplo.com' });
  check('pedido de visitante ainda não aparece em "Meus pedidos"', (await ana.get('/api/account/orders')).data.orders.length === 1);
  check('vincular só com o número (sem código) → recusado', (await ana.post('/api/account/orders/claim', { order_number: guest.order.order_number })).status === 400);
  check('vincular com código errado → recusado', (await ana.post('/api/account/orders/claim', { order_number: guest.order.order_number, code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' })).status === 400);
  const before = new Date((await new Client().get(`/api/tracking/${guest.token}`)).data.order.updated_at);
  const claim = await ana.post('/api/account/orders/claim', { order_number: `#${guest.order.order_number}`, code: guest.token.toLowerCase() });
  check('vincular com número + código + telefone da conta → ok', claim.status === 200 && claim.data.order.linked === true && claim.data.order.items[0].product_id, claim.data);
  check('vincular não conta como atualização do pedido (updated_at igual)', new Date((await new Client().get(`/api/tracking/${guest.token}`)).data.order.updated_at).getTime() === before.getTime());
  check('vincular de novo é idempotente', (await ana.post('/api/account/orders/claim', { order_number: guest.order.order_number, code: guest.token })).status === 200);
  check('agora aparece em "Meus pedidos" (2)', (await ana.get('/api/account/orders')).data.orders.length === 2);
  check('o link de visitante continua funcionando depois de vinculado', (await new Client().get(`/api/tracking/${guest.token}`)).data.order.linked === true);

  // telefone/e-mail diferentes → recusa mesmo com o código
  const foreign = await place(new Client(), { customer_phone: '(11) 91111-2222', customer_email: 'outra@pessoa.com' });
  const refuse = await ana.post('/api/account/orders/claim', { order_number: foreign.order.order_number, code: foreign.token });
  check('pedido com outro telefone e e-mail não pode ser reivindicado, mesmo com o código', refuse.status === 400 && /telefone/.test(refuse.data.error) && psql(`select customer_id is null from orders where order_number = ${foreign.order.order_number}`) === 't', refuse.data);
  const byEmail = await place(new Client(), { customer_phone: '(11) 91111-3333', customer_email: 'ANA@exemplo.com' });
  check('basta o e-mail igual ao da conta (mesmo com telefone diferente)', (await ana.post('/api/account/orders/claim', { order_number: byEmail.order.order_number, code: byEmail.token })).status === 200);
  check('vincular sem login → 401', (await new Client().post('/api/account/orders/claim', { order_number: guest.order.order_number, code: guest.token })).status === 401);
  const throttle = new Client();
  await registerVerified(throttle, { name: 'Cris Tentando', email: 'cris@exemplo.com', phone: '34 96666-0000', password: 'cris-senha-123' });
  const attempts = [];
  for (let i = 0; i < 12; i++) attempts.push((await throttle.post('/api/account/orders/claim', { order_number: guest.order.order_number, code: `AAAAA-AAAAA-AAAAA-AAAA${i % 9}` })).status);
  check('tentativas de vínculo com código errado são limitadas (429)', attempts.includes(429), attempts.join());
}

section('12. Perfil, endereço guardado, senha, exclusão e recuperação');
let code;
{
  const up = await ana.patch('/api/account', { name: 'Ana Maria Souza', address: 'Rua das Flores', address_number: '45', neighborhood: 'Centro', complement: 'Apto 2' });
  check('atualiza nome e endereço guardado', up.status === 200 && up.data.customer.address === 'Rua das Flores' && up.data.customer.name === 'Ana Maria Souza', up.data);
  check('endereço persiste no banco', (await ana.get('/api/account/me')).data.customer.neighborhood === 'Centro');
  check('perfil sem login → 401', (await new Client().patch('/api/account', { name: 'x' })).status === 401);
  check('nome curto → 400', (await ana.patch('/api/account', { name: 'A' })).status === 400);
  check('não dá para trocar o e-mail/ativo pela API do cliente', (await ana.patch('/api/account', { email: 'novo@x.com', active: false })).status === 200 && (await ana.get('/api/account/me')).data.customer.email === 'ana@exemplo.com');

  const second = new Client();
  await second.post('/api/account/login', { email: 'ana@exemplo.com', password: 'ana-senha-123' });
  check('senha atual errada → 400', (await ana.patch('/api/account/password', { current: 'errada', next: 'nova-senha-123' })).status === 400);
  check('senha nova curta → 400', (await ana.patch('/api/account/password', { current: 'ana-senha-123', next: '123' })).status === 400);
  check('troca de senha', (await ana.patch('/api/account/password', { current: 'ana-senha-123', next: 'nova-senha-123' })).status === 200);
  check('outras sessões da conta caem; a atual continua', (await second.get('/api/account/me')).data.customer === null && (await ana.get('/api/account/me')).data.customer !== null);
  check('senha antiga não entra; a nova entra', (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'ana-senha-123' })).status === 401 && (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'nova-senha-123' })).status === 200);

  // recuperação sem e-mail: prova de posse com um pedido da conta
  const orderMine = (await ana.get('/api/account/orders')).data.orders[0].order_number;
  code = (await owner.post(`/api/admin/orders/${(await owner.get(`/api/admin/orders/${orderMine}`)).data.order.id}/tracking-link`, { replace: true })).data.token;
  const rec = (extra = {}) => ({ email: 'ana@exemplo.com', phone: '(34) 98888-1111', order_number: orderMine, code, password: 'recuperada-123', ...extra });
  const x = new Client();
  check('recuperar com telefone errado → 400 genérico', (await x.post('/api/account/recover', rec({ phone: '(34) 90000-0000' }))).status === 400);
  check('recuperar com código errado → 400 genérico', (await x.post('/api/account/recover', rec({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' }))).status === 400);
  check('recuperar com pedido que não é da conta → 400', (await x.post('/api/account/recover', rec({ order_number: A.order.order_number, code: A.token }))).status === 400);
  check('recuperar com senha curta → 400', (await x.post('/api/account/recover', rec({ password: '123' }))).status === 400);
  const recOk = await x.post('/api/account/recover', rec());
  check('recuperar com e-mail + telefone + pedido + código da conta', recOk.status === 200, recOk.data);
  check('senha nova vale; a anterior e as sessões abertas caem', (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'recuperada-123' })).status === 200 && (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'nova-senha-123' })).status === 401 && (await ana.get('/api/account/me')).data.customer === null);
  await ana.post('/api/account/login', { email: 'ana@exemplo.com', password: 'recuperada-123' });
}

section('13. Painel: clientes, link de redefinição e exclusão');
const staff = new Client();
{
  await owner.post('/api/admin/admins', { name: 'Atendente 4', email: 'atendente4@copocheio.local', password: 'Caixa#Segura-2026', role: 'admin' });
  await staff.login('atendente4@copocheio.local', 'Caixa#Segura-2026');
  const list = await owner.get('/api/admin/customers');
  check('admin lista as contas com a quantidade de pedidos', list.status === 200 && list.data.customers.length >= 3 && list.data.customers.find((c) => c.email === 'ana@exemplo.com').orders === 3, list.data.customers?.map((c) => [c.email, c.orders]));
  check('lista de clientes não traz hash nem sessões', !JSON.stringify(list.data).includes('scrypt'));
  check('lista de clientes sem login → 401', (await new Client().get('/api/admin/customers')).status === 401);
  check('a conta de cliente não lista clientes → 401', (await bia.get('/api/admin/customers')).status === 401);
  check('busca de clientes por nome/e-mail/telefone', (await owner.get('/api/admin/customers?q=bia')).data.customers.length === 1 && (await owner.get('/api/admin/customers?q=98888')).data.customers.length === 1);
  const anaRow = list.data.customers.find((c) => c.email === 'ana@exemplo.com');
  check('pedidos de conta aparecem no filtro "com conta" e no detalhe', (await owner.get('/api/admin/orders?account=account')).data.orders.length === 3 && (await owner.get(`/api/admin/orders/${(await ana.get('/api/account/orders')).data.orders[0].order_number}`)).data.account.email === 'ana@exemplo.com');

  const bRow = list.data.customers.find((c) => c.email === 'bia@exemplo.com');
  check('link de redefinição sem login → 401', (await new Client().post(`/api/admin/customers/${bRow.id}/reset-link`, {})).status === 401);
  // Quem tem o link assume a conta do cliente: só o owner gera (e fica registrado no histórico de atividades).
  check('atendente (admin comum) NÃO gera link de redefinição (403)', (await staff.post(`/api/admin/customers/${bRow.id}/reset-link`, {})).status === 403);
  const link = await owner.post(`/api/admin/customers/${bRow.id}/reset-link`, {});
  check('owner gera link de redefinição (24 h)', link.status === 201 && link.data.token.length >= 30 && new Date(link.data.expires_at) > new Date(Date.now() + 23 * 3600_000), link.data);
  check('...e o cliente é avisado por e-mail (conta com e-mail confirmado)', link.data.notified === true);
  check('...e a ação fica no histórico de atividades', psql(`select count(*) from audit_log where action = 'customer.reset_link' and entity_id = '${bRow.id}'`) === '1');
  check('só o hash do link fica no banco', !execFileSync('pg_dump', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '--data-only', '-t', 'customer_password_resets'], { encoding: 'utf8' }).includes(link.data.token));
  const anon = new Client();
  check('link com senha curta → 400 (e o link continua valendo)', (await anon.post('/api/account/reset', { token: link.data.token, password: '123' })).status === 400);
  check('link inválido → 400', (await anon.post('/api/account/reset', { token: 'abc', password: 'senha-nova-123' })).status === 400);
  check('redefine a senha com o link', (await anon.post('/api/account/reset', { token: link.data.token, password: 'bia-nova-123' })).status === 200);
  check('o link é de uso único', (await anon.post('/api/account/reset', { token: link.data.token, password: 'outra-senha-123' })).status === 400);
  check('sessões antigas caíram; senha nova entra', (await bia.get('/api/account/me')).data.customer === null && (await new Client().post('/api/account/login', { email: 'bia@exemplo.com', password: 'bia-nova-123' })).status === 200);
  const second = await owner.post(`/api/admin/customers/${bRow.id}/reset-link`, {});
  psql(`update customer_password_resets set expires_at = now() - interval '1 minute' where customer_id = '${bRow.id}'`);
  check('link vencido não vale', (await anon.post('/api/account/reset', { token: second.data.token, password: 'bia-outra-123' })).status === 400);
  check('cliente inexistente → 404', (await owner.post('/api/admin/customers/11111111-1111-4111-8111-111111111111/reset-link', {})).status === 404);

  const off = await owner.patch(`/api/admin/customers/${bRow.id}`, { active: false });
  check('admin desativa a conta', off.status === 200 && off.data.customer.active === false);
  check('conta desativada não entra', (await new Client().post('/api/account/login', { email: 'bia@exemplo.com', password: 'bia-nova-123' })).status === 401);
  const ghostOrder = await place(await (async () => { const c = new Client(); c.cookie = bia.cookie; return c; })(), { customer_phone: '34933332222' });
  check('pedido feito com sessão de conta desativada vira pedido de visitante', ghostOrder.status === 201 && ghostOrder.order.linked === false);
  await owner.patch(`/api/admin/customers/${bRow.id}`, { active: true });
  check('atendente NÃO exclui conta (só owner → 403)', (await staff.del(`/api/admin/customers/${bRow.id}`)).status === 403);

  // Exclusão pelo titular: a conta some, os pedidos ficam e o link segue valendo
  const mineOrders = (await ana.get('/api/account/orders')).data.orders.map((o) => o.order_number);
  check('excluir conta com senha errada → 400', (await ana.del('/api/account', { password: 'errada' })).status === 400);
  const del = await ana.del('/api/account', { password: 'recuperada-123' });
  check('titular exclui a própria conta', del.status === 200 && psql(`select count(*) from customers where lower(email) = 'ana@exemplo.com'`) === '0');
  check('os pedidos continuam na loja, sem ligação com a conta', psql(`select count(*) from orders where order_number in (${mineOrders.join(',')}) and customer_id is null`) === String(mineOrders.length));
  check('login da conta excluída falha; sessão caiu', (await new Client().post('/api/account/login', { email: 'ana@exemplo.com', password: 'recuperada-123' })).status === 401 && (await ana.get('/api/account/me')).data.customer === null);
  check('o link de acompanhamento do pedido segue valendo', (await new Client().get(`/api/tracking/${code}`)).status === 200);
  check('owner exclui conta a pedido do titular', (await owner.del(`/api/admin/customers/${bRow.id}`)).status === 200 && psql(`select count(*) from customers where lower(email) = 'bia@exemplo.com'`) === '0');
}

section('14. Cabeçalhos e vazamentos');
{
  const r = await new Client().get(`/api/tracking/${A.token}`);
  const text = JSON.stringify(r.data);
  check('resposta pública sem telefone, e-mail, ids internos, hash ou estoque', !/customer_phone|customer_email|token_hash|"id"|stock|password/.test(text), Object.keys(r.data.order));
  const list = await owner.get('/api/admin/orders?limit=100');
  check('lista do painel sem hash de código', !/token_hash/.test(JSON.stringify(list.data)));
  check('saúde da API segue ok', (await new Client().get('/api/health')).data.database === 'ok');
}

summary();
