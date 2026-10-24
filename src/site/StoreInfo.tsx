import { Banknote, Clock, CreditCard, Info, QrCode, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { PAYMENT_LABEL } from '../lib/format';
import { DAYS, dayHoursText, nextOpening, todayKey } from '../lib/hours';
import type { PaymentMethod } from '../lib/types';
import { acceptedPayments, useShop } from './data';
import { BrandName } from './ui';

// O botão ⓘ da página Bebidas e a janela com o horário de funcionamento e as formas de pagamento. Tudo vem do que o owner já cadastra no painel
// (Horários e Pagamento): nada é escrito à mão aqui, e uma forma de pagamento desligada no painel simplesmente não aparece.

// "Aberto agora" / "Fechado · Abre amanhã às 09:00"
export function OpenStatus() {
  const { store, isOpen } = useShop();
  const next = isOpen ? '' : store.orders_paused ? 'Pedidos pausados' : nextOpening(store.opening_hours, store.timezone, new Date(), store.exceptions);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${
        isOpen ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30' : 'bg-white/5 text-white/60 ring-white/15'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${isOpen ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.9)]' : 'bg-white/40'}`} />
      {isOpen ? 'Aberto agora' : `Fechado${next ? ` · ${next}` : ''}`}
    </span>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// De domingo a sábado (a lista do painel começa na segunda).
const WEEK = [DAYS[6], ...DAYS.slice(0, 6)];

function Section({ icon, title, children, ...rest }: { icon: ReactNode; title: string; children: ReactNode; 'data-section'?: string }) {
  return (
    <section {...rest} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="flex items-center gap-2.5 text-sm font-bold text-white">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#145CFF]/15 text-[#2563FF]">{icon}</span>
        {title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

const PAYMENT_NOTE: Partial<Record<PaymentMethod, string>> = { card: 'na entrega ou na retirada' };

function PaymentIcon({ code }: { code: PaymentMethod }) {
  const cls = 'h-4 w-4';
  if (code === 'pix') return <QrCode className={cls} aria-hidden="true" />;
  if (code === 'cash') return <Banknote className={cls} aria-hidden="true" />;
  return <CreditCard className={cls} aria-hidden="true" />;
}

function StoreInfoDialog({ onClose }: { onClose: () => void }) {
  const { store, payments } = useShop();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const captionId = useId();
  const titleId = useId();
  const [shown, setShown] = useState(false);
  // O dia de hoje (no fuso da loja) é o de quando a janela abriu.
  const [today] = useState(() => todayKey(store.timezone));

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    // A página de trás não rola enquanto a janela está aberta.
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => setShown(true));
    closeRef.current?.focus();
    // Fase de captura: o Esc fecha só esta janela. Tab e Shift+Tab ficam presos dentro dela.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      const dialog = dialogRef.current;
      if (e.key !== 'Tab' || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !dialog.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !dialog.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [onClose]);

  const accepted = acceptedPayments(payments);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`absolute inset-0 bg-black/75 backdrop-blur-sm transition-opacity duration-200 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${captionId} ${titleId}`}
        data-store-info
        className={`relative flex max-h-[min(46rem,calc(100dvh-2rem))] w-full max-w-md flex-col overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#07080D] shadow-[0_30px_90px_-30px_rgba(20,92,255,0.55)] transition-all duration-200 ease-out motion-reduce:transition-none ${
          shown ? 'translate-y-0 scale-100 opacity-100' : 'translate-y-3 scale-[0.98] opacity-0'
        }`}
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-[radial-gradient(90%_100%_at_50%_0%,rgba(20,92,255,0.28),transparent_75%)]" />

        <div className="relative flex items-start justify-between gap-3 px-5 pb-3 pt-5">
          <div className="min-w-0">
            <p id={captionId} className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#8FB1FF]">
              Informações da loja
            </p>
            <h2 id={titleId} className="mt-1 text-2xl font-black leading-tight tracking-tight text-white">
              <BrandName name={store.store_name} />
            </h2>
            {store.tagline && <p className="text-sm font-medium text-white/60">{store.tagline}</p>}
            <div className="mt-3">
              <OpenStatus />
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Fechar informações da loja"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/15 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Focável para quem navega pelo teclado conseguir rolar a lista quando ela não cabe na tela (não há outro item focável aqui dentro). */}
        <div
          tabIndex={0}
          role="region"
          aria-label="Horário de funcionamento e formas de pagamento"
          className="relative space-y-3 overflow-y-auto overscroll-contain px-5 pb-5 pt-1 [color-scheme:dark] [scrollbar-color:rgb(255_255_255/0.25)_transparent] [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#2563FF]/70"
        >
          <Section icon={<Clock className="h-4 w-4" aria-hidden="true" />} title="Horário de funcionamento" data-section="hours">
            <ul className="space-y-1">
              {WEEK.map((day) => {
                const hours = store.opening_hours[day.key];
                const closed = !hours?.open;
                const isToday = day.key === today;
                return (
                  <li
                    key={day.key}
                    data-day={day.key}
                    data-closed={closed ? 'true' : undefined}
                    data-today={isToday ? 'true' : undefined}
                    aria-current={isToday ? 'date' : undefined}
                    className={`flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm ${
                      isToday ? 'bg-[#145CFF]/15 ring-1 ring-[#2563FF]/50' : ''
                    }`}
                  >
                    <span className={`flex items-center gap-2 ${isToday ? 'font-bold text-white' : 'text-white/75'}`}>
                      {day.label}
                      {isToday && <span className="rounded-full bg-[#145CFF] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">Hoje</span>}
                    </span>
                    <span className={`tabular-nums ${closed ? 'font-semibold text-rose-300' : isToday ? 'font-bold text-white' : 'font-medium text-white/85'}`}>{dayHoursText(hours)}</span>
                  </li>
                );
              })}
            </ul>
          </Section>

          {accepted.length > 0 && (
            <Section icon={<CreditCard className="h-4 w-4" aria-hidden="true" />} title="Formas de pagamento" data-section="payments">
              <ul className="flex flex-wrap gap-2">
                {accepted.map((p) => (
                  <li key={p.code} data-payment={p.code} className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white">
                    <span className="text-[#2563FF]">
                      <PaymentIcon code={p.code} />
                    </span>
                    <span className="font-semibold">{PAYMENT_LABEL[p.code]}</span>
                    {PAYMENT_NOTE[p.code] && <span className="text-xs text-white/55">{PAYMENT_NOTE[p.code]}</span>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// O ⓘ: pequeno e discreto, ao lado do status de funcionamento.
export function StoreInfoButton({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Horário de funcionamento e formas de pagamento"
        title="Horário e formas de pagamento"
        data-store-info-trigger
        className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/15 text-white/60 transition-all duration-150 after:absolute after:-inset-2 after:content-[''] hover:scale-110 hover:border-[#2563FF] hover:bg-[#145CFF]/15 hover:text-white hover:shadow-[0_0_14px_rgba(37,99,255,0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-reduce:transition-none motion-reduce:hover:scale-100 ${className}`}
      >
        <Info className="h-4 w-4" aria-hidden="true" />
      </button>
      {open && <StoreInfoDialog onClose={close} />}
    </>
  );
}
