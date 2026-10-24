import { Minus, Plus, Snowflake, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flavorsCounter, flavorsHint, flavorsTitle, sumPicks } from '../lib/flavors';
import type { FlavorPick } from '../lib/flavors';
import { useShop } from './data';
import type { CartLine, Product } from './data';
import { FlavorPickerContext } from './flavorPicker';
import type { FlavorPickerApi } from './flavorPicker';
import { BLUE_BUTTON, ProductImage, SoldOutBadge } from './ui';

// "Escolha os 4 gelos saborizados": ao adicionar um combo que traz gelos, a pessoa monta os sabores (podendo repetir) entre os produtos que a loja cadastrou como
// gelo saborizado. Nada é inventado nem fixo: a lista vem do cadastro (`flavoredIce`), esgotado aparece mas não se escolhe, e o botão de confirmar só liga com
// exatamente a quantidade que o combo traz. O banco confere tudo de novo ao criar o pedido.

const STEP = 'tap grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30 disabled:hover:bg-transparent';

function FlavorCard({ flavor, qty, canAdd, onChange }: { flavor: Product; qty: number; canAdd: boolean; onChange: (qty: number) => void }) {
  const name = flavor.name;
  return (
    <li
      data-flavor={flavor.id}
      data-flavor-qty={qty}
      className={`flex flex-col rounded-2xl border p-2.5 transition-colors ${qty > 0 ? 'border-[#2563FF] bg-[#145CFF]/15 ring-1 ring-[#2563FF]' : 'border-white/10 bg-white/[0.04]'}`}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
        <ProductImage product={flavor} padding="p-1.5" />
        {flavor.soldOut && <SoldOutBadge className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />}
      </div>
      <p className={`mt-2 line-clamp-2 min-h-[2.5rem] text-sm font-bold leading-tight ${flavor.soldOut ? 'text-white/55' : 'text-white'}`}>{name}</p>
      <div role="group" aria-label={`Quantidade de ${name}`} className="mt-2 flex items-center justify-between rounded-full border border-white/15 bg-black/20">
        <button type="button" onClick={() => onChange(qty - 1)} disabled={qty <= 0} aria-label={`Tirar um ${name}`} className={STEP}>
          <Minus className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="w-8 text-center text-base font-black tabular-nums text-white" data-qty={qty} aria-live="polite">
          {qty}
        </span>
        <button
          type="button"
          onClick={() => onChange(qty + 1)}
          disabled={flavor.soldOut || !canAdd}
          aria-label={flavor.soldOut ? `${name} esgotado` : canAdd ? `Adicionar um ${name}` : `Adicionar um ${name} (já escolheu todos os gelos; tire um para trocar)`}
          className={STEP}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

type Target = { id: number; mode: 'add'; product: Product } | { id: number; mode: 'edit'; line: CartLine };

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Folha de baixo no celular (o contador no topo e os botões embaixo ficam sempre à vista; só a lista de sabores rola), janela no centro no computador.
function FlavorSheet({ target, onClose, onConfirm }: { target: Target; onClose: () => void; onConfirm: (picks: FlavorPick[]) => void }) {
  const { products } = useShop();
  const combo = target.mode === 'add' ? target.product : target.line.product;
  const count = combo.comboIces;
  // Os sabores possíveis: só os produtos cadastrados como gelo saborizado; os disponíveis primeiro (a ordem do cardápio se mantém dentro de cada grupo).
  const flavors = useMemo(() => {
    const all = products.filter((p) => p.flavoredIce && p.id !== combo.id);
    return [...all.filter((p) => !p.soldOut), ...all.filter((p) => p.soldOut)];
  }, [products, combo.id]);
  const [picks, setPicks] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    if (target.mode === 'edit') for (const f of target.line.flavors ?? []) if (flavors.some((p) => p.id === f.id)) initial[f.id] = f.qty;
    return initial;
  });
  const [shown, setShown] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const hintId = useId();

  const total = Object.values(picks).reduce((sum, n) => sum + n, 0);
  const complete = total === count;
  const anyAvailable = flavors.some((p) => !p.soldOut);
  const stale = flavors.filter((p) => p.soldOut && (picks[p.id] ?? 0) > 0);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => setShown(true));
    const dialog = dialogRef.current;
    closeRef.current?.focus();
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

  const change = (flavor: Product, qty: number) => {
    const next = Math.max(0, qty);
    const without = Object.fromEntries(Object.entries(picks).filter(([id]) => id !== flavor.id));
    if (next > (picks[flavor.id] ?? 0) && total >= count) return;
    const updated = next > 0 ? { ...without, [flavor.id]: next } : without;
    setPicks(updated);
    const sum = Object.values(updated).reduce((s, n) => s + n, 0);
    setAnnouncement(`${flavorsCounter(sum, count)}.`);
  };

  const confirm = () => {
    if (!complete) return;
    onConfirm(Object.entries(picks).map(([id, qty]) => ({ id, qty })));
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-6">
      <div onClick={onClose} className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 motion-reduce:transition-none ${shown ? 'opacity-100' : 'opacity-0'}`} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        data-flavor-sheet=""
        className={`relative flex max-h-[94dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-[2rem] border border-white/10 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] shadow-[0_-30px_100px_-30px_rgba(20,92,255,0.7)] transition-all duration-300 ease-out motion-reduce:transition-none sm:max-h-[90dvh] sm:rounded-[2rem] sm:shadow-[0_30px_100px_-30px_rgba(20,92,255,0.7)] ${
          shown ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'
        }`}
      >
        <div className="shrink-0 px-5 pt-5 sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold tracking-[0.14em] text-[#8FB1FF]">{target.mode === 'add' ? 'ANTES DE ADICIONAR' : 'ALTERAR OS GELOS'}</p>
              <h2 id={titleId} className="mt-0.5 flex items-center gap-2 text-xl font-black leading-tight text-white">
                <Snowflake className="h-5 w-5 shrink-0 text-[#2563FF]" aria-hidden="true" />
                {flavorsTitle(count)}
              </h2>
              <p className="mt-1 line-clamp-1 text-sm font-semibold text-white/60">{combo.name}</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Fechar a escolha dos gelos"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-white/15 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <p id={hintId} className="mt-2 text-sm leading-snug text-white/70">
            {flavorsHint(count)}
          </p>
          <p
            data-flavor-counter={total}
            className={`mt-3 flex items-center justify-between gap-3 rounded-2xl border px-3.5 py-2.5 text-sm font-black ${complete ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-100' : 'border-[#2563FF]/40 bg-[#145CFF]/15 text-white'}`}
          >
            <span>{flavorsCounter(total, count)}</span>
            <span aria-hidden="true" className="flex gap-1">
              {Array.from({ length: count }, (_, i) => (
                <span key={i} className={`h-2 w-4 rounded-full ${i < total ? 'bg-[#2563FF]' : 'bg-white/20'}`} />
              ))}
            </span>
          </p>
          {stale.length > 0 && (
            <p role="alert" className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-3.5 py-2.5 text-sm text-rose-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {stale.map((p) => p.name).join(', ')} esgotou. Tire e escolha outro sabor.
            </p>
          )}
          {!anyAvailable && (
            <p role="alert" className="mt-3 flex items-start gap-2 rounded-2xl border border-amber-400/40 bg-amber-400/10 px-3.5 py-2.5 text-sm text-amber-100">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              Nenhum sabor de gelo está disponível agora. Tente de novo em alguns instantes.
            </p>
          )}
        </div>

        <ul className="mt-3 grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto px-5 pb-3 sm:grid-cols-3 sm:px-6" data-flavor-list="">
          {flavors.map((flavor) => (
            <FlavorCard key={flavor.id} flavor={flavor} qty={picks[flavor.id] ?? 0} canAdd={total < count} onChange={(qty) => change(flavor, qty)} />
          ))}
        </ul>

        <div className="shrink-0 border-t border-white/10 bg-[#060913]/80 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6 sm:pb-5">
          <div className="grid grid-cols-[auto_1fr] gap-3">
            <button
              type="button"
              onClick={onClose}
              className="tap inline-flex min-h-12 items-center justify-center rounded-full border border-white/20 px-5 text-sm font-bold text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Cancelar
            </button>
            <button
              type="button"
              data-flavor-confirm=""
              onClick={confirm}
              disabled={!complete}
              className={`${BLUE_BUTTON} min-h-12 px-3 text-center text-sm leading-tight disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:scale-100`}
            >
              {target.mode === 'add' ? 'Confirmar sabores e adicionar ao carrinho' : 'Confirmar sabores'}
            </button>
          </div>
          {!complete && (
            <p className="mt-2 text-center text-xs text-white/60">
              Faltam {Math.max(0, count - total)} {count - total === 1 ? 'gelo' : 'gelos'} para confirmar.
            </p>
          )}
        </div>
        <div role="status" aria-live="polite" className="sr-only">
          {announcement}
        </div>
      </div>
    </div>
  );
}

// Uma só escolha de gelos para o site inteiro: os cartões dos combos, a gaveta do pedido e o checkout chamam daqui.
export function FlavorPickerProvider({ children }: { children: ReactNode }) {
  const { cart } = useShop();
  const [target, setTarget] = useState<Target | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const counter = useRef(0);

  const api = useMemo<FlavorPickerApi>(
    () => ({
      pick: (product) => setTarget({ id: ++counter.current, mode: 'add', product }),
      edit: (line) => setTarget({ id: ++counter.current, mode: 'edit', line }),
    }),
    [],
  );

  const confirm = (picks: FlavorPick[]) => {
    if (!target) return;
    if (target.mode === 'add') {
      cart.addFlavored(target.product, picks);
      // O aviso dos combos ("pagar a diferença ao trocar o energético") e o atalho da troca aparecem como sempre, logo depois de adicionar.
      cart.announce(target.product);
      setAnnouncement(`${target.product.name} adicionado ao pedido com ${sumPicks(picks)} gelos saborizados.`);
    } else {
      cart.setFlavors(target.line.key, picks);
      setAnnouncement(`${target.line.product.name}: gelos alterados.`);
    }
    setTarget(null);
  };

  return (
    <FlavorPickerContext.Provider value={api}>
      {children}
      {target && <FlavorSheet key={target.id} target={target} onClose={() => setTarget(null)} onConfirm={confirm} />}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </FlavorPickerContext.Provider>
  );
}
