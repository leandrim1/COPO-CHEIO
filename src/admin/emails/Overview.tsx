import { CheckCircle2, CircleSlash, Info, Play, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, friendlyError } from '../../lib/api';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { EmailAlert, EmailOverview } from '../../lib/types';
import { useAdmin } from '../AdminApp';
import { Badge, Button, Card, cx, useToast } from '../ui';
import { ALERT_LABEL, ALERT_TONE, SUPPRESSION_REASON } from './labels';

const n = (value: number | null | undefined) => (value ?? 0).toLocaleString('pt-BR');
const pct = (value: number | null, digits = 1) => (value === null ? '—' : `${value.toLocaleString('pt-BR', { maximumFractionDigits: digits })}%`);

function Stat({ label, value, help, tone = 'white' }: { label: string; value: string; help: string; tone?: 'white' | 'green' | 'red' | 'amber' | 'muted' }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4" title={help}>
      <p className="text-[12px] font-semibold text-white/60">{label}</p>
      <p className={cx('mt-1 font-black tabular-nums', tone === 'muted' ? 'text-lg' : 'text-2xl', tone === 'green' && 'text-emerald-300', tone === 'red' && 'text-rose-300', tone === 'amber' && 'text-amber-200', tone === 'muted' && 'text-white/40', tone === 'white' && 'text-white')}>{value}</p>
      <p className="mt-1 text-[11px] leading-snug text-white/50">{help}</p>
    </div>
  );
}

function AlertItem({ alert }: { alert: EmailAlert }) {
  const tone = ALERT_TONE[alert.severity];
  const Icon = alert.severity === 'info' ? Info : alert.severity === 'critical' ? ShieldAlert : TriangleAlert;
  return (
    <li
      className={cx(
        'rounded-2xl border p-4',
        alert.severity === 'critical' ? 'border-rose-500/35 bg-rose-500/[0.08]' : alert.severity === 'warning' ? 'border-amber-400/30 bg-amber-400/[0.07]' : 'border-[#145CFF]/30 bg-[#145CFF]/[0.07]',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <Icon className={cx('mt-0.5 h-5 w-5 shrink-0', alert.severity === 'critical' ? 'text-rose-300' : alert.severity === 'warning' ? 'text-amber-200' : 'text-[#8FB1FF]')} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-bold text-white">
            {alert.title}
            <Badge tone={tone}>{ALERT_LABEL[alert.severity]}</Badge>
          </p>
          <p className="mt-1 text-sm text-white/80">{alert.detail}</p>
          <p className="mt-1.5 text-sm text-white/65">
            <span className="font-semibold text-white/80">O que fazer: </span>
            {alert.hint}
          </p>
          <p className="mt-1.5 text-[11px] text-white/50">Aberto {timeAgo(alert.opened_at)}.</p>
        </div>
      </div>
    </li>
  );
}

function Capability({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2.5 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" /> : <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-white/40" aria-hidden="true" />}
      <span className="min-w-0">
        <span className={cx('font-semibold', ok ? 'text-white' : 'text-white/60')}>
          {label}
          <span className="sr-only">{ok ? ' (informado)' : ' (não informado)'}</span>
        </span>
        <span className="block text-xs text-white/55">{detail}</span>
      </span>
    </li>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold text-white/80">{label}</span>
        <span className="tabular-nums text-white/65">
          {n(used)} de {n(limit)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
        <div className={cx('h-full rounded-full', percent >= 100 ? 'bg-rose-400' : percent >= 80 ? 'bg-amber-300' : 'bg-[#2563FF]')} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function DailyChart({ days }: { days: EmailOverview['by_day'] }) {
  const max = Math.max(1, ...days.map((d) => d.total));
  const short = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return (
    <div>
      <div className="flex h-40 items-end gap-1 sm:gap-1.5" role="img" aria-label={`Mensagens por dia nos últimos ${days.length} dias`}>
        {days.map((d) => {
          const height = (d.total / max) * 100;
          const part = (value: number) => (d.total ? `${(value / d.total) * 100}%` : '0%');
          return (
            <div key={d.day} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={`${short(d.day)}: ${d.ok} aceitas, ${d.failed} falhas, ${d.blocked} bloqueadas`}>
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-t-md bg-white/[0.04]" style={{ height: `${Math.max(height, d.total ? 4 : 1)}%` }}>
                <div className="bg-emerald-400/80" style={{ height: part(d.ok) }} />
                <div className="bg-rose-400/85" style={{ height: part(d.failed) }} />
                <div className="bg-amber-300/80" style={{ height: part(d.blocked) }} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-1 sm:gap-1.5 text-[10px] text-white/50" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 truncate text-center">
            {days.length <= 14 || i % Math.ceil(days.length / 10) === 0 ? short(d.day) : ''}
          </span>
        ))}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/60">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-emerald-400/80" aria-hidden="true" />aceitas pelo servidor</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-rose-400/85" aria-hidden="true" />falharam</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-300/80" aria-hidden="true" />bloqueadas</span>
      </p>
      <table className="sr-only">
        <caption>Mensagens por dia</caption>
        <thead>
          <tr><th>Dia</th><th>Aceitas</th><th>Falharam</th><th>Bloqueadas</th></tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day}><td>{short(d.day)}</td><td>{d.ok}</td><td>{d.failed}</td><td>{d.blocked}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function OverviewTab({
  data,
  days,
  setDays,
  loading,
  onRefresh,
  goTo,
}: {
  data: EmailOverview;
  days: number;
  setDays: (days: number) => void;
  loading: boolean;
  onRefresh: () => void;
  goTo: (tab: 'mensagens' | 'supressoes' | 'autenticacao') => void;
}) {
  const { user } = useAdmin();
  const toast = useToast();
  const [processing, setProcessing] = useState(false);
  const t = data.totals;
  const caps = data.transport.capabilities;
  const accepted = t.accepted + t.delivered + t.delayed + t.bounced + t.complained;
  const alerts = data.alerts;
  const urgent = alerts.filter((a) => a.severity !== 'info');

  const processQueue = async () => {
    setProcessing(true);
    try {
      const r = await api.post<{ processed: number; accepted: number; retried: number; failed: number; blocked: number; cancelled: number }>('/api/admin/emails/process', {});
      toast.success(
        r.processed ? `${r.processed} mensagem(ns) processada(s).` : 'Nada para processar agora.',
        r.processed ? `${r.accepted} aceita(s), ${r.retried} voltaram para a fila, ${r.failed} falharam, ${r.blocked} bloqueada(s), ${r.cancelled} cancelada(s).` : 'Só entram aqui as mensagens cuja hora de enviar (ou de tentar de novo) já chegou.',
      );
      onRefresh();
    } catch (err) {
      toast.error('Não foi possível processar a fila.', friendlyError(err, ''));
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor="email-period" className="text-sm font-semibold text-white/70">
            Período
          </label>
          <select id="email-period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-xl border border-white/[0.12] bg-[#07090E] px-3 py-2 text-sm text-white focus:border-[#2563FF] focus:outline-none">
            <option value={1}>Hoje</option>
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
          </select>
        </div>
        <Button size="sm" variant="secondary" loading={loading} icon={<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={onRefresh}>
          Atualizar
        </Button>
      </div>

      {/* Alertas */}
      {alerts.length === 0 ? (
        <div className="flex items-start gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/[0.07] p-4 text-sm text-emerald-100">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <p>
            <span className="font-bold">Nenhum alerta aberto.</span> O sistema confere falhas, fila parada, teto diário
            {caps.complaints ? ', devoluções e reclamações de spam' : ''} e avisa os donos por e-mail quando algo precisa de atenção.
          </p>
        </div>
      ) : (
        <section aria-label="Alertas">
          <h2 className="mb-2 text-sm font-bold text-white/80">
            {urgent.length ? `${urgent.length} alerta(s) pedindo atenção` : 'Informações'}
          </h2>
          <ul className="space-y-2.5">
            {alerts.map((a) => (
              <AlertItem key={a.code} alert={a} />
            ))}
          </ul>
        </section>
      )}

      {/* Como os e-mails saem e o que dá para saber */}
      <Card
        title={`Como os e-mails saem: ${data.transport.label}`}
        description={
          data.transport.configured
            ? `Remetente: ${data.transport.from_name ? `${data.transport.from_name} ` : ''}<${data.transport.from_email ?? '—'}>${data.transport.host ? ` · servidor ${data.transport.host}` : ''}`
            : `Não configurado. Faltam: ${data.transport.missing.join(', ') || '—'}.`
        }
      >
        <ul className="grid gap-3 sm:grid-cols-2">
          <Capability ok={caps.acceptance} label="Aceito pelo servidor" detail="O servidor de e-mail confirma que recebeu a mensagem (ou a recusa na hora)." />
          <Capability ok={caps.delivery} label="Entregue na caixa do destinatário" detail={caps.delivery ? 'Informado pelo provedor por aviso assinado (webhook).' : 'Não informado: o SMTP comum não avisa a entrega.'} />
          <Capability ok={caps.bounces} label="Devolvido depois (endereço ruim)" detail={caps.bounces ? 'Informado pelo provedor.' : 'Não informado. Só vemos as recusas que o servidor faz na hora do envio.'} />
          <Capability ok={caps.complaints} label="Marcado como spam pelo destinatário" detail={caps.complaints ? 'Informado pelo provedor.' : 'Não informado. Não há como saber quem marcou como spam.'} />
          <Capability ok={caps.opens} label="Aberto" detail="Não medimos aberturas: o pixel de rastreio pioraria a reputação e a privacidade, e os provedores de caixa de entrada já escondem esse dado." />
          <Capability ok={caps.clicks} label="Clique em links" detail="Não medimos cliques: os links do e-mail vão direto ao site, sem redirecionador." />
        </ul>
        <p className="mt-4 rounded-xl bg-white/[0.04] p-3 text-xs leading-relaxed text-white/65">
          <span className="font-semibold text-white/80">Importante:</span> “aceito pelo servidor” <strong>não</strong> é “chegou na caixa de entrada”. Nenhum sistema consegue dizer em qual pasta (Entrada, Promoções ou Spam) o e-mail caiu; isso só se confere abrindo uma mensagem real no Gmail e no Outlook (veja a aba Autenticação).
        </p>
        {data.transport.order_notices_paused && (
          <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
            Os e-mails de <strong>pedido e pagamento estão pausados</strong> (<code>EMAIL_ORDER_NOTICES=off</code> na Vercel): nada novo sai, e cada um aparece em Mensagens como “bloqueado”. Para voltar, apague a variável (ou troque o valor) e faça um novo deploy. Códigos de confirmação, nova senha e promoções não são afetados.
          </p>
        )}
        {data.transport.free_sender && (
          <p className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-3 text-xs leading-relaxed text-amber-100">
            O remetente é um e-mail gratuito (<code>@{data.transport.from_domain}</code>). Não existe domínio da loja para autenticar com SPF, DKIM e DMARC.{' '}
            <button type="button" className="font-bold underline" onClick={() => goTo('autenticacao')}>
              Veja como melhorar
            </button>
            .
          </p>
        )}
      </Card>

      {/* Números */}
      <section aria-label="Números do período" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Mensagens no período" value={n(t.total)} help="Tudo o que o sistema tentou ou decidiu enviar." />
        <Stat label="Aceitas pelo servidor" value={n(accepted)} tone="green" help="O servidor de e-mail recebeu. Não garante caixa de entrada." />
        <Stat label="Falharam" value={n(t.failed)} tone={t.failed ? 'red' : 'white'} help="Recusadas de vez pelo servidor ou sem mais tentativas." />
        <Stat label="Bloqueadas (não enviadas)" value={n(t.blocked)} tone={t.blocked ? 'amber' : 'white'} help="Barradas por regra de proteção: lista de supressão, sem consentimento, teto por endereço..." />
        <Stat label="Taxa de aceitação" value={pct(data.rates.accepted_percent)} help="Das mensagens que o servidor respondeu, quantas ele aceitou." />
        <Stat label="Na fila" value={n(t.queued)} help="Esperando enviar ou tentar de novo." />
        <Stat label="Canceladas" value={n(t.cancelled)} help="Deixaram de fazer sentido (pedido avançou, campanha cancelada)." />
        {caps.delivery ? (
          <Stat label="Taxa de entrega (provedor)" value={pct(data.rates.delivered_percent)} tone="green" help="Entregues ÷ (entregues + devolvidas + spam), segundo o aviso do provedor." />
        ) : (
          <Stat label="Entregues" value="Não informado" tone="muted" help="O SMTP comum não avisa a entrega. Não inventamos esse número." />
        )}
        {caps.bounces ? (
          <>
            <Stat label="Devolvidas" value={`${n(t.bounced)} (${pct(data.rates.bounced_percent)})`} tone={t.bounced ? 'red' : 'white'} help="Recusadas pelo servidor do destinatário depois de aceitas." />
            <Stat label="Marcadas como spam" value={`${n(t.complained)} (${pct(data.rates.complaint_percent, 2)})`} tone={t.complained ? 'red' : 'white'} help="O Gmail pede ficar abaixo de 0,10% e nunca passar de 0,30%." />
          </>
        ) : (
          <>
            <Stat label="Devolvidas depois" value="Não informado" tone="muted" help="Sem aviso do provedor. As recusas na hora do envio aparecem em “Falharam”." />
            <Stat label="Marcadas como spam" value="Não informado" tone="muted" help="Sem aviso do provedor, não há como saber." />
          </>
        )}
      </section>

      <Card title="Mensagens por dia" description="Barras: aceitas pelo servidor, falhas e bloqueadas.">
        <DailyChart days={data.by_day} />
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Fila e limite diário">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-white/75">
                <span className="font-bold text-white">{n(data.queue.queued)}</span> na fila
                {data.queue.due > 0 && (
                  <>
                    , <span className="font-bold text-white">{n(data.queue.due)}</span> pronta(s) para enviar agora
                    {data.queue.oldest_due_minutes !== null && data.queue.oldest_due_minutes >= 1 ? ` (a mais antiga espera há ${n(data.queue.oldest_due_minutes)} min)` : ''}
                  </>
                )}
                .
              </p>
              {user.role === 'owner' && (
                <Button size="sm" icon={<Play className="h-3.5 w-3.5" aria-hidden="true" />} loading={processing} onClick={() => void processQueue()}>
                  Processar fila agora
                </Button>
              )}
            </div>
            {data.budget.limit > 0 && data.budget.used !== null ? <Meter label="Teto diário de envio (24 h)" used={data.budget.used} limit={data.budget.limit} /> : <p className="text-xs text-white/60">Sem teto diário configurado (EMAIL_DAILY_LIMIT). Com Gmail, o teto padrão é 450 por dia.</p>}
            <Meter label="Promoções hoje (24 h)" used={data.budget.promo_used} limit={data.budget.promo_limit} />
            <p className="text-xs text-white/55">Códigos de login e avisos importantes não esperam: só promoções e avisos de pedido ficam na fila quando o teto enche. A fila anda sozinha enquanto o painel está aberto, a cada pedido e uma vez por dia.</p>
          </div>
        </Card>

        <Card title="Avisos do provedor (webhook)">
          {data.webhook.applicable ? (
            <div className="space-y-2 text-sm text-white/75">
              <p>
                Rota: <code className="rounded bg-white/[0.06] px-1.5 py-0.5 text-xs">/api/email/webhook/resend</code> · {data.webhook.configured ? <Badge tone="green">Segredo configurado</Badge> : <Badge tone="red">Falta RESEND_WEBHOOK_SECRET</Badge>}
              </p>
              <p>Último aviso aceito: {data.webhook.last_ok_at ? `${formatDateTime(data.webhook.last_ok_at)} (${timeAgo(data.webhook.last_ok_at)})` : 'nenhum ainda'}.</p>
              <p>
                Recebidos: <span className="font-bold text-white">{n(data.webhook.ok_count)}</span> · recusados (assinatura inválida, corpo estranho): <span className={cx('font-bold', data.webhook.error_count ? 'text-amber-200' : 'text-white')}>{n(data.webhook.error_count)}</span>
              </p>
              {data.webhook.last_error && (
                <p className="text-xs text-white/60">
                  Último problema ({data.webhook.last_error_at ? timeAgo(data.webhook.last_error_at) : ''}): {data.webhook.last_error}
                </p>
              )}
              <p className="text-xs text-white/55">Todo aviso precisa vir assinado pelo provedor e ser recente; o que não confere é descartado sem ler.</p>
            </div>
          ) : (
            <p className="text-sm text-white/65">
              Não se aplica: o SMTP comum não envia avisos de entrega, devolução ou spam. Para receber esses avisos é preciso um provedor de e-mail transacional (o sistema já tem suporte opcional à Resend; veja a aba Autenticação → “Como melhorar”).
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Por tipo de e-mail" description="Quanto de cada tipo saiu no período.">
          {data.by_kind.length === 0 ? (
            <p className="text-sm text-white/60">Nenhuma mensagem no período.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {data.by_kind.map((k) => (
                <li key={k.kind} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0 text-white/85">
                    {k.label}
                    {k.category === 'promotional' && <Badge tone="violet" className="ml-2">Promoção</Badge>}
                  </span>
                  <span className="tabular-nums text-xs text-white/65">
                    {n(k.total)} no total
                    {k.failed ? <span className="text-rose-300"> · {n(k.failed)} falha(s)</span> : null}
                    {k.blocked ? <span className="text-amber-200"> · {n(k.blocked)} bloqueada(s)</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Principais domínios de destino" description="Onde mais se perdem mensagens costuma aparecer aqui primeiro.">
          {data.top_domains.length === 0 ? (
            <p className="text-sm text-white/60">Nenhuma mensagem no período.</p>
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {data.top_domains.map((d) => (
                <li key={d.domain} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0 truncate text-white/85">{d.domain}</span>
                  <span className="shrink-0 tabular-nums text-xs text-white/65">
                    {n(d.total)}
                    {d.failed ? <span className="text-rose-300"> · {n(d.failed)} com problema</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card
          title="Lista de supressão"
          description="Endereços que não recebem mais nada."
          actions={
            <Button size="sm" variant="ghost" onClick={() => goTo('supressoes')}>
              Ver lista
            </Button>
          }
        >
          {Object.keys(data.suppressions).length === 0 ? (
            <p className="text-sm text-white/60">Nenhum endereço suprimido.</p>
          ) : (
            <ul className="space-y-1.5 text-sm text-white/75">
              {Object.entries(data.suppressions).map(([reason, count]) => (
                <li key={reason} className="flex justify-between gap-3">
                  <span>{SUPPRESSION_REASON[reason] ?? reason}</span>
                  <span className="font-bold tabular-nums text-white">{n(count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Consentimento para promoções" description="Promoções só vão para quem aceitou e confirmou o e-mail.">
          <ul className="space-y-1.5 text-sm text-white/75">
            <li className="flex justify-between gap-3"><span>Aceitaram receber</span><span className="font-bold tabular-nums text-white">{n(data.consent.marketing)}</span></li>
            <li className="flex justify-between gap-3"><span>Marcaram no cadastro, esperando confirmar o e-mail</span><span className="font-bold tabular-nums text-white">{n(data.consent.pending)}</span></li>
            <li className="flex justify-between gap-3"><span>Já cancelaram a inscrição</span><span className="font-bold tabular-nums text-white">{n(data.consent.unsubscribed)}</span></li>
          </ul>
          <p className="mt-3 text-xs text-white/55">E-mails de conta e de pedido (código, nova senha, status do pedido) são transacionais e não dependem desse consentimento.</p>
        </Card>
      </div>

      <p className="text-center text-[11px] text-white/45">
        Atualizado {timeAgo(data.generated_at)} · <button type="button" className="underline" onClick={() => goTo('mensagens')}>ver o histórico de mensagens</button>
      </p>
    </div>
  );
}
