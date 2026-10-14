// Adaptador da ValidaPay (Pix com divisão da comissão para a conta master, conferência de cobrança, cancelamento, avisos e subcontas).
//
// TUDO aqui vem da documentação oficial da ValidaPay (servidor MCP da própria ValidaPay, consultado em 11/10/2026): endereços,
// autenticação, campos, regras e eventos. O que a documentação NÃO diz está marcado com "NÃO CONFIRMADO" e tem um comportamento seguro:
//  • Autenticação: OAuth2 client_credentials em POST /auth/token (corpo "x-www-form-urlencoded" com grant_type, client_id, client_secret e
//    scope). Um token por escopo (a documentação só exemplifica um escopo por pedido); vale 3600 s.
//  • Pix com divisão para a master: POST /v1/charges/pix com o cabeçalho X-Sub-Account (a subconta do estabelecimento) e `split` SEM
//    accountNumber. Valores em REAIS (nunca centavos). Esta rota NÃO tem idempotência (externalId é descartado): duas chamadas iguais criam
//    duas cobranças; o controle de duplicidade é da loja (uma cobrança em aberto por pedido, no banco). A resposta traz chargeId e emv.
//  • A validade do QR Code de uma cobrança imediata não é configurável em minutos (só "expiration", uma data): a loja vale-se da própria
//    validade (15 min) e CANCELA a cobrança na ValidaPay quando vence (DELETE /v1/charges/{id}: "o QR Code deixa de aceitar pagamento").
//  • Consulta: GET /v1/charges/{id}/status (leve, para repetir) e GET /v1/charges/{id} (taxa, líquido, valor pago). Devoluções:
//    GET /v1/wallet/refunds?chargeId=. Status: PENDING, PROCESSING, AWAITING_PAYMENT, PAID, FAILED, EXPIRED, CANCELED, ARCHIVED, DISPUTE,
//    REFUNDED, PARTIALLY_REFUNDED, CHARGED_BACK.
//  • Avisos: POST com X-Webhook-Signature "t=<ms>,v1=<hex>", v1 = HMAC-SHA256(segredo, `${t}.${corpo bruto}`); X-Webhook-Id é o mesmo em
//    todas as tentativas do mesmo aviso (chave de deduplicação); assinatura com mais de 5 minutos é recusada; opcionalmente x-access-token.
//  • Subcontas: POST /v1/proposals (PF ou PJ) devolve formId; o número da conta chega no aviso onboarding.create (data.account.number) e a
//    listagem oficial é GET /v1/accounts/subaccounts. A criação custa R$ 15,00 em produção (debitados da master); no sandbox não há cobrança.
//  • Cartão de crédito (à vista): POST /v1/charges com paymentMethod "creditcard", `cardToken` e `deviceId` (gerados NO NAVEGADOR pelo SDK
//    @validapay/tokenize: número e CVV nunca passam por aqui), `customer` (nome, e-mail e CPF/CNPJ obrigatórios), `amount` em REAIS (o total já com a
//    taxa do cartão que a loja repassa ao cliente) e `externalId` = id da tentativa da loja (chave de idempotência: repetir recebe 409
//    DUPLICATE_CHARGE com o chargeId original em error.details.chargeId, e o cartão não é cobrado de novo). A resposta é imediata: 200
//    (status "paid") ou 402 (recusado). `metadata` NÃO é gravado nesta rota (só o Pix grava), então a ligação com o pedido é o chargeId e o
//    externalId. `installments: 1` e `passFeesToCustomer: false`: o campo documentado repassa a taxa de PARCELAMENTO, e a taxa do cartão à vista é
//    repassada pela própria loja (o preço já chega somado), sem cobrança em duplicidade.
//    O CARTÃO É UM FLUXO SEPARADO DO PIX: é cobrado na SUBCONTA do estabelecimento (cabeçalho X-Sub-Account) e SEM `split` (a documentação não traz
//    divisão para o cartão). O Pix continua com a subconta E a divisão de valor fixo para a master. NÃO CONFIRMADO na documentação: se a cobrança no
//    cartão aceita X-Sub-Account e se o token gerado com o publicId (VALIDAPAY_PUBLIC_ID) vale para a subconta: o token "só funciona na conta que o
//    gerou", então o publicId tem de ser o Id Público DA SUBCONTA em que o cartão é cobrado.
//  • NÃO CONFIRMADO: se a consulta de uma cobrança criada na subconta exige o cabeçalho X-Sub-Account (a loja envia e, se a ValidaPay
//    responder 404, tenta de novo sem ele); se o repasse da comissão aparece no extrato da master (GET /v1/wallet/transactions) com o
//    chargeId da cobrança (a loja só marca a comissão como efetivada se achar esse crédito; senão ela fica "calculada"); como a ValidaPay
//    sinaliza subconta duplicada (a loja trata qualquer 409 como conflito e mostra a mensagem que ela devolver).
//
// Sem segredos em log: este módulo não registra nada, e as mensagens de erro nunca levam credenciais, tokens ou corpos de resposta.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from './types.js';
import type {
  CancelResult,
  CardChargeResult,
  CardCheckoutConfig,
  ChargeSnapshot,
  ChargeStatus,
  CreateCardInput,
  CreatePixInput,
  CreatedPix,
  MerchantObservation,
  MerchantProvider,
  PaymentProvider,
  ProposalReceipt,
  ProposalState,
  ProviderAccount,
  ProviderContext,
  WebhookEvent,
} from './types.js';

export type ValidaPayEnvironment = 'sandbox' | 'production';

const URLS = {
  sandbox: { api: 'https://sandbox.validapay.com.br', auth: 'https://oauth2-sandbox.validapay.com.br/auth/token' },
  production: { api: 'https://api.validapay.com.br', auth: 'https://oauth2.validapay.com.br/auth/token' },
} as const;

// Variáveis de ambiente (só no servidor, nunca VITE_): os NOMES são da loja; os valores são os que a ValidaPay mostra no painel.
export const VALIDAPAY_REQUIRED_VARIABLES = ['VALIDAPAY_ENV', 'VALIDAPAY_CLIENT_ID', 'VALIDAPAY_CLIENT_SECRET', 'VALIDAPAY_WEBHOOK_SECRET'] as const;

export type ValidaPayConfig = {
  environment: ValidaPayEnvironment;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  // Token estático opcional (cabeçalho x-access-token), se configurado no cadastro do webhook da ValidaPay.
  webhookToken?: string | null;
  // Cartão: identificador PÚBLICO da conta em que o cartão é cobrado, a SUBCONTA do estabelecimento (painel → Gerenciamento → Minha Conta → Id Público;
  // não é segredo), que o SDK do navegador usa. Sem o publicId o cartão online não existe.
  publicId?: string | null;
  // Só os testes trocam estes quatro: nunca vêm do ambiente de produção.
  apiUrl?: string;
  authUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  cardTimeoutMs?: number;
};

// ---- Conversões --------------------------------------------------------------------------------------------------------------------

const reais = (cents: number): number => Number((cents / 100).toFixed(2));

function toCents(value: unknown): number | null {
  const n = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  const cents = Math.round(n * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

const text = (value: unknown, max = 200): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

function toDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Na documentação do sandbox o mesmo identificador aparece às vezes com o prefixo "SANDBOX_": para comparar, ele não conta.
const bare = (id: string): string => id.replace(/^SANDBOX_/, '');
const sameCharge = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && bare(a) === bare(b);

const CHARGE_ID = /^[A-Za-z0-9_-]{3,120}$/;
const ACCOUNT_NUMBER = /^[A-Za-z0-9_-]{1,60}$/;

export const maskDocument = (value: unknown): string | null => {
  const digits = typeof value === 'string' ? value.replace(/\D/g, '') : '';
  if (!digits) return null;
  return digits.length <= 4 ? '••••' : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
};

// Status da ValidaPay → status da loja. Desconhecido: o adaptador recusa (a cobrança não muda por um status que ninguém entendeu).
const STATUS: Record<string, ChargeStatus> = {
  PENDING: 'pending',
  AWAITING_PAYMENT: 'pending',
  PROCESSING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  EXPIRED: 'expired',
  CANCELED: 'cancelled',
  CANCELLED: 'cancelled',
  ARCHIVED: 'cancelled',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'refunded',
  // O dinheiro entrou, mas está em contestação: a loja mantém "pago" e sinaliza para conferência.
  DISPUTE: 'paid',
  CHARGED_BACK: 'paid',
};
const NEEDS_DETAIL = new Set(['PAID', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTE', 'CHARGED_BACK']);
const REFUND_STATUSES = new Set(['REFUNDED', 'PARTIALLY_REFUNDED']);
const DISPUTED = new Set(['DISPUTE', 'CHARGED_BACK']);

// ---- Fábrica ------------------------------------------------------------------------------------------------------------------------

export function createValidaPayProvider(config: ValidaPayConfig): PaymentProvider {
  const now = config.now ?? (() => Date.now());
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.requestTimeoutMs ?? 6000;
  const urls = { api: config.apiUrl ?? URLS[config.environment].api, auth: config.authUrl ?? URLS[config.environment].auth };

  // ---- Token (um por escopo; compartilha a busca em andamento) ----
  const tokens = new Map<string, { value: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();

  async function fetchToken(scope: string): Promise<string> {
    let response: Response;
    try {
      response = await doFetch(urls.auth, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret, scope }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Sem token nenhuma cobrança foi criada: falha definitiva desta tentativa (não há o que conferir depois).
      throw new ProviderError('rejected', 'não foi possível obter o token da ValidaPay', 'TOKEN_UNAVAILABLE');
    }
    const data = await readJson(response);
    const value = isObject(data) ? text(data.access_token, 4000) : null;
    if (!response.ok || !value) {
      throw new ProviderError('rejected', `credenciais recusadas pela ValidaPay (HTTP ${response.status})`, 'TOKEN_REJECTED', response.status);
    }
    const seconds = isObject(data) && typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) ? Math.min(Math.max(data.expires_in, 60), 3600) : 3600;
    tokens.set(scope, { value, expiresAt: now() + seconds * 1000 });
    return value;
  }

  async function tokenFor(scope: string): Promise<string> {
    const cached = tokens.get(scope);
    if (cached && cached.expiresAt - 60_000 > now()) return cached.value;
    let inflight = pending.get(scope);
    if (!inflight) {
      inflight = fetchToken(scope).finally(() => pending.delete(scope));
      pending.set(scope, inflight);
    }
    return inflight;
  }

  async function readJson(response: Response): Promise<unknown> {
    const raw = await response.text().catch(() => '');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  // ---- Chamada à API ----
  type Call = { method: 'GET' | 'POST' | 'DELETE'; path: string; scope: string; query?: Record<string, string>; body?: unknown; subAccount?: string | null; timeoutMs?: number };
  type Reply = { status: number; data: unknown };

  async function send(call: Call): Promise<Reply> {
    // 401 = a ValidaPay não reconheceu o token (vencido antes da hora, revogado): nada foi processado. Pede um token novo e repete UMA vez.
    for (let attempt = 0; ; attempt++) {
      const token = await tokenFor(call.scope);
      const url = new URL(call.path, urls.api);
      for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (call.body !== undefined) headers['content-type'] = 'application/json';
      if (call.subAccount) headers['x-sub-account'] = call.subAccount;
      let response: Response;
      try {
        response = await doFetch(url, { method: call.method, headers, body: call.body === undefined ? undefined : JSON.stringify(call.body), signal: AbortSignal.timeout(call.timeoutMs ?? timeoutMs) });
      } catch {
        throw new ProviderError('unavailable', 'a ValidaPay não respondeu', 'NO_RESPONSE');
      }
      const data = await readJson(response);
      if (response.status === 401) {
        tokens.delete(call.scope);
        if (attempt === 0) continue;
      }
      if (data === undefined && response.ok) throw new ProviderError('unavailable', 'resposta da ValidaPay ilegível', 'BAD_RESPONSE', response.status);
      return { status: response.status, data };
    }
  }

  function failure(reply: Reply, what: string): ProviderError {
    const error = isObject(reply.data) && isObject(reply.data.error) ? reply.data.error : null;
    const code = text(error?.code, 80) ?? undefined;
    const message = text(error?.message, 300);
    const retryable = reply.status >= 500 || reply.status === 408 || reply.status === 429;
    return new ProviderError(retryable ? 'unavailable' : 'rejected', `${what}: HTTP ${reply.status}${code ? ` ${code}` : ''}${message ? ` — ${message}` : ''}`, code, reply.status);
  }

  // Leitura de cobrança: com o cabeçalho da subconta e, se a ValidaPay disser que não a conhece (NÃO CONFIRMADO se precisa), sem ele.
  async function readCharge(path: string, ctx: ProviderContext | undefined, query?: Record<string, string>): Promise<Reply> {
    const sub = ctx?.merchantAccountId ?? null;
    const reply = await send({ method: 'GET', path, scope: 'charges/read', subAccount: sub, query });
    if (reply.status === 404 && sub) return send({ method: 'GET', path, scope: 'charges/read', query });
    return reply;
  }

  async function refundedCents(chargeId: string, ctx: ProviderContext | undefined): Promise<number | null> {
    try {
      const sub = ctx?.merchantAccountId ?? null;
      const query: Record<string, string> = { chargeId };
      if (sub) query.accountId = sub;
      const reply = await send({ method: 'GET', path: '/v1/wallet/refunds', scope: 'wallet/read', query });
      if (reply.status !== 200 || !isObject(reply.data) || !Array.isArray(reply.data.items)) return null;
      let sum = 0;
      for (const item of reply.data.items) {
        if (!isObject(item) || (item.status !== 'CONFIRMED' && item.success !== true)) continue;
        sum += toCents(item.amount) ?? 0;
      }
      return sum;
    } catch {
      return null;
    }
  }

  // O repasse da comissão: só há evidência se a master recebeu um CRÉDITO ligado a ESTA cobrança (mesmo chargeId). NÃO CONFIRMADO: a
  // documentação não diz como o repasse aparece no extrato; sem achar o crédito a comissão fica "calculada" (nunca "efetivada").
  async function commissionEvidence(chargeId: string, paidAt: Date | null): Promise<number | null> {
    try {
      let sum = 0;
      let found = false;
      let pageToken: string | undefined;
      const from = new Date((paidAt?.getTime() ?? now()) - 15 * 60_000).toISOString();
      for (let page = 0; page < 3; page++) {
        const query: Record<string, string> = { type: 'CREDIT', dateFrom: from, limit: '100' };
        if (pageToken) query.nextPageToken = pageToken;
        const reply = await send({ method: 'GET', path: '/v1/wallet/transactions', scope: 'wallet/read', query });
        if (reply.status !== 200 || !isObject(reply.data) || !Array.isArray(reply.data.transactions)) return null;
        for (const entry of reply.data.transactions) {
          if (isObject(entry) && entry.type === 'CREDIT' && sameCharge(entry.chargeId, chargeId)) {
            sum += toCents(entry.amount) ?? 0;
            found = true;
          }
        }
        pageToken = reply.data.hasMore === true ? (text(reply.data.nextPageToken, 2000) ?? undefined) : undefined;
        if (!pageToken) break;
      }
      return found ? sum : null;
    } catch {
      return null;
    }
  }

  // ---- Cobrança Pix ----
  async function createPixCharge(input: CreatePixInput): Promise<CreatedPix> {
    if (!ACCOUNT_NUMBER.test(input.merchantAccountId)) throw new ProviderError('rejected', 'conta do estabelecimento inválida', 'MERCHANT_ACCOUNT');
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new ProviderError('rejected', 'valor inválido', 'AMOUNT');
    const body: Record<string, unknown> = {
      amount: reais(input.amountCents),
      paymentMethod: 'pix',
      externalTxid: 'copo-cheio-site',
      // metadata é gravado nesta rota e volta no aviso payment.success: é como o pagamento se liga ao pedido.
      metadata: { paymentId: input.paymentId, orderNumber: input.orderNumber },
    };
    // A comissão é uma divisão de valor FIXO para a master (sem accountNumber = a conta master). Valor fixo, e não percentual, para a conta
    // da ValidaPay ser exatamente a do banco da loja (centavo arredondado uma vez só). Sem comissão, sem divisão.
    if (input.commissionCents > 0) body.split = [{ type: 'fixed', amount: reais(input.commissionCents) }];
    const reply = await send({ method: 'POST', path: '/v1/charges/pix', scope: 'charges/write', body, subAccount: input.merchantAccountId });
    if (reply.status < 200 || reply.status >= 300) throw failure(reply, 'a ValidaPay recusou criar o Pix');
    const data = isObject(reply.data) ? reply.data : {};
    const chargeId = text(data.chargeId, 120);
    const emv = text(data.emv, 2048);
    // Criada com resposta ilegível: a cobrança pode existir lá. É ambíguo, a loja sinaliza para conferência.
    if (!chargeId || !CHARGE_ID.test(chargeId) || !emv) throw new ProviderError('unavailable', 'resposta da criação do Pix incompleta', 'BAD_RESPONSE', reply.status);
    return { providerChargeId: chargeId, qrPayload: emv, expiresAt: new Date(now() + input.expiresInSeconds * 1000), providerStatus: 'PENDING' };
  }

  // ---- Cobrança no cartão ----
  const CARD_TOKEN = /^[A-Za-z0-9_-]{8,200}$/;
  const DEVICE_ID = /^[A-Za-z0-9_-]{8,100}$/;
  // O banco do cliente pode demorar para autorizar: prazo maior que o das outras chamadas (e a loja espera um pouco mais que ele).
  const CARD_TIMEOUT_MS = config.cardTimeoutMs ?? 25_000;

  // O telefone do pedido (só dígitos, com ou sem o 55) no formato internacional que a operadora aceita.
  const e164 = (digits: string): string | null => {
    const national = digits.length >= 12 && digits.startsWith('55') ? digits.slice(2) : digits;
    return /^\d{10,11}$/.test(national) ? `+55${national}` : null;
  };

  async function createCardCharge(input: CreateCardInput): Promise<CardChargeResult> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new ProviderError('rejected', 'valor inválido', 'AMOUNT');
    if (!CARD_TOKEN.test(input.cardToken) || !DEVICE_ID.test(input.deviceId)) throw new ProviderError('rejected', 'dados do cartão inválidos', 'CARD_DATA');
    if (!ACCOUNT_NUMBER.test(input.merchantAccountId)) throw new ProviderError('rejected', 'conta do estabelecimento inválida', 'MERCHANT_ACCOUNT');
    const document = input.customer.document.replace(/\D/g, '');
    const phone = e164(input.customer.phone.replace(/\D/g, ''));
    if (!/^(\d{11}|\d{14})$/.test(document)) throw new ProviderError('rejected', 'CPF/CNPJ inválido', 'DOCUMENT');
    const body: Record<string, unknown> = {
      paymentMethod: 'creditcard',
      // Chave de idempotência: o id desta tentativa. Repetir a chamada (resposta perdida, clique repetido) NUNCA cobra o cartão duas vezes.
      externalId: input.paymentId,
      externalTxid: 'copo-cheio-site',
      customer: { name: input.customer.name, email: input.customer.email, documentNumber: document, ...(phone ? { phone } : {}) },
      cardToken: input.cardToken,
      deviceId: input.deviceId,
      // O total EXATO que a loja mostrou ao cliente (itens + entrega + taxa do cartão), calculado no banco.
      amount: reais(input.amountCents),
      installments: 1,
      passFeesToCustomer: false,
      description: input.description.slice(0, 120),
    };
    const reply = await send({
      method: 'POST',
      path: '/v1/charges',
      scope: 'charges/write',
      body,
      // Na subconta do estabelecimento, mas sem divisão: o cartão nunca leva `split` (que é só do Pix).
      subAccount: input.merchantAccountId,
      timeoutMs: CARD_TIMEOUT_MS,
    });
    const data = isObject(reply.data) ? reply.data : {};
    const error = isObject(data.error) ? data.error : null;
    if (reply.status === 402) {
      // Cartão recusado pelo banco ou pela operadora: definitivo. O texto vem da operadora (nunca leva dado do cartão).
      const chargeId = text(data.chargeId, 120);
      if (!chargeId || !CHARGE_ID.test(chargeId)) throw new ProviderError('rejected', 'cartão recusado', 'CARD_DECLINED', 402);
      return { providerChargeId: chargeId, outcome: 'declined', providerStatus: 'FAILED', reason: text(data.error, 120) ?? 'Cartão recusado' };
    }
    if (reply.status === 409 && text(error?.code, 80) === 'DUPLICATE_CHARGE') {
      // A operadora já conhece esta tentativa (a resposta anterior se perdeu): adota a cobrança original e confere o resultado dela.
      const original = text(isObject(error?.details) ? error.details.chargeId : null, 120);
      if (original && CHARGE_ID.test(original)) return { providerChargeId: original, outcome: 'duplicate', providerStatus: null };
      throw new ProviderError('unavailable', 'cobrança duplicada sem o identificador original', 'BAD_RESPONSE', 409);
    }
    if (reply.status < 200 || reply.status >= 300) throw failure(reply, 'a ValidaPay recusou a cobrança no cartão');
    const chargeId = text(data.chargeId, 120);
    // Aceita mas sem identificador: o cartão pode ter sido cobrado. Ambíguo: a loja não cobra de novo, sinaliza e confere.
    if (!chargeId || !CHARGE_ID.test(chargeId) || data.success !== true) throw new ProviderError('unavailable', 'resposta da cobrança no cartão incompleta', 'BAD_RESPONSE', reply.status);
    const status = text(data.status, 40)?.toUpperCase() ?? '';
    return { providerChargeId: chargeId, outcome: status === 'PAID' ? 'paid' : 'processing', providerStatus: status || null };
  }

  async function getCharge(chargeId: string, ctx?: ProviderContext): Promise<ChargeSnapshot> {
    if (!CHARGE_ID.test(chargeId)) throw new ProviderError('rejected', 'código de cobrança inválido', 'CHARGE_ID');
    const reply = await readCharge(`/v1/charges/${encodeURIComponent(chargeId)}/status`, ctx);
    if (reply.status !== 200 || !isObject(reply.data)) throw failure(reply, 'consulta da cobrança');
    const raw = text(reply.data.status, 40)?.toUpperCase() ?? '';
    const status = STATUS[raw];
    if (!status) throw new ProviderError('unavailable', 'status da cobrança desconhecido', 'UNKNOWN_STATUS', reply.status);
    if (!sameCharge(reply.data.chargeId, chargeId)) throw new ProviderError('unavailable', 'resposta de outra cobrança', 'OTHER_CHARGE', reply.status);

    let amountCents = toCents(reply.data.amount);
    let feeCents: number | null = null;
    let netCents: number | null = null;
    const paidAt = toDate(reply.data.paidAt);
    if (NEEDS_DETAIL.has(raw)) {
      const detail = await readCharge(`/v1/charges/${encodeURIComponent(chargeId)}`, ctx);
      if (detail.status === 200 && isObject(detail.data)) {
        const fee = isObject(detail.data.fee) ? toCents(detail.data.fee.amount) : null;
        feeCents = fee;
        netCents = toCents(detail.data.netAmount);
        // O que foi pago de fato (para a loja comparar com o valor da cobrança); sem ele vale o valor cobrado.
        amountCents = toCents(detail.data.paidAmount) ?? amountCents;
      }
    }

    const snapshot: ChargeSnapshot = {
      providerChargeId: chargeId,
      status,
      providerStatus: raw,
      amountCents,
      feeCents,
      netCents,
      paidAt: status === 'paid' || status === 'refunded' ? paidAt : null,
      refundedCents: null,
      split: null,
      disputed: DISPUTED.has(raw),
      detail: DISPUTED.has(raw) ? `A ValidaPay informa a cobrança como ${raw === 'DISPUTE' ? 'em disputa' : 'devolvida pelo banco (chargeback)'}.` : null,
    };
    if (REFUND_STATUSES.has(raw)) {
      const cents = await refundedCents(chargeId, ctx);
      // Estorno total sem o valor devolvido: vale o valor da cobrança; parcial sem o valor: a loja não presume (fica só sinalizado).
      snapshot.refundedCents = cents ?? (raw === 'REFUNDED' ? amountCents : null);
      if (cents === null && raw === 'PARTIALLY_REFUNDED') {
        snapshot.status = 'paid';
        snapshot.disputed = true;
        snapshot.detail = 'Estorno parcial informado pela ValidaPay, sem o valor devolvido. Confira na ValidaPay.';
      }
    }
    if ((status === 'paid' || status === 'refunded') && (ctx?.commissionCents ?? 0) > 0) {
      const credited = await commissionEvidence(chargeId, snapshot.paidAt ?? null);
      snapshot.split = credited === null ? { state: 'pending', detail: 'repasse ainda não encontrado no extrato da conta master' } : { state: 'applied', commissionCents: credited };
    }
    return snapshot;
  }

  async function cancelCharge(chargeId: string, ctx?: ProviderContext): Promise<CancelResult> {
    if (!CHARGE_ID.test(chargeId)) throw new ProviderError('rejected', 'código de cobrança inválido', 'CHARGE_ID');
    const path = `/v1/charges/${encodeURIComponent(chargeId)}`;
    const sub = ctx?.merchantAccountId ?? null;
    let reply = await send({ method: 'DELETE', path, scope: 'charges/write', subAccount: sub });
    if (reply.status === 404 && sub) reply = await send({ method: 'DELETE', path, scope: 'charges/write' });
    if (reply.status >= 200 && reply.status < 300) return { cancelled: true };
    const code = isObject(reply.data) && isObject(reply.data.error) ? text(reply.data.error.code, 80) : null;
    if (reply.status === 400 && code === 'CHARGE_NOT_CANCELABLE') return { cancelled: false, reason: 'not_cancelable' };
    if (reply.status === 404) return { cancelled: false, reason: 'not_found' };
    throw failure(reply, 'cancelamento da cobrança');
  }

  // ---- Avisos (webhooks) ----
  const MAX_AGE_MS = 5 * 60 * 1000;

  function checkSignature(rawBody: Uint8Array, headers: Headers): void {
    const header = headers.get('x-webhook-signature') ?? '';
    const parts = new Map<string, string>();
    for (const piece of header.split(',')) {
      const at = piece.indexOf('=');
      if (at > 0) parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
    }
    const t = parts.get('t') ?? '';
    const v1 = parts.get('v1') ?? '';
    if (!/^\d{10,16}$/.test(t) || !/^[0-9a-fA-F]{64}$/.test(v1)) throw new ProviderError('invalid_webhook', 'assinatura ausente ou malformada');
    const expected = createHmac('sha256', config.webhookSecret).update(`${t}.`).update(rawBody).digest();
    const given = Buffer.from(v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ProviderError('invalid_webhook', 'assinatura não confere');
    // Sem janela de tolerância, uma assinatura capturada valeria para sempre (a ValidaPay reenvia com assinatura nova).
    if (Math.abs(now() - Number(t)) > MAX_AGE_MS) throw new ProviderError('invalid_webhook', 'assinatura fora do prazo');
    if (config.webhookToken) {
      const token = Buffer.from(headers.get('x-access-token') ?? '');
      const wanted = Buffer.from(config.webhookToken);
      if (token.length !== wanted.length || !timingSafeEqual(token, wanted)) throw new ProviderError('invalid_webhook', 'token do aviso não confere');
    }
  }

  function merchantObservation(event: string, payload: Record<string, unknown>): MerchantObservation | null {
    const data = isObject(payload.data) ? payload.data : null;
    if (!data) return null;
    const step = event.slice('onboarding.'.length);
    const status = text(data.status, 20)?.toUpperCase() ?? '';
    const account = isObject(data.account) ? data.account : null;
    const accountNumber = text(account?.number, 60);
    let state: MerchantObservation['state'];
    if (event === 'onboarding.create') {
      // Conta aberta: só vale com o status CONFIRMED E o número da conta.
      if (status !== 'CONFIRMED' || !accountNumber || !ACCOUNT_NUMBER.test(accountNumber)) return null;
      state = 'confirmed';
    } else if (status === 'REPROVED') state = 'rejected';
    else if (status === 'APPROVED') state = 'approved';
    else if (status === 'PENDING') state = 'pending';
    else return null;
    return {
      formId: text(data.formId, 80),
      proposalId: text(data.proposalId, 80),
      state,
      step,
      accountNumber: state === 'confirmed' ? accountNumber : null,
      documentNumber: text(data.documentNumber, 20)?.replace(/\D/g, '') ?? null,
      detail: step === 'documentscopy' && text(data.url, 10) ? 'Aguardando o envio dos documentos pelo titular.' : null,
    };
  }

  async function verifyWebhook(rawBody: Uint8Array, headers: Headers): Promise<WebhookEvent[]> {
    checkSignature(rawBody, headers);
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    } catch {
      throw new ProviderError('malformed_webhook', 'corpo não é JSON');
    }
    if (!isObject(payload)) throw new ProviderError('malformed_webhook', 'corpo não é um objeto');
    const type = text(payload.event, 80) ?? text(headers.get('x-webhook-event'), 80);
    if (!type) throw new ProviderError('malformed_webhook', 'aviso sem o nome do evento');
    // O mesmo aviso tem o mesmo X-Webhook-Id em todas as tentativas. Sem ele, um resumo do conteúdo (iguais, mesma chave).
    const id = text(headers.get('x-webhook-id'), 120);
    const dedupeKey = id ?? `h:${createHash('sha256').update(rawBody).digest('hex')}`;

    if (type.startsWith('onboarding.')) {
      const merchant = merchantObservation(type, payload);
      return [{ dedupeKey, type, providerChargeId: null, reference: null, snapshot: null, merchant, informational: merchant === null }];
    }

    const rawCharge = text(payload.chargeId, 120);
    const chargeId = rawCharge && CHARGE_ID.test(rawCharge) ? rawCharge : null;
    const metadata = isObject(payload.metadata) ? payload.metadata : null;
    const reference = text(metadata?.paymentId, 80);
    const mapped: Record<string, ChargeStatus> = { 'payment.success': 'paid', 'charge.expired': 'expired', 'payment.failed': 'failed' };
    const status = mapped[type];
    // Eventos que a loja só registra: criação da cobrança (a loja já sabe), assinaturas, MED, DDA... Os de pagamento, vencimento, falha e
    // devolução fazem a loja consultar a ValidaPay: o aviso só diz "olhe a cobrança X".
    const actionable = chargeId !== null && (status !== undefined || type.startsWith('refund.'));
    const snapshot: ChargeSnapshot | null =
      chargeId && status
        ? { providerChargeId: chargeId, status, providerStatus: text(payload.status, 40), amountCents: toCents(payload.amount), paidAt: toDate(payload.paidAt) }
        : null;
    return [{ dedupeKey, type, providerChargeId: chargeId, reference, snapshot, informational: !actionable }];
  }

  // ---- Subcontas ----
  const merchant: MerchantProvider = {
    environment: config.environment,
    accountCreationFeeCents: config.environment === 'production' ? 1500 : 0,

    async listAccounts(): Promise<ProviderAccount[]> {
      const out: ProviderAccount[] = [];
      let pageToken: string | undefined;
      for (let page = 1; page <= 5; page++) {
        // dateFrom/dateTo: o guia de subcontas cita estes filtros e a resposta devolve a janela usada; pede-se uma janela larga para não
        // perder contas antigas (NÃO CONFIRMADO qual é a janela padrão).
        const query: Record<string, string> = { perPage: '100', dateFrom: '2020-01-01T00:00:00.000Z', dateTo: new Date(now()).toISOString() };
        if (pageToken) {
          query.page = String(page);
          query.nextPageToken = pageToken;
        }
        const reply = await send({ method: 'GET', path: '/v1/accounts/subaccounts', scope: 'subaccounts/read', query });
        if (reply.status !== 200 || !isObject(reply.data) || !Array.isArray(reply.data.subAccounts)) throw failure(reply, 'listagem de subcontas');
        for (const item of reply.data.subAccounts) {
          if (!isObject(item)) continue;
          const number = item.accountNumber === undefined || item.accountNumber === null ? null : String(item.accountNumber);
          if (!number || !ACCOUNT_NUMBER.test(number)) continue;
          const status = text(item.status, 40) ?? '';
          out.push({ accountNumber: number, name: text(item.name, 120), documentMasked: maskDocument(item.documentNumber), status, confirmed: status.toUpperCase() === 'CONFIRMED' });
        }
        pageToken = reply.data.hasMore === true ? (text(reply.data.nextPageToken, 2000) ?? undefined) : undefined;
        if (!pageToken) break;
      }
      return out;
    },

    async submitProposal(kind, data): Promise<ProposalReceipt> {
      const reply = await send({ method: 'POST', path: '/v1/proposals', scope: 'proposals/write', body: data });
      if (reply.status < 200 || reply.status >= 300) throw failure(reply, kind === 'pf' ? 'cadastro da subconta (pessoa física)' : 'cadastro da subconta (pessoa jurídica)');
      const body = isObject(reply.data) ? reply.data : {};
      const formId = text(body.formId, 80);
      // Aceita, mas sem o formId: a proposta pode ter sido criada (e cobrada). Ambíguo: a loja não tenta de novo sozinha.
      if (!formId) throw new ProviderError('unavailable', 'resposta do cadastro sem o identificador do formulário', 'BAD_RESPONSE', reply.status);
      return { formId, status: text(body.status, 40) };
    },

    async getProposal(formId): Promise<ProposalState> {
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(formId)) throw new ProviderError('rejected', 'identificador de formulário inválido', 'FORM_ID');
      const reply = await send({ method: 'GET', path: `/v1/proposals/${encodeURIComponent(formId)}`, scope: 'proposals/write' });
      if (reply.status !== 200 || !isObject(reply.data)) throw failure(reply, 'consulta do cadastro da subconta');
      const status = isObject(reply.data.proposalStatus) ? reply.data.proposalStatus : {};
      return {
        formId,
        form: text(status.form, 40),
        proposal: text(status.proposal, 40),
        documents: text(status.documents, 40),
        documentsUrl: text(status.urlDocumentscopy, 500),
      };
    },
  };

  // O nome já diz o ambiente: contas, cobranças e avisos do sandbox nunca se misturam com os de produção (cada um tem o seu "provider").
  const publicId = (config.publicId ?? '').trim();
  const cardCheckout: CardCheckoutConfig | null = /^[A-Za-z0-9_-]{3,80}$/.test(publicId) ? { publicId, environment: config.environment } : null;
  return {
    name: config.environment === 'production' ? 'validapay' : 'validapay-sandbox',
    canLookup: true,
    createPixCharge,
    // Só existe com o identificador público da conta: sem ele o navegador não tem como gerar o token do cartão.
    ...(cardCheckout ? { createCardCharge, cardCheckout } : {}),
    getCharge,
    cancelCharge,
    verifyWebhook,
    merchant,
  };
}

// ---- A partir do ambiente do servidor -------------------------------------------------------------------------------------------------

export type ValidaPaySetup = {
  provider: PaymentProvider | null;
  environment: ValidaPayEnvironment | null;
  // Nomes (nunca valores) das variáveis obrigatórias que não estão definidas.
  missing: string[];
  // Por que não ligou, quando não é só falta de variável.
  note: string | null;
};

export function validaPayFromEnv(env: Record<string, string | undefined>): ValidaPaySetup {
  const value = (name: string) => env[name]?.trim() ?? '';
  const missing = VALIDAPAY_REQUIRED_VARIABLES.filter((name) => !value(name));
  if (missing.length) return { provider: null, environment: null, missing: [...missing], note: null };
  const environment = value('VALIDAPAY_ENV').toLowerCase();
  if (environment !== 'sandbox' && environment !== 'production') {
    return { provider: null, environment: null, missing: [], note: 'VALIDAPAY_ENV precisa ser "sandbox" ou "production".' };
  }
  // Deploy de teste (preview) nunca fala com a ValidaPay de produção: cobrança, subconta e tarifa seriam reais.
  if (environment === 'production' && env.VERCEL_ENV && env.VERCEL_ENV !== 'production') {
    return { provider: null, environment, missing: [], note: 'O ambiente de produção da ValidaPay só é usado no deploy de produção.' };
  }
  const provider = createValidaPayProvider({
    environment,
    clientId: value('VALIDAPAY_CLIENT_ID'),
    clientSecret: value('VALIDAPAY_CLIENT_SECRET'),
    webhookSecret: value('VALIDAPAY_WEBHOOK_SECRET'),
    webhookToken: value('VALIDAPAY_WEBHOOK_TOKEN') || null,
    publicId: value('VALIDAPAY_PUBLIC_ID') || null,
  });
  return { provider, environment, missing: [], note: null };
}
