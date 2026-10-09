import { ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Inbox, Link2, MessageCircle, Phone, Printer, Search, User, UserCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import {
  DELIVERY_LABEL,
  PAYMENT_LABEL,
  PAYMENT_STATUS_LABEL,
  STATUS,
  STATUS_FLOW,
  addressLines,
  formatDateTime,
  formatPhone,
  money,
  statusLabel,
  timeAgo,
  whatsappTo,
} from '../lib/format';
import { navigate } from '../lib/router';
import { copyText, trackingUrl } from '../lib/tracking';
import type { Order, OrderItem, OrderStatus, PaymentStatus, StatusChange, TrackingLinkInfo } from '../lib/types';
import { useLiveOrders } from './AdminApp';
import { Badge, Button, Card, EmptyState, ErrorState, INPUT, PageHeader, Skeleton, Spinner, StatusBadge, cx, useConfirm, useToast } from './ui';

const FILTERS: { value: OrderStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'new', label: 'Novos' },
  { value: 'confirmed', label: 'Confirmados' },
  { value: 'preparing', label: 'Em preparo' },
  { value: 'out_for_delivery', label: 'Em entrega' },
  { value: 'delivered', label: 'Entregues' },
  { value: 'cancelled', label: 'Cancelados' },
];

const PAGE = 30;

// Pedido de cliente com conta ou de visitante.
function AccountBadge({ order }: { order: Pick<Order, 'customer_id'> }) {
  return order.customer_id ? (
    <Badge tone="blue" className="shrink-0">
      <UserCheck className="h-3 w-3" aria-hidden="true" /> Conta
    </Badge>
  ) : (
    <Badge tone="gray" className="shrink-0">Visitante</Badge>
  );
}

// Próximo passo do fluxo (para o botão rápido da lista).
function nextStatus(o: Order): { status: OrderStatus; label: string } | null {
  const i = STATUS_FLOW.indexOf(o.order_status);
  if (i < 0 || i >= STATUS_FLOW.length - 1) return null;
  const next = STATUS_FLOW[i + 1];
  const labels: Record<string, string> = {
    confirmed: 'Confirmar',
    preparing: 'Preparar',
    out_for_delivery: o.delivery_type === 'pickup' ? 'Pronto' : 'Saiu p/ entrega',
    delivered: o.delivery_type === 'pickup' ? 'Retirado' : 'Entregue',
  };
  return { status: next, label: labels[next] };
}

// Devolve o erro (ou null quando deu certo). O servidor grava o histórico com o nome de quem mudou.
export async function changeStatus(order: Pick<Order, 'id' | 'order_number'>, status: OrderStatus): Promise<unknown> {
  try {
    await api.patch(`/api/admin/orders/${order.id}`, { status });
    return null;
  } catch (error) {
    return error;
  }
}

// ---- Lista (/admin/pedidos) --------------------------------------------------------------------

export function OrdersPage() {
  const { version } = useLiveOrders();
  const toast = useToast();
  const [filter, setFilter] = useState<OrderStatus | 'all'>(() => {
    const status = new URLSearchParams(window.location.search).get('status');
    return FILTERS.some((f) => f.value === status) ? (status as OrderStatus) : 'all';
  });
  // /admin/pedidos?q=… (links vindos de Clientes) já abre filtrado.
  const [query, setQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [term, setTerm] = useState(() => (new URLSearchParams(window.location.search).get('q') ?? '').trim());
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [account, setAccount] = useState<'all' | 'account' | 'guest'>('all');
  const [limit, setLimit] = useState(PAGE);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [counts, setCounts] = useState<Partial<Record<OrderStatus, number>>>({});
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => setLimit(PAGE), [filter, term, from, to, account]);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (filter !== 'all') params.set('status', filter);
    if (term) params.set('q', term);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (account !== 'all') params.set('account', account);
    try {
      const data = await api.get<{ orders: Order[]; has_more: boolean; counts: Partial<Record<OrderStatus, number>> }>(`/api/admin/orders?${params}`);
      setError(false);
      setHasMore(data.has_more);
      setOrders(data.orders);
      setCounts(data.counts);
    } catch {
      setError(true);
    }
  }, [filter, term, from, to, account, limit]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const setFilterAndUrl = (value: OrderStatus | 'all') => {
    setFilter(value);
    window.history.replaceState(null, '', value === 'all' ? '/admin/pedidos' : `/admin/pedidos?status=${value}`);
  };

  const advance = async (o: Order) => {
    const next = nextStatus(o);
    if (!next) return;
    setBusy(o.id);
    const error = await changeStatus(o, next.status);
    setBusy(null);
    if (error) toast.error('Não foi possível atualizar o pedido.', friendlyError(error, ''));
    else {
      setOrders((list) => list?.map((x) => (x.id === o.id ? { ...x, order_status: next.status } : x)) ?? null);
      toast.success('Pedido atualizado.', `#${o.order_number} → ${statusLabel(next.status, o.delivery_type)}`);
      void load();
    }
  };

  const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

  return (
    <>
      <PageHeader title="Pedidos" description="Os pedidos do site chegam aqui em tempo real." />

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div role="group" aria-label="Filtrar por status" className="-mx-3 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 lg:flex-1">
          {FILTERS.map((f) => {
            const n = f.value === 'all' ? total : counts[f.value];
            const active = filter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilterAndUrl(f.value)}
                className={cx(
                  'inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
                  active ? 'border-[#145CFF] bg-[#145CFF] text-white' : 'border-white/10 bg-[#0C1018] text-white/65 hover:border-white/25 hover:text-white',
                )}
              >
                {f.value !== 'all' && <span className={cx('h-1.5 w-1.5 rounded-full', STATUS[f.value].dot)} aria-hidden="true" />}
                {f.label}
                {n !== undefined && <span className={cx('text-xs tabular-nums', active ? 'text-white/80' : 'text-white/40')}>{n}</span>}
              </button>
            );
          })}
        </div>
        <label className="relative block lg:w-80">
          <span className="sr-only">Buscar pedidos</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Número, nome, telefone ou e-mail" className={cx(INPUT, 'pl-9')} />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3" role="group" aria-label="Filtros de data e tipo de cliente">
        <label className="block text-xs font-semibold text-white/55">
          De
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={cx(INPUT, 'mt-1 w-40')} />
        </label>
        <label className="block text-xs font-semibold text-white/55">
          Até
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={cx(INPUT, 'mt-1 w-40')} />
        </label>
        <label className="block text-xs font-semibold text-white/55">
          Cliente
          <select value={account} onChange={(e) => setAccount(e.target.value as typeof account)} className={cx(INPUT, 'mt-1 w-44')}>
            <option value="all">Todos</option>
            <option value="account">Com conta</option>
            <option value="guest">Visitantes</option>
          </select>
        </label>
        {(from || to || account !== 'all') && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setFrom('');
              setTo('');
              setAccount('all');
            }}
          >
            Limpar filtros
          </Button>
        )}
      </div>

      <div className="mt-4">
        {error && !orders ? (
          <Card>
            <ErrorState message="Não foi possível carregar os pedidos." onRetry={() => void load()} />
          </Card>
        ) : !orders ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-16 rounded-2xl" />
            ))}
          </div>
        ) : orders.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
              title={term || filter !== 'all' || from || to || account !== 'all' ? 'Nenhum pedido encontrado' : 'Nenhum pedido ainda'}
              description={term || filter !== 'all' || from || to || account !== 'all' ? 'Tente outro filtro ou busca.' : 'Assim que um cliente finalizar um pedido no site, ele aparece aqui.'}
            />
          </Card>
        ) : (
          <>
            {/* Tabela (desktop) */}
            <div className="hidden overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0C1018] lg:block">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-white/[0.06] text-xs uppercase tracking-wide text-white/45">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-semibold">Número</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Cliente</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Valor</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Tipo</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Pagamento</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                    <th scope="col" className="px-4 py-3 font-semibold">Data</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.05]">
                  {orders.map((o) => {
                    const next = nextStatus(o);
                    return (
                      <tr key={o.id} className={cx('transition-colors hover:bg-white/[0.02]', o.order_status === 'new' && 'bg-[#145CFF]/[0.06]')}>
                        <td className="px-4 py-3">
                          <a href={`/admin/pedidos/${o.order_number}`} className="font-black text-white hover:text-[#8FB1FF]">
                            #{o.order_number}
                          </a>
                        </td>
                        <td className="max-w-[14rem] px-4 py-3">
                          <p className="flex items-center gap-2 font-semibold text-white">
                            <span className="truncate">{o.customer_name}</span>
                            <AccountBadge order={o} />
                          </p>
                          <p className="text-xs text-white/45">{formatPhone(o.customer_phone)}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-bold tabular-nums text-white">{money(Number(o.total))}</td>
                        <td className="px-4 py-3 text-white/70">{DELIVERY_LABEL[o.delivery_type]}</td>
                        <td className="px-4 py-3">
                          <p className="text-white/80">{PAYMENT_LABEL[o.payment_method]}</p>
                          <p className={cx('text-xs', o.payment_status === 'paid' ? 'text-emerald-300' : 'text-white/40')}>{PAYMENT_STATUS_LABEL[o.payment_status]}</p>
                        </td>
                        <td className="px-4 py-3">
                          <StatusBadge status={o.order_status} delivery={o.delivery_type} />
                        </td>
                        <td className="px-4 py-3 text-white/60" title={formatDateTime(o.created_at)}>
                          {timeAgo(o.created_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-2">
                            {next && (
                              <Button size="sm" variant="secondary" loading={busy === o.id} onClick={() => void advance(o)}>
                                {next.label}
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => navigate(`/admin/pedidos/${o.order_number}`)} aria-label={`Ver pedido ${o.order_number}`}>
                              Ver <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Cards (celular e tablet) */}
            <ul className="space-y-2.5 lg:hidden">
              {orders.map((o) => {
                const next = nextStatus(o);
                return (
                  <li key={o.id} className={cx('rounded-2xl border bg-[#0C1018] p-3.5', o.order_status === 'new' ? 'border-[#2563FF]/50' : 'border-white/[0.08]')}>
                    <a href={`/admin/pedidos/${o.order_number}`} className="block focus-visible:outline-none">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-base font-black text-white">#{o.order_number}</p>
                          <p className="flex items-center gap-2 text-sm font-semibold text-white/85">
                            <span className="truncate">{o.customer_name}</span>
                            <AccountBadge order={o} />
                          </p>
                        </div>
                        <StatusBadge status={o.order_status} delivery={o.delivery_type} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-white/50">
                        <span className="text-sm font-bold text-white">{money(Number(o.total))}</span>
                        <span>{DELIVERY_LABEL[o.delivery_type]}</span>
                        <span>
                          {PAYMENT_LABEL[o.payment_method]}
                          {o.payment_status === 'paid' ? ' · pago' : ''}
                        </span>
                        <span>{timeAgo(o.created_at)}</span>
                      </div>
                    </a>
                    {next && (
                      <Button size="sm" variant="secondary" className="mt-3 w-full" loading={busy === o.id} onClick={() => void advance(o)}>
                        {next.label}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>

            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="secondary" onClick={() => setLimit((l) => l + PAGE)}>
                  Carregar mais
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---- Detalhes (/admin/pedidos/:numero) ---------------------------------------------------------

const ACTIONS: OrderStatus[] = ['confirmed', 'preparing', 'out_for_delivery', 'delivered'];

const PRINT_CSS = `
@media print {
  @page { margin: 8mm; }
  body * { visibility: hidden !important; }
  #recibo, #recibo * { visibility: visible !important; }
  #recibo { position: absolute; left: 0; top: 0; width: 100%; display: block !important; }
  html, body { background: #fff !important; }
}
`;

// ---- Link de acompanhamento do cliente --------------------------------------------------------

// O banco guarda só o hash do código: o link que o cliente recebeu não pode ser lido de volta. Para enviar,
// copiar ou abrir, o painel gera um link novo (os que o cliente já tem continuam valendo, a não ser que se
// escolha "Trocar link").
function TrackingCard({ order, links, retention, onChanged }: { order: Order; links: TrackingLinkInfo[]; retention: number; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState<'new' | 'replace' | null>(null);
  const [copied, setCopied] = useState(false);
  const active = links.filter((l) => !l.revoked_at);
  const first = order.customer_name.split(' ')[0];
  const url = fresh ? trackingUrl(fresh) : '';

  const generate = async (replace: boolean) => {
    if (replace) {
      const ok = await confirm({
        title: 'Trocar o link de acompanhamento?',
        description: 'Os links que o cliente já recebeu (inclusive o da página de confirmação) deixam de funcionar. Use se o link vazou ou foi parar na mão errada.',
        confirmLabel: 'Trocar link',
      });
      if (!ok) return;
    }
    setBusy(replace ? 'replace' : 'new');
    try {
      const data = await api.post<{ token: string }>(`/api/admin/orders/${order.id}/tracking-link`, { replace });
      setFresh(data.token);
      setCopied(false);
      onChanged();
      toast.success(replace ? 'Link trocado.' : 'Link gerado.', replace ? 'Os links anteriores foram invalidados.' : 'Os links que o cliente já tem continuam valendo.');
    } catch (err) {
      toast.error('Não foi possível gerar o link.', friendlyError(err, ''));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Acompanhamento do cliente" description={`O cliente acompanha o pedido sem login. O link vale por ${retention} dias após a última atualização.`}>
      <p className="flex items-center gap-2 text-sm text-white/75">
        <Link2 className="h-4 w-4 text-white/40" aria-hidden="true" />
        {active.length} {active.length === 1 ? 'link ativo' : 'links ativos'}
        {links.length > active.length ? <span className="text-white/40">· {links.length - active.length} invalidado(s)</span> : null}
      </p>
      <p className="mt-2 text-xs text-white/45">
        Por segurança, o sistema guarda só o hash do código: o link que o cliente já recebeu não pode ser visto de novo. Gere um link novo para abrir, copiar ou enviar.
      </p>

      {fresh && (
        <div className="mt-3 space-y-2 rounded-xl border border-[#145CFF]/35 bg-[#145CFF]/10 p-3">
          <input readOnly value={url} aria-label="Link de acompanhamento" onFocus={(e) => e.currentTarget.select()} className={cx(INPUT, 'text-xs')} />
          <p className="text-[11px] text-white/50">Este link só aparece agora. Código: <span className="font-mono text-white/80">{fresh}</span></p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
              onClick={() => void copyText(url).then((ok) => (ok ? setCopied(true) : toast.error('Não foi possível copiar.', 'Selecione o link e copie à mão.')))}
            >
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.06] px-3 text-xs font-semibold text-white hover:bg-white/10"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Abrir
            </a>
            <a
              href={whatsappTo(order.customer_phone, `Olá, ${first}! Aqui é da Copo Cheio. Acompanhe o seu pedido #${order.order_number} por este link:\n${url}`)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-[#25D366] px-3 text-xs font-bold text-[#04210F] hover:bg-[#3DE07A]"
            >
              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" /> Enviar por WhatsApp
            </a>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" loading={busy === 'new'} onClick={() => void generate(false)}>
          Gerar link
        </Button>
        <Button size="sm" variant="danger-ghost" loading={busy === 'replace'} onClick={() => void generate(true)}>
          Trocar link
        </Button>
      </div>
    </Card>
  );
}

export function OrderDetailPage({ number }: { number: string }) {
  const { version } = useLiveOrders();
  const toast = useToast();
  const confirm = useConfirm();
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [items, setItems] = useState<OrderItem[]>([]);
  const [history, setHistory] = useState<StatusChange[]>([]);
  const [links, setLinks] = useState<TrackingLinkInfo[]>([]);
  const [account, setAccount] = useState<{ id: string; name: string; email: string; phone: string } | null>(null);
  const [retention, setRetention] = useState(180);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!/^\d+$/.test(number)) {
      setOrder(null);
      return;
    }
    try {
      const data = await api.get<{ order: Order; items: OrderItem[]; history: StatusChange[]; tracking_links: TrackingLinkInfo[]; account: typeof account; retention_days: number }>(`/api/admin/orders/${number}`);
      setError(false);
      setOrder(data.order);
      setItems(data.items);
      setHistory(data.history);
      setLinks(data.tracking_links);
      setAccount(data.account);
      setRetention(data.retention_days);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setOrder(null);
      else setError(true);
    }
  }, [number]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const setStatus = async (status: OrderStatus) => {
    if (!order || status === order.order_status) return;
    if (status === 'cancelled') {
      const ok = await confirm({
        title: `Cancelar o pedido #${order.order_number}?`,
        description: 'O estoque dos itens volta para a loja. Um pedido cancelado não pode ser reaberto.',
        confirmLabel: 'Cancelar pedido',
      });
      if (!ok) return;
    }
    setBusy(status);
    const err = await changeStatus(order, status);
    setBusy(null);
    if (err) toast.error('Não foi possível atualizar o pedido.', friendlyError(err, ''));
    else {
      setOrder({ ...order, order_status: status });
      toast.success('Pedido atualizado.', `#${order.order_number} → ${statusLabel(status, order.delivery_type)}`);
      void load();
    }
  };

  const setPayment = async (payment_status: PaymentStatus) => {
    if (!order) return;
    setBusy('payment');
    const err = await api.patch(`/api/admin/orders/${order.id}`, { payment_status }).then(
      () => null,
      (e: unknown) => e,
    );
    setBusy(null);
    if (err) toast.error('Não foi possível atualizar o pagamento.', friendlyError(err, ''));
    else {
      setOrder({ ...order, payment_status });
      toast.success('Pagamento atualizado.', PAYMENT_STATUS_LABEL[payment_status]);
      void load();
    }
  };

  const address = useMemo(() => (order ? addressLines(order) : []), [order]);

  if (error && !order) return <ErrorState message="Não foi possível carregar o pedido." onRetry={() => void load()} />;
  if (order === undefined) return <Spinner label="Carregando o pedido" />;
  if (order === null)
    return (
      <Card>
        <EmptyState
          icon={<Inbox className="h-6 w-6" aria-hidden="true" />}
          title="Pedido não encontrado"
          action={
            <Button variant="secondary" onClick={() => navigate('/admin/pedidos')}>
              Voltar para pedidos
            </Button>
          }
        />
      </Card>
    );

  const cancelled = order.order_status === 'cancelled';
  const customerWhatsapp = whatsappTo(order.customer_phone, `Olá, ${order.customer_name.split(' ')[0]}! Aqui é da Copo Cheio, sobre o seu pedido #${order.order_number}.`);

  return (
    <>
      <style>{PRINT_CSS}</style>
      <a href="/admin/pedidos" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-white/55 hover:text-white">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Pedidos
      </a>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">PEDIDO #{order.order_number}</h1>
            <StatusBadge status={order.order_status} delivery={order.delivery_type} />
            <AccountBadge order={order} />
          </div>
          <p className="mt-1 text-sm text-white/50">
            {formatDateTime(order.created_at)} · {timeAgo(order.created_at)} · {DELIVERY_LABEL[order.delivery_type]}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={customerWhatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-[#25D366] px-4 text-sm font-bold text-[#04210F] hover:bg-[#3DE07A]"
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" /> WhatsApp do cliente
          </a>
          <Button variant="secondary" icon={<Printer className="h-4 w-4" aria-hidden="true" />} onClick={() => window.print()}>
            Imprimir
          </Button>
        </div>
      </div>

      {/* Ações de status */}
      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {ACTIONS.map((status) => {
            const current = order.order_status === status;
            const label = order.delivery_type === 'pickup' && status === 'out_for_delivery' ? 'PRONTO P/ RETIRAR' : order.delivery_type === 'pickup' && status === 'delivered' ? 'RETIRADO' : STATUS[status].action;
            return (
              <Button
                key={status}
                variant={current ? 'primary' : 'secondary'}
                size="lg"
                disabled={cancelled}
                loading={busy === status}
                aria-pressed={current}
                onClick={() => void setStatus(status)}
                className={cx('w-full text-xs sm:text-[13px]', current && 'cursor-default ring-2 ring-[#5B8CFF]/50')}
              >
                {label}
              </Button>
            );
          })}
          <Button variant="danger-ghost" size="lg" disabled={cancelled} loading={busy === 'cancelled'} onClick={() => void setStatus('cancelled')} className="col-span-2 w-full border border-rose-500/30 text-xs sm:col-span-1 sm:text-[13px]">
            {cancelled ? 'CANCELADO' : 'CANCELAR'}
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Card title="Itens" padded={false}>
            <ul className="divide-y divide-white/[0.06]">
              {items.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-4 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="font-semibold text-white">
                      <span className="text-[#8FB1FF]">{item.quantity}x</span> {item.product_name}
                    </p>
                    <p className="text-xs text-white/45">{money(Number(item.unit_price))} cada</p>
                  </div>
                  <p className="shrink-0 font-bold tabular-nums text-white">{money(Number(item.total_price))}</p>
                </li>
              ))}
            </ul>
            <dl className="space-y-1.5 border-t border-white/[0.06] px-4 py-4 text-sm sm:px-5">
              <div className="flex justify-between text-white/60">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(Number(order.subtotal))}</dd>
              </div>
              <div className="flex justify-between text-white/60">
                <dt>Entrega</dt>
                <dd className="tabular-nums">{money(Number(order.delivery_fee))}</dd>
              </div>
              <div className="flex justify-between text-white/60">
                <dt>Desconto</dt>
                <dd className="tabular-nums">{Number(order.discount) > 0 ? `− ${money(Number(order.discount))}` : money(0)}</dd>
              </div>
              <div className="flex items-baseline justify-between pt-2">
                <dt className="text-base font-black text-white">TOTAL</dt>
                <dd className="text-2xl font-black tabular-nums text-white">{money(Number(order.total))}</dd>
              </div>
            </dl>
          </Card>

          {order.notes && (
            <Card title="Observações">
              <p className="whitespace-pre-line text-sm text-white/80">{order.notes}</p>
            </Card>
          )}

          <Card title="Histórico">
            <ol className="relative space-y-4 border-l border-white/10 pl-5">
              {history.map((h) => (
                <li key={h.id} className="relative">
                  <span className={cx('absolute -left-[25px] top-1 h-2.5 w-2.5 rounded-full ring-4 ring-[#0C1018]', STATUS[h.to_status].dot)} aria-hidden="true" />
                  <p className="text-sm font-semibold text-white">
                    {h.from_status ? (
                      <>
                        {statusLabel(h.from_status, order.delivery_type)} <span className="text-white/40">→</span> {statusLabel(h.to_status, order.delivery_type)}
                      </>
                    ) : (
                      'Pedido recebido pelo site'
                    )}
                  </p>
                  <p className="text-xs text-white/45">
                    {formatDateTime(h.created_at)} · {h.changed_by_name ?? '—'}
                  </p>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="Cliente">
            <div className="space-y-2 text-sm">
              <p className="flex items-center gap-2 font-semibold text-white">
                <User className="h-4 w-4 text-white/40" aria-hidden="true" /> {order.customer_name}
              </p>
              <p className="flex items-center gap-2 text-white/75">
                <Phone className="h-4 w-4 text-white/40" aria-hidden="true" />
                <a href={`tel:${order.customer_phone}`} className="hover:text-white">
                  {formatPhone(order.customer_phone)}
                </a>
              </p>
              {order.customer_email && <p className="pl-6 text-white/60">{order.customer_email}</p>}
              <p className="flex items-center gap-2 pt-1 text-xs text-white/55">
                {account ? (
                  <>
                    <UserCheck className="h-4 w-4 text-[#9DBBFF]" aria-hidden="true" />
                    <span>
                      Cliente com conta: <a href={`/admin/clientes?q=${encodeURIComponent(account.email)}`} className="font-semibold text-[#8FB1FF] hover:text-white">{account.email}</a>
                    </span>
                  </>
                ) : (
                  <span>Pedido de visitante (sem conta).</span>
                )}
              </p>
            </div>
          </Card>

          <TrackingCard order={order} links={links} retention={retention} onChanged={() => void load()} />
          <Card title={order.delivery_type === 'delivery' ? 'Endereço de entrega' : 'Retirada'}>
            {order.delivery_type === 'delivery' ? (
              <div className="space-y-0.5 text-sm text-white/80">
                {address.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                <a
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${order.address}, ${order.address_number} - ${order.neighborhood}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-block text-xs font-semibold text-[#8FB1FF] hover:text-white"
                >
                  Abrir no mapa →
                </a>
              </div>
            ) : (
              <p className="text-sm text-white/70">O cliente vai retirar na loja.</p>
            )}
          </Card>
          <Card title="Pagamento">
            <p className="text-sm font-semibold text-white">
              {PAYMENT_LABEL[order.payment_method]}
              {order.payment_method === 'cash' && order.change_for ? <span className="font-normal text-white/60"> · troco para {money(Number(order.change_for))}</span> : null}
            </p>
            <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Situação do pagamento">
              {(['pending', 'paid', 'refunded'] as PaymentStatus[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={order.payment_status === p}
                  disabled={busy === 'payment'}
                  onClick={() => void setPayment(p)}
                  className={cx(
                    'rounded-full px-3 py-1.5 text-xs font-bold ring-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
                    order.payment_status === p
                      ? p === 'paid'
                        ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/50'
                        : p === 'refunded'
                          ? 'bg-rose-500/15 text-rose-200 ring-rose-400/40'
                          : 'bg-amber-400/15 text-amber-200 ring-amber-400/40'
                      : 'text-white/50 ring-white/10 hover:text-white',
                  )}
                >
                  {PAYMENT_STATUS_LABEL[p]}
                </button>
              ))}
            </div>
            {order.payment_method === 'pix' && order.payment_status !== 'paid' && <Badge tone="amber" className="mt-3">Confira o comprovante do PIX</Badge>}
          </Card>
        </div>
      </div>

      {/* Recibo para impressão */}
      <div id="recibo" className="hidden bg-white p-2 font-mono text-[12px] leading-snug text-black">
        <p className="text-center text-base font-bold">COPO CHEIO – Disk Bebidas</p>
        <p className="text-center text-lg font-bold">PEDIDO #{order.order_number}</p>
        <p className="text-center">{formatDateTime(order.created_at)}</p>
        <p className="text-center font-bold">{DELIVERY_LABEL[order.delivery_type].toUpperCase()} · {statusLabel(order.order_status, order.delivery_type)}</p>
        <hr className="my-2 border-black" />
        <p>Cliente: {order.customer_name}</p>
        <p>Telefone: {formatPhone(order.customer_phone)}</p>
        {order.delivery_type === 'delivery' && address.map((line) => <p key={line}>{line}</p>)}
        <hr className="my-2 border-black" />
        {items.map((item) => (
          <p key={item.id} className="flex justify-between gap-2">
            <span>
              {item.quantity}x {item.product_name}
            </span>
            <span>{money(Number(item.total_price))}</span>
          </p>
        ))}
        <hr className="my-2 border-black" />
        <p className="flex justify-between">
          <span>Subtotal</span>
          <span>{money(Number(order.subtotal))}</span>
        </p>
        <p className="flex justify-between">
          <span>Entrega</span>
          <span>{money(Number(order.delivery_fee))}</span>
        </p>
        {Number(order.discount) > 0 && (
          <p className="flex justify-between">
            <span>Desconto</span>
            <span>− {money(Number(order.discount))}</span>
          </p>
        )}
        <p className="flex justify-between text-base font-bold">
          <span>TOTAL</span>
          <span>{money(Number(order.total))}</span>
        </p>
        <p>
          Pagamento: {PAYMENT_LABEL[order.payment_method]}
          {order.change_for ? ` (troco para ${money(Number(order.change_for))})` : ''} – {PAYMENT_STATUS_LABEL[order.payment_status]}
        </p>
        {order.notes && <p className="mt-1">Obs.: {order.notes}</p>}
      </div>
    </>
  );
}
