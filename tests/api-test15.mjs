// ValidaPay: o adaptador REAL (server/payments/validapay.ts) e a loja inteira contra um servidor ValidaPay FALSO (tests/validapay-fake.mjs) que segue
// a documentação oficial: autenticação, Pix com divisão para a master, consulta, cancelamento, avisos assinados (HMAC), vínculo e cadastro da subconta.
//
// ATENÇÃO: o servidor falso é uma SIMULAÇÃO escrita a partir da documentação. Estes testes provam a lógica da loja e do adaptador contra o contrato
// documentado; NÃO provam que a ValidaPay de verdade responde assim. Isso só se prova no sandbox da ValidaPay (nunca foi feito).
//
// usage: bash tests/fresh.sh && node tests/api-test15.mjs   (reinicia o servidor de teste no modo "validapay" e, no fim, volta ao normal)
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BASE, Client, check, section, summary } from './lib.mjs';
import { FAKE, paymentSuccess, postWebhook, signWebhook, sleep, startFakeValidaPay } from './validapay-fake.mjs';

const root = new URL('..', import.meta.url).pathname;
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const serve = (env = {}) => execSync(`bash ${root}tests/serve.sh`, { env: { ...process.env, ...env }, stdio: 'ignore' });

const fake = await startFakeValidaPay();
const startServer = (env = {}) =>
  serve({ PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500', ...env });
startServer();

const calls = () => fake.state.calls;
const callsTo = (method, pathPart) => calls().filter((c) => c.method === method && c.path.includes(pathPart));
const clearCalls = () => fake.control('calls/clear', {});
const hook = (payload, opts) => postWebhook(BASE, payload, opts);
const events = () => Number(psql('select count(*) from payment_events'));
const serverLog = () => readFileSync(`${root}tests/server.log`, 'utf8');
const SECRET_TEXTS = ['client-secret-de-teste', FAKE.webhookSecret, 'Bearer ', 'tok.charges', 'tok.wallet', 'tok.proposals', 'tok.subaccounts', '00020101021226910014br.gov.bcb.pix2563fake'];

// ------------------------------------------------------------------------------------------------
section('1. Configuração: a operadora liga só com as variáveis; o painel só informa nomes, nunca valores');
const owner = new Client(undefined, '198.51.100.40');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const staff = new Client(undefined, '198.51.100.41');
await owner.post('/api/admin/admins', { name: 'Atendente', email: 'atendente@copocheio.local', password: 'senha-forte-456', role: 'admin' });
await staff.login('atendente@copocheio.local', 'senha-forte-456');
const ownerFrom = async (ip) => {
  const c = new Client(undefined, ip);
  await c.login();
  return c;
};
{
  const overview = (await owner.get('/api/admin/payments')).data;
  check('a operadora aparece conectada, com nome do ambiente (sandbox) e podendo gerenciar contas', overview.provider.configured === true && overview.provider.name === 'validapay-sandbox' && overview.provider.environment === 'sandbox' && overview.provider.manages_accounts === true && overview.provider.missing.length === 0, overview.provider);
  check('sandbox: a criação de conta não tem tarifa', overview.account_fee_cents === 0, overview.account_fee_cents);
  check('ainda sem conta do estabelecimento e com o Pix online desligado', overview.merchant === null && overview.method?.enabled === false && overview.readiness.ready === false, overview);
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('sem conta aprovada não dá para ligar o Pix online (409)', on.status === 409 && on.data.code === 'payments_not_ready', on.data);
}

// ------------------------------------------------------------------------------------------------
section('2. As rotas da conta do estabelecimento são só do owner');
{
  const anon = new Client();
  for (const [method, path, body] of [
    ['get', '/api/admin/payments/account/candidates'],
    ['post', '/api/admin/payments/account/link', { account_number: '4960589', authorized: true }],
    ['post', '/api/admin/payments/account/proposal', { kind: 'pf', authorized: true, form: {} }],
    ['post', '/api/admin/payments/account/refresh', {}],
  ]) {
    const a = await anon[method](path, body);
    const s = await staff[method](path, body);
    check(`${method.toUpperCase()} ${path.replace('/api/admin/payments/', '')}: sem login 401 e atendente 403`, a.status === 401 && s.status === 403, [a.status, s.status]);
  }
  check('nenhuma chamada saiu para a ValidaPay por causa dessas tentativas', calls().length === 0, calls().length);
}

// ------------------------------------------------------------------------------------------------
section('3. Vincular uma conta que já existe (conferida na lista oficial)');
{
  const noAuth = await owner.post('/api/admin/payments/account/link', { account_number: '4960589' });
  check('sem a autorização do titular: 400 authorization_required (e nada é consultado)', noAuth.status === 400 && noAuth.data.code === 'authorization_required' && calls().length === 0, noAuth.data);
  const cand = await owner.get('/api/admin/payments/account/candidates');
  check('lista as contas informadas pela operadora, com o documento SEMPRE mascarado', cand.status === 200 && cand.data.accounts.length === 2 && cand.data.accounts[0].documentMasked === '••••••••••0195' && !JSON.stringify(cand.data).includes('12345678000195') && !JSON.stringify(cand.data).includes('52998224725'), cand.data);
  check('só a conta CONFIRMADA pela operadora vale como aberta', cand.data.accounts.find((a) => a.accountNumber === '4960589').confirmed === true && cand.data.accounts.find((a) => a.accountNumber === '4949228').confirmed === false);
  const list = callsTo('GET', '/v1/accounts/subaccounts')[0];
  check('a listagem usa o token do escopo subaccounts/read (OAuth client_credentials)', list?.scope === 'subaccounts/read' && list.hasAuth === true && callsTo('POST', '/auth/token')[0].body.grant_type === 'client_credentials', list);
  const pending = await owner.post('/api/admin/payments/account/link', { account_number: '4949228', authorized: true });
  check('conta que a operadora ainda não confirmou: recusada (409 account_not_confirmed)', pending.status === 409 && pending.data.code === 'account_not_confirmed', pending.data);
  const unknown = await owner.post('/api/admin/payments/account/link', { account_number: '999999', authorized: true });
  check('conta que não está na lista oficial: recusada', unknown.status === 409 && unknown.data.code === 'account_not_confirmed', unknown.data);
  check('número com caracteres estranhos: 400', (await owner.post('/api/admin/payments/account/link', { account_number: '4960589; drop', authorized: true })).status === 400);
  check('nada foi gravado pelas tentativas recusadas', psql('select count(*) from merchant_accounts') === '0');

  const link = await owner.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  check('vincula a conta confirmada: 201, aprovada, com o identificador mascarado na resposta', link.status === 201 && link.data.account.status === 'approved' && link.data.account.provider_account_id === '••••' && link.data.account.provider === 'validapay-sandbox', link.data);
  const row = JSON.parse(psql(`select row_to_json(m) from merchant_accounts m`));
  check('no banco: aprovada, com o número definitivo, quem autorizou e quando; sandbox não exige ciência de tarifa', row.status === 'approved' && row.provider_account_id === '4960589' && row.authorized_by !== null && row.authorized_at !== null && row.fees_acknowledged_at === null && row.provider === 'validapay-sandbox');
  const again = await owner.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  check('vincular de novo é recusado (409): um cadastro ativo por operadora', again.status === 409 && again.data.code === 'account_conflict', again.data);
  const cand2 = await owner.get('/api/admin/payments/account/candidates');
  check('a conta vinculada aparece como "linked" na lista', cand2.data.accounts.find((a) => a.accountNumber === '4960589').linked === true);
  const log = (await owner.get('/api/admin/audit?entity=merchant_account&limit=10')).data.entries.map((e) => e.summary).join(' | ');
  check('o vínculo fica no histórico de atividades', /Vinculou uma conta existente/.test(log), log);
  const on = await owner.patch('/api/admin/payments/pix_online', { enabled: true });
  check('com a conta aprovada, o owner liga o Pix online', on.status === 200 && on.data.payment.enabled === true, on.data);
  const health = (await owner.get('/api/admin/health')).data;
  check('o estado do sistema mostra a operadora e a conta, sem valores', health.payments?.provider === 'validapay-sandbox' && health.payments?.merchant === 'approved' && health.payments?.ready === true, health.payments);
}

// ------------------------------------------------------------------------------------------------
const cat = (await owner.post('/api/admin/categories', { name: 'Bebidas ValidaPay' })).data.category;
const mk = async (name, price, stock = 500) => (await owner.post('/api/admin/products', { name, price, category_id: cat.id, stock, confirm_duplicate: true })).data.product;
const p25 = await mk('Cerveja Artesanal', 25);
const p1010 = await mk('Água Gourmet', 10.1);
const p1765 = await mk('Drink da Casa', 17.65);
let ip = 60;
const buyer = () => new Client(undefined, `203.0.113.${ip++}`);
let phone = 0;
const nextPhone = () => `3496${String(3000000 + ++phone).slice(-7)}`;
async function placeOrder(items) {
  const c = buyer();
  const r = await c.post('/api/orders', { customer_name: 'Cliente ValidaPay', customer_phone: nextPhone(), delivery_type: 'pickup', payment_method: 'pix_online', items });
  if (r.status !== 201) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  return { c, token: r.data.token, number: r.data.order.order_number };
}
const payRow = (n, attempt) => JSON.parse(psql(`select row_to_json(p) from payments p join orders o on o.id = p.order_id where o.order_number = ${n} ${attempt ? `and p.attempt = ${attempt}` : ''} order by p.created_at desc limit 1`));
const orderRow = (n) => JSON.parse(psql(`select row_to_json(o) from orders o where order_number = ${n}`));
const history = (n) => psql(`select coalesce(string_agg(coalesce(h.from_status, '-') || '>' || h.to_status, ' | ' order by h.created_at, h.id), '') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${n}`);
const pay = (c, token) => c.post(`/api/tracking/${token}/payment`, { method: 'pix' });
const view = (c, token) => c.get(`/api/tracking/${token}/payment`);
const charge = (id) => fake.state.charges.get(id);
const payOnProvider = (id, extra = {}) => fake.control('pay', { chargeId: id, ...extra });

// ------------------------------------------------------------------------------------------------
section('4. Criar o Pix: valores em reais, divisão fixa de 5% (taxa de serviço) para a master, subconta do estabelecimento, metadata');
const A = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
await clearCalls();
const aPay = await pay(A.c, A.token);
const A1 = payRow(A.number);
{
  check('o Pix é criado (201) e a tela recebe o "copia e cola" da operadora', aPay.status === 201 && aPay.data.payment.status === 'pending' && aPay.data.payment.amount === 25.63 && /^00020101/.test(aPay.data.payment.pix.payload), aPay.data);
  const [tokenCall] = callsTo('POST', '/auth/token');
  const create = callsTo('POST', '/v1/charges/pix');
  check('um token novo, do escopo charges/write, só com credenciais da loja (nunca no corpo do Pix)', tokenCall?.body.scope === 'charges/write' && tokenCall.contentType.includes('x-www-form-urlencoded') && tokenCall.body.has_secret === true && create.length === 1 && create[0].scope === 'charges/write', [tokenCall, create.length]);
  const body = create[0].body;
  check('o valor vai em REAIS (25,63 = R$ 25,00 + taxa de serviço do cliente de R$ 0,63), nunca em centavos', body.amount === 25.63 && body.paymentMethod === 'pix', body);
  check('a taxa de serviço de 5% (R$ 1,25 sobre R$ 25,00) vai como divisão de valor FIXO, sem accountNumber (= conta master)', JSON.stringify(body.split) === JSON.stringify([{ type: 'fixed', amount: 1.25 }]), body.split);
  check('a cobrança nasce na SUBCONTA do estabelecimento (cabeçalho X-Sub-Account)', create[0].subAccount === '4960589', create[0].subAccount);
  check('o pagamento se liga ao pedido pelo metadata (paymentId da loja + número do pedido); externalId não é enviado (a rota Pix não tem idempotência)', body.metadata.paymentId === A1.id && body.metadata.orderNumber === A.number && !('externalId' in body), body);
  check('no banco: operadora do ambiente, código da cobrança, comissão calculada (ainda não efetivada) e validade de 15 minutos', A1.provider === 'validapay-sandbox' && /^cha_/.test(A1.provider_charge_id) && A1.commission_cents === 125 && A1.commission_state === 'calculated' && A1.amount_cents === 2563 && Math.abs(new Date(A1.expires_at) - Date.now() - 15 * 60_000) < 20_000, A1);
  const dup = await pay(A.c, A.token);
  check('clique repetido: a MESMA cobrança, sem criar outra na operadora', dup.status === 200 && dup.data.payment.id === aPay.data.payment.id && callsTo('POST', '/v1/charges/pix').length === 1, dup.data);
  check('o servidor devolve ao cliente só o que ele precisa (nada de comissão, taxas ou código da operadora)', !/commission|fee|cha_|4960589|validapay/i.test(JSON.stringify({ ...dup.data, payment: { ...dup.data.payment, pix: null } })), dup.data);

  const B = await placeOrder([{ product_id: p1010.id, quantity: 1 }]);
  await pay(B.c, B.token);
  const C = await placeOrder([{ product_id: p1765.id, quantity: 1 }]);
  await pay(C.c, C.token);
  const bodies = callsTo('POST', '/v1/charges/pix').map((c) => c.body);
  check('R$ 10,10 → cobra R$ 10,35 com divisão de R$ 0,51 e R$ 17,65 → cobra R$ 18,09 com divisão de R$ 0,88 (5% arredondado UMA vez, no banco)', bodies[1].amount === 10.35 && bodies[1].split[0].amount === 0.51 && bodies[2].amount === 18.09 && bodies[2].split[0].amount === 0.88, [bodies[1], bodies[2]]);
  check('o banco guardou a mesma conta', payRow(B.number).commission_cents === 51 && payRow(C.number).commission_cents === 88);
}

// ------------------------------------------------------------------------------------------------
section('5. Confirmação: só aviso VERIFICADO + consulta à operadora; nunca o corpo do aviso sozinho');
{
  const id = A1.provider_charge_id;
  const body = JSON.stringify(paymentSuccess(charge(id)));
  const before = events();
  const bad = [
    ['assinatura de outro segredo', await hook(null, { rawBody: body, signature: signWebhook(body, { secret: 'outro-segredo' }) })],
    ['assinatura de 6 minutos atrás', await hook(null, { rawBody: body, t: Date.now() - 6 * 60_000 })],
    ['corpo adulterado', await hook(null, { rawBody: body.replace('"amount":25.63', '"amount":1'), signature: signWebhook(body) })],
    ['sem assinatura', await hook(null, { rawBody: body, signature: 'nada' })],
  ];
  for (const [name, r] of bad) check(`aviso ${name}: 401, nada gravado`, r.status === 401, r);
  check('os avisos recusados não gravaram nada nem consultaram a operadora', events() === before && callsTo('GET', `/v1/charges/${id}`).length === 0 && orderRow(A.number).order_status === 'awaiting_payment');

  // O aviso de pagamento chega, mas a operadora AINDA diz que a cobrança está em aberto: o pedido não é liberado.
  const early = await hook(paymentSuccess(charge(id)), { id: 'wh-cedo' });
  check('aviso verificado de "pago" com a cobrança ainda em aberto na operadora: NÃO libera o pedido', early.status === 200 && orderRow(A.number).order_status === 'awaiting_payment' && payRow(A.number).status === 'pending', [early, payRow(A.number).status]);

  await payOnProvider(id, { paidAmount: 25.63, fee: 0.99 });
  await clearCalls();
  const ok1 = await hook(paymentSuccess(charge(id)), { id: 'wh-pago-1' });
  const lookups = calls().filter((c) => c.method === 'GET');
  check('aviso verificado + consulta (status, detalhe e extrato da master): 200', ok1.status === 200 && lookups.some((c) => c.path.endsWith('/status')) && lookups.some((c) => c.path === `/v1/charges/${id}`) && lookups.every((c) => c.scope?.endsWith('/read')), lookups.map((c) => c.path));
  const consultaComCabecalho = lookups.filter((c) => c.path.startsWith('/v1/charges/')).every((c) => c.subAccount === '4960589');
  check('a consulta da cobrança leva o cabeçalho da subconta', consultaComCabecalho, lookups);
  const paid = payRow(A.number);
  check('pago: o pedido vira "novo" na mesma transação, com taxa e líquido da operadora', paid.status === 'paid' && orderRow(A.number).order_status === 'new' && orderRow(A.number).payment_status === 'paid' && paid.fee_cents === 99 && paid.net_cents === 2464 && history(A.number) === '->awaiting_payment | awaiting_payment>new', [paid, history(A.number)]);
  check('a comissão continua só "calculada": a master ainda não mostra o crédito no extrato', paid.commission_state === 'calculated' && paid.commission_confirmed_cents === null, paid);
  const eventsAfter = events();
  const dupe = await hook(paymentSuccess(charge(id)), { id: 'wh-pago-1', attempt: 2 });
  check('o mesmo aviso (mesmo X-Webhook-Id) reenviado é deduplicado: nada se repete', dupe.status === 200 && events() === eventsAfter && history(A.number) === '->awaiting_payment | awaiting_payment>new');
  const dupe2 = await hook(paymentSuccess(charge(id)), { id: 'wh-pago-da-master' });
  check('o aviso da master para a mesma cobrança (outro identificador) não duplica pedido nem repasse', dupe2.status === 200 && history(A.number) === '->awaiting_payment | awaiting_payment>new' && Number(psql('select count(*) from payments')) === 3);

  // Conciliação: a master recebeu o crédito da comissão, ligado a ESTA cobrança.
  await fake.control('credit', { chargeId: 'cha_outra_cobranca', amount: 1.25 });
  const r1 = await owner.post(`/api/admin/payments/${paid.id}/refresh`);
  check('crédito de OUTRA cobrança não confirma a comissão', r1.status === 200 && payRow(A.number).commission_state === 'calculated', payRow(A.number));
  await fake.control('credit', { chargeId: id, amount: 1.25 });
  const r2 = await owner.post(`/api/admin/payments/${paid.id}/refresh`);
  const confirmed = payRow(A.number);
  check('com o crédito da master ligado à cobrança, "Atualizar pagamento" efetiva a taxa (R$ 1,25)', r2.status === 200 && confirmed.commission_state === 'confirmed' && confirmed.commission_confirmed_cents === 125 && confirmed.needs_attention === false, confirmed);

  const noCharge = await hook(paymentSuccess({ id: 'cha_desconhecida_1', amount: 9, metadata: null }), { id: 'wh-desconhecido' });
  check('aviso de cobrança que a loja não conhece: 200, só registrado', noCharge.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'wh-desconhecido'`) === 'unknown_charge');
  const created = await hook({ event: 'charge.created', chargeId: id, status: 'PENDING' }, { id: 'wh-criada' });
  check('aviso informativo (charge.created): 200, registrado e ignorado, sem consultar a operadora', created.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'wh-criada'`) === 'ignored');
  const sub = await hook({ event: 'subscription.created', chargeId: id }, { id: 'wh-assinatura' });
  check('eventos de assinatura (que a loja não usa) também só são registrados', sub.status === 200 && psql(`select outcome from payment_events where dedupe_key = 'wh-assinatura'`) === 'ignored');
  const notJson = await hook(null, { rawBody: 'isto não é json' });
  check('corpo que não é JSON (mesmo assinado): 400', notJson.status === 400, notJson);
}

// ------------------------------------------------------------------------------------------------
section('6. Valor pago diferente do cobrado, comissão diferente da calculada e disputa');
{
  const D = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(D.c, D.token);
  const id = payRow(D.number).provider_charge_id;
  await payOnProvider(id, { paidAmount: 20 });
  await hook(paymentSuccess(charge(id), { amount: 20 }), { id: 'wh-valor-errado' });
  const row = payRow(D.number);
  check('pagou R$ 20 de R$ 25,63: o pedido NÃO é liberado e a cobrança fica sinalizada', orderRow(D.number).order_status === 'awaiting_payment' && row.needs_attention === true && /diferente do valor da cobrança/.test(row.attention_reason) && row.status === 'pending', row);

  const E = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(E.c, E.token);
  const eid = payRow(E.number).provider_charge_id;
  await payOnProvider(eid);
  await fake.control('credit', { chargeId: eid, amount: 1 });
  await hook(paymentSuccess(charge(eid)), { id: 'wh-comissao-menor' });
  const e = payRow(E.number);
  check('a master recebeu R$ 1,00 em vez de R$ 1,25: o pedido é liberado, a comissão fica sinalizada com o valor que a operadora mostra', orderRow(E.number).order_status === 'new' && e.commission_state === 'confirmed' && e.commission_confirmed_cents === 100 && e.needs_attention === true && /Comissão efetivada \(100 centavos\) diferente da calculada \(125\)/.test(e.attention_reason), e);

  await fake.control('set-status', { chargeId: eid, status: 'DISPUTE' });
  const refresh = await owner.post(`/api/admin/payments/${e.id}/refresh`);
  const disputed = payRow(E.number);
  check('disputa (DISPUTE): continua "pago", mas sinalizada para o dono conferir na ValidaPay', refresh.status === 200 && disputed.status === 'paid' && disputed.needs_attention === true && /disputa/.test(disputed.attention_reason), disputed);
  await fake.control('set-status', { chargeId: eid, status: 'REFUNDED' });
  await fake.state.refunds.push({ refundId: 'ref_1', chargeId: eid, status: 'CONFIRMED', success: true, amount: 25.63 });
  await owner.post(`/api/admin/payments/${e.id}/refresh`);
  check('devolução total confirmada pela operadora: a cobrança vira "estornada" e o pedido fica com pagamento "reembolsado"', payRow(E.number).status === 'refunded' && payRow(E.number).refunded_cents === 2563 && orderRow(E.number).payment_status === 'refunded', payRow(E.number));
}

// ------------------------------------------------------------------------------------------------
section('7. Pix vencido: a loja CANCELA a cobrança na operadora (o QR Code deixa de valer) antes de encerrá-la');
{
  const F = await placeOrder([{ product_id: p25.id, quantity: 2 }]);
  await pay(F.c, F.token);
  const fid = payRow(F.number).provider_charge_id;
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(F.number).id)}`);
  await clearCalls();
  const v = await view(F.c, F.token);
  const seq = calls().filter((c) => c.path.includes(fid)).map((c) => `${c.method} ${c.path.replace(fid, '{id}')}`);
  check('venceu: confere a cobrança, cancela na operadora e mostra "O Pix venceu" na hora', v.status === 200 && v.data.payment.status === 'expired' && v.data.payment.can_retry === true && v.data.payment.pix === null && /venceu/.test(v.data.payment.message) && JSON.stringify(seq) === JSON.stringify(['GET /v1/charges/{id}/status', 'DELETE /v1/charges/{id}']), [v.data, seq]);
  check('na operadora a cobrança ficou CANCELED (o QR Code antigo não aceita mais pagamento)', charge(fid).status === 'CANCELED' && callsTo('DELETE', fid)[0].scope === 'charges/write' && callsTo('DELETE', fid)[0].subAccount === '4960589');
  const lateTry = await fake.control('pay', { chargeId: fid });
  check('pagar o QR Code antigo depois do cancelamento é recusado pela operadora', lateTry.error !== undefined);
  const again = await pay(F.c, F.token);
  check('o cliente gera um novo Pix e só ele vale', again.status === 201 && again.data.payment.attempt === 2 && payRow(F.number, 2).provider_charge_id !== fid, again.data);

  // Corrida: o cliente paga no instante em que a loja cancela.
  const G = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(G.c, G.token);
  const gid = payRow(G.number).provider_charge_id;
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(G.number).id)}`);
  await fake.control('mode', { paidBetweenLookupAndCancel: gid });
  const race = await view(G.c, G.token);
  check('pago no instante do cancelamento: a operadora recusa cancelar (já paga), a loja reconsulta e registra o PAGAMENTO (não o vencimento)', race.data.payment.status === 'paid' && orderRow(G.number).order_status === 'new' && callsTo('DELETE', gid).length === 1, [race.data, orderRow(G.number).order_status]);

  // Operadora fora do ar na hora de cancelar: a cobrança fica em aberto e a próxima conferência termina o serviço.
  const H = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(H.c, H.token);
  const hid = payRow(H.number).provider_charge_id;
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(H.number).id)}`);
  await fake.control('mode', { cancelFail: true });
  const stuck = await view(H.c, H.token);
  check('não deu para cancelar na operadora: a cobrança continua em aberto (não é encerrada às cegas)', stuck.status === 200 && stuck.data.payment.status === 'pending' && charge(hid).status === 'PENDING' && orderRow(H.number).order_status === 'awaiting_payment', stuck.data);
  await fake.control('mode', { cancelFail: false });
  const swept = await owner.post('/api/admin/payments/sweep');
  check('"Conferir agora": cancela na operadora e encerra', swept.status === 200 && charge(hid).status === 'CANCELED' && payRow(H.number).status === 'expired', [swept.data, payRow(H.number).status]);
  const I = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await pay(I.c, I.token);
  psql(`update payments set expires_at = now() - interval '1 minute' where id = ${lit(payRow(I.number).id)}`);
  await fake.control('mode', { statusFail: true });
  const down = await view(I.c, I.token);
  check('operadora fora do ar na consulta: nada é encerrado nem cancelado', down.status === 200 && down.data.payment.status === 'pending' && callsTo('DELETE', payRow(I.number).provider_charge_id).length === 0, down.data);
  await fake.control('mode', { statusFail: false });
}

// ------------------------------------------------------------------------------------------------
section('8. Falhas ao criar o Pix e a cobrança "órfã" (criada lá, resposta perdida)');
{
  const J = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
  await fake.control('mode', { createFail: 'invalid' });
  const rejected = await pay(J.c, J.token);
  check('a operadora recusa os dados (400): erro claro, tentativa encerrada sem sinalizar (definitivo)', rejected.status === 502 && rejected.data.code === 'provider_rejected' && payRow(J.number).status === 'failed' && payRow(J.number).needs_attention === false, [rejected.status, rejected.data]);
  await fake.control('mode', { createFail: 'down' });
  const down = await pay(J.c, J.token);
  const j2 = payRow(J.number);
  check('a operadora cai (500): 503, a tentativa é sinalizada (a cobrança PODE ter sido criada)', down.status === 503 && down.data.code === 'provider_unavailable' && j2.status === 'failed' && j2.needs_attention === true && /Sem resposta da operadora/.test(j2.attention_reason), [down.status, j2]);
  await fake.control('mode', { createFail: 'hang' });
  const t0 = Date.now();
  const hang = await pay(J.c, J.token);
  check('sem resposta: o adaptador desiste no prazo (não trava o cliente) e sinaliza', hang.status === 503 && Date.now() - t0 < 6000 && payRow(J.number).needs_attention === true, [hang.status, Date.now() - t0]);
  await fake.control('mode', { createFail: null });

  // Cobrança órfã: criada na operadora, mas a resposta nunca chegou à loja. O cliente nunca viu esse QR Code; se alguém o pagar, o aviso traz
  // o metadata.paymentId e a loja o reconhece pela referência.
  const failed = payRow(J.number, 3);
  const orphan = await fake.control('charge', { amount: 25.63, sub: '4960589', metadata: { paymentId: failed.id, orderNumber: J.number } });
  await payOnProvider(orphan.id, { paidAmount: 25.63 });
  const hookResult = await hook(paymentSuccess(orphan), { id: 'wh-orfa' });
  const after = payRow(J.number, 3);
  check('aviso de uma cobrança que a loja não guardou: achada pela referência (metadata.paymentId), código guardado, pago e pedido liberado', hookResult.status === 200 && after.provider_charge_id === orphan.id && after.status === 'paid' && orderRow(J.number).order_status === 'new', [hookResult, after]);
}

// ------------------------------------------------------------------------------------------------
section('9. A consulta da subconta funciona com ou sem o cabeçalho X-Sub-Account (a documentação não deixa claro qual vale)');
{
  for (const mode of ['required', 'forbidden']) {
    await fake.control('mode', { subHeaderOnRead: mode });
    const K = await placeOrder([{ product_id: p25.id, quantity: 1 }]);
    await pay(K.c, K.token);
    const kid = payRow(K.number).provider_charge_id;
    await payOnProvider(kid);
    await fake.control('credit', { chargeId: kid, amount: 1.25 });
    const r = await hook(paymentSuccess(charge(kid)), { id: `wh-sub-${mode}` });
    check(`consulta da cobrança com a operadora no modo "${mode}": paga e comissão efetivada`, r.status === 200 && payRow(K.number).status === 'paid' && payRow(K.number).commission_state === 'confirmed', payRow(K.number));
  }
  await fake.control('mode', { subHeaderOnRead: 'any' });
}

// ------------------------------------------------------------------------------------------------
section('10. Cadastro de uma conta nova: reprovação, aprovação só pela confirmação oficial, nada de duplicar');
// Libera o vínculo atual (a conta antiga passa a "suspensa", fora do que vale como cadastro ativo).
psql(`update merchant_accounts set status = 'suspended'`);
const pfForm = () => ({
  documentNumber: '529.982.247-25',
  fullName: 'Fulano de Tal da Silva',
  email: 'titular@exemplo.com.br',
  phoneNumber: '(34) 99128-3384',
  motherName: 'Maria da Silva Sauro',
  socialName: '',
  birthDate: '1990-12-31',
  isPoliticallyExposedPerson: false,
  address: { postalCode: '38400-000', street: 'Rua das Flores Secretas', number: '45', addressComplement: '', neighborhood: 'Centro', city: 'Uberlândia', state: 'MG' },
  financialDetails: { declaredIncome: 'DINP02', occupation: 'ONP27', netWorth: 'NWNP02' },
});
const pjForm = () => ({
  documentNumber: '11.222.333/0001-81',
  businessName: 'Disk Bebidas Ltda',
  tradingName: 'Disk Bebidas',
  companyType: 'ME',
  businessEmail: 'contato@diskbebidas.com.br',
  contactNumber: '34991283384',
  businessAddress: { postalCode: '38400000', street: 'Av. Principal', number: '100', addressComplement: 'Loja 2', neighborhood: 'Centro', city: 'Uberlândia', state: 'MG' },
  owner: {
    documentNumber: '52998224725',
    fullName: 'Fulano de Tal da Silva',
    phoneNumber: '34988887777',
    email: 'socio@diskbebidas.com.br',
    motherName: 'Maria da Silva Sauro',
    socialName: 'Fulano',
    birthDate: '1985-12-31',
    isPoliticallyExposedPerson: false,
    address: { postalCode: '38400000', street: 'Rua B', number: '5', addressComplement: '', neighborhood: 'Centro', city: 'Uberlândia', state: 'MG' },
    financialOwnerDetails: { ownerDeclaredIncome: 'ODIB02', ownerDeclaredRevenue: 'ODRB02' },
  },
});
const proposal = (c, over = {}) => c.post('/api/admin/payments/account/proposal', { kind: 'pf', authorized: true, form: pfForm(), ...over });
const merchantRow = () => JSON.parse(psql(`select row_to_json(m) from merchant_accounts m where status <> 'suspended' order by created_at desc limit 1`) || 'null');
const proposalPosts = () => callsTo('POST', '/v1/proposals').length;
const o1 = await ownerFrom('198.51.100.51');
await clearCalls();
{
  const noAuth = await proposal(o1, { authorized: false });
  check('sem a autorização do titular: 400 authorization_required, nada enviado', noAuth.status === 400 && noAuth.data.code === 'authorization_required' && proposalPosts() === 0, noAuth.data);
  const bad = await proposal(o1, { form: { ...pfForm(), documentNumber: '111.111.111-11', email: 'x' } });
  check('formulário inválido: 400 com os campos errados, e NADA vai para a operadora (nem custa tarifa)', bad.status === 400 && bad.data.code === 'invalid_form' && 'documentNumber' in bad.data.fields && 'email' in bad.data.fields && proposalPosts() === 0 && merchantRow() === null, bad.data);
  check('tipo de cadastro inválido: 400', (await proposal(o1, { kind: 'mei' })).status === 400);

  const sent = await proposal(o1);
  const row = merchantRow();
  const post = callsTo('POST', '/v1/proposals')[0];
  check('cadastro PF enviado: 201, "pending", com o identificador do formulário mascarado na resposta', sent.status === 201 && sent.data.account.status === 'pending' && sent.data.account.kind === 'pf' && sent.data.account.proposal_id !== row.proposal_id && /^[0-9a-f-]{36}$/.test(row.proposal_id), [sent.status, sent.data]);
  check('o corpo enviado segue o contrato (CPF só dígitos, telefone E.164, data DD-MM-AAAA, códigos financeiros) e não leva webhookUrl', post.scope === 'proposals/write' && post.body.documentNumber === '52998224725' && post.body.phoneNumber === '+5534991283384' && post.body.birthDate === '31-12-1990' && post.body.address.postalCode === '38400000' && post.body.financialDetails.occupation === 'ONP27' && !('webhookUrl' in post.body), post.body);
  check('foi gravada a autorização (quem e quando) e o aceite de tarifas não era exigido no sandbox', row.authorized_by !== null && row.fees_acknowledged_at === null && row.ambiguous === false);
  const again = await proposal(o1);
  check('segundo envio com um cadastro em andamento: 409 account_conflict, sem nova chamada à operadora', again.status === 409 && again.data.code === 'account_conflict' && proposalPosts() === 1, again.data);
  const link = await o1.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  check('vincular outra conta com cadastro em andamento também é recusado', link.status === 409 && link.data.code === 'account_conflict', link.data);
  const refresh = await o1.post('/api/admin/payments/account/refresh');
  check('"Atualizar": traz a situação e o endereço de envio dos documentos (que NÃO é guardado)', refresh.status === 200 && /formulário FINISHED/.test(refresh.data.account.status_detail) && /^https:\/\/documentos/.test(refresh.data.documents_url) && !psql('select string_agg(coalesce(status_detail, \'\'), \'|\') from merchant_accounts').includes('documentos.exemplo'), refresh.data);

  // Avisos assinados da operadora sobre o cadastro.
  const formId = row.proposal_id;
  const onboarding = (event, data, id) => hook({ event, timestamp: new Date().toISOString(), accountId: '4231833', data: { formId, proposalId: 'p-1', documentNumber: '52998224725', ...data } }, { id });
  const bg = await onboarding('onboarding.backgroundcheck', { status: 'PENDING', proposalType: 'PF' }, 'wh-bg');
  check('etapa em análise: continua pendente', bg.status === 200 && merchantRow().status === 'pending' && /análise de background/.test(merchantRow().status_detail), merchantRow());
  const step = await onboarding('onboarding.proposal', { status: 'APPROVED', proposalType: 'PF' }, 'wh-prop-ok');
  check('"proposta aprovada" NÃO aprova a conta: sem o número oficial ela continua pendente e sem identificador', step.status === 200 && merchantRow().status === 'pending' && merchantRow().provider_account_id === null, merchantRow());
  const fakeCreate = await onboarding('onboarding.create', { status: 'APPROVED', account: { number: '777000111' } }, 'wh-create-approved');
  check('onboarding.create com status APPROVED (e não CONFIRMED): ignorado, nada é aprovado', fakeCreate.status === 200 && merchantRow().status === 'pending' && merchantRow().provider_account_id === null);
  const unknown = await hook({ event: 'onboarding.create', timestamp: new Date().toISOString(), accountId: '4231833', data: { formId: 'de-outra-proposta-qualquer', status: 'CONFIRMED', account: { number: '555000222' } } }, { id: 'wh-estranho' });
  check('aviso de uma proposta que a loja não conhece: 200, só registrado, nenhuma conta é criada', unknown.status === 200 && Number(psql(`select count(*) from merchant_accounts where provider_account_id = '555000222'`)) === 0 && merchantRow().status === 'pending', [unknown, merchantRow()]);
  const forged = await hook({ event: 'onboarding.create', data: { formId, status: 'CONFIRMED', account: { number: '1' } } }, { id: 'wh-falso', secret: 'segredo-errado' });
  check('aviso de aprovação com assinatura falsa: 401 e a conta não muda', forged.status === 401 && merchantRow().status === 'pending');
  const reproved = await onboarding('onboarding.proposal', { status: 'REPROVED', proposalType: 'PF' }, 'wh-prop-no');
  check('reprovada pela operadora: status "rejected" com o motivo; deixa de ser cadastro ativo', reproved.status === 200 && merchantRow().status === 'rejected' && /Reprovado/.test(merchantRow().status_detail), merchantRow());

  // Nova tentativa (PJ) depois de reprovado.
  const o2 = await ownerFrom('198.51.100.52');
  const pj = await proposal(o2, { kind: 'pj', form: pjForm() });
  const pjPost = callsTo('POST', '/v1/proposals')[1];
  check('depois de reprovada, uma nova tentativa (PJ) é aceita e vira outro cadastro', pj.status === 201 && merchantRow().kind === 'pj' && merchantRow().status === 'pending' && proposalPosts() === 2, pj.data);
  check('o corpo PJ segue o contrato (sócio, faturamento, tipo da empresa, CNPJ só dígitos)', pjPost.body.documentNumber === '11222333000181' && pjPost.body.companyType === 'ME' && pjPost.body.owner[0].ownerType === 'SOCIO' && pjPost.body.owner[0].financialOwnerDetails.ownerDeclaredRevenue === 'ODRB02' && pjPost.body.contactNumber === '+5534991283384', pjPost.body);
  const pjForm2 = merchantRow().proposal_id;
  const confirm = await hook({ event: 'onboarding.create', timestamp: new Date().toISOString(), accountId: '4231833', data: { formId: pjForm2, proposalId: 'p-2', documentNumber: '11222333000181', status: 'CONFIRMED', account: { number: '483918595', branch: '0001', name: 'Disk Bebidas Ltda' } } }, { id: 'wh-create-ok' });
  const approved = merchantRow();
  check('só o aviso oficial onboarding.create CONFIRMED com o número da conta aprova: identificador definitivo gravado', confirm.status === 200 && approved.status === 'approved' && approved.provider_account_id === '483918595', approved);
  const repeat = await hook({ event: 'onboarding.create', timestamp: new Date().toISOString(), accountId: '4231833', data: { formId: pjForm2, status: 'CONFIRMED', account: { number: '483918595' } } }, { id: 'wh-create-ok' });
  check('o mesmo aviso repetido não muda nada', repeat.status === 200 && merchantRow().provider_account_id === '483918595');
  const late = await hook({ event: 'onboarding.proposal', timestamp: new Date().toISOString(), accountId: '4231833', data: { formId: pjForm2, status: 'REPROVED' } }, { id: 'wh-tarde' });
  check('um aviso de reprovação tardio não desfaz a conta já aprovada', late.status === 200 && merchantRow().status === 'approved');

  // Os dados pessoais não ficam na loja.
  const stored = psql(`select coalesce(string_agg(row_to_json(m)::text, ' '), '') from merchant_accounts m`) + psql(`select coalesce(string_agg(summary || ' ' || coalesce(details::text, '') || ' ' || coalesce(entity_id, ''), ' '), '') from audit_log`);
  const log = serverLog();
  const secrets = ['52998224725', '529.982.247-25', '11222333000181', 'Maria da Silva Sauro', 'titular@exemplo.com.br', 'Rua das Flores Secretas', '991283384', 'documentos.exemplo'];
  check('dados pessoais do titular não estão no banco da loja nem no histórico de atividades', secrets.every((s) => !stored.includes(s)), secrets.filter((s) => stored.includes(s)));
  check('...nem no log do servidor', secrets.every((s) => !log.includes(s)), secrets.filter((s) => log.includes(s)));
}

// ------------------------------------------------------------------------------------------------
section('11. Cadastro: falhas da operadora, resposta perdida (pode ter cobrado) e cliques simultâneos');
{
  const reset = () => psql(`update merchant_accounts set status = 'suspended' where status in ('draft', 'submitted', 'pending', 'approved')`);
  reset();
  const o = await ownerFrom('198.51.100.53');
  await fake.control('mode', { proposal: 'balance' });
  const balance = await proposal(o);
  check('saldo insuficiente da master (409): "error" com a explicação da tarifa, tentativa livre para repetir', balance.status === 201 && merchantRow().status === 'error' && /Saldo insuficiente/.test(merchantRow().status_detail) && merchantRow().ambiguous === false, merchantRow());
  await fake.control('mode', { proposal: 'conflict' });
  const conflict = await proposal(o);
  check('a operadora recusa como duplicado (409): status "duplicate"', conflict.status === 201 && merchantRow().status === 'duplicate' && /duplicado/.test(merchantRow().status_detail), merchantRow());
  await fake.control('mode', { proposal: 'invalid' });
  const invalid = await proposal(o);
  check('a operadora recusa os dados (400): "error" com o motivo dela', invalid.status === 201 && merchantRow().status === 'error' && /recusou o cadastro/.test(merchantRow().status_detail), merchantRow());
  const posts = proposalPosts();

  await fake.control('mode', { proposal: 'hang' });
  const hang = await proposal(o);
  const amb = merchantRow();
  check('sem resposta ao enviar: "error" AMBÍGUO (a proposta pode ter sido criada e cobrada)', hang.status === 201 && amb.status === 'error' && amb.ambiguous === true && /PODE ter sido criado/.test(amb.status_detail), amb);
  await fake.control('mode', { proposal: null });
  const blocked = await proposal(o);
  check('depois de uma resposta perdida, nova tentativa exige confirmação explícita (409 confirm_duplicate_risk), sem chamar a operadora', blocked.status === 409 && blocked.data.code === 'confirm_duplicate_risk' && proposalPosts() === posts + 1, blocked.data);
  const confirmed = await proposal(o, { confirm_duplicate_risk: true });
  check('com a confirmação do dono, a nova tentativa segue', confirmed.status === 201 && merchantRow().status === 'pending' && merchantRow().ambiguous === false, merchantRow());

  // Cliques simultâneos: exatamente UM cadastro e UMA chamada à operadora.
  reset();
  const before = proposalPosts();
  const racers = await Promise.all(Array.from({ length: 5 }, (_v, i) => ownerFrom(`198.51.100.${70 + i}`)));
  const results = await Promise.all(racers.map((c) => proposal(c)));
  check('cinco envios ao mesmo tempo: um 201 e quatro 409 (o banco só deixa um cadastro ativo)', results.filter((r) => r.status === 201).length === 1 && results.filter((r) => r.status === 409).length === 4, results.map((r) => r.status));
  check('...e a operadora recebeu UMA proposta só (nenhuma tarifa dobrada)', proposalPosts() === before + 1 && Number(psql(`select count(*) from merchant_accounts where status in ('draft','submitted','pending','approved')`)) === 1);
  const log = serverLog();
  check('credenciais, token, segredo do webhook e o Pix "copia e cola" não aparecem no log do servidor (modo sandbox, depois de todos os fluxos)', SECRET_TEXTS.every((s) => !log.includes(s)) && !log.includes(A.token), SECRET_TEXTS.filter((s) => log.includes(s)));
  check('limite de envios: o mesmo endereço não consegue mais de 8 cadastros por hora', await (async () => {
    const c = await ownerFrom('198.51.100.99');
    let last;
    for (let i = 0; i < 9; i++) last = await proposal(c, { authorized: false });
    return last.status === 429;
  })());
}

// ------------------------------------------------------------------------------------------------
section('12. Produção: só com a ciência das tarifas; conta de teste e de produção nunca se misturam');
{
  startServer({ FAKE_VALIDAPAY_ENV: 'production' });
  const o = await ownerFrom('198.51.100.90');
  const overview = (await o.get('/api/admin/payments')).data;
  check('produção: a operadora usa o nome "validapay" e informa a tarifa de criação (R$ 15,00 = 1500 centavos)', overview.provider.name === 'validapay' && overview.provider.environment === 'production' && overview.account_fee_cents === 1500, [overview.provider, overview.account_fee_cents]);
  check('a conta do sandbox não aparece em produção (cada ambiente tem o seu cadastro)', overview.merchant === null && overview.readiness.ready === false, overview.merchant);
  await clearCalls();
  const noFees = await o.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  check('vincular conta SEM a ciência das tarifas: 400 fees_ack_required (e nada é consultado)', noFees.status === 400 && noFees.data.code === 'fees_ack_required' && calls().length === 0, noFees.data);
  const noFeesNew = await o.post('/api/admin/payments/account/proposal', { kind: 'pf', authorized: true, form: pfForm() });
  check('cadastrar conta SEM a ciência da tarifa de R$ 15,00: 400 fees_ack_required, nada enviado', noFeesNew.status === 400 && noFeesNew.data.code === 'fees_ack_required' && /15,00/.test(noFeesNew.data.error) && callsTo('POST', '/v1/proposals').length === 0, noFeesNew.data);
  const link = await o.post('/api/admin/payments/account/link', { account_number: '4960589', authorized: true, fees_acknowledged: true });
  const row = JSON.parse(psql(`select row_to_json(m) from merchant_accounts m where provider = 'validapay'`));
  check('com a ciência das tarifas: vincula e grava quando o dono declarou conhecê-las', link.status === 201 && row.fees_acknowledged_at !== null && row.provider === 'validapay' && row.fees_snapshot.environment === 'production', row);
  const on = await o.patch('/api/admin/payments/pix_online', { enabled: true });
  check('...e então o Pix online pode ser ligado em produção', on.status === 200 && on.data.payment.enabled === true, on.data);
  psql(`update merchant_accounts set fees_acknowledged_at = null where provider = 'validapay'`);
  const notReady = (await o.get('/api/admin/payments')).data.readiness;
  check('conta de produção sem o registro da ciência das tarifas não conta como pronta', notReady.ready === false, notReady);
}

// ------------------------------------------------------------------------------------------------
section('13. Nada sensível no log do servidor');
{
  const log = serverLog();
  check('credenciais, token, segredo do webhook e o Pix "copia e cola" não aparecem no log (deste servidor, em modo produção)', SECRET_TEXTS.every((s) => !log.includes(s)), SECRET_TEXTS.filter((s) => log.includes(s)));
  check('nem o código de acompanhamento dos pedidos', !log.includes(A.token));
}

serve();
await fake.stop();
summary();
