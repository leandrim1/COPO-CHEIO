import {
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  Copy,
  Link2,
  LoaderCircle,
  Motorbike,
  PackageCheck,
  RefreshCw,
  ShieldCheck,
  Store,
  UserRound,
  WifiOff,
  XCircle,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { DELIVERY_LABEL, PAYMENT_LABEL, STATUS, STATUS_FLOW, addressLines, formatDateTime, money, stepLabel } from '../lib/format';
import { orderCache, seedOrder } from '../lib/orderCache';
import { forgetAllOrders, forgetOrder, loadRecent, rememberOrder } from '../lib/recent';
import type { RecentOrder } from '../lib/recent';
import { copyText, normalizeCode, trackingPath, trackingUrl } from '../lib/tracking';
import { navigate } from '../lib/router';
import type { CustomerAccount, OrderStatus, PublicOrder, StoreSettings } from '../lib/types';
import { setCustomer, useCustomer } from './customer';
import { fullAddress, storeWhatsappUrl, useShop } from './data';
import { OrderListItem, useActiveOrders } from './OrderList';
import { Field, PageShell } from './shell';
import { BLUE_BUTTON, FIELD, GHOST_BUTTON, Price, WHATSAPP_BUTTON, WhatsAppIcon } from './ui';
import { useOrderFeed } from './useOrderFeed';

// ---- Textos de status ---------------------------------------------------------------------------

function headline(order: PublicOrder): string {
  const pickup = order.delivery_type === 'pickup';
  switch (order.order_status) {
    case 'new':
      return 'Recebemos o seu pedido e estamos esperando a confirmação da loja.';
    case 'confirmed':
      return 'Pedido confirmado! Já vamos separar as suas bebidas.';
    case 'preparing':
      return 'Estamos preparando o seu pedido.';
    case 'out_for_delivery':
      return pickup ? 'Seu pedido está pronto! Pode vir buscar na loja.' : 'Seu pedido saiu para entrega e já está a caminho.';
    case 'delivered':
      return pickup ? 'Pedido retirado. Obrigado pela preferência!' : 'Pedido entregue. Obrigado pela preferência!';
    case 'cancelled':
      return 'Este pedido foi cancelado. Qualquer dúvida, fale com a loja pelo WhatsApp.';
  }
}

function paymentText(order: PublicOrder): { label: string; tone: 'amber' | 'green' | 'red' } {
  if (order.payment_status === 'paid') return { label: 'Pagamento confirmado', tone: 'green' };
  if (order.payment_status === 'refunded') return { label: 'Pagamento estornado', tone: 'red' };
  if (order.payment_method === 'pix') return { label: 'Pagamento pendente', tone: 'amber' };
  return { label: order.delivery_type === 'pickup' ? 'Pagar na retirada' : 'Pagar na entrega', tone: 'amber' };
}

const TONE = {
  amber: 'border-amber-400/30 bg-amber-400/10 text-amber-100',
  green: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-100',
  red: 'border-rose-400/30 bg-rose-500/10 text-rose-100',
};

const hourFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// "14:32" se foi hoje; "03/05 14:32" nos outros dias.
export function stepTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? hourFormat.format(date) : dayFormat.format(date);
}

// ---- WhatsApp -------------------------------------------------------------------------------------

// Mensagem para a loja com o pedido e o link de acompanhamento.
export function orderWhatsappMessage(store: StoreSettings, order: PublicOrder, link: string): string {
  const payment =
    PAYMENT_LABEL[order.payment_method] +
    (order.payment_method === 'cash' && order.change_for ? ` (troco para ${money(order.change_for)})` : '');
  return [
    `Olá, ${store.store_name}! Quero fazer o pedido #${order.order_number}.`,
    '',
    'Cliente:',
    order.customer_name,
    '',
    'Itens:',
    ...order.items.map((item) => `${item.quantity}x ${item.product_name}`),
    '',
    'Total:',
    money(order.total),
    '',
    order.delivery_type === 'delivery' ? 'Entrega:' : 'Retirada:',
    ...(order.delivery_type === 'delivery' ? addressLines(order) : ['Vou retirar na loja']),
    '',
    'Pagamento:',
    payment,
    ...(order.notes ? ['', 'Observações:', order.notes] : []),
    '',
    'Acompanhar pedido:',
    link,
  ].join('\n');
}


// ---- Linha do tempo -----------------------------------------------------------------------------

function Timeline({ order }: { order: PublicOrder }) {
  const reached = new Map(order.history.map((h) => [h.status, h.at]));
  const cancelled = order.order_status === 'cancelled';
  const currentIndex = STATUS_FLOW.indexOf(order.order_status);
  const next = !cancelled && currentIndex >= 0 && currentIndex < STATUS_FLOW.length - 1 ? STATUS_FLOW[currentIndex + 1] : null;

  return (
    <div>
      {cancelled && (
        <p role="status" className="mb-4 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 font-semibold text-rose-100">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <span>
            Pedido cancelado{reached.get('cancelled') ? ` em ${stepTime(reached.get('cancelled')!)}` : ''}. Qualquer dúvida, fale com a loja pelo WhatsApp.
          </span>
        </p>
      )}
      <ol className="grid gap-3 sm:grid-cols-5 sm:gap-2" aria-label="Andamento do pedido">
        {STATUS_FLOW.map((status, i) => {
          const done = !cancelled && i <= currentIndex;
          const wasReached = cancelled && reached.has(status);
          const current = !cancelled && i === currentIndex;
          const isNext = next === status;
          const at = done || wasReached ? reached.get(status) : undefined;
          return (
            <li
              key={status}
              data-state={current ? 'current' : done || wasReached ? 'done' : isNext ? 'next' : 'todo'}
              className="flex items-center gap-3 sm:flex-col sm:items-center sm:gap-2 sm:text-center"
              aria-current={current ? 'step' : undefined}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-black ${
                  done || wasReached
                    ? 'bg-[#145CFF] text-white shadow-[0_0_18px_rgba(20,92,255,0.8)]'
                    : isNext
                      ? 'border border-dashed border-[#5B8CFF] text-[#8FB1FF]'
                      : 'border border-white/15 text-white/40'
                } ${current ? 'ring-4 ring-[#145CFF]/30' : ''}`}
              >
                {done || wasReached ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-[12px] font-black leading-tight ${done || wasReached ? 'text-white' : isNext ? 'text-[#8FB1FF]' : 'text-white/40'}`}>
                  {stepLabel(status, order.delivery_type)}
                </span>
                {at ? <span className="block text-[11px] text-white/50">{stepTime(at)}</span> : isNext ? <span className="block text-[11px] text-[#8FB1FF]/80">Próxima etapa</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {next && (
        <p className="mt-4 text-sm text-white/65">
          Próxima etapa: <strong className="text-white">{stepLabel(next, order.delivery_type)}</strong>
        </p>
      )}
    </div>
  );
}

// ---- Peças do pedido ------------------------------------------------------------------------------

function Panel({ id, title, children, className = '' }: { id: string; title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6 ${className}`} aria-labelledby={id}>
      <h2 id={id} className="text-lg font-black text-white">
        {title}
      </h2>
      {children}
    </section>
  );
}

function StatusBadge({ order, big = false }: { order: PublicOrder; big?: boolean }) {
  const s = STATUS[order.order_status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-black tracking-wide ring-1 ${s.badge} ${big ? 'px-4 py-2 text-sm' : 'px-2.5 py-1 text-[11px]'}`}>
      <span className={`rounded-full ${s.dot} ${big ? 'h-2.5 w-2.5' : 'h-1.5 w-1.5'}`} />
      {stepLabel(order.order_status, order.delivery_type).toUpperCase()}
    </span>
  );
}

function StatusIcon({ status }: { status: OrderStatus }) {
  const cls = 'mx-auto h-14 w-14 drop-shadow-[0_0_20px_rgba(37,99,255,0.9)]';
  if (status === 'cancelled') return <XCircle className={`${cls} text-rose-300`} aria-hidden="true" />;
  if (status === 'delivered') return <PackageCheck className={`${cls} text-emerald-300`} aria-hidden="true" />;
  if (status === 'out_for_delivery') return <Motorbike className={`${cls} text-[#5B8CFF]`} aria-hidden="true" />;
  if (status === 'preparing') return <ChefHat className={`${cls} text-[#5B8CFF]`} aria-hidden="true" />;
  return <CheckCircle2 className={`${cls} text-[#5B8CFF]`} aria-hidden="true" />;
}

function CopyButton({ text, label, done = 'Copiado', className }: { text: string; label: string; done?: string; className: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <>
      <button
        type="button"
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? 'ok' : 'fail');
            window.setTimeout(() => setState('idle'), 2500);
          });
        }}
        className={className}
      >
        {state === 'ok' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        {state === 'ok' ? done : state === 'fail' ? 'Não foi possível copiar' : label}
      </button>
      {/* Avisa leitores de tela sem mexer no nome do botão */}
      <span role="status" className="sr-only">
        {state === 'ok' ? done : state === 'fail' ? 'Não foi possível copiar' : ''}
      </span>
    </>
  );
}

// Link permanente + código. Funciona em qualquer aparelho, sem login.
function LinkCard({ order, token, link }: { order: PublicOrder; token: string; link: string }) {
  return (
    <Panel id="link" title={<span className="flex items-center gap-2 text-base"><Link2 className="h-5 w-5 text-[#2563FF]" aria-hidden="true" /> Seu link de acompanhamento</span>} className="!p-5">
      <p className="mt-2 text-sm text-white/65">Guarde este link: com ele você acompanha o pedido a qualquer hora, em qualquer aparelho, sem criar conta.</p>
      <div className="mt-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/30 p-2 pl-3">
        <input
          readOnly
          aria-label="Link de acompanhamento"
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 truncate bg-transparent text-xs text-white/85 focus:outline-none"
        />
        <CopyButton
          text={link}
          label="Copiar"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#145CFF] px-3.5 py-2 text-xs font-bold text-white hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        />
      </div>
      <dl className="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-xs text-white/60">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <dt>Número do pedido</dt>
          <dd className="font-black tabular-nums text-white">#{order.order_number}</dd>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <dt>Código de acompanhamento</dt>
          <dd className="break-all font-mono font-bold tracking-wide text-white">{token}</dd>
        </div>
        <p className="mt-2 text-white/45">Sem o link, use o número e o código em “Acompanhar pedido”.</p>
      </dl>
      <p className="mt-3 flex items-start gap-2 text-xs text-white/45">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-white/40" aria-hidden="true" />
        <span>
          O link vale por {order.retention_days} dias depois da última atualização do pedido. Quem tem o link vê os itens e o endereço, então compartilhe só com quem você confia.
        </span>
      </p>
    </Panel>
  );
}

// Guardar o pedido na conta (opcional): exige login e prova de posse pelo código.
function AccountCard({ order, token, mine }: { order: PublicOrder; token: string; mine: boolean }) {
  const { status, customer } = useCustomer();
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState('');
  const here = window.location.pathname;

  if (status === 'idle' || status === 'loading' || status === 'error') return null;
  const inAccount = mine || state === 'done';
  if (order.linked && !inAccount) return null;

  const save = async () => {
    setState('busy');
    setError('');
    try {
      await api.post('/api/account/orders/claim', { order_number: order.order_number, code: token });
      setState('done');
    } catch (e) {
      setState('idle');
      // Sessão vencida: volta a mostrar "Entrar / Criar conta".
      if (e instanceof ApiError && e.status === 401) setCustomer(null);
      setError(friendlyError(e, 'Não foi possível salvar o pedido na sua conta.'));
    }
  };

  return (
    <Panel id="conta" title={<span className="flex items-center gap-2 text-base"><UserRound className="h-5 w-5 text-[#2563FF]" aria-hidden="true" /> Sua conta</span>} className="!p-5">
      {inAccount ? (
        <>
          <p className="mt-2 flex items-start gap-2 text-sm text-emerald-200">
            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> Este pedido está salvo na sua conta.
          </p>
          <a href={`/conta/pedidos/${order.order_number}`} className={`${GHOST_BUTTON} mt-3 w-full !py-2.5 text-sm`}>
            Ver em Meus pedidos
          </a>
        </>
      ) : status === 'in' ? (
        <>
          <p className="mt-2 text-sm text-white/65">
            Você entrou como <strong className="text-white">{customer?.name}</strong>. Quer ver este pedido em “Meus pedidos”?
          </p>
          <button type="button" onClick={() => void save()} disabled={state === 'busy'} className={`${BLUE_BUTTON} mt-3 w-full !py-2.5 text-sm disabled:opacity-60`}>
            {state === 'busy' ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Salvar na minha conta
          </button>
          {error && (
            <p role="alert" className="mt-2 text-xs font-medium text-rose-300">
              {error}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-white/65">Quer guardar o histórico dos seus pedidos? Criar uma conta é opcional — você não precisa dela para acompanhar este pedido.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a href={`/conta?voltar=${encodeURIComponent(here)}`} className={`${GHOST_BUTTON} !px-3 !py-2.5 text-sm`}>
              Entrar
            </a>
            <a href={`/conta?aba=cadastro&voltar=${encodeURIComponent(here)}`} className={`${BLUE_BUTTON} !px-3 !py-2.5 text-sm`}>
              Criar conta
            </a>
          </div>
        </>
      )}
    </Panel>
  );
}

// ---- A página do pedido -------------------------------------------------------------------------

type FeedInfo = { offline: boolean; retryIn: number; checkedAt: Date | null; refresh: () => void };

function ConnectionBanner({ feed }: { feed: FeedInfo }) {
  if (!feed.offline) return null;
  return (
    <div role="status" className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
      <WifiOff className="h-5 w-5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Sem conexão com o servidor. Mostrando a última atualização{feed.checkedAt ? ` (${hourFormat.format(feed.checkedAt)})` : ''}; tentando de novo em {feed.retryIn}s.
      </span>
      <button type="button" onClick={feed.refresh} className="inline-flex items-center gap-1.5 rounded-full bg-amber-300/20 px-3 py-1.5 text-xs font-bold hover:bg-amber-300/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Tentar agora
      </button>
    </div>
  );
}

export function OrderView({
  order,
  token,
  confirmation = false,
  mine = false,
  feed,
  children,
}: {
  order: PublicOrder;
  // Ausente na área "Meus pedidos" (a conta não precisa do código).
  token?: string;
  confirmation?: boolean;
  mine?: boolean;
  feed: FeedInfo;
  // Ações extras (ex.: "Pedir novamente" na conta).
  children?: ReactNode;
}) {
  const { store, payments } = useShop();
  const pixKey = payments.find((p) => p.code === 'pix')?.details ?? null;
  const live = order.order_status !== 'delivered' && order.order_status !== 'cancelled';
  const link = token ? trackingUrl(token) : '';
  const pay = paymentText(order);
  const showPix = order.payment_method === 'pix' && pixKey && order.payment_status !== 'paid' && order.order_status !== 'cancelled';
  const whatsapp = token ? storeWhatsappUrl(store, confirmation ? orderWhatsappMessage(store, order, link) : `Olá, ${store.store_name}! Estou acompanhando o pedido #${order.order_number}.\n\nAcompanhar pedido:\n${link}`) : '';

  useEffect(() => {
    document.title = `Pedido #${order.order_number} – ${store.store_name}`;
  }, [order.order_number, store.store_name]);

  return (
    <>
      <ConnectionBanner feed={feed} />
      <div className="relative overflow-hidden rounded-[2rem] border border-[#145CFF]/35 bg-gradient-to-br from-[#145CFF]/30 via-[#0B1230] to-[#050505] p-6 text-center shadow-[0_40px_120px_-50px_rgba(20,92,255,0.9)] sm:p-10">
        <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-[#2563FF]/30 blur-3xl cc-glow" />
        <div className="relative">
          {confirmation ? <CheckCircle2 className="mx-auto h-14 w-14 text-[#5B8CFF] drop-shadow-[0_0_20px_rgba(37,99,255,0.9)]" aria-hidden="true" /> : <StatusIcon status={order.order_status} />}
          <h1 className="mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">{confirmation ? 'Pedido recebido!' : `Pedido #${order.order_number}`}</h1>
          <p className="mx-auto mt-2 max-w-md text-balance text-white/75 sm:text-lg">
            {confirmation ? (
              <>
                Seu pedido <strong className="text-white">#{order.order_number}</strong> foi enviado para a {store.store_name}.
              </>
            ) : null}
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2" aria-live="polite">
            <StatusBadge order={order} big />
            <span className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-bold ${TONE[pay.tone]}`}>{pay.label}</span>
          </div>
          {!confirmation && <p className="mx-auto mt-3 max-w-md text-balance text-white/75">{headline(order)}</p>}
          <p className="mt-3 text-sm text-white/55">
            <span className="font-semibold text-white">{money(order.total)}</span> · {DELIVERY_LABEL[order.delivery_type]} · feito em {formatDateTime(order.created_at)}
          </p>

          {confirmation && token && (
            <div className="mx-auto mt-7 grid max-w-xl gap-3 sm:grid-cols-2">
              <a href={trackingPath(token)} className={`${BLUE_BUTTON} sm:col-span-2`}>
                Acompanhar meu pedido
              </a>
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={WHATSAPP_BUTTON}>
                <WhatsAppIcon className="h-5 w-5" />
                Compartilhar pelo WhatsApp
              </a>
              <CopyButton text={link} label="Copiar link de acompanhamento" done="Link copiado!" className={GHOST_BUTTON} />
              <a href="/bebidas" className={`${GHOST_BUTTON} sm:col-span-2`}>
                Fazer outro pedido
              </a>
            </div>
          )}
          {confirmation && <p className="mt-4 text-xs text-white/50">O pedido já está salvo. O WhatsApp abre uma conversa com a loja com o número e o link; é só uma forma de falar com a gente, ele não confirma nada sozinho.</p>}
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-5">
          <Panel id="andamento" title="Andamento">
            <div className="mt-5">
              <Timeline order={order} />
            </div>
            <p className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 pt-3 text-xs text-white/50">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                Última atualização: {formatDateTime(order.updated_at)}
              </span>
              {feed.checkedAt && !feed.offline && (
                <span className="inline-flex items-center gap-1.5">
                  {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-hidden="true" />}
                  {live ? 'Atualiza sozinho' : 'Pedido finalizado'} · verificado às {hourFormat.format(feed.checkedAt)}
                </span>
              )}
            </p>
            <details className="mt-3 text-sm text-white/65">
              <summary className="cursor-pointer select-none font-semibold text-[#8FB1FF] hover:text-white">Ver todas as atualizações</summary>
              <ol className="mt-3 space-y-2 border-l border-white/10 pl-4">
                {order.history.map((h, i) => (
                  <li key={i} className="relative">
                    <span className={`absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ${STATUS[h.status].dot}`} aria-hidden="true" />
                    <span className="font-semibold text-white">{stepLabel(h.status, order.delivery_type)}</span>
                    <span className="text-white/45"> · {formatDateTime(h.at)}</span>
                  </li>
                ))}
              </ol>
            </details>
          </Panel>

          <Panel id="itens" title="Itens">
            <ul className="mt-3 divide-y divide-white/10">
              {order.items.map((item, i) => (
                <li key={i} className="flex justify-between gap-4 py-2.5 text-sm">
                  <span className="text-white">
                    <span className="font-bold text-[#8FB1FF]">{item.quantity}x</span> {item.product_name}
                  </span>
                  <span className="tabular-nums text-white/75">{money(item.total_price)}</span>
                </li>
              ))}
            </ul>
            <dl className="mt-3 space-y-1.5 border-t border-white/10 pt-3 text-sm">
              <div className="flex justify-between text-white/65">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between text-white/65">
                <dt>Entrega</dt>
                <dd className="tabular-nums">{order.delivery_fee > 0 ? money(order.delivery_fee) : 'Grátis'}</dd>
              </div>
              {order.discount > 0 && (
                <div className="flex justify-between text-white/65">
                  <dt>Desconto</dt>
                  <dd className="tabular-nums">− {money(order.discount)}</dd>
                </div>
              )}
              <div className="flex items-end justify-between pt-1">
                <dt className="font-bold text-white">Total</dt>
                <dd>
                  <Price value={order.total} className="text-2xl" />
                </dd>
              </div>
            </dl>
          </Panel>
          {children}
        </div>

        <aside className="space-y-5">
          <Panel
            id="entrega"
            className="!p-5"
            title={
              <span className="flex items-center gap-2 text-base">
                {order.delivery_type === 'delivery' ? <Motorbike className="h-5 w-5 text-[#2563FF]" aria-hidden="true" /> : <Store className="h-5 w-5 text-[#2563FF]" aria-hidden="true" />}
                {DELIVERY_LABEL[order.delivery_type]}
              </span>
            }
          >
            <div className="mt-2 space-y-0.5 text-sm text-white/70">
              {order.delivery_type === 'delivery' ? addressLines(order).map((line) => <p key={line}>{line}</p>) : <p>{fullAddress(store) || 'Retirada na loja'}</p>}
            </div>
          </Panel>

          <Panel id="pagamento" title={<span className="text-base">Pagamento</span>} className="!p-5">
            <p className="mt-2 text-sm text-white/70">
              {PAYMENT_LABEL[order.payment_method]}
              {order.payment_method === 'cash' && order.change_for ? ` · troco para ${money(order.change_for)}` : ''}
            </p>
            <p className={`mt-2 inline-flex rounded-full border px-3 py-1 text-xs font-bold ${TONE[pay.tone]}`}>{pay.label}</p>
            {showPix && (
              <div className="mt-3 rounded-2xl border border-[#145CFF]/30 bg-[#145CFF]/10 p-3">
                <p className="text-xs text-white/60">Chave PIX</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-sm font-bold text-white">{pixKey}</code>
                  <CopyButton
                    text={pixKey ?? ''}
                    label="Copiar"
                    done="Copiada"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#145CFF] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  />
                </div>
                <p className="mt-2 text-xs text-white/55">Pague {money(order.total)} e envie o comprovante pelo WhatsApp.</p>
              </div>
            )}
          </Panel>

          {order.notes && (
            <Panel id="obs" title={<span className="text-base">Observações</span>} className="!p-5">
              <p className="mt-2 whitespace-pre-line text-sm text-white/70">{order.notes}</p>
            </Panel>
          )}

          {token && <LinkCard order={order} token={token} link={link} />}
          {token && !confirmation && (
            <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} w-full`}>
              <WhatsAppIcon className="h-5 w-5" />
              Compartilhar pelo WhatsApp
            </a>
          )}
          {token && <AccountCard order={order} token={token} mine={mine} />}
          {!confirmation && (
            <a href="/bebidas" className={`${GHOST_BUTTON} w-full`}>
              Fazer outro pedido
            </a>
          )}
        </aside>
      </div>
    </>
  );
}

// ---- /acompanhar-pedido/:código e /pedido/:código ----------------------------------------------

function useNoIndex() {
  // O endereço da página contém o código: não indexar e não repassar como "referência" para outros sites.
  useEffect(() => {
    const added: HTMLMetaElement[] = [];
    for (const [name, content] of [
      ['robots', 'noindex, nofollow'],
      ['referrer', 'no-referrer'],
    ]) {
      const meta = document.createElement('meta');
      meta.name = name;
      meta.content = content;
      document.head.appendChild(meta);
      added.push(meta);
    }
    return () => added.forEach((m) => m.remove());
  }, []);
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto mt-10 max-w-md text-center">
      <h1 className="text-2xl font-black text-white">{title}</h1>
      <div className="mt-2 text-white/65">{children}</div>
    </div>
  );
}

// `confirmation`: logo depois de finalizar o pedido (ou ao abrir o link /pedido/… de um pedido recente).
export function TrackingPage({ token, confirmation }: { token: string; confirmation: boolean }) {
  // Endereço que nem parece um código: nem consulta o servidor.
  if (normalizeCode(token) === null) return <TrackingNotFound />;
  return <TrackingLoaded token={token} confirmation={confirmation} />;
}

function TrackingNotFound() {
  useNoIndex();
  return (
    <PageShell back="/" backLabel="Início">
      <Message title="Pedido não encontrado">
        <p>Esse link não é válido ou já expirou. Confira o link ou consulte pelo número do pedido e o código de acompanhamento.</p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <a href="/acompanhar-pedido" className={BLUE_BUTTON}>
            Acompanhar pelo número e código
          </a>
          <a href="/bebidas" className={GHOST_BUTTON}>
            Ver bebidas
          </a>
        </div>
      </Message>
    </PageShell>
  );
}

function TrackingLoaded({ token, confirmation }: { token: string; confirmation: boolean }) {
  useNoIndex();
  const [mine, setMine] = useState(false);
  const feed = useOrderFeed(
    token,
    async () => {
      const data = await api.get<{ order: PublicOrder; mine?: boolean }>(`/api/tracking/${encodeURIComponent(token)}`);
      setMine(Boolean(data.mine));
      return data.order;
    },
    orderCache.get(token) ?? null,
  );

  if (feed.state === 'loading') {
    return (
      <PageShell back="/" backLabel="Início">
        <div className="mt-20 flex justify-center" role="status" aria-label="Carregando o pedido">
          <LoaderCircle className="h-10 w-10 animate-spin text-[#2563FF]" aria-hidden="true" />
        </div>
      </PageShell>
    );
  }

  if (feed.state === 'error' && !feed.order) {
    return (
      <PageShell back="/" backLabel="Início">
        <Message title="Não foi possível carregar o pedido agora">
          <p>Sem conexão com o servidor. Seu pedido está salvo; tentando de novo em {feed.retryIn}s.</p>
          <button type="button" onClick={feed.refresh} className={`${BLUE_BUTTON} mt-6`}>
            Tentar agora
          </button>
        </Message>
      </PageShell>
    );
  }

  if (feed.state === 'missing' || !feed.order) return <TrackingNotFound />;

  const fresh = confirmation && (orderCache.has(token) || Date.now() - new Date(feed.order.created_at).getTime() < 30 * 60_000);
  return (
    <PageShell back={fresh ? '/bebidas' : '/acompanhar-pedido'} backLabel={fresh ? 'Bebidas' : 'Acompanhar pedido'}>
      <OrderView order={feed.order} token={token} confirmation={fresh} mine={mine} feed={feed} />
    </PageShell>
  );
}

// ---- /acompanhar-pedido -------------------------------------------------------------------------

// Quem já entrou na conta vê só os próprios pedidos: acompanhar "sem cadastro" deixa de fazer sentido.
export function LookupPage() {
  const { status, customer } = useCustomer();
  // Só decide qual versão mostrar depois de saber se há conta logada (assim a opção errada não pisca);
  // se a resposta demorar, mostra a consulta sem cadastro mesmo assim.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    document.title = 'Acompanhar pedido';
    const timer = window.setTimeout(() => setWaited(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);

  if (status === 'in' && customer) return <AccountTracking customer={customer} />;
  if ((status === 'idle' || status === 'loading') && !waited) {
    return (
      <PageShell back="/" backLabel="Início">
        <div className="mt-20 flex justify-center" role="status" aria-label="Carregando">
          <LoaderCircle className="h-10 w-10 animate-spin text-[#2563FF]" aria-hidden="true" />
        </div>
      </PageShell>
    );
  }
  return <GuestLookup />;
}

const LookupTitle = () => (
  <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
    Acompanhar <span className="text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">pedido</span>
  </h1>
);

// Logado: os pedidos em andamento da conta, direto, sem número nem código.
function AccountTracking({ customer }: { customer: CustomerAccount }) {
  const { orders, failed, reload } = useActiveOrders();
  return (
    <PageShell back="/" backLabel="Início">
      <LookupTitle />
      <p className="mt-2 max-w-2xl text-white/60">
        Você entrou como <strong className="text-white">{customer.name}</strong>. Seus pedidos ficam aqui, sem precisar de link nem de código.
      </p>
      <section aria-labelledby="em-andamento" className="mt-8 max-w-3xl">
        <h2 id="em-andamento" className="mb-3 text-lg font-black text-white">
          {orders && orders.length === 1 ? 'Seu pedido em andamento' : 'Seus pedidos em andamento'}
        </h2>
        {orders === null ? (
          failed ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <span className="min-w-0 flex-1">Não foi possível carregar seus pedidos agora.</span>
              <button type="button" onClick={() => void reload()} className="inline-flex items-center gap-1.5 rounded-full bg-amber-300/20 px-3 py-1.5 text-xs font-bold hover:bg-amber-300/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Tentar de novo
              </button>
            </div>
          ) : (
            <div className="flex justify-center py-8" role="status" aria-label="Carregando seus pedidos">
              <LoaderCircle className="h-8 w-8 animate-spin text-[#2563FF]" aria-hidden="true" />
            </div>
          )
        ) : orders.length === 0 ? (
          <div className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6">
            <p className="font-semibold text-white">Você não tem nenhum pedido em andamento agora.</p>
            <p className="mt-1 text-sm text-white/60">Quando fizer um pedido, o andamento aparece aqui e se atualiza sozinho.</p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <a href="/bebidas" className={BLUE_BUTTON}>
                Ver bebidas
              </a>
              <a href="/conta/pedidos" className={GHOST_BUTTON}>
                Ver meus pedidos
              </a>
            </div>
          </div>
        ) : (
          <>
            <ul className="space-y-3">
              {orders.map((o) => (
                <OrderListItem key={o.order_number} o={o} />
              ))}
            </ul>
            <a href="/conta/pedidos" className={`${GHOST_BUTTON} mt-5`}>
              Ver todos os meus pedidos
            </a>
          </>
        )}
      </section>
    </PageShell>
  );
}

// Sem conta: número + código (opção B) ou entrar na conta (opção A).
function GuestLookup() {
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<{ number?: string; code?: string }>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<RecentOrder[]>(() => loadRecent());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    const next: typeof errors = {};
    const digits = number.trim().replace(/^#/, '');
    if (!/^\d{1,12}$/.test(digits)) next.number = 'Informe o número do pedido (só números, como 1001).';
    const normalized = normalizeCode(code);
    if (!normalized) next.code = 'Confira o código: são 20 letras e números, como 7K3M9-QX2VB-4HRD6-WTP8N.';
    setErrors(next);
    if (next.number || next.code) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setBusy(true);
    try {
      const { order, token } = await api.post<{ order: PublicOrder; token: string }>('/api/tracking/lookup', { order_number: digits, code: normalized });
      seedOrder(token, order);
      rememberOrder(order.order_number, token);
      navigate(trackingPath(token));
    } catch (error) {
      setBusy(false);
      setFormError(
        error instanceof ApiError && error.status === 0
          ? error.message
          : friendlyError(error, 'Não foi possível consultar agora. Tente de novo em instantes.'),
      );
    }
  };

  return (
    <PageShell back="/" backLabel="Início">
      <LookupTitle />
      <p className="mt-2 max-w-2xl text-white/60">Veja em que etapa está o seu pedido. Você pode entrar na sua conta ou acompanhar sem cadastro, como preferir.</p>

      <div className="mt-8 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="opcao-a" className="flex flex-col rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-5 sm:p-6">
          <p className="text-xs font-black tracking-[0.2em] text-[#8FB1FF]">OPÇÃO A</p>
          <h2 id="opcao-a" className="mt-1 text-xl font-black text-white">
            Já tenho uma conta
          </h2>
          <p className="mt-2 text-sm text-white/65">Entre para ver todos os seus pedidos, o andamento de cada um e repetir uma compra sem digitar tudo de novo.</p>
          <ul className="mt-4 space-y-2 text-sm text-white/75">
            {['Todos os seus pedidos em um só lugar', 'Andamento de cada pedido, atualizado sozinho', 'Seus dados salvos para o próximo pedido'].map((benefit) => (
              <li key={benefit} className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#5B8CFF]" aria-hidden="true" />
                {benefit}
              </li>
            ))}
          </ul>
          <div className="mt-auto pt-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <a href="/conta?voltar=%2Fconta%2Fpedidos" className={BLUE_BUTTON}>
                Entrar na conta
              </a>
              <a href="/conta?aba=cadastro&voltar=%2Fconta%2Fpedidos" className={GHOST_BUTTON}>
                Criar conta
              </a>
            </div>
          </div>
        </section>

        <section aria-labelledby="opcao-b" className="rounded-[1.75rem] border border-[#145CFF]/35 bg-gradient-to-b from-[#145CFF]/15 to-white/[0.02] p-5 sm:p-6">
          <p className="text-xs font-black tracking-[0.2em] text-[#8FB1FF]">OPÇÃO B</p>
          <h2 id="opcao-b" className="mt-1 text-xl font-black text-white">
            Quero acompanhar sem cadastro
          </h2>
          <p className="mt-2 text-sm text-white/65">Sem senha e sem e-mail. Use o número do pedido e o código que aparecem na confirmação.</p>
          <form onSubmit={submit} noValidate className="mt-4 space-y-4">
            <Field label="Número do pedido" error={errors.number}>
              {(p) => (
                <input
                  {...p}
                  value={number}
                  onChange={(e) => {
                    setNumber(e.target.value);
                    setErrors((x) => ({ ...x, number: undefined }));
                  }}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={14}
                  className={FIELD}
                  placeholder="#1001"
                />
              )}
            </Field>
            <Field label="Código de acompanhamento" error={errors.code} hint="Ou cole aqui o link inteiro do seu pedido.">
              {(p) => (
                <input
                  {...p}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setErrors((x) => ({ ...x, code: undefined }));
                  }}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  maxLength={160}
                  className={`${FIELD} font-mono tracking-wide`}
                  placeholder="7K3M9-QX2VB-4HRD6-WTP8N"
                />
              )}
            </Field>
            {formError && (
              <p role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {formError}
              </p>
            )}
            <button type="submit" disabled={busy} className={`${BLUE_BUTTON} w-full disabled:cursor-not-allowed disabled:opacity-60`}>
              {busy ? <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> : null}
              Consultar pedido
            </button>
          </form>
          <p className="mt-4 flex items-start gap-2 text-xs text-white/50">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            Dica: guarde o link do seu pedido. Com ele você volta aqui a qualquer hora, de qualquer aparelho, sem digitar nada.
          </p>
        </section>
      </div>

      {recent.length > 0 && (
        <section aria-labelledby="recentes" className="mt-5 rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 id="recentes" className="text-lg font-black text-white">
              Pedidos feitos neste aparelho
            </h2>
            <button
              type="button"
              onClick={() => {
                forgetAllOrders();
                setRecent([]);
              }}
              className="shrink-0 whitespace-nowrap text-xs font-semibold text-white/50 underline-offset-4 hover:text-white hover:underline"
            >
              Esquecer todos
            </button>
          </div>
          <ul className="mt-3 divide-y divide-white/10">
            {recent.map((r) => (
              <li key={r.number} className="flex items-center justify-between gap-3 py-3">
                <a href={trackingPath(r.token)} className="min-w-0 flex-1 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
                  <span className="font-black text-white">Pedido #{r.number}</span>
                  <span className="block text-xs text-white/50">{formatDateTime(r.at)}</span>
                </a>
                <a href={trackingPath(r.token)} className="rounded-full bg-[#145CFF] px-4 py-2 text-xs font-bold text-white hover:bg-[#2563FF]">
                  Acompanhar
                </a>
                <button
                  type="button"
                  aria-label={`Esquecer o pedido ${r.number} neste aparelho`}
                  onClick={() => {
                    forgetOrder(r.number);
                    setRecent(loadRecent());
                  }}
                  className="rounded-full p-2 text-white/40 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                >
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-white/40">Só um atalho deste aparelho. Os pedidos continuam salvos no sistema e acessíveis pelo link ou pelo número e código.</p>
        </section>
      )}
    </PageShell>
  );
}
