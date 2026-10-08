import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Flame,
  GlassWater,
  MapPin,
  Minus,
  Motorbike,
  Navigation,
  Plus,
  Search,
  ShoppingBag,
  Snowflake,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';

const BRAND_NAME = 'COPO CHEIO';
const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260508_215831_c6a8989c-d716-4d8d-8745-e972a2eec711.mp4';

// Dados da loja. Preencha aqui (ou pelas variáveis VITE_* do deploy): o que ficar vazio não aparece no site.
const env = import.meta.env;
const STORE = {
  whatsapp: String(env.VITE_WHATSAPP ?? ''), // só números, com 55 + DDD. Ex.: 5511999999999
  instagram: String(env.VITE_INSTAGRAM ?? 'copocheiodisk'),
  address: String(env.VITE_ADDRESS ?? ''),
  hours: String(env.VITE_HOURS ?? 'Segunda à Sexta - 09:00 às 23:00'),
  deliveryTime: String(env.VITE_DELIVERY_TIME ?? '30 a 45 min'),
  deliveryFee: String(env.VITE_DELIVERY_FEE ?? 'R$ 5,00'),
};

// "Pedir agora" leva ao pedido: a página Bebidas (ou à gaveta do pedido, se já houver itens).
const ORDER_HREF = '/bebidas';

// The background video shows a hand moving around the middle of the frame (≈39–60% of its
// width, from the bottom almost to the top). That vertical band of the video is masked out,
// with a margin. Values are fractions of the video frame.
const HAND_BAND = { start: 0.3, end: 0.7, fade: 0.07 };
// Largest the cup box gets on desktop, as a fraction of the video's rendered height.
const CUP_MAX_SIZE = 0.82;
// On desktop the whole cup must stay visible: it is fitted between the nav and the bottom edge
// (px kept clear above and below; the bottom one also holds the carousel dots and the float animation).
const CUP_MARGIN = { top: 100, bottom: 36 };
// Horizontal centre of a drink inside its image: every image has the product centred.
const CUP_CENTER_IN_IMAGE = 0.5;
// The widest a product gets, as a fraction of its image. On desktop the drink is centred in the
// space the hero copy leaves free: from COPY_RIGHT_EDGE (px: its left padding plus its max width,
// with some air) to CUP_RIGHT_MARGIN (px) short of the right edge.
const CUP_CONTENT_WIDTH = 0.58;
const COPY_RIGHT_EDGE = 520;
const CUP_RIGHT_MARGIN = 56;

// Drinks shown in rotation. Each image is a transparent 1100×1100 canvas with the product centred,
// resting on the same baseline and scaled to the same height, so they swap in place at the same size.
const SLIDE_MS = 4500;
const DRINKS = [
  { src: '/img/frozen-rosa.webp', alt: 'Frozen rosa com chantilly, calda de frutas vermelhas e picolé' },
  { src: '/img/frozen-chocolate.webp', alt: 'Copo cremoso com chocolate, maracujá e picolé de manga' },
  { src: '/img/energetico-azul.webp', alt: 'Energético azul em copo com gelo' },
];

const NAV_LINKS = ['Início', 'Bebidas', 'Contato'];
// Hidden on tablet so the pill never collides with the logo; everything shows from lg up.
const SECONDARY_LINKS = new Set(['Início']);

// Mobile-first fit: in portrait the hero is exactly one visible screen tall (dvh follows the browser's
// address bar, vh does not); the sections below it scroll. The cup area takes whatever height is left and the
// cup is sized to it with container units (the vh line is the fallback for older browsers). Landscape
// heroes are not height-locked, so there the cup keeps a window-based size and the hero may scroll.
const VIEWPORT_STYLES = `
.cc-screen { min-height: 100vh; min-height: 100dvh; }
.cc-cup-area { container-type: size; }
.cc-cup-box { width: clamp(6rem, calc(100vh - 32rem), 76vw); width: min(86cqw, 100cqh); }
@media (min-width: 640px) {
  .cc-cup-box { width: min(60vw, 38vh); width: min(60cqw, 100cqh); }
}
@media (orientation: portrait) {
  .cc-screen { height: 100vh; height: 100dvh; }
}
@media (prefers-reduced-motion: no-preference) {
  html { scroll-behavior: smooth; }
}
@media (orientation: landscape) {
  .cc-cup-area { container-type: normal; min-height: calc(min(60vw, 38vh) + 3.5rem); }
  .cc-cup-box { width: min(60vw, 38vh); }
}
@media (max-width: 639px) and (max-height: 760px) {
  .cc-copy { padding-bottom: 1.25rem; }
  .cc-h1 { margin-top: 0.75rem; font-size: 1.875rem; }
  .cc-lead { margin-top: 0.75rem; font-size: 13px; line-height: 1.45; }
  .cc-cta { margin-top: 1rem; flex-direction: row; gap: 0.5rem; }
  .cc-cta > a { flex: 1 1 0; padding-inline: 0.75rem; }
}
`;

const MOTION_STYLES = `
@keyframes cc-float {
  0%, 100% { transform: translate3d(0, 0, 0); }
  50% { transform: translate3d(0, -14px, 0); }
}
@keyframes cc-glow {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 0.95; transform: scale(1.08); }
}
.cc-float { animation: cc-float 7s ease-in-out infinite; will-change: transform; }
.cc-glow { animation: cc-glow 6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .cc-float, .cc-glow { animation: none; }
}
`;

type CupBox = { left: number; top: number; size: number };
type VideoFraming = { handMask?: string; cupBox: CupBox | null };

// Mirrors the video's object-cover/object-left framing to find where the hand is rendered.
// Returns the mask that hides it and the box the cup occupies over it; cupBox is null when
// the layout can't host the cup there (mobile, tablets and portrait windows), which keeps
// the regular placement.
function useVideoFraming(
  rootRef: RefObject<HTMLDivElement | null>,
  videoRef: RefObject<HTMLVideoElement | null>,
) {
  const [framing, setFraming] = useState<VideoFraming>({ cupBox: null });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root || !video) return;

    const update = () => {
      const { width, height } = root.getBoundingClientRect();
      const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const renderedHeight = Math.max(height, width / aspect);
      // object-left keeps the frame's left edge at x = 0, so band positions are plain offsets.
      const renderedWidth = renderedHeight * aspect;
      const bandStart = renderedWidth * HAND_BAND.start;
      const bandEnd = renderedWidth * HAND_BAND.end;
      const fade = renderedWidth * HAND_BAND.fade;
      const handMask = `linear-gradient(to right, #000 ${bandStart - fade}px, transparent ${bandStart}px, transparent ${bandEnd}px, #000 ${bandEnd + fade}px)`;

      // Decided by the window, not the page: the page's own height depends on the layout chosen.
      const { innerWidth, innerHeight } = window;
      if (innerWidth < 1024 || innerWidth / innerHeight < 1.2) {
        setFraming({ handMask, cupBox: null });
        return;
      }
      const available = Math.min(height, innerHeight) - CUP_MARGIN.top - CUP_MARGIN.bottom;
      const size = Math.min(renderedHeight * CUP_MAX_SIZE, available);
      // Centred between the hero copy and the right edge, so the drink balances the text instead
      // of leaving the right side empty; never closer to the copy than the widest drink needs.
      const centerX = Math.max(
        (COPY_RIGHT_EDGE + innerWidth - CUP_RIGHT_MARGIN) / 2,
        COPY_RIGHT_EDGE + (size * CUP_CONTENT_WIDTH) / 2,
      );
      setFraming({
        handMask,
        cupBox: {
          left: centerX - size * CUP_CENTER_IN_IMAGE,
          top: CUP_MARGIN.top + (available - size) / 2,
          size,
        },
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    video.addEventListener('loadedmetadata', update);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', update);
      window.removeEventListener('resize', update);
    };
  }, [rootRef, videoRef]);

  return framing;
}

// Stacks every drink in the same spot and cross-fades between them; the dots below pick one.
// The rotation pauses while a mouse hovers the dots or a keyboard user is focused on them.
function DrinkShowcase() {
  const [active, setActive] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => setActive((i) => (i + 1) % DRINKS.length), SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [active, paused]);

  return (
    <>
      <div className="absolute inset-0 cc-float drop-shadow-[0_30px_50px_rgba(0,0,0,0.55)]">
        {DRINKS.map((drink, i) => {
          const isActive = i === active;
          return (
            <img
              key={drink.src}
              src={drink.src}
              alt={isActive ? drink.alt : ''}
              aria-hidden={!isActive}
              width={1100}
              height={1100}
              decoding="async"
              fetchPriority={i === 0 ? 'high' : 'low'}
              className={`absolute inset-0 h-full w-full object-contain transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-opacity ${
                isActive
                  ? 'translate-y-0 scale-100 opacity-100'
                  : 'translate-y-3 scale-95 opacity-0 motion-reduce:translate-y-0 motion-reduce:scale-100'
              }`}
            />
          );
        })}
      </div>

      <div
        role="group"
        aria-label="Escolher bebida"
        onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={(e) => setFocused(e.target.matches(':focus-visible'))}
        onBlur={() => setFocused(false)}
        className="pointer-events-auto absolute left-1/2 top-full z-10 mt-2 flex -translate-x-1/2 items-center"
      >
        {DRINKS.map((drink, i) => {
          const isActive = i === active;
          return (
            <button
              key={drink.src}
              type="button"
              onClick={() => setActive(i)}
              aria-label={`Ver bebida ${i + 1} de ${DRINKS.length}`}
              aria-current={isActive}
              className="group rounded-full p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span
                className={`block h-2 rounded-full transition-all duration-300 ${
                  isActive
                    ? 'w-6 bg-[#145CFF] shadow-[0_0_10px_rgba(20,92,255,0.9)]'
                    : 'w-2 bg-white/35 group-hover:bg-white/70'
                }`}
              />
            </button>
          );
        })}
      </div>
    </>
  );
}

function IceCube({ className, delay = '0s' }: { className: string; delay?: string }) {
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

function Sparkle({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute h-1 w-1 rounded-full bg-white/80 shadow-[0_0_10px_3px_rgba(255,255,255,0.45)] ${className}`}
    />
  );
}

function InfoChip({
  icon,
  title,
  subtitle,
  className,
  style,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  className: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`absolute hidden w-max items-center gap-3 rounded-2xl border border-white/15 bg-[#080A0F]/60 px-3.5 py-2.5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl cc-float xl:flex ${className}`}
      style={style}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#145CFF] text-white shadow-[0_0_18px_rgba(20,92,255,0.7)]">
        {icon}
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-[13px] font-bold text-white">{title}</span>
        <span className="text-[11px] font-medium text-white/65">{subtitle}</span>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loja: produtos, pedido e seções abaixo do Hero                      */
/* ------------------------------------------------------------------ */

type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  description?: string;
  image?: string;
  featured?: boolean;
};

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format;
const WHATSAPP_DIGITS = STORE.whatsapp.replace(/\D/g, '');
// Sem número configurado o link abre o WhatsApp para a pessoa escolher o contato.
const whatsappUrl = (text: string) => `https://wa.me/${WHATSAPP_DIGITS}?text=${encodeURIComponent(text)}`;
const INSTAGRAM_HANDLE = STORE.instagram.replace(/^@/, '');
const INSTAGRAM_URL = `https://instagram.com/${INSTAGRAM_HANDLE}`;
const CART_KEY = 'copocheio:pedido';

const WHATSAPP_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-6 py-3.5 text-[15px] font-extrabold text-[#04210F] shadow-[0_16px_40px_-14px_rgba(37,211,102,0.8)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#3DE07A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
const GHOST_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full border border-white/25 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white backdrop-blur-md transition-all duration-200 hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
const BLUE_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#145CFF] px-6 py-3.5 text-[15px] font-extrabold text-white shadow-[0_16px_40px_-14px_rgba(20,92,255,0.95)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';

function WhatsAppIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

function InstagramIcon({ className = 'h-5 w-5' }: { className?: string }) {
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

// ---- Produtos: lidos de /produtos.json (public/produtos.json) ----------------------------------

function parseProducts(raw: unknown): Product[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const products: Product[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    const p = item as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const price = typeof p.price === 'number' ? p.price : Number(String(p.price ?? '').replace(/[^\d,.-]/g, '').replace(',', '.'));
    if (!name || !Number.isFinite(price) || price < 0) return;
    let id = typeof p.id === 'string' || typeof p.id === 'number' ? String(p.id) : `item-${index}`;
    if (seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    products.push({
      id,
      name,
      price,
      category: text(p.category) ?? 'Outros',
      description: text(p.description),
      image: text(p.image),
      featured: p.featured === true,
    });
  });
  return products;
}

function useProducts() {
  const [state, setState] = useState<{ ready: boolean; products: Product[] }>({ ready: false, products: [] });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/produtos.json', { signal: controller.signal, cache: 'no-cache' })
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => [])
      .then((raw) => {
        if (!controller.signal.aborted) setState({ ready: true, products: parseProducts(raw) });
      });
    return () => controller.abort();
  }, []);

  return state;
}

// ---- Pedido: guardado no navegador e enviado pelo WhatsApp -------------------------------------

type CartLine = { product: Product; qty: number };

function loadCart(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CART_KEY) ?? '{}');
    const cart: Record<string, number> = {};
    if (parsed && typeof parsed === 'object') {
      for (const [id, qty] of Object.entries(parsed)) {
        if (typeof qty === 'number' && Number.isInteger(qty) && qty > 0) cart[id] = Math.min(qty, 99);
      }
    }
    return cart;
  } catch {
    return {};
  }
}

function useCart(products: Product[], ready: boolean) {
  const [cart, setCart] = useState<Record<string, number>>(loadCart);

  // Once the catalog is known, drop anything that is no longer on it.
  useEffect(() => {
    if (!ready) return;
    setCart((prev) => {
      const known = new Set(products.map((p) => p.id));
      const next: Record<string, number> = {};
      for (const [id, qty] of Object.entries(prev)) if (known.has(id)) next[id] = qty;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [products, ready]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* private mode: the order simply isn't remembered */
    }
  }, [cart]);

  const setQty = useCallback((id: string, qty: number) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) delete next[id];
      else next[id] = Math.min(qty, 99);
      return next;
    });
  }, []);
  const clear = useCallback(() => setCart({}), []);

  const lines: CartLine[] = useMemo(
    () => products.filter((p) => (cart[p.id] ?? 0) > 0).map((product) => ({ product, qty: cart[product.id] })),
    [products, cart],
  );
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  const total = lines.reduce((sum, line) => sum + line.qty * line.product.price, 0);

  return { cart, setQty, clear, lines, count, total };
}

function useOutOfView(ref: RefObject<HTMLElement | null>) {
  const [out, setOut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setOut(entry.intersectionRatio < 0.15), {
      threshold: [0, 0.15, 0.5, 1],
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return out;
}

// ---- Peças visuais -----------------------------------------------------------------------------

function SectionHeading({ id, eyebrow, title, subtitle }: { id: string; eyebrow: string; title: ReactNode; subtitle: string }) {
  return (
    <div className="mx-auto max-w-3xl text-center">
      <span className="inline-flex items-center gap-2 rounded-full border border-[#145CFF]/40 bg-[#145CFF]/15 px-3.5 py-1.5 text-[11px] font-semibold tracking-[0.18em] text-[#8FB1FF] backdrop-blur-md">
        <Snowflake className="h-3.5 w-3.5" aria-hidden="true" />
        {eyebrow}
      </span>
      <h2
        id={id}
        className="mt-5 text-balance text-3xl font-black leading-[1.05] tracking-tight text-white sm:text-4xl lg:text-5xl"
      >
        {title}
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-balance text-[15px] leading-relaxed text-white/65 sm:text-base">{subtitle}</p>
    </div>
  );
}

function Price({ value, className = '' }: { value: number; className?: string }) {
  const [symbol, ...rest] = money(value).split(/\s/);
  return (
    <span className={`inline-flex items-baseline gap-1 font-black tracking-tight text-white ${className}`}>
      <span className="text-[0.55em] font-bold text-[#8FB1FF]">{symbol}</span>
      <span>{rest.join(' ')}</span>
    </span>
  );
}

function ProductImage({ product, padding = 'p-3 sm:p-4' }: { product: Product; padding?: string }) {
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
      className={`absolute inset-0 h-full w-full object-contain drop-shadow-[0_14px_18px_rgba(0,0,0,0.45)] transition-transform duration-500 ease-out group-hover:scale-105 motion-reduce:transform-none ${padding}`}
    />
  );
}

function AddControl({
  qty,
  name,
  onChange,
  compact = false,
}: {
  qty: number;
  name: string;
  onChange: (qty: number) => void;
  compact?: boolean;
}) {
  const focusRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#050505]';
  if (qty === 0) {
    return (
      <button
        type="button"
        onClick={() => onChange(1)}
        aria-label={`Adicionar ${name} ao pedido`}
        className={`inline-flex items-center justify-center gap-2 rounded-full bg-[#145CFF] text-sm font-bold text-white shadow-[0_10px_26px_-10px_rgba(20,92,255,0.9)] transition-all duration-200 hover:bg-[#2563FF] group-hover:shadow-[0_14px_32px_-8px_rgba(37,99,255,0.95)] active:scale-[0.98] ${compact ? 'h-10 px-4' : 'h-11 w-full'} ${focusRing}`}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Adicionar
      </button>
    );
  }
  return (
    <div
      role="group"
      aria-label={`Quantidade de ${name}`}
      className={`flex items-center justify-between rounded-full border border-[#2563FF]/60 bg-[#145CFF]/15 px-1 ${compact ? 'h-10 gap-1' : 'h-11 w-full'}`}
    >
      <button
        type="button"
        onClick={() => onChange(qty - 1)}
        aria-label={`Diminuir ${name}`}
        className={`grid h-8 w-8 place-items-center rounded-full text-white transition-colors hover:bg-white/10 ${focusRing}`}
      >
        <Minus className="h-4 w-4" aria-hidden="true" />
      </button>
      <span className={`text-sm font-bold tabular-nums text-white ${compact ? 'min-w-6 text-center' : ''}`} aria-live="polite">
        {qty}
        {!compact && <span className="ml-1 hidden text-xs font-medium text-white/60 sm:inline">no pedido</span>}
      </span>
      <button
        type="button"
        onClick={() => onChange(qty + 1)}
        aria-label={`Aumentar ${name}`}
        className={`grid h-8 w-8 place-items-center rounded-full bg-[#145CFF] text-white transition-colors hover:bg-[#2563FF] ${focusRing}`}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

function ProductDetails({ product, qty, onChange }: { product: Product; qty: number; onChange: (qty: number) => void }) {
  return (
    <div className="flex flex-1 flex-col px-1 pb-1 pt-3">
      <h3 className="line-clamp-2 min-h-[2.5rem] text-[15px] font-bold leading-tight text-white sm:min-h-[2.6rem] sm:text-base">
        {product.name}
      </h3>
      {product.description && (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-white/55 sm:text-[13px]">{product.description}</p>
      )}
      <div className="mt-auto pt-3">
        <Price value={product.price} className="text-xl sm:text-2xl" />
        <div className="mt-2.5">
          <AddControl qty={qty} name={product.name} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

function FeaturedCard({
  product,
  qty,
  onChange,
  className = '',
}: {
  product: Product;
  qty: number;
  onChange: (qty: number) => void;
  className?: string;
}) {
  return (
    <li
      className={`group relative rounded-[1.75rem] bg-gradient-to-b from-[#2563FF] via-[#145CFF]/30 to-white/10 p-px shadow-[0_20px_44px_-26px_rgba(37,99,255,0.9)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_26px_54px_-24px_rgba(37,99,255,1)] motion-reduce:transform-none ${className}`}
    >
      <div className="relative flex h-full flex-col overflow-hidden rounded-[calc(1.75rem-1px)] bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] p-3 sm:p-4">
        <span className="absolute left-3 top-3 z-10 inline-flex items-center gap-1 rounded-full bg-[#145CFF] px-2.5 py-1 text-[10px] font-bold tracking-wider text-white shadow-[0_0_18px_rgba(20,92,255,0.8)] sm:left-4 sm:top-4">
          <Flame className="h-3 w-3" aria-hidden="true" />
          FAVORITO
        </span>
        <div className="relative aspect-square overflow-hidden rounded-2xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.6),rgba(20,92,255,0.12)_55%,transparent_78%)]">
          <ProductImage product={product} />
        </div>
        <ProductDetails product={product} qty={qty} onChange={onChange} />
      </div>
    </li>
  );
}

function SkeletonRow() {
  return (
    <li className="flex gap-4 rounded-3xl border border-white/10 bg-white/[0.03] p-4" aria-hidden="true">
      <div className="flex flex-1 flex-col gap-3">
        <div className="h-4 w-2/3 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
        <div className="h-3 w-full animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />
        <div className="mt-3 h-6 w-1/3 animate-pulse rounded bg-white/[0.08] motion-reduce:animate-none" />
      </div>
      <div className="h-24 w-24 animate-pulse rounded-2xl bg-white/[0.06] motion-reduce:animate-none sm:h-32 sm:w-32" />
    </li>
  );
}

// ---- Página Bebidas (/bebidas) -----------------------------------------------------------------

const norm = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const categoryId = (name: string) => `cat-${norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

function ProductRow({ product, qty, onChange }: { product: Product; qty: number; onChange: (qty: number) => void }) {
  return (
    <li className="group relative flex gap-3 rounded-3xl border border-white/10 bg-gradient-to-br from-white/[0.07] to-white/[0.02] p-3.5 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:border-[#2563FF]/50 hover:shadow-[0_22px_50px_-24px_rgba(37,99,255,0.75)] motion-reduce:transform-none sm:gap-5 sm:p-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <h3 className="text-[15px] font-bold leading-snug text-white sm:text-base">{product.name}</h3>
        {product.description && (
          <p className="mt-1 line-clamp-3 text-xs leading-snug text-white/55 sm:text-[13px]">{product.description}</p>
        )}
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-3">
          <Price value={product.price} className="text-xl sm:text-2xl" />
          <AddControl qty={qty} name={product.name} onChange={onChange} compact />
        </div>
      </div>
      <div className="relative h-24 w-24 shrink-0 self-start overflow-hidden rounded-2xl bg-[radial-gradient(circle_at_50%_58%,rgba(37,99,255,0.4),rgba(20,92,255,0.07)_55%,transparent_78%)] sm:h-32 sm:w-32">
        <ProductImage product={product} padding="p-1.5" />
      </div>
    </li>
  );
}

function BebidasPage({
  ready,
  products,
  cart,
  setQty,
}: {
  ready: boolean;
  products: Product[];
  cart: Record<string, number>;
  setQty: (id: string, qty: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const chipsRef = useRef<HTMLDivElement>(null);

  const term = norm(query.trim());
  const matches = useMemo(
    () => (term ? products.filter((p) => norm(`${p.name} ${p.description ?? ''} ${p.category}`).includes(term)) : products),
    [products, term],
  );
  const groups = useMemo(() => {
    const byCategory = new Map<string, Product[]>();
    for (const product of matches) {
      const list = byCategory.get(product.category);
      if (list) list.push(product);
      else byCategory.set(product.category, [product]);
    }
    return Array.from(byCategory.entries());
  }, [matches]);
  const featured = useMemo(() => (term ? [] : products.filter((p) => p.featured).slice(0, 4)), [products, term]);
  const activeCategory = groups.some(([name]) => name === active) ? active : (groups[0]?.[0] ?? '');

  // Highlight the chip of the category being read.
  useEffect(() => {
    const sections = groups.map(([name]) => document.getElementById(categoryId(name))).filter((el): el is HTMLElement => !!el);
    if (sections.length < 2) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive((entry.target as HTMLElement).dataset.category ?? '');
        }
      },
      { rootMargin: '-30% 0px -60% 0px' },
    );
    sections.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [groups]);

  // Keep the active chip in view inside the horizontally scrolling row.
  useEffect(() => {
    const row = chipsRef.current;
    const chip = row?.querySelector<HTMLElement>('[aria-current="true"]');
    if (row && chip) row.scrollTo({ left: chip.offsetLeft - row.clientWidth / 2 + chip.offsetWidth / 2, behavior: 'smooth' });
  }, [activeCategory]);

  const goTo = (name: string) => {
    setActive(name);
    document.getElementById(categoryId(name))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const info = [
    STORE.deliveryTime && { icon: <Clock className="h-4 w-4" aria-hidden="true" />, text: STORE.deliveryTime },
    STORE.deliveryFee && { icon: <Motorbike className="h-4 w-4" aria-hidden="true" />, text: `Entrega ${STORE.deliveryFee}` },
  ].filter(Boolean) as { icon: ReactNode; text: string }[];

  return (
    <div className="relative min-h-[100dvh] overflow-x-clip bg-[#050505]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -left-40 top-1/3 h-96 w-96 rounded-full bg-[#145CFF]/12 blur-3xl cc-glow" />
        <div className="absolute -right-40 top-2/3 h-96 w-96 rounded-full bg-[#2563FF]/10 blur-3xl cc-glow [animation-delay:2s]" />
      </div>

      <div className="relative mx-auto w-full max-w-[44rem]">
        <div className="relative h-44 overflow-hidden rounded-b-[2rem] bg-gradient-to-b from-[#0E36B8] via-[#0A2273] to-[#07123A] sm:h-52">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#5B8CFF]/30" />
            <div className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#5B8CFF]/20" />
            <div className="absolute left-1/2 top-1/2 h-[26rem] w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#5B8CFF]/12" />
            <div className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#2563FF]/40 blur-3xl" />
            <IceCube className="left-[14%] top-[34%] h-10 w-10 opacity-60" delay="-2s" />
            <IceCube className="right-[13%] top-[24%] h-12 w-12 opacity-55" delay="-4s" />
            <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#050505]/60 to-transparent" />
          </div>
          <a
            href="/"
            className="absolute left-4 top-4 z-10 inline-flex items-center gap-2 rounded-full border border-white/20 bg-black/40 px-4 py-2 text-sm font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Início
          </a>
        </div>

        <div className="px-4 sm:px-6">
          <img
            src="/logo.png"
            alt="COPO CHEIO – Disk Bebidas"
            width={96}
            height={96}
            className="relative -mt-12 h-24 w-24 rounded-full object-contain shadow-[0_0_50px_-4px_rgba(20,92,255,0.8)] ring-4 ring-[#050505]"
          />
          <h1 className="mt-4 text-3xl font-black tracking-tight text-white">
            COPO <span className="text-[#2563FF]">CHEIO</span>
          </h1>
          <p className="mt-0.5 text-sm font-medium text-white/60">Disk Bebidas</p>
          {(info.length > 0 || STORE.hours) && (
            <div className="mt-3 space-y-1.5">
              {info.length > 0 && (
                <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm text-white/80">
                  {info.map((item) => (
                    <li key={item.text} className="flex items-center gap-1.5">
                      <span className="text-[#2563FF]">{item.icon}</span>
                      {item.text}
                    </li>
                  ))}
                </ul>
              )}
              {STORE.hours && <p className="text-xs text-white/50">{STORE.hours}</p>}
            </div>
          )}

          <div className="mt-8">
            <h2 className="text-balance text-2xl font-black leading-tight tracking-tight text-white sm:text-3xl">
              Bebidas para deixar seu momento{' '}
              <span className="whitespace-nowrap text-[#145CFF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">ainda melhor</span>
            </h2>
            <p className="mt-2 text-balance text-sm leading-relaxed text-white/65 sm:text-[15px]">
              Escolha sua bebida favorita. A gente entrega gelada e rapidinho na sua casa.
            </p>
          </div>

          {ready && products.length > 0 && (
            <label className="relative mt-6 block">
              <span className="sr-only">Buscar no cardápio</span>
              <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-white/40" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar no cardápio"
                className="h-12 w-full rounded-full border border-white/15 bg-white/5 pl-12 pr-4 text-[15px] text-white placeholder:text-white/40 focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/40"
              />
            </label>
          )}
        </div>

        {ready && groups.length > 1 && (
          <div className="sticky top-0 z-30 mt-5 border-b border-white/10 bg-[#050505]/85 backdrop-blur-xl">
            <div
              ref={chipsRef}
              role="group"
              aria-label="Categorias"
              className="relative flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none] sm:px-6 [&::-webkit-scrollbar]:hidden"
            >
              {groups.map(([name]) => {
                const current = name === activeCategory;
                return (
                  <button
                    key={name}
                    type="button"
                    aria-current={current}
                    onClick={() => goTo(name)}
                    className={`shrink-0 rounded-full border px-4 py-2 text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                      current
                        ? 'border-[#145CFF] bg-[#145CFF] text-white shadow-[0_0_22px_-4px_rgba(20,92,255,0.9)]'
                        : 'border-white/15 bg-white/5 text-white/75 hover:border-white/30 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="px-4 pb-32 pt-2 sm:px-6">
          {!ready && (
            <ul className="mt-6 space-y-3" aria-busy="true">
              {Array.from({ length: 5 }, (_, i) => (
                <SkeletonRow key={i} />
              ))}
            </ul>
          )}

          {ready && products.length === 0 && (
            <div className="mt-8 rounded-[2rem] border border-white/10 bg-gradient-to-b from-white/[0.06] to-transparent p-8 text-center sm:p-12">
              <div className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#145CFF]/15 text-[#2563FF] shadow-[0_0_40px_-8px_rgba(20,92,255,0.8)] ring-1 ring-[#145CFF]/40">
                <GlassWater className="h-8 w-8" aria-hidden="true" />
              </div>
              <h3 className="mt-6 text-2xl font-black text-white">Estamos montando o cardápio</h3>
              <p className="mx-auto mt-2 max-w-md text-white/65">
                Em breve as bebidas aparecem por aqui. Enquanto isso, é só chamar no WhatsApp que a gente atende você.
              </p>
              <a
                href={whatsappUrl('Olá, Copo Cheio! Vim pelo site e gostaria de fazer um pedido.')}
                target="_blank"
                rel="noopener noreferrer"
                className={`${WHATSAPP_BUTTON} mt-7`}
              >
                <WhatsAppIcon />
                Chamar no WhatsApp
              </a>
            </div>
          )}

          {ready && products.length > 0 && matches.length === 0 && (
            <p className="mt-10 text-center text-white/60" role="status">
              Nenhuma bebida encontrada para “{query.trim()}”.
            </p>
          )}

          {featured.length > 0 && (
            <section aria-labelledby="favoritos" className="pt-8">
              <h2 id="favoritos" className="flex items-center gap-2 text-xl font-black tracking-tight text-white">
                <Flame className="h-5 w-5 text-[#2563FF]" aria-hidden="true" />
                Os favoritos da galera
              </h2>
              <ul className="-mx-4 -mb-6 mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-10 [scrollbar-width:none] sm:-mx-6 sm:px-6 [&::-webkit-scrollbar]:hidden">
                {featured.map((product) => (
                  <FeaturedCard
                    key={product.id}
                    product={product}
                    qty={cart[product.id] ?? 0}
                    onChange={(qty) => setQty(product.id, qty)}
                    className="w-[62%] shrink-0 snap-start sm:w-[44%]"
                  />
                ))}
              </ul>
            </section>
          )}

          {groups.map(([name, items]) => (
            <section key={name} id={categoryId(name)} data-category={name} aria-labelledby={`${categoryId(name)}-titulo`} className="scroll-mt-20 pt-8">
              <h2 id={`${categoryId(name)}-titulo`} className="flex items-baseline gap-3 text-xl font-black tracking-tight text-white">
                {name}
                <span className="text-sm font-medium text-white/40">{items.length}</span>
              </h2>
              <ul className="mt-4 space-y-3">
                {items.map((product) => (
                  <ProductRow
                    key={product.id}
                    product={product}
                    qty={cart[product.id] ?? 0}
                    onChange={(qty) => setQty(product.id, qty)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>

      <Footer />
    </div>
  );
}

// ---- Rotas: "/" (Home) e "/bebidas" ------------------------------------------------------------

type Route = 'home' | 'bebidas';
const routeOf = (pathname: string): Route => (pathname.replace(/\/+$/, '') === '/bebidas' ? 'bebidas' : 'home');
const NAV_HREF: Record<string, string> = { Início: '/', Bebidas: '/bebidas', Contato: '/#contato' };

// Two pages, no router library: internal links ("/", "/bebidas", "/#contato") swap the page without reloading.
function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a');
      if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) {
        // Same page: "#section" links scroll natively; a plain link to this page goes to its top.
        if (!url.hash && url.search === window.location.search) {
          e.preventDefault();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        return;
      }
      if (url.pathname.replace(/\/+$/, '') !== '' && routeOf(url.pathname) !== 'bebidas') return;
      e.preventDefault();
      window.history.pushState(null, '', url.pathname + url.search + url.hash);
      setPath(url.pathname);
    };
    window.addEventListener('popstate', onPopState);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return routeOf(path);
}

// ---- Seção Contato -----------------------------------------------------------------------------

function ContactRow({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-4 rounded-3xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] p-4 backdrop-blur-sm sm:p-5">
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#145CFF]/20 text-[#8FB1FF] shadow-[0_0_24px_-6px_rgba(20,92,255,0.8)] ring-1 ring-[#145CFF]/40">
        {icon}
      </span>
      <div className="min-w-0">
        <h3 className="text-base font-bold text-white">{title}</h3>
        <div className="mt-0.5 text-sm leading-relaxed text-white/65">{children}</div>
      </div>
    </div>
  );
}

function ContatoSection() {
  const hello = 'Olá, Copo Cheio! Vim pelo site e gostaria de fazer um pedido.';
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(STORE.address)}`;
  const linkClass = 'font-semibold text-[#8FB1FF] underline-offset-4 transition-colors hover:text-white hover:underline';

  return (
    <section id="contato" aria-labelledby="contato-titulo" className="relative overflow-hidden bg-[#050505] py-20 sm:py-24">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-px w-2/3 -translate-x-1/2 bg-gradient-to-r from-transparent via-[#145CFF]/40 to-transparent" />
        <div className="absolute -right-32 top-1/4 h-96 w-96 rounded-full bg-[#145CFF]/15 blur-3xl cc-glow" />
        <IceCube className="left-[4%] top-20 hidden h-10 w-10 opacity-35 md:block" delay="-2s" />
      </div>

      <div className="relative mx-auto w-full max-w-7xl px-5 sm:px-8 lg:px-12">
        <SectionHeading
          id="contato-titulo"
          eyebrow="CONTATO"
          title={
            <>
              Fale com a{' '}
              <span className="whitespace-nowrap text-[#145CFF] [text-shadow:0_0_28px_rgba(20,92,255,0.6)]">Copo Cheio</span>
            </>
          }
          subtitle="Precisa de ajuda com seu pedido? Estamos prontos para atender você."
        />

        <div className="mt-12 grid gap-6 lg:mt-16 lg:grid-cols-2 lg:gap-8">
          <div className="flex flex-col gap-4 lg:justify-center">
            <ContactRow icon={<WhatsAppIcon className="h-6 w-6" />} title="WhatsApp">
              Faça seu pedido pelo WhatsApp.{' '}
              <a href={whatsappUrl(hello)} target="_blank" rel="noopener noreferrer" className={linkClass}>
                Chamar agora
              </a>
            </ContactRow>
            <ContactRow icon={<InstagramIcon className="h-6 w-6" />} title="Instagram">
              Acompanhe a Copo Cheio.{' '}
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                @{INSTAGRAM_HANDLE}
              </a>
            </ContactRow>
            {STORE.hours && (
              <ContactRow icon={<Clock className="h-6 w-6" aria-hidden="true" />} title="Horário de atendimento">
                <span className="whitespace-pre-line">{STORE.hours}</span>
              </ContactRow>
            )}
            {STORE.address && (
              <ContactRow icon={<MapPin className="h-6 w-6" aria-hidden="true" />} title="Endereço">
                {STORE.address}
              </ContactRow>
            )}
          </div>

          <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-[#0C1B4D]/80 via-[#08112F]/80 to-[#060913] p-5 shadow-[0_30px_90px_-40px_rgba(20,92,255,0.8)] sm:p-7">
            <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-[#145CFF]/25 blur-3xl" />
            {STORE.address ? (
              <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10">
                <iframe
                  title="Mapa com a localização da Copo Cheio"
                  src={`https://www.google.com/maps?q=${encodeURIComponent(STORE.address)}&output=embed`}
                  loading="lazy"
                  referrerPolicy="no-referrer-when-downgrade"
                  className="h-full w-full"
                />
              </div>
            ) : (
              <div className="relative flex aspect-[4/3] flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl border border-white/10 bg-[radial-gradient(circle_at_50%_45%,rgba(37,99,255,0.35),transparent_65%)] text-center">
                <IceCube className="left-[9%] top-[12%] h-9 w-9 opacity-60" delay="-2s" />
                <IceCube className="right-[9%] top-[16%] h-11 w-11 opacity-55" delay="-4s" />
                <img
                  src="/logo.png"
                  alt=""
                  width={128}
                  height={128}
                  loading="lazy"
                  className="h-28 w-28 rounded-full object-contain shadow-[0_0_60px_-6px_rgba(20,92,255,0.8)] ring-1 ring-[#145CFF]/50 sm:h-32 sm:w-32"
                />
                <p className="flex items-center gap-2 px-4 text-sm font-semibold tracking-wide text-white/80">
                  <Motorbike className="h-4 w-4 text-[#2563FF]" aria-hidden="true" />
                  GELADA • RÁPIDA • NA SUA CASA
                </p>
              </div>
            )}

            <div className="relative mt-5 flex flex-col gap-3 sm:flex-row">
              {STORE.address && (
                <a href={directions} target="_blank" rel="noopener noreferrer" className={`${GHOST_BUTTON} sm:flex-1`}>
                  <Navigation className="h-5 w-5" aria-hidden="true" />
                  Como chegar
                </a>
              )}
              <a
                href={whatsappUrl(hello)}
                target="_blank"
                rel="noopener noreferrer"
                className={`${WHATSAPP_BUTTON} sm:flex-1`}
              >
                <WhatsAppIcon />
                Chamar no WhatsApp
              </a>
            </div>

            <a
              href={INSTAGRAM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative mt-4 flex items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-4 transition-all duration-200 hover:border-[#2563FF]/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#145CFF] text-white shadow-[0_0_20px_rgba(20,92,255,0.6)]">
                <InstagramIcon className="h-5 w-5" />
              </span>
              <span className="flex flex-col leading-tight">
                <span className="text-sm font-bold text-white">Siga a Copo Cheio</span>
                <span className="text-sm text-[#8FB1FF]">@{INSTAGRAM_HANDLE}</span>
              </span>
              <ArrowRight
                className="ml-auto h-5 w-5 text-white/50 transition-all duration-200 group-hover:translate-x-1 group-hover:text-white"
                aria-hidden="true"
              />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

// ---- Chamada final e rodapé --------------------------------------------------------------------

function FinalCta({ onOrder }: { onOrder: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <section aria-labelledby="deu-sede" className="relative overflow-hidden bg-[#050505] px-5 pb-20 pt-4 sm:px-8 sm:pb-28 lg:px-12">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-[2.25rem] border border-[#145CFF]/35 bg-gradient-to-br from-[#145CFF]/35 via-[#0B1230] to-[#050505] px-6 py-14 text-center shadow-[0_40px_120px_-50px_rgba(20,92,255,0.9)] sm:px-12 sm:py-20">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 -top-24 h-72 w-72 rounded-full bg-[#2563FF]/30 blur-3xl cc-glow" />
          <div className="absolute -bottom-24 -right-16 h-72 w-72 rounded-full bg-[#145CFF]/25 blur-3xl cc-glow [animation-delay:2s]" />
          <IceCube className="left-[6%] top-[12%] h-9 w-9 opacity-55 sm:left-[8%] sm:top-[18%] sm:h-11 sm:w-11" delay="-1s" />
          <IceCube className="right-[7%] top-[10%] h-10 w-10 opacity-55 sm:bottom-[16%] sm:top-auto sm:right-[9%]" delay="-3s" />
          <IceCube className="right-[24%] top-[10%] hidden h-8 w-8 opacity-40 md:block" delay="-5s" />
        </div>
        <div className="relative">
          <h2 id="deu-sede" className="text-5xl font-black tracking-tight text-white sm:text-6xl lg:text-7xl">
            Deu <span className="text-[#2563FF] [text-shadow:0_0_36px_rgba(37,99,255,0.8)]">sede?</span>
          </h2>
          <p className="mx-auto mt-4 max-w-md text-base text-white/75 sm:text-lg">
            Peça agora e receba sua bebida bem gelada.
          </p>
          <a
            href={ORDER_HREF}
            onClick={onOrder}
            className={`${BLUE_BUTTON} group mt-8 px-9 py-4 text-base tracking-wide`}
          >
            PEDIR AGORA
            <ArrowRight className="h-5 w-5 transition-transform duration-200 group-hover:translate-x-1" aria-hidden="true" />
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/10 bg-[#050505] py-10">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-6 px-5 text-center sm:px-8 md:flex-row md:justify-between md:text-left lg:px-12">
        <a href="#inicio" className="flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#145CFF]">
          <img src="/logo.png" alt="" width={44} height={44} loading="lazy" className="h-11 w-11 rounded-full object-contain ring-1 ring-white/15" />
          <span className="flex flex-col items-start leading-none">
            <span className="text-lg font-black tracking-tight text-white">
              COPO <span className="text-[#2563FF]">CHEIO</span>
            </span>
            <span className="mt-1 text-[10px] font-semibold tracking-[0.2em] text-white/50">DISK BEBIDAS</span>
          </span>
        </a>
        <nav aria-label="Rodapé" className="flex items-center gap-6 text-sm font-medium text-white/65">
          {NAV_LINKS.map((link) => (
            <a key={link} href={NAV_HREF[link]} className="transition-colors hover:text-white">
              {link}
            </a>
          ))}
          <a
            href={INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Instagram @${INSTAGRAM_HANDLE}`}
            className="grid h-9 w-9 place-items-center rounded-full border border-white/15 text-white/75 transition-all hover:border-white/40 hover:text-white"
          >
            <InstagramIcon className="h-4 w-4" />
          </a>
        </nav>
      </div>
      <p className="mx-auto mt-8 max-w-7xl px-5 text-center text-xs text-white/40 sm:px-8 md:text-left lg:px-12">
        © {new Date().getFullYear()} Copo Cheio Disk Bebidas. Todos os direitos reservados.
      </p>
    </footer>
  );
}

// ---- Menu fixo (aparece depois do Hero), barra e gaveta do pedido ------------------------------

function StickyNav({ visible, count, onOrder }: { visible: boolean; count: number; onOrder: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  return (
    <header
      aria-hidden={!visible}
      inert={!visible}
      className={`fixed inset-x-0 top-0 z-40 flex justify-center px-3 pt-3 transition-all duration-300 sm:px-6 ${
        visible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
      }`}
    >
      <nav
        aria-label="Navegação"
        className="flex w-full max-w-4xl items-center justify-between gap-3 rounded-full border border-white/15 bg-[#080A0F]/75 py-2 pl-2.5 pr-2 shadow-[0_10px_40px_-14px_rgba(20,92,255,0.6)] backdrop-blur-xl"
      >
        <a href="#inicio" aria-label={`${BRAND_NAME} – início`} className="flex items-center gap-2.5 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#145CFF]">
          <img src="/logo.png" alt="" width={36} height={36} className="h-9 w-9 rounded-full object-contain ring-1 ring-white/15" />
          <span className="text-[15px] font-black tracking-tight text-white">
            COPO <span className="text-[#2563FF]">CHEIO</span>
          </span>
        </a>
        <div className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map((link) => (
            <a key={link} href={NAV_HREF[link]} className="text-sm font-medium text-white/75 transition-colors hover:text-white">
              {link}
            </a>
          ))}
        </div>
        <a
          href={ORDER_HREF}
          onClick={onOrder}
          className="inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-[#145CFF] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_0_20px_rgba(20,92,255,0.45)] transition-all duration-200 hover:bg-[#0B4FE0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {count > 0 ? (
            <>
              <ShoppingBag className="h-4 w-4" aria-hidden="true" />
              Ver pedido
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-white px-1 text-[11px] font-black text-[#145CFF]">{count}</span>
            </>
          ) : (
            'Pedir agora'
          )}
        </a>
      </nav>
    </header>
  );
}

function OrderBar({ show, count, total, onOpen }: { show: boolean; count: number; total: number; onOpen: () => void }) {
  return (
    <div
      aria-hidden={!show}
      inert={!show}
      className={`fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] transition-all duration-300 ${
        show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-6 opacity-0'
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full max-w-md items-center justify-between gap-4 rounded-full bg-[#145CFF] py-3 pl-4 pr-6 text-white shadow-[0_18px_50px_-12px_rgba(20,92,255,0.95)] ring-1 ring-white/20 transition-all duration-200 hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white active:scale-[0.99]"
      >
        <span className="flex items-center gap-3 font-bold">
          <span className="relative grid h-9 w-9 place-items-center rounded-full bg-white/15">
            <ShoppingBag className="h-5 w-5" aria-hidden="true" />
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full bg-white px-1 text-[11px] font-black text-[#145CFF]">
              {count}
            </span>
          </span>
          Ver pedido
        </span>
        <span className="text-lg font-black tabular-nums">{money(total)}</span>
      </button>
    </div>
  );
}

function OrderDrawer({
  open,
  onClose,
  lines,
  total,
  setQty,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  lines: CartLine[];
  total: number;
  setQty: (id: string, qty: number) => void;
  onClear: () => void;
}) {
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  const message = [
    'Olá, Copo Cheio! Quero fazer um pedido:',
    '',
    ...lines.map(({ product, qty }) => `${qty}x ${product.name} — ${money(product.price * qty)}`),
    '',
    `Total: ${money(total)}`,
    ...(address.trim() ? ['', `Endereço de entrega: ${address.trim()}`] : []),
    ...(notes.trim() ? [`Observações: ${notes.trim()}`] : []),
  ].join('\n');

  const field =
    'w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/35 focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/40';

  return (
    <div
      aria-hidden={!open}
      inert={!open}
      className="fixed inset-0 z-50"
      style={{ visibility: open ? 'visible' : 'hidden', transition: open ? 'visibility 0s' : 'visibility 0s 300ms' }}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pedido-titulo"
        className={`absolute inset-x-0 bottom-0 flex max-h-[90dvh] flex-col rounded-t-[2rem] border border-white/10 bg-gradient-to-b from-[#0C1B4D] via-[#08112F] to-[#060913] shadow-[0_-30px_100px_-30px_rgba(20,92,255,0.7)] transition-transform duration-300 ease-out sm:inset-y-0 sm:left-auto sm:max-h-none sm:w-[26rem] sm:rounded-l-[2rem] sm:rounded-tr-none ${
          open ? 'translate-x-0 translate-y-0' : 'translate-y-full sm:translate-x-full sm:translate-y-0'
        }`}
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-5 sm:px-6">
          <h2 id="pedido-titulo" className="flex items-center gap-2.5 text-xl font-black text-white">
            <ShoppingBag className="h-5 w-5 text-[#2563FF]" aria-hidden="true" />
            Seu pedido
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Fechar pedido"
            className="grid h-10 w-10 place-items-center rounded-full border border-white/15 text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {lines.length === 0 ? (
          <div className="px-6 pb-10 pt-6 text-center">
            <p className="font-semibold text-white">Seu pedido está vazio</p>
            <p className="mt-1 text-sm text-white/60">Escolha suas bebidas favoritas para começar.</p>
            <a href="/bebidas" onClick={onClose} className={`${BLUE_BUTTON} mt-6`}>
              Ver bebidas
            </a>
          </div>
        ) : (
          <>
            <ul className="flex-1 space-y-3 overflow-y-auto px-5 py-2 sm:px-6">
              {lines.map(({ product, qty }) => (
                <li key={product.id} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-2.5">
                  <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
                    <ProductImage product={product} padding="p-1" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm font-bold leading-tight text-white">{product.name}</p>
                    <p className="mt-1 text-sm font-semibold text-[#8FB1FF]">{money(product.price * qty)}</p>
                  </div>
                  <div className="flex items-center rounded-full border border-white/15 bg-black/20">
                    <button
                      type="button"
                      onClick={() => setQty(product.id, qty - 1)}
                      aria-label={qty === 1 ? `Remover ${product.name}` : `Diminuir ${product.name}`}
                      className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <Minus className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <span className="w-6 text-center text-sm font-bold tabular-nums text-white" aria-live="polite">
                      {qty}
                    </span>
                    <button
                      type="button"
                      onClick={() => setQty(product.id, qty + 1)}
                      aria-label={`Aumentar ${product.name}`}
                      className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="space-y-3 border-t border-white/10 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 sm:px-6">
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Endereço de entrega (opcional)"
                aria-label="Endereço de entrega"
                autoComplete="street-address"
                className={field}
              />
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Observações (opcional)"
                aria-label="Observações do pedido"
                className={field}
              />
              <div className="flex items-end justify-between pt-1">
                <button
                  type="button"
                  onClick={onClear}
                  className="text-sm font-medium text-white/50 underline-offset-4 hover:text-white hover:underline"
                >
                  Limpar pedido
                </button>
                <div className="text-right">
                  <span className="block text-xs text-white/50">Total</span>
                  <Price value={total} className="text-3xl" />
                </div>
              </div>
              <a href={whatsappUrl(message)} target="_blank" rel="noopener noreferrer" className={`${WHATSAPP_BUTTON} w-full py-4`}>
                <WhatsAppIcon className="h-6 w-6" />
                Enviar pedido pelo WhatsApp
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Hero({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { handMask, cupBox } = useVideoFraming(rootRef, videoRef);
  const overHand = cupBox !== null;

  return (
    <div ref={rootRef} id="inicio" className="cc-screen relative overflow-hidden bg-black">

      {/* Background video: left-aligned so phones show a hand-free part, with the hand's band masked out */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover object-left"
        style={{ maskImage: handMask, WebkitMaskImage: handMask }}
        src={VIDEO_URL}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        aria-hidden="true"
        tabIndex={-1}
      />

      {/* Layered overlays: darken, brand tint, readability gradients and vignette */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[#050505]/50" />
        <div className="absolute inset-0 bg-gradient-to-br from-[#145CFF]/25 via-transparent to-[#0B4FE0]/25" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#050505]/85 via-[#050505]/35 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-[#050505] via-[#050505]/60 to-transparent" />
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-[#050505]/75 to-transparent" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(5,5,5,0.85)_100%)]" />
      </div>

      {/* Decorative glows, ice and highlights */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute -left-40 -top-40 h-[26rem] w-[26rem] rounded-full bg-[#145CFF]/20 blur-3xl cc-glow" />
        <div className="absolute -bottom-32 left-1/3 h-72 w-72 rounded-full bg-[#2563FF]/15 blur-3xl cc-glow [animation-delay:2s]" />
        <Sparkle className="left-[12%] top-[22%]" />
        <Sparkle className="right-[30%] top-[18%] hidden lg:block" />
        <Sparkle className="right-[8%] top-[42%]" />
        <Sparkle className="bottom-[38%] left-[46%] hidden lg:block" />
      </div>

      {/* Foreground */}
      <div className="cc-screen relative z-10 flex flex-col">
        <nav
          aria-label="Navegação principal"
          className="flex items-center justify-between pt-4 sm:pt-6 px-4 sm:px-8 lg:px-12"
        >
          <a
            href="#inicio"
            aria-label={`${BRAND_NAME} – Disk Bebidas, página inicial`}
            className="flex items-center gap-2.5 sm:gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#145CFF] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
          >
            <img
              src="/logo.png"
              alt=""
              width={48}
              height={48}
              className="h-10 w-10 shrink-0 rounded-full object-contain ring-1 ring-white/15 shadow-[0_0_24px_rgba(20,92,255,0.55)] sm:h-12 sm:w-12"
            />
            <span className="flex flex-col items-start">
              <span className="whitespace-nowrap text-[15px] font-black leading-none tracking-tight text-white sm:text-xl">
                COPO <span className="text-[#2563FF]">CHEIO</span>
              </span>
              <span className="mt-1 rounded bg-[#145CFF] px-1.5 py-0.5 text-[8px] font-bold leading-none tracking-[0.22em] text-white sm:text-[9px]">
                DISK BEBIDAS
              </span>
            </span>
          </a>

          <div className="flex items-center gap-4 sm:gap-6 lg:gap-8 rounded-full px-4 sm:px-6 py-2.5 sm:py-3 max-[359px]:p-2 bg-white/10 backdrop-blur-xl border border-white/20">
            {NAV_LINKS.map((link) => {
              const isActive = link === 'Início';
              return (
                <a
                  key={link}
                  href={NAV_HREF[link]}
                  aria-current={isActive ? 'page' : undefined}
                  className={`${SECONDARY_LINKS.has(link) ? 'hidden lg:inline' : 'hidden md:inline'} relative text-[12px] sm:text-[14px] font-medium transition-colors duration-200 hover:text-white focus-visible:text-white focus-visible:outline-none ${
                    isActive
                      ? 'text-white after:absolute after:-bottom-1.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-[#145CFF] after:shadow-[0_0_8px_rgba(20,92,255,0.9)]'
                      : 'text-white/80'
                  }`}
                >
                  {link}
                </a>
              );
            })}
            <a
              href={ORDER_HREF}
              aria-label="Pedir agora pelo delivery"
              className="whitespace-nowrap bg-[#145CFF] text-white rounded-full px-4 py-2 text-[12px] sm:text-[13px] font-semibold hover:bg-[#0B4FE0] transition-all duration-200 shadow-[0_0_20px_rgba(20,92,255,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Pedir agora
            </a>
          </div>
        </nav>

        {/* Product: over the video's hand on desktop, in-flow above the copy on mobile/tablet */}
        <div
          className={
            overHand
              ? 'pointer-events-none absolute inset-0 z-10'
              : 'cc-cup-area flex min-h-0 flex-1 items-center justify-center px-6 pb-6 pt-4 sm:pt-8'
          }
        >
          <div
            className={
              overHand
                ? 'absolute aspect-square'
                : 'cc-cup-box relative aspect-square'
            }
            style={cupBox ? { left: cupBox.left, top: cupBox.top, width: cupBox.size } : undefined}
          >
            <div
              aria-hidden="true"
              className="absolute inset-x-[18%] inset-y-[10%] rounded-full bg-[#145CFF]/45 blur-[70px] cc-glow lg:blur-[100px]"
            />
            <div
              aria-hidden="true"
              className="absolute right-[24%] top-[2%] h-[26%] w-[26%] rounded-full bg-white/10 blur-2xl"
            />
            <div
              aria-hidden="true"
              className="absolute inset-x-[30%] bottom-[2%] h-[8%] rounded-[100%] bg-[#145CFF]/55 blur-2xl"
            />
            {overHand ? (
              <>
                <IceCube className="left-[7%] top-[10%] h-12 w-12 opacity-70 xl:h-14 xl:w-14" delay="-2s" />
                <IceCube className="right-[6%] top-[14%] h-9 w-9 opacity-50" delay="-1s" />
                <IceCube className="bottom-[12%] right-[12%] h-10 w-10 opacity-60" delay="-4s" />
              </>
            ) : (
              <>
                <IceCube className="left-[8%] top-[18%] h-9 w-9 opacity-70 sm:h-11 sm:w-11" delay="-2s" />
                <IceCube className="bottom-[22%] right-[8%] h-7 w-7 opacity-60 sm:h-9 sm:w-9" delay="-4s" />
              </>
            )}

            <DrinkShowcase />

            <InfoChip
              className={overHand ? 'left-[82%] top-[30%]' : 'left-[-6%] top-[36%]'}
              style={{ animationDelay: '-3s' }}
              icon={<Snowflake className="h-4 w-4" aria-hidden="true" />}
              title="Trincando de gelada"
              subtitle="Direto do freezer"
            />
            <InfoChip
              className={overHand ? 'bottom-[30%] left-[80%]' : 'bottom-[26%] right-[18%]'}
              style={{ animationDelay: '-5s' }}
              icon={<Motorbike className="h-4 w-4" aria-hidden="true" />}
              title="Entrega rápida"
              subtitle="Na porta da sua casa"
            />
          </div>
        </div>

        {/* Hero copy */}
        <main
          className={`cc-copy relative flex items-end pb-10 sm:pb-16 lg:pb-20 px-6 sm:px-12 md:px-20 lg:px-28 ${overHand ? 'flex-1' : 'shrink-0'}`}
        >
          <div className="max-w-xl">
            <img
              src="/logo.png"
              alt={`${BRAND_NAME} – Disk Bebidas`}
              width={112}
              height={112}
              className="mb-6 hidden h-24 w-24 rounded-full object-contain ring-1 ring-[#145CFF]/40 shadow-[0_0_50px_-4px_rgba(20,92,255,0.65)] sm:block lg:h-28 lg:w-28 [@media(max-height:700px)]:!hidden"
            />

            <div className="inline-flex items-center gap-2 bg-[#145CFF]/90 border border-blue-300/30 rounded-full px-3.5 py-2 backdrop-blur-md shadow-[0_0_24px_rgba(20,92,255,0.45)]">
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/70 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#CFE0FF] shadow-[0_0_10px_2px_rgba(207,224,255,0.9)]" />
              </span>
              <span className="text-[11px] sm:text-[12px] font-semibold tracking-wide text-white">
                GELADA • RÁPIDA • NA SUA CASA
              </span>
            </div>

            <h1 className="cc-h1 mt-4 sm:mt-5 lg:max-w-[26rem] text-4xl sm:text-5xl lg:text-6xl [@media(max-height:700px)]:lg:!text-[3rem] leading-[0.95] font-black text-white tracking-tight [text-shadow:0_4px_30px_rgba(0,0,0,0.45)]">
              Sua{' '}
              <span className="text-[#145CFF] [text-shadow:0_0_24px_rgba(20,92,255,0.65),0_0_60px_rgba(20,92,255,0.35)]">
                bebida gelada
              </span>{' '}
              chega até você.
            </h1>

            <p className="cc-lead mt-4 sm:mt-5 text-[14px] sm:text-[16px] text-white/70 font-normal leading-relaxed max-w-md lg:max-w-sm">
              Bebidas bem geladas, variedade e rapidez para deixar qualquer momento muito melhor.
            </p>

            <div className="cc-cta mt-6 sm:mt-7 flex flex-col gap-3 sm:flex-row">
              <a
                href={ORDER_HREF}
                aria-label="Pedir agora pelo delivery"
                className="group inline-flex whitespace-nowrap items-center justify-center gap-2 text-[13px] sm:text-[14px] font-bold text-white bg-[#145CFF] rounded-full px-6 py-3 hover:bg-[#0B4FE0] hover:scale-[1.03] transition-all duration-200 shadow-[0_14px_36px_-12px_rgba(20,92,255,0.95)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                Pedir agora
                <ArrowRight
                  className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-1"
                  aria-hidden="true"
                />
              </a>
              <a
                href="/bebidas"
                aria-label="Ver bebidas disponíveis"
                className="inline-flex whitespace-nowrap items-center justify-center gap-2 text-[13px] sm:text-[14px] font-semibold text-white border border-white/30 bg-white/5 backdrop-blur-md rounded-full px-6 py-3 hover:bg-white/10 hover:border-white/50 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
              >
                <GlassWater className="h-4 w-4 text-[#2563FF]" aria-hidden="true" />
                Ver bebidas
              </a>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

function HomePage({ count, onOrder }: { count: number; onOrder: (e: MouseEvent<HTMLAnchorElement>) => void }) {
  const heroRef = useRef<HTMLDivElement>(null);
  const pastHero = useOutOfView(heroRef);
  return (
    <>
      <Hero rootRef={heroRef} />
      <StickyNav visible={pastHero} count={count} onOrder={onOrder} />
      <ContatoSection />
      <FinalCta onOrder={onOrder} />
      <Footer />
    </>
  );
}

export default function App() {
  const route = useRoute();
  const { ready, products } = useProducts();
  const { cart, setQty, clear, lines, count, total } = useCart(products, ready);
  const [orderOpen, setOrderOpen] = useState(false);
  const openOrder = useCallback(() => setOrderOpen(true), []);
  const closeOrder = useCallback(() => setOrderOpen(false), []);
  // "Pedir agora": with items in the order it opens the order; otherwise the link goes to Bebidas.
  const startOrder = (e: MouseEvent<HTMLAnchorElement>) => {
    if (count > 0) {
      e.preventDefault();
      openOrder();
    }
  };

  // New page: scroll to its #section (e.g. "/#contato") or to the top, and set the tab title.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView({ behavior: 'instant' });
    else window.scrollTo({ top: 0, behavior: 'instant' });
    document.title = route === 'bebidas' ? 'Bebidas – COPO CHEIO Disk Bebidas' : 'COPO CHEIO – Disk Bebidas';
  }, [route]);

  return (
    <>
      <style>
        {MOTION_STYLES}
        {VIEWPORT_STYLES}
      </style>
      {route === 'bebidas' ? (
        <BebidasPage ready={ready} products={products} cart={cart} setQty={setQty} />
      ) : (
        <HomePage count={count} onOrder={startOrder} />
      )}
      <OrderBar show={count > 0 && !orderOpen} count={count} total={total} onOpen={openOrder} />
      <OrderDrawer open={orderOpen} onClose={closeOrder} lines={lines} total={total} setQty={setQty} onClear={clear} />
    </>
  );
}
