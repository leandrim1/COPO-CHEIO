import { ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { PAYMENT_LABEL, STATUS, formatDateTime, money, stepLabel } from '../lib/format';
import type { AccountOrderSummary } from '../lib/types';
import { setCustomer } from './customer';

// Cartão de um pedido da conta na lista (Meus pedidos e "pedidos em andamento").
export function OrderListItem({ o }: { o: AccountOrderSummary }) {
  return (
    <li>
      <a
        href={`/conta/pedidos/${o.order_number}`}
        className="flex items-center gap-4 rounded-[1.5rem] border border-white/10 bg-white/[0.03] p-4 transition-colors hover:border-white/30 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:p-5"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-lg font-black text-white">Pedido #{o.order_number}</span>
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black tracking-wide ring-1 ${STATUS[o.order_status].badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${STATUS[o.order_status].dot}`} />
              {stepLabel(o.order_status, o.delivery_type).toUpperCase()}
            </span>
          </span>
          {o.summary && <span className="mt-1 block truncate text-sm text-white/65">{o.summary}</span>}
          <span className="mt-1 block text-xs text-white/45">
            {formatDateTime(o.created_at)} · {PAYMENT_LABEL[o.payment_method]}
            {o.payment_status === 'paid' ? ' · pago' : ''}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-black tabular-nums text-white">{money(o.total)}</span>
          <ChevronRight className="ml-auto mt-1 h-5 w-5 text-white/40" aria-hidden="true" />
        </span>
      </a>
    </li>
  );
}

const isActive = (o: AccountOrderSummary) => o.order_status !== 'delivered' && o.order_status !== 'cancelled';

// Pedidos da conta que ainda estão em andamento, para acompanhar sem procurar o link da confirmação.
// Atualiza sozinho a cada 20 s com a aba aberta e na hora em que ela volta.
export function useActiveOrders() {
  const [orders, setOrders] = useState<AccountOrderSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await api.get<{ orders: AccountOrderSummary[] }>('/api/account/orders');
      if (!alive.current) return;
      setOrders(data.orders.filter(isActive));
      setFailed(false);
    } catch (err) {
      if (!alive.current) return;
      // Sessão vencida: as telas voltam a mostrar "Entrar".
      if (err instanceof ApiError && err.status === 401) setCustomer(null);
      else setFailed(true);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void load(), 20_000);
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { orders, failed, reload: load };
}
