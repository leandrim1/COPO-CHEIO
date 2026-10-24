// Medição de visitas (Google Analytics 4), opcional e só com o consentimento da pessoa.
//
//  • Só existe se a loja cadastrou o identificador (variável GA_MEASUREMENT_ID no servidor; ela chega aqui por /api/site → analytics_id). Sem identificador, nada
//    deste arquivo faz nada: nenhum script é baixado, nenhum aviso aparece.
//  • Com identificador, o script do Google só é baixado DEPOIS de a pessoa tocar em "Aceitar". "Recusar" (ou não responder) = nenhuma conexão com o Google.
//  • Nunca vão para a medição: nome, telefone, e-mail, endereço, código de acompanhamento, dados do cartão ou o conteúdo do pedido; só o valor total e o número do pedido.
//    O endereço da página é reduzido ao tipo da página (/pedido/ABC123 vira /pedido); o painel e a tela do cartão nunca são medidos.
//  • A política de segurança do site (vercel.json) só deixa o Google carregar depois de a loja liberar os endereços dele: veja docs/PWA-SEO-ANALYTICS.md.
//
// Mudou o texto do aviso? Troque a versão: todo mundo vê a pergunta de novo.
const STORAGE_KEY = 'copocheio:analytics-v1';
const ID_PATTERN = /^G-[A-Z0-9]{4,14}$/;

export type Consent = 'granted' | 'denied' | null;

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

let measurementId: string | null = null;
let loaded = false;
let lastPage = '';
const listeners = new Set<() => void>();

export const isMeasurementId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);

export function readConsent(): Consent {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export { subscribe as subscribeConsent };

// A pessoa escolheu (ou voltou atrás nas Preferências). Recusar depois de aceitar interrompe a medição na hora (o script já carregado fica quieto) e apaga os cookies.
export function setConsent(value: 'granted' | 'denied'): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* sem armazenamento: vale até recarregar a página */
  }
  if (value === 'granted') load();
  else forget();
  listeners.forEach((listener) => listener());
}

function load(): void {
  if (loaded || !measurementId || readConsent() !== 'granted') return;
  loaded = true;
  window.dataLayer = window.dataLayer ?? [];
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag('js', new Date());
  // Sem anúncios nem perfis: só a contagem de visitas. A visita à página é enviada à mão (trackPage), não pelo script, para a gente controlar o que vai.
  window.gtag('config', measurementId, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, cookie_flags: 'SameSite=Lax;Secure' });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
}

// Apaga o que a medição guardou neste aparelho (cookies _ga*) e o aviso de que já mediu.
function forget(): void {
  if (measurementId) (window as unknown as Record<string, unknown>)[`ga-disable-${measurementId}`] = true;
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (name === '_ga' || name.startsWith('_ga_')) document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
  }
}

export function initAnalytics(id: string | null): void {
  const next = id && isMeasurementId(id) ? id : null;
  const changed = next !== measurementId;
  measurementId = next;
  if (measurementId) load();
  if (changed) listeners.forEach((listener) => listener());
}

export const analyticsConfigured = (): boolean => measurementId !== null;

// O tipo da página, sem nada que identifique pessoa ou pedido. `null` = não medir.
export function sanitizePath(pathname: string): string | null {
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return null;
  if (pathname.startsWith('/pedido/')) return '/pedido';
  if (pathname === '/acompanhar-pedido' || pathname.startsWith('/acompanhar-pedido/')) return '/acompanhar-pedido';
  if (pathname === '/conta' || pathname.startsWith('/conta/')) return '/conta';
  if (/^\/[a-z0-9-]*$/.test(pathname)) return pathname || '/';
  return null;
}

function send(name: string, params: Record<string, unknown>): void {
  if (!measurementId || !loaded || readConsent() !== 'granted' || typeof window.gtag !== 'function') return;
  window.gtag('event', name, params);
}

// Uma visita por troca de página (React em modo estrito roda o efeito duas vezes; repetir a mesma página em seguida não conta de novo).
export function trackPage(pathname: string): void {
  const path = sanitizePath(pathname);
  if (!path || path === lastPage) return;
  lastPage = path;
  send('page_view', { page_path: path, page_location: `${window.location.origin}${path}`, page_title: document.title });
}

// Eventos do funil de compra. Só valores (nada de nome, telefone, endereço ou código de acompanhamento).
const seenEvents = new Set<string>();
export function trackOnce(key: string, name: 'begin_checkout' | 'purchase', params: { value: number; currency?: 'BRL'; payment_type?: string; transaction_id?: string }): void {
  if (seenEvents.has(key)) return;
  seenEvents.add(key);
  send(name, { currency: 'BRL', ...params });
}
