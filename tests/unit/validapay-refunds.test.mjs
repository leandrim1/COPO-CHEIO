import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

// Devolução (estorno) pelo adaptador REAL da ValidaPay, com um `fetch` de mentira que segue o contrato documentado de POST e GET /v1/wallet/refunds
// (consultado pelo servidor MCP da ValidaPay). Nada aqui fala com a ValidaPay: prova a tradução e as regras do adaptador, não o comportamento dela.
const mod = await load('server/payments/validapay.ts');

const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', url, path: url.pathname, headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), body: init.body };
    calls.push(call);
    if (url.pathname === '/auth/token') {
      const form = new URLSearchParams(String(init.body));
      call.form = Object.fromEntries(form);
      return ok({ access_token: `tok-${form.get('scope')}-${calls.length}`, expires_in: 3600, token_type: 'Bearer' });
    }
    for (const [method, pattern, handler] of routes) {
      if (method === call.method && pattern.test(url.pathname)) {
        const reply = handler(call);
        if (!init.signal) return reply;
        return Promise.race([reply, new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('abortado')), { once: true }))]);
      }
    }
    return ok({ error: { code: 'NOT_FOUND', message: 'rota' } }, 404);
  };
  return { fetchImpl, calls, api: (name) => calls.filter((c) => c.path !== '/auth/token' && (!name || c.path.includes(name))) };
}

const provider = (routes, over = {}) => {
  const f = fakeFetch(routes);
  const p = mod.createValidaPayProvider({ environment: 'sandbox', clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'segredo', refundsEnabled: true, apiUrl: 'https://api.teste', authUrl: 'https://api.teste/auth/token', fetch: f.fetchImpl, ...over });
  return { p, f };
};

const CHARGE = 'cha_1774437468463_4hj927ips';
const created = (over = {}) => ({ refundId: 'ref_1774437918293_jm2hen5y7', status: 'PROCESSING', amount: 10.5, reason: 'CUSTOMER_REQUEST', endToEndId: 'E003603052026032511186a4f4cdf139', chargeId: CHARGE, createdAt: '2026-03-25T11:25:18.293Z', ...over });
const apiError = (status, code, message = 'erro') => ok({ error: { message, code, details: null, timestamp: '2026-03-25T11:25:18.293Z' } }, status);
const rejects = (promise, kind, code) => assert.rejects(promise, (error) => error.kind === kind && (code === undefined || error.code === code), `esperava ProviderError ${kind}${code ? ` ${code}` : ''}`);
const PIX = { providerChargeId: CHARGE, method: 'pix', amountCents: 1050, reason: 'CUSTOMER_REQUEST' };

test('Pix: o corpo é { chargeId, amount em reais, reason } (e nada mais), com o escopo wallet/write e o cabeçalho da subconta', async () => {
  const { p, f } = provider([['POST', /^\/v1\/wallet\/refunds$/, () => ok(created(), 201)]]);
  const item = await p.createRefund(PIX, { merchantAccountId: '4960589' });
  const [call] = f.api('/v1/wallet/refunds');
  assert.deepEqual(JSON.parse(call.body), { chargeId: CHARGE, amount: 10.5, reason: 'CUSTOMER_REQUEST' });
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-sub-account'], '4960589');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.match(call.headers.authorization, /^Bearer tok-wallet\/write-/);
  assert.deepEqual({ id: item.providerRefundId, status: item.status, cents: item.amountCents }, { id: 'ref_1774437918293_jm2hen5y7', status: 'processing', cents: 1050 });
  assert.ok(item.createdAt instanceof Date);
});

test('os valores em reais saem exatos, sem erro de ponto flutuante (1999 → 19.99, 5 → 0.05, 12345 → 123.45)', async () => {
  const sent = [];
  const { p } = provider([['POST', /refunds$/, (call) => { const b = JSON.parse(call.body); sent.push(b.amount); return ok(created({ amount: b.amount }), 201); }]]);
  for (const cents of [1999, 5, 1, 100, 12345, 29]) await p.createRefund({ ...PIX, amountCents: cents }, undefined);
  assert.deepEqual(sent, [19.99, 0.05, 0.01, 1, 123.45, 0.29]);
});

test('cartão: o corpo leva a subconta em accountId (não no cabeçalho) e a devolução pode voltar CONFIRMED na hora', async () => {
  const { p, f } = provider([['POST', /refunds$/, () => ok({ refundId: 'ref_1774531490865_bq4e8v12x', status: 'CONFIRMED', success: true, amount: 100, reason: 'CUSTOMER_REQUEST', chargeId: CHARGE, providerChargeId: 'prov_ch_9f8a7b6c', paymentType: 'CREDIT_CARD', createdAt: '2026-03-26T13:24:52.106Z' }, 201)]]);
  const item = await p.createRefund({ providerChargeId: CHARGE, method: 'card', amountCents: 10000, reason: 'CUSTOMER_REQUEST' }, { merchantAccountId: '459013777' });
  const [call] = f.api('/v1/wallet/refunds');
  assert.deepEqual(JSON.parse(call.body), { chargeId: CHARGE, amount: 100, reason: 'CUSTOMER_REQUEST', accountId: '459013777' });
  assert.equal(call.headers['x-sub-account'], undefined);
  assert.equal(item.status, 'confirmed');
});

test('Pix: se a ValidaPay não conhece a cobrança COM o cabeçalho da subconta, tenta sem ele (o contrato não confirma qual vale)', async () => {
  const { p, f } = provider([['POST', /refunds$/, (call) => (call.headers['x-sub-account'] ? apiError(404, 'CHARGE_NOT_FOUND') : ok(created(), 201))]]);
  const item = await p.createRefund(PIX, { merchantAccountId: '4960589' });
  const posts = f.api('/v1/wallet/refunds');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['x-sub-account'], '4960589');
  assert.equal(posts[1].headers['x-sub-account'], undefined);
  assert.equal(item.status, 'processing');
});

test('recusas da ValidaPay são "rejected" (nada foi devolvido): valor acima do disponível, sem endToEndId, cobrança desconhecida, sem permissão', async () => {
  for (const [status, code] of [[400, 'REFUND_AMOUNT_EXCEEDED'], [400, 'CHARGE_WITHOUT_END_TO_END_ID'], [403, 'FORBIDDEN'], [401, 'UNAUTHORIZED'], [422, 'ANY']]) {
    const { p } = provider([['POST', /refunds$/, () => apiError(status, code)]]);
    await rejects(p.createRefund(PIX, undefined), 'rejected', code);
  }
  const { p } = provider([['POST', /refunds$/, () => apiError(404, 'CHARGE_NOT_FOUND')]]);
  await assert.rejects(p.createRefund(PIX, undefined), (error) => error.kind === 'rejected' && error.httpStatus === 404);
});

test('sem resposta, erro 5xx, 429 e resposta ilegível são "unavailable" (AMBÍGUO: a devolução pode ter sido criada)', async () => {
  for (const make of [() => apiError(500, 'INTERNAL'), () => apiError(503, 'UNAVAILABLE'), () => apiError(429, 'RATE'), () => new Response('<html>', { status: 201 })]) {
    const { p } = provider([['POST', /refunds$/, make]]);
    await rejects(p.createRefund(PIX, undefined), 'unavailable');
  }
  const { p } = provider([['POST', /refunds$/, () => new Promise(() => undefined)]], { requestTimeoutMs: 40 });
  const keepAlive = setTimeout(() => {}, 5000); // o prazo (AbortSignal.timeout) não segura o processo de teste; uma conexão de verdade seguraria
  await rejects(p.createRefund(PIX, undefined), 'unavailable', 'NO_RESPONSE');
  clearTimeout(keepAlive);
});

test('2xx com resposta que não bate com o pedido (outro valor, outra cobrança, sem refundId) é "unavailable": a loja confere antes de repetir', async () => {
  for (const reply of [created({ amount: 11.5 }), created({ chargeId: 'cha_outra_cobranca_999' }), created({ refundId: undefined }), created({ amount: 0 }), {}]) {
    const { p } = provider([['POST', /refunds$/, () => ok(reply, 201)]]);
    await rejects(p.createRefund(PIX, undefined), 'unavailable', 'BAD_RESPONSE');
  }
});

test('pedido inválido nunca sai: motivo fora da lista, valor zero ou fracionário, código de cobrança estranho', async () => {
  const { p, f } = provider([['POST', /refunds$/, () => ok(created(), 201)]]);
  await rejects(p.createRefund({ ...PIX, reason: 'QUERO_DE_VOLTA' }, undefined), 'rejected', 'REASON');
  await rejects(p.createRefund({ ...PIX, amountCents: 0 }, undefined), 'rejected', 'AMOUNT');
  await rejects(p.createRefund({ ...PIX, amountCents: 10.5 }, undefined), 'rejected', 'AMOUNT');
  await rejects(p.createRefund({ ...PIX, amountCents: -100 }, undefined), 'rejected', 'AMOUNT');
  await rejects(p.createRefund({ ...PIX, providerChargeId: 'cha 1; drop' }, undefined), 'rejected', 'CHARGE_ID');
  assert.equal(f.calls.length, 0, 'nenhuma chamada (nem a do token) saiu');
});

test('listRefunds: lê { items } da cobrança com o escopo wallet/read e a subconta em accountId; só CONFIRMED (ou success) é devolvido', async () => {
  const { p, f } = provider([
    ['GET', /refunds$/, () =>
      ok({ items: [
        { refundId: 'ref_aaaaaaaaaaaa', status: 'CONFIRMED', success: true, amount: 5, chargeId: CHARGE, createdAt: '2026-03-25T11:00:00.000Z', error: null },
        { refundId: 'ref_bbbbbbbbbbbb', status: 'PROCESSING', success: false, amount: 3.25, chargeId: CHARGE, createdAt: '2026-03-25T12:00:00.000Z' },
        { refundId: 'ref_cccccccccccc', status: 'ERROR', amount: 2, chargeId: CHARGE, error: 'Saldo insuficiente' },
        { refundId: 'ref_dddddddddddd', status: 'ALGO_NOVO', amount: 1, chargeId: CHARGE },
        { refundId: 'ref_eeeeeeeeeeee', status: 'CONFIRMED', amount: 9, chargeId: 'cha_de_outra_cobranca' },
        { refundId: 'ref_ffffffffffff', status: 'CONFIRMED', amount: 'abc', chargeId: CHARGE },
        { status: 'CONFIRMED', amount: 1, chargeId: CHARGE },
        null,
      ] })],
  ]);
  const items = await p.listRefunds(CHARGE, { merchantAccountId: '4960589' });
  const [call] = f.api('/v1/wallet/refunds');
  assert.equal(call.method, 'GET');
  assert.equal(call.url.searchParams.get('chargeId'), CHARGE);
  assert.equal(call.url.searchParams.get('accountId'), '4960589');
  assert.match(call.headers.authorization, /^Bearer tok-wallet\/read-/);
  assert.deepEqual(items.map((i) => [i.providerRefundId, i.status, i.amountCents]), [
    ['ref_aaaaaaaaaaaa', 'confirmed', 500],
    ['ref_bbbbbbbbbbbb', 'processing', 325],
    ['ref_cccccccccccc', 'failed', 200],
    ['ref_dddddddddddd', 'processing', 100],
  ]);
  assert.equal(items[2].error, 'Saldo insuficiente');
  assert.equal(items[1].error, null);
});

test('listRefunds: status desconhecido NUNCA vira "devolvido"; consulta que falha lança erro (a loja não presume nada)', async () => {
  const { p } = provider([['GET', /refunds$/, () => ok({ items: [{ refundId: 'ref_gggggggggggg', status: 'ESTORNADO', amount: 7, chargeId: CHARGE }] })]]);
  assert.equal((await p.listRefunds(CHARGE, undefined))[0].status, 'processing');
  const down = provider([['GET', /refunds$/, () => apiError(503, 'UNAVAILABLE')]]);
  await rejects(down.p.listRefunds(CHARGE, undefined), 'unavailable');
  const shape = provider([['GET', /refunds$/, () => ok({ refunds: [] })]]);
  await assert.rejects(shape.p.listRefunds(CHARGE, undefined));
  const empty = provider([['GET', /refunds$/, () => ok({ items: [] })]]);
  assert.deepEqual(await empty.p.listRefunds(CHARGE, undefined), []);
  await rejects(provider([]).p.listRefunds('cha 1; drop', undefined), 'rejected', 'CHARGE_ID');
});

test('as credenciais e o token nunca aparecem em mensagens de erro da devolução', async () => {
  const { p } = provider([['POST', /refunds$/, () => apiError(400, 'REFUND_AMOUNT_EXCEEDED', 'Valor excede o disponível')]]);
  try {
    await p.createRefund(PIX, undefined);
    assert.fail('deveria recusar');
  } catch (error) {
    assert.doesNotMatch(String(error.message), /csecret|tok-wallet|Bearer/);
    assert.match(error.message, /REFUND_AMOUNT_EXCEEDED/);
  }
});
