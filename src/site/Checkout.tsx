import { Banknote, Check, Clock, CreditCard, LoaderCircle, MapPin, Motorbike, QrCode, ShoppingBag, Store, Ticket, TriangleAlert, UserRound, X, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useId } from 'react';
import { ApiError, api, friendlyError } from '../lib/api';
import { trackOnce } from '../lib/analytics';
import { PAYMENT_LABEL, maskPhone, money, onlyDigits, parseMoney } from '../lib/format';
import { nextOpening } from '../lib/hours';
import { FLAVORS_REQUIRED_MESSAGE, picksToPayload, picksToken } from '../lib/flavors';
import { ICE_REQUIRED_MESSAGE } from '../lib/ice';
import { seedOrder } from '../lib/orderCache';
import { rememberOrder } from '../lib/recent';
import { navigate } from '../lib/router';
import type { DeliveryType, PaymentMethod, PublicOrder } from '../lib/types';
import { AGE_TEXT_VERSION } from './AgeGate';
import { ScheduleChoice } from './ScheduleChoice';
import type { ScheduleValue } from './ScheduleChoice';
import { useCustomer } from './customer';
import { acceptedPayments, fullAddress, incompleteMessage, useShop } from './data';
import { useFlavorPicker } from './flavorPicker';
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
  cep: string;
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

const AGE_REQUIRED_MESSAGE = 'Confirme que você tem 18 anos ou mais para finalizar o pedido.';

// Cupom conferido pelo servidor (prévia): o valor do desconto vem do banco, nunca da conta do navegador.
type AppliedCoupon = { code: string; description: string | null; kind: 'percent' | 'fixed' | 'free_delivery'; discount: number; free_delivery: boolean };

type PriceChangedBody = {
  total?: number | string;
  delivery_fee?: number | string;
  discount?: number | string;
  items?: { product_id: string; name: string; quantity: number; unit_price: number | string; ice_choice?: string | null; swap_to?: string | null; ice_flavors?: { product_id: string; quantity: number }[] | null }[];
};

export function CheckoutPage() {
  const { store, zones, payments, cart, isOpen, fresh, offline, refresh } = useShop();
  const { lines, total: subtotal, setQty, clear, unavailable, incomplete } = cart;
  const flavorPicker = useFlavorPicker();
  const [form, setForm] = useState<Customer>(() => {
    const saved = loadCustomer();
    return {
      name: saved.name ?? '',
      phone: saved.phone ?? '',
      email: saved.email ?? '',
      delivery: saved.delivery ?? 'delivery',
      cep: saved.cep ?? '',
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
  // Declaração de maioridade: pedida sempre que há bebida alcoólica no pedido e nunca guardada de um pedido para o outro. É uma declaração da pessoa,
  // não uma prova: o servidor a exige de novo (create_order) e o documento é conferido na entrega ou na retirada.
  const [ageOk, setAgeOk] = useState(false);
  const [ageError, setAgeError] = useState('');
  // Quando: o quanto antes ou agendado (a faixa escolhida é conferida pelo banco ao fechar o pedido).
  const [schedule, setSchedule] = useState<ScheduleValue>({ mode: 'now', at: '' });
  const [scheduleKey, setScheduleKey] = useState(0);
  const [scheduleError, setScheduleError] = useState('');
  // Endereços extras salvos na conta (o principal já preenche o formulário sozinho). Escolher um preenche os campos; "Outro endereço" deixa como está.
  const [savedAddresses, setSavedAddresses] = useState<{ id: string; label: string; cep: string | null; address: string; address_number: string; neighborhood: string; complement: string | null; reference: string | null }[]>([]);
  const [pickedAddress, setPickedAddress] = useState('');
  const [keepAddress, setKeepAddress] = useState(false);
  // CEP: a consulta é feita pelo nosso servidor (o serviço de CEP nunca vê o aparelho da pessoa); falhou, a pessoa preenche à mão.
  const [cepNote, setCepNote] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [cepBusy, setCepBusy] = useState(false);
  const cepAsked = useRef('');
  // Cupom: o código digitado, o que o servidor conferiu (prévia) e a mensagem de erro. Um cupom por pedido.
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<AppliedCoupon | null>(null);
  const [couponMsg, setCouponMsg] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  // Armadilha para robôs (campo escondido) e quanto tempo a pessoa ficou na tela: o servidor desconfia de quem envia rápido demais.
  const [trap, setTrap] = useState('');
  const openedAt = useRef(performance.now());
  const errorRef = useRef<HTMLDivElement>(null);

  // Só oferece o que a loja aceita agora.
  const deliveryOptions = (['delivery', 'pickup'] as DeliveryType[]).filter((d) => (d === 'delivery' ? store.delivery_enabled : store.pickup_enabled));
  const paymentOptions: PaymentMethod[] = acceptedPayments(payments).map((p) => p.code);
  const pixKey = payments.find((p) => p.code === 'pix')?.details ?? null;
  const delivery = deliveryOptions.includes(form.delivery) ? form.delivery : deliveryOptions[0];
  const payment = paymentOptions.includes(form.payment) ? form.payment : paymentOptions[0];

  const zone = zones.find((z) => z.name.trim().toLowerCase() === form.neighborhood.trim().toLowerCase());
  const baseFee = delivery === 'delivery' ? (zones.length ? (zone?.fee ?? null) : store.delivery_fee) : 0;
  // Desconto do cupom (em centavos, vindo da prévia do servidor) e frete grátis: a mesma regra do banco. O frete grátis por valor olha o subtotal
  // DEPOIS do desconto; o cupom de entrega grátis zera a taxa. O servidor calcula tudo de novo e confere o total (expected_total).
  const itemsCents = lines.reduce((sum, line) => sum + Math.round(line.unit * 100) * line.qty, 0);
  const discountCents = coupon ? Math.min(Math.round(coupon.discount * 100), itemsCents) : 0;
  const feeWaived =
    delivery === 'delivery' &&
    baseFee !== null &&
    baseFee > 0 &&
    (Boolean(coupon?.free_delivery) || (store.free_delivery_enabled && itemsCents - discountCents >= Math.round(store.free_delivery_min * 100)));
  const fee = baseFee === null ? null : feeWaived ? 0 : baseFee;
  const total = (itemsCents - discountCents) / 100 + (fee ?? 0);
  const totalCents = itemsCents - discountCents + Math.round((fee ?? 0) * 100);
  const belowMinimum = delivery === 'delivery' && store.min_order > 0 && subtotal < store.min_order;
  const needsAge = lines.some((line) => line.product.alcoholic);

  // Medição de visitas (só com a loja tendo ligado e a pessoa aceitado): a finalização foi aberta com itens, uma vez por visita à página.
  const hasLines = lines.length > 0;
  useEffect(() => {
    if (hasLines) trackOnce('begin_checkout', 'begin_checkout', { value: itemsCents / 100 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasLines]);

  const set =<K extends keyof Customer>(key: K, value: Customer[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Mexeu nos itens, na quantidade ou no endereço: o aviso de "valor mudou" não vale mais.
  const cartKey = lines.map((line) => `${line.key}:${line.qty}`).join(',');
  useEffect(() => {
    setPriceNotice(null);
  }, [cartKey, delivery, form.neighborhood, coupon?.code, coupon?.discount]);

  const lookupCep = async (digits: string) => {
    if (digits.length !== 8 || cepAsked.current === digits) return;
    cepAsked.current = digits;
    setCepBusy(true);
    setCepNote(null);
    try {
      const found = await api.get<{ address: { street: string; neighborhood: string; city: string; state: string }; zone: { name: string } | null; zones_configured: boolean }>(`/api/cep/${digits}`);
      const { address, zone: matched, zones_configured: hasZones } = found;
      setForm((f) => ({
        ...f,
        address: address.street || f.address,
        neighborhood: hasZones ? (matched?.name ?? f.neighborhood) : address.neighborhood || f.neighborhood,
      }));
      setErrors((e) => ({ ...e, address: undefined, neighborhood: undefined }));
      const where = [address.street, address.neighborhood, [address.city, address.state].filter(Boolean).join('/')].filter(Boolean).join(' · ');
      if (hasZones && !matched && address.neighborhood) {
        setCepNote({ tone: 'warn', text: `${where}. O bairro ${address.neighborhood} não está na nossa lista de entrega: escolha um bairro da lista ou retire na loja.` });
      } else setCepNote({ tone: 'ok', text: where || 'CEP encontrado.' });
    } catch (error) {
      cepAsked.current = '';
      setCepNote({ tone: 'warn', text: friendlyError(error, 'Não foi possível consultar o CEP agora. Preencha o endereço à mão.') });
    } finally {
      setCepBusy(false);
    }
  };

  // Itens enviados à prévia do cupom (o servidor lê os preços no banco).
  const previewItems = lines.map((line) => ({ product_id: line.product.id, quantity: line.qty, ...(line.swap ? { swap_to: line.swap.id } : {}) }));
  const previewKey = `${cartKey}|${delivery}|${onlyDigits(form.phone).length >= 10 ? onlyDigits(form.phone) : ''}`;
  const checkCoupon = async (code: string): Promise<AppliedCoupon> => {
    const phone = onlyDigits(form.phone);
    const result = await api.post<{ coupon: AppliedCoupon }>('/api/coupons/validate', { code, delivery_type: delivery, items: previewItems, ...(phone.length >= 10 ? { phone } : {}) });
    return result.coupon;
  };
  const applyCoupon = async () => {
    const code = couponInput.trim().toUpperCase();
    if (!code) return setCouponMsg('Digite o código do cupom.');
    setCouponBusy(true);
    setCouponMsg('');
    try {
      const found = await checkCoupon(code);
      setCoupon(found);
      setCouponInput('');
    } catch (error) {
      setCoupon(null);
      setCouponMsg(friendlyError(error, 'Não foi possível conferir o cupom. Tente de novo.'));
    } finally {
      setCouponBusy(false);
    }
  };
  const removeCoupon = () => {
    setCoupon(null);
    setCouponMsg('');
  };
  // Mexeu nos itens, na entrega ou no telefone: o servidor confere o cupom de novo (pedido mínimo, categorias, limite por cliente...).
  const appliedCode = coupon?.code;
  useEffect(() => {
    if (!appliedCode) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      checkCoupon(appliedCode).then(
        (found) => {
          if (alive) setCoupon((current) => (current && current.code === found.code ? found : current));
        },
        (error) => {
          if (!alive) return;
          setCoupon(null);
          setCouponMsg(friendlyError(error, 'O cupom deixou de valer.'));
        },
      );
    }, 450);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedCode, previewKey]);

  // O aviso "escolha o gelo" some sozinho quando todos os itens já têm a escolha.
  useEffect(() => {
    if (incomplete.length === 0) setSubmitError((current) => (current === ICE_REQUIRED_MESSAGE || current === FLAVORS_REQUIRED_MESSAGE ? '' : current));
  }, [incomplete.length]);

  useEffect(() => {
    if (submitError) errorRef.current?.focus();
  }, [submitError]);

  useEffect(() => {
    if (accountStatus !== 'in') return;
    let alive = true;
    api.get<{ addresses: typeof savedAddresses }>('/api/account/addresses').then(
      (data) => alive && setSavedAddresses(data.addresses),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [accountStatus]);

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
    // Falta escolher o gelo (ou os gelos saborizados do combo) de algum item: nada é enviado; a mensagem aparece junto do botão e o foco vai para o item.
    if (incomplete.length > 0) {
      setSubmitError(incompleteMessage(incomplete));
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-line="${incomplete[0].key}"] [data-ice-pending]`)?.focus());
      return;
    }
    if (couponInput.trim()) {
      setCouponMsg('Toque em “Aplicar” para usar o cupom, ou apague o código.');
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-coupon-input]')?.focus());
      return;
    }
    if (store.scheduling_enabled && schedule.mode === 'later' && !schedule.at) {
      setScheduleError('Escolha o dia e o horário do agendamento, ou volte para “O quanto antes”.');
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-schedule-time]')?.focus());
      return;
    }
    setScheduleError('');
    const valid = validate();
    const ageMissing = needsAge && !ageOk;
    if (ageMissing) setAgeError(AGE_REQUIRED_MESSAGE);
    if (!valid || ageMissing) {
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
      ...(needsAge ? { age_confirmed: true, age_text_version: AGE_TEXT_VERSION } : {}),
      ...(coupon ? { coupon_code: coupon.code } : {}),
      ...(store.scheduling_enabled && schedule.mode === 'later' && schedule.at ? { scheduled_for: schedule.at } : {}),
      // A escolha do gelo vai junto de cada item que a pede e o energético escolhido numa troca de combo vai em "swap_to" (o servidor
      // confere tudo de novo e calcula a diferença de preço).
      items: lines.map((line) => ({
        product_id: line.product.id,
        quantity: line.qty,
        ...(line.product.iceRequired ? { ice_choice: line.ice } : {}),
        ...(line.swap ? { swap_to: line.swap.id } : {}),
        // Combo com gelos saborizados: os sabores desta unidade do combo (o banco confere que são gelos saborizados cadastrados, disponíveis, na quantidade do combo).
        ...(line.product.comboIces > 0 && line.flavors ? { ice_flavors: picksToPayload(line.flavors) } : {}),
      })),
    };
    // O total que a pessoa está vendo (ou o novo total que ela acabou de aceitar), em centavos para não errar na soma.
    const seenTotal = priceNotice ? priceNotice.current : totalCents / 100;
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
        // (num combo com gelos saborizados, as linhas com sabores diferentes também são linhas diferentes.)
        const keyOf = (productId: string, ice: string | null | undefined, swapTo: string | null | undefined, flavors: string) => `${productId}|${ice ?? ''}|${swapTo ?? ''}|${flavors}`;
        const byLine = new Map(
          (body.items ?? []).map((item) => [keyOf(item.product_id, item.ice_choice, item.swap_to, picksToken((item.ice_flavors ?? []).map((f) => ({ id: f.product_id, qty: f.quantity })))), Number(item.unit_price)]),
        );
        const lineKeyOf = (line: (typeof lines)[number]) => keyOf(line.product.id, line.ice, line.swap?.id, picksToken(line.flavors ?? []));
        const changes = lines
          .filter((line) => byLine.has(lineKeyOf(line)) && Math.abs((byLine.get(lineKeyOf(line)) ?? 0) - line.unit) >= 0.005)
          .map((line) => `${line.product.name}${line.swap ? ` (com ${line.swap.name})` : ''}: ${money(line.unit)} → ${money(byLine.get(lineKeyOf(line)) ?? 0)}`);
        if (body.delivery_fee !== undefined && Math.abs(Number(body.delivery_fee) - (fee ?? 0)) >= 0.005) changes.push(`Taxa de entrega: ${money(fee ?? 0)} → ${money(Number(body.delivery_fee))}`);
        if (body.discount !== undefined && Math.abs(Number(body.discount) - discountCents / 100) >= 0.005) changes.push(`Desconto do cupom: ${money(discountCents / 100)} → ${money(Number(body.discount))}`);
        setPriceNotice({ previous: seenTotal, current: Number(body.total), changes });
        void refresh(true);
        return;
      }
      if (error instanceof ApiError && error.code === 'idempotency_conflict') forgetOrderKey();
      if (error instanceof ApiError && error.code === 'age_required') {
        // O servidor pediu a declaração de maioridade (a tela e o servidor discordaram sobre haver bebida alcoólica no pedido).
        setAgeOk(false);
        setAgeError(AGE_REQUIRED_MESSAGE);
        void refresh(true);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-age-confirm]')?.focus());
        return;
      }
      setSubmitError(friendlyError(error, 'Não foi possível enviar o pedido. Tente de novo em instantes.'));
      // Um sabor de gelo deixou de estar disponível (ou o combo veio sem os gelos): abre a escolha daquele combo para a pessoa escolher de novo.
      if (error instanceof ApiError && (error.code === 'flavor_unavailable' || error.code === 'ice_flavors_required')) {
        const data = error.data as { product_id?: string; products?: { product_id: string }[] } | null;
        const comboId = data?.product_id ?? data?.products?.[0]?.product_id;
        const target = lines.find((line) => line.product.id === comboId && line.product.comboIces > 0);
        if (target) window.setTimeout(() => flavorPicker.edit(target), 0);
      }
      // Se o pedido era agendado, a faixa pode ter acabado de lotar: busca as faixas de novo.
      if (schedule.mode === 'later') setScheduleKey((k) => k + 1);
      // Se havia um cupom, confere de novo: ele pode ter acabado de vencer ou de esgotar.
      if (coupon) checkCoupon(coupon.code).catch((e) => (setCoupon(null), setCouponMsg(friendlyError(e, 'O cupom deixou de valer.'))));
      // Preço, estoque ou horário podem ter mudado: atualiza o cardápio.
      void refresh(true);
      return;
    }
    setSending(false);
    forgetOrderKey();
    // "Guardar este endereço na minha conta": depois que o pedido já está salvo, sem atrapalhar nada se falhar.
    if (keepAddress && delivery === 'delivery' && accountStatus === 'in') {
      void api
        .post('/api/account/addresses', {
          label: (zone?.name ?? form.neighborhood).trim().slice(0, 30) || 'Endereço',
          cep: onlyDigits(form.cep) || null,
          address: form.address.trim(),
          address_number: form.number.trim(),
          neighborhood: zone?.name ?? form.neighborhood.trim(),
          complement: form.complement.trim() || null,
          reference: form.reference.trim() || null,
        })
        .catch(() => undefined);
    }
    // O pedido já está salvo no Neon; o código de acompanhamento vai no endereço da página de confirmação
    // e fica na lista "neste aparelho" só como atalho.
    seedOrder(token, order);
    rememberOrder(order.order_number, token);
    trackOnce(`purchase:${order.order_number}`, 'purchase', { value: Number(order.total), transaction_id: String(order.order_number), payment_type: order.payment_method });
    clear();
    navigate(`/pedido/${token}`);
  };

  const closedText = store.orders_paused
    ? 'A loja pausou os pedidos pelo site por enquanto.'
    : `Estamos fechados agora. ${nextOpening(store.opening_hours, store.timezone, new Date(), store.exceptions)}`.trim();
  // Sem resposta da API não dá para saber se a loja está aberta: não mostra "fechado" por engano (o servidor confere ao enviar).
  // Loja fechada MAS com agendamento ligado: o pedido segue (só para um horário em que a loja abre). Pausada, nada segue.
  const closedNow = fresh && !offline && !isOpen;
  const canSchedule = store.scheduling_enabled && !store.orders_paused;
  const blocked = closedNow && !(canSchedule && schedule.mode === 'later');

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
              <Field label="E-mail (opcional)" error={errors.email}>
                {(p) => (
                  <input {...p} {...EMAIL_INPUT} value={form.email} onChange={(e) => set('email', e.target.value)} className={FIELD} placeholder="voce@email.com" />
                )}
              </Field>
            </div>
          </Card>

          <Card step={3} title="Entrega">
            <ScheduleChoice enabled={canSchedule} closedNow={closedNow} pickup={delivery === 'pickup'} value={schedule} onChange={(next) => (setScheduleError(''), setSchedule(next))} refreshKey={scheduleKey} />
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
                {accountStatus === 'in' && savedAddresses.length > 0 && (
                  <Field label="Usar um endereço salvo" className="sm:col-span-6">
                    {(p) => (
                      <select
                        {...p}
                        data-saved-address
                        value={pickedAddress}
                        onChange={(e) => {
                          const id = e.target.value;
                          setPickedAddress(id);
                          const a = savedAddresses.find((x) => x.id === id);
                          if (!a) return;
                          setForm((f) => ({ ...f, cep: a.cep ? `${a.cep.slice(0, 5)}-${a.cep.slice(5)}` : '', address: a.address, number: a.address_number, neighborhood: a.neighborhood, complement: a.complement ?? '', reference: a.reference ?? '' }));
                          setErrors((er) => ({ ...er, address: undefined, number: undefined, neighborhood: undefined }));
                          setKeepAddress(false);
                        }}
                        className={`${FIELD} appearance-none`}
                      >
                        <option value="" className="bg-[#0A0D14]">
                          Outro endereço
                        </option>
                        {savedAddresses.map((a) => (
                          <option key={a.id} value={a.id} className="bg-[#0A0D14]">
                            {a.label} · {a.address}, {a.address_number}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                )}
                <Field label="CEP (opcional)" hint={cepBusy ? 'Buscando o endereço…' : 'Com o CEP, preenchemos a rua e o bairro.'} className="sm:col-span-6">
                  {(p) => (
                    <div className="sm:max-w-xs">
                      <input
                        {...p}
                        data-cep-input
                        value={form.cep}
                        onChange={(e) => {
                          const digits = onlyDigits(e.target.value).slice(0, 8);
                          set('cep', digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits);
                          if (digits.length < 8) {
                            cepAsked.current = '';
                            setCepNote(null);
                          } else void lookupCep(digits);
                        }}
                        inputMode="numeric"
                        autoComplete="postal-code"
                        maxLength={9}
                        className={FIELD}
                        placeholder="00000-000"
                      />
                      {cepNote && (
                        <p data-cep-note={cepNote.tone} role="status" className={`mt-1.5 text-xs ${cepNote.tone === 'ok' ? 'text-emerald-200/90' : 'text-amber-200'}`}>
                          {cepNote.text}
                        </p>
                      )}
                    </div>
                  )}
                </Field>
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
                {accountStatus === 'in' && !pickedAddress && savedAddresses.length < 4 && (
                  <label className="flex cursor-pointer items-center gap-3 text-sm text-white/80 sm:col-span-6">
                    <input type="checkbox" checked={keepAddress} onChange={(e) => setKeepAddress(e.target.checked)} data-keep-address className="h-5 w-5 shrink-0 accent-[#145CFF]" />
                    Guardar este endereço na minha conta
                  </label>
                )}
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
                  icon={p === 'pix' ? <QrCode className="h-5 w-5" aria-hidden="true" /> : p === 'cash' ? <Banknote className="h-5 w-5" aria-hidden="true" /> : <CreditCard className="h-5 w-5" aria-hidden="true" />}
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
                        : undefined
                  }
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
            <div data-coupon-box className="mt-4">
              {coupon ? (
                <div data-coupon-applied={coupon.code} className="flex items-start justify-between gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-3.5 py-2.5 text-sm text-emerald-100">
                  <p className="flex min-w-0 items-start gap-2">
                    <Ticket className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block font-mono text-sm font-black tracking-wide">{coupon.code}</span>
                      <span className="block text-xs text-emerald-100/85">
                        {coupon.free_delivery ? 'Entrega grátis' : `Desconto de ${money(coupon.discount)}`}
                        {coupon.description ? ` · ${coupon.description}` : ''}
                      </span>
                    </span>
                  </p>
                  <button
                    type="button"
                    onClick={removeCoupon}
                    data-coupon-remove
                    aria-label={`Remover o cupom ${coupon.code}`}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-emerald-100/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <div>
                  <label htmlFor="cupom" className="text-xs font-semibold text-white/70">
                    Tem um cupom?
                  </label>
                  <div className="mt-1.5 flex gap-2">
                    <input
                      id="cupom"
                      data-coupon-input
                      value={couponInput}
                      onChange={(e) => (setCouponInput(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30)), setCouponMsg(''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void applyCoupon();
                        }
                      }}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      aria-invalid={couponMsg ? true : undefined}
                      aria-describedby={couponMsg ? 'cupom-msg' : undefined}
                      placeholder="CÓDIGO"
                      className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/[0.05] px-3.5 font-mono text-sm uppercase tracking-wide text-white placeholder:text-white/40 focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/40"
                    />
                    <button
                      type="button"
                      onClick={() => void applyCoupon()}
                      disabled={couponBusy}
                      data-coupon-apply
                      className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-white/20 px-4 text-sm font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-60"
                    >
                      {couponBusy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : 'Aplicar'}
                    </button>
                  </div>
                </div>
              )}
              {couponMsg && (
                <p id="cupom-msg" role="alert" data-coupon-message className="mt-1.5 text-xs font-semibold text-rose-300">
                  {couponMsg}
                </p>
              )}
            </div>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="flex justify-between text-white/70">
                <dt>Subtotal</dt>
                <dd className="tabular-nums">{money(subtotal)}</dd>
              </div>
              {discountCents > 0 && coupon && (
                <div data-discount-line className="flex justify-between text-emerald-300">
                  <dt>Desconto ({coupon.code})</dt>
                  <dd className="tabular-nums">− {money(discountCents / 100)}</dd>
                </div>
              )}
              <div className="flex justify-between text-white/70">
                <dt>{delivery === 'delivery' ? 'Entrega' : 'Retirada'}</dt>
                <dd className="tabular-nums" data-delivery-line={feeWaived ? 'waived' : undefined}>
                  {delivery === 'pickup' ? (
                    'Grátis'
                  ) : fee === null ? (
                    'Escolha o bairro'
                  ) : feeWaived ? (
                    <>
                      <s className="mr-1.5 text-white/45">{money(baseFee ?? 0)}</s>
                      <span className="font-semibold text-emerald-300">Grátis</span>
                    </>
                  ) : fee > 0 ? (
                    money(fee)
                  ) : (
                    'Grátis'
                  )}
                </dd>
              </div>
              <div className="flex items-end justify-between border-t border-white/10 pt-3">
                <dt className="font-bold text-white">Total</dt>
                <dd>
                  <Price value={totalCents / 100} className="text-3xl" />
                </dd>
              </div>
            </dl>
            {delivery === 'delivery' && store.free_delivery_enabled && !feeWaived && baseFee !== null && baseFee > 0 && (
              <p data-free-delivery-hint className="mt-2.5 text-xs text-emerald-200/90">
                Entrega grátis a partir de {money(store.free_delivery_min)}
                {itemsCents - discountCents < Math.round(store.free_delivery_min * 100) ? `: faltam ${money(store.free_delivery_min - (itemsCents - discountCents) / 100)}.` : '.'}
              </p>
            )}

            <div className="mt-5 space-y-3">
              {closedNow && (
                <p data-closed-notice className="flex items-start gap-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 px-3.5 py-2.5 text-sm text-amber-100">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {closedText}
                  {canSchedule ? ' Você pode agendar o pedido para um horário em que a loja abre (escolha “Agendar” em Entrega).' : ''}
                </p>
              )}
              {scheduleError && (
                <p role="alert" data-schedule-error className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
                  {scheduleError}
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
              {needsAge && (
                <div data-age-declaration>
                  <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-white/15 bg-white/[0.04] px-3.5 py-3 text-sm leading-snug text-white/85">
                    <input
                      type="checkbox"
                      checked={ageOk}
                      onChange={(e) => {
                        setAgeOk(e.target.checked);
                        if (e.target.checked) setAgeError('');
                      }}
                      aria-invalid={ageError ? true : undefined}
                      aria-describedby={ageError ? 'age-error' : undefined}
                      data-age-confirm
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[#145CFF]"
                    />
                    <span>
                      Declaro que tenho <strong className="text-white">18 anos ou mais</strong>. Sei que a {delivery === 'pickup' ? 'retirada' : 'entrega'} só acontece com a apresentação de
                      documento oficial com foto e que o pedido não é entregue a quem não comprovar a maioridade.
                    </span>
                  </label>
                  {ageError && (
                    <p id="age-error" role="alert" className="mt-1.5 text-xs font-semibold text-rose-300">
                      {ageError}
                    </p>
                  )}
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
                    Finalizar pedido · {money(total)}
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
