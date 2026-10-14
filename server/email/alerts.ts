// Alertas de entregabilidade: olha os números dos registros de e-mail, abre e fecha alertas (tabela email_alerts, um por código) e avisa
// os donos da loja por e-mail UMA vez por alerta (e de novo só depois de 24 h, se o problema continuar).
//
// Só entram aqui números que o sistema realmente sabe. Com SMTP puro não há "entregue", "devolvida" nem "spam": esses alertas só existem
// quando o transporte avisa (hoje, o opcional Resend). Os limites seguem as regras públicas de Gmail/Yahoo (reclamação abaixo de 0,10%,
// nunca acima de 0,30%) e a boa prática de manter devoluções definitivas abaixo de 2%.
import { query } from '../db.js';
import { dailyLimit, sendsFromFreemail, transportName } from './config.js';
import type { AlertSeverity } from './alertText.js';
import { deliver, kickQueue } from './service.js';
import { getTransport } from './transport.js';
import * as ledger from './ledger.js';

export type Active = { code: string; severity: AlertSeverity; detail: Record<string, unknown> };

type Numbers = {
  total_24h: number;
  failed_24h: number;
  system_failed_24h: number;
  total_7d: number;
  rejected_7d: number;
  policy_7d: number;
  stuck: number;
  auth_error_at: string | null;
  last_accepted_at: string | null;
  accepted_30d: number;
  complaints_30d: number;
  hard_bounces_30d: number;
  provider_accepted_24h: number;
  provider_events_24h: number;
};

export async function readNumbers(): Promise<Numbers> {
  const rows = await query<Numbers>(
    `select
       count(*) filter (where created_at > now() - interval '24 hours' and status in ('accepted','delivered','delayed','bounced','complained','failed'))::int as total_24h,
       count(*) filter (where created_at > now() - interval '24 hours' and status = 'failed')::int as failed_24h,
       count(*) filter (where created_at > now() - interval '24 hours' and status = 'failed' and coalesce(error_kind, 'other') not in ('recipient', 'policy', 'render'))::int as system_failed_24h,
       count(*) filter (where created_at > now() - interval '7 days' and status in ('accepted','delivered','delayed','bounced','complained','failed'))::int as total_7d,
       count(*) filter (where created_at > now() - interval '7 days' and status = 'failed' and bounce_type = 'hard')::int as rejected_7d,
       count(*) filter (where created_at > now() - interval '7 days' and error_kind = 'policy' and status = 'failed')::int as policy_7d,
       count(*) filter (where status = 'queued' and next_attempt_at < now() - interval '30 minutes')::int as stuck,
       max(last_attempt_at) filter (where error_kind in ('auth', 'config') and last_attempt_at > now() - interval '24 hours') as auth_error_at,
       max(accepted_at) as last_accepted_at,
       count(*) filter (where accepted_at > now() - interval '30 days')::int as accepted_30d,
       count(*) filter (where complained_at > now() - interval '30 days')::int as complaints_30d,
       count(*) filter (where bounced_at > now() - interval '30 days' and bounce_type = 'hard')::int as hard_bounces_30d,
       count(*) filter (where transport = 'resend' and accepted_at > now() - interval '24 hours')::int as provider_accepted_24h,
       (select count(*)::int from email_events e where e.provider <> 'smtp' and e.provider <> 'admin' and e.received_at > now() - interval '24 hours') as provider_events_24h
     from email_messages`,
  );
  return rows[0];
}

const pct = (a: number, b: number): number => (b > 0 ? (a / b) * 100 : 0);
const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

// Regras puras (testadas sem banco): números → alertas ativos.
export function decideAlerts(n: Numbers, ctx: { dailyLimit: number; usedBudget: number; freeSender: boolean; transportDelivery: boolean; webhookConfigured: boolean; transport?: string }): Active[] {
  const out: Active[] = [];
  // Usuário/senha do servidor de e-mail recusados e nenhuma mensagem aceita depois disso.
  if (n.auth_error_at && (!n.last_accepted_at || new Date(n.auth_error_at) > new Date(n.last_accepted_at))) out.push({ code: 'smtp_auth', severity: 'critical', detail: { transport: ctx.transport ?? 'smtp' } });

  const failPct = pct(n.system_failed_24h, n.total_24h);
  if (n.total_24h >= 10 && failPct >= 20) out.push({ code: 'send_failures', severity: failPct >= 50 ? 'critical' : 'warning', detail: { failed: n.system_failed_24h, total: n.total_24h, percent: round(failPct) } });

  const rejectedPct = pct(n.rejected_7d, n.total_7d);
  if (n.rejected_7d >= 3 && rejectedPct > 2) out.push({ code: 'hard_rejections', severity: rejectedPct >= 10 ? 'critical' : 'warning', detail: { rejected: n.rejected_7d, percent: round(rejectedPct) } });

  if (n.policy_7d >= 2) out.push({ code: 'policy_blocks', severity: n.policy_7d >= 10 ? 'critical' : 'warning', detail: { count: n.policy_7d } });

  if (n.stuck >= 1) out.push({ code: 'queue_backlog', severity: 'warning', detail: { count: n.stuck } });

  if (ctx.dailyLimit > 0) {
    const used = pct(ctx.usedBudget, ctx.dailyLimit);
    if (used >= 80) out.push({ code: 'daily_limit', severity: used >= 100 ? 'critical' : 'warning', detail: { used: ctx.usedBudget, limit: ctx.dailyLimit, percent: Math.round(used), reached: used >= 100 } });
  }

  // Só existem quando o transporte AVISA entrega/devolução/reclamação.
  if (ctx.transportDelivery) {
    const complaintPct = pct(n.complaints_30d, n.accepted_30d);
    if (n.complaints_30d >= 1 && complaintPct >= 0.1) out.push({ code: 'complaints', severity: complaintPct >= 0.3 ? 'critical' : 'warning', detail: { count: n.complaints_30d, percent: round(complaintPct, 2) } });
    const bouncePct = pct(n.hard_bounces_30d, n.accepted_30d);
    if (n.hard_bounces_30d >= 3 && bouncePct > 2) out.push({ code: 'hard_bounces', severity: bouncePct >= 5 ? 'critical' : 'warning', detail: { count: n.hard_bounces_30d, percent: round(bouncePct) } });
    if (ctx.webhookConfigured && n.provider_accepted_24h >= 5 && n.provider_events_24h === 0) out.push({ code: 'no_events', severity: 'warning', detail: {} });
  }

  if (ctx.freeSender) out.push({ code: 'free_sender', severity: 'info', detail: {} });
  return out;
}

export async function activeAlerts(): Promise<Active[]> {
  const n = await readNumbers();
  return decideAlerts(n, {
    dailyLimit: dailyLimit(),
    usedBudget: dailyLimit() > 0 ? await ledger.usedBudget() : 0,
    freeSender: sendsFromFreemail(),
    transportDelivery: getTransport().capabilities.delivery,
    transport: transportName(),
    webhookConfigured: transportName() === 'resend' && Boolean((process.env.RESEND_WEBHOOK_SECRET ?? '').trim()),
  });
}

export type AlertRow = { code: string; severity: AlertSeverity; opened_at: string; last_seen_at: string; detail: Record<string, unknown> | null };

// Grava o que está ativo (abre, atualiza ou reabre) e fecha o que deixou de valer. Devolve os alertas abertos agora.
export async function syncAlerts(active: Active[]): Promise<AlertRow[]> {
  const codes = active.map((a) => a.code);
  await query(`update email_alerts set resolved_at = now() where resolved_at is null and not (code = any($1::text[]))`, [codes]);
  for (const a of active) {
    await query(
      `insert into email_alerts (code, severity, detail) values ($1, $2, $3::jsonb)
       on conflict (code) do update set
         severity = excluded.severity, detail = excluded.detail, last_seen_at = now(),
         opened_at = case when email_alerts.resolved_at is null then email_alerts.opened_at else now() end,
         last_notified_at = case when email_alerts.resolved_at is null then email_alerts.last_notified_at else null end,
         resolved_at = null`,
      [a.code, a.severity, JSON.stringify(a.detail)],
    );
  }
  return query<AlertRow>(`select code, severity, opened_at, last_seen_at, detail from email_alerts where resolved_at is null order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, opened_at`);
}

// Avisa os donos (por e-mail) dos alertas que valem um aviso: gravidade "atenção" ou "crítico", nunca avisados ou avisados há mais de 24 h.
export async function notifyOwners(req: Request): Promise<number> {
  const due = await query<{ code: string }>(
    `select code from email_alerts
      where resolved_at is null and severity in ('warning', 'critical') and (last_notified_at is null or last_notified_at < now() - interval '24 hours')
      order by code`,
  );
  if (!due.length) return 0;
  const codes = due.map((d) => d.code);
  // Duas instâncias que avaliam ao mesmo tempo geram a MESMA chave: só um aviso por dono, por conjunto de alertas, por dia.
  const day = Math.floor(Date.now() / 86_400_000);
  const owners = await query<{ email: string; name: string }>(`select email, name from admins where role = 'owner' and active`);
  let queued = 0;
  for (const owner of owners) {
    const result = await deliver({ kind: 'deliverability_alert', to: owner.email, spec: { codes, name: owner.name }, req, attempt: 'later', dedupeKey: `alert:${owner.email.toLowerCase()}:${codes.join(',')}:${day}` });
    if (result.status === 'queued') queued += 1;
  }
  if (queued) {
    await query(`update email_alerts set last_notified_at = now() where code = any($1::text[])`, [codes]);
    kickQueue(req);
  }
  return queued;
}

let lastRun = 0;
// Avalia, grava e avisa. `force`: ignora o intervalo mínimo de 10 minutos entre avaliações nesta instância.
export async function runAlerts(req: Request, opts: { force?: boolean } = {}): Promise<AlertRow[]> {
  if (!opts.force && Date.now() - lastRun < 10 * 60_000) return [];
  lastRun = Date.now();
  const rows = await syncAlerts(await activeAlerts());
  await notifyOwners(req).catch(() => 0);
  return rows;
}
