import { ArrowRight, Bike, CheckCircle2, ChefHat, Clock3, Inbox, PackageCheck, ShoppingBag } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { DELIVERY_LABEL, money, timeAgo } from '../lib/format';
import type { Order } from '../lib/types';
import { useLiveOrders } from './AdminApp';
import { BarList, ColumnChart } from './Charts';
import { Card, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, cx } from './ui';

type Dashboard = {
  timezone: string;
  cards: {
    today_orders: number;
    pending: number;
    confirmed: number;
    preparing: number;
    out_for_delivery: number;
    delivered_today: number;
    cancelled_today: number;
    revenue_today: number;
    revenue_week: number;
    revenue_month: number;
  };
  range: { days: number; orders: number; revenue: number; average_ticket: number };
  series: { bucket: string; orders: number; revenue: number }[];
  top_products: { name: string; quantity: number; revenue: number }[];
  recent: Order[];
};

const RANGES = [
  { days: 1, label: 'Hoje' },
  { days: 7, label: '7 dias' },
  { days: 30, label: '30 dias' },
];

const compactMoney = (v: number) =>
  v >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

function bucketLabels(bucket: string, days: number) {
  const [date, time] = bucket.split('T');
  const [, m, d] = date.split('-');
  if (days === 1) return { label: `Hoje, ${time}`, tick: time.slice(0, 2) + 'h' };
  return { label: `${d}/${m}`, tick: `${d}/${m}` };
}

function StatCard({ label, value, icon, tone, href }: { label: string; value: ReactNode; icon: ReactNode; tone: string; href?: string }) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-white/60">{label}</span>
        <span className={cx('grid h-8 w-8 place-items-center rounded-lg', tone)}>{icon}</span>
      </div>
      <p className="mt-3 text-3xl font-black tracking-tight text-white">{value}</p>
    </>
  );
  const cls = 'block rounded-2xl border border-white/[0.08] bg-[#0C1018] p-4 transition-colors';
  return href ? (
    <a href={href} className={cx(cls, 'hover:border-[#2563FF]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]')}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export default function DashboardPage() {
  const { version } = useLiveOrders();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Dashboard | null>(null);
  const [recent, setRecent] = useState<Order[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [, setTick] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const dash = await api.get<Dashboard>(`/api/admin/dashboard?days=${days}`);
      setError(false);
      setData(dash);
      setRecent(dash.recent);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // "Há 3 minutos" se atualiza sozinho.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (error && !data) return <ErrorState message="Não foi possível carregar o dashboard." onRetry={() => void load()} />;

  const c = data?.cards;
  const series = (data?.series ?? []).map((s) => ({ ...bucketLabels(s.bucket, data!.range.days), revenue: Number(s.revenue), orders: s.orders }));
  const todayText = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const today = todayText.charAt(0).toUpperCase() + todayText.slice(1);

  return (
    <>
      <PageHeader title="Dashboard" description={today} />

      {/* Operação agora */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {c ? (
          <>
            <StatCard label="Pedidos de hoje" value={c.today_orders} icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />} tone="bg-white/[0.06] text-white/70" href="/admin/pedidos" />
            <StatCard label="Pendentes" value={c.pending} icon={<Inbox className="h-4 w-4" aria-hidden="true" />} tone="bg-[#145CFF]/20 text-[#9DBBFF]" href="/admin/pedidos?status=new" />
            <StatCard label="Confirmados" value={c.confirmed} icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />} tone="bg-cyan-400/15 text-cyan-200" href="/admin/pedidos?status=confirmed" />
            <StatCard label="Em preparo" value={c.preparing} icon={<ChefHat className="h-4 w-4" aria-hidden="true" />} tone="bg-amber-400/15 text-amber-200" href="/admin/pedidos?status=preparing" />
            <StatCard label="Em entrega" value={c.out_for_delivery} icon={<Bike className="h-4 w-4" aria-hidden="true" />} tone="bg-violet-400/15 text-violet-200" href="/admin/pedidos?status=out_for_delivery" />
            <StatCard label="Concluídos hoje" value={c.delivered_today} icon={<PackageCheck className="h-4 w-4" aria-hidden="true" />} tone="bg-emerald-400/15 text-emerald-200" href="/admin/pedidos?status=delivered" />
          </>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-2xl" />)
        )}
      </div>

      {/* Faturamento */}
      <div className="mt-3 grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="relative overflow-hidden rounded-2xl border border-[#2563FF]/40 bg-gradient-to-br from-[#145CFF]/30 via-[#0C1430] to-[#0C1018] p-5">
          <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-[#2563FF]/30 blur-3xl" />
          <p className="relative text-[13px] font-semibold text-white/70">Faturamento do dia</p>
          {c ? <p className="relative mt-2 text-5xl font-black tracking-tight text-white">{money(Number(c.revenue_today))}</p> : <Skeleton className="mt-3 h-12 w-48" />}
          <p className="relative mt-2 text-xs text-white/50">Pedidos não cancelados</p>
        </div>
        <div className="rounded-2xl border border-white/[0.08] bg-[#0C1018] p-5">
          <p className="text-[13px] font-semibold text-white/60">Faturamento da semana</p>
          {c ? <p className="mt-2 text-3xl font-black tracking-tight text-white">{money(Number(c.revenue_week))}</p> : <Skeleton className="mt-3 h-9 w-36" />}
          <p className="mt-2 text-xs text-white/45">Desde segunda-feira</p>
        </div>
        <div className="rounded-2xl border border-white/[0.08] bg-[#0C1018] p-5">
          <p className="text-[13px] font-semibold text-white/60">Faturamento do mês</p>
          {c ? <p className="mt-2 text-3xl font-black tracking-tight text-white">{money(Number(c.revenue_month))}</p> : <Skeleton className="mt-3 h-9 w-36" />}
          <p className="mt-2 text-xs text-white/45">Desde o dia 1º</p>
        </div>
      </div>

      {/* Filtro de período: vale para tudo abaixo */}
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Período" className="inline-flex rounded-xl border border-white/10 bg-[#0C1018] p-1">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
              className={cx(
                'rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
                days === r.days ? 'bg-[#145CFF] text-white' : 'text-white/60 hover:text-white',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-sm text-white/55">
            <strong className="text-white">{data.range.orders}</strong> pedidos · <strong className="text-white">{money(Number(data.range.revenue))}</strong> · ticket médio{' '}
            <strong className="text-white">{money(Number(data.range.average_ticket))}</strong>
          </p>
        )}
      </div>

      <div className={cx('mt-3 grid gap-3 lg:grid-cols-2', loading && data && 'opacity-60 transition-opacity')}>
        <Card title="Vendas por dia" description={days === 1 ? 'Faturamento por hora, hoje' : `Faturamento nos últimos ${days} dias`}>
          {data ? (
            <ColumnChart title="Vendas por dia" data={series.map((s) => ({ label: s.label, tick: s.tick, value: s.revenue }))} format={money} axisFormat={compactMoney} />
          ) : (
            <Skeleton className="h-[210px]" />
          )}
        </Card>
        <Card title="Pedidos por dia" description={days === 1 ? 'Pedidos por hora, hoje' : `Pedidos nos últimos ${days} dias`}>
          {data ? (
            <ColumnChart
              title="Pedidos por dia"
              data={series.map((s) => ({ label: s.label, tick: s.tick, value: s.orders }))}
              format={(v) => `${v} ${v === 1 ? 'pedido' : 'pedidos'}`}
              axisFormat={(v) => String(v)}
              integer
            />
          ) : (
            <Skeleton className="h-[210px]" />
          )}
        </Card>
      </div>

      <div className={cx('mt-3 grid gap-3 lg:grid-cols-[1fr_1.35fr]', loading && data && 'opacity-60 transition-opacity')}>
        <Card title="Produtos mais vendidos" description={days === 1 ? 'Hoje' : `Últimos ${days} dias`}>
          {!data ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          ) : data.top_products.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/45">Nenhuma venda no período.</p>
          ) : (
            <BarList
              rows={data.top_products.map((p) => ({
                label: p.name,
                value: p.quantity,
                valueText: `${p.quantity} un.`,
                detail: money(Number(p.revenue)),
              }))}
            />
          )}
        </Card>

        <Card
          title="Pedidos recentes"
          actions={
            <a href="/admin/pedidos" className="inline-flex items-center gap-1 text-sm font-semibold text-[#8FB1FF] hover:text-white">
              Ver todos <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          }
          padded={false}
        >
          {!recent ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : recent.length === 0 ? (
            <EmptyState icon={<Clock3 className="h-6 w-6" aria-hidden="true" />} title="Nenhum pedido ainda" description="Os pedidos feitos no site aparecem aqui na hora." />
          ) : (
            <ul className="divide-y divide-white/[0.06]">
              {recent.map((o) => (
                <li key={o.id}>
                  <a
                    href={`/admin/pedidos/${o.order_number}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none sm:px-5"
                  >
                    <span className="w-14 shrink-0 text-sm font-black text-white">#{o.order_number}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-white">{o.customer_name}</span>
                      <span className="block text-xs text-white/45">
                        {DELIVERY_LABEL[o.delivery_type]} · {timeAgo(o.created_at)}
                      </span>
                    </span>
                    <span className="hidden text-sm font-bold tabular-nums text-white sm:block">{money(Number(o.total))}</span>
                    <StatusBadge status={o.order_status} delivery={o.delivery_type} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
