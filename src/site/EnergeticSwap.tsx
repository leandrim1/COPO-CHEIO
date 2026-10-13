import { Minus, Plus, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { COMBO_NOTE, canSwap, swapBaseOf, swapDifference, swapOptions } from '../lib/combo';
import { money } from '../lib/format';
import { plainCount, swappedCount } from '../lib/ice';
import { unitPrice, useShop } from './data';
import type { Product } from './data';
import { EnergeticSwapContext } from './energeticSwap';
import { BLUE_BUTTON, ProductImage, SoldOutBadge } from './ui';

// "QUERO TROCAR O ENERGÉTICO" (combos): lista os energéticos de 2L do site. Escolher um troca UMA unidade do combo pelo energético
// novo (o botão vira um contador para trocar mais ou voltar atrás) e o preço do combo passa a levar a diferença entre os dois
// energéticos. O banco recalcula tudo ao criar o pedido.

const STEP = 'grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30';

function EnergeticRow({ energetic, base, n, available, onSwap }: { energetic: Product; base: Product; n: number; available: number; onSwap: (delta: number) => void }) {
  const diff = swapDifference(energetic, base);
  const name = energetic.name;
  return (
    <li data-energetic={energetic.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
        <ProductImage product={energetic} padding="p-1" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-sm font-bold leading-tight text-white">{name}</p>
        {energetic.soldOut ? (
          <div className="mt-1">
            <SoldOutBadge />
          </div>
        ) : (
          <p data-swap-diff={diff} className={`mt-1 text-sm font-extrabold ${diff > 0 ? 'text-[#8FB1FF]' : 'text-emerald-300'}`}>
            {diff > 0 ? `+ ${money(diff)}` : 'Sem diferença'}
            <span className="ml-1 text-xs font-medium text-white/55">por combo</span>
          </p>
        )}
      </div>
      {energetic.soldOut ? null : n === 0 ? (
        <button
          type="button"
          disabled={available <= 0}
          onClick={() => onSwap(1)}
          aria-label={`Trocar por ${name}${diff > 0 ? `, mais ${money(diff)} por combo` : ', sem diferença de preço'}`}
          className="inline-flex h-10 shrink-0 items-center justify-center rounded-full bg-[#145CFF] px-3.5 text-[13px] font-bold text-white shadow-[0_10px_26px_-10px_rgba(20,92,255,0.9)] transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40"
        >
          Trocar
        </button>
      ) : (
        <div role="group" aria-label={`Combos com ${name}`} className="flex shrink-0 items-center rounded-full border border-[#2563FF]/60 bg-[#145CFF]/15">
          <button type="button" onClick={() => onSwap(-1)} aria-label={n === 1 ? `Voltar ao energético original (tirar ${name})` : `Diminuir os combos com ${name}`} className={STEP}>
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="w-6 text-center text-sm font-bold tabular-nums text-white" data-qty={n}>
            {n}
          </span>
          <button type="button" disabled={available <= 0} onClick={() => onSwap(1)} aria-label={`Trocar mais um combo por ${name}`} className={STEP}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

function EnergeticSheet({ combo, onClose }: { combo: Product; onClose: () => void }) {
  const { products, cart } = useShop();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const base = swapBaseOf(products, combo);
  const options = useMemo(
    () =>
      swapOptions(products, combo).sort(
        (a, b) => Number(a.soldOut) - Number(b.soldOut) || (base ? swapDifference(a, base) - swapDifference(b, base) : 0) || unitPrice(a) - unitPrice(b) || a.name.localeCompare(b.name, 'pt-BR'),
      ),
    [products, combo, base],
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    // Fase de captura: o Esc fecha só esta janela (a gaveta do pedido, se estiver por baixo, continua aberta).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [onClose]);

  if (!base) return null;
  const plain = plainCount(cart.cart, combo.id);
  const total = cart.countOf(combo.id);
  const swapped = options.reduce((sum, p) => sum + swappedCount(cart.cart, combo.id, p.id), 0);

  return (
    <div className="fixed inset-0 z-[60]">
      <div onClick={onClose} className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="energetico-titulo"
        className="absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col rounded-t-[2rem] border border-white/10 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] shadow-[0_-30px_100px_-30px_rgba(20,92,255,0.7)] sm:inset-y-0 sm:left-auto sm:max-h-none sm:w-[26rem] sm:rounded-l-[2rem] sm:rounded-tr-none"
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-5 sm:px-6">
          <h2 id="energetico-titulo" className="flex items-center gap-2.5 text-xl font-black text-white">
            <Zap className="h-5 w-5 shrink-0 text-[#2563FF]" aria-hidden="true" />
            Trocar o energético
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Fechar a lista de energéticos"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/15 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="px-5 pb-3 text-sm leading-snug sm:px-6">
          <p className="font-semibold text-white" data-swap-combo={combo.id}>
            Vem no combo: <span className="text-[#8FB1FF]">{base.name}</span>
          </p>
          <p className="mt-1 text-white/70">Energéticos de 2L: toque em Trocar e pague só a diferença de preço por combo.</p>
          <p className="mt-1 font-semibold text-amber-100">Obs: {COMBO_NOTE}</p>
          {total === 0 && <p className="mt-2 font-bold text-rose-200">Este combo não está mais no seu pedido.</p>}
          {total > 0 && plain === 0 && <p className="mt-2 font-bold text-amber-100">Todos os combos já estão com energético trocado. Diminua um para trocar por outro.</p>}
        </div>
        <ul className="flex-1 space-y-3 overflow-y-auto px-5 py-2 sm:px-6">
          {options.map((energetic) => (
            <EnergeticRow
              key={energetic.id}
              energetic={energetic}
              base={base}
              n={swappedCount(cart.cart, combo.id, energetic.id)}
              available={plain}
              onSwap={(delta) => {
                cart.swapBy(combo.id, energetic.id, delta);
                setAnnouncement(delta > 0 ? `Um combo trocado por ${energetic.name}.` : `Um combo voltou ao energético ${base.name}.`);
              }}
            />
          ))}
        </ul>
        <div className="border-t border-white/10 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
          <button type="button" onClick={onClose} className={`${BLUE_BUTTON} w-full py-4`}>
            Pronto{total > 0 ? ` (${swapped} de ${total} ${total === 1 ? 'combo trocado' : 'combos trocados'})` : ''}
          </button>
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    </div>
  );
}

// Uma só lista de energéticos para o site inteiro: o aviso dos combos e a linha do combo no pedido (gaveta e checkout) chamam daqui.
export function EnergeticSwapProvider({ children }: { children: ReactNode }) {
  const { products } = useShop();
  const [target, setTarget] = useState<Product | null>(null);
  const api = useMemo(() => ({ open: (combo: Product) => setTarget(combo), canSwap: (combo: Product) => canSwap(products, combo) }), [products]);
  const close = useMemo(() => () => setTarget(null), []);

  return (
    <EnergeticSwapContext.Provider value={api}>
      {children}
      {target && <EnergeticSheet key={target.id} combo={target} onClose={close} />}
    </EnergeticSwapContext.Provider>
  );
}
