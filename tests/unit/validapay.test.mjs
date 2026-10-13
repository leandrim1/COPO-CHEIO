import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { load } from './load.mjs';

// O adaptador REAL da ValidaPay, com um `fetch` de mentira que confere cada pedido contra o que a documentação oficial diz.
// Nada aqui fala com a ValidaPay: prova a tradução e as regras do adaptador, não o comportamento da ValidaPay de verdade.
const mod = await load('server/payments/validapay.ts');
const merchantMod = await load('server/payments/merchant.ts');

const SECRET = 'segredo-de-teste';
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Servidor de mentira: `routes` é uma lista de [método, regex do caminho, função(req) => Response]; guarda tudo o que recebeu.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      method: init.method ?? 'GET',
      url,
      path: url.pathname,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body,
    };
    calls.push(call);
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(String(init.body));
      call.form = Object.fromEntries(form);
      return ok({ access_token: `tok-${form.get('scope')}-${calls.length}`, expires_in: 3600, token_type: 'Bearer' });
    }
    for (const [method, pattern, handler] of routes) {
      if (method === call.method && pattern.test(url.pathname)) return handler(call);
    }
    return ok({ error: { code: 'NOT_FOUND', message: 'rota' } }, 404);
  };
  return { fetchImpl, calls, api: (name) => calls.filter((c) => c.path !== '/auth/token' && (!name || c.path.includes(name))) };
}

const provider = (routes, over = {}) => {
  const f = fakeFetch(routes);
  const p = mod.createValidaPayProvider({
    environment: 'sandbox',
    clientId: 'cid',
    clientSecret: 'csecret',
    webhookSecret: SECRET,
    apiUrl: 'https://api.teste',
    authUrl: 'https://api.teste/auth/token',
    fetch: f.fetchImpl,
    ...over,
  });
  return { p, f };
};

// ---- variáveis de ambiente ----------------------------------------------------------------------------------------------------------

test('sem as variáveis, nada liga e só os NOMES que faltam são informados', () => {
  const none = mod.validaPayFromEnv({});
  assert.equal(none.provider, null);
  assert.deepEqual(none.missing, ['VALIDAPAY_ENV', 'VALIDAPAY_CLIENT_ID', 'VALIDAPAY_CLIENT_SECRET', 'VALIDAPAY_WEBHOOK_SECRET']);
  const partial = mod.validaPayFromEnv({ VALIDAPAY_ENV: 'sandbox', VALIDAPAY_CLIENT_ID: 'x', VALIDAPAY_CLIENT_SECRET: '   ' });
  assert.deepEqual(partial.missing, ['VALIDAPAY_CLIENT_SECRET', 'VALIDAPAY_WEBHOOK_SECRET'], 'valor em branco conta como faltando');
  const withSecrets = mod.validaPayFromEnv({ VALIDAPAY_ENV: 'banana', VALIDAPAY_CLIENT_ID: 'id-secreto-1', VALIDAPAY_CLIENT_SECRET: 'segredo-2', VALIDAPAY_WEBHOOK_SECRET: 'whsec-3' });
  assert.equal(withSecrets.provider, null);
  assert.match(withSecrets.note, /sandbox/);
  assert.doesNotMatch(JSON.stringify(withSecrets), /id-secreto-1|segredo-2|whsec-3/, 'nenhum valor sai nas informações de configuração');
});

test('sandbox liga; produção só liga no deploy de produção (preview nunca fala com a ValidaPay de verdade)', () => {
  const base = { VALIDAPAY_CLIENT_ID: 'id', VALIDAPAY_CLIENT_SECRET: 's', VALIDAPAY_WEBHOOK_SECRET: 'w' };
  const sandbox = mod.validaPayFromEnv({ ...base, VALIDAPAY_ENV: 'Sandbox' });
  assert.equal(sandbox.provider.name, 'validapay-sandbox');
  assert.equal(sandbox.provider.merchant.environment, 'sandbox');
  assert.equal(sandbox.provider.merchant.accountCreationFeeCents, 0, 'sandbox não cobra a criação da conta');
  const preview = mod.validaPayFromEnv({ ...base, VALIDAPAY_ENV: 'production', VERCEL_ENV: 'preview' });
  assert.equal(preview.provider, null);
  assert.match(preview.note, /deploy de produção/);
  const prod = mod.validaPayFromEnv({ ...base, VALIDAPAY_ENV: 'production', VERCEL_ENV: 'production' });
  assert.equal(prod.provider.name, 'validapay', 'só a produção usa o nome sem sufixo');
  assert.equal(prod.provider.merchant.accountCreationFeeCents, 1500, 'produção: R$ 15,00 pela criação da subconta (documentação)');
  assert.equal(mod.validaPayFromEnv({ ...base, VALIDAPAY_ENV: 'production' }).provider.name, 'validapay', 'fora da Vercel (sem VERCEL_ENV) a produção liga');
});

// ---- criar o Pix --------------------------------------------------------------------------------------------------------------------

const createInput = { paymentId: '0b6f7a1e-3c58-4d0e-9a3a-5f1d2c4e8b11', orderNumber: 1005, amountCents: 1010, commissionCents: 51, merchantAccountId: '4960589', expiresInSeconds: 900, description: 'Pedido #1005' };

test('createPixCharge: pedido exatamente como a documentação manda (reais, split fixo para a master, X-Sub-Account, metadata)', async () => {
  const { p, f } = provider([['POST', /^\/v1\/charges\/pix$/, () => ok({ chargeId: 'cha_1_abc', emv: '0002010102122691', qrCode: 'data:image/png;base64,AAAA', metadata: { orderNumber: 1005 } })]]);
  const created = await p.createPixCharge(createInput);
  assert.equal(created.providerChargeId, 'cha_1_abc');
  assert.equal(created.qrPayload, '0002010102122691');
  const token = f.calls[0];
  assert.equal(token.path, '/auth/token');
  assert.equal(token.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(token.form, { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csecret', scope: 'charges/write' });
  const [call] = f.api();
  assert.equal(call.headers['x-sub-account'], '4960589');
  assert.match(call.headers.authorization, /^Bearer tok-charges\/write/);
  const body = JSON.parse(call.body);
  assert.equal(body.amount, 10.1, 'valor em REAIS, nunca em centavos');
  assert.equal(body.paymentMethod, 'pix');
  assert.deepEqual(body.split, [{ type: 'fixed', amount: 0.51 }], 'a comissão é um valor fixo, sem accountNumber (vai para a master)');
  assert.deepEqual(body.metadata, { paymentId: createInput.paymentId, orderNumber: 1005 }, 'metadata liga o pagamento ao pedido e volta no aviso');
  assert.equal('externalId' in body, false, 'a rota Pix não tem idempotência: externalId é descartado, então não é enviado');
  assert.equal(created.expiresAt.getTime() > Date.now() + 800_000 && created.expiresAt.getTime() < Date.now() + 1_000_000, true, 'validade da loja (15 min), não a da operadora');
});

test('createPixCharge: sem comissão não há divisão; valores quebrados viram reais certinhos', async () => {
  const { p, f } = provider([['POST', /\/v1\/charges\/pix$/, () => ok({ chargeId: 'cha_2', emv: '000201' })]]);
  await p.createPixCharge({ ...createInput, amountCents: 5, commissionCents: 0 });
  await p.createPixCharge({ ...createInput, amountCents: 99999, commissionCents: 5000 });
  const bodies = f.api().map((c) => JSON.parse(c.body));
  assert.equal('split' in bodies[0], false);
  assert.equal(bodies[0].amount, 0.05);
  assert.equal(bodies[1].amount, 999.99);
  assert.deepEqual(bodies[1].split, [{ type: 'fixed', amount: 50 }]);
});

test('createPixCharge: o token é pedido uma vez por escopo e reaproveitado; 401 derruba o token', async () => {
  let unauthorized = false;
  const { p, f } = provider([['POST', /\/v1\/charges\/pix$/, () => (unauthorized ? ok({ error: { code: 'UNAUTHORIZED' } }, 401) : ok({ chargeId: 'cha_3', emv: '000201' }))]]);
  await p.createPixCharge(createInput);
  await p.createPixCharge(createInput);
  assert.equal(f.calls.filter((c) => c.path === '/auth/token').length, 1, 'segundo pedido reaproveita o token');
  unauthorized = true;
  await assert.rejects(p.createPixCharge(createInput), (error) => error.kind === 'rejected' && error.httpStatus === 401);
  unauthorized = false;
  await p.createPixCharge(createInput);
  assert.equal(f.calls.filter((c) => c.path === '/auth/token').length, 2, 'depois do 401 pede um token novo');
});

test('createPixCharge: erros viram "rejected" (definitivo) ou "unavailable" (ambíguo), sem vazar segredos', async () => {
  const cases = [
    [400, { error: { code: 'INVALID_DATA', message: 'campo inválido' } }, 'rejected'],
    [403, { error: { code: 'FORBIDDEN' } }, 'rejected'],
    [409, { error: { code: 'X' } }, 'rejected'],
    [500, { error: { code: 'INTERNAL' } }, 'unavailable'],
    [503, null, 'unavailable'],
    [429, null, 'unavailable'],
  ];
  for (const [status, data, kind] of cases) {
    const { p } = provider([['POST', /\/v1\/charges\/pix$/, () => ok(data, status)]]);
    await assert.rejects(p.createPixCharge(createInput), (error) => {
      assert.equal(error.kind, kind, `HTTP ${status}`);
      assert.doesNotMatch(error.message, /csecret|Bearer|tok-/);
      return true;
    });
  }
  // Resposta 200 sem chargeId/emv: a cobrança pode existir lá, então é ambíguo.
  const { p: incomplete } = provider([['POST', /\/v1\/charges\/pix$/, () => ok({ chargeId: 'cha_9' })]]);
  await assert.rejects(incomplete.createPixCharge(createInput), (error) => error.kind === 'unavailable');
  // Sem resposta (rede): ambíguo.
  const { p: down } = provider([['POST', /\/v1\/charges\/pix$/, () => Promise.reject(new TypeError('fetch failed'))]]);
  await assert.rejects(down.createPixCharge(createInput), (error) => error.kind === 'unavailable');
  // Sem token: nenhuma cobrança foi criada, então é definitivo.
  const { p: noToken } = provider([], { fetch: async () => ok({ error: 'invalid_client' }, 401) });
  await assert.rejects(noToken.createPixCharge(createInput), (error) => error.kind === 'rejected' && error.code === 'TOKEN_REJECTED');
});

test('createPixCharge: dados da loja inválidos nem chegam à operadora', async () => {
  const { p, f } = provider([['POST', /\/v1\/charges\/pix$/, () => ok({ chargeId: 'cha', emv: '00' })]]);
  for (const bad of [{ amountCents: 0 }, { amountCents: 10.5 }, { amountCents: -1 }, { merchantAccountId: 'a b' }, { merchantAccountId: '' }]) {
    await assert.rejects(p.createPixCharge({ ...createInput, ...bad }), (error) => error.kind === 'rejected');
  }
  assert.equal(f.calls.length, 0);
});

// ---- consultar a cobrança -----------------------------------------------------------------------------------------------------------

const detail = (over = {}) => ({ chargeId: 'cha_5', status: 'PAID', amount: 25, paidAmount: 25, netAmount: 24.01, fee: { amount: 0.99 }, paidAt: '2026-10-11T12:00:00.000Z', ...over });

test('getCharge: cobrança em aberto usa só a rota leve de status; paga busca taxa, líquido e valor pago', async () => {
  const state = { status: 'AWAITING_PAYMENT', paidAt: null };
  const { p, f } = provider([
    ['GET', /\/status$/, () => ok({ chargeId: 'cha_5', status: state.status, amount: 25, paidAt: state.paidAt })],
    ['GET', /^\/v1\/charges\/cha_5$/, () => ok(detail())],
  ]);
  const open = await p.getCharge('cha_5', { merchantAccountId: '4960589', commissionCents: 125 });
  assert.equal(open.status, 'pending');
  assert.equal(open.amountCents, 2500);
  assert.equal(open.paidAt, null);
  assert.equal(f.api().length, 1, 'não buscou o detalhe');
  assert.equal(f.api()[0].headers['x-sub-account'], '4960589');
  state.status = 'PAID';
  state.paidAt = '2026-10-11T12:00:00.000Z';
  const paid = await p.getCharge('cha_5', { merchantAccountId: '4960589', commissionCents: 0 });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.amountCents, 2500);
  assert.equal(paid.feeCents, 99);
  assert.equal(paid.netCents, 2401);
  assert.equal(paid.paidAt.toISOString(), '2026-10-11T12:00:00.000Z');
});

test('getCharge: traduz todos os status documentados e recusa os que não conhece', async () => {
  const expected = { PENDING: 'pending', PROCESSING: 'pending', AWAITING_PAYMENT: 'pending', PAID: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELED: 'cancelled', ARCHIVED: 'cancelled', REFUNDED: 'refunded', DISPUTE: 'paid', CHARGED_BACK: 'paid' };
  for (const [raw, status] of Object.entries(expected)) {
    const { p } = provider([
      ['GET', /\/status$/, () => ok({ chargeId: 'cha_6', status: raw, amount: 10 })],
      ['GET', /^\/v1\/charges\/cha_6$/, () => ok(detail({ chargeId: 'cha_6', amount: 10, paidAmount: 10 }))],
      ['GET', /\/wallet\/refunds$/, () => ok({ items: [{ status: 'CONFIRMED', amount: 10 }] })],
    ]);
    const snap = await p.getCharge('cha_6');
    assert.equal(snap.status, status, raw);
    assert.equal(snap.disputed === true, raw === 'DISPUTE' || raw === 'CHARGED_BACK', `${raw}: disputa sinalizada`);
  }
  const { p } = provider([['GET', /\/status$/, () => ok({ chargeId: 'cha_6', status: 'ESTRANHO', amount: 10 })]]);
  await assert.rejects(p.getCharge('cha_6'), (error) => error.kind === 'unavailable' && error.code === 'UNKNOWN_STATUS');
});

test('getCharge: resposta de OUTRA cobrança é recusada; código de cobrança estranho nem sai da loja', async () => {
  const { p } = provider([['GET', /\/status$/, () => ok({ chargeId: 'cha_outra', status: 'PAID', amount: 10 })]]);
  await assert.rejects(p.getCharge('cha_7'), (error) => error.kind === 'unavailable' && error.code === 'OTHER_CHARGE');
  const { p: q, f } = provider([]);
  for (const bad of ['../../v1/wallet/balance', 'a b', '', 'x'.repeat(200)]) await assert.rejects(q.getCharge(bad), (error) => error.kind === 'rejected');
  assert.equal(f.calls.length, 0);
});

test('getCharge: o mesmo código do sandbox com ou sem o prefixo "SANDBOX_" é a mesma cobrança', async () => {
  const { p } = provider([['GET', /\/status$/, () => ok({ chargeId: 'SANDBOX_cha_8', status: 'PENDING', amount: 10 })]]);
  assert.equal((await p.getCharge('cha_8')).status, 'pending');
});

test('getCharge: valor pago diferente do cobrado aparece (a loja não libera o pedido); sem o detalhe vale o valor cobrado', async () => {
  const { p } = provider([
    ['GET', /\/status$/, () => ok({ chargeId: 'cha_9', status: 'PAID', amount: 25, paidAt: '2026-10-11T12:00:00Z' })],
    ['GET', /^\/v1\/charges\/cha_9$/, () => ok(detail({ chargeId: 'cha_9', paidAmount: 20 }))],
  ]);
  assert.equal((await p.getCharge('cha_9')).amountCents, 2000);
  const { p: noDetail } = provider([['GET', /\/status$/, () => ok({ chargeId: 'cha_9', status: 'PAID', amount: 25 })], ['GET', /^\/v1\/charges\/cha_9$/, () => ok({}, 500)]]);
  const snap = await noDetail.getCharge('cha_9');
  assert.equal(snap.amountCents, 2500);
  assert.equal(snap.feeCents, null);
});

test('getCharge: sem o cabeçalho da subconta tenta de novo quando a operadora diz que não conhece a cobrança', async () => {
  const { p, f } = provider([['GET', /\/status$/, (c) => (c.headers['x-sub-account'] ? ok({ error: { code: 'CHARGE_NOT_FOUND' } }, 404) : ok({ chargeId: 'cha_10', status: 'PENDING', amount: 5 }))]]);
  const snap = await p.getCharge('cha_10', { merchantAccountId: '4960589' });
  assert.equal(snap.status, 'pending');
  assert.equal(f.api().length, 2);
  assert.equal(f.api()[1].headers['x-sub-account'], undefined);
});

test('getCharge: comissão só vira "repassada" se a master recebeu um crédito ligado a ESTA cobrança', async () => {
  const credits = [];
  const routes = [
    ['GET', /\/status$/, () => ok({ chargeId: 'cha_11', status: 'PAID', amount: 25, paidAt: '2026-10-11T12:00:00Z' })],
    ['GET', /^\/v1\/charges\/cha_11$/, () => ok(detail({ chargeId: 'cha_11' }))],
    ['GET', /\/wallet\/transactions$/, () => ok({ transactions: credits, hasMore: false })],
  ];
  const { p } = provider(routes);
  const ctx = { merchantAccountId: '4960589', commissionCents: 125 };
  assert.deepEqual((await p.getCharge('cha_11', ctx)).split, { state: 'pending', detail: 'repasse ainda não encontrado no extrato da conta master' });
  credits.push({ type: 'CREDIT', amount: 9, chargeId: 'cha_outra' }, { type: 'DEBIT', amount: 1.25, chargeId: 'cha_11' });
  assert.equal((await p.getCharge('cha_11', ctx)).split.state, 'pending', 'crédito de outra cobrança ou débito não conta');
  credits.push({ type: 'CREDIT', amount: 1.25, chargeId: 'cha_11' });
  assert.deepEqual((await p.getCharge('cha_11', ctx)).split, { state: 'applied', commissionCents: 125 });
  assert.equal((await p.getCharge('cha_11', { ...ctx, commissionCents: 0 })).split, null, 'sem comissão não há o que conferir');
  const { p: broken } = provider([...routes.slice(0, 2), ['GET', /\/wallet\/transactions$/, () => ok({}, 500)]]);
  assert.equal((await broken.getCharge('cha_11', ctx)).split.state, 'pending', 'extrato fora do ar: nunca "repassada"');
});

test('getCharge: estorno total, parcial e disputa', async () => {
  const refunds = [{ status: 'CONFIRMED', amount: 10 }, { status: 'PROCESSING', amount: 5 }, { status: 'ERROR', amount: 7 }];
  const make = (status) =>
    provider([
      ['GET', /\/status$/, () => ok({ chargeId: 'cha_12', status, amount: 25 })],
      ['GET', /^\/v1\/charges\/cha_12$/, () => ok(detail({ chargeId: 'cha_12' }))],
      ['GET', /\/wallet\/refunds$/, () => ok({ items: refunds })],
    ]).p;
  const partial = await make('PARTIALLY_REFUNDED').getCharge('cha_12');
  assert.equal(partial.status, 'refunded');
  assert.equal(partial.refundedCents, 1000, 'só conta a devolução CONFIRMADA');
  const total = await make('REFUNDED').getCharge('cha_12');
  assert.equal(total.refundedCents, 1000);
  const dispute = await make('DISPUTE').getCharge('cha_12');
  assert.equal(dispute.status, 'paid');
  assert.equal(dispute.disputed, true);
  assert.match(dispute.detail, /disputa/);
});

// ---- cancelar -----------------------------------------------------------------------------------------------------------------------

test('cancelCharge: cancela, informa "não está em aberto" e "não conhecida", e repassa falhas', async () => {
  const answer = { status: 200, data: { message: 'Cobrança cancelada com sucesso', chargeId: 'cha_13' } };
  const { p, f } = provider([['DELETE', /^\/v1\/charges\/cha_13$/, () => ok(answer.data, answer.status)]]);
  assert.deepEqual(await p.cancelCharge('cha_13', { merchantAccountId: '4960589' }), { cancelled: true });
  assert.equal(f.api()[0].headers['x-sub-account'], '4960589');
  assert.match(f.api()[0].headers.authorization, /tok-charges\/write/);
  answer.status = 400;
  answer.data = { error: { code: 'CHARGE_NOT_CANCELABLE', message: 'Apenas cobranças pendentes...' } };
  assert.deepEqual(await p.cancelCharge('cha_13'), { cancelled: false, reason: 'not_cancelable' });
  answer.status = 404;
  answer.data = { error: { code: 'CHARGE_NOT_FOUND' } };
  assert.deepEqual(await p.cancelCharge('cha_13'), { cancelled: false, reason: 'not_found' });
  answer.status = 503;
  await assert.rejects(p.cancelCharge('cha_13'), (error) => error.kind === 'unavailable');
});

// ---- avisos (webhooks) --------------------------------------------------------------------------------------------------------------

const sign = (body, t = Date.now(), secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const hook = (payload, { id = 'wh-1', signature, t, token } = {}) => {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = new Headers({ 'x-webhook-id': id, 'x-webhook-signature': signature ?? sign(body, t) });
  if (token !== undefined) headers.set('x-access-token', token);
  return { body: new TextEncoder().encode(body), headers };
};

test('verifyWebhook: só aceita assinatura HMAC-SHA256 de "t.corpo" com segredo certo, no prazo', async () => {
  const { p } = provider([]);
  const payload = { event: 'charge.created', chargeId: 'cha_1' };
  const good = hook(payload);
  assert.equal((await p.verifyWebhook(good.body, good.headers)).length, 1);
  const invalid = async (name, args) => await assert.rejects(p.verifyWebhook(args.body, args.headers), (error) => error.kind === 'invalid_webhook', name);
  await invalid('segredo errado', hook(payload, { signature: sign(JSON.stringify(payload), Date.now(), 'outro-segredo') }));
  await invalid('corpo adulterado', { body: new TextEncoder().encode(JSON.stringify({ ...payload, chargeId: 'cha_2' })), headers: good.headers });
  await invalid('espaçamento diferente do corpo bruto', { body: new TextEncoder().encode(JSON.stringify(payload, null, 2)), headers: good.headers });
  await invalid('sem o cabeçalho', { body: good.body, headers: new Headers({ 'x-webhook-id': 'x' }) });
  await invalid('cabeçalho malformado', hook(payload, { signature: 'v1=abc' }));
  await invalid('assinatura de 6 minutos atrás (reaproveitada)', hook(payload, { t: Date.now() - 6 * 60_000 }));
  await invalid('assinatura do futuro', hook(payload, { t: Date.now() + 6 * 60_000 }));
  await invalid('hex curto', hook(payload, { signature: `t=${Date.now()},v1=abcd` }));
  const ok4 = hook(payload, { t: Date.now() - 4 * 60_000 });
  assert.equal((await p.verifyWebhook(ok4.body, ok4.headers)).length, 1, 'até 5 minutos de tolerância');
});

test('verifyWebhook: token estático opcional (x-access-token) é conferido quando configurado', async () => {
  const { p } = provider([], { webhookToken: 'tok-estatico' });
  const payload = { event: 'charge.created', chargeId: 'cha_1' };
  for (const token of [undefined, 'errado', '']) {
    const bad = hook(payload, { token });
    await assert.rejects(p.verifyWebhook(bad.body, bad.headers), (error) => error.kind === 'invalid_webhook', String(token));
  }
  const good = hook(payload, { token: 'tok-estatico' });
  assert.equal((await p.verifyWebhook(good.body, good.headers)).length, 1);
});

test('verifyWebhook: payment.success vira "consulte a cobrança X", com a referência da loja vinda do metadata', async () => {
  const { p } = provider([]);
  const payload = { event: 'payment.success', timestamp: '2026-10-11T12:00:00.000Z', accountId: '4231833', chargeId: 'cha_20', amount: 25, status: 'PAID', paidAt: '2026-10-11T12:00:00.000Z', metadata: { paymentId: 'pay-uuid', orderNumber: 1005 } };
  const { body, headers } = hook(payload, { id: 'wh-abc' });
  const [event] = await p.verifyWebhook(body, headers);
  assert.equal(event.dedupeKey, 'wh-abc', 'X-Webhook-Id é a chave de deduplicação');
  assert.equal(event.type, 'payment.success');
  assert.equal(event.providerChargeId, 'cha_20');
  assert.equal(event.reference, 'pay-uuid');
  assert.equal(event.informational, false);
  assert.equal(event.snapshot.status, 'paid');
  assert.equal(event.snapshot.amountCents, 2500);
});

test('verifyWebhook: eventos que a loja só registra, vencimento, devolução e eventos desconhecidos', async () => {
  const { p } = provider([]);
  const run = async (payload, id = 'wh-x') => {
    const { body, headers } = hook(payload, { id });
    return (await p.verifyWebhook(body, headers))[0];
  };
  assert.equal((await run({ event: 'charge.created', chargeId: 'cha_1' })).informational, true, 'criação da cobrança: a loja já sabe');
  const expired = await run({ event: 'charge.expired', chargeId: 'cha_1', status: 'EXPIRED', amount: 10 });
  assert.equal(expired.informational, false);
  assert.equal(expired.snapshot.status, 'expired');
  const refund = await run({ event: 'refund.confirmed', chargeId: 'cha_1', amount: 10 });
  assert.equal(refund.informational, false, 'devolução: a loja consulta a cobrança');
  assert.equal(refund.snapshot, null);
  assert.equal((await run({ event: 'subscription.created', chargeId: 'cha_1' })).informational, true);
  assert.equal((await run({ event: 'med.balance.blocked', caseId: 'c1' })).informational, true);
  assert.equal((await run({ event: 'payment.success' })).informational, true, 'sem código de cobrança não há o que consultar');
  assert.equal((await run({ event: 'payment.success', chargeId: '../x' })).providerChargeId, null, 'código estranho é descartado');
  // Sem X-Webhook-Id a chave é um resumo do conteúdo: o mesmo corpo dá a mesma chave.
  const bodyText = JSON.stringify({ event: 'charge.created', chargeId: 'cha_9' });
  const withoutId = async () => {
    const headers = new Headers({ 'x-webhook-signature': sign(bodyText) });
    return (await p.verifyWebhook(new TextEncoder().encode(bodyText), headers))[0].dedupeKey;
  };
  assert.equal(await withoutId(), await withoutId());
  assert.match(await withoutId(), /^h:[0-9a-f]{64}$/);
});

test('verifyWebhook: corpo que não é JSON, ou sem nome de evento, é "malformed" (depois de verificada a assinatura)', async () => {
  const { p } = provider([]);
  for (const text of ['isto não é json', '[1,2]', '{"chargeId":"cha_1"}']) {
    const { body, headers } = hook(text);
    await assert.rejects(p.verifyWebhook(body, headers), (error) => error.kind === 'malformed_webhook', text);
  }
});

test('verifyWebhook: avisos de cadastro da conta — só onboarding.create CONFIRMED com número vira "confirmada"', async () => {
  const { p } = provider([]);
  const run = async (event, data, id = `wh-${event}-${data.status}`) => {
    const { body, headers } = hook({ event, timestamp: '2026-10-11T12:00:00Z', accountId: '4231833', data }, { id });
    return (await p.verifyWebhook(body, headers))[0];
  };
  const created = await run('onboarding.create', { formId: 'form-1', proposalId: 'p-1', documentNumber: '12345678000195', status: 'CONFIRMED', account: { number: '483918595', branch: '0001', name: 'Fulano' } });
  assert.deepEqual(created.merchant, { formId: 'form-1', proposalId: 'p-1', state: 'confirmed', step: 'create', accountNumber: '483918595', documentNumber: '12345678000195', detail: null });
  for (const bad of [{ status: 'APPROVED', account: { number: '1' } }, { status: 'CONFIRMED' }, { status: 'CONFIRMED', account: { number: 'a b' } }, { status: 'CONFIRMED', account: { number: '' } }]) {
    const event = await run('onboarding.create', { formId: 'form-1', ...bad }, `wh-${JSON.stringify(bad)}`);
    assert.equal(event.merchant, null, JSON.stringify(bad));
    assert.equal(event.informational, true);
  }
  assert.equal((await run('onboarding.proposal', { formId: 'form-1', status: 'APPROVED' })).merchant.state, 'approved');
  assert.equal((await run('onboarding.proposal', { formId: 'form-1', status: 'APPROVED' })).merchant.accountNumber, null, 'etapa aprovada não traz número de conta');
  assert.equal((await run('onboarding.backgroundcheck', { formId: 'form-1', status: 'PENDING' })).merchant.state, 'pending');
  assert.equal((await run('onboarding.documentscopy', { formId: 'form-1', status: 'REPROVED' })).merchant.state, 'rejected');
  const docs = await run('onboarding.documentscopy', { formId: 'form-1', status: 'PENDING', url: 'https://documentos.exemplo/abc' });
  assert.match(docs.merchant.detail, /documentos/);
  assert.equal(JSON.stringify(docs).includes('documentos.exemplo'), false, 'o endereço de envio dos documentos não é guardado');
});

// ---- contas ------------------------------------------------------------------------------------------------------------------------

test('listAccounts: documento sempre mascarado; só "CONFIRMED" vale como conta aberta', async () => {
  const { p, f } = provider([['GET', /\/v1\/accounts\/subaccounts$/, () => ok({ subAccounts: [{ accountNumber: '4960589', name: 'Loja', documentNumber: '12345678000195', status: 'CONFIRMED' }, { accountNumber: 4949228, name: 'Pessoa', documentNumber: '52998224725', status: 'PENDING' }, { accountNumber: 'a b', status: 'CONFIRMED' }], hasMore: false })]]);
  const accounts = await p.merchant.listAccounts();
  assert.deepEqual(accounts.map((a) => [a.accountNumber, a.confirmed]), [['4960589', true], ['4949228', false]]);
  assert.equal(accounts[0].documentMasked, '••••••••••0195');
  assert.equal(JSON.stringify(accounts).includes('12345678000195'), false);
  assert.match(f.api()[0].headers.authorization, /tok-subaccounts\/read/);
});

test('submitProposal / getProposal: escopo certo, formId exigido, falhas ambíguas separadas das definitivas', async () => {
  const answer = { status: 201, data: { status: 'UNFINISHED', formId: 'a6358673-dd00-4c6d-9592-df393513a78a' } };
  const { p, f } = provider([
    ['POST', /\/v1\/proposals$/, () => ok(answer.data, answer.status)],
    ['GET', /\/v1\/proposals\/a6358673/, () => ok({ proposalStatus: { form: 'FINISHED', proposal: 'PENDING', documents: 'PENDING', urlDocumentscopy: 'https://docs.exemplo/x' } })],
  ]);
  const receipt = await p.merchant.submitProposal('pf', { documentNumber: '1' });
  assert.equal(receipt.formId, 'a6358673-dd00-4c6d-9592-df393513a78a');
  assert.match(f.api()[0].headers.authorization, /tok-proposals\/write/);
  assert.deepEqual(await p.merchant.getProposal(receipt.formId), { formId: receipt.formId, form: 'FINISHED', proposal: 'PENDING', documents: 'PENDING', documentsUrl: 'https://docs.exemplo/x' });
  await assert.rejects(p.merchant.getProposal('../x'), (error) => error.kind === 'rejected');
  answer.data = { status: 'UNFINISHED' };
  await assert.rejects(p.merchant.submitProposal('pj', {}), (error) => error.kind === 'unavailable', 'aceita sem o formId: pode ter sido criada');
  answer.status = 409;
  answer.data = { error: { code: 'INSUFFICIENT_BALANCE_FOR_SUBACCOUNT_FEE', message: 'saldo' } };
  await assert.rejects(p.merchant.submitProposal('pj', {}), (error) => error.kind === 'rejected' && error.code === 'INSUFFICIENT_BALANCE_FOR_SUBACCOUNT_FEE' && error.httpStatus === 409);
  answer.status = 500;
  await assert.rejects(p.merchant.submitProposal('pj', {}), (error) => error.kind === 'unavailable');
});

test('maskDocument: nunca devolve o documento inteiro', () => {
  assert.equal(mod.maskDocument('123.456.789-09'), '•••••••8909');
  assert.equal(mod.maskDocument('12'), '••••');
  assert.equal(mod.maskDocument(''), null);
  assert.equal(mod.maskDocument(null), null);
});

// ---- formulário do cadastro (merchant.ts) --------------------------------------------------------------------------------------------

const pfForm = () => ({
  documentNumber: '529.982.247-25',
  fullName: 'Fulano de Tal da Silva',
  email: 'Titular@Exemplo.com.br',
  phoneNumber: '(34) 99128-3384',
  motherName: 'Maria da Silva',
  socialName: '',
  birthDate: '1990-12-31',
  isPoliticallyExposedPerson: false,
  address: { postalCode: '38400-000', street: 'Rua das Flores', number: '45', addressComplement: '', neighborhood: 'Centro', city: 'Uberlândia', state: 'mg' },
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
    motherName: 'Maria da Silva',
    socialName: 'Fulano',
    birthDate: '31/12/1985',
    isPoliticallyExposedPerson: false,
    address: { postalCode: '38400000', street: 'Rua B', number: '5', addressComplement: '', neighborhood: 'Centro', city: 'Uberlândia', state: 'MG' },
    financialOwnerDetails: { ownerDeclaredIncome: 'ODIB02', ownerDeclaredRevenue: 'ODRB02' },
  },
});

test('CPF e CNPJ: dígitos verificadores conferidos', () => {
  assert.equal(merchantMod.validCpf('52998224725'), true);
  for (const bad of ['52998224726', '11111111111', '123', '', '5299822472a']) assert.equal(merchantMod.validCpf(bad), false, bad);
  assert.equal(merchantMod.validCnpj('11222333000181'), true);
  for (const bad of ['11222333000182', '00000000000000', '123']) assert.equal(merchantMod.validCnpj(bad), false, bad);
});

test('cadastro PF: o formulário vira exatamente o corpo documentado (telefone E.164, data DD-MM-AAAA, só dígitos)', () => {
  const body = merchantMod.buildProposalBody('pf', pfForm());
  assert.deepEqual(body, {
    documentNumber: '52998224725',
    phoneNumber: '+5534991283384',
    email: 'titular@exemplo.com.br',
    motherName: 'Maria da Silva',
    fullName: 'Fulano de Tal da Silva',
    socialName: '',
    birthDate: '31-12-1990',
    address: { postalCode: '38400000', street: 'Rua das Flores', number: '45', addressComplement: '', neighborhood: 'Centro', city: 'Uberlândia', state: 'MG' },
    isPoliticallyExposedPerson: false,
    financialDetails: { declaredIncome: 'DINP02', occupation: 'ONP27', netWorth: 'NWNP02' },
  });
  assert.equal('webhookUrl' in body, false, 'a loja recebe os avisos pelo webhook cadastrado, não por webhookUrl da proposta');
});

test('cadastro PJ: o formulário vira exatamente o corpo documentado, com o sócio e o faturamento', () => {
  const body = merchantMod.buildProposalBody('pj', pjForm());
  assert.equal(body.documentNumber, '11222333000181');
  assert.equal(body.contactNumber, '+5534991283384');
  assert.equal(body.companyType, 'ME');
  assert.equal(body.owner.length, 1);
  assert.deepEqual(body.owner[0].financialOwnerDetails, { ownerDeclaredIncome: 'ODIB02', ownerDeclaredRevenue: 'ODRB02' });
  assert.equal(body.owner[0].ownerType, 'SOCIO');
  assert.equal(body.owner[0].birthDate, '31-12-1985');
  assert.equal(body.businessAddress.addressComplement, 'Loja 2');
});

test('cadastro: formulário inválido lista TODOS os campos com erro e nunca vira corpo', () => {
  const bad = pfForm();
  bad.documentNumber = '111.111.111-11';
  bad.email = 'sem-arroba';
  bad.phoneNumber = '123';
  bad.birthDate = '2015-01-01';
  bad.address.postalCode = '123';
  bad.address.state = 'M1';
  bad.financialDetails.declaredIncome = 'XYZ';
  bad.isPoliticallyExposedPerson = 'não';
  assert.throws(
    () => merchantMod.buildProposalBody('pf', bad),
    (error) => {
      assert.equal(error.status, 400);
      assert.deepEqual(Object.keys(error.extra.fields).sort(), ['address.postalCode', 'address.state', 'birthDate', 'documentNumber', 'email', 'financialDetails.declaredIncome', 'isPoliticallyExposedPerson', 'phoneNumber']);
      return true;
    },
  );
  assert.throws(() => merchantMod.buildProposalBody('pf', null), (error) => error.status === 400);
  assert.throws(() => merchantMod.buildProposalBody('pf', {}), (error) => error.status === 400 && Object.keys(error.extra.fields).length > 5);
  const pj = pjForm();
  pj.documentNumber = '11222333000182';
  pj.companyType = 'SA';
  pj.owner.socialName = '';
  assert.throws(() => merchantMod.buildProposalBody('pj', pj), (error) => ['documentNumber', 'companyType', 'owner.socialName'].every((key) => key in error.extra.fields));
  // Maior de idade: 18 anos exatos hoje passam, amanhã não.
  const today = new Date();
  const adult = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate())).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate() + 1)).toISOString().slice(0, 10);
  assert.doesNotThrow(() => merchantMod.buildProposalBody('pf', { ...pfForm(), birthDate: adult }));
  assert.throws(() => merchantMod.buildProposalBody('pf', { ...pfForm(), birthDate: tomorrow }));
});
