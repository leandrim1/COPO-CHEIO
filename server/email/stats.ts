// Números do painel "E-mails e Entregabilidade". Tudo sai dos registros de mensagens: nada é inventado e cada número diz o que mede.
//
// Definições (o painel mostra estas frases ao lado dos números):
//  • Aceitas pelo servidor: o servidor de e-mail respondeu "ok, recebi" no envio. NÃO significa que chegou na caixa de entrada.
//  • Falharam: o servidor recusou a mensagem de vez (endereço inexistente, política, configuração) ou as tentativas acabaram.
//  • Entregues / devolvidas / spam / abertas / clicadas: SÓ existem quando o provedor avisa (webhook). Com SMTP comum ficam em "não informado".
//  • Bloqueadas: nem foram tentadas (endereço suprimido, sem consentimento, teto por endereço, domínio inválido...).
import { one, query } from '../db.js';
import { dailyLimit, fromAddress, promoDailyLimit, sendsFromFreemail, transportName } from './config.js';
import { KINDS, isKind } from './kinds.js';
import * as ledger from './ledger.js';
import { mailStatus } from '../mail.js';
import { getTransport } from './transport.js';

type Counts = {
  total: number;
  queued: number;
  accepted: number;
  delivered: number;
  delayed: number;
  bounced: number;
  complained: number;
  failed: number;
  blocked: number;
  cancelled: number;
};

const STATUS_COLUMNS = `
  count(*)::int as total,
  count(*) filter (where status in ('queued', 'sending'))::int as queued,
  count(*) filter (where status = 'accepted')::int as accepted,
  count(*) filter (where status = 'delivered')::int as delivered,
  count(*) filter (where status = 'delayed')::int as delayed,
  count(*) filter (where status = 'bounced')::int as bounced,
  count(*) filter (where status = 'complained')::int as complained,
  count(*) filter (where status = 'failed')::int as failed,
  count(*) filter (where status = 'blocked')::int as blocked,
  count(*) filter (where status = 'cancelled')::int as cancelled`;

const ratio = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function overview(days: number) {
  const since = `now() - make_interval(days => ${Math.min(Math.max(Math.floor(days), 1), 90)})`;
  const transport = getTransport();
  const caps = transport.capabilities;

  const [totals] = await query<Counts>(`select ${STATUS_COLUMNS} from email_messages where created_at > ${since}`);
  const byCategory = await query<Counts & { category: string }>(`select category, ${STATUS_COLUMNS} from email_messages where created_at > ${since} group by category`);
  const byKindRows = await query<Counts & { kind: string }>(`select kind, ${STATUS_COLUMNS} from email_messages where created_at > ${since} group by kind order by count(*) desc`);
  const byDay = await query<{ day: string; total: number; ok: number; failed: number; blocked: number }>(
    `select to_char(d.day, 'YYYY-MM-DD') as day,
            count(m.id)::int as total,
            count(*) filter (where m.accepted_at is not null)::int as ok,
            count(*) filter (where m.status = 'failed')::int as failed,
            count(*) filter (where m.status = 'blocked')::int as blocked
       from (select (date_trunc('day', now() at time zone tz) - make_interval(days => g))::date as day, tz
               from (select coalesce((select timezone from store_settings where id = 1), 'America/Sao_Paulo') as tz) t, generate_series(0, ${Math.min(Math.max(Math.floor(days), 1), 90) - 1}) g) d
       left join email_messages m on (m.created_at at time zone d.tz)::date = d.day
      group by d.day order by d.day`,
  );
  const domains = await query<{ domain: string; total: number; failed: number; rejected: number }>(
    `select recipient_domain as domain, count(*)::int as total,
            count(*) filter (where status in ('failed', 'bounced'))::int as failed,
            count(*) filter (where bounce_type = 'hard')::int as rejected
       from email_messages where created_at > ${since} and recipient_domain is not null and status not in ('blocked', 'cancelled')
      group by recipient_domain order by count(*) desc limit 8`,
  );
  const queue = await one<{ queued: number; due: number; oldest_due_minutes: number | null; sending: number }>(
    `select count(*) filter (where status = 'queued')::int as queued,
            count(*) filter (where status = 'queued' and next_attempt_at <= now())::int as due,
            (extract(epoch from (now() - min(next_attempt_at) filter (where status = 'queued' and next_attempt_at <= now()))) / 60)::int as oldest_due_minutes,
            count(*) filter (where status = 'sending')::int as sending
       from email_messages`,
  );
  const suppressions = await query<{ reason: string; n: number }>(`select reason, count(*)::int as n from email_suppressions where expires_at is null or expires_at > now() group by reason`);
  const webhook = await one<{ provider: string; last_ok_at: string | null; last_error_at: string | null; last_error: string | null; ok_count: string; error_count: string }>(
    `select provider, last_ok_at, last_error_at, last_error, ok_count::text, error_count::text from email_webhook_state where provider = 'resend'`,
  );
  const lastEvent = await one<{ at: string | null }>(`select max(received_at) as at from email_events where provider <> 'smtp' and provider <> 'admin'`);
  const consent = await one<{ marketing: number; pending: number; unsubscribed: number }>(
    `select count(*) filter (where marketing)::int as marketing,
            count(*) filter (where marketing_pending_at is not null and not marketing)::int as pending,
            count(*) filter (where marketing_unsubscribed_at is not null and not marketing)::int as unsubscribed
       from email_preferences`,
  );

  const status = mailStatus();
  const from = fromAddress();
  const limit = dailyLimit();
  const attempted = totals.accepted + totals.delivered + totals.delayed + totals.bounced + totals.complained + totals.failed;
  const okCount = totals.accepted + totals.delivered + totals.delayed + totals.bounced + totals.complained;
  const providerFinal = totals.delivered + totals.bounced + totals.complained;

  return {
    generated_at: new Date().toISOString(),
    period_days: days,
    transport: {
      name: transportName(),
      label: transport.name === 'resend' ? 'Resend (API)' : 'SMTP',
      capabilities: caps,
      configured: transport.name === 'resend' ? Boolean((process.env.RESEND_API_KEY ?? '').trim()) && status.configured : status.configured,
      missing: status.missing,
      host: status.host,
      from_name: from?.display || null,
      from_email: from?.email ?? null,
      from_domain: from?.domain ?? null,
      free_sender: sendsFromFreemail(),
    },
    totals,
    by_category: Object.fromEntries(byCategory.map(({ category, ...rest }) => [category, rest])),
    by_kind: byKindRows.map(({ kind, ...rest }) => ({ kind, label: isKind(kind) ? KINDS[kind].label : kind, category: isKind(kind) ? KINDS[kind].category : null, ...rest })),
    by_day: byDay,
    top_domains: domains,
    rates: {
      // Das mensagens que o servidor respondeu (aceitou ou recusou de vez), quantas aceitou.
      accepted_percent: ratio(okCount, attempted),
      // Só com aviso do provedor: das mensagens com desfecho conhecido, quantas foram entregues.
      delivered_percent: caps.delivery ? ratio(totals.delivered, providerFinal) : null,
      bounced_percent: caps.bounces ? ratio(totals.bounced, okCount) : null,
      complaint_percent: caps.complaints ? (okCount > 0 ? Math.round((totals.complained / okCount) * 10000) / 100 : null) : null,
    },
    budget: { limit, used: limit > 0 ? await ledger.usedBudget() : null, promo_limit: promoDailyLimit(), promo_used: await ledger.usedBudget('promotional') },
    queue: queue ?? { queued: 0, due: 0, oldest_due_minutes: null, sending: 0 },
    suppressions: Object.fromEntries(suppressions.map((s) => [s.reason, s.n])),
    consent: consent ?? { marketing: 0, pending: 0, unsubscribed: 0 },
    webhook: {
      // O aviso do provedor só faz sentido com o transporte que avisa.
      applicable: caps.delivery,
      configured: transportName() === 'resend' && Boolean((process.env.RESEND_WEBHOOK_SECRET ?? '').trim()),
      last_ok_at: webhook?.last_ok_at ?? null,
      last_error_at: webhook?.last_error_at ?? null,
      last_error: webhook?.last_error ?? null,
      ok_count: Number(webhook?.ok_count ?? 0),
      error_count: Number(webhook?.error_count ?? 0),
      last_event_at: lastEvent?.at ?? null,
    },
  };
}
