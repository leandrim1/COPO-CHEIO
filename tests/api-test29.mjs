// Devolução (estorno) de pagamento online pelo painel (migration 0028), contra o servidor ValidaPay FALSO (tests/validapay-fake.mjs), que segue o contrato
// documentado de POST/GET /v1/wallet/refunds e dos avisos refund.*.
//
// ATENÇÃO: o servidor falso é uma SIMULAÇÃO escrita a partir da documentação. Estes testes provam a lógica da loja e do adaptador contra o contrato
// documentado; NÃO provam que a ValidaPay de verdade responde assim (nenhum dinheiro é movido). Isso só se prova no sandbox da ValidaPay: ver
// docs/PAGAMENTO-ONLINE.md (roteiro de homologação).
//
// O que se garante: só o owner devolve; o dinheiro só é "devolvido" depois que a operadora CONFIRMA; um pedido aberto por pagamento (duplo clique e nova
// tentativa não devolvem em dobro); resposta perdida/tempo esgotado NÃO repete às cegas (confere na operadora); aviso duplicado ou fora de ordem não desfaz nem
// repete nada; devolução feita no painel da ValidaPay também é reconhecida; segredos nunca vão para o log.
// usage: bash tests/fresh.sh && node tests/api-test29.mjs   (reinicia o servidor de teste no modo "validapay" e, no fim, volta ao normal)
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, Client, check, mailsTo, section, summary } from './lib.mjs';
import { FAKE, paymentSuccess, postWebhook, sleep, startFakeValidaPay } from './validapay-fake.mjs';

const root = new URL('..', import.meta.url).pathname;
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const DB = process.env.TEST_DB ?? 'copocheio_test';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', DB, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const serve = (env = {}) => execSync(`bash ${process.env.SERVE_SCRIPT ?? `${root}tests/serve.sh`}`, { env: { ...process.env, ...env }, stdio: 'ignore' });

const fake = await startFakeValidaPay();
serve({ PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500' });

const calls = () => fake.state.calls;
const refundPosts = () => calls().filter((c) => c.method === 'POST' && c.path === '/v1/wallet/refunds');
const hook = (payload, opts) => postWebhook(BASE, payload, opts);
const serverLog = () => readFileSync(process.env.SERVER_LOG ?? `${root}tests/server.log`, 'utf8');
const charge = (id) => fake.state.charges.get(id);
const SECRET_TEXTS = ['client-secret-de-teste', FAKE.webhookSecret, 'Bearer ', 'tok.wallet', 'tok.charges'];

const owner = new Client(undefined, '198.51.100.90');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.91');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente@copocheio.local', 'senha-forte-456');
const anon = new Client();
await owner.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
await owner.patch('/api/admin/payments/pix_online', { enabled: true });
const cat = (await owner.post('/api/admin/categories', { name: 'Devoluções' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Cerveja Devolução', price: 25, category_id: cat.id, stock: 500, alcoholic: false, confirm_duplicate: true })).data.product;

let ip = 120;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const EMAIL = 'cliente.devolucao@exemplo.com';
const payRow = (n) => JSON.parse(psql(`select row_to_json(p) from payments p join orders o on o.id = p.order_id where o.order_number = ${n} order by p.created_at desc limit 1`));
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const refundRows = (n) => JSON.parse(psql(`select coalesce(json_agg(r order by r.created_at), '[]') from payment_refunds r join orders o on o.id = r.order_id where o.order_number = ${n}`));

// Um pedido de Pix online, já PAGO (aviso verificado + consulta): o ponto de partida de cada teste de devolução. Valor cobrado: R$ 25,63 (R$ 25,00 + taxa de serviço).
let seq = 0;
async function paidOrder({ email } = {}) {
  const c = buyer();
  const r = await c.post('/api/orders', { customer_name: 'Cliente Devolução', customer_phone: `3496${String(5000000 + ++phone).slice(-7)}`, delivery_type: 'pickup', payment_method: 'pix_online', customer_email: email ?? null, items: [{ product_id: beer.id, quantity: 1 }] });
  if (r.status !== 201) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  const token = r.data.token;
  const number = r.data.order.order_number;
  const made = await c.post(`/api/tracking/${token}/payment`, { method: 'pix' });
  if (made.status !== 201) throw new Error(`Pix não criado: ${JSON.stringify(made.data)}`);
  const id = payRow(number).provider_charge_id;
  await fake.control('pay', { chargeId: id, paidAmount: 25.63, fee: 0.99 });
  await hook(paymentSuccess(charge(id)), { id: `wh-paid-${++seq}` });
  const row = payRow(number);
  if (row.status !== 'paid') throw new Error(`pedido ${number} não ficou pago: ${row.status}`);
  return { c, token, number, id, pid: row.id };
}
const refundPath = (pid) => `/api/admin/payments/${pid}/refund`;
const refundEvent = (type, refund, extra = {}) => ({ event: type, timestamp: new Date().toISOString(), accountId: '4960589', refundId: refund.refundId, chargeId: refund.chargeId, endToEndId: refund.endToEndId, amount: refund.amount, status: type === 'refund.confirmed' ? 'CONFIRMED' : type === 'refund.failed' ? 'ERROR' : 'PROCESSING', ...extra });

// ------------------------------------------------------------------------------------------------
section('1. Só o owner devolve; pedido inválido nunca chega à operadora');
{
  const A = await paidOrder();
  const before = calls().length;
  check('sem login: 401', (await anon.post(refundPath(A.pid), { reason: 'CUSTOMER_REQUEST' })).status === 401);
  check('atendente (não é owner): 403', (await staff.post(refundPath(A.pid), { reason: 'CUSTOMER_REQUEST' })).status === 403);
  check('conferir devolução também é só do owner', (await staff.post(`/api/admin/payments/${A.pid}/refunds/check`, {})).status === 403 && (await anon.post(`/api/admin/payments/${A.pid}/refunds/check`, {})).status === 401);
  for (const [name, body] of [
    ['sem motivo', {}],
    ['motivo fora da lista', { reason: 'QUERO_DE_VOLTA' }],
    ['valor que não é número', { reason: 'CUSTOMER_REQUEST', amount: 'abc' }],
    ['valor zero', { reason: 'CUSTOMER_REQUEST', amount: '0' }],
    ['valor negativo', { reason: 'CUSTOMER_REQUEST', amount: '-5' }],
    ['valor com 3 casas', { reason: 'CUSTOMER_REQUEST', amount: '1,234' }],
    ['valor absurdo', { reason: 'CUSTOMER_REQUEST', amount: '99999999' }],
    ['anotação grande demais', { reason: 'CUSTOMER_REQUEST', note: 'x'.repeat(201) }],
    ['anotação que não é texto', { reason: 'CUSTOMER_REQUEST', note: { a: 1 } }],
  ]) {
    const r = await owner.post(refundPath(A.pid), body);
    check(`${name}: 400`, r.status === 400, r.data);
  }
  const tooMuch = await owner.post(refundPath(A.pid), { reason: 'CUSTOMER_REQUEST', amount: '30,00' });
  check('valor acima do que foi pago (R$ 25,63): recusado pelo banco, com o limite na mensagem', tooMuch.status === 400 && /R\$ 25,63/.test(tooMuch.data.error), tooMuch.data);
  check('pagamento que não existe: 404', (await owner.post(refundPath('00000000-0000-4000-8000-000000000000'), { reason: 'CUSTOMER_REQUEST' })).status === 404 && (await owner.post(refundPath('nao-e-uuid'), { reason: 'CUSTOMER_REQUEST' })).status === 404);
  check('nenhuma dessas tentativas chegou à ValidaPay (nem para criar nem para consultar devolução)', refundPosts().length === 0 && calls().slice(before).filter((c) => c.path === '/v1/wallet/refunds' && c.method === 'POST').length === 0);
  check('...e nada foi gravado', refundRows(A.number).length === 0 && payRow(A.number).refunded_cents === 0);

  // Pagamento que ainda não foi pago
  const c = buyer();
  const r = await c.post('/api/orders', { customer_name: 'Cliente Aberto', customer_phone: '34960009999', delivery_type: 'pickup', payment_method: 'pix_online', items: [{ product_id: beer.id, quantity: 1 }] });
  await c.post(`/api/tracking/${r.data.token}/payment`, { method: 'pix' });
  const open = payRow(r.data.order.order_number);
  const notPaid = await owner.post(refundPath(open.id), { reason: 'CUSTOMER_REQUEST' });
  check('pagamento ainda em aberto: não dá para devolver (só o que foi confirmado)', notPaid.status === 400 && /confirmado pela operadora/.test(notPaid.data.error), notPaid.data);
}

// ------------------------------------------------------------------------------------------------
section('2. Devolução parcial do Pix: pedir NÃO é devolver; só a confirmação da operadora conta');
const B = await paidOrder({ email: EMAIL });
{
  const made = await owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST', amount: '10,00', note: 'Cliente desistiu de uma unidade' });
  check('pedido aceito: 201, estado "processing" e a mensagem diz que ainda falta a confirmação da operadora', made.status === 201 && made.data.outcome === 'processing' && /só é dado como devolvido quando ela confirmar/.test(made.data.message), made.data);
  const [post] = refundPosts();
  check('a ValidaPay recebeu exatamente { chargeId, amount (reais), reason }, no escopo wallet/write', refundPosts().length === 1 && JSON.stringify(post.body) === JSON.stringify({ chargeId: B.id, amount: 10, reason: 'CUSTOMER_REQUEST' }) && post.scope === 'wallet/write', post);
  check('o cabeçalho da subconta vai no pedido do Pix (como na consulta e no cancelamento)', post.subAccount === '4960589', post.subAccount);
  const rows = refundRows(B.number);
  check('o banco guarda: valor, motivo, quem pediu, a anotação, o código da operadora e o estado "processing"', rows.length === 1 && rows[0].amount_cents === 1000 && rows[0].reason === 'CUSTOMER_REQUEST' && rows[0].status === 'processing' && /^ref_/.test(rows[0].provider_refund_id) && rows[0].requested_by_name === 'Dono Teste' && rows[0].note === 'Cliente desistiu de uma unidade', rows);
  const pay = payRow(B.number);
  check('o pagamento continua "pago" e NADA foi devolvido ainda (refunded_cents = 0)', pay.status === 'paid' && pay.refunded_cents === 0 && orderRow(B.number).payment_status === 'paid', pay);
  const log = (await owner.get('/api/admin/audit?entity=payment&limit=20')).data.entries.map((e) => e.summary).join(' | ');
  check('o pedido de devolução fica no histórico de atividades (aguardando a confirmação)', new RegExp(`Pediu a devolução de R\\$ 10,00 do pagamento do pedido #${B.number}.*aguardando a confirmação`).test(log), log);

  const second = await owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST', amount: '5,00' });
  check('outro pedido enquanto há um aberto: 409 refund_open (nada é pedido em dobro)', second.status === 409 && second.data.code === 'refund_open' && refundPosts().length === 1 && refundRows(B.number).length === 1, second.data);
  const dbl = await Promise.all([owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST' }), owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST' })]);
  check('dois cliques ao mesmo tempo também não devolvem em dobro', dbl.every((r) => r.status === 409) && refundPosts().length === 1, dbl.map((r) => r.status));

  const detail = (await owner.get(`/api/admin/payments/${B.pid}`)).data;
  check('o detalhe do pagamento (owner) mostra os pedidos de devolução', detail.refunds.length === 1 && detail.refunds[0].status === 'processing', detail.refunds);
  const orderView = (await owner.get(`/api/admin/orders/${B.number}`)).data;
  check('o detalhe do pedido mostra as devoluções do pagamento para o owner', orderView.payments[0].refunds?.length === 1);
  const staffView = (await staff.get(`/api/admin/orders/${B.number}`)).data;
  check('...e o atendente não vê valores de devolução', !JSON.stringify(staffView.payments).includes('refunds') && !JSON.stringify(staffView.payments).includes('provider_charge_id'), staffView.payments);

  // A operadora conclui: aviso assinado refund.confirmed
  const item = fake.state.refunds[0];
  await fake.control('refund-settle', { refundId: item.refundId, status: 'CONFIRMED' });
  const ev = await hook(refundEvent('refund.confirmed', item), { id: 'wh-refund-conf-1' });
  const after = payRow(B.number);
  check('aviso refund.confirmed verificado: 200', ev.status === 200, ev);
  check('o pedido de devolução vira "confirmed" e o pagamento mostra R$ 10,00 devolvidos (ainda "pago": a devolução foi parcial)', refundRows(B.number)[0].status === 'confirmed' && refundRows(B.number)[0].confirmed_at !== null && after.refunded_cents === 1000 && after.status === 'paid' && orderRow(B.number).payment_status === 'paid', [after.refunded_cents, after.status]);
  check('o pagamento fica sinalizado para o dono conferir a comissão (regra que já existia)', after.needs_attention === true && /comissão/i.test(after.attention_reason), after.attention_reason);
  const dupe = await hook(refundEvent('refund.confirmed', item), { id: 'wh-refund-conf-1', attempt: 2 });
  check('o mesmo aviso reenviado é deduplicado: nada muda', dupe.status === 200 && payRow(B.number).refunded_cents === 1000);
  const late = await hook(refundEvent('refund.requested', item), { id: 'wh-refund-req-late' });
  check('aviso refund.requested chegando DEPOIS do confirmado (fora de ordem): não desfaz nada', late.status === 200 && refundRows(B.number)[0].status === 'confirmed' && payRow(B.number).refunded_cents === 1000);
  const failedLate = await hook(refundEvent('refund.failed', item), { id: 'wh-refund-failed-late' });
  check('refund.failed atrasado para uma devolução já confirmada: não a transforma em falha', failedLate.status === 200 && refundRows(B.number)[0].status === 'confirmed');
  check('uma devolução confirmada é final: o pedido de pagamento seguinte pode pedir o resto', (await owner.get(`/api/admin/payments/${B.pid}`)).data.refunds.length === 1);

  // O resto: sem informar o valor devolve tudo o que falta
  const rest = await owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST' });
  check('sem informar o valor: pede TUDO o que falta (R$ 15,63) à ValidaPay', rest.status === 201 && refundPosts().length === 2 && refundPosts()[1].body.amount === 15.63 && rest.data.refund.amount_cents === 1563, rest.data);
  check('o pedido de pagamento continua "pago" até a confirmação', payRow(B.number).status === 'paid' && orderRow(B.number).payment_status === 'paid');
  const item2 = fake.state.refunds[1];
  await fake.control('refund-settle', { refundId: item2.refundId, status: 'CONFIRMED' });
  await hook(refundEvent('refund.confirmed', item2), { id: 'wh-refund-conf-2' });
  const done = payRow(B.number);
  check('confirmado o resto: pagamento "refunded", tudo devolvido', done.status === 'refunded' && done.refunded_cents === 2563, [done.status, done.refunded_cents]);
  check('...e SÓ AGORA o pedido passa a "reembolsado" (nunca por clique)', orderRow(B.number).payment_status === 'refunded');
  const none = await owner.post(refundPath(B.pid), { reason: 'CUSTOMER_REQUEST' });
  check('devolver de novo um pagamento já devolvido por completo: recusado', none.status === 400 && /já foi devolvido por completo/.test(none.data.error), none.data);
  const view = await B.c.get(`/api/tracking/${B.token}/payment`);
  check('o cliente vê "estornado" na tela do pedido', view.data.payment?.status === 'refunded', view.data);
  let mail = [];
  for (let i = 0; i < 40 && !mail.some((m) => /Reembolso/i.test(m.subject ?? '')); i++) {
    await sleep(250);
    mail = await mailsTo(EMAIL);
  }
  check('o cliente recebe o e-mail de reembolso só depois da confirmação (e um só)', mail.filter((m) => /Reembolso/i.test(m.subject ?? '')).length === 1, mail.map((m) => m.subject));
}

// ------------------------------------------------------------------------------------------------
section('3. A operadora recusa: nada é devolvido, o motivo é claro e dá para tentar de novo');
{
  const C = await paidOrder();
  const posts = refundPosts().length;
  // 403: a credencial não tem o escopo wallet/write
  await fake.control('mode', { refundFail: 'forbidden' });
  const forbidden = await owner.post(refundPath(C.pid), { reason: 'CUSTOMER_REQUEST' });
  check('sem permissão (escopo wallet/write): 422 com a explicação, nada devolvido', forbidden.status === 422 && /wallet\/write/.test(forbidden.data.error) && forbidden.data.code === 'refund_rejected', forbidden.data);
  check('o pedido fica "failed" (final) e libera uma nova tentativa', refundRows(C.number)[0].status === 'failed' && /wallet\/write/.test(refundRows(C.number)[0].last_error) && payRow(C.number).refunded_cents === 0, refundRows(C.number));
  await fake.control('mode', { refundFail: null });

  // Valor acima do disponível NA OPERADORA: alguém devolveu parte pelo painel da ValidaPay e a loja ainda não sabia
  await fake.control('refund-external', { chargeId: C.id, amount: 20, status: 'CONFIRMED' });
  const stale = await owner.post(refundPath(C.pid), { reason: 'CUSTOMER_REQUEST', amount: '10,00' });
  check('devolução feita no painel da ValidaPay (R$ 20,00): a loja a reconhece ANTES de pedir e recusa o excesso (resta R$ 5,63)', stale.status === 400 && /R\$ 5,63/.test(stale.data.error), stale.data);
  check('...o pagamento passou a mostrar o que a ValidaPay devolveu (R$ 20,00) e nada novo foi pedido', payRow(C.number).refunded_cents === 2000 && refundPosts().length === posts + 1 && refundRows(C.number).length === 1, [payRow(C.number).refunded_cents, refundPosts().length - posts]);
  const ok = await owner.post(refundPath(C.pid), { reason: 'BANK_ERROR' });
  check('o resto (R$ 5,63) é pedido normalmente, com o motivo escolhido', ok.status === 201 && refundPosts().at(-1).body.amount === 5.63 && refundPosts().at(-1).body.reason === 'BANK_ERROR', ok.data);
  await fake.control('refund-settle', { refundId: fake.state.refunds.at(-1).refundId, status: 'ERROR', error: 'Conta de destino encerrada' });
  const failedEvent = await hook(refundEvent('refund.failed', fake.state.refunds.at(-1)), { id: 'wh-refund-failed-1' });
  const failed = refundRows(C.number).at(-1);
  check('refund.failed: o pedido vira "failed" com o motivo da operadora; nada devolvido além dos R$ 20,00 de antes', failedEvent.status === 200 && failed.status === 'failed' && /encerrada/.test(failed.last_error) && payRow(C.number).refunded_cents === 2000 && payRow(C.number).status === 'paid', failed);
}

// ------------------------------------------------------------------------------------------------
section('4. Resposta perdida: a loja NÃO repete às cegas; confere na operadora antes de qualquer nova tentativa');
{
  const D = await paidOrder();
  const posts = refundPosts().length;
  await fake.control('mode', { refundFail: 'lose' });
  const lost = await owner.post(refundPath(D.pid), { reason: 'CUSTOMER_REQUEST', amount: '12,00' });
  check('a ValidaPay criou a devolução mas a resposta se perdeu: 201 com "unknown" e o aviso para conferir antes de pedir de novo', lost.status === 201 && lost.data.outcome === 'unknown' && /Conferir devolução/.test(lost.data.message), lost.data);
  check('o pedido fica "requested" (aguardando resposta) e o pagamento é sinalizado', refundRows(D.number)[0].status === 'requested' && refundRows(D.number)[0].provider_refund_id === null && payRow(D.number).needs_attention === true && /sem resposta/.test(payRow(D.number).attention_reason), refundRows(D.number));
  await fake.control('mode', { refundFail: null });
  const again = await owner.post(refundPath(D.pid), { reason: 'CUSTOMER_REQUEST', amount: '12,00' });
  check('tentar de novo: a loja primeiro CONFERE na operadora, reconhece a devolução que já existe e NÃO cria outra', again.status === 409 && again.data.code === 'refund_open' && refundPosts().length === posts + 1, [again.status, refundPosts().length - posts]);
  const row = refundRows(D.number)[0];
  check('...o pedido achou o código da operadora (pelo valor e pelo horário) e passou a "processing"', row.status === 'processing' && /^ref_/.test(row.provider_refund_id) && row.provider_refund_id === fake.state.refunds.at(-1).refundId, row);
  const check1 = await owner.post(`/api/admin/payments/${D.pid}/refunds/check`, {});
  check('"Conferir devolução" também funciona sozinho: 200, sem criar nada', check1.status === 200 && refundPosts().length === posts + 1);
  await fake.control('refund-settle', { refundId: row.provider_refund_id, status: 'CONFIRMED' });
  const check2 = await owner.post(`/api/admin/payments/${D.pid}/refunds/check`, {});
  check('depois que a ValidaPay conclui, "Conferir devolução" confirma o pedido e atualiza o pagamento (R$ 12,00)', check2.status === 200 && check2.data.changed === true && refundRows(D.number)[0].status === 'confirmed' && payRow(D.number).refunded_cents === 1200, [check2.data, payRow(D.number).refunded_cents]);
  const log = (await owner.get('/api/admin/audit?entity=payment&limit=40')).data.entries.map((e) => e.summary).join(' | ');
  check('a conferência fica no histórico de atividades', /Conferiu as devoluções do pagamento/.test(log), log);
}
{
  // Erro 500 e tempo esgotado: ambíguo também. A operadora NÃO tem nada: depois de 10 minutos o pedido é dado como "não registrado" e pode ser repetido.
  const E = await paidOrder();
  await fake.control('mode', { refundFail: 'down' });
  const down = await owner.post(refundPath(E.pid), { reason: 'CUSTOMER_REQUEST' });
  check('erro 500 da operadora: "unknown" (pode ou não ter sido criada), nada marcado como devolvido', down.status === 201 && down.data.outcome === 'unknown' && payRow(E.number).refunded_cents === 0, down.data);
  await fake.control('mode', { refundFail: null });
  const young = await owner.post(refundPath(E.pid), { reason: 'CUSTOMER_REQUEST' });
  check('logo depois: a operadora não tem nada, mas ainda é cedo para dar como não registrado → continua aberto (409)', young.status === 409 && young.data.code === 'refund_open' && refundRows(E.number)[0].status === 'requested', young.data);
  psql(`update payment_refunds set requested_at = now() - interval '11 minutes' where order_id = (select id from orders where order_number = ${E.number})`);
  const posts = refundPosts().length;
  const retry = await owner.post(refundPath(E.pid), { reason: 'CUSTOMER_REQUEST' });
  check('11 minutos depois, a operadora (consultada) não tem pedido nenhum: o antigo vira "failed" e o novo é criado', retry.status === 201 && refundRows(E.number)[0].status === 'failed' && /não registrou/.test(refundRows(E.number)[0].last_error) && refundRows(E.number).length === 2 && refundPosts().length === posts + 1, refundRows(E.number));

  const F = await paidOrder();
  await fake.control('mode', { refundFail: 'hang' });
  const t0 = Date.now();
  const hang = await owner.post(refundPath(F.pid), { reason: 'CUSTOMER_REQUEST' });
  check('operadora que não responde: o painel não fica pendurado (prazo curto) e diz "unknown"', hang.status === 201 && hang.data.outcome === 'unknown' && Date.now() - t0 < 9000, [hang.status, Date.now() - t0]);
  await fake.control('mode', { refundFail: null });

  const G = await paidOrder();
  await fake.control('mode', { refundFail: 'badresponse' });
  const bad = await owner.post(refundPath(G.pid), { reason: 'CUSTOMER_REQUEST', amount: '9,00' });
  check('resposta que não bate com o pedido (outro valor): tratada como ambígua, NUNCA como confirmada', bad.status === 201 && bad.data.outcome === 'unknown' && refundRows(G.number)[0].status === 'requested' && payRow(G.number).refunded_cents === 0, bad.data);
  await fake.control('mode', { refundFail: null });

  // Sem conseguir conferir (a consulta das devoluções fora do ar), a loja não pede às cegas.
  const H = await paidOrder();
  await fake.control('mode', { refundList: 'down' });
  const posts2 = refundPosts().length;
  const blind = await owner.post(refundPath(H.pid), { reason: 'CUSTOMER_REQUEST' });
  check('consulta das devoluções fora do ar: 503 e NADA é pedido (poderia devolver em dobro)', blind.status === 503 && blind.data.code === 'provider_unavailable' && refundPosts().length === posts2 && refundRows(H.number).length === 0, blind.data);
  const blindCheck = await owner.post(`/api/admin/payments/${H.pid}/refunds/check`, {});
  check('"Conferir devolução" com a operadora fora do ar: 503', blindCheck.status === 503);
  await fake.control('mode', { refundList: 'ok' });
}

// ------------------------------------------------------------------------------------------------
section('5. O contrato não confirma o cabeçalho da subconta no Pix: os dois comportamentos possíveis funcionam');
{
  await fake.control('mode', { refundSub: 'forbidden' });
  const I = await paidOrder();
  const posts = refundPosts().length;
  const r = await owner.post(refundPath(I.pid), { reason: 'CUSTOMER_REQUEST', amount: '5,00' });
  const sent = refundPosts().slice(posts);
  check('a ValidaPay não aceita o cabeçalho: a loja tenta de novo sem ele e dá certo', r.status === 201 && r.data.outcome === 'processing' && sent.length === 2 && sent[0].subAccount === '4960589' && sent[1].subAccount === null, sent.map((s) => s.subAccount));
  await fake.control('mode', { refundSub: 'required' });
  const J = await paidOrder();
  const r2 = await owner.post(refundPath(J.pid), { reason: 'CUSTOMER_REQUEST', amount: '5,00' });
  check('a ValidaPay exige o cabeçalho: o primeiro pedido já o leva', r2.status === 201 && r2.data.outcome === 'processing' && refundPosts().at(-1).subAccount === '4960589');
  await fake.control('mode', { refundSub: 'any' });
}

// ------------------------------------------------------------------------------------------------
section('6. Devolução feita direto no painel da ValidaPay também é reconhecida (por consulta ou por aviso)');
{
  const K = await paidOrder();
  await fake.control('refund-external', { chargeId: K.id, amount: 25.63, status: 'CONFIRMED' });
  const ev = await hook(refundEvent('refund.confirmed', fake.state.refunds.at(-1)), { id: 'wh-refund-externo' });
  const row = payRow(K.number);
  check('aviso refund.confirmed de uma devolução que a loja não pediu: o pagamento passa a "refunded" e o pedido a "reembolsado"', ev.status === 200 && row.status === 'refunded' && row.refunded_cents === 2563 && orderRow(K.number).payment_status === 'refunded', [row.status, row.refunded_cents]);
  check('...sem nenhum registro de pedido da loja (foi feita fora) e sem POST novo', refundRows(K.number).length === 0);
  const L = await paidOrder();
  await fake.control('refund-external', { chargeId: L.id, amount: 5, status: 'CONFIRMED' });
  const refresh = await owner.post(`/api/admin/payments/${L.pid}/refresh`);
  check('"Atualizar pagamento" também reconhece a devolução parcial feita fora (R$ 5,00) e mantém "pago"', refresh.status === 200 && payRow(L.number).refunded_cents === 500 && payRow(L.number).status === 'paid');
}

// ------------------------------------------------------------------------------------------------
section('7. Pedido cancelado depois de pago: a devolução continua disponível e a marcação manual não existe para pagamento online');
{
  const M = await paidOrder();
  const id = (await owner.get(`/api/admin/orders/${M.number}`)).data.order.id;
  await owner.patch(`/api/admin/orders/${id}`, { status: 'cancelled', reason: 'Cliente pediu o cancelamento' });
  check('cancelar pedido já pago sinaliza "devolva o valor ao cliente"', payRow(M.number).needs_attention === true && /Devolva o valor/.test(payRow(M.number).attention_reason), payRow(M.number));
  const manual = await owner.patch(`/api/admin/orders/${id}`, { payment_status: 'refunded' });
  check('marcar "reembolsado" à mão num pagamento online: recusado (quem confirma é a operadora)', manual.status === 400 && /operadora/.test(manual.data.error), manual.data);
  const r = await owner.post(refundPath(M.pid), { reason: 'CUSTOMER_REQUEST' });
  check('o owner pede a devolução total do pedido cancelado pelo painel da loja', r.status === 201 && r.data.refund.amount_cents === 2563);
}

// ------------------------------------------------------------------------------------------------
section('8. Segredos e dados do pagador nunca vão para o log; nenhum dinheiro de verdade é movido');
{
  const log = serverLog();
  check('nenhum segredo, token ou cabeçalho de autorização no log do servidor', SECRET_TEXTS.every((s) => !log.includes(s)), SECRET_TEXTS.filter((s) => log.includes(s)));
  check('todas as chamadas foram ao servidor FALSO (as URLs do adaptador são as dos testes)', calls().length > 0 && fake.url.startsWith('http://127.0.0.1'));
  check('a devolução da loja nunca usa o corpo do guia ({ endToEndId, reason }): sempre chargeId + amount + reason', refundPosts().every((c) => c.body && typeof c.body.chargeId === 'string' && typeof c.body.amount === 'number' && !('endToEndId' in c.body)));
}

serve({ PAYMENTS_SIM: 'off' });
summary();
