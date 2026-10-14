import { CheckCircle2, CreditCard, LoaderCircle, Lock, RefreshCw, TriangleAlert, WifiOff, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { digitsOf, expiryForProvider, luhnOk, maskCardNumber, maskDocument, maskExpiry, validDocument } from '../lib/cardInput';
import { money } from '../lib/format';
import type { CustomerPayment, PublicOrder } from '../lib/types';
import { storeWhatsappUrl, useShop } from './data';
import { Field, PageShell } from './shell';
import { BLUE_BUTTON, FIELD, GHOST_BUTTON, WHATSAPP_BUTTON, WhatsAppIcon } from './ui';

// Pagamento do pedido por cartão de crédito (/pagar/<código do pedido>).
//
// Esta é uma página à parte, aberta do zero (não uma troca de tela dentro do site): o SDK da operadora (@validapay/tokenize) e o antifraude dela
// precisam de permissões de segurança que o resto do site não tem (ver vercel.json), então só esta página as recebe.
//
// O CARTÃO NUNCA PASSA PELA LOJA: o número, a validade e o código de segurança vão direto do navegador para a operadora, que devolve um token de uso
// único (vale 5 minutos). Só o token, o identificador do dispositivo e o CPF/CNPJ vão para o servidor da loja. Nada do cartão é guardado (nem
// no armazenamento do navegador) nem escrito no console. O valor cobrado NÃO sai desta página: o servidor usa o total gravado no pedido.
//
// O que a tela NUNCA faz: aprovar o pagamento. Quem confirma é o servidor, depois de consultar a operadora. Voltar para esta página, recarregar ou
// clicar de novo só mostra o estado que o servidor tem (e nunca cobra de novo).

const POLL_MS = 4000;
const POLL_HIDDEN_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
// Sem resposta da operadora: depois deste tempo a pessoa pode tentar de novo (o servidor reaproveita a cobrança que talvez já exista).
const RETRY_AFTER_MS = 60_000;
const CUSTOMER_KEY = 'copocheio:cliente';
const CARD = 'rounded-[1.75rem] border p-5 sm:p-6';

type Sdk = typeof import('@validapay/tokenize/browser');

// O que o formulário de checkout guardou neste aparelho (nome e e-mail), só para adiantar o preenchimento. Nunca o cartão.
function savedCustomer(): { name: string; email: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOMER_KEY) ?? '{}') as { name?: unknown; email?: unknown };
    return { name: typeof saved.name === 'string' ? saved.name : '', email: typeof saved.email === 'string' ? saved.email : '' };
  } catch {
    return { name: '', email: '' };
  }
}

type Fields = { number: string; holder: string; expiry: string; cvv: string; document: string; email: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

export function CardPaymentPage({ token }: { token: string }) {
  const { store } = useShop();
  const base = `/api/tracking/${encodeURIComponent(token)}`;
  const [phase, setPhase] = useState<'loading' | 'missing' | 'error' | 'ready'>('loading');
  const [order, setOrder] = useState<PublicOrder | null>(null);
  const [data, setData] = useState<CustomerPayment | null>(null);
  const [offline, setOffline] = useState(false);
  const [fields, setFields] = useState<Fields>(() => {
    const saved = savedCustomer();
    return { number: '', holder: saved.name.toUpperCase(), expiry: '', cvv: '', document: '', email: saved.email };
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [forceForm, setForceForm] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const busyRef = useRef(false);
  const sdkRef = useRef<Promise<Sdk> | null>(null);
  const deviceRef = useRef<Promise<string | null> | null>(null);

  const loadPayment = useCallback(async (): Promise<boolean> => {
    try {
      const next = await api.get<CustomerPayment>(`${base}/payment`);
      setData(next);
      setOffline(false);
      setPhase('ready');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setPhase('missing');
      else setOffline(true);
      return false;
    }
  }, [base]);

  const loadOrder = useCallback(async () => {
    try {
      const { order: next } = await api.get<{ order: PublicOrder }>(base);
      setOrder(next);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) setPhase('missing');
    }
  }, [base]);

  // Ao abrir (e ao recarregar): vê como está o pedido e o pagamento. Nada é cobrado por abrir a página.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [{ order: first }, payment] = await Promise.all([api.get<{ order: PublicOrder }>(base), api.get<CustomerPayment>(`${base}/payment`)]);
        if (!alive) return;
        setOrder(first);
        setData(payment);
        setPhase('ready');
      } catch (error) {
        if (!alive) return;
        setPhase(error instanceof ApiError && error.status === 404 ? 'missing' : 'error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [base]);

  const status = data?.payment?.status;
  const waiting = status === 'pending' || status === 'creating';

  // Aguardando a operadora: pergunta ao servidor de poucos em poucos segundos (mais devagar com a aba escondida ou com a conexão falhando).
  useEffect(() => {
    if (!waiting) {
      setWaitingSince(null);
      return;
    }
    setWaitingSince((current) => current ?? Date.now());
    let alive = true;
    let timer: number | undefined;
    let failures = 0;
    const tick = async () => {
      const ok = await loadPayment();
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
    const clock = window.setInterval(() => setNow(Date.now()), 5000);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(clock);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [waiting, loadPayment]);

  // Mudou para "pago": traz o pedido de novo (o status do pedido mudou).
  useEffect(() => {
    if (status === 'paid') void loadOrder();
  }, [status, loadOrder]);

  // Enquanto o cartão está sendo cobrado, fechar a aba seria arriscado: o navegador pergunta antes.
  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);

  const checkout = data?.card_checkout ?? null;
  const payment = data?.payment ?? null;
  const awaitingPayment = data?.order_status === 'awaiting_payment';
  const showForm =
    phase === 'ready' && awaitingPayment && checkout !== null && (payment === null || ((payment.status === 'failed' || payment.status === 'cancelled' || payment.status === 'expired') && payment.can_retry) || (payment.status === 'creating' && forceForm));

  // O SDK e o antifraude só são baixados quando o formulário aparece, e o identificador do dispositivo é pedido uma vez.
  useEffect(() => {
    if (!showForm || !checkout || deviceRef.current) return;
    const sdk = import('@validapay/tokenize/browser');
    sdkRef.current = sdk;
    deviceRef.current = sdk
      .then((mod) => mod.collectDevice({ publicId: checkout.public_id, environment: checkout.environment }))
      .then((result) => result.deviceId)
      .catch(() => null);
  }, [showForm, checkout]);

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    if (!luhnOk(fields.number)) next.number = 'Confira o número do cartão.';
    if (fields.holder.trim().length < 2) next.holder = 'Informe o nome como está no cartão.';
    if (!expiryForProvider(fields.expiry)) next.expiry = 'Confira a validade (MM/AA).';
    if (!/^\d{3,4}$/.test(fields.cvv)) next.cvv = 'O código de segurança tem 3 ou 4 números.';
    if (!validDocument(fields.document)) next.document = 'Confira o CPF (ou CNPJ) de quem paga.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fields.email.trim())) next.email = 'Confira o e-mail.';
    return next;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // Um clique só: enquanto uma tentativa está em andamento, outro clique (ou Enter) não faz nada.
    if (busyRef.current || !checkout || !order) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice('');
    let sdk: Sdk | null = null;
    try {
      sdk = await (sdkRef.current ?? import('@validapay/tokenize/browser'));
      const deviceId = await (deviceRef.current ?? Promise.resolve(null));
      if (!deviceId) {
        // Sem o identificador do dispositivo a operadora não aceita a cobrança. Pede outro na próxima tentativa.
        deviceRef.current = sdk.collectDevice({ publicId: checkout.public_id, environment: checkout.environment }).then((r) => r.deviceId).catch(() => null);
        setNotice('Não foi possível validar o seu aparelho agora. Confira a conexão e tente de novo.');
        return;
      }
      // O cartão vai direto para a operadora, que devolve o token. É a única vez que o número e o código de segurança são lidos.
      const issued = await sdk.tokenize({
        publicId: checkout.public_id,
        environment: checkout.environment,
        card: { number: digitsOf(fields.number), holderName: fields.holder.trim(), cvv: fields.cvv, expiration: expiryForProvider(fields.expiry)! },
        customer: { document: digitsOf(fields.document), name: order.customer_name, email: fields.email.trim() },
      });
      // Número e código de segurança somem da tela e da memória do formulário assim que viram token.
      setFields((f) => ({ ...f, number: '', cvv: '' }));
      const next = await api.post<CustomerPayment>(`${base}/payment/card`, { card_token: issued.cardToken, device_id: deviceId, document: digitsOf(fields.document) });
      setData(next);
      setOffline(false);
      setForceForm(false);
      if (next.payment?.status === 'failed') setNotice(next.payment.message ?? 'O cartão não foi aprovado. Confira os dados ou use outro cartão.');
    } catch (error) {
      // O token pode já ter sido usado: nunca é reaproveitado. Número e código de segurança saem da tela de qualquer jeito.
      setFields((f) => ({ ...f, number: '', cvv: '' }));
      if (sdk && error instanceof sdk.ValidaPayError) {
        setNotice(error.message && error.message.length <= 160 ? error.message : 'Não foi possível validar o cartão. Confira os dados e tente de novo.');
      } else if (error instanceof ApiError && (error.code === 'payment_in_progress' || error.code === 'card_unconfirmed' || error.status === 0)) {
        // Em andamento ou sem confirmação: a loja não sabe se cobrou. Mostra o que o servidor tem e NÃO deixa pagar de novo agora.
        setForceForm(false);
        setNotice(error.status === 0 ? 'Perdemos a conexão no meio do pagamento. Não pague de novo ainda: estamos conferindo.' : error.message);
        await loadPayment();
      } else {
        setNotice(friendlyError(error, 'Não foi possível processar o pagamento. Tente de novo em instantes.'));
        await loadPayment();
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const whatsapp = storeWhatsappUrl(store, `Olá, ${store.store_name}! Preciso de ajuda com o pagamento do pedido #${order?.order_number ?? ''}.`);
  const orderLink = `/pedido/${encodeURIComponent(token)}`;

  // ---- Telas ----------------------------------------------------------------------------------------------------------------

  if (phase === 'loading') {
    return (
      <PageShell back={orderLink} backLabel="Meu pedido">
        <p role="status" className="mt-16 flex items-center justify-center gap-2 text-white/75">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Carregando o pagamento…
        </p>
      </PageShell>
    );
  }

  if (phase === 'missing' || phase === 'error' || !order || !data) {
    return (
      <PageShell back="/acompanhar-pedido" backLabel="Acompanhar pedido">
        <section className={`${CARD} mx-auto mt-10 max-w-lg border-rose-400/30 bg-rose-500/10`} role="alert">
          <h1 className="flex items-center gap-2 text-lg font-black text-rose-100">
            <TriangleAlert className="h-5 w-5" aria-hidden="true" /> {phase === 'missing' ? 'Não encontramos este pedido' : 'Não foi possível abrir o pagamento'}
          </h1>
          <p className="mt-2 text-sm text-rose-50/85">{phase === 'missing' ? 'Confira o link do pedido.' : 'Confira a conexão e tente de novo.'}</p>
          {phase === 'error' && (
            <button type="button" onClick={() => window.location.reload()} className={`${BLUE_BUTTON} mt-4`}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Tentar de novo
            </button>
          )}
        </section>
      </PageShell>
    );
  }

  // Pedido que não é de cartão online: aqui não há o que pagar.
  if (order.payment_method !== 'card_online') {
    return (
      <PageShell back={orderLink} backLabel="Meu pedido">
        <section className={`${CARD} mx-auto mt-10 max-w-lg border-white/10 bg-white/[0.04]`}>
          <h1 className="text-lg font-black text-white">Este pedido não é de cartão online</h1>
          <a href={orderLink} className={`${BLUE_BUTTON} mt-4`}>
            Ver meu pedido
          </a>
        </section>
      </PageShell>
    );
  }

  const paid = payment?.status === 'paid' || payment?.status === 'refunded';
  const cancelled = data.order_status === 'cancelled';
  const sandbox = checkout?.environment === 'sandbox';
  const fee = order.payment_fee;

  return (
    <PageShell back={orderLink} backLabel="Meu pedido">
      <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
        Pagamento com <span className="text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">cartão</span>
      </h1>
      <p className="mt-2 text-white/60">
        Pedido <strong className="text-white">#{order.order_number}</strong> · {store.store_name}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-5">
          {sandbox && showForm && (
            <p data-card-sandbox className="rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
              <strong>Ambiente de testes:</strong> nenhuma cobrança real é feita. Use um cartão de teste da operadora.
            </p>
          )}

          {paid ? (
            <section data-card-state={payment?.status} className={`${CARD} ${cancelled ? 'border-amber-400/30 bg-amber-400/10' : 'border-emerald-400/30 bg-emerald-400/10'}`}>
              <h2 className={`flex items-center gap-2 text-lg font-black ${cancelled ? 'text-amber-100' : 'text-emerald-100'}`}>
                {cancelled ? <TriangleAlert className="h-5 w-5" aria-hidden="true" /> : <CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
                {payment?.status === 'refunded' ? 'Pagamento estornado' : cancelled ? 'Pagamento recebido, pedido cancelado' : 'Pagamento aprovado!'}
              </h2>
              <p role="status" className="mt-2 text-sm text-white/80">
                {payment?.message ?? `Recebemos ${money(payment?.amount ?? order.total)} no seu cartão. A ${store.store_name} já recebeu o pedido #${order.order_number} e vai preparar tudo.`}
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <a href={orderLink} className={BLUE_BUTTON}>
                  Acompanhar meu pedido
                </a>
                {cancelled && (
                  <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={WHATSAPP_BUTTON}>
                    <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
                  </a>
                )}
              </div>
            </section>
          ) : cancelled ? (
            <section data-card-state="cancelled" className={`${CARD} border-amber-400/30 bg-amber-400/10`}>
              <h2 className="flex items-center gap-2 text-lg font-black text-amber-100">
                <XCircle className="h-5 w-5" aria-hidden="true" /> Pedido cancelado
              </h2>
              <p role="status" className="mt-2 text-sm text-amber-50/90">Como o pagamento não foi concluído a tempo, este pedido foi cancelado e os itens voltaram para o estoque. Faça um novo pedido quando quiser.</p>
              <a href="/bebidas" className={`${GHOST_BUTTON} mt-4`}>
                Fazer um novo pedido
              </a>
            </section>
          ) : waiting && !showForm ? (
            <section data-card-state={status} aria-labelledby="cartao-espera" className={`${CARD} border-[#145CFF]/40 bg-gradient-to-b from-[#145CFF]/15 via-[#0B1230] to-transparent`}>
              <h2 id="cartao-espera" className="flex items-center gap-2 text-lg font-black text-white">
                <LoaderCircle className="h-5 w-5 animate-spin text-[#8FB1FF]" aria-hidden="true" />
                {status === 'creating' ? 'Estamos processando o pagamento' : 'Aguardando a confirmação do banco'}
              </h2>
              <p role="status" className="mt-2 text-sm text-white/80">
                {payment?.message ?? 'Não feche esta tela e não pague de novo.'} Assim que o banco responder, esta tela se atualiza sozinha.
              </p>
              {notice && (
                <p role="alert" className="mt-3 text-sm font-semibold text-amber-100">
                  {notice}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="button" onClick={() => void loadPayment()} className={`${GHOST_BUTTON} !px-4 !py-2 text-sm`}>
                  <RefreshCw className="h-4 w-4" aria-hidden="true" /> Conferir agora
                </button>
                {status === 'creating' && waitingSince !== null && now - waitingSince >= RETRY_AFTER_MS && (
                  <button type="button" onClick={() => setForceForm(true)} className={`${GHOST_BUTTON} !px-4 !py-2 text-sm`}>
                    Tentar pagar de novo
                  </button>
                )}
              </div>
              {status === 'creating' && waitingSince !== null && now - waitingSince >= RETRY_AFTER_MS && (
                <p className="mt-2 text-xs text-white/60">Se o valor já tiver saído da sua conta, ele é reconhecido na nova tentativa e você não paga duas vezes.</p>
              )}
            </section>
          ) : payment && (payment.status === 'failed' || payment.status === 'cancelled' || payment.status === 'expired') && !payment.can_retry ? (
            <section data-card-state={payment.status} className={`${CARD} border-amber-400/30 bg-amber-400/10`}>
              <h2 className="flex items-center gap-2 text-lg font-black text-amber-100">
                <XCircle className="h-5 w-5" aria-hidden="true" /> Não foi possível concluir o pagamento
              </h2>
              <p role="status" className="mt-2 text-sm text-amber-50/90">{payment.message ?? 'O cartão não foi aprovado.'} Fale com a loja para combinar outra forma de pagar.</p>
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-4`}>
                <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
              </a>
            </section>
          ) : !checkout ? (
            <section data-card-state="unavailable" className={`${CARD} border-amber-400/30 bg-amber-400/10`}>
              <h2 className="flex items-center gap-2 text-lg font-black text-amber-100">
                <TriangleAlert className="h-5 w-5" aria-hidden="true" /> O pagamento por cartão não está disponível agora
              </h2>
              <p className="mt-2 text-sm text-amber-50/85">Seu pedido está salvo. Fale com a loja pelo WhatsApp para combinar outra forma de pagar.</p>
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-4`}>
                <WhatsAppIcon className="h-5 w-5" /> Falar com a loja
              </a>
            </section>
          ) : (
            <form onSubmit={submit} noValidate autoComplete="on" aria-labelledby="cartao-titulo" data-card-form className={`${CARD} border-[#145CFF]/40 bg-gradient-to-b from-[#145CFF]/15 via-[#0B1230] to-transparent`}>
              <h2 id="cartao-titulo" className="flex items-center gap-2 text-xl font-black text-white">
                <CreditCard className="h-5 w-5 text-[#8FB1FF]" aria-hidden="true" /> Dados do cartão de crédito
              </h2>
              <p className="mt-1 flex items-start gap-2 text-sm text-white/70">
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB1FF]" aria-hidden="true" />
                <span>Os dados do cartão vão direto para a operadora de pagamento. Este site não guarda o número nem o código de segurança. Pagamento à vista.</span>
              </p>

              {(notice || payment?.status === 'failed') && (
                <p role="alert" data-card-notice className="mt-4 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {notice || payment?.message || 'O cartão não foi aprovado. Confira os dados ou use outro cartão.'}
                </p>
              )}

              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <Field label="Número do cartão *" error={errors.number} className="sm:col-span-2">
                  {(p) => (
                    <input
                      {...p}
                      name="cardnumber"
                      value={fields.number}
                      onChange={(e) => set('number', maskCardNumber(e.target.value))}
                      inputMode="numeric"
                      autoComplete="cc-number"
                      maxLength={23}
                      className={FIELD}
                      placeholder="0000 0000 0000 0000"
                      spellCheck={false}
                      data-card-number
                    />
                  )}
                </Field>
                <Field label="Nome impresso no cartão *" error={errors.holder} className="sm:col-span-2">
                  {(p) => <input {...p} name="ccname" value={fields.holder} onChange={(e) => set('holder', e.target.value.toUpperCase())} autoComplete="cc-name" maxLength={60} className={FIELD} placeholder="NOME COMO NO CARTÃO" />}
                </Field>
                <Field label="Validade *" error={errors.expiry}>
                  {(p) => (
                    <input {...p} name="cc-exp" value={fields.expiry} onChange={(e) => set('expiry', maskExpiry(e.target.value))} inputMode="numeric" autoComplete="cc-exp" maxLength={5} className={FIELD} placeholder="MM/AA" data-card-expiry />
                  )}
                </Field>
                <Field label="Código de segurança *" error={errors.cvv}>
                  {(p) => (
                    <input
                      {...p}
                      name="cvc"
                      type="password"
                      value={fields.cvv}
                      onChange={(e) => set('cvv', digitsOf(e.target.value).slice(0, 4))}
                      inputMode="numeric"
                      autoComplete="cc-csc"
                      maxLength={4}
                      className={FIELD}
                      placeholder="CVV"
                      data-card-cvv
                    />
                  )}
                </Field>
                <Field label="CPF ou CNPJ de quem paga *" error={errors.document}>
                  {(p) => <input {...p} name="document" value={fields.document} onChange={(e) => set('document', maskDocument(e.target.value))} inputMode="numeric" autoComplete="off" maxLength={18} className={FIELD} placeholder="000.000.000-00" data-card-document />}
                </Field>
                <Field label="E-mail do comprovante *" error={errors.email}>
                  {(p) => <input {...p} name="email" type="email" value={fields.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" maxLength={254} className={FIELD} placeholder="voce@email.com" />}
                </Field>
              </div>

              <button type="submit" disabled={busy} data-card-submit className={`${BLUE_BUTTON} mt-6 w-full py-4 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100`}>
                {busy ? (
                  <>
                    <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" /> Processando… não feche esta tela
                  </>
                ) : (
                  <>Pagar {money(order.total)} no cartão</>
                )}
              </button>
              <p className="mt-3 text-center text-xs text-white/60">
                O valor cobrado é o total do pedido, já com a taxa do cartão de {money(fee)}. Você será cobrado(a) uma única vez.
              </p>
            </form>
          )}

          {offline && (
            <p role="status" className="flex items-center gap-2 text-xs text-amber-200">
              <WifiOff className="h-4 w-4" aria-hidden="true" /> Sem conexão com o servidor. Tentando de novo…
            </p>
          )}
        </div>

        <aside className="lg:sticky lg:top-6">
          <div data-card-summary className="rounded-[1.75rem] border border-[#145CFF]/35 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] p-5 shadow-[0_30px_80px_-40px_rgba(20,92,255,0.9)] sm:p-6">
            <h2 className="text-lg font-black text-white">Resumo do pagamento</h2>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between text-white/70">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(order.subtotal)}</dd>
              </div>
              <div className="flex justify-between text-white/70">
                <dt>{order.delivery_type === 'delivery' ? 'Entrega' : 'Retirada'}</dt>
                <dd className="tabular-nums">{order.delivery_fee > 0 ? money(order.delivery_fee) : 'Grátis'}</dd>
              </div>
              {order.discount > 0 && (
                <div className="flex justify-between text-white/70">
                  <dt>Desconto</dt>
                  <dd className="tabular-nums">− {money(order.discount)}</dd>
                </div>
              )}
              <div className="flex justify-between text-white/70">
                <dt>Taxa do cartão</dt>
                <dd className="tabular-nums">{money(fee)}</dd>
              </div>
              <div className="flex items-end justify-between border-t border-white/10 pt-3">
                <dt className="font-bold text-white">Total no cartão</dt>
                <dd className="text-2xl font-black tabular-nums text-white">{money(order.total)}</dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-white/60">A taxa do cartão repassa o custo de processamento do pagamento no cartão de crédito. Ela só existe nesta forma de pagamento.</p>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}
