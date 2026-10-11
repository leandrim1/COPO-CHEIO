import { Landmark, TriangleAlert, Wallet } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import type { MerchantAccount, PaymentState, PaymentsOverview } from '../lib/types';
import { useAdmin, useLiveOrders } from './AdminApp';
import { CommissionBadge, PAYMENT_STATE_LABEL, PaymentActions, PaymentStateBadge, cents, when } from './OnlinePayment';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, PageHeader, Skeleton, Switch, cx, useToast } from './ui';

// Pagamentos online (só o owner): a operadora, a conta do estabelecimento, as cobranças e a comissão.
// A comissão só aparece como "efetivada" quando a operadora confirmou o valor repassado; o resto é conta feita pela loja.

const MERCHANT_LABEL: Record<MerchantAccount['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'gray' }> = {
  approved: { label: 'Aprovada', tone: 'green' },
  pending: { label: 'Aguardando aprovação', tone: 'amber' },
  submitted: { label: 'Cadastro enviado', tone: 'amber' },
  draft: { label: 'Rascunho', tone: 'gray' },
  rejected: { label: 'Recusada', tone: 'red' },
  duplicate: { label: 'Cadastro duplicado', tone: 'red' },
  error: { label: 'Erro no cadastro', tone: 'red' },
  suspended: { label: 'Suspensa', tone: 'red' },
};

function Stat({ label, value, hint, tone = 'text-white' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4">
      <p className="text-xs font-semibold text-white/55">{label}</p>
      <p className={cx('mt-1 text-xl font-black tabular-nums', tone)}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-white/45">{hint}</p>}
    </div>
  );
}

const FILTERS: ('all' | PaymentState)[] = ['all', 'pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded'];

export default function PaymentsPage() {
  const { user } = useAdmin();
  const { version } = useLiveOrders();
  const toast = useToast();
  const [data, setData] = useState<PaymentsOverview | null>(null);
  const [error, setError] = useState(false);
  const [status, setStatus] = useState<'all' | PaymentState>('all');
  const [attention, setAttention] = useState(false);
  const [busy, setBusy] = useState<'sweep' | 'method' | null>(null);
  const owner = user.role === 'owner';

  const load = useCallback(async () => {
    if (!owner) return;
    const params = new URLSearchParams({ limit: '50' });
    if (status !== 'all') params.set('status', status);
    if (attention) params.set('attention', '1');
    try {
      setData(await api.get<PaymentsOverview>(`/api/admin/payments?${params}`));
      setError(false);
    } catch {
      setError(true);
    }
  }, [owner, status, attention]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!owner) {
    return (
      <>
        <PageHeader title="Pagamentos online" />
        <Card>
          <EmptyState icon={<Wallet className="h-6 w-6" aria-hidden="true" />} title="Só o dono da loja vê esta página" description="Peça ao owner para conferir os pagamentos online." />
        </Card>
      </>
    );
  }

  const sweep = async () => {
    setBusy('sweep');
    try {
      const r = await api.post<{ checked: number; closed: number; cancelled: number }>('/api/admin/payments/sweep');
      toast.success('Pagamentos conferidos.', `${r.checked} consultado(s), ${r.closed} encerrado(s), ${r.cancelled} pedido(s) cancelado(s) por falta de pagamento.`);
      await load();
    } catch (e) {
      toast.error('Não foi possível conferir agora.', friendlyError(e, ''));
    } finally {
      setBusy(null);
    }
  };

  const toggleMethod = async (on: boolean) => {
    setBusy('method');
    try {
      await api.patch('/api/admin/payments/pix_online', { enabled: on });
      toast.success(on ? 'Pix online ligado.' : 'Pix online desligado.', on ? 'O cliente já pode escolher pagar pelo site.' : 'O site deixou de oferecer essa opção.');
      await load();
    } catch (e) {
      toast.error('Não foi possível alterar.', friendlyError(e, ''));
    } finally {
      setBusy(null);
    }
  };

  const s = data?.summary;
  const merchant = data?.merchant;
  const ready = data?.readiness.ready ?? false;
  const enabled = data?.method?.enabled ?? false;

  return (
    <>
      <PageHeader
        title="Pagamentos online"
        description="Pix pelo site: o cliente paga e a operadora de pagamento confirma. Aqui você acompanha as cobranças e a comissão."
        actions={
          <Button variant="secondary" loading={busy === 'sweep'} icon={<Landmark className="h-4 w-4" aria-hidden="true" />} onClick={() => void sweep()}>
            Conferir agora
          </Button>
        }
      />

      {error && !data ? (
        <Card>
          <ErrorState message="Não foi possível carregar os pagamentos." onRetry={() => void load()} />
        </Card>
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : (
        <>
          <Card title="Operadora e conta" description="O Pix online só pode ser ligado com uma operadora conectada e uma conta do estabelecimento aprovada por ela.">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[14rem_1fr]">
              <dt className="font-semibold text-white/60">Operadora de pagamento</dt>
              <dd data-provider={data.provider.configured ? 'on' : 'off'} className="text-white">
                {data.provider.configured ? (
                  <>
                    <Badge tone="green">Conectada</Badge> <span className="ml-1 text-white/70">{data.provider.name}</span>
                  </>
                ) : (
                  <>
                    <Badge tone="gray">Não conectada</Badge>
                    <span className="ml-2 text-white/60">Nenhuma operadora está conectada a este site ainda.</span>
                  </>
                )}
              </dd>
              <dt className="font-semibold text-white/60">Conta do estabelecimento</dt>
              <dd data-merchant={merchant?.status ?? 'none'} className="text-white">
                {merchant ? (
                  <>
                    <Badge tone={MERCHANT_LABEL[merchant.status].tone}>{MERCHANT_LABEL[merchant.status].label}</Badge>
                    {merchant.kind && <span className="ml-2 text-white/60">{merchant.kind === 'pj' ? 'Pessoa jurídica' : 'Pessoa física'}</span>}
                    {merchant.provider_account_id && <span className="ml-2 font-mono text-xs text-white/60">{merchant.provider_account_id}</span>}
                    {merchant.status_detail && <p className="mt-1 text-xs text-white/60">{merchant.status_detail}</p>}
                    <p className="mt-1 text-xs text-white/45">Atualizada {when(merchant.updated_at)}</p>
                  </>
                ) : (
                  <>
                    <Badge tone="gray">Sem cadastro</Badge>
                    <span className="ml-2 text-white/60">O cadastro da conta depende da integração com a operadora e da sua autorização.</span>
                  </>
                )}
              </dd>
              <dt className="font-semibold text-white/60">Pix online no site</dt>
              <dd>
                <Switch
                  checked={enabled}
                  disabled={busy === 'method' || (!ready && !enabled)}
                  onChange={(v) => void toggleMethod(v)}
                  ariaLabel="Oferecer Pix online no checkout"
                />
                <p className="mt-1.5 text-xs text-white/55">
                  {enabled
                    ? 'Ligado: o cliente pode escolher “Pix online” ao finalizar o pedido.'
                    : ready
                      ? 'Desligado. Ligue para o cliente poder pagar pelo site.'
                      : 'Indisponível: falta operadora conectada e conta aprovada.'}
                </p>
              </dd>
            </dl>
          </Card>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Pagos" value={String(s!.paid)} hint={cents(s!.paid_cents)} tone="text-emerald-200" />
            <Stat label="Aguardando pagamento" value={String(s!.pending)} tone="text-amber-200" />
            <Stat label="Vencidos, cancelados ou com falha" value={String(s!.expired + s!.failed)} />
            <Stat label="Pedem conferência" value={String(s!.attention)} tone={s!.attention ? 'text-amber-200' : 'text-white'} />
          </div>

          <Card className="mt-4" title="Comissão (5% do total do pedido)" description="“Efetivada” só conta o que a operadora confirmou ter repassado. O resto é a conta feita pela loja.">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Calculada" value={cents(s!.commission_calculated_cents)} hint="dos pedidos pagos" />
              <Stat label="Efetivada" value={cents(s!.commission_confirmed_cents)} hint="confirmada pela operadora" tone="text-emerald-200" />
              <Stat label="Aguardando confirmação" value={cents(s!.commission_waiting_cents)} hint="ainda não confirmada" tone={s!.commission_waiting_cents ? 'text-amber-200' : 'text-white'} />
              <Stat label="Falhou" value={cents(s!.commission_failed_cents)} hint="não foi repassada" tone={s!.commission_failed_cents ? 'text-rose-200' : 'text-white'} />
            </div>
            <p className="mt-3 text-xs text-white/50">Tarifas informadas pela operadora nos pedidos pagos: {cents(s!.fee_cents)}.</p>
          </Card>

          <div className="mt-5 flex flex-wrap items-end gap-3" role="group" aria-label="Filtros dos pagamentos">
            <label className="block text-xs font-semibold text-white/55">
              Situação
              <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className={cx(INPUT, 'mt-1 w-52')}>
                {FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {f === 'all' ? 'Todas' : PAYMENT_STATE_LABEL[f]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex h-10 items-center gap-2 text-sm font-semibold text-white/75">
              <input type="checkbox" checked={attention} onChange={(e) => setAttention(e.target.checked)} className="h-4 w-4 accent-[#145CFF]" />
              Só os que pedem conferência
            </label>
          </div>

          <div className="mt-3">
            {data.payments.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<Wallet className="h-6 w-6" aria-hidden="true" />}
                  title={attention || status !== 'all' ? 'Nenhuma cobrança nesse filtro' : 'Nenhuma cobrança ainda'}
                  description={attention || status !== 'all' ? 'Tente outro filtro.' : 'Quando um cliente pagar um pedido com Pix online, a cobrança aparece aqui.'}
                />
              </Card>
            ) : (
              <ul className="space-y-2.5" aria-label="Cobranças">
                {data.payments.map((p) => (
                  <li key={p.id} data-payment={p.status} className={cx('rounded-2xl border bg-[#0C1018] p-4', p.needs_attention ? 'border-amber-400/40' : 'border-white/[0.08]')}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-base font-black text-white">
                          <a href={`/admin/pedidos/${p.order_number}`} className="hover:text-[#8FB1FF]">
                            Pedido #{p.order_number}
                          </a>{' '}
                          <span className="text-sm font-semibold text-white/55">· tentativa {p.attempt}</span>
                        </p>
                        <p className="text-xs text-white/55">
                          {when(p.created_at)}
                          {p.paid_at ? ` · paga ${when(p.paid_at)}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-black tabular-nums text-white">{cents(p.amount_cents)}</span>
                        <PaymentStateBadge status={p.status} />
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/65">
                      <span className="inline-flex items-center gap-1.5">
                        Comissão {cents(p.commission_cents)} <CommissionBadge state={p.commission_state ?? 'calculated'} />
                      </span>
                      <span>Tarifa {p.fee_cents === null || p.fee_cents === undefined ? '—' : cents(p.fee_cents)}</span>
                      <span>Líquido {p.net_cents === null || p.net_cents === undefined ? '—' : cents(p.net_cents)}</span>
                    </div>
                    {p.needs_attention && (
                      <p role="status" className="mt-2 flex items-start gap-2 rounded-lg bg-amber-400/10 px-2.5 py-2 text-xs text-amber-100 ring-1 ring-amber-400/30">
                        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{p.attention_reason ?? 'Precisa de conferência.'}</span>
                      </p>
                    )}
                    <div className="mt-3">
                      <PaymentActions payment={p} onChanged={() => void load()} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data.has_more && <p className="mt-3 text-center text-xs text-white/50">Mostrando as 50 cobranças mais recentes. Use os filtros para refinar.</p>}
          </div>
        </>
      )}
    </>
  );
}
