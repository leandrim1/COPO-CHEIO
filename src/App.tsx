import { ArrowRight, GlassWater, Motorbike, Snowflake } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';

const BRAND_NAME = 'COPO CHEIO';
const VIDEO_URL =
  'https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260508_215831_c6a8989c-d716-4d8d-8745-e972a2eec711.mp4';

// Troque pelo link do WhatsApp (ex.: https://wa.me/55DDDNUMERO) quando estiver disponível.
const ORDER_HREF = '#contato';

// Where the hand in the background video sits, as fractions of the video frame.
// On desktop the cup is drawn over it so the hand never shows.
const HAND_IN_VIDEO = { centerX: 0.498, cupTop: 0.26, cupSize: 0.82 };
// Horizontal centre of the cup inside bebida.png (the image has transparent side margins).
const CUP_CENTER_IN_IMAGE = 0.51;

const NAV_LINKS = ['Início', 'Bebidas', 'Ofertas', 'Sobre', 'Contato'];
// Hidden on tablet so the pill never collides with the logo; everything shows from lg up.
const SECONDARY_LINKS = new Set(['Início', 'Sobre']);

const toAnchor = (label: string) =>
  `#${label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()}`;

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

// Mirrors the video's object-cover/object-left framing to find where the hand is rendered,
// and returns the box the cup must occupy to cover it. Null when the layout can't host the
// cup there (mobile, tablets and portrait windows), which keeps the regular placement.
function useCupOverHand(rootRef: RefObject<HTMLDivElement | null>, videoRef: RefObject<HTMLVideoElement | null>) {
  const [box, setBox] = useState<CupBox | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const video = videoRef.current;
    if (!root || !video) return;

    const update = () => {
      const { width, height } = root.getBoundingClientRect();
      if (width < 1024 || width / height < 1.2) {
        setBox(null);
        return;
      }
      const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const renderedHeight = Math.max(height, width / aspect);
      const renderedWidth = renderedHeight * aspect;
      const offsetY = (height - renderedHeight) / 2;
      const size = renderedHeight * HAND_IN_VIDEO.cupSize;
      setBox({
        left: renderedWidth * HAND_IN_VIDEO.centerX - size * CUP_CENTER_IN_IMAGE,
        top: offsetY + renderedHeight * HAND_IN_VIDEO.cupTop,
        size,
      });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    video.addEventListener('loadedmetadata', update);
    return () => {
      observer.disconnect();
      video.removeEventListener('loadedmetadata', update);
    };
  }, [rootRef, videoRef]);

  return box;
}

function IceCube({ className, delay = '0s' }: { className: string; delay?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute cc-float ${className}`} style={{ animationDelay: delay }}>
      <div className="relative h-full w-full rotate-12 rounded-xl border border-white/25 bg-gradient-to-br from-white/30 via-white/5 to-[#145CFF]/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_10px_30px_-8px_rgba(20,92,255,0.6)] backdrop-blur-[2px]">
        <span className="absolute left-[18%] top-[14%] h-[34%] w-[14%] rounded-full bg-white/60 blur-[1px]" />
        <span className="absolute bottom-[16%] right-[16%] h-[10%] w-[10%] rounded-full bg-white/40" />
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
      className={`absolute hidden items-center gap-3 rounded-2xl border border-white/15 bg-[#080A0F]/60 px-3.5 py-2.5 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur-xl cc-float xl:flex ${className}`}
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
  const cupBox = useCupOverHand(rootRef, videoRef);
  const overHand = cupBox !== null;

  return (
    <div ref={rootRef} id="inicio" className="relative min-h-screen overflow-hidden bg-black">
      <style>{MOTION_STYLES}</style>

      {/* Background video, left-aligned so on portrait screens its hand falls outside the frame */}
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover object-left"
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
      <div className="relative z-10 flex flex-col min-h-screen">
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
              ? 'pointer-events-none absolute inset-0'
              : 'flex justify-center px-6 pt-4 sm:pt-8 lg:pointer-events-none lg:absolute lg:inset-0 lg:block lg:p-0'
          }
        >
          <div
            className={
              overHand
                ? 'absolute aspect-square'
                : 'relative aspect-square w-[min(64vw,29vh)] sm:w-[min(60vw,40vh)] lg:absolute lg:right-[-5%] lg:bottom-[-5%] lg:w-[min(64vh,46vw)] xl:w-[min(84vh,50vw)]'
            }
            style={cupBox ? { left: cupBox.left, top: cupBox.top, width: cupBox.size } : undefined}
          >
            {overHand && (
              <div
                aria-hidden="true"
                className="absolute inset-x-[22%] bottom-[-8%] top-[24%] rounded-full bg-[#050505]/60 blur-3xl"
              />
            )}
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
            <picture>
              <source srcSet="/bebida.webp" type="image/webp" />
              <img
                src="/bebida.png"
                alt="Frozen rosa com chantilly, calda de frutas vermelhas e picolé"
                width={1254}
                height={1254}
                fetchPriority="high"
                className="relative h-full w-full object-contain cc-float drop-shadow-[0_30px_50px_rgba(0,0,0,0.55)]"
              />
            </picture>

            {overHand ? (
              <>
                <IceCube className="left-[24%] top-[8%] h-12 w-12 opacity-70 xl:h-14 xl:w-14" delay="-2s" />
                <IceCube className="right-[10%] top-[12%] h-9 w-9 opacity-50" delay="-1s" />
                <IceCube className="bottom-[14%] left-[20%] h-10 w-10 opacity-60" delay="-4s" />
              </>
            ) : (
              <>
                <IceCube className="left-[8%] top-[18%] h-9 w-9 opacity-70 sm:h-11 sm:w-11 lg:left-[20%] lg:top-[4%] lg:h-12 lg:w-12 xl:left-[8%] xl:top-[16%] xl:h-14 xl:w-14" delay="-2s" />
                <IceCube className="bottom-[22%] right-[10%] h-7 w-7 opacity-60 sm:h-9 sm:w-9 lg:bottom-[16%] lg:left-[16%] lg:right-auto lg:h-10 lg:w-10" delay="-4s" />
                <IceCube className="right-[24%] top-[6%] hidden h-8 w-8 opacity-50 lg:block" delay="-1s" />
              </>
            )}

            <InfoChip
              className={overHand ? 'right-[-16%] top-[30%]' : 'left-[-6%] top-[36%]'}
              style={{ animationDelay: '-3s' }}
              icon={<Snowflake className="h-4 w-4" aria-hidden="true" />}
              title="Trincando de gelada"
              subtitle="Direto do freezer"
            />
            <InfoChip
              className={overHand ? 'bottom-[30%] right-[-8%]' : 'bottom-[26%] right-[18%]'}
              style={{ animationDelay: '-5s' }}
              icon={<Motorbike className="h-4 w-4" aria-hidden="true" />}
              title="Entrega rápida"
              subtitle="Na porta da sua casa"
            />
          </div>
        </div>

        {/* Hero copy */}
        <main className="relative flex-1 flex items-end pb-10 sm:pb-16 lg:pb-20 px-6 sm:px-12 md:px-20 lg:px-28">
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

            <h1 className="mt-4 sm:mt-5 lg:max-w-[26rem] text-4xl sm:text-5xl lg:text-6xl leading-[0.95] font-black text-white tracking-tight [text-shadow:0_4px_30px_rgba(0,0,0,0.45)]">
              Sua{' '}
              <span className="text-[#145CFF] [text-shadow:0_0_24px_rgba(20,92,255,0.65),0_0_60px_rgba(20,92,255,0.35)]">
                bebida gelada
              </span>{' '}
              chega até você.
            </h1>

            <p className="mt-4 sm:mt-5 text-[14px] sm:text-[16px] text-white/70 font-normal leading-relaxed max-w-md lg:max-w-sm">
              Bebidas bem geladas, variedade e rapidez para deixar qualquer momento muito melhor.
            </p>

            <div className="mt-6 sm:mt-7 flex flex-col gap-3 sm:flex-row">
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
