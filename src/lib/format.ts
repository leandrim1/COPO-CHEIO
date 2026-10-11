import type { DeliveryType, OrderStatus, PaymentMethod, PaymentStatus } from './types';

export const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format;

// "12,50", "12.5", "R$ 1.234,50" → número. Vazio → null; inválido → NaN.
export function parseMoney(input: string): number | null {
  const text = input.replace(/R\$|\s/g, '');
  if (!text) return null;
  const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return Number.NaN;
  return Math.round(Number(normalized) * 100) / 100;
}

export const moneyInput = (value: number | null | undefined) =>
  value === null || value === undefined ? '' : value.toFixed(2).replace('.', ',');

export const onlyDigits = (text: string) => text.replace(/\D/g, '');

// (34) 99999-0000 enquanto a pessoa digita.
export function maskPhone(input: string): string {
  const d = onlyDigits(input).slice(0, 11);
  if (d.length <= 2) return d.length ? `(${d}` : '';
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function formatPhone(digits: string | null | undefined): string {
  if (!digits) return '';
  const d = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  return d.length === 10 || d.length === 11 ? maskPhone(d) : digits;
}

// Link do WhatsApp de um número brasileiro (com ou sem o 55).
export function whatsappTo(digits: string, text?: string): string {
  const d = onlyDigits(digits);
  const full = d.length <= 11 ? `55${d}` : d;
  return `https://wa.me/${full}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));

export function timeAgo(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'agora';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `há ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `há ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'ontem' : `há ${days} dias`;
  return formatDateTime(iso);
}

export const STATUS_FLOW: OrderStatus[] = ['new', 'confirmed', 'preparing', 'out_for_delivery', 'delivered'];

// As mesmas regras do banco (admin_set_order_status): o painel não oferece o que o servidor vai recusar.
// Para a frente vale pular etapas; para trás, só uma etapa; entregue só volta para "saiu para entrega" e não cancela; cancelado não reabre.
export function statusMoveProblem(from: OrderStatus, to: OrderStatus): string | null {
  if (from === to) return null;
  if (from === 'cancelled') return 'Este pedido foi cancelado e não pode ser reaberto.';
  if (from === 'delivered') {
    if (to === 'cancelled') return 'Pedido entregue não pode ser cancelado. Para devolver o dinheiro, marque o pagamento como reembolsado.';
    return to === 'out_for_delivery' ? null : 'Pedido entregue só pode voltar para “Saiu para entrega” (se o clique foi por engano).';
  }
  if (to === 'cancelled') return null;
  return STATUS_FLOW.indexOf(to) < STATUS_FLOW.indexOf(from) - 1 ? 'O pedido só pode voltar uma etapa de cada vez.' : null;
}

// Regras do pagamento (admin_set_payment_status): cancelado não vira "pago"; só se reembolsa o que estava pago.
export function paymentMoveProblem(order: { order_status: OrderStatus; payment_status: PaymentStatus }, to: PaymentStatus): string | null {
  if (order.payment_status === to) return null;
  if (to === 'paid' && order.order_status === 'cancelled') return 'Pedido cancelado não pode ser marcado como pago. Se houve pagamento, marque como reembolsado.';
  if (to === 'refunded' && order.payment_status !== 'paid') return 'Só dá para reembolsar um pedido que estava marcado como pago.';
  return null;
}

export const STATUS: Record<OrderStatus, { label: string; action: string; badge: string; dot: string }> = {
  new: {
    label: 'NOVO',
    action: 'NOVO',
    badge: 'bg-[#145CFF]/20 text-[#9DBBFF] ring-[#145CFF]/50',
    dot: 'bg-[#2563FF] shadow-[0_0_10px_rgba(37,99,255,0.9)]',
  },
  confirmed: {
    label: 'CONFIRMADO',
    action: 'CONFIRMAR PEDIDO',
    badge: 'bg-cyan-400/15 text-cyan-200 ring-cyan-400/40',
    dot: 'bg-cyan-300',
  },
  preparing: {
    label: 'EM PREPARO',
    action: 'EM PREPARO',
    badge: 'bg-amber-400/15 text-amber-200 ring-amber-400/40',
    dot: 'bg-amber-300',
  },
  out_for_delivery: {
    label: 'EM ENTREGA',
    action: 'SAIU PARA ENTREGA',
    badge: 'bg-violet-400/15 text-violet-200 ring-violet-400/40',
    dot: 'bg-violet-300',
  },
  delivered: {
    label: 'ENTREGUE',
    action: 'ENTREGUE',
    badge: 'bg-emerald-400/15 text-emerald-200 ring-emerald-400/40',
    dot: 'bg-emerald-300',
  },
  cancelled: {
    label: 'CANCELADO',
    action: 'CANCELAR',
    badge: 'bg-rose-500/15 text-rose-200 ring-rose-500/40',
    dot: 'bg-rose-400',
  },
};

// Na retirada, "saiu para entrega" vira "pronto para retirar".
export function statusLabel(status: OrderStatus, delivery: DeliveryType): string {
  if (delivery === 'pickup' && status === 'out_for_delivery') return 'PRONTO P/ RETIRAR';
  if (delivery === 'pickup' && status === 'delivered') return 'RETIRADO';
  return STATUS[status].label;
}

// Nomes das etapas como o cliente lê (na retirada, "saiu para entrega" vira "pronto para retirar").
export function stepLabel(status: OrderStatus, delivery: DeliveryType): string {
  if (status === 'out_for_delivery') return delivery === 'pickup' ? 'Pronto para retirar' : 'Saiu para entrega';
  if (status === 'delivered') return delivery === 'pickup' ? 'Retirado' : 'Entregue';
  return { new: 'Novo', confirmed: 'Confirmado', preparing: 'Em preparo', cancelled: 'Cancelado' }[status];
}

export const PAYMENT_LABEL: Record<PaymentMethod, string> = { pix: 'PIX', cash: 'Dinheiro', card: 'Cartão' };
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  pending: 'Aguardando pagamento',
  paid: 'Pago',
  refunded: 'Estornado',
};
export const DELIVERY_LABEL: Record<DeliveryType, string> = { delivery: 'Delivery', pickup: 'Retirada' };

export function addressLines(o: {
  address: string | null;
  address_number: string | null;
  neighborhood: string | null;
  complement: string | null;
  reference: string | null;
}): string[] {
  return [
    [o.address, o.address_number].filter(Boolean).join(', '),
    [o.neighborhood, o.complement].filter(Boolean).join(' – '),
    o.reference ? `Referência: ${o.reference}` : '',
  ].filter(Boolean);
}

export const normalizeText = (text: string) =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---- Fuso da loja e janela de promoção --------------------------------------------------------------

export const STORE_TIMEZONE = 'America/Sao_Paulo';

// Quanto o relógio do fuso está à frente (ou atrás) do UTC naquele instante, em milissegundos.
function zoneOffsetMs(ts: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ts))
      .map((part) => [part.type, part.value]),
  );
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - Math.floor(ts / 1000) * 1000;
}

// "2026-12-24T18:00" digitado no painel vale como horário da LOJA (não do computador de quem digita) → instante ISO em UTC.
export function localToIso(value: string, timeZone = STORE_TIMEZONE): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const asUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let ts = asUtc - zoneOffsetMs(asUtc, timeZone);
  ts = asUtc - zoneOffsetMs(ts, timeZone);
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// O contrário: instante guardado → "AAAA-MM-DDTHH:mm" no horário da loja, para o campo de data e hora.
export function isoToLocal(iso: string | null | undefined, timeZone = STORE_TIMEZONE): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export type PromoState = 'none' | 'scheduled' | 'active' | 'expired';

// Situação da promoção do produto agora: sem preço promocional, agendada (ainda não começou), valendo ou encerrada.
export function promoState(p: { promo_price: number | null; promo_starts_at?: string | null; promo_ends_at?: string | null }, now = Date.now()): PromoState {
  if (p.promo_price === null || p.promo_price === undefined) return 'none';
  if (p.promo_starts_at && new Date(p.promo_starts_at).getTime() > now) return 'scheduled';
  if (p.promo_ends_at && new Date(p.promo_ends_at).getTime() <= now) return 'expired';
  return 'active';
}
