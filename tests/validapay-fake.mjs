// Servidor ValidaPay FALSO: SÓ PARA OS TESTES AUTOMATIZADOS. NÃO é a ValidaPay.
//
// Segue o que a documentação oficial da ValidaPay (consultada pelo servidor MCP dela em 11/10/2026) diz de cada rota que a loja usa:
// POST /auth/token (client_credentials, x-www-form-urlencoded), POST /v1/charges/pix (valores em REAIS, split, metadata, cabeçalho
// X-Sub-Account), GET /v1/charges/{id}/status, GET /v1/charges/{id}, DELETE /v1/charges/{id}, GET /v1/wallet/refunds, GET /v1/wallet/transactions,
// GET /v1/accounts/subaccounts, POST /v1/proposals e GET /v1/proposals/{formId}. CARTÃO: POST /v1/charges com paymentMethod "creditcard"
// (cardToken de uso único e 5 minutos, deviceId em UUID, externalId como idempotência → 409 DUPLICATE_CHARGE com o chargeId original em
// error.details.chargeId, 200 "paid" ou 402 recusado, cartões de teste do sandbox) e as duas rotas que o SDK do navegador chama
// (POST /v1/payment-sessions e POST /v1/payment-sessions/payment-methods). Quando a loja foge do documentado, este servidor RECUSA, para o
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
  publicId: 'pub_teste_0001',
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
      // ---- Devolução (POST/GET /v1/wallet/refunds) ----
      refundFail: null, // null | 'down' (500) | 'hang' (nunca responde) | 'lose' (cria a devolução e derruba a conexão) | 'forbidden' (403: sem o escopo) | 'badresponse' (201 com outro valor)
      refundList: 'ok', // 'ok' | 'down' (503 na consulta das devoluções)
      refundCardInstant: true, // cartão: a devolução volta CONFIRMED na hora (documentação); false: volta PROCESSING
      // NÃO CONFIRMADO na documentação: o POST de devolução do Pix exige o cabeçalho X-Sub-Account? 'any' | 'required' | 'forbidden'
      refundSub: 'any',
      paidBetweenLookupAndCancel: null, // chargeId que vira PAID no instante do DELETE (corrida de pagamento × cancelamento)
      // ---- Cartão ----
      card: null, // null | 'processing' (200 sem "paid") | 'lose' (cobra e derruba a conexão) | 'hang' (cobra e nunca responde) | 'down' (500 sem cobrar) | 'down_after' (cobra e responde 500) | 'forbidden' (403)
      cardFeePct: 5.37, // taxa que a ValidaPay "cobra" da loja no cartão (percentual e tarifa fixa em reais): vem no detalhe da cobrança
      cardFeeFixed: 0.37,
      cardFeeReport: 'rates', // 'rates' | 'none' (o detalhe da cobrança não informa a tarifa)
      cardPaidDelta: 0, // reais somados ao valor "pago" informado (simula divergência entre o valor cobrado e o recebido)
      phoneRequired: false, // 400 CUSTOMER_PHONE_REQUIRED quando falta o telefone
      // NÃO CONFIRMADO na documentação: POST /v1/charges aceita o cabeçalho X-Sub-Account? 'any' | 'forbidden'
      cardSub: 'any',
    },
    cardTokens: new Map(),
    externalIds: new Map(),
    cardChargeCount: 0,
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

  // Tarifa que a ValidaPay cobra da loja neste cartão: percentual sobre o valor + tarifa fixa, arredondada ao centavo (em reais).
  const cardFeeOf = (amount) => Math.round(amount * 100 * (state.mode.cardFeePct / 100) + state.mode.cardFeeFixed * 100) / 100;

  // Cartões de teste do sandbox (documentação "Gerar cobrança Cartão"): o número digitado na tokenização define o resultado.
  const CARD_OUTCOMES = {
    '4111111111111111': null,
    '4000000000000002': 'card_declined',
    '4000000000000004': 'insufficient_funds',
    '4000000000000006': 'expired_card',
    '4000000000000008': 'invalid_cvv',
    '4000000000000010': 'fraud_suspected',
  };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function mintCardToken(number) {
    const digits = String(number ?? '').replace(/\D/g, '');
    const token = `ctk_${randomUUID().replace(/-/g, '')}`;
    state.cardTokens.set(token, {
      outcome: Object.hasOwn(CARD_OUTCOMES, digits) ? CARD_OUTCOMES[digits] : null,
      last4: digits.slice(-4),
      brand: digits.startsWith('4') ? 'VISA' : 'MASTERCARD',
      createdAt: Date.now(),
      used: false,
      expired: false,
    });
    return token;
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
          cardChargeCount: state.cardChargeCount,
          cardTokens: [...state.cardTokens.entries()].map(([token, t]) => ({ token, ...t })),
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
        Object.assign(state.mode, {
          createFail: null, authFail: false, statusFail: false, cancelFail: false, subHeaderOnRead: 'any', proposal: null, listFail: false, paidBetweenLookupAndCancel: null, refundFail: null, refundList: 'ok', refundCardInstant: true, refundSub: 'any',
          card: null, cardFeePct: 5.37, cardFeeFixed: 0.37, cardFeeReport: 'rates', cardPaidDelta: 0, phoneRequired: false, cardSub: 'any',
        });
        state.cardTokens.clear();
        state.externalIds.clear();
        state.cardChargeCount = 0;
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
        if (!['PENDING', 'PROCESSING'].includes(charge.status)) return send(res, 409, { error: `cobrança está ${charge.status}` });
        charge.status = 'PAID';
        charge.paidAt = new Date().toISOString();
        charge.paidAmount = body.paidAmount ?? charge.amount;
        charge.fee = body.fee ?? (charge.card ? cardFeeOf(charge.amount) : 0.99);
        charge.endToEndId = charge.card ? null : `E${String(Date.now()).padEnd(31, '0')}`.slice(0, 32);
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
      // Gera um cardToken como o SDK faria (o teste de API não tem navegador). `number` define o resultado, como no sandbox.
      if (req.path === '/__fake/token') {
        const cardToken = mintCardToken(body.number ?? '4111111111111111');
        return send(res, 200, { cardToken, deviceId: randomUUID() });
      }
      if (req.path === '/__fake/token/expire') {
        const token = state.cardTokens.get(body.cardToken);
        if (!token) return send(res, 404, {});
        token.expired = true;
        return send(res, 200, {});
      }
      // Conclui uma devolução pendente como o banco faria: CONFIRMED (a cobrança vira REFUNDED/PARTIALLY_REFUNDED) ou ERROR.
      if (req.path === '/__fake/refund-settle') {
        const refund = state.refunds.find((item) => item.refundId === body.refundId);
        if (!refund) return send(res, 404, {});
        refund.status = body.status ?? 'CONFIRMED';
        refund.success = refund.status === 'CONFIRMED';
        if (refund.status === 'ERROR') refund.error = body.error ?? 'ERROR';
        const charge = state.charges.get(refund.chargeId);
        if (charge && refund.status === 'CONFIRMED') {
          const sum = state.refunds.filter((item) => item.chargeId === charge.id && item.status === 'CONFIRMED').reduce((acc, item) => acc + item.amount, 0);
          charge.status = sum >= charge.amount - 1e-9 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        }
        return send(res, 200, refund);
      }
      // Cria direto uma devolução que a loja NÃO pediu (feita no painel da ValidaPay).
      if (req.path === '/__fake/refund-external') {
        const charge = state.charges.get(body.chargeId);
        if (!charge) return send(res, 404, {});
        const refund = { refundId: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`, accountId: charge.sub ?? 'master', status: body.status ?? 'CONFIRMED', success: (body.status ?? 'CONFIRMED') === 'CONFIRMED', amount: body.amount, reason: 'MD06', chargeId: charge.id, endToEndId: charge.endToEndId, paymentType: charge.card ? 'CREDIT_CARD' : null, splitReversals: [], error: null, createdAt: new Date().toISOString() };
        state.refunds.push(refund);
        if (refund.status === 'CONFIRMED') {
          const sum = state.refunds.filter((item) => item.chargeId === charge.id && item.status === 'CONFIRMED').reduce((acc, item) => acc + item.amount, 0);
          charge.status = sum >= charge.amount - 1e-9 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        }
        return send(res, 200, refund);
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

    // ---- SDK de tokenização (navegador): sem token OAuth, identificado pelo Id Público ----
    if (req.method === 'POST' && req.path === '/v1/payment-sessions') {
      log(req);
      if (req.body?.publicId !== FAKE.publicId) return fail(res, 404, 'PUBLIC_ID_NOT_FOUND', 'Id público desconhecido');
      return send(res, 200, { fingerprint: { orgId: 'fakeorg', merchantId: 'fakemerchant', dfpId: randomUUID() } });
    }
    if (req.method === 'POST' && req.path === '/v1/payment-sessions/payment-methods') {
      const b = req.body ?? {};
      // O registro de chamadas NUNCA guarda número, CVV nem validade do cartão (nem os de teste): só o que a loja precisa conferir.
      log(req, { body: { publicId: b.publicId ?? null, hasCard: Boolean(b.number), last4: String(b.number ?? '').replace(/\D/g, '').slice(-4), customer: { name: b.customer?.name ?? null, email: b.customer?.email ?? null } } });
      if (b.publicId !== FAKE.publicId) return fail(res, 404, 'PUBLIC_ID_NOT_FOUND', 'Id público desconhecido');
      const digits = String(b.number ?? '').replace(/\D/g, '');
      if (!/^\d{13,19}$/.test(digits)) return fail(res, 400, 'INVALID_CARD', 'Número do cartão inválido');
      if (!/^\d{3,4}$/.test(String(b.cvv ?? ''))) return fail(res, 400, 'INVALID_CARD', 'CVV inválido');
      if (!/^(0[1-9]|1[0-2])\/\d{4}$/.test(String(b.expiration ?? ''))) return fail(res, 400, 'INVALID_CARD', 'Validade inválida (use MM/AAAA)');
      if (typeof b.cardHolderName !== 'string' || !b.cardHolderName.trim()) return fail(res, 400, 'INVALID_CARD', 'Nome do titular obrigatório');
      if (!/^(\d{11}|\d{14})$/.test(String(b.customer?.document ?? '')) || !b.customer?.name || !b.customer?.email) return fail(res, 400, 'INVALID_CARD', 'Dados do comprador inválidos');
      const cardToken = mintCardToken(digits);
      const t = state.cardTokens.get(cardToken);
      return send(res, 200, { cardToken, cardTokenExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), cardBrand: t.brand, cardLastFour: t.last4 });
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

    // POST /v1/charges (cartão de crédito à vista)
    if (req.method === 'POST' && req.path === '/v1/charges') {
      if (!need('charges/write')) return;
      if (state.mode.card === 'forbidden') return fail(res, 403, 'FORBIDDEN', 'sem permissão');
      if (state.mode.card === 'down') return fail(res, 500, 'INTERNAL', 'erro interno');
      const body = req.body ?? {};
      if (body.paymentMethod !== 'creditcard') return fail(res, 400, 'INVALID_DATA', 'esta rota é usada pela loja só para cartão');
      const c = body.customer;
      if (!c || typeof c.name !== 'string' || !c.name.trim() || !/^\S+@\S+\.\S+$/.test(c.email ?? '') || !/^(\d{11}|\d{14})$/.test(c.documentNumber ?? '')) return fail(res, 400, 'INVALID_DATA', 'customer.name, customer.email e customer.documentNumber (11 ou 14 dígitos) são obrigatórios');
      if (c.phone !== undefined && !/^\+55\d{10,11}$/.test(c.phone)) return fail(res, 400, 'INVALID_DATA', 'telefone fora do formato E.164');
      if (state.mode.phoneRequired && !c.phone) return fail(res, 400, 'CUSTOMER_PHONE_REQUIRED', 'telefone obrigatório para cobrança no cartão');
      if (typeof body.cardToken !== 'string' || !body.cardToken) return fail(res, 400, 'MISSING_CARD_DATA', 'cardToken é obrigatório na cobrança com cartão; gere um com o SDK @validapay/tokenize');
      if (typeof body.deviceId !== 'string' || !UUID.test(body.deviceId)) return fail(res, 400, 'INVALID_DATA', 'deviceId deve estar no formato uuid');
      if (body.items !== undefined) return fail(res, 400, 'INVALID_DATA', 'envie items OU amount, nunca os dois');
      if (typeof body.amount !== 'number' || body.amount < 0.01 || !reais(body.amount)) return fail(res, 400, 'INVALID_DATA', 'amount deve ser um valor em reais com duas casas (mín. 0.01)');
      if (body.installments !== undefined && !(Number.isInteger(body.installments) && body.installments >= 1 && body.installments <= 12)) return fail(res, 400, 'INVALID_DATA', 'installments inválido');
      // A documentação não traz divisão (split) para o cartão: quem a mandar é recusado, para o teste pegar o desvio.
      if (body.split !== undefined) return fail(res, 400, 'INVALID_DATA', 'split não existe na cobrança no cartão');
      if (state.mode.cardSub === 'forbidden' && sub) return fail(res, 400, 'INVALID_DATA', 'X-Sub-Account não é aceito nesta rota');
      if (sub && !state.subaccounts.some((a) => a.accountNumber === sub && a.status === 'CONFIRMED')) return fail(res, 404, 'ACCOUNT_NOT_FOUND', 'subconta desconhecida');
      // Token: de uso único, vale 5 minutos, existente (não é de outra conta).
      const token = state.cardTokens.get(body.cardToken);
      if (!token || token.used) return fail(res, 404, 'CARD_TOKEN_NOT_FOUND', 'cardToken inexistente ou de outra conta');
      if (token.expired || Date.now() - token.createdAt > 5 * 60_000) return fail(res, 400, 'CARD_TOKEN_EXPIRED', 'cardToken expirado: gere outro na página');
      // Idempotência: o mesmo externalId NUNCA cobra duas vezes. A resposta traz o chargeId da cobrança original (e o token novo não é gasto).
      if (typeof body.externalId === 'string' && state.externalIds.has(body.externalId)) {
        return send(res, 409, { error: { message: 'externalId já utilizado', code: 'DUPLICATE_CHARGE', details: { chargeId: state.externalIds.get(body.externalId) }, timestamp: new Date().toISOString() } });
      }
      token.used = true;
      const id = `cha_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      const approved = token.outcome === null;
      const charge = {
        id,
        amount: body.amount,
        split: null,
        sub,
        metadata: null, // documentado: metadata NÃO é gravado na cobrança no cartão
        externalId: body.externalId ?? null,
        externalTxid: body.externalTxid ?? null,
        card: { last4: token.last4, brand: token.brand },
        customerDocument: c.documentNumber,
        installments: body.installments ?? 1,
        status: approved ? (state.mode.card === 'processing' ? 'PROCESSING' : 'PAID') : 'FAILED',
        failureReason: approved ? null : token.outcome,
        createdAt: new Date().toISOString(),
        expiresAt: null,
        emv: null,
        paidAt: null,
        paidAmount: null,
        fee: null,
        endToEndId: null,
      };
      if (charge.status === 'PAID') {
        charge.paidAt = new Date().toISOString();
        charge.paidAmount = Number((body.amount + state.mode.cardPaidDelta).toFixed(2));
        charge.fee = cardFeeOf(body.amount);
      }
      state.charges.set(id, charge);
      if (body.externalId) state.externalIds.set(body.externalId, id);
      state.cardChargeCount += 1;
      if (state.mode.card === 'lose') return void rawReq.socket.destroy();
      if (state.mode.card === 'hang') return;
      if (state.mode.card === 'down_after') return fail(res, 500, 'INTERNAL', 'erro interno');
      if (!approved) return send(res, 402, { success: false, chargeId: id, status: 'failed', error: token.outcome });
      return send(res, 200, { success: true, chargeId: id, customerId: `cus_${state.seq}`, status: charge.status === 'PAID' ? 'paid' : 'processing' });
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
          paymentType: charge.card ? 'CREDIT_CARD' : 'PIX',
          emv: charge.emv,
          qrCode: charge.emv ? 'data:image/png;base64,iVBORw0KGgo=' : null,
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
        paymentType: charge.card ? 'CREDIT_CARD' : 'PIX',
        saleType: 'ONE_TIME',
        paidAt: charge.paidAt,
        expiresAt: charge.expiresAt,
        endToEndId: charge.endToEndId,
        externalTxid: charge.externalTxid,
        grossAmount: charge.amount,
        failureReason: charge.failureReason ?? null,
        netAmount: charge.fee === null || (charge.card && state.mode.cardFeeReport === 'none') ? null : Number((charge.amount - charge.fee).toFixed(2)),
        paidAmount: charge.paidAmount,
        fee:
          charge.fee === null || (charge.card && state.mode.cardFeeReport === 'none')
            ? null
            : charge.card
              ? { amount: charge.fee, percentageRate: state.mode.cardFeePct / 100, percentage: state.mode.cardFeePct, fixed: state.mode.cardFeeFixed }
              : { amount: charge.fee, percentageRate: 0, percentage: 0, fixed: charge.fee },
        payer: charge.paidAt ? { name: 'Pagador Teste', document: '12345678909' } : null,
        pix: charge.card ? null : { emv: charge.emv, qrCode: 'data:image/png;base64,iVBORw0KGgo=', dueDate: null, discount: null },
        card: charge.card ? { brand: charge.card.brand, lastFour: charge.card.last4, installments: charge.installments } : null,
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

    // POST /v1/wallet/refunds (Pix: { chargeId, amount, reason } · cartão: { chargeId, amount, accountId?, reason? })
    if (req.method === 'POST' && req.path === '/v1/wallet/refunds') {
      if (state.mode.refundFail === 'forbidden') return fail(res, 403, 'FORBIDDEN', 'o token não tem o escopo wallet/write');
      if (!need('wallet/write')) return;
      if (state.mode.refundFail === 'hang') return; // nunca responde: o adaptador estoura o prazo
      if (state.mode.refundFail === 'down') return fail(res, 500, 'INTERNAL', 'erro interno');
      const body = req.body ?? {};
      // Só os campos do contrato: a ValidaPay recusa o corpo { endToEndId, reason } do guia (validate_request).
      if (typeof body.chargeId !== 'string') return fail(res, 400, 'INVALID_DATA', 'chargeId é obrigatório');
      if (typeof body.amount !== 'number' || body.amount < 0.01 || !reais(body.amount)) return fail(res, 400, 'INVALID_DATA', 'amount deve ser um valor em reais com duas casas');
      const charge = state.charges.get(body.chargeId);
      const hide = (state.mode.refundSub === 'required' && charge?.sub && sub !== charge.sub) || (state.mode.refundSub === 'forbidden' && sub);
      if (!charge || hide) return fail(res, 404, 'CHARGE_NOT_FOUND', 'Cobrança não encontrada');
      if (!charge.card && !['BANK_ERROR', 'FRAUD', 'CUSTOMER_REQUEST', 'PIX_CHANGE_ERROR'].includes(body.reason)) return fail(res, 400, 'INVALID_DATA', 'reason é obrigatório e deve ser BANK_ERROR, FRAUD, CUSTOMER_REQUEST ou PIX_CHANGE_ERROR');
      if (!charge.card && !charge.endToEndId) return fail(res, 400, 'CHARGE_WITHOUT_END_TO_END_ID', `Cobrança ${charge.id} não possui endToEndId: o pagamento Pix ainda não foi confirmado ou a cobrança não é Pix`);
      if (!['PAID', 'PARTIALLY_REFUNDED'].includes(charge.status)) return fail(res, 400, 'CHARGE_NOT_REFUNDABLE', 'Só cobranças pagas podem ser devolvidas');
      const used = state.refunds.filter((item) => item.chargeId === charge.id && item.status !== 'ERROR').reduce((acc, item) => acc + item.amount, 0);
      if (body.amount > charge.amount - used + 1e-9) return fail(res, 400, 'REFUND_AMOUNT_EXCEEDED', `Valor excede o disponível para devolução. Original: R$${charge.amount}, já devolvido: R$${used}, restante: R$${(charge.amount - used).toFixed(2)}`);
      const instant = charge.card && state.mode.refundCardInstant;
      const refund = {
        refundId: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
        accountId: charge.sub ?? 'master',
        status: instant ? 'CONFIRMED' : 'PROCESSING',
        success: Boolean(instant),
        amount: body.amount,
        reason: body.reason ?? null,
        chargeId: charge.id,
        endToEndId: charge.card ? null : charge.endToEndId,
        paymentType: charge.card ? 'CREDIT_CARD' : null,
        splitReversals: [],
        error: null,
        createdAt: new Date().toISOString(),
      };
      state.refunds.push(refund);
      if (instant) charge.status = state.refunds.filter((item) => item.chargeId === charge.id && item.status === 'CONFIRMED').reduce((acc, item) => acc + item.amount, 0) >= charge.amount - 1e-9 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      if (state.mode.refundFail === 'lose') return res.destroy(); // a devolução FOI criada, mas a resposta nunca chega
      const answer = { refundId: refund.refundId, status: refund.status, ...(instant ? { success: true } : {}), amount: state.mode.refundFail === 'badresponse' ? Number((refund.amount + 1).toFixed(2)) : refund.amount, reason: refund.reason, ...(charge.card ? { paymentType: 'CREDIT_CARD', providerChargeId: 'prov_ch_fake' } : { endToEndId: refund.endToEndId }), chargeId: charge.id, createdAt: refund.createdAt };
      return send(res, 201, answer);
    }

    // GET /v1/wallet/refunds (?refundId= · ?chargeId=): sempre uma lista em `items`
    if (req.method === 'GET' && req.path === '/v1/wallet/refunds') {
      if (!need('wallet/read')) return;
      if (state.mode.refundList === 'down') return fail(res, 503, 'UNAVAILABLE', 'fora do ar');
      const chargeId = url.searchParams.get('chargeId');
      const refundId = url.searchParams.get('refundId');
      return send(res, 200, { items: state.refunds.filter((item) => (refundId ? item.refundId === refundId : item.chargeId === chargeId)) });
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

// payment.success de uma cobrança avulsa no cartão (a loja só usa chargeId, status e valor; o resto é conferido na consulta à ValidaPay).
export const paymentSuccessCard = (charge, extra = {}) =>
  paymentSuccess(charge, { paymentType: 'CREDIT_CARD', paymentMethod: 'CREDIT_CARD', paymentId: null, metadata: null, payer: { name: 'Pagador Teste', taxId: charge.customerDocument ?? '12345678909' }, ...extra });

export const sleep = wait;
