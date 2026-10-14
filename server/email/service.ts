// O serviço central de e-mails: UM caminho de saída para tudo o que o sistema envia.
//
//   deliver()      → confere as regras (endereço suprimido, consentimento, tetos), registra a mensagem, envia pelo transporte e anota o
//                    resultado. Mensagens "sync" (têm código ou link de senha) são tentadas UMA vez, na hora, e o segredo nunca vai
//                    para o banco. Mensagens "queued" guardam só uma receita e, se o servidor de e-mail falhar, tentam de novo
//                    com espera crescente.
//   processQueue() → pega as mensagens que já podem ser (re)tentadas e as envia. Roda "de passagem" (sem agendador): depois de um pedido,
//                    com o painel aberto, no cron diário da Vercel e no botão "Processar fila" do painel.
//
// Regras que valem para tudo: o registro NUNCA impede o envio de um código de login (se o banco falhar, o e-mail sai mesmo assim);
// e-mail com segredo nunca é guardado nem reenviado; e o log nunca leva endereço, código, link nem corpo.
import { randomUUID } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { MissingConfig } from '../env.js';
import type { Message } from '../mail.js';
import { checkMailDomain } from '../mailDomain.js';
import { dailyLimit, promoDailyLimit } from './config.js';
import { classifyFailure, retryDelayMs } from './errors.js';
import { GROUP_DAY, KINDS, RECIPIENT_HARD_DAY, isKind } from './kinds.js';
import type { KindDef, KindName } from './kinds.js';
import * as ledger from './ledger.js';
import { getPreferences, isVerifiedCustomerEmail } from './preferences.js';
import { renderMessage } from './render.js';
import { getTransport } from './transport.js';
import type { MessageRow, SendFailure } from './types.js';

export type BlockReason = 'suppressed' | 'no_consent' | 'order_notices_off' | 'recipient_limit' | 'bad_domain' | 'no_recipient';

// Frase curta em português para o painel.
export const BLOCK_LABEL: Record<BlockReason, string> = {
  suppressed: 'Endereço na lista de supressão (devolução definitiva, reclamação ou bloqueio manual)',
  no_consent: 'Sem consentimento para promoções (ou conta não confirmada)',
  order_notices_off: 'O destinatário pediu para não receber e-mails de pedidos',
  recipient_limit: 'Teto de mensagens por endereço em 24 h atingido',
  bad_domain: 'Domínio do e-mail inexistente, descartável ou que não recebe e-mail',
  no_recipient: 'Sem destinatário válido',
};

// Por que o envio falhou, em português e sem dado sensível (as mesmas frases de sempre para o painel).
export function failureText(result: Pick<DeliverResult, 'blocked' | 'failure'>): string {
  if (result.blocked) return BLOCK_LABEL[result.blocked];
  switch (result.failure?.legacy) {
    case 'auth':
      return 'O servidor de e-mail recusou o usuário/senha (SMTP_USER / SMTP_PASS).';
    case 'network':
      return 'Não foi possível falar com o servidor de e-mail.';
    default:
      return result.failure?.kind === 'recipient' ? 'O servidor de e-mail recusou o endereço de destino.' : 'O servidor de e-mail não aceitou a mensagem.';
  }
}

export type DeliverInput = {
  kind: KindName;
  to: string;
  // Para os tipos "sync": a mensagem pronta (tem segredo; nunca é guardada).
  message?: Message;
  // Para os tipos "queued": a receita (só ids e dados sem segredo). Usada para montar a mensagem agora e nas novas tentativas.
  spec?: Record<string, unknown>;
  // Necessária para montar a mensagem a partir da receita (endereço do site, marca).
  req?: Request;
  customerId?: string | null;
  orderId?: string | null;
  campaignId?: string | null;
  // No máximo uma mensagem por esta chave (ex.: "campaign:<id>:<e-mail>").
  dedupeKey?: string | null;
  // "now" (padrão): tenta antes de voltar. "later": só entra na fila (quem chamou dispara o processamento).
  attempt?: 'now' | 'later';
};

export type DeliverResult = {
  ok: boolean;
  id: string | null;
  status: 'accepted' | 'queued' | 'failed' | 'blocked' | 'duplicate';
  blocked?: BlockReason;
  failure?: SendFailure;
};

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normalizeAddress = (value: unknown): string | null => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.length <= 254 && ADDRESS.test(email) ? email : null;
};

const log = (msg: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ level: 'warn', msg: `[email] ${msg}`, ...extra }));

// ---- Regras antes de enviar ---------------------------------------------------------------------------

async function verdict(kind: KindName, def: KindDef, to: string | null, excludeId?: string): Promise<BlockReason | null> {
  if (!to) return 'no_recipient';
  if (await ledger.suppressionOf(to)) return 'suppressed';
  if (def.category === 'promotional' || (def.respectsOrderPref && !def.userInitiated)) {
    const prefs = await getPreferences(to);
    if (def.category === 'promotional' && (!prefs || !prefs.marketing || !(await isVerifiedCustomerEmail(to)))) return 'no_consent';
    if (def.respectsOrderPref && prefs && !prefs.notify_orders) return 'order_notices_off';
  }
  if (def.checkDomain) {
    const check = await checkMailDomain(to.slice(to.lastIndexOf('@') + 1));
    if (!check.ok) return 'bad_domain';
  }
  if ((await ledger.countRecent(to, 24, { kinds: [kind], excludeId })) >= def.perRecipientDay) return 'recipient_limit';
  if (def.group) {
    const kinds = (Object.keys(KINDS) as KindName[]).filter((k) => KINDS[k].group === def.group);
    if ((await ledger.countRecent(to, 24, { kinds, excludeId })) >= GROUP_DAY[def.group]) return 'recipient_limit';
  }
  if ((await ledger.countRecent(to, 24, { excludeId })) >= RECIPIENT_HARD_DAY) return 'recipient_limit';
  return null;
}

// Cabeçalhos por categoria. Transacional: e-mail automático (não responder com "fora do escritório"). Promocional: NUNCA leva estes
// cabeçalhos; o descadastro com um clique (RFC 8058) vem da própria mensagem (message.headers).
function headersFor(def: KindDef, message: Message): Record<string, string> {
  const base: Record<string, string> = def.category === 'transactional' ? { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } : {};
  return { ...base, ...(message.headers ?? {}) };
}

// ---- Uma tentativa de envio ---------------------------------------------------------------------------

type Attempt = { id: string | null; attempt: number; maxAttempts: number };

type Outcome = { status: 'accepted' | 'queued' | 'failed'; failure?: SendFailure };

async function runSend(kind: KindName, def: KindDef, to: string, message: Message, at: Attempt, patient: boolean): Promise<Outcome> {
  const transport = getTransport();
  try {
    const result = await transport.send({ ...message, to, id: at.id ?? randomUUID(), headers: headersFor(def, message), patient });
    if (at.id) await ledger.markAccepted(at.id, at.attempt, transport.name, result).catch((e) => log('não foi possível registrar o envio', { id: at.id, error: String((e as Error).message).slice(0, 120) }));
    return { status: 'accepted' };
  } catch (error) {
    if (error instanceof MissingConfig) throw error;
    const failure = classifyFailure(error);
    // Nunca endereço, código, link nem corpo: só o motivo técnico.
    log('falha ao enviar', { id: at.id, kind, attempt: at.attempt, failure: failure.kind, code: failure.code, detail: failure.detail });
    const retry = def.mode === 'queued' && failure.retryable && at.attempt < at.maxAttempts;
    if (at.id) {
      try {
        if (retry) await ledger.markRetry(at.id, at.attempt, failure, retryDelayMs(at.attempt, failure.kind, Math.random()));
        else {
          await ledger.markFailed(at.id, at.attempt, failure);
          // Endereço definitivamente recusado pelo servidor de destino: não insistir nem nele nem em nenhum outro tipo de e-mail.
          if (failure.hard) await ledger.suppress(to, 'hard_bounce', 'smtp', at.id, failure.detail);
        }
      } catch (e) {
        log('não foi possível registrar a falha', { id: at.id, error: String((e as Error).message).slice(0, 120) });
      }
    }
    return { status: retry ? 'queued' : 'failed', failure };
  }
}

// ---- Enviar -------------------------------------------------------------------------------------------

export async function deliver(input: DeliverInput): Promise<DeliverResult> {
  const def = KINDS[input.kind];
  const to = normalizeAddress(input.to);
  const subject = def.sensitive ? def.label : (input.message?.subject ?? def.label);

  const blocked = await verdict(input.kind, def, to).catch((e) => {
    // Erro do banco ao conferir as regras não pode impedir um código de login: segue sem a conferência.
    log('não foi possível conferir as regras', { kind: input.kind, error: String((e as Error).message).slice(0, 120) });
    return null;
  });
  const base = {
    kind: input.kind,
    category: def.category,
    audience: def.audience,
    to,
    customerId: input.customerId,
    orderId: input.orderId,
    campaignId: input.campaignId,
    subject,
    maxAttempts: def.maxAttempts,
    transport: getTransport().name,
  } as const;
  if (blocked) {
    const id = await ledger.insertMessage({ ...base, status: 'blocked', dedupeKey: null, blockReason: blocked }).catch(() => null);
    return { ok: false, id, status: 'blocked', blocked };
  }

  const now = input.attempt !== 'later';
  let id: string | null = null;
  let ledgerDown = false;
  try {
    id = await ledger.insertMessage({ ...base, status: now ? 'sending' : 'queued', spec: def.sensitive ? null : (input.spec ?? null), dedupeKey: input.dedupeKey ?? null });
    if (id === null) return { ok: true, id: null, status: 'duplicate' };
  } catch (e) {
    ledgerDown = true;
    log('não foi possível registrar a mensagem', { kind: input.kind, error: String((e as Error).message).slice(0, 120) });
  }
  if (!now) return { ok: true, id, status: 'queued' };

  // Mensagem pronta (tipos com segredo) ou montada agora a partir da receita.
  let message = input.message ?? null;
  if (!message) {
    if (!input.req) throw new Error('deliver: falta a requisição (req) para montar a mensagem');
    message = await renderMessage({ kind: input.kind, to, spec: input.spec ?? null }, input.req).catch(() => null);
    if (!message) {
      if (id) await ledger.markCancelled(id, 'nada a enviar').catch(() => undefined);
      return { ok: false, id, status: 'failed', failure: undefined };
    }
  }
  if (id && !def.sensitive) await ledger.oneRow('update email_messages set subject = $2 where id = $1', [id, message.subject.slice(0, 200)]).catch(() => undefined);
  const outcome = await runSend(input.kind, def, to!, message, { id, attempt: 1, maxAttempts: def.maxAttempts }, false);
  void ledgerDown;
  return { ok: outcome.status === 'accepted', id, status: outcome.status, failure: outcome.failure };
}

// ---- Fila ---------------------------------------------------------------------------------------------

export type QueueResult = { processed: number; accepted: number; retried: number; failed: number; blocked: number; deferred: number; cancelled: number };

// Processa as mensagens que já podem ser tentadas. `budgetMs`: não pega mensagem nova depois desse tempo (a função da Vercel tem tempo limite).
export async function processQueue(opts: { req: Request; limit?: number; budgetMs?: number }): Promise<QueueResult> {
  const out: QueueResult = { processed: 0, accepted: 0, retried: 0, failed: 0, blocked: 0, deferred: 0, cancelled: 0 };
  const started = Date.now();
  const budget = opts.budgetMs ?? 6000;
  let remaining = Math.max(1, Math.min(opts.limit ?? 3, 25));
  while (remaining > 0 && Date.now() - started < budget) {
    const rows = await ledger.claimDue(Math.min(remaining, 3));
    if (!rows.length) break;
    for (const row of rows) {
      remaining -= 1;
      out.processed += 1;
      const result = await attemptClaimed(row, opts.req).catch((e) => {
        log('erro ao processar a fila', { id: row.id, error: String((e as Error).message).slice(0, 120) });
        return 'failed' as const;
      });
      out[result] += 1;
      if (Date.now() - started >= budget) break;
    }
  }
  if (out.processed) await ledger.finishCampaigns().catch(() => undefined);
  return out;
}

async function attemptClaimed(row: MessageRow, req: Request): Promise<'accepted' | 'retried' | 'failed' | 'blocked' | 'deferred' | 'cancelled'> {
  const kind = row.kind;
  if (!isKind(kind)) {
    await ledger.markFailed(row.id, row.attempts, { kind: 'render', retryable: false, hard: false, code: null, detail: 'tipo de e-mail desconhecido', legacy: 'other' });
    return 'failed';
  }
  const def = KINDS[kind];
  const to = row.recipient_email;
  const blocked = await verdict(kind, def, to, row.id);
  if (blocked) {
    await ledger.markBlocked(row.id, blocked);
    return 'blocked';
  }
  // Teto diário de envio do provedor: promoções usam só a parte delas; quem não cabe espera, sem gastar a tentativa.
  const total = dailyLimit();
  const promo = def.category === 'promotional';
  if (total > 0 || promo) {
    const usedAll = total > 0 ? await ledger.usedBudget() : 0;
    const usedPromo = promo ? await ledger.usedBudget('promotional') : 0;
    if ((total > 0 && usedAll >= total) || (promo && usedPromo >= promoDailyLimit())) {
      await ledger.deferWithoutAttempt(row.id, 30 * 60_000, 'teto diário de envio atingido; tenta de novo mais tarde');
      return 'deferred';
    }
  }
  const message = await renderMessage({ kind, to, spec: row.spec }, req);
  if (!message) {
    // O pedido já passou desta etapa, foi apagado, a campanha foi cancelada...: não há mais o que enviar (não é uma falha).
    await ledger.markCancelled(row.id, 'nada a enviar');
    return 'cancelled';
  }
  if (!def.sensitive) await ledger.oneRow('update email_messages set subject = $2 where id = $1', [row.id, message.subject.slice(0, 200)]).catch(() => undefined);
  const outcome = await runSend(kind, def, to!, message, { id: row.id, attempt: row.attempts, maxAttempts: row.max_attempts }, true);
  return outcome.status === 'accepted' ? 'accepted' : outcome.status === 'queued' ? 'retried' : 'failed';
}

// ---- Em segundo plano ---------------------------------------------------------------------------------

let lastKick = 0;
// A última requisição vista por esta instância: o processamento em segundo plano (disparado de dentro do banco, por exemplo quando um
// pagamento é confirmado) precisa de uma requisição só para saber o endereço do site.
let lastRequest: Request | null = null;
export const rememberRequest = (req: Request): void => {
  lastRequest = req;
};

// Um só processamento por vez nesta instância (o banco já impede que duas instâncias peguem a mesma mensagem). Se chega um aviso novo
// enquanto ele roda, `rerun` faz uma rodada a mais no fim: a mensagem pode ter entrado depois de o processamento olhar a fila.
let running: Promise<void> | null = null;
let rerun = false;

// Trabalho a fazer depois que a fila rodou (hoje: avaliar os alertas de entregabilidade). Registrado por server/index.ts, para este
// arquivo não precisar importar quem depende dele.
let afterRun: ((req: Request) => Promise<unknown>) | null = null;
export const onQueueRun = (fn: (req: Request) => Promise<unknown>): void => {
  afterRun = fn;
};

// Dispara o processamento da fila SEM esperar (o cliente já recebeu a resposta). Na Vercel, `waitUntil` mantém a função viva até
// terminar; fora dela (teste, computador do desenvolvedor) o trabalho simplesmente segue em paralelo. `minGapMs`: intervalo mínimo
// entre disparos nesta instância. O padrão (0) vale para quem sabe que acabou de enfileirar algo (pedido, pagamento); as telas que
// consultam de tempos em tempos passam um intervalo maior, para não pesar.
export function kickQueue(req?: Request, opts: { limit?: number; minGapMs?: number } = {}): void {
  const request = req ?? lastRequest;
  if (!request) return;
  const gap = opts.minGapMs ?? 0;
  if (running) {
    if (gap === 0) rerun = true;
    return;
  }
  if (Date.now() - lastKick < gap) return;
  lastKick = Date.now();
  const limit = opts.limit ?? 3;
  const job = (async () => {
    for (let round = 0; round < 3; round += 1) {
      rerun = false;
      const result = await processQueue({ req: request, limit, budgetMs: 6000 });
      if (!rerun && result.processed < limit) break;
    }
    if (afterRun) await afterRun(request).catch((e) => log('trabalho depois da fila falhou', { error: String((e as Error).message).slice(0, 120) }));
  })()
    .catch((e) => log('fila em segundo plano falhou', { error: String((e as Error).message).slice(0, 120) }))
    .finally(() => {
      running = null;
    });
  running = job;
  try {
    waitUntil(job);
  } catch {
    /* fora da Vercel não há contexto: o trabalho segue sozinho */
  }
}

// ---- Ações do painel ----------------------------------------------------------------------------------

// Reenvia uma mensagem que falhou (só as que ainda têm receita). Volta para a fila com as tentativas zeradas.
export async function requeue(id: string): Promise<boolean> {
  const row = await ledger.oneRow<{ id: string }>(
    `update email_messages set status = 'queued', attempts = 0, next_attempt_at = now(), claimed_at = null, error_kind = null, error_code = null, error_detail = null, block_reason = null
      where id = $1 and status in ('failed') and spec is not null and recipient_email is not null returning id`,
    [id],
  );
  return Boolean(row);
}

export async function cancel(id: string): Promise<boolean> {
  const row = await ledger.oneRow<{ id: string }>(
    `update email_messages set status = 'cancelled', block_reason = 'cancelada no painel', spec = null, next_attempt_at = null, claimed_at = null where id = $1 and status in ('queued', 'failed') returning id`,
    [id],
  );
  return Boolean(row);
}
