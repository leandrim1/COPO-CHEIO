// Acesso ao banco do sistema de e-mails: registro de mensagens, eventos, supressão e contagens. Só SQL; as regras ficam em service.ts.
// Nada aqui grava corpo de e-mail, código, link ou segredo: o registro só tem o que está descrito na migration 0019.
import { one, query } from '../db.js';
import type { Row } from '../db.js';
import { redact } from './errors.js';
import type { Audience, Category, MessageRow, SendFailure, SendResult } from './types.js';

export type NewMessage = {
  kind: string;
  category: Category;
  audience: Audience;
  to: string | null;
  customerId?: string | null;
  orderId?: string | null;
  campaignId?: string | null;
  subject: string | null;
  // sending: o chamador vai tentar agora (conta a tentativa 1) · queued: fica para a fila · blocked: nunca foi enviada.
  status: 'queued' | 'sending' | 'blocked';
  spec?: Record<string, unknown> | null;
  dedupeKey?: string | null;
  maxAttempts: number;
  blockReason?: string | null;
  transport?: string | null;
};

const domainOf = (email: string | null) => (email && email.includes('@') ? email.slice(email.lastIndexOf('@') + 1) : null);

// Devolve o id, ou null se já existe uma mensagem com a mesma chave de duplicidade (o e-mail "já foi tratado").
export async function insertMessage(m: NewMessage): Promise<string | null> {
  const row = await one<{ id: string }>(
    `insert into email_messages (kind, category, audience, recipient_email, recipient_domain, customer_id, order_id, campaign_id, subject, status, spec, dedupe_key,
                                 max_attempts, next_attempt_at, claimed_at, attempts, last_attempt_at, block_reason, transport)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
             case when $10 = 'queued' then now() else null end,
             case when $10 = 'sending' then now() else null end,
             case when $10 = 'sending' then 1 else 0 end,
             case when $10 = 'sending' then now() else null end,
             $14, $15)
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [
      m.kind,
      m.category,
      m.audience,
      m.to,
      domainOf(m.to),
      m.customerId ?? null,
      m.orderId ?? null,
      m.campaignId ?? null,
      m.subject ? m.subject.slice(0, 200) : null,
      m.status,
      m.spec ? JSON.stringify(m.spec) : null,
      m.dedupeKey ?? null,
      m.maxAttempts,
      m.blockReason ?? null,
      m.transport ?? null,
    ],
  );
  return row?.id ?? null;
}

export async function addEvent(messageId: string | null, provider: string, key: string, type: string, detail?: Record<string, unknown>): Promise<void> {
  await query('insert into email_events (message_id, provider, dedupe_key, type, detail) values ($1, $2, $3, $4, $5::jsonb) on conflict (provider, dedupe_key) do nothing', [
    messageId,
    provider,
    key.slice(0, 200),
    type,
    detail ? JSON.stringify(detail) : null,
  ]);
}

export async function markAccepted(id: string, attempt: number, transport: string, result: SendResult): Promise<void> {
  await query(
    `update email_messages
        set status = 'accepted', accepted_at = now(), transport = $2, message_id = $3, provider_id = $4, spec = null,
            next_attempt_at = null, claimed_at = null, error_kind = null, error_code = null, error_detail = null, block_reason = null
      where id = $1 and status in ('sending', 'queued')`,
    [id, transport, result.messageId?.slice(0, 200) ?? null, result.providerId?.slice(0, 200) ?? null],
  );
  await addEvent(id, 'smtp', `attempt:${id}:${attempt}`, 'accepted', { attempt, response: result.response ? redact(result.response, 100) : null });
}

const BOUNCE_OF = (f: SendFailure): 'hard' | 'soft' | 'policy' | null => (f.hard ? 'hard' : f.kind === 'policy' ? 'policy' : f.kind === 'recipient' ? 'soft' : null);

// Falhou, mas vale tentar de novo: volta para a fila, com a hora da próxima tentativa.
export async function markRetry(id: string, attempt: number, failure: SendFailure, delayMs: number): Promise<void> {
  await query(
    `update email_messages
        set status = 'queued', next_attempt_at = now() + make_interval(secs => $2::double precision), claimed_at = null,
            error_kind = $3, error_code = $4, error_detail = $5
      where id = $1 and status = 'sending'`,
    [id, delayMs / 1000, failure.kind, failure.code, failure.detail],
  );
  await addEvent(id, 'smtp', `attempt:${id}:${attempt}`, 'deferred', { attempt, kind: failure.kind, code: failure.code, retry_in_s: Math.round(delayMs / 1000) });
}

// Falhou de vez (endereço recusado, recusa por política ou tentativas esgotadas).
export async function markFailed(id: string, attempt: number, failure: SendFailure): Promise<void> {
  await query(
    `update email_messages
        set status = 'failed', next_attempt_at = null, claimed_at = null, error_kind = $2, error_code = $3, error_detail = $4, bounce_type = $5
      where id = $1 and status in ('sending', 'queued')`,
    [id, failure.kind, failure.code, failure.detail, BOUNCE_OF(failure)],
  );
  await addEvent(id, 'smtp', `attempt:${id}:${attempt}`, failure.hard || failure.kind === 'policy' ? 'rejected' : 'failed', { attempt, kind: failure.kind, code: failure.code, hard: failure.hard });
}

// Não foi enviada de propósito (endereço suprimido, sem consentimento, teto atingido...). Sem receita: nada a refazer.
export async function markBlocked(id: string, reason: string): Promise<void> {
  // Pegar a mensagem da fila contou uma tentativa; como ela nem foi tentada, a tentativa volta.
  await query(`update email_messages set status = 'blocked', block_reason = $2, spec = null, next_attempt_at = null, claimed_at = null, attempts = case when status = 'sending' then greatest(attempts - 1, 0) else attempts end where id = $1 and status in ('sending', 'queued')`, [id, reason.slice(0, 60)]);
  await addEvent(id, 'smtp', `blocked:${id}`, 'blocked', { reason });
}

export async function markCancelled(id: string, reason: string): Promise<void> {
  await query(`update email_messages set status = 'cancelled', block_reason = $2, spec = null, next_attempt_at = null, claimed_at = null, attempts = case when status = 'sending' then greatest(attempts - 1, 0) else attempts end where id = $1 and status in ('sending', 'queued')`, [id, reason.slice(0, 60)]);
  await addEvent(id, 'smtp', `cancelled:${id}`, 'cancelled', { reason });
}

// Adia uma mensagem que NÃO pôde ser tentada agora (teto diário): devolve à fila sem gastar a tentativa.
export async function deferWithoutAttempt(id: string, delayMs: number, reason: string): Promise<void> {
  await query(
    `update email_messages
        set status = 'queued', attempts = greatest(attempts - 1, 0), next_attempt_at = now() + make_interval(secs => $2::double precision), claimed_at = null,
            error_kind = null, error_code = null, error_detail = $3
      where id = $1 and status = 'sending'`,
    [id, delayMs / 1000, reason.slice(0, 300)],
  );
}

export async function claimDue(limit: number): Promise<MessageRow[]> {
  return query<MessageRow>('select * from email_claim_due($1, 300)', [limit]);
}

// Pega UMA mensagem que já está na fila (o chamador quer tentá-la agora). Null se outro trabalhador já a pegou.
export async function claimOne(id: string): Promise<MessageRow | null> {
  return one<MessageRow>(
    `update email_messages set status = 'sending', claimed_at = now(), attempts = attempts + 1, last_attempt_at = now()
      where id = $1 and status = 'queued' returning *`,
    [id],
  );
}

export async function getMessage(id: string): Promise<MessageRow | null> {
  return one<MessageRow>('select * from email_messages where id = $1', [id]);
}

// ---- Supressão -----------------------------------------------------------------------------------------

export type Suppression = { reason: 'hard_bounce' | 'complaint' | 'repeated_soft' | 'manual'; source: string };

export async function suppressionOf(email: string): Promise<Suppression | null> {
  return one<Suppression>('select reason, source from email_suppressions where email = $1 and (expires_at is null or expires_at > now())', [email]);
}

export async function suppress(email: string, reason: Suppression['reason'], source: 'smtp' | 'webhook' | 'admin', messageId: string | null, detail: string | null): Promise<void> {
  await query(
    `insert into email_suppressions (email, reason, source, message_id, detail) values ($1, $2, $3, $4, $5)
     on conflict (email) do update
       set reason = excluded.reason, source = excluded.source, message_id = excluded.message_id, detail = excluded.detail, expires_at = null
     where email_suppressions.reason = 'repeated_soft'`,
    [email, reason, source, messageId, detail ? detail.slice(0, 200) : null],
  );
}

// A pessoa provou que lê esta caixa de e-mail (digitou o código ou abriu o link que chegou nela): uma devolução ou bloqueio automático antigo
// não vale mais. Reclamação e bloqueio manual ficam (são decisões da pessoa ou do dono da loja).
export async function clearAutoSuppression(email: string): Promise<void> {
  await query(`delete from email_suppressions where email = $1 and reason in ('hard_bounce', 'repeated_soft')`, [email.toLowerCase()]);
}

export async function unsuppress(email: string): Promise<boolean> {
  const row = await one<{ email: string }>('delete from email_suppressions where email = $1 returning email', [email]);
  return Boolean(row);
}

// ---- Contagens (tetos) ---------------------------------------------------------------------------------

// Mensagens para o mesmo endereço nas últimas `hours` horas que contam para o teto (as bloqueadas e canceladas não contam).
export async function countRecent(email: string, hours: number, opts: { kinds?: string[]; excludeId?: string } = {}): Promise<number> {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from email_messages
      where recipient_email = $1 and created_at > now() - make_interval(hours => $2::integer)
        and status not in ('blocked', 'cancelled')
        and ($3::text[] is null or kind = any($3::text[]))
        and ($4::uuid is null or id <> $4::uuid)`,
    [email, hours, opts.kinds ?? null, opts.excludeId ?? null],
  );
  return row?.n ?? 0;
}

// Quantos e-mails o servidor aceitou nas últimas 24 h (e quantos estão sendo enviados agora): é o que conta para o limite do provedor.
export async function usedBudget(category?: Category): Promise<number> {
  const row = await one<{ n: number }>(
    `select count(*)::int as n from email_messages
      where ($1::text is null or category = $1)
        and ((accepted_at > now() - interval '24 hours') or (status = 'sending' and claimed_at > now() - interval '10 minutes'))`,
    [category ?? null],
  );
  return row?.n ?? 0;
}

export async function oneRow<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  return one<T>(text, params);
}

// Campanha cujas mensagens já terminaram todas (nada mais na fila) passa a "concluída".
export async function finishCampaigns(): Promise<void> {
  await query(
    `update email_campaigns c set status = 'done', finished_at = now()
      where c.status = 'sending'
        and not exists (select 1 from email_messages m where m.campaign_id = c.id and m.kind = 'campaign' and m.status in ('queued', 'sending'))`,
  );
}

// ---- Avisos do provedor (webhook): o painel mostra se estão chegando ----

export async function recordWebhook(provider: string, ok: boolean, error?: string): Promise<void> {
  await query(
    `insert into email_webhook_state (provider, last_ok_at, last_error_at, last_error, ok_count, error_count)
     values ($1, case when $2 then now() end, case when $2 then null else now() end, case when $2 then null else left($3, 200) end, case when $2 then 1 else 0 end, case when $2 then 0 else 1 end)
     on conflict (provider) do update set
       last_ok_at = case when $2 then now() else email_webhook_state.last_ok_at end,
       last_error_at = case when $2 then email_webhook_state.last_error_at else now() end,
       last_error = case when $2 then email_webhook_state.last_error else left($3, 200) end,
       ok_count = email_webhook_state.ok_count + case when $2 then 1 else 0 end,
       error_count = email_webhook_state.error_count + case when $2 then 0 else 1 end`,
    [provider, ok, error ?? null],
  );
}
