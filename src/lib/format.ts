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
