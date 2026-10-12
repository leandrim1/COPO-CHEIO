// Servidor ValidaPay FALSO: SÓ PARA OS TESTES AUTOMATIZADOS. NÃO é a ValidaPay.
//
// Segue o que a documentação oficial da ValidaPay (consultada pelo servidor MCP dela em 11/10/2026) diz de cada rota que a loja usa:
// POST /auth/token (client_credentials, x-www-form-urlencoded), POST /v1/charges/pix (valores em REAIS, split, metadata, cabeçalho
// X-Sub-Account), GET /v1/charges/{id}/status, GET /v1/charges/{id}, DELETE /v1/charges/{id}, GET /v1/wallet/refunds, GET /v1/wallet/transactions,
// GET /v1/accounts/subaccounts, POST /v1/proposals e GET /v1/proposals/{formId}. Quando a loja foge do documentado, este servidor RECUSA, para o
// teste pegar o desvio. O que a documentação não diz tem um modo de teste para os dois comportamentos possíveis (marcado abaixo).
// Isto prova a lógica do adaptador e da loja contra o CONTRATO DOCUMENTADO; não prova que a ValidaPay de verdade se comporta assim:
// isso só se prova no sandbox da ValidaPay.
import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';

export const FAKE = {
  clientId: 'client-id-de-teste',
  clientSecret: 'client-secret-de-teste',
  webhookSecret: 'segredo-do-webhook-de-teste',
  webhookToken: 'token-estatico-de-teste',
};

const SCOPES = new Set(['charges/read', 'charges/write', 'wallet/read', 'wallet/write', 'subaccounts/read', 'proposals/write']);
const reais = (n) => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startFakeValidaPay() {
  const state = {
    // Parâmetros de comportamento (mudam por teste).
    mode: {
      createFail: null, // null | 'down' (500) | 'hang' | 'invalid' (400) | 'forbidden' (403)
      authFail: false,
      statusFail: false, // consulta de cobrança responde 503
      cancelFail: false, // cancelamento responde 503
      // NÃO CONFIRMADO na documentação: a consulta da cobrança da subconta exige o cabeçalho X-Sub-Account? 'required' | 'forbidden' | 'any'
      subHeaderOnRead: 'any',
      proposal: null, // null | 'balance' (409 INSUFFICIENT_BALANCE_FOR_SUBACCOUNT_FEE) | 'conflict' (409) | 'hang' | 'invalid' (400)
      listFail: false,
      paidBetweenLookupAndCancel: null, // chargeId que vira PAID no instante do DELETE (corrida de pagamento × cancelamento)
    },
    charges: new Map(),
    subaccounts: [
      { accountNumber: '4960589', name: 'Estabelecimento Teste Ltda', documentNumber: '12345678000195', status: 'CONFIRMED', balance: 0 },
      { accountNumber: '4949228', name: 'Outra Pessoa', documentNumber: '52998224725', status: 'PENDING', balance: 0 },
    ],
    masterCredits: [],
    refunds: [],
    proposals: new Map(),
    tokens: new Map(),
    calls: [],
    seq: 0,
  };

  const log = (req, extra = {}) =>
    state.calls.push({
      method: req.method,
      path: req.path,
      query: Object.fromEntries(req.url.searchParams),
      subAccount: req.headers['x-sub-account'] ?? null,
      contentType: req.headers['content-type'] ?? null,
      hasAuth: /^Bearer /.test(req.headers.authorization ?? ''),
      scope: req.scope ?? null,
      body: req.body ?? null,
      ...extra,
    });

  const send = (res, status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(data === undefined ? '' : JSON.stringify(data));
  const fail = (res, status, code, message) => send(res, status, { error: { message, code, details: null, timestamp: new Date().toISOString() } });

  function chargeStatus(charge) {
    return charge.status;
  }

  const server = http.createServer(async (rawReq, res) => {
    const url = new URL(rawReq.url, 'http://fake');
    const chunks = [];
    for await (const chunk of rawReq) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const req = { method: rawReq.method, url, path: url.pathname, headers: rawReq.headers, raw, body: null, scope: null };

    // ---- controles dos testes ----
    if (req.path.startsWith('/__fake/')) {
      const body = raw ? JSON.parse(raw) : {};
      if (req.path === '/__fake/state') {
        return send(res, 200, {
          mode: state.mode,
          calls: state.calls,
          charges: [...state.charges.values()],
          proposals: [...state.proposals.values()],
          subaccounts: state.subaccounts,
          masterCredits: state.masterCredits,
        });
      }
      if (req.path === '/__fake/mode') return send(res, 200, Object.assign(state.mode, body));
      if (req.path === '/__fake/calls/clear') {
        state.calls.length = 0;
        return send(res, 200, {});
      }
      if (req.path === '/__fake/reset') {
        Object.assign(state.mode, { createFail: null, authFail: false, statusFail: false, cancelFail: false, subHeaderOnRead: 'any', proposal: null, listFail: false, paidBetweenLookupAndCancel: null });
        state.charges.clear();
        state.proposals.clear();
        state.masterCredits.length = 0;
        state.refunds.length = 0;
        state.calls.length = 0;
        state.subaccounts = state.subaccounts.slice(0, 2);
        return send(res, 200, {});
      }
      if (req.path === '/__fake/pay') {
        const charge = state.charges.get(body.chargeId);
        if (!charge) return send(res, 404, { error: 'sem cobrança' });
        if (charge.status !== 'PENDING') return send(res, 409, { error: `cobrança está ${charge.status}` });
        charge.status = 'PAID';
        charge.paidAt = new Date().toISOString();
        charge.paidAmount = body.paidAmount ?? charge.amount;
        charge.fee = body.fee ?? 0.99;
        charge.endToEndId = `E${String(Date.now()).padEnd(31, '0')}`.slice(0, 32);
        return send(res, 200, charge);
      }
      // Cria direto no servidor falso uma cobrança que a loja NÃO conhece (como a que a ValidaPay criou mas cuja resposta se perdeu).
      if (req.path === '/__fake/charge') {
        const id = `cha_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
        const charge = {
          id,
          amount: body.amount,
          split: body.split ?? null,
          sub: body.sub ?? null,
          metadata: body.metadata ?? null,
          externalTxid: null,
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
          emv: `00020101021226910014br.gov.bcb.pix2563fake.example/v2/${id}`,
          paidAt: null,
          paidAmount: null,
          fee: null,
          endToEndId: null,
        };
        state.charges.set(id, charge);
        return send(res, 200, charge);
      }
      if (req.path === '/__fake/set-status') {
        const charge = state.charges.get(body.chargeId);
        if (!charge) return send(res, 404, {});
        charge.status = body.status;
        return send(res, 200, charge);
      }
      if (req.path === '/__fake/credit') {
        state.masterCredits.push({ transactionId: `txn_${++state.seq}`, type: 'CREDIT', category: body.category ?? 'PAYMENT', amount: body.amount, chargeId: body.chargeId ?? null, createdAt: new Date().toISOString() });
        return send(res, 200, {});
      }
      if (req.path === '/__fake/subaccount') {
        state.subaccounts.push(body);
        return send(res, 200, {});
      }
      return send(res, 404, {});
    }

    try {
      if (raw && /json/.test(req.headers['content-type'] ?? '')) req.body = JSON.parse(raw);
    } catch {
      return fail(res, 400, 'INVALID_JSON', 'corpo não é JSON');
    }

    // ---- POST /auth/token ----
    if (req.method === 'POST' && req.path === '/auth/token') {
      const params = new URLSearchParams(raw);
      req.body = { grant_type: params.get('grant_type'), client_id: params.get('client_id'), scope: params.get('scope'), has_secret: Boolean(params.get('client_secret')) };
      log(req);
      if (state.mode.authFail) return send(res, 503, { error: 'unavailable' });
      if (!/x-www-form-urlencoded/.test(req.headers['content-type'] ?? '')) return send(res, 400, { error: 'invalid_request' });
      if (params.get('grant_type') !== 'client_credentials' || params.get('client_id') !== FAKE.clientId || params.get('client_secret') !== FAKE.clientSecret) return send(res, 401, { error: 'invalid_client' });
      const scope = params.get('scope') ?? '';
      if (!SCOPES.has(scope)) return send(res, 400, { error: 'invalid_scope' });
      const token = `tok.${scope}.${++state.seq}`;
      state.tokens.set(token, scope);
      return send(res, 200, { access_token: token, expires_in: 3600, token_type: 'Bearer' });
    }

    // ---- as demais rotas exigem token do escopo certo ----
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    req.scope = auth ? (state.tokens.get(auth) ?? null) : null;
    const need = (scope) => {
      if (!req.scope) {
        fail(res, 401, 'UNAUTHORIZED', 'token ausente ou inválido');
        return false;
      }
      if (req.scope !== scope) {
        fail(res, 403, 'FORBIDDEN', `o token não tem o escopo ${scope}`);
        return false;
      }
      return true;
    };
    log(req);
    const sub = req.headers['x-sub-account'] ?? null;

    // POST /v1/charges/pix
    if (req.method === 'POST' && req.path === '/v1/charges/pix') {
      if (!need('charges/write')) return;
      if (state.mode.createFail === 'hang') return; // nunca responde: o adaptador estoura o prazo
      if (state.mode.createFail === 'down') return fail(res, 500, 'INTERNAL', 'erro interno');
      if (state.mode.createFail === 'forbidden') return fail(res, 403, 'FORBIDDEN', 'sem permissão');
      if (state.mode.createFail === 'invalid') return fail(res, 400, 'INVALID_DATA', 'campo inválido');
      const body = req.body ?? {};
      if (typeof body.amount !== 'number' || body.amount < 0.01 || !reais(body.amount)) return fail(res, 400, 'INVALID_DATA', 'amount deve ser um valor em reais com duas casas');
      if (body.paymentMethod !== undefined && body.paymentMethod !== 'pix') return fail(res, 400, 'INVALID_DATA', 'paymentMethod');
      if (body.split !== undefined) {
        if (!Array.isArray(body.split)) return fail(res, 400, 'INVALID_DATA', 'split deve ser uma lista');
        for (const part of body.split) {
          if (!['fixed', 'percentage'].includes(part?.type) || typeof part.amount !== 'number' || part.amount < 0.01) return fail(res, 400, 'INVALID_DATA', 'split inválido');
          // Documentação ("Split para Conta Master"): sem accountNumber o valor vai para a conta master.
          if (sub && part.accountNumber !== undefined) return fail(res, 400, 'INVALID_DATA', 'split para a master não leva accountNumber');
        }
      }
      if (sub && !state.subaccounts.some((a) => a.accountNumber === sub && a.status === 'CONFIRMED')) return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'subconta desconhecida');
      const id = `cha_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      const charge = {
        id,
        amount: body.amount,
        split: body.split ?? null,
        sub,
        metadata: body.metadata ?? null,
        externalTxid: body.externalTxid ?? null,
        status: 'PENDING',
        createdAt: new Date().toISOString(),
        // A documentação não diz a validade do QR Code de uma cobrança imediata: fim do dia seguinte, como nos exemplos de resposta.
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        emv: `00020101021226910014br.gov.bcb.pix2563fake.example/v2/${id}`,
        paidAt: null,
        paidAmount: null,
        fee: null,
        endToEndId: null,
      };
      state.charges.set(id, charge);
      return send(res, 200, { chargeId: id, emv: charge.emv, qrCode: 'data:image/png;base64,iVBORw0KGgo=', metadata: charge.metadata });
    }

    // GET /v1/charges/{id}/status e GET /v1/charges/{id}
    const readMatch = /^\/v1\/charges\/([^/]+?)(\/status)?$/.exec(req.path);
    if (req.method === 'GET' && readMatch) {
      if (!need('charges/read')) return;
      if (state.mode.statusFail) return fail(res, 503, 'UNAVAILABLE', 'fora do ar');
      const charge = state.charges.get(decodeURIComponent(readMatch[1]));
      const hide =
        (state.mode.subHeaderOnRead === 'required' && charge?.sub && sub !== charge.sub) || (state.mode.subHeaderOnRead === 'forbidden' && sub);
      if (!charge || hide) return fail(res, 404, 'CHARGE_NOT_FOUND', 'Cobrança não encontrada');
      if (readMatch[2]) {
        return send(res, 200, {
          chargeId: charge.id,
          status: chargeStatus(charge),
          amount: charge.amount,
          paymentType: 'PIX',
          emv: charge.emv,
          qrCode: 'data:image/png;base64,iVBORw0KGgo=',
          paidAt: charge.paidAt,
          createdAt: charge.createdAt,
          expiresAt: charge.expiresAt,
        });
      }
      return send(res, 200, {
        chargeId: charge.id,
        status: chargeStatus(charge),
        amount: charge.amount,
        currency: 'BRL',
        paymentType: 'PIX',
        saleType: 'ONE_TIME',
        paidAt: charge.paidAt,
        expiresAt: charge.expiresAt,
        endToEndId: charge.endToEndId,
        externalTxid: charge.externalTxid,
        grossAmount: charge.amount,
        netAmount: charge.fee === null ? null : Number((charge.amount - charge.fee).toFixed(2)),
        paidAmount: charge.paidAmount,
        fee: charge.fee === null ? null : { amount: charge.fee, percentageRate: 0, percentage: 0, fixed: charge.fee },
        payer: charge.paidAt ? { name: 'Pagador Teste', document: '12345678909' } : null,
        pix: { emv: charge.emv, qrCode: 'data:image/png;base64,iVBORw0KGgo=', dueDate: null, discount: null },
      });
    }

    // DELETE /v1/charges/{id}
    const delMatch = /^\/v1\/charges\/([^/]+)$/.exec(req.path);
    if (req.method === 'DELETE' && delMatch) {
      if (!need('charges/write')) return;
      if (state.mode.cancelFail) return fail(res, 503, 'UNAVAILABLE', 'fora do ar');
      const charge = state.charges.get(decodeURIComponent(delMatch[1]));
      if (!charge) return fail(res, 404, 'CHARGE_NOT_FOUND', 'Cobrança não encontrada');
      if (state.mode.paidBetweenLookupAndCancel === charge.id) {
        charge.status = 'PAID';
        charge.paidAt = new Date().toISOString();
        charge.paidAmount = charge.amount;
        charge.fee = 0.99;
        state.mode.paidBetweenLookupAndCancel = null;
      }
      if (!['PENDING', 'AWAITING_PAYMENT'].includes(charge.status)) return fail(res, 400, 'CHARGE_NOT_CANCELABLE', 'Apenas cobranças pendentes ou aguardando pagamento podem ser canceladas');
      charge.status = 'CANCELED';
      return send(res, 200, { message: 'Cobrança cancelada com sucesso', chargeId: charge.id, invoiceId: null, cycleNumber: null, notas: { canceled: 0, flagged: 0, failed: 0, untouched: 0 } });
    }

    // GET /v1/wallet/refunds
    if (req.method === 'GET' && req.path === '/v1/wallet/refunds') {
      if (!need('wallet/read')) return;
      const chargeId = url.searchParams.get('chargeId');
      return send(res, 200, { items: state.refunds.filter((item) => item.chargeId === chargeId) });
    }

    // GET /v1/wallet/transactions (extrato da conta master quando não há accountId)
    if (req.method === 'GET' && req.path === '/v1/wallet/transactions') {
      if (!need('wallet/read')) return;
      return send(res, 200, { accountId: 'master', transactions: state.masterCredits, nextPageToken: null, hasMore: false });
    }

    // GET /v1/accounts/subaccounts
    if (req.method === 'GET' && req.path === '/v1/accounts/subaccounts') {
      if (!need('subaccounts/read')) return;
      if (state.mode.listFail) return fail(res, 503, 'UNAVAILABLE', 'fora do ar');
      return send(res, 200, { masterAccountId: 'SANDBOX_master', subAccounts: state.subaccounts, page: 1, perPage: 100, hasMore: false, nextPageToken: null });
    }

    // POST /v1/proposals
    if (req.method === 'POST' && req.path === '/v1/proposals') {
      if (!need('proposals/write')) return;
      if (state.mode.proposal === 'hang') return;
      if (state.mode.proposal === 'balance') return fail(res, 409, 'INSUFFICIENT_BALANCE_FOR_SUBACCOUNT_FEE', 'Saldo insuficiente para a tarifa da subconta');
      if (state.mode.proposal === 'conflict') return fail(res, 409, 'PROPOSAL_CONFLICT', 'Já existe uma proposta para este documento');
      if (state.mode.proposal === 'invalid') return fail(res, 400, 'INVALID_DATA', 'campo inválido');
      const body = req.body ?? {};
      const pf = typeof body.fullName === 'string';
      const required = pf
        ? ['documentNumber', 'phoneNumber', 'email', 'motherName', 'fullName', 'birthDate', 'address', 'isPoliticallyExposedPerson', 'financialDetails']
        : ['contactNumber', 'documentNumber', 'businessEmail', 'businessName', 'tradingName', 'companyType', 'owner', 'businessAddress'];
      const missing = required.filter((key) => body[key] === undefined);
      if (missing.length) return fail(res, 400, 'INVALID_DATA', `faltam campos: ${missing.join(', ')}`);
      if (!/^\+55\d{10,11}$/.test(body.phoneNumber ?? body.contactNumber)) return fail(res, 400, 'INVALID_DATA', 'telefone fora do formato E.164');
      if (!/^\d{2}-\d{2}-\d{4}$/.test(body.birthDate ?? body.owner?.[0]?.birthDate ?? '')) return fail(res, 400, 'INVALID_DATA', 'birthDate deve ser DD-MM-AAAA');
      if ('webhookUrl' in body) return fail(res, 400, 'INVALID_DATA', 'a loja não envia webhookUrl');
      const formId = randomUUID();
      state.proposals.set(formId, { formId, type: pf ? 'PF' : 'PJ', body });
      return send(res, 201, { status: 'UNFINISHED', message: 'Formulário criado com sucesso', formId });
    }

    const propMatch = /^\/v1\/proposals\/([^/]+)$/.exec(req.path);
    if (req.method === 'GET' && propMatch) {
      if (!need('proposals/write')) return;
      const proposal = state.proposals.get(propMatch[1]);
      if (!proposal) return fail(res, 404, 'NOT_FOUND', 'Formulário não encontrado');
      return send(res, 200, { type: proposal.type, proposalStatus: { form: 'FINISHED', sendStatus: 'SENT', proposal: 'PENDING', documents: 'PENDING', urlDocumentscopy: 'https://documentos.exemplo.invalid/envio/abc123' } });
    }

    return fail(res, 404, 'NOT_FOUND', `rota desconhecida: ${req.method} ${req.path}`);
  });

  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}`;
      const control = (path, body) => fetch(`${url}/__fake/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
      resolve({
        url,
        state,
        control,
        stop: () => new Promise((done) => server.close(done)),
      });
    }),
  );
}

// ---- Avisos (webhooks) como a ValidaPay os envia -------------------------------------------------------------------------------------
// X-Webhook-Signature: t=<ms>,v1=<hex>; v1 = HMAC-SHA256(segredo, `${t}.${corpo bruto}`).
export const signWebhook = (body, { secret = FAKE.webhookSecret, t = Date.now() } = {}) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

export async function postWebhook(appUrl, payload, { id = randomUUID(), secret, t, token, signature, rawBody, attempt = 1 } = {}) {
  const body = rawBody ?? JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'x-webhook-id': id,
    'x-webhook-event': payload?.event ?? 'x',
    'x-webhook-attempt': String(attempt),
    'x-webhook-signature': signature ?? signWebhook(body, { secret, t }),
  };
  if (token !== undefined) headers['x-access-token'] = token;
  const res = await fetch(`${appUrl}/api/payments/webhook`, { method: 'POST', headers, body });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// Payload de payment.success de uma cobrança avulsa por Pix (POST /v1/charges/pix), como no catálogo da documentação.
export const paymentSuccess = (charge, extra = {}) => ({
  event: 'payment.success',
  timestamp: new Date().toISOString(),
  accountNumber: '4231833',
  accountId: '4231833',
  chargeId: charge.id,
  invoiceId: null,
  type: 'ONE_TIME_ITEM',
  amount: charge.amount,
  currency: 'BRL',
  transactionId: '4000782515',
  metadata: charge.metadata,
  status: 'PAID',
  paymentType: 'PIX',
  paymentMethod: 'PIX',
  paymentId: 'E13935893202609051200s0290d93572',
  paidAt: new Date().toISOString(),
  payer: { name: 'Pagador Teste', taxId: '12345678909' },
  ...extra,
});

export const sleep = wait;
