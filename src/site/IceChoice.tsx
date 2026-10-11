import { Check, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { money } from '../lib/format';
import { ICE_CHOICES, ICE_INFO, ICE_QUESTION, ICE_REQUIRED_MESSAGE } from '../lib/ice';
import type { IceChoice } from '../lib/ice';
import { unitPrice, useShop } from './data';
import type { CartLine, Product } from './data';
import { IcePickerContext } from './icePicker';
import type { IcePickerApi } from './icePicker';
import { BLUE_BUTTON, ProductImage, ProductPrice } from './ui';

// "Qual gelo você prefere?": dois cartões, um escolhido por vez. É a mesma pergunta ao adicionar um produto e ao trocar o gelo de uma
// linha que já está no pedido. Os botões de rádio de verdade ficam por baixo (teclado, leitor de tela e setas funcionam sozinhos).
function IceOptions({
  name,
  value,
  invalid,
  describedBy,
  onChange,
  firstRef,
}: {
  name: string;
  value: IceChoice | null;
  invalid: boolean;
  describedBy?: string;
  onChange: (choice: IceChoice) => void;
  firstRef: RefObject<HTMLInputElement | null>;
}) {
  const labelId = useId();
  return (
    <div>
      <p id={labelId} className="text-base font-black text-white">
        {ICE_QUESTION}{' '}
        <span aria-hidden="true" className="text-rose-300">
          *
        </span>
        <span className="sr-only"> (obrigatório)</span>
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-required="true"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="mt-3 grid grid-cols-2 gap-3"
      >
        {ICE_CHOICES.map((choice, index) => {
          const checked = value === choice;
          return (
            <label
              key={choice}
              data-ice={choice}
              className={`relative flex min-h-[7.5rem] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-2xl border px-3 py-4 text-center transition-all duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white motion-reduce:transition-none ${
                checked
                  ? 'border-[#2563FF] bg-[#145CFF]/20 shadow-[0_0_30px_-10px_rgba(20,92,255,0.95)] ring-1 ring-[#2563FF]'
                  : invalid
                    ? 'border-rose-400/60 bg-rose-500/[0.06] hover:border-rose-300'
                    : 'border-white/15 bg-white/[0.04] hover:border-white/35 hover:bg-white/[0.07]'
              }`}
            >
              <input
                ref={index === 0 ? firstRef : undefined}
                type="radio"
                name={name}
                value={choice}
                checked={checked}
                onChange={() => onChange(choice)}
                className="sr-only"
              />
              <span aria-hidden="true" className="text-4xl leading-none">
                {ICE_INFO[choice].emoji}
              </span>
              <span className="text-sm font-bold leading-tight text-white">{ICE_INFO[choice].label}</span>
              {checked && (
                <span aria-hidden="true" className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-[#2563FF] shadow-[0_0_14px_rgba(37,99,255,0.9)]">
                  <Check className="h-3 w-3 text-white" />
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

type Target = { id: number; mode: 'add'; product: Product } | { id: number; mode: 'edit'; line: CartLine };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Folha de baixo no celular, janela no centro no computador.
function IceSheet({ target, onClose, onConfirm }: { target: Target; onClose: () => void; onConfirm: (choice: IceChoice) => void }) {
  const product = target.mode === 'add' ? target.product : target.line.product;
  const [choice, setChoice] = useState<IceChoice | null>(target.mode === 'edit' ? target.line.ice : null);
  const [invalid, setInvalid] = useState(false);
  const [shown, setShown] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRadio = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const errorId = useId();
  const groupName = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => setShown(true));
    const dialog = dialogRef.current;
    (dialog?.querySelector<HTMLInputElement>('input[type="radio"]:checked') ?? firstRadio.current)?.focus();
    // Captura: com a gaveta do pedido aberta por baixo, o Esc fecha só esta janela.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
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
  }, []);

  const confirm = () => {
    if (!choice) {
      setInvalid(true);
      firstRadio.current?.focus();
      return;
    }
    onConfirm(choice);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div onClick={onClose} className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`relative max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[2rem] border border-white/10 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 shadow-[0_-30px_100px_-30px_rgba(20,92,255,0.7)] transition-all duration-300 ease-out motion-reduce:transition-none sm:rounded-[2rem] sm:px-6 sm:pb-6 sm:shadow-[0_30px_100px_-30px_rgba(20,92,255,0.7)] ${
          shown ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
              <ProductImage product={product} padding="p-1" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-[#8FB1FF]">{target.mode === 'add' ? 'ANTES DE ADICIONAR' : 'TROCAR O GELO'}</p>
              <h2 id={titleId} className="mt-0.5 line-clamp-2 text-lg font-black leading-tight text-white">
                {product.name}
              </h2>
              <ProductPrice product={product} className="mt-0.5 text-base" />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/15 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="mt-5">
          <IceOptions
            name={groupName}
            value={choice}
            invalid={invalid}
            describedBy={invalid ? errorId : undefined}
            firstRef={firstRadio}
            onChange={(next) => {
              setChoice(next);
              setInvalid(false);
            }}
          />
          {invalid && (
            <p id={errorId} role="alert" className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {ICE_REQUIRED_MESSAGE}
            </p>
          )}
        </div>

        <button type="button" onClick={confirm} className={`${BLUE_BUTTON} mt-5 w-full py-4`}>
          {target.mode === 'add' ? `Adicionar ao pedido · ${money(unitPrice(product))}` : 'Salvar escolha'}
        </button>
      </div>
    </div>
  );
}

// Uma só pergunta de gelo para o site inteiro: os cartões de produto, a gaveta do pedido, o checkout e "pedir de novo" chamam daqui.
export function IcePickerProvider({ children }: { children: ReactNode }) {
  const { cart } = useShop();
  const [target, setTarget] = useState<Target | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const counter = useRef(0);

  const api = useMemo<IcePickerApi>(
    () => ({
      pick: (product) => setTarget({ id: ++counter.current, mode: 'add', product }),
      edit: (line) => setTarget({ id: ++counter.current, mode: 'edit', line }),
    }),
    [],
  );

  const confirm = (choice: IceChoice) => {
    if (!target) return;
    if (target.mode === 'add') {
      cart.add(target.product, choice, 1);
      setAnnouncement(`${target.product.name} adicionado ao pedido com ${ICE_INFO[choice].label.toLowerCase()}.`);
    } else {
      cart.changeIce(target.line.key, choice);
      setAnnouncement(`${target.line.product.name}: agora com ${ICE_INFO[choice].label.toLowerCase()}.`);
    }
    setTarget(null);
  };

  return (
    <IcePickerContext.Provider value={api}>
      {children}
      {target && <IceSheet key={target.id} target={target} onClose={() => setTarget(null)} onConfirm={confirm} />}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </IcePickerContext.Provider>
  );
}
