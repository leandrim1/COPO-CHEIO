import { GlassWater, Minus, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { money } from '../lib/format';
import { instagramHandle, unitPrice, useShop } from './data';
import type { CartLine, Product } from './data';

// Peças visuais usadas em mais de uma página do site.

export const WHATSAPP_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-6 py-3.5 text-[15px] font-extrabold text-[#04210F] shadow-[0_16px_40px_-14px_rgba(37,211,102,0.8)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#3DE07A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
export const GHOST_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full border border-white/25 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white backdrop-blur-md transition-all duration-200 hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
export const BLUE_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#145CFF] px-6 py-3.5 text-[15px] font-extrabold text-white shadow-[0_16px_40px_-14px_rgba(20,92,255,0.95)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export const NAV_LINKS = ['Início', 'Bebidas', 'Contato'];
export const NAV_HREF: Record<string, string> = { Início: '/', Bebidas: '/bebidas', Contato: '/#contato' };

export function WhatsAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

export function InstagramIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IceCube({ className, delay = '0s' }: { className: string; delay?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute cc-float ${className}`} style={{ animationDelay: delay }}>
      <div className="relative h-full w-full rotate-12">
        <img
          src="/gelo.webp"
          alt=""
          width={320}
          height={320}
          decoding="async"
          className="h-full w-full object-contain drop-shadow-[0_8px_12px_rgba(20,92,255,0.5)]"
        />
      </div>
    </div>
  );
}

// "Copo Cheio" → COPO + CHEIO em azul (a última palavra do nome fica azul).
export function BrandName({ name }: { name: string }) {
  const words = name.trim().toUpperCase().split(/\s+/);
  if (words.length < 2) return <>{words[0]}</>;
  return (
    <>
      {`${words.slice(0, -1).join(' ')} `}
      <span className="text-[#2563FF]">{words[words.length - 1]}</span>
    </>
  );
}

// Pinta de azul o trecho "highlight" dentro do título (se ele aparecer no título).
export function Highlight({ text, highlight, className }: { text: string; highlight?: string | null; className: string }) {
  const at = highlight ? text.indexOf(highlight) : -1;
  if (!highlight || at < 0) return <>{text}</>;
  // Os espaços em volta do trecho ficam em nós de texto próprios, como no texto escrito à mão.
  const before = text.slice(0, at);
  const after = text.slice(at + highlight.length);
  return (
    <>
      {before.trimEnd()}
      {before !== before.trimEnd() && ' '}
      <span className={className}>{highlight}</span>
      {after !== after.trimStart() && ' '}
      {after.trimStart()}
    </>
  );
}

export function Price({ value, className = '' }: { value: number; className?: string }) {
  const [symbol, ...rest] = money(value).split(/\s/);
  return (
    <span className={`inline-flex items-baseline gap-1 font-black tracking-tight text-white ${className}`}>
      <span className="text-[0.55em] font-bold text-[#8FB1FF]">{symbol}</span>
      <span>{rest.join(' ')}</span>
    </span>
  );
}

// Preço do produto; com promoção mostra também o preço antigo riscado.
export function ProductPrice({ product, className = '' }: { product: Product; className?: string }) {
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      <Price value={unitPrice(product)} className={className} />
      {product.promoPrice !== null && (
        <s className="text-sm font-medium text-white/45">
          <span className="sr-only">de </span>
          {money(product.price)}
        </s>
      )}
    </span>
  );
}

export function ProductImage({ product, padding = 'p-3 sm:p-4' }: { product: Product; padding?: string }) {
  const [failed, setFailed] = useState(false);
  if (!product.image || failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-[#2563FF]/60" aria-hidden="true">
        <GlassWater className="h-1/3 w-1/3" strokeWidth={1.25} />
      </div>
    );
  }
  return (
    <img
      src={product.image}
      alt={product.name}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`absolute inset-0 h-full w-full object-contain drop-shadow-[0_14px_18px_rgba(0,0,0,0.45)] transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:transform-none ${padding} ${product.soldOut ? 'opacity-45 grayscale' : ''}`}
    />
  );
}

export function SoldOutBadge({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-rose-500/90 px-2.5 py-1 text-[10px] font-black tracking-[0.14em] text-white shadow-[0_0_18px_rgba(244,63,94,0.55)] ${className}`}
    >
      ESGOTADO
    </span>
  );
}

export function Footer() {
  const { store, logo } = useShop();
  const handle = instagramHandle(store);
  return (
    <footer className="border-t border-white/10 bg-[#050505] py-10">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-5 text-center sm:px-8 md:flex-row md:justify-between md:text-left lg:px-12">
        <a href="/" className="flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#145CFF]">
          <img src={logo} alt="" width={44} height={44} loading="lazy" className="h-11 w-11 rounded-full object-contain ring-1 ring-white/15" />
          <span className="flex flex-col items-start leading-none">
            <span className="text-lg font-black tracking-tight text-white">
              <BrandName name={store.store_name} />
            </span>
            {store.tagline && (
              <span className="mt-1 text-[10px] font-semibold tracking-[0.2em] text-white/50">{store.tagline.toUpperCase()}</span>
            )}
          </span>
        </a>
        <nav aria-label="Rodapé" className="flex items-center gap-6 text-sm font-medium text-white/65">
          {NAV_LINKS.map((link) => (
            <a key={link} href={NAV_HREF[link]} className="transition-colors hover:text-white">
              {link}
            </a>
          ))}
          {handle && (
            <a
              href={`https://instagram.com/${handle}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Instagram @${handle}`}
              className="grid h-9 w-9 place-items-center rounded-full border border-white/15 text-white/75 transition-all hover:border-white/40 hover:text-white"
            >
              <InstagramIcon className="h-4 w-4" />
            </a>
          )}
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-7xl px-5 text-center text-xs text-white/40 sm:px-8 md:text-left lg:px-12">
        © {new Date().getFullYear()} {store.store_name} {store.tagline}. Todos os direitos reservados.
      </p>
    </footer>
  );
}

// Campo de formulário do site (checkout).
export const FIELD =
  'w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-[15px] text-white placeholder:text-white/35 focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/40 aria-[invalid=true]:border-rose-400/70';

export function CartLineItem({ line, setQty }: { line: CartLine; setQty: (id: string, qty: number) => void }) {
  const { product, qty } = line;
  return (
    <li className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
        <ProductImage product={product} padding="p-1" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-bold leading-tight text-white">{product.name}</p>
        {product.soldOut ? (
          <p className="mt-1 text-xs font-bold text-rose-300">Esgotado – remova do pedido</p>
        ) : (
          <p className="mt-1 text-sm font-semibold text-[#8FB1FF]">{money(unitPrice(product) * qty)}</p>
        )}
      </div>
      <div className="flex items-center rounded-full border border-white/15 bg-black/20">
        <button
          type="button"
          onClick={() => setQty(product.id, product.soldOut ? 0 : qty - 1)}
          aria-label={qty === 1 || product.soldOut ? `Remover ${product.name}` : `Diminuir ${product.name}`}
          className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {product.soldOut ? <X className="h-4 w-4" aria-hidden="true" /> : <Minus className="h-4 w-4" aria-hidden="true" />}
        </button>
        <span className="w-6 text-center text-sm font-bold tabular-nums text-white" aria-live="polite">
          {qty}
        </span>
        <button
          type="button"
          onClick={() => setQty(product.id, qty + 1)}
          disabled={product.soldOut}
          aria-label={`Aumentar ${product.name}`}
          className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}
