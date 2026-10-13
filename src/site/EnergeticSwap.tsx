import { Minus, Plus, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { COMBO_NOTE, isEnergetico2L } from '../lib/combo';
import { unitPrice, useShop } from './data';
import type { Product } from './data';
import { EnergeticSwapContext } from './energeticSwap';
import { BLUE_BUTTON, ProductImage, ProductPrice, SoldOutBadge } from './ui';

// "QUERO TROCAR O ENERGÉTICO" (combos): lista os energéticos de 2L do site, cada um com "Adicionar" ao pedido. O energético escolhido entra
// no pedido como item próprio, pelo preço dele; o texto da janela repete o aviso dos combos (pagar a diferença).

function EnergeticRow({ product, qty, setQty, announce }: { product: Product; qty: number; setQty: (id: string, qty: number) => void; announce: (text: string) => void }) {
  const name = product.name;
  const btn = 'grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30';
  return (
    <li data-energetic={product.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
        <ProductImage product={product} padding="p-1" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 text-sm font-bold leading-tight text-white">{name}</p>
        <div className="mt-1 text-sm">{product.soldOut ? <SoldOutBadge /> : <ProductPrice product={product} className="text-base" />}</div>
      </div>
      {product.soldOut ? null : qty === 0 ? (
        <button
          type="button"
          onClick={() => {
            setQty(product.id, 1);
            announce(`${name} adicionado ao pedido.`);
          }}
          aria-label={`Adicionar ${name} ao pedido`}
          className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[#145CFF] px-3.5 text-[13px] font-bold text-white shadow-[0_10px_26px_-10px_rgba(20,92,255,0.9)] transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Adicionar
        </button>
      ) : (
        <div role="group" aria-label={`Quantidade de ${name}`} className="flex shrink-0 items-center rounded-full border border-[#2563FF]/60 bg-[#145CFF]/15">
          <button type="button" onClick={() => setQty(product.id, qty - 1)} aria-label={qty === 1 ? `Remover ${name} do pedido` : `Diminuir ${name}`} className={btn}>
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <span className="w-6 text-center text-sm font-bold tabular-nums text-white" data-qty={qty}>
            {qty}
          </span>
          <button type="button" onClick={() => setQty(product.id, qty + 1)} aria-label={`Aumentar ${name}`} className={btn}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </li>
  );
}

function EnergeticSheet({ items, onClose }: { items: Product[]; onClose: () => void }) {
  const { cart } = useShop();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [announcement, setAnnouncement] = useState('');

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

  const inOrder = items.reduce((sum, p) => sum + cart.countOf(p.id), 0);

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
        <p className="px-5 pb-3 text-sm font-semibold leading-snug text-amber-100 sm:px-6">Energéticos de 2L: escolha o que você quer e toque em Adicionar. Obs: {COMBO_NOTE}</p>
        <ul className="flex-1 space-y-3 overflow-y-auto px-5 py-2 sm:px-6">
          {items.map((product) => (
            <EnergeticRow key={product.id} product={product} qty={cart.countOf(product.id)} setQty={cart.setQty} announce={setAnnouncement} />
          ))}
        </ul>
        <div className="border-t border-white/10 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
          <button type="button" onClick={onClose} className={`${BLUE_BUTTON} w-full py-4`}>
            Pronto{inOrder > 0 ? ` (${inOrder} no pedido)` : ''}
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
  const [open, setOpen] = useState(false);
  const items = useMemo(
    () =>
      products
        .filter((p) => isEnergetico2L(p))
        .sort((a, b) => Number(a.soldOut) - Number(b.soldOut) || unitPrice(a) - unitPrice(b) || a.name.localeCompare(b.name, 'pt-BR')),
    [products],
  );
  const available = items.length > 0;
  const api = useMemo(() => ({ open: () => setOpen(true), available }), [available]);
  const close = useMemo(() => () => setOpen(false), []);

  return (
    <EnergeticSwapContext.Provider value={api}>
      {children}
      {open && available && <EnergeticSheet items={items} onClose={close} />}
    </EnergeticSwapContext.Provider>
  );
}
