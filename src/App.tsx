import { ArrowRight, GlassWater, Motorbike, Snowflake } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

const BRAND_NAME = 'COPO CHEIO';
const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260508_215831_c6a8989c-d716-4d8d-8745-e972a2eec711.mp4';

// Troque pelo link do WhatsApp (ex.: https://wa.me/55DDDNUMERO) quando estiver disponível.
const ORDER_HREF = '#contato';

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
  { src: '/bebidas/frozen-rosa.webp', alt: 'Frozen rosa com chantilly, calda de frutas vermelhas e picolé' },
  { src: '/bebidas/frozen-chocolate.webp', alt: 'Copo cremoso com chocolate, maracujá e picolé de manga' },
  { src: '/bebidas/energetico-azul.webp', alt: 'Energético azul em copo com gelo' },
];

const NAV_LINKS = ['Início', 'Bebidas', 'Ofertas', 'Sobre', 'Contato'];
// Hidden on tablet so the pill never collides with the logo; everything shows from lg up.
const SECONDARY_LINKS = new Set(['Início', 'Sobre']);

const toAnchor = (label: string) =>
  `#${label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()}`;

// Mobile-first fit: in portrait the page is exactly one visible screen tall (dvh follows the browser's
// address bar, vh does not) and cannot be scrolled; the cup area takes whatever height is left and the
// cup is sized to it with container units (the vh line is the fallback for older browsers). Landscape
// pages are not height-locked, so there the cup keeps a window-based size and the page may scroll.
const VIEWPORT_STYLES = `
.cc-screen { min-height: 100vh; min-height: 100dvh; }
.cc-cup-area { container-type: size; }
.cc-cup-box { width: clamp(6rem, calc(100vh - 32rem), 76vw); width: min(86cqw, 100cqh); }
@media (min-width: 640px) {
  .cc-cup-box { width: min(60vw, 38vh); width: min(60cqw, 100cqh); }
}
@media (orientation: portrait) {
  html, body { height: 100%; overflow: hidden; overscroll-behavior: none; }
  .cc-screen { height: 100vh; height: 100dvh; }
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

export default function App() {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { handMask, cupBox } = useVideoFraming(rootRef, videoRef);
  const overHand = cupBox !== null;

  return (
    <div ref={rootRef} id="inicio" className="cc-screen relative overflow-hidden bg-black">
      <style>{MOTION_STYLES}{VIEWPORT_STYLES}</style>

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
                  href={toAnchor(link)}
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
                href="#bebidas"
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
