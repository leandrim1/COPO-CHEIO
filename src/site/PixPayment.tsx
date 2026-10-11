import { CheckCircle2, Clock, LoaderCircle, RefreshCw, TriangleAlert, WifiOff, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { money } from '../lib/format';
import type { CustomerPayment, PaymentView, PublicOrder } from '../lib/types';
import { CopyButton } from './CopyButton';
import { storeWhatsappUrl, useShop } from './data';
import { BLUE_BUTTON, GHOST_BUTTON, WHATSAPP_BUTTON, WhatsAppIcon } from './ui';

// Pagamento do pedido por Pix, na página do pedido.
//
// O que a tela faz: gera o Pix (uma vez só, mesmo que a pessoa clique de novo ou recarregue a página), mostra o QR Code e o "copia e cola",
// consulta o servidor de poucos em poucos segundos e mostra o resultado.
// O que a tela NUNCA faz: confirmar pagamento. "Já paguei" só pede ao servidor para conferir de novo; quem confirma é o servidor,
// depois que a operadora de pagamento avisa e ele consulta a cobrança.

const POLL_MS = 4000;
const POLL_HIDDEN_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

function QrCode({ text, label }: { text: string; label: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    // A biblioteca que desenha o QR Code só é baixada quando um Pix aparece na tela.
    void import('qrcode-generator').then(({ default: qrcode }) => {
      if (!alive) return;
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      setSvg(qr.createSvgTag({ cellSize: 6, margin: 0, scalable: true }));
    });
    return () => {
      alive = false;
    };
  }, [text]);
  // Fundo branco: os aplicativos dos bancos leem o QR Code escuro sobre claro.
  return (
    <div
      role="img"
      aria-label={label}
      data-pix-qr
      className="mx-auto aspect-square w-52 max-w-full rounded-2xl bg-white p-3 shadow-[0_0_40px_-10px_rgba(20,92,255,0.6)] [&_svg]:h-full [&_svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// Tempo que falta para o Pix vencer, em minutos e segundos. O relógio do aparelho pode estar errado: é só uma ajuda visual
// (o servidor é quem sabe se venceu).
function useSecondsLeft(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [iso]);
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000));
}

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

const CARD = 'rounded-[1.75rem] border p-5 sm:p-6';
const hourFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

// `base`: o endereço do pagamento do pedido (por código de acompanhamento ou pela conta).
export function PixPayment({ base, order, onSettled }: { base: string; order: PublicOrder; onSettled: () => void }) {
  const { store } = useShop();
  const [data, setData] = useState<CustomerPayment | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [checked, setChecked] = useState('');
  const settled = useRef(false);
  const started = useRef(false);
  const settledCallback = useRef(onSettled);
  settledCallback.current = onSettled;

  const accept = useCallback((next: CustomerPayment) => {
    setData(next);
    setPhase('ready');
    setOffline(false);
    setError('');
    if (next.payment?.status === 'paid' && !settled.current) {
      settled.current = true;
      settledCallback.current();
    }
  }, []);

  const load = useCallback(async () => {
    try {
      accept(await api.get<CustomerPayment>(base));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setPhase('error');
        setError('Não encontramos este pedido. Confira o link.');
      } else setOffline(true);
      return false;
    }
  }, [accept, base]);

  const create = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      accept(await api.post<CustomerPayment>(base, { method: 'pix' }));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'payments_unavailable') setPhase('unavailable');
      else {
        // Falha ao gerar: atualiza a situação (a tentativa fica registrada como falha) e mostra o motivo, com a opção de tentar de novo.
        const message = friendlyError(e, 'Não foi possível gerar o Pix agora. Tente de novo em instantes.');
        setPhase((current) => (current === 'loading' ? 'error' : current));
        await load();
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }, [accept, load, base]);

  // Ao abrir: vê como está o pagamento. Pedido sem Pix ainda → gera um (uma vez; o servidor também não deixa duplicar).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const first = await api.get<CustomerPayment>(base);
        accept(first);
        if (first.payment === null && first.order_status === 'awaiting_payment') await create();
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          setPhase('error');
          setError('Não encontramos este pedido. Confira o link.');
        } else {
          setPhase('error');
          setError(friendlyError(e, 'Não foi possível carregar o pagamento. Tente de novo.'));
        }
      }
    })();
  }, [accept, create, base]);

  // Enquanto aguarda: pergunta ao servidor de poucos em poucos segundos (mais devagar com a aba escondida; mais devagar ainda se a conexão falha).
  const status = data?.payment?.status;
  const waiting = status === 'pending' || status === 'creating';
  useEffect(() => {
    if (!waiting) return;
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    const tick = async () => {
      const ok = await load();
      failures = ok ? 0 : failures + 1;
      if (alive) schedule();
    };
    const schedule = () => {
      window.clearTimeout(timer);
      const interval = document.visibilityState === 'visible' ? POLL_MS : POLL_HIDDEN_MS;
      timer = window.setTimeout(() => void tick(), failures ? Math.min(interval * 2 ** failures, MAX_BACKOFF_MS) : interval);
    };
    const wake = () => {
      if (document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        void tick();
      }
    };
    schedule();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [waiting, load]);

  const payment: PaymentView | null = data?.payment ?? null;
  const left = useSecondsLeft(payment?.status === 'pending' ? payment.expires_at : null);
  // Passou da validade no relógio daqui: confere já com o servidor (a operadora é quem diz se venceu).
  useEffect(() => {
    if (left === 0 && payment?.status === 'pending') void load();
  }, [left, payment?.status, load]);

  const whatsapp = storeWhatsappUrl(store, `Olá, ${store.store_name}! Preciso de ajuda com o pagamento do pedido #${order.order_number}.`);

  const verify = async () => {
    setBusy(true);
    setChecked('');
    const ok = await load();
    setBusy(false);
    setChecked(ok ? 'Ainda não recebemos o pagamento. Pode levar alguns segundos depois de pagar; esta tela confere sozinha.' : 'Não foi possível conferir agora. Tente de novo.');
  };

  if (phase === 'loading') {
    return (
      <section aria-labelledby="pix-titulo" className={`${CARD} border-white/10 bg-white/[0.03]`}>
        <h2 id="pix-titulo" className="sr-only">
          Pagamento com Pix
        </h2>
        <p role="status" className="flex items-center justify-center gap-2 py-6 text-white/75">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Gerando o seu Pix…
        </p>
      </section>
    );
  }

  if (phase === 'unavailable') {
    return (
      <section aria-labelledby="pix-titulo" className={`${CARD} border-amber-400/30 bg-amber-400/10`}>
        <h2 id="pix-titulo" className="flex items-center gap-2 text-lg font-black text-amber-100">
          <TriangleAlert className="h-5 w-5" aria-hidden="true" /> O pagamento online não está disponível agora
        </h2>
        <p className="mt-2 text-sm text-amber-50/85">Não conseguimos gerar o seu Pix. Fale com a loja pelo WhatsApp para combinar outra forma de pagar.</p>
        <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-4 w-full sm:w-auto`}>
          <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
        </a>
      </section>
    );
  }

  if (phase === 'error' || !payment) {
    return (
      <section aria-labelledby="pix-titulo" className={`${CARD} border-rose-400/30 bg-rose-500/10`}>
        <h2 id="pix-titulo" className="flex items-center gap-2 text-lg font-black text-rose-100">
          <TriangleAlert className="h-5 w-5" aria-hidden="true" /> Não foi possível mostrar o Pix
        </h2>
        <p role="alert" className="mt-2 text-sm text-rose-50/85">
          {error || 'Tente de novo em instantes.'}
        </p>
        <button type="button" onClick={() => void create()} disabled={busy} className={`${BLUE_BUTTON} mt-4 w-full disabled:opacity-60 sm:w-auto`}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          Tentar de novo
        </button>
      </section>
    );
  }

  // ---- Pago -------------------------------------------------------------------------------------------------------------------
  if (payment.status === 'paid' || payment.status === 'refunded') {
    const cancelled = data?.order_status === 'cancelled';
    return (
      <section aria-labelledby="pix-titulo" data-pix-state={payment.status} className={`${CARD} ${cancelled ? 'border-amber-400/30 bg-amber-400/10' : 'border-emerald-400/30 bg-emerald-400/10'}`}>
        <h2 id="pix-titulo" className={`flex items-center gap-2 text-lg font-black ${cancelled ? 'text-amber-100' : 'text-emerald-100'}`}>
          {cancelled ? <TriangleAlert className="h-5 w-5" aria-hidden="true" /> : <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
          {payment.status === 'refunded' ? 'Pagamento estornado' : cancelled ? 'Pagamento recebido, pedido cancelado' : 'Pagamento confirmado!'}
        </h2>
        <p role="status" className="mt-2 text-sm text-white/80">
          {payment.message ??
            `Recebemos o seu Pix de ${money(payment.amount)}. A ${store.store_name} já recebeu o pedido #${order.order_number} e vai preparar tudo.`}
        </p>
        {cancelled && (
          <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-4 w-full sm:w-auto`}>
            <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
          </a>
        )}
      </section>
    );
  }

  // ---- Venceu, foi cancelado ou falhou ----------------------------------------------------------------------------------------
  if (payment.status === 'expired' || payment.status === 'cancelled' || payment.status === 'failed') {
    const closedOrder = data?.order_status === 'cancelled';
    return (
      <section aria-labelledby="pix-titulo" data-pix-state={payment.status} className={`${CARD} border-amber-400/30 bg-amber-400/10`}>
        <h2 id="pix-titulo" className="flex items-center gap-2 text-lg font-black text-amber-100">
          <XCircle className="h-5 w-5" aria-hidden="true" />{' '}
          {closedOrder ? 'Pedido cancelado' : payment.status === 'expired' ? 'O Pix venceu' : payment.status === 'cancelled' ? 'Este Pix foi cancelado' : 'Não foi possível gerar o Pix'}
        </h2>
        <p role="status" className="mt-2 text-sm text-amber-50/90">
          {closedOrder
            ? 'Como o pagamento não foi feito a tempo, este pedido foi cancelado e os itens voltaram para o estoque. Faça um novo pedido quando quiser.'
            : payment.can_retry
              ? `${payment.status === 'failed' ? 'O banco não respondeu a tempo.' : (payment.message ?? 'Este Pix não vale mais.')} ${payment.status === 'failed' ? 'Tente de novo' : 'Gere outro Pix'} para manter o seu pedido${payment.retry_until ? ` (até ${hourFormat.format(new Date(payment.retry_until))})` : ''}.`
              : (payment.message ?? 'Este Pix não vale mais.')}
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm font-semibold text-rose-200">
            {error}
          </p>
        )}
        {!closedOrder && payment.can_retry ? (
          <button type="button" onClick={() => void create()} disabled={busy} className={`${BLUE_BUTTON} mt-4 w-full disabled:opacity-60 sm:w-auto`}>
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
            {payment.status === 'failed' ? 'Tentar de novo' : 'Gerar novo Pix'}
          </button>
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {!closedOrder && (
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={WHATSAPP_BUTTON}>
                <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
              </a>
            )}
            <a href="/bebidas" className={GHOST_BUTTON}>
              Fazer um novo pedido
            </a>
          </div>
        )}
      </section>
    );
  }

  // ---- Criando / aguardando o pagamento ---------------------------------------------------------------------------------------
  const pending = payment.status === 'pending' && payment.pix;
  return (
    <section aria-labelledby="pix-titulo" data-pix-state={payment.status} className={`${CARD} border-[#145CFF]/40 bg-gradient-to-b from-[#145CFF]/15 via-[#0B1230] to-transparent`}>
      <h2 id="pix-titulo" className="text-xl font-black text-white">
        Pague com <span className="text-[#2563FF] [text-shadow:0_0_24px_rgba(20,92,255,0.6)]">Pix</span>
      </h2>
      <p className="mt-1 text-sm text-white/70">Assim que o banco confirmar, o pedido segue para a loja. Seu pedido só é enviado depois do pagamento.</p>

      {!pending ? (
        <p role="status" className="flex items-center justify-center gap-2 py-8 text-white/75">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Gerando o seu Pix…
        </p>
      ) : (
        <>
          <div className="mt-5 grid gap-5 md:grid-cols-[auto_1fr] md:items-start">
            <div>
              <QrCode text={payment.pix!.payload} label={`QR Code do Pix de ${money(payment.amount)}`} />
              <p className="mt-2 text-center text-xs text-white/60">Aponte a câmera do app do seu banco</p>
            </div>
            <div className="min-w-0">
              <p className="text-sm text-white/65">Valor a pagar</p>
              <p className="text-3xl font-black tabular-nums text-white">{money(payment.amount)}</p>
              <label htmlFor="pix-copia-e-cola" className="mt-4 block text-sm font-semibold text-white">
                Pix copia e cola
              </label>
              <textarea
                id="pix-copia-e-cola"
                readOnly
                rows={4}
                value={payment.pix!.payload}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 w-full resize-none break-all rounded-2xl border border-white/15 bg-black/30 p-3 font-mono text-xs leading-relaxed text-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5B8CFF]"
              />
              <CopyButton text={payment.pix!.payload} label="Copiar código Pix" done="Código copiado!" className={`${BLUE_BUTTON} mt-3 w-full sm:w-auto`} />
              <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-white/70">
                <li>Abra o app do seu banco e vá em Pix.</li>
                <li>Escolha “Pagar com QR Code” ou “Pix copia e cola”.</li>
                <li>Confira o valor e confirme o pagamento.</li>
              </ol>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/10 pt-4 text-sm">
            <p role="status" className="inline-flex items-center gap-2 font-semibold text-[#8FB1FF]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-[#2563FF]" aria-hidden="true" />
              Aguardando o pagamento…
            </p>
            {left !== null && (
              <p className="inline-flex items-center gap-1.5 text-white/65">
                <Clock className="h-4 w-4" aria-hidden="true" />
                <span data-pix-countdown className="tabular-nums">
                  {left > 0 ? `Vence em ${clock(left)}` : 'Conferindo se venceu…'}
                </span>
              </p>
            )}
            <button type="button" onClick={() => void verify()} disabled={busy} className={`${GHOST_BUTTON} !px-4 !py-2 text-sm disabled:opacity-60 sm:ml-auto`}>
              {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Já paguei, conferir agora
            </button>
          </div>
          {checked && (
            <p role="status" className="mt-2 text-xs text-white/65">
              {checked}
            </p>
          )}
        </>
      )}

      {offline && (
        <p role="status" className="mt-3 flex items-center gap-2 text-xs text-amber-200">
          <WifiOff className="h-4 w-4" aria-hidden="true" /> Sem conexão com o servidor. Tentando de novo…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm font-semibold text-rose-200">
          {error}
        </p>
      )}
    </section>
  );
}
