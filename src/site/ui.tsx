import { GlassWater, Info, Minus, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { comboNote } from '../lib/combo';
import { DEFAULT_LOGO } from '../lib/defaults';
import { money } from '../lib/format';
import { ICE_INFO, iceLabel } from '../lib/ice';
import { instagramHandle, unitPrice, useShop } from './data';
import type { CartLine, Product } from './data';
import { useEnergeticSwap } from './energeticSwapContext';
import { useIcePicker } from './icePicker';

// Peças visuais usadas em mais de uma página do site.

export const WHATSAPP_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#25D366] px-6 py-3.5 text-[15px] font-extrabold text-[#04210F] shadow-[0_16px_40px_-14px_rgba(37,211,102,0.8)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#3DE07A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
export const GHOST_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full border border-white/25 bg-white/5 px-6 py-3.5 text-[15px] font-semibold text-white backdrop-blur-md transition-all duration-200 hover:border-white/50 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';
export const BLUE_BUTTON =
  'inline-flex items-center justify-center gap-2.5 rounded-full bg-[#145CFF] px-6 py-3.5 text-[15px] font-extrabold text-white shadow-[0_16px_40px_-14px_rgba(20,92,255,0.95)] transition-all duration-200 hover:scale-[1.02] hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black';

export const NAV_LINKS = ['Início', 'Bebidas', 'Contato'];
// Fora de NAV_LINKS de propósito: o menu do Hero não muda. Estes aparecem no rodapé e no menu fixo.
export const CUSTOMER_LINKS = [
  { label: 'Acompanhar pedido', href: '/acompanhar-pedido' },
  { label: 'Minha conta', href: '/conta' },
];
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

// A logo padrão tem cópias de 128 e 256 px (public/logo-*.webp): na tela ela aparece com 36 a 128 px e o arquivo de 512 px pesa 72 KB. Uma
// logo enviada pelo painel (outro endereço) segue como está. `sizes` é a largura que a logo ocupa no lugar onde ela é usada.
export function logoSources(logo: string, sizes: string): { src: string; srcSet?: string; sizes?: string } {
  return logo === DEFAULT_LOGO ? { src: logo, srcSet: '/logo-128.webp 128w, /logo-256.webp 256w, /logo-512.webp 512w', sizes } : { src: logo };
}

export function IceCube({ className, delay = '0s' }: { className: string; delay?: string }) {
  return (
    <div aria-hidden="true" className={`pointer-events-none absolute cc-float ${className}`} style={{ animationDelay: delay }}>
      <div className="relative h-full w-full rotate-12">
        <img
          src="/gelo.webp"
          srcSet="/gelo-96.webp 96w, /gelo-192.webp 192w, /gelo.webp 320w"
          sizes="(min-width: 1024px) 80px, 48px"
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
// `accent`: o azul da última palavra. Em texto pequeno sobre fundo escuro o azul da marca (#2563FF) fica abaixo do contraste mínimo
// (4,18:1; o mínimo é 4,5:1): nesses pontos (rodapé) usa-se um azul um pouco mais claro. Nos títulos grandes continua o da marca.
export function BrandName({ name, accent = 'text-[#2563FF]' }: { name: string; accent?: string }) {
  const words = name.trim().toUpperCase().split(/\s+/);
  if (words.length < 2) return <>{words[0]}</>;
  return (
    <>
      {`${words.slice(0, -1).join(' ')} `}
      <span className={accent}>{words[words.length - 1]}</span>
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
        <s className="text-sm font-medium text-white/60">
          <span className="sr-only">de </span>
          {money(product.price)}
        </s>
      )}
    </span>
  );
}

// A foto do produto. Nas listas (cartões, linhas do pedido) é a miniatura de 400 px: ela já é o tamanho certo para qualquer celular (88 a 128 px de
// largura × densidade de até 3,8) e para as listas no computador (176 px × 2), e um `src` simples custa muito menos para o navegador do que um
// `srcset` com `sizes` em cada uma das ~90 fotos (medido: ~95 ms contra ~4 ms para criar 90 <img>, com a CPU de um celular intermediário). Nos "favoritos" (cartões
// grandes, uns poucos) vale o `srcset`, e `sizes` diz a largura do cartão em cada tela para o navegador escolher entre 400 e 720 px.
export const IMAGE_SIZES = {
  // "Os favoritos da galera" (FeaturedCard): 62% da tela no celular, 44% no tablet, 256/288 px no computador.
  featured: '(min-width: 1280px) 288px, (min-width: 1024px) 256px, (min-width: 640px) 44vw, 62vw',
} as const;

export function ProductImage({ product, padding = 'p-3 sm:p-4', sizes }: { product: Product; padding?: string; sizes?: string }) {
  const [failed, setFailed] = useState(false);
  const useSet = Boolean(sizes && product.imageSrcSet);
  if (!product.image || failed) {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-[#2563FF]/60" aria-hidden="true">
        <GlassWater className="h-1/3 w-1/3" strokeWidth={1.25} />
      </div>
    );
  }
  return (
    <img
      src={useSet ? product.image : (product.imageSm ?? product.image)}
      srcSet={useSet ? product.imageSrcSet : undefined}
      sizes={useSet ? sizes : undefined}
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

// `wide`: no computador (a partir de 1024 px) o rodapé acompanha a largura da página Bebidas (tela toda, com respiro nas laterais).
export function Footer({ wide = false }: { wide?: boolean } = {}) {
  const { store, logo } = useShop();
  const handle = instagramHandle(store);
  const lateral = wide ? 'lg:max-w-[120rem] lg:px-10 xl:px-14 2xl:px-20' : 'lg:px-12';
  return (
    <footer className="border-t border-white/10 bg-[#050505] py-10">
      <div className={`mx-auto flex max-w-7xl flex-col items-center gap-6 px-5 text-center sm:px-8 md:flex-row md:justify-between md:text-left ${lateral}`}>
        <a href="/" className="flex items-center gap-3 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#145CFF]">
          <img {...logoSources(logo, '44px')} alt="" width={44} height={44} loading="lazy" className="h-11 w-11 rounded-full object-contain ring-1 ring-white/15" />
          <span className="flex flex-col items-start leading-none">
            <span className="text-lg font-black tracking-tight text-white">
              <BrandName name={store.store_name} accent="text-[#3B72FF]" />
            </span>
            {store.tagline && (
              <span className="mt-1 text-[10px] font-semibold tracking-[0.2em] text-white/50">{store.tagline.toUpperCase()}</span>
            )}
          </span>
        </a>
        <nav aria-label="Rodapé" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3 text-sm font-medium text-white/65 md:justify-end">
          {NAV_LINKS.map((link) => (
            <a key={link} href={NAV_HREF[link]} className="-my-1 inline-block py-1 transition-colors hover:text-white">
              {link}
            </a>
          ))}
          {CUSTOMER_LINKS.map((link) => (
            <a key={link.href} href={link.href} className="-my-1 inline-block py-1 transition-colors hover:text-white">
              {link.label}
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
      <p className={`mx-auto mt-8 max-w-7xl px-5 text-center text-xs text-white/60 sm:px-8 md:text-left ${lateral}`}>
        © {new Date().getFullYear()} {store.store_name} {store.tagline}. Todos os direitos reservados.
        <span aria-hidden="true"> · </span>
        <a href="/privacidade" className="underline-offset-4 transition-colors hover:text-white hover:underline">
          Política de privacidade
        </a>
      </p>
    </footer>
  );
}

// Campo de formulário do site (checkout).
export const FIELD =
  'w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-[15px] text-white placeholder:text-white/50 focus:border-[#2563FF] focus:outline-none focus:ring-2 focus:ring-[#2563FF]/40 aria-[invalid=true]:border-rose-400/70';

// Uma linha do pedido (produto + gelo, ou combo + energético trocado). `setQty` recebe a chave da linha (o id do produto, id:gelo ou id@energético).
export function CartLineItem({ line, setQty }: { line: CartLine; setQty: (key: string, qty: number) => void }) {
  const { product, qty, key, ice, needsIce, swap: swapTo, unit } = line;
  const picker = useIcePicker();
  const swapper = useEnergeticSwap();
  const { cart } = useShop();
  // Nome para quem usa leitor de tela: a mesma bebida com gelos ou energéticos diferentes são linhas diferentes.
  const name = swapTo ? `${product.name}, com ${swapTo.name}` : ice ? `${product.name}, ${iceLabel(ice).toLowerCase()}` : product.name;
  const askIce = product.iceRequired && !product.soldOut;
  const note = comboNote(product.category);
  const soldOut = product.soldOut || swapTo?.soldOut === true;
  const extra = swapTo ? unit - unitPrice(product) : 0;
  return (
    <li data-line={key} className={`rounded-2xl border bg-white/5 p-2.5 ${needsIce ? 'border-amber-400/50' : 'border-white/10'}`}>
      <div className="flex items-center gap-3">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-[radial-gradient(circle_at_50%_60%,rgba(37,99,255,0.4),transparent_75%)]">
          <ProductImage product={product} padding="p-1" />
        </div>
        <div className="min-w-0 flex-1">
          {/* Produto que pede o gelo: até 3 linhas de nome (o mesmo copão em gelos diferentes precisa de nome inteiro para a pessoa saber
              qual é qual). Os demais produtos seguem com 2 linhas, como sempre. */}
          <p className={`${product.iceRequired ? 'line-clamp-3' : 'line-clamp-2'} text-sm font-bold leading-tight text-white`}>{product.name}</p>
          {soldOut ? (
            <p className="mt-1 text-xs font-bold text-rose-300">{product.soldOut ? 'Esgotado – remova do pedido' : `${swapTo?.name} esgotou – troque ou remova`}</p>
          ) : (
            <p className="mt-1 text-sm font-semibold text-[#8FB1FF]">{money(unit * qty)}</p>
          )}
        </div>
        <div className="flex items-center rounded-full border border-white/15 bg-black/20">
          <button
            type="button"
            onClick={() => setQty(key, product.soldOut ? 0 : qty - 1)}
            aria-label={qty === 1 || product.soldOut ? `Remover ${name}` : `Diminuir ${name}`}
            className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            {product.soldOut ? <X className="h-4 w-4" aria-hidden="true" /> : <Minus className="h-4 w-4" aria-hidden="true" />}
          </button>
          <span className="w-6 text-center text-sm font-bold tabular-nums text-white" aria-live="polite">
            {qty}
          </span>
          <button
            type="button"
            onClick={() => setQty(key, qty + 1)}
            disabled={product.soldOut}
            aria-label={`Aumentar ${name}`}
            className="grid h-9 w-9 place-items-center rounded-full text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-30"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      {note && !swapTo && (
        <p data-combo-note="" className="mt-2 rounded-xl bg-amber-400/10 px-3 py-2 text-xs font-semibold leading-snug text-amber-100 ring-1 ring-amber-400/30">
          Obs: {note}
        </p>
      )}
      {note && !swapTo && swapper.canSwap(product) && (
        <button
          type="button"
          data-swap-energetic=""
          onClick={() => swapper.open(product)}
          className="mt-2 w-full rounded-xl border border-[#2563FF]/60 bg-[#145CFF]/15 px-3 py-2.5 text-xs font-extrabold tracking-wide text-white transition-colors hover:bg-[#145CFF]/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          QUERO TROCAR O ENERGÉTICO
        </button>
      )}
      {/* Combo com o energético trocado: qual é, quanto a troca custa por combo, e atalhos para mudar ou voltar ao original. */}
      {swapTo && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[4.75rem]">
          <span data-swap-tag={swapTo.id} className="inline-block rounded-2xl bg-[#145CFF]/20 px-2.5 py-1 text-xs font-semibold leading-snug text-white ring-1 ring-[#2563FF]/50">
            <span aria-hidden="true">⚡ </span>
            {swapTo.name} <span className="whitespace-nowrap font-extrabold">{extra > 0 ? `(+ ${money(extra)})` : '(sem diferença)'}</span>
          </span>
          {swapper.canSwap(product) && (
            <button
              type="button"
              data-swap-change=""
              onClick={() => swapper.open(product)}
              aria-label={`Alterar o energético de ${product.name}`}
              className="-my-1 rounded px-1 py-1.5 text-xs font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Alterar
            </button>
          )}
          <button
            type="button"
            data-swap-undo=""
            onClick={() => cart.swapBy(product.id, swapTo.id, -qty)}
            aria-label={`Voltar ao energético original de ${product.name}`}
            className="-my-1 rounded px-1 py-1.5 text-xs font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            Voltar ao original
          </button>
        </div>
      )}
      {/* O gelo escolhido, na largura toda da linha (alinhado ao texto, depois da foto): cabe inteiro até em celular pequeno. */}
      {askIce && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[4.75rem]">
          {ice ? (
            <>
              <span data-ice-tag={ice} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-[#145CFF]/20 px-2.5 py-0.5 text-xs font-semibold text-white ring-1 ring-[#2563FF]/50">
                <span aria-hidden="true">{ICE_INFO[ice].emoji}</span>
                {ICE_INFO[ice].label}
              </span>
              <button
                type="button"
                onClick={() => picker.edit(line)}
                aria-label={`Alterar o gelo de ${product.name}`}
                className="-my-1 rounded px-1 py-1.5 text-xs font-semibold text-[#8FB1FF] underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                Alterar
              </button>
            </>
          ) : (
            <button
              type="button"
              data-ice-pending=""
              onClick={() => picker.edit(line)}
              aria-label={`Escolher o gelo de ${product.name} (obrigatório)`}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-400/15 px-2.5 py-1 text-xs font-bold text-amber-100 ring-1 ring-amber-400/50 transition-colors hover:bg-amber-400/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              Escolher o gelo *
            </button>
          )}
        </div>
      )}
    </li>
  );
}

// Aviso que aparece logo depois de adicionar um produto com observação (os combos). Não rouba o foco, o leitor de tela o anuncia
// (role="status") e dá para fechar; some sozinho depois de alguns segundos. Fica acima da barra "Ver pedido".
export function AddNotice({ notice, onClose }: { notice: { id: number; text: string; productId: string } | null; onClose: () => void }) {
  const swapper = useEnergeticSwap();
  const { products } = useShop();
  const combo = notice ? products.find((p) => p.id === notice.productId) : undefined;
  return (
    <div role="status" className="pointer-events-none fixed inset-x-0 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-[45] flex justify-center px-4">
      {notice && (
        <div
          key={notice.id}
          data-add-notice=""
          className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-2xl border border-amber-400/40 bg-[#1B1405]/95 p-3.5 text-sm leading-snug text-amber-50 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.85)] backdrop-blur"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />
          <p className="min-w-0 flex-1">
            <strong className="block text-white">Combo adicionado ao pedido.</strong>
            <span className="font-semibold">Obs: {notice.text}</span>
            {combo && swapper.canSwap(combo) && (
              <button
                type="button"
                data-swap-energetic=""
                onClick={() => {
                  onClose();
                  swapper.open(combo);
                }}
                className="mt-2.5 block w-full rounded-xl bg-[#145CFF] px-3 py-2.5 text-xs font-extrabold tracking-wide text-white transition-colors hover:bg-[#2563FF] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                QUERO TROCAR O ENERGÉTICO
              </button>
            )}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar aviso"
            className="-m-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-amber-100/80 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
