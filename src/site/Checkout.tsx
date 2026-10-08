import {
  ArrowLeft,
  Banknote,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  LoaderCircle,
  MapPin,
  Motorbike,
  QrCode,
  ShoppingBag,
  Store,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { DELIVERY_LABEL, PAYMENT_LABEL, STATUS, addressLines, formatTime, maskPhone, money, onlyDigits, parseMoney, statusLabel } from '../lib/format';
import { nextOpening } from '../lib/hours';
import { navigate } from '../lib/router';
import { db, friendlyError } from '../lib/supabase';
import type { DeliveryType, OrderStatus, PaymentMethod, PublicOrder, StoreSettings } from '../lib/types';
import { fullAddress, storeWhatsappUrl, useShop } from './data';
import { BLUE_BUTTON, CartLineItem, FIELD, Footer, GHOST_BUTTON, Price, WHATSAPP_BUTTON, WhatsAppIcon } from './ui';

// ---- Mensagem do pedido para o WhatsApp da loja ------------------------------------------------

export function orderWhatsappMessage(store: StoreSettings, order: PublicOrder): string {
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
  ].join('\n');
}

// Pedido recém-criado: a página do pedido abre na hora, sem esperar outra consulta.
const orderCache = new Map<string, PublicOrder>();

// ---- Peças do formulário -----------------------------------------------------------------------

function Card({ title, step, children }: { title: string; step: number; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-[1.75rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 sm:p-6">
      <h2 id={id} className="flex items-center gap-3 text-lg font-black text-white">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-[#145CFF] text-xs font-black shadow-[0_0_16px_rgba(20,92,255,0.7)]">{step}</span>
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({
  label,
  error,
  hint,
  children,
  className = '',
}: {
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const describedBy = error ? `${id}-erro` : hint ? `${id}-dica` : undefined;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-semibold text-white/80">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${id}-erro`} className="mt-1.5 text-xs font-medium text-rose-300">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-dica`} className="mt-1.5 text-xs text-white/45">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Choice({
  name,
  value,
  checked,
  onChange,
  icon,
  title,
  subtitle,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  icon: ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <label
      className={`relative flex cursor-pointer items-center gap-3 rounded-2xl border p-3.5 transition-all duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white ${
        checked
          ? 'border-[#2563FF] bg-[#145CFF]/15 shadow-[0_0_30px_-12px_rgba(20,92,255,0.9)]'
          : 'border-white/10 bg-white/[0.03] hover:border-white/30'
      }`}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} className="sr-only" />
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${checked ? 'bg-[#145CFF] text-white' : 'bg-white/5 text-[#8FB1FF]'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-white">{title}</span>
        {subtitle && <span className="block text-xs text-white/55">{subtitle}</span>}
      </span>
      <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full border ${checked ? 'border-[#2563FF] bg-[#2563FF]' : 'border-white/30'}`}>
        {checked && <Check className="h-3 w-3 text-white" aria-hidden="true" />}
      </span>
    </label>
  );
}

function PageShell({ back, backLabel, children }: { back: string; backLabel: string; children: ReactNode }) {
  const { store, logo } = useShop();
  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-[#050505]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 top-0 h-96 w-96 rounded-full bg-[#145CFF]/15 blur-3xl cc-glow" />
        <div className="absolute -right-40 top-1/2 h-96 w-96 rounded-full bg-[#2563FF]/10 blur-3xl cc-glow [animation-delay:2s]" />
      </div>
      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-6">
        <a
          href={back}
          className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {backLabel}
        </a>
        <a href="/" className="flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white" aria-label={`${store.store_name} – início`}>
          <img src={logo} alt="" width={40} height={40} className="h-10 w-10 rounded-full object-contain ring-1 ring-white/15 shadow-[0_0_24px_rgba(20,92,255,0.55)]" />
        </a>
      </header>
      <div className="relative mx-auto w-full max-w-5xl px-4 pb-24 pt-6 sm:px-6">{children}</div>
      <Footer />
    </div>
  );
}

// ---- Checkout (/checkout) ----------------------------------------------------------------------

type Customer = {
  name: string;
  phone: string;
  email: string;
  delivery: DeliveryType;
  address: string;
  number: string;
  neighborhood: string;
  complement: string;
  reference: string;
  payment: PaymentMethod;
  change: string;
  notes: string;
};

const CUSTOMER_KEY = 'copocheio:cliente';

function loadCustomer(): Partial<Customer> {
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOMER_KEY) ?? '{}') as Partial<Customer>;
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

export function CheckoutPage() {
  const { store, zones, cart, isOpen, fresh, refresh } = useShop();
  const { lines, total: subtotal, setQty, clear, unavailable } = cart;
  const [form, setForm] = useState<Customer>(() => {
    const saved = loadCustomer();
    return {
      name: saved.name ?? '',
      phone: saved.phone ?? '',
      email: saved.email ?? '',
      delivery: saved.delivery ?? 'delivery',
      address: saved.address ?? '',
      number: saved.number ?? '',
      neighborhood: saved.neighborhood ?? '',
      complement: saved.complement ?? '',
      reference: saved.reference ?? '',
      payment: saved.payment ?? 'pix',
      change: '',
      notes: '',
    };
  });
  const [errors, setErrors] = useState<Partial<Record<keyof Customer, string>>>({});
  const [submitError, setSubmitError] = useState('');
  const [sending, setSending] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  // Só oferece o que a loja aceita agora.
  const deliveryOptions = (['delivery', 'pickup'] as DeliveryType[]).filter((d) => (d === 'delivery' ? store.delivery_enabled : store.pickup_enabled));
  const paymentOptions = (['pix', 'cash', 'card'] as PaymentMethod[]).filter((p) => store[`${p}_enabled` as const]);
  const delivery = deliveryOptions.includes(form.delivery) ? form.delivery : deliveryOptions[0];
  const payment = paymentOptions.includes(form.payment) ? form.payment : paymentOptions[0];

  const zone = zones.find((z) => z.name.trim().toLowerCase() === form.neighborhood.trim().toLowerCase());
  const fee = delivery === 'delivery' ? (zones.length ? (zone?.fee ?? null) : store.delivery_fee) : 0;
  const total = subtotal + (fee ?? 0);
  const belowMinimum = delivery === 'delivery' && store.min_order > 0 && subtotal < store.min_order;

  const set = <K extends keyof Customer>(key: K, value: Customer[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  if (lines.length === 0) {
    return (
      <PageShell back="/bebidas" backLabel="Bebidas">
        <div className="mx-auto mt-10 max-w-md rounded-[2rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-8 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#145CFF]/15 text-[#2563FF] ring-1 ring-[#145CFF]/40">
            <ShoppingBag className="h-8 w-8" aria-hidden="true" />
          </div>
          <h1 className="mt-6 text-2xl font-black text-white">Seu pedido está vazio</h1>
          <p className="mt-2 text-white/65">Escolha suas bebidas favoritas e volte aqui para finalizar.</p>
          <a href="/bebidas" className={`${BLUE_BUTTON} mt-7`}>
            Ver bebidas
          </a>
        </div>
      </PageShell>
    );
  }

  const validate = () => {
    const next: Partial<Record<keyof Customer, string>> = {};
    if (form.name.trim().length < 2) next.name = 'Informe seu nome.';
    const phone = onlyDigits(form.phone);
    if (phone.length < 10 || phone.length > 11) next.phone = 'Informe um telefone com DDD.';
    if (form.email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) next.email = 'Confira o e-mail.';
    if (delivery === 'delivery') {
      if (!form.address.trim()) next.address = 'Informe a rua.';
      if (!form.number.trim()) next.number = 'Informe o número.';
      if (!form.neighborhood.trim()) next.neighborhood = 'Informe o bairro.';
      else if (zones.length && !zone) next.neighborhood = 'Escolha um bairro da lista.';
    }
    if (payment === 'cash' && form.change.trim()) {
      const change = parseMoney(form.change);
      if (change === null || Number.isNaN(change)) next.change = 'Valor inválido.';
      else if (change < total) next.change = `Precisa ser pelo menos ${money(total)}.`;
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError('');
    if (!validate()) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (!db) {
      setSubmitError('Os pedidos pelo site ainda não estão ativos. Fale com a loja pelo WhatsApp.');
      return;
    }
    setSending(true);
    try {
      localStorage.setItem(
        CUSTOMER_KEY,
        JSON.stringify({ ...form, change: '', notes: '', delivery, payment }),
      );
    } catch {
      /* modo privado */
    }
    const change = payment === 'cash' && form.change.trim() ? parseMoney(form.change) : null;
    const { data, error } = await db.rpc('create_order', {
      payload: {
        customer_name: form.name.trim(),
        customer_phone: onlyDigits(form.phone),
        customer_email: form.email.trim() || null,
        delivery_type: delivery,
        address: form.address.trim(),
        address_number: form.number.trim(),
        neighborhood: zone?.name ?? form.neighborhood.trim(),
        complement: form.complement.trim(),
        reference: form.reference.trim(),
        payment_method: payment,
        change_for: change === null ? null : change.toFixed(2),
        notes: form.notes.trim(),
        items: lines.map((line) => ({ product_id: line.product.id, quantity: line.qty })),
      },
    });
    setSending(false);
    if (error || !data) {
      setSubmitError(friendlyError(error, 'Não foi possível enviar o pedido. Tente de novo em instantes.'));
      // Preço, estoque ou horário podem ter mudado: atualiza o cardápio.
      void refresh();
      return;
    }
    const order = data as PublicOrder;
    orderCache.set(order.token, order);
    clear();
    navigate(`/pedido/${order.token}`);
  };

  const closedText = store.orders_paused
    ? 'A loja pausou os pedidos pelo site por enquanto.'
    : `Estamos fechados agora. ${nextOpening(store.opening_hours, store.timezone)}`.trim();
  const blocked = fresh && !isOpen;

  return (
    <PageShell back="/bebidas" backLabel="Bebidas">
      <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
        Finalizar <span className="text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">pedido</span>
      </h1>
      <p className="mt-2 text-white/60">Confira seus itens, diga onde entregar e como vai pagar.</p>

      <form onSubmit={submit} noValidate className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-5">
          <Card step={1} title="Seu pedido">
            <ul className="space-y-3">
              {lines.map((line) => (
                <CartLineItem key={line.product.id} line={line} setQty={setQty} />
              ))}
            </ul>
            <a href="/bebidas" className="mt-4 inline-flex text-sm font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              + Adicionar mais bebidas
            </a>
          </Card>

          <Card step={2} title="Seus dados">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome *" error={errors.name} className="sm:col-span-2">
                {(p) => (
                  <input {...p} value={form.name} onChange={(e) => set('name', e.target.value)} autoComplete="name" maxLength={80} className={FIELD} placeholder="Como podemos te chamar?" />
                )}
              </Field>
              <Field label="Telefone / WhatsApp *" error={errors.phone}>
                {(p) => (
                  <input
                    {...p}
                    type="tel"
                    inputMode="tel"
                    value={form.phone}
                    onChange={(e) => set('phone', maskPhone(e.target.value))}
                    autoComplete="tel-national"
                    className={FIELD}
                    placeholder="(34) 99999-0000"
                  />
                )}
              </Field>
              <Field label="E-mail (opcional)" error={errors.email}>
                {(p) => (
                  <input {...p} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} autoComplete="email" maxLength={254} className={FIELD} placeholder="voce@email.com" />
                )}
              </Field>
            </div>
          </Card>

          <Card step={3} title="Entrega">
            {deliveryOptions.length > 1 && (
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Como você quer receber">
                <Choice
                  name="entrega"
                  value="delivery"
                  checked={delivery === 'delivery'}
                  onChange={() => set('delivery', 'delivery')}
                  icon={<Motorbike className="h-5 w-5" aria-hidden="true" />}
                  title="Delivery"
                  subtitle={store.delivery_time ?? 'Entregamos na sua casa'}
                />
                <Choice
                  name="entrega"
                  value="pickup"
                  checked={delivery === 'pickup'}
                  onChange={() => set('delivery', 'pickup')}
                  icon={<Store className="h-5 w-5" aria-hidden="true" />}
                  title="Retirar na loja"
                  subtitle="Sem taxa de entrega"
                />
              </div>
            )}
            {delivery === 'delivery' ? (
              <div className={`grid gap-4 sm:grid-cols-6 ${deliveryOptions.length > 1 ? 'mt-5' : ''}`}>
                <Field label="Rua / Avenida *" error={errors.address} className="sm:col-span-4">
                  {(p) => <input {...p} value={form.address} onChange={(e) => set('address', e.target.value)} autoComplete="address-line1" maxLength={120} className={FIELD} />}
                </Field>
                <Field label="Número *" error={errors.number} className="sm:col-span-2">
                  {(p) => <input {...p} value={form.number} onChange={(e) => set('number', e.target.value)} inputMode="numeric" maxLength={20} className={FIELD} />}
                </Field>
                <Field label="Bairro *" error={errors.neighborhood} className="sm:col-span-3">
                  {(p) =>
                    zones.length ? (
                      <select {...p} value={zone?.name ?? ''} onChange={(e) => set('neighborhood', e.target.value)} className={`${FIELD} appearance-none`}>
                        <option value="" className="bg-[#0A0D14]">
                          Escolha o bairro
                        </option>
                        {zones.map((z) => (
                          <option key={z.id} value={z.name} className="bg-[#0A0D14]">
                            {z.name} – {z.fee > 0 ? money(z.fee) : 'grátis'}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input {...p} value={form.neighborhood} onChange={(e) => set('neighborhood', e.target.value)} maxLength={60} className={FIELD} />
                    )
                  }
                </Field>
                <Field label="Complemento" className="sm:col-span-3">
                  {(p) => <input {...p} value={form.complement} onChange={(e) => set('complement', e.target.value)} autoComplete="address-line2" maxLength={60} className={FIELD} placeholder="Apto, bloco, casa..." />}
                </Field>
                <Field label="Ponto de referência" className="sm:col-span-6">
                  {(p) => <input {...p} value={form.reference} onChange={(e) => set('reference', e.target.value)} maxLength={120} className={FIELD} placeholder="Perto de..." />}
                </Field>
              </div>
            ) : (
              <div className={`flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-sm text-white/75 ${deliveryOptions.length > 1 ? 'mt-5' : ''}`}>
                <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-[#2563FF]" aria-hidden="true" />
                <span>{fullAddress(store) || 'Combine a retirada com a loja pelo WhatsApp depois de enviar o pedido.'}</span>
              </div>
            )}
          </Card>

          <Card step={4} title="Pagamento">
            <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Forma de pagamento">
              {paymentOptions.map((p) => (
                <Choice
                  key={p}
                  name="pagamento"
                  value={p}
                  checked={payment === p}
                  onChange={() => set('payment', p)}
                  icon={p === 'pix' ? <QrCode className="h-5 w-5" aria-hidden="true" /> : p === 'cash' ? <Banknote className="h-5 w-5" aria-hidden="true" /> : <CreditCard className="h-5 w-5" aria-hidden="true" />}
                  title={PAYMENT_LABEL[p]}
                  subtitle={p === 'card' ? (delivery === 'delivery' ? 'Na entrega' : 'Na retirada') : p === 'pix' ? (store.pix_key ? 'Chave na confirmação' : 'Combine pelo WhatsApp') : undefined}
                />
              ))}
            </div>
            {payment === 'cash' && (
              <Field label="Troco para quanto? (opcional)" error={errors.change} hint="Deixe em branco se não precisar de troco." className="mt-4 sm:max-w-xs">
                {(p) => <input {...p} value={form.change} onChange={(e) => set('change', e.target.value)} inputMode="decimal" className={FIELD} placeholder="R$ 50,00" />}
              </Field>
            )}
            <Field label="Observações" className="mt-5">
              {(p) => (
                <textarea
                  {...p}
                  value={form.notes}
                  onChange={(e) => set('notes', e.target.value)}
                  maxLength={500}
                  rows={3}
                  className={`${FIELD} resize-none`}
                  placeholder="Ex.: bem gelada, sem gelo, tocar o interfone..."
                />
              )}
            </Field>
          </Card>
        </div>

        <aside className="lg:sticky lg:top-6">
          <div className="rounded-[1.75rem] border border-[#145CFF]/35 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] p-5 shadow-[0_30px_80px_-40px_rgba(20,92,255,0.9)] sm:p-6">
            <h2 className="text-lg font-black text-white">Resumo</h2>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between text-white/70">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(subtotal)}</dd>
              </div>
              <div className="flex justify-between text-white/70">
                <dt>{delivery === 'delivery' ? 'Entrega' : 'Retirada'}</dt>
                <dd className="tabular-nums">
                  {delivery === 'pickup' ? 'Grátis' : fee === null ? 'Escolha o bairro' : fee > 0 ? money(fee) : 'Grátis'}
                </dd>
              </div>
              <div className="flex items-end justify-between border-t border-white/10 pt-3">
                <dt className="font-bold text-white">Total</dt>
                <dd>
                  <Price value={total} className="text-3xl" />
                </dd>
              </div>
            </dl>

            <div className="mt-5 space-y-3">
              {blocked && (
                <p className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-sm text-amber-100">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {closedText}
                </p>
              )}
              {belowMinimum && (
                <p className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-sm text-amber-100">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Pedido mínimo para entrega: {money(store.min_order)}. Faltam {money(store.min_order - subtotal)}.
                </p>
              )}
              {unavailable.length > 0 && (
                <p className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Remova os itens esgotados para continuar.
                </p>
              )}
              {submitError && (
                <div ref={errorRef} tabIndex={-1} role="alert" className="flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100 focus:outline-none">
                  <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {submitError}
                </div>
              )}
              <button
                type="submit"
                disabled={sending || blocked || belowMinimum || unavailable.length > 0}
                className={`${BLUE_BUTTON} w-full py-4 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100`}
              >
                {sending ? (
                  <>
                    <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
                    Enviando pedido...
                  </>
                ) : (
                  <>Finalizar pedido · {money(total)}</>
                )}
              </button>
              <p className="text-center text-xs text-white/45">Você recebe o número do pedido na hora e pode enviá-lo pelo WhatsApp.</p>
            </div>
          </div>
        </aside>
      </form>
    </PageShell>
  );
}

// ---- Pedido do cliente (/pedido/:id) -----------------------------------------------------------

const FINAL: OrderStatus[] = ['delivered', 'cancelled'];

function StatusSteps({ order }: { order: PublicOrder }) {
  const steps: OrderStatus[] = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];
  const reached = new Map(order.history.map((h) => [h.status, h.at]));
  if (order.order_status === 'cancelled') {
    return (
      <p className="flex items-center gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 font-semibold text-rose-100">
        <XCircle className="h-5 w-5" aria-hidden="true" />
        Pedido cancelado. Qualquer dúvida, fale com a loja pelo WhatsApp.
      </p>
    );
  }
  const currentIndex = steps.indexOf(order.order_status);
  return (
    <ol className="grid gap-3 sm:grid-cols-5 sm:gap-2" aria-label="Andamento do pedido">
      {steps.map((status, i) => {
        const done = i <= currentIndex;
        const current = i === currentIndex;
        const at = reached.get(status);
        return (
          <li key={status} className="flex items-center gap-3 sm:flex-col sm:items-center sm:gap-2 sm:text-center" aria-current={current ? 'step' : undefined}>
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-black ${
                done ? 'bg-[#145CFF] text-white shadow-[0_0_18px_rgba(20,92,255,0.8)]' : 'border border-white/15 text-white/40'
              } ${current ? 'ring-4 ring-[#145CFF]/30' : ''}`}
            >
              {done ? <Check className="h-4 w-4" aria-hidden="true" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={`block text-[11px] font-black tracking-wide ${done ? 'text-white' : 'text-white/40'}`}>
                {statusLabel(status, order.delivery_type)}
              </span>
              {at && <span className="block text-[11px] text-white/45">{formatTime(at)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function OrderPage({ token }: { token: string }) {
  const { store } = useShop();
  const [order, setOrder] = useState<PublicOrder | null>(() => orderCache.get(token) ?? null);
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>(() => (orderCache.has(token) ? 'ok' : 'loading'));
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!db) {
        setState('error');
        return;
      }
      const { data, error } = await db.rpc('get_public_order', { token });
      if (!alive) return;
      if (error) setState((s) => (s === 'ok' ? s : 'error'));
      else if (!data) setState('missing');
      else {
        setOrder(data as PublicOrder);
        setState('ok');
      }
    };
    void load();
    // Acompanha o status enquanto a página está aberta.
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [token]);

  useEffect(() => {
    if (order) document.title = `Pedido #${order.order_number} – ${store.store_name}`;
  }, [order, store.store_name]);

  if (state === 'loading' || (state === 'error' && !order)) {
    return (
      <PageShell back="/" backLabel="Início">
        {state === 'loading' ? (
          <div className="mt-20 flex justify-center" role="status" aria-label="Carregando o pedido">
            <LoaderCircle className="h-10 w-10 animate-spin text-[#2563FF]" aria-hidden="true" />
          </div>
        ) : (
          <p className="mt-16 text-center text-white/70" role="alert">
            Não foi possível carregar o pedido agora. Atualize a página em instantes.
          </p>
        )}
      </PageShell>
    );
  }

  if (state === 'missing' || !order) {
    return (
      <PageShell back="/" backLabel="Início">
        <div className="mx-auto mt-10 max-w-md text-center">
          <h1 className="text-2xl font-black text-white">Pedido não encontrado</h1>
          <p className="mt-2 text-white/65">Confira o link ou fale com a loja pelo WhatsApp.</p>
          <a href="/bebidas" className={`${BLUE_BUTTON} mt-7`}>
            Ver bebidas
          </a>
        </div>
      </PageShell>
    );
  }

  const message = orderWhatsappMessage(store, order);
  const showPix = order.payment_method === 'pix' && store.pix_key && order.payment_status !== 'paid' && order.order_status !== 'cancelled';
  const live = !FINAL.includes(order.order_status);

  return (
    <PageShell back="/bebidas" backLabel="Bebidas">
      <div className="relative overflow-hidden rounded-[2rem] border border-[#145CFF]/35 bg-gradient-to-br from-[#145CFF]/30 via-[#0B1230] to-[#050505] p-6 text-center shadow-[0_40px_120px_-50px_rgba(20,92,255,0.9)] sm:p-10">
        <div aria-hidden="true" className="pointer-events-none absolute -left-16 -top-20 h-64 w-64 rounded-full bg-[#2563FF]/30 blur-3xl cc-glow" />
        <div className="relative">
          <CheckCircle2 className="mx-auto h-14 w-14 text-[#5B8CFF] drop-shadow-[0_0_20px_rgba(37,99,255,0.9)]" aria-hidden="true" />
          <h1 className="mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">Pedido recebido!</h1>
          <p className="mx-auto mt-2 max-w-md text-balance text-white/75 sm:text-lg">
            Seu pedido <strong className="text-white">#{order.order_number}</strong> foi enviado para a {store.store_name}.
          </p>
          <a href={storeWhatsappUrl(store, message)} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} mt-7 w-full sm:w-auto`}>
            <WhatsAppIcon className="h-6 w-6" />
            Enviar pedido pelo WhatsApp
          </a>
          <p className="mt-3 text-xs text-white/50">O pedido já está salvo. O WhatsApp é para falar com a loja, se quiser.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_22rem] lg:items-start">
        <div className="space-y-5">
          <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6" aria-labelledby="andamento">
            <div className="flex items-center justify-between gap-3">
              <h2 id="andamento" className="text-lg font-black text-white">
                Andamento
              </h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-black tracking-wide ring-1 ${STATUS[order.order_status].badge}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${STATUS[order.order_status].dot}`} />
                {statusLabel(order.order_status, order.delivery_type)}
              </span>
            </div>
            <div className="mt-5">
              <StatusSteps order={order} />
            </div>
            {live && <p className="mt-4 text-xs text-white/45">Esta página atualiza sozinha.</p>}
          </section>

          <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5 sm:p-6" aria-labelledby="itens">
            <h2 id="itens" className="text-lg font-black text-white">
              Itens
            </h2>
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
          </section>
        </div>

        <aside className="space-y-5">
          <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5" aria-labelledby="entrega">
            <h2 id="entrega" className="flex items-center gap-2 text-base font-black text-white">
              {order.delivery_type === 'delivery' ? <Motorbike className="h-5 w-5 text-[#2563FF]" aria-hidden="true" /> : <Store className="h-5 w-5 text-[#2563FF]" aria-hidden="true" />}
              {DELIVERY_LABEL[order.delivery_type]}
            </h2>
            <div className="mt-2 space-y-0.5 text-sm text-white/70">
              {order.delivery_type === 'delivery' ? addressLines(order).map((line) => <p key={line}>{line}</p>) : <p>{fullAddress(store) || 'Retirada na loja'}</p>}
            </div>
          </section>
          <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5" aria-labelledby="pagamento">
            <h2 id="pagamento" className="text-base font-black text-white">
              Pagamento
            </h2>
            <p className="mt-2 text-sm text-white/70">
              {PAYMENT_LABEL[order.payment_method]}
              {order.payment_method === 'cash' && order.change_for ? ` · troco para ${money(order.change_for)}` : ''}
              {order.payment_status === 'paid' ? ' · pago' : ''}
            </p>
            {showPix && (
              <div className="mt-3 rounded-2xl border border-[#145CFF]/30 bg-[#145CFF]/10 p-3">
                <p className="text-xs text-white/60">Chave PIX</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all text-sm font-bold text-white">{store.pix_key}</code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(store.pix_key ?? '').then(() => setCopied(true));
                      window.setTimeout(() => setCopied(false), 2000);
                    }}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[#145CFF] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
                    {copied ? 'Copiada' : 'Copiar'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-white/55">Pague {money(order.total)} e envie o comprovante pelo WhatsApp.</p>
              </div>
            )}
          </section>
          {order.notes && (
            <section className="rounded-[1.75rem] border border-white/10 bg-white/[0.03] p-5" aria-labelledby="obs">
              <h2 id="obs" className="text-base font-black text-white">
                Observações
              </h2>
              <p className="mt-2 whitespace-pre-line text-sm text-white/70">{order.notes}</p>
            </section>
          )}
          <a href="/bebidas" className={`${GHOST_BUTTON} w-full`}>
            Fazer outro pedido
          </a>
        </aside>
      </div>
    </PageShell>
  );
}
