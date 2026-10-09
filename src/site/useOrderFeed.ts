import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../lib/api';
import type { PublicOrder } from '../lib/types';

// Mantém a página do pedido em dia sozinha:
//  • consulta o servidor a cada poucos segundos enquanto a aba está aberta (mais devagar em segundo plano);
//  • volta a consultar na hora quando a aba reaparece ou a internet volta;
//  • se a rede falhar, mostra o último estado conhecido, avisa e tenta de novo com intervalo crescente;
//  • os dados vêm sempre do banco: recarregar, fechar e abrir ou trocar de aparelho dão no mesmo.

export type FeedState = 'loading' | 'ok' | 'missing' | 'error';

const LIVE_MS = 10_000;
const FINAL_MS = 60_000;
const HIDDEN_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

export function useOrderFeed(key: string, fetcher: () => Promise<PublicOrder>, seed?: PublicOrder | null) {
  const [order, setOrder] = useState<PublicOrder | null>(seed ?? null);
  const [state, setState] = useState<FeedState>(seed ? 'ok' : 'loading');
  // Última consulta que deu certo e se a conexão está falhando agora.
  const [checkedAt, setCheckedAt] = useState<Date | null>(seed ? new Date() : null);
  const [offline, setOffline] = useState(false);
  const [retryIn, setRetryIn] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const kick = useRef<() => void>(() => undefined);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    let running = false;
    let latest: PublicOrder | null = seed ?? null;

    const schedule = () => {
      window.clearTimeout(timer);
      if (!alive) return;
      const hidden = document.visibilityState !== 'visible';
      const final = latest && (latest.order_status === 'delivered' || latest.order_status === 'cancelled');
      let wait = hidden ? HIDDEN_MS : final ? FINAL_MS : LIVE_MS;
      if (failures > 0) wait = Math.min(LIVE_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      setRetryIn(failures > 0 ? Math.round(wait / 1000) : 0);
      timer = window.setTimeout(() => void load(), wait);
    };

    const load = async () => {
      if (running || !alive) return;
      running = true;
      try {
        const fresh = await fetcherRef.current();
        if (!alive) return;
        latest = fresh;
        failures = 0;
        setOrder(fresh);
        setState('ok');
        setOffline(false);
        setCheckedAt(new Date());
      } catch (error) {
        if (!alive) return;
        if (error instanceof ApiError && (error.status === 404 || error.status === 401)) {
          // Link revogado ou vencido, ou sessão encerrada.
          setState('missing');
          return;
        }
        failures += 1;
        setOffline(true);
        setState((s) => (s === 'ok' ? s : 'error'));
      } finally {
        running = false;
        schedule();
      }
    };

    kick.current = () => {
      window.clearTimeout(timer);
      void load();
    };
    const onWake = () => {
      if (document.visibilityState === 'visible') kick.current();
    };
    void load();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(() => kick.current(), []);
  return { order, state, offline, retryIn, checkedAt, refresh };
}
