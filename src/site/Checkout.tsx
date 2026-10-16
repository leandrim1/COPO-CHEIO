import { Banknote, Check, Clock, CreditCard, LoaderCircle, MapPin, Motorbike, QrCode, ShoppingBag, Store, TriangleAlert, UserRound, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { cardFeeCents, serviceFeeCents } from '../lib/cardFee';
import { PAYMENT_LABEL, maskPhone, money, onlyDigits, parseMoney } from '../lib/format';
import { nextOpening } from '../lib/hours';
import { ICE_REQUIRED_MESSAGE } from '../lib/ice';
import { seedOrder } from '../lib/orderCache';
import { rememberOrder } from '../lib/recent';
import { navigate } from '../lib/router';
import type { DeliveryType, PaymentMethod, PublicOrder } from '../lib/types';
import { useCustomer } from './customer';
import { acceptedPayments, cardFeeRates, fullAddress, useShop } from './data';
import { Field, PageShell } from './shell';
import { EMAIL_INPUT } from './accountUi';
import { BLUE_BUTTON, CartLineItem, FIELD, Price } from './ui';

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

// ---- Envio seguro do pedido ---------------------------------------------------------------------

const ORDER_KEY = 'copocheio:pedido-chave';

function newKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// A mesma chave acompanha o mesmo pedido (mesmos itens e dados): se a resposta se perder e a pessoa tocar de novo, ou a página
// for recarregada, o servidor devolve o pedido que já criou em vez de criar outro. Mudou algo no pedido, muda a chave.
function orderKey(fingerprint: string): string {
  try {
    const saved = JSON.parse(sessionStorage.getItem(ORDER_KEY) ?? 'null') as { fp?: string; key?: string } | null;
    if (saved && saved.fp === fingerprint && typeof saved.key === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(saved.key)) return saved.key;
  } catch {
    /* armazenamento bloqueado: segue com uma chave nova */
  }
  const key = newKey();
  try {
    sessionStorage.setItem(ORDER_KEY, JSON.stringify({ fp: fingerprint, key }));
  } catch {
    /* modo privado */
  }
  return key;
}

const forgetOrderKey = () => {
  try {
    sessionStorage.removeItem(ORDER_KEY);
  } catch {
    /* nada a fazer */
  }
};

// O que o servidor respondeu quando o valor do pedido mudou entre a tela e o envio (409 price_changed).
type PriceNotice = { previous: number; current: number; changes: string[] };

type PriceChangedBody = {
  total?: number | string;
  delivery_fee?: number | string;
  payment_fee?: number | string;
  items?: { product_id: string; name: string; quantity: number; unit_price: number | string; ice_choice?: string | null; swap_to?: string | null }[];
};

export function CheckoutPage() {
  const { store, zones, payments, cart, isOpen, fresh, offline, refresh } = useShop();
  const { lines, total: subtotal, setQty, clear, unavailable, incomplete } = cart;
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
  const { status: accountStatus, customer: account } = useCustomer();
  const prefilled = useRef(false);
  const [errors, setErrors] = useState<Partial<Record<keyof Customer, string>>>({});
  const [submitError, setSubmitError] = useState('');
  const [sending, setSending] = useState(false);
  const [priceNotice, setPriceNotice] = useState<PriceNotice | null>(null);
  // Armadilha para robôs (campo escondido) e quanto tempo a pessoa ficou na tela: o servidor desconfia de quem envia rápido demais.
  const [trap, setTrap] = useState('');
  const openedAt = useRef(performance.now());
  const errorRef = useRef<HTMLDivElement>(null);

  // Só oferece o que a loja aceita agora.
  const deliveryOptions = (['delivery', 'pickup'] as DeliveryType[]).filter((d) => (d === 'delivery' ? store.delivery_enabled : store.pickup_enabled));
  // Cartão online: a taxa (percentual + tarifa fixa) vem do servidor só para o resumo mudar enquanto a pessoa mexe no pedido; o servidor calcula
  // de novo ao receber o pedido e recusa (409) se o total que a pessoa viu for diferente. Sem a taxa conhecida, a opção nem aparece.
  const cardRates = cardFeeRates(payments.find((p) => p.code === 'card_online')?.card_fee);
  const paymentOptions: PaymentMethod[] = acceptedPayments(payments).map((p) => p.code);
  // Pix online: taxa de serviço do cliente (percentual sobre itens + entrega), também só para o resumo; o servidor calcula e confere de novo.
  const pixRate = payments.find((p) => p.code === 'pix_online')?.service_fee;
  const pixBps = pixRate && Number.isSafeInteger(pixRate.bps) && pixRate.bps >= 0 && pixRate.bps <= 1000 ? pixRate.bps : null;
  const pixKey = payments.find((p) => p.code === 'pix')?.details ?? null;
  const delivery = deliveryOptions.includes(form.delivery) ? form.delivery : deliveryOptions[0];
  const payment = paymentOptions.includes(form.payment) ? form.payment : paymentOptions[0];

  const zone = zones.find((z) => z.name.trim().toLowerCase() === form.neighborhood.trim().toLowerCase());
  const fee = delivery === 'delivery' ? (zones.length ? (zone?.fee ?? null) : store.delivery_fee) : 0;
  const total = subtotal + (fee ?? 0);
  const totalCents = lines.reduce((sum, line) => sum + Math.round(line.unit * 100) * line.qty, 0) + Math.round((fee ?? 0) * 100);
  // A taxa do cartão incide sobre tudo o que vai no cartão (itens + entrega), em centavos inteiros, como no servidor. Entrega ainda sem valor
  // (bairro não escolhido): a taxa fica para depois, e o envio já é bloqueado até escolher o bairro.
  const hasFee = payment === 'card_online' || (payment === 'pix_online' && pixBps !== null);
  const feeLabel = payment === 'pix_online' ? 'Taxa de serviço' : 'Taxa do cartão';
  const cardFee =
    fee === null || totalCents <= 0 ? 0 : payment === 'card_online' && cardRates ? cardFeeCents(totalCents, cardRates) : payment === 'pix_online' && pixBps !== null ? serviceFeeCents(totalCents, pixBps) : 0;
  const payTotalCents = totalCents + cardFee;
  const payTotal = payTotalCents / 100;
  const belowMinimum = delivery === 'delivery' && store.min_order > 0 && subtotal < store.min_order;

  const set = <K extends keyof Customer>(key: K, value: Customer[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Mexeu nos itens, na quantidade ou no endereço: o aviso de "valor mudou" não vale mais.
  const cartKey = lines.map((line) => `${line.key}:${line.qty}`).join(',');
  useEffect(() => {
    setPriceNotice(null);
  }, [cartKey, delivery, form.neighborhood]);

  // O aviso "escolha o gelo" some sozinho quando todos os itens já têm a escolha.
  useEffect(() => {
    if (incomplete.length === 0) setSubmitError((current) => (current === ICE_REQUIRED_MESSAGE ? '' : current));
  }, [incomplete.length]);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  // Já baixa a página de confirmação/acompanhamento: ao finalizar o pedido ela abre na hora.
  useEffect(() => {
    void import('./CustomerPages');
  }, []);

  // Com login, os dados da conta já vêm preenchidos (nome, telefone, e-mail e o endereço guardado).
  useEffect(() => {
    if (!account || prefilled.current) return;
    prefilled.current = true;
    const digits = onlyDigits(account.phone);
    setForm((f) => ({
      ...f,
      name: account.name,
      phone: maskPhone(digits.length > 11 ? digits.replace(/^55/, '') : digits),
      email: account.email,
      ...(account.address
        ? {
            address: account.address,
            number: account.address_number ?? '',
            neighborhood: account.neighborhood ?? '',
            complement: account.complement ?? '',
            reference: account.reference ?? '',
          }
        : {}),
    }));
  }, [account]);

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
    else if (payment === 'card_online' && !form.email.trim()) next.email = 'Informe o e-mail para pagar com cartão de crédito.';
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
    // Falta escolher o gelo de algum item: nada é enviado; a mensagem aparece junto do botão e o foco vai para o item.
    if (incomplete.length > 0) {
      setSubmitError(ICE_REQUIRED_MESSAGE);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-line="${incomplete[0].key}"] [data-ice-pending]`)?.focus());
      return;
    }
    if (!validate()) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
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
    const base = {
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
      // A escolha do gelo vai junto de cada item que a pede e o energético escolhido numa troca de combo vai em "swap_to" (o servidor
      // confere tudo de novo e calcula a diferença de preço).
      items: lines.map((line) => ({
        product_id: line.product.id,
        quantity: line.qty,
        ...(line.product.iceRequired ? { ice_choice: line.ice } : {}),
        ...(line.swap ? { swap_to: line.swap.id } : {}),
      })),
    };
    // O total que a pessoa está vendo (ou o novo total que ela acabou de aceitar), em centavos para não errar na soma.
    const seenTotal = priceNotice ? priceNotice.current : payTotalCents / 100;
    let order: PublicOrder;
    let token: string;
    try {
      ({ order, token } = await api.post<{ order: PublicOrder; token: string }>('/api/orders', {
        ...base,
        idempotency_key: orderKey(JSON.stringify(base)),
        expected_total: seenTotal.toFixed(2),
        website: trap,
        fill_ms: Math.round(performance.now() - openedAt.current),
      }));
    } catch (error) {
      setSending(false);
      if (error instanceof ApiError && error.status === 409 && error.code === 'price_changed') {
        // Nada foi enviado: o valor mudou (preço, promoção ou taxa) e a pessoa precisa ver o novo total antes de confirmar.
        const body = error.data as PriceChangedBody;
        // Uma linha é produto + gelo + energético trocado: o preço novo de cada uma vem do servidor, linha a linha.
        const keyOf = (productId: string, ice: string | null | undefined, swapTo: string | null | undefined) => `${productId}|${ice ?? ''}|${swapTo ?? ''}`;
        const byLine = new Map((body.items ?? []).map((item) => [keyOf(item.product_id, item.ice_choice, item.swap_to), Number(item.unit_price)]));
        const changes = lines
          .filter((line) => byLine.has(keyOf(line.product.id, line.ice, line.swap?.id)) && Math.abs((byLine.get(keyOf(line.product.id, line.ice, line.swap?.id)) ?? 0) - line.unit) >= 0.005)
          .map((line) => `${line.product.name}${line.swap ? ` (com ${line.swap.name})` : ''}: ${money(line.unit)} → ${money(byLine.get(keyOf(line.product.id, line.ice, line.swap?.id)) ?? 0)}`);
        if (body.delivery_fee !== undefined && Math.abs(Number(body.delivery_fee) - (fee ?? 0)) >= 0.005) changes.push(`Taxa de entrega: ${money(fee ?? 0)} → ${money(Number(body.delivery_fee))}`);
        if (hasFee && body.payment_fee !== undefined && Math.abs(Number(body.payment_fee) - cardFee / 100) >= 0.005) changes.push(`${feeLabel}: ${money(cardFee / 100)} → ${money(Number(body.payment_fee))}`);
        setPriceNotice({ previous: seenTotal, current: Number(body.total), changes });
        void refresh(true);
        return;
      }
      if (error instanceof ApiError && error.code === 'idempotency_conflict') forgetOrderKey();
      setSubmitError(friendlyError(error, 'Não foi possível enviar o pedido. Tente de novo em instantes.'));
      // Preço, estoque ou horário podem ter mudado: atualiza o cardápio.
      void refresh(true);
      return;
    }
    setSending(false);
    forgetOrderKey();
    // O pedido já está salvo no Neon; o código de acompanhamento vai no endereço da página de confirmação
    // e fica na lista "neste aparelho" só como atalho.
    seedOrder(token, order);
    rememberOrder(order.order_number, token);
    clear();
    // Cartão: a tela do cartão é uma página à parte, aberta de novo do zero (o SDK da operadora e o antifraude dela só podem rodar ali, com regras de
    // segurança próprias). Se por algum motivo não abrir, o pedido está salvo e o botão "Pagar com cartão" fica na página do pedido.
    if (order.payment_method === 'card_online') {
      window.location.assign(`/pagar/${token}`);
      return;
    }
    navigate(`/pedido/${token}`);
  };

  const closedText = store.orders_paused
    ? 'A loja pausou os pedidos pelo site por enquanto.'
    : `Estamos fechados agora. ${nextOpening(store.opening_hours, store.timezone)}`.trim();
  // Sem resposta da API não dá para saber se a loja está aberta: não mostra "fechado" por engano (o servidor confere ao enviar).
  const blocked = fresh && !offline && !isOpen;

  return (
    <PageShell back="/bebidas" backLabel="Bebidas">
      <h1 className="text-3xl font-black tracking-tight text-white sm:text-4xl">
        Finalizar <span className="text-[#2563FF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">pedido</span>
      </h1>
      <p className="mt-2 text-white/60">Confira seus itens, diga onde entregar e como vai pagar.</p>
      {accountStatus === 'in' && account ? (
        <p className="mt-4 flex items-start gap-2.5 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-100">
          <UserRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Você entrou como <strong className="text-white">{account.name}</strong>. Este pedido fica salvo em “Meus pedidos”.
          </span>
        </p>
      ) : accountStatus === 'out' ? (
        <p className="mt-4 flex items-start gap-2.5 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
          <UserRound className="mt-0.5 h-4 w-4 shrink-0 text-white/60" aria-hidden="true" />
          <span>
            Você pode finalizar sem conta e acompanhar o pedido pelo link. Quer guardar o histórico?{' '}
            <a href="/conta?voltar=%2Fcheckout" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              Entrar
            </a>{' '}
            ou{' '}
            <a href="/conta?aba=cadastro&voltar=%2Fcheckout" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
              criar conta
            </a>
            .
          </span>
        </p>
      ) : null}

      <form onSubmit={submit} noValidate className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem] lg:items-start">
        {/* Armadilha para robôs: pessoas não veem nem preenchem este campo. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>
            Não preencha este campo
            <input name="apelido_interno" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
          </label>
        </div>
        <div className="space-y-5">
          <Card step={1} title="Seu pedido">
            <ul className="space-y-3">
              {lines.map((line) => (
                <CartLineItem key={line.key} line={line} setQty={setQty} />
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
              <Field
                label={payment === 'card_online' ? 'E-mail *' : 'E-mail (opcional)'}
                error={errors.email}
                hint={payment === 'card_online' ? 'A operadora do cartão exige o e-mail para enviar o comprovante.' : undefined}
              >
                {(p) => (
                  <input {...p} {...EMAIL_INPUT} value={form.email} onChange={(e) => set('email', e.target.value)} className={FIELD} placeholder="voce@email.com" />
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
            <div className={`grid gap-3 ${paymentOptions.length > 3 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`} role="radiogroup" aria-label="Forma de pagamento">
              {paymentOptions.map((p) => (
                <Choice
                  key={p}
                  name="pagamento"
                  value={p}
                  checked={payment === p}
                  onChange={() => set('payment', p)}
                  icon={p === 'pix' || p === 'pix_online' ? <QrCode className="h-5 w-5" aria-hidden="true" /> : p === 'cash' ? <Banknote className="h-5 w-5" aria-hidden="true" /> : <CreditCard className="h-5 w-5" aria-hidden="true" />}
                  title={PAYMENT_LABEL[p]}
                  subtitle={
                    p === 'card'
                      ? delivery === 'delivery'
                        ? 'Na entrega'
                        : 'Na retirada'
                      : p === 'pix'
                        ? pixKey
                          ? 'Chave na confirmação'
                          : 'Combine pelo WhatsApp'
                        : p === 'pix_online'
                          ? 'Pague agora, pelo site'
                          : p === 'card_online'
                            ? 'Pague agora, pelo site · com taxa do cartão'
                            : undefined
                  }
                />
              ))}
            </div>
            {payment === 'pix_online' && (
              <div data-pix-notice className="mt-4 rounded-2xl border border-[#145CFF]/30 bg-[#145CFF]/10 px-4 py-3 text-sm text-white/80">
                <p className="flex items-start gap-2.5">
                  <QrCode className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB1FF]" aria-hidden="true" />
                  <span>Você paga na próxima tela, com QR Code ou Pix copia e cola. O pedido só é enviado para a loja depois que o pagamento for confirmado.</span>
                </p>
              </div>
            )}
            {payment === 'card_online' && (
              <div data-card-notice className="mt-4 rounded-2xl border border-[#145CFF]/30 bg-[#145CFF]/10 px-4 py-3 text-sm text-white/80">
                <p className="flex items-start gap-2.5">
                  <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-[#8FB1FF]" aria-hidden="true" />
                  <span>Os dados do cartão vão direto para a operadora de pagamento: este site não guarda número nem código de segurança.</span>
                </p>
              </div>
            )}
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
              {hasFee && (
                <div data-card-fee data-fee-line className="flex justify-between text-white/70">
                  <dt>{feeLabel}</dt>
                  <dd className="tabular-nums">{fee === null ? 'Escolha o bairro' : money(cardFee / 100)}</dd>
                </div>
              )}
              <div className="flex items-end justify-between border-t border-white/10 pt-3">
                <dt className="font-bold text-white">Total</dt>
                <dd>
                  <Price value={payTotal} className="text-3xl" />
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
              {priceNotice && (
                <div role="alert" className="rounded-2xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-3 text-sm text-amber-100">
                  <p className="flex items-start gap-2 font-semibold">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      Os valores mudaram desde que você abriu esta tela. O total {priceNotice.current > priceNotice.previous ? 'subiu' : 'baixou'} de {money(priceNotice.previous)} para{' '}
                      <strong className="text-white">{money(priceNotice.current)}</strong>.
                    </span>
                  </p>
                  {priceNotice.changes.length > 0 && (
                    <ul className="mt-2 list-disc space-y-0.5 pl-9 text-amber-100/90">
                      {priceNotice.changes.map((change) => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 pl-6 text-amber-100/90">Se estiver tudo certo, toque em “Confirmar novo total”.</p>
                </div>
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
                ) : priceNotice ? (
                  <>Confirmar novo total · {money(priceNotice.current)}</>
                ) : (
                  <>
                    {payment === 'pix_online' ? 'Finalizar e pagar com Pix' : payment === 'card_online' ? 'Finalizar e pagar com cartão' : 'Finalizar pedido'} · {money(payTotal)}
                  </>
                )}
              </button>
              <p className="text-center text-xs text-white/60">Você recebe o número do pedido e um link para acompanhar o andamento, sem precisar de cadastro.</p>
              <p className="text-center text-xs text-white/60">
                Usamos seus dados só para entregar e acompanhar o pedido. Veja a{' '}
                <a href="/privacidade" className="font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline">
                  política de privacidade
                </a>
                .
              </p>
            </div>
          </div>
        </aside>
      </form>
    </PageShell>
  );
}
