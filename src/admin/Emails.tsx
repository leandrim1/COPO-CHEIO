import { useCallback, useEffect, useRef, useState } from 'react';
import { api, friendlyError } from '../lib/api';
import type { EmailOverview } from '../lib/types';
import { Card, ErrorState, PageHeader, Skeleton, cx, useToast } from './ui';
import AuthenticationTab from './emails/Authentication';
import CampaignsTab from './emails/Campaigns';
import MessagesTab from './emails/Messages';
import OverviewTab from './emails/Overview';
import SuppressionsTab from './emails/Suppressions';

// Painel "E-mails e Entregabilidade": o que foi enviado, o que o servidor aceitou, o que falhou, alertas, promoções e a autenticação do domínio.
// Tudo o que aparece vem dos registros do sistema; o que o provedor não informa (entrega, spam, aberturas) aparece como "não informado".
const TABS = [
  { id: 'visao-geral', label: 'Visão geral' },
  { id: 'mensagens', label: 'Mensagens' },
  { id: 'campanhas', label: 'Promoções' },
  { id: 'supressoes', label: 'Supressões' },
  { id: 'autenticacao', label: 'Autenticação' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const fromUrl = (): TabId => {
  const wanted = new URLSearchParams(window.location.search).get('aba');
  return TABS.find((t) => t.id === wanted)?.id ?? 'visao-geral';
};

export default function EmailsPage() {
  const toast = useToast();
  const [tab, setTab] = useState<TabId>(fromUrl);
  const [days, setDays] = useState(7);
  const [data, setData] = useState<EmailOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);

  const load = useCallback(
    async (refresh = false, silent = false) => {
      if (!silent) setLoading(true);
      try {
        const next = await api.get<EmailOverview>(`/api/admin/emails/overview?days=${days}${refresh ? '&refresh=1' : ''}`);
        if (!alive.current) return;
        setData(next);
        setError(null);
      } catch (err) {
        if (!alive.current) return;
        if (!silent || !data) setError(friendlyError(err, 'Não foi possível carregar os números dos e-mails.'));
        if (refresh) toast.error('Não foi possível atualizar.', friendlyError(err, ''));
      } finally {
        if (alive.current) setLoading(false);
      }
    },
    [days, data, toast],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  // A visão geral se atualiza sozinha enquanto está na tela (a cada minuto).
  useEffect(() => {
    if (tab !== 'visao-geral') return;
    const timer = window.setInterval(() => document.visibilityState === 'visible' && void load(false, true), 60_000);
    return () => window.clearInterval(timer);
  }, [tab, load]);

  const go = (next: TabId) => {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === 'visao-geral') url.searchParams.delete('aba');
    else url.searchParams.set('aba', next);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  };

  const critical = data?.alerts.filter((a) => a.severity === 'critical').length ?? 0;
  const warning = data?.alerts.filter((a) => a.severity === 'warning').length ?? 0;

  return (
    <>
      <PageHeader
        title="E-mails e Entregabilidade"
        description="O que o sistema enviou, o que o servidor de e-mail aceitou, o que falhou e o que precisa de atenção. Números que o provedor não informa aparecem como “não informado”: nada é inventado."
      />
      <div role="tablist" aria-label="Seções" className="mb-5 flex gap-1 overflow-x-auto rounded-2xl border border-white/[0.08] bg-[#0C1018] p-1.5">
        {TABS.map((t) => {
          const badge = t.id === 'visao-geral' ? critical + warning : 0;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => go(t.id)}
              className={cx(
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]',
                tab === t.id ? 'bg-[#145CFF] text-white' : 'text-white/65 hover:bg-white/[0.06] hover:text-white',
              )}
            >
              {t.label}
              {badge > 0 && <span className={cx('grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-black', critical ? 'bg-rose-500 text-white' : 'bg-amber-300 text-black')} aria-label={`${badge} alerta(s)`}>{badge}</span>}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {error && !data ? (
          <Card>
            <ErrorState message={error} onRetry={() => void load(false)} />
          </Card>
        ) : !data ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-2xl" />
            <Skeleton className="h-48 rounded-2xl" />
          </div>
        ) : tab === 'visao-geral' ? (
          <OverviewTab data={data} days={days} setDays={setDays} loading={loading} onRefresh={() => void load(true)} goTo={go} />
        ) : tab === 'mensagens' ? (
          <MessagesTab kinds={data.kinds} />
        ) : tab === 'campanhas' ? (
          <CampaignsTab />
        ) : tab === 'supressoes' ? (
          <SuppressionsTab />
        ) : (
          <AuthenticationTab overview={data} />
        )}
      </div>
    </>
  );
}
