import { useEffect, useSyncExternalStore } from 'react';
import { analyticsConfigured, readConsent, setConsent, subscribeConsent, trackPage } from '../lib/analytics';

// Aviso de medição de visitas. Só aparece se a loja ligou a medição (GA_MEASUREMENT_ID) e a pessoa ainda não escolheu. Fica fora do portão +18 e some assim que
// ela escolhe. Mede a visita à página (sem dados pessoais) somente depois do "Aceitar".
//
// Quem já escolheu pode mudar de ideia na Política de privacidade (botão "Preferências de medição").

const PRIVATE_PAGES = new Set(['pagar']);

export function AnalyticsConsent({ page, pathname, enabled }: { page: string; pathname: string; enabled: boolean }) {
  const consent = useSyncExternalStore(subscribeConsent, readConsent, () => null);
  const configured = useSyncExternalStore(subscribeConsent, analyticsConfigured, () => false);

  useEffect(() => {
    if (enabled && consent === 'granted') trackPage(pathname);
  }, [enabled, consent, pathname]);

  if (!enabled || !configured || consent !== null || PRIVATE_PAGES.has(page)) return null;
  return (
    <section
      aria-label="Medição de visitas"
      data-analytics-consent
      className="fixed inset-x-3 bottom-3 z-[60] mx-auto max-w-xl rounded-2xl border border-white/15 bg-[#0A0D14]/95 p-4 text-sm text-white shadow-[0_20px_60px_-20px_rgba(0,0,0,0.9)] backdrop-blur-md [padding-bottom:max(1rem,env(safe-area-inset-bottom))]"
    >
      <p className="text-white/80">
        Podemos contar as visitas ao site para melhorar o cardápio? Usamos o Google Analytics, sem anúncios e sem seu nome, telefone ou endereço. Você pode mudar de ideia na{' '}
        <a href="/privacidade" className="font-semibold text-[#8FB1FF] underline underline-offset-4 hover:text-white">
          Política de privacidade
        </a>
        .
      </p>
      <div className="mt-3 flex gap-3">
        <button
          type="button"
          data-analytics-accept
          onClick={() => setConsent('granted')}
          className="min-h-11 flex-1 rounded-full bg-[#145CFF] px-5 text-sm font-extrabold text-white transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Aceitar
        </button>
        <button
          type="button"
          data-analytics-deny
          onClick={() => setConsent('denied')}
          className="min-h-11 flex-1 rounded-full border border-white/25 bg-white/5 px-5 text-sm font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Recusar
        </button>
      </div>
    </section>
  );
}
