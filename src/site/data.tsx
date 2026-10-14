import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { DEFAULT_HERO, DEFAULT_LOGO, DEFAULT_PAYMENTS, DEFAULT_SITE, DEFAULT_STORE } from '../lib/defaults';
import { comboNote, swapBasePrice, swapDifference, swapStillValid } from '../lib/combo';
import { isOpenNow } from '../lib/hours';
import { addToCart, changeLineIce, countFor, normalizeCart, parseLineKey, setLineQty, setProductTotal, settleCart, swapUnits } from '../lib/ice';
import type { Cart, IceChoice } from '../lib/ice';
import type { Banner, Category, DayHours, DayKey, DeliveryZone, HeroSettings, OpeningHours, PaymentOption, SiteSettings, StoreSettings } from '../lib/types';

// Produto como o site mostra (vem de GET /api/products: tabelas products + categories do Neon).
export type Product = {
  id: string;
  name: string;
  category: string;
  categoryPosition: number;
  price: number;
  promoPrice: number | null;
  description?: string;
  image?: string;
  featured: boolean;
  soldOut: boolean;
  position: number;
  // A categoria do produto pede a escolha do gelo (gelo normal ou de sabor) antes de ir para o pedido.
  iceRequired: boolean;
  // Combos (troca de energético): o produto do cardápio que é o energético que vem no combo e/ou o VALOR dele (o painel define; sem nenhum dos
  // dois o produto não aceita a troca) e os energéticos que o cliente pode escolher (lista vazia = qualquer energético de 2L).
  swapBaseId: string | null;
  swapBasePrice: number | null;
  swapOptionIds: string[];
};

export const unitPrice = (p: Product) => p.promoPrice ?? p.price;
export const OTHER_CATEGORY = 'Outros';

type ShopData = {
  store: StoreSettings;
  site: SiteSettings;
  hero: HeroSettings;
  products: Product[];
  // Carrossel abaixo do título "Bebidas".
  banners: Banner[];
  // Faixa do topo da página (no lugar dos gelos). Vazio = a capa azul de sempre.
  coverBanners: Banner[];
  zones: DeliveryZone[];
  payments: PaymentOption[];
};

// v3: os produtos passaram a trazer `iceRequired`. Uma cópia v2 (sem essa informação) seria um cardápio que deixa pedir copão sem
// perguntar o gelo, então ela simplesmente não é mais lida.
const CACHE_KEY = 'copocheio:site-v3';
const EMPTY: ShopData = { store: DEFAULT_STORE, site: DEFAULT_SITE, hero: DEFAULT_HERO, products: [], banners: [], coverBanners: [], zones: [], payments: DEFAULT_PAYMENTS };

// ---- Dados defensivos --------------------------------------------------------------------------
// O que vem da API (ou da cópia salva no navegador, que pode ser de uma versão antiga do site) nunca derruba a página: campo
// que falta, nulo ou com formato estranho cai no valor padrão em vez de virar tela branca.

const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = <T,>(value: unknown, keep: (item: unknown) => boolean): T[] => (Array.isArray(value) ? (value.filter(keep) as T[]) : []);
const text = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value : fallback);
const amount = (value: unknown, fallback: number) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function normalizeHours(raw: unknown): OpeningHours {
  const source = isObject(raw) ? raw : {};
  const hours = {} as OpeningHours;
  for (const key of DAY_KEYS) {
    const day = source[key] as Partial<DayHours> | undefined;
    hours[key] =
      isObject(day) && typeof day.open === 'boolean' && typeof day.start === 'string' && TIME.test(day.start) && typeof day.end === 'string' && TIME.test(day.end)
        ? { open: day.open, start: day.start, end: day.end }
        : DEFAULT_STORE.opening_hours[key];
  }
  return hours;
}

export function normalizeStore(raw: unknown): StoreSettings {
  const r = (isObject(raw) ? raw : {}) as Partial<StoreSettings>;
  return {
    ...DEFAULT_STORE,
    ...r,
    store_name: text(r.store_name, DEFAULT_STORE.store_name),
    tagline: typeof r.tagline === 'string' ? r.tagline : DEFAULT_STORE.tagline,
    opening_hours: normalizeHours(r.opening_hours),
    timezone: text(r.timezone, DEFAULT_STORE.timezone),
    orders_paused: r.orders_paused === true,
    delivery_enabled: typeof r.delivery_enabled === 'boolean' ? r.delivery_enabled : DEFAULT_STORE.delivery_enabled,
    pickup_enabled: typeof r.pickup_enabled === 'boolean' ? r.pickup_enabled : DEFAULT_STORE.pickup_enabled,
    delivery_fee: amount(r.delivery_fee, DEFAULT_STORE.delivery_fee),
    min_order: amount(r.min_order, 0),
    tracking_retention_days: amount(r.tracking_retention_days, DEFAULT_STORE.tracking_retention_days),
  };
}

export function normalizeSite(raw: unknown): SiteSettings {
  const r = (isObject(raw) ? raw : {}) as Partial<SiteSettings>;
  const merged = { ...DEFAULT_SITE, ...r };
  for (const key of ['bebidas_title', 'featured_title', 'contato_title', 'cta_title', 'cta_button', 'seo_title'] as const) merged[key] = text(r[key], DEFAULT_SITE[key]);
  merged.featured_limit = Math.max(1, Math.min(24, Math.round(amount(r.featured_limit, DEFAULT_SITE.featured_limit))));
  return merged;
}

export function normalizeHero(raw: unknown): HeroSettings {
  const r = (isObject(raw) ? raw : {}) as Partial<HeroSettings>;
  return { ...DEFAULT_HERO, ...r, images: Array.isArray(r.images) ? r.images : [] };
}

const bannerOk = (item: unknown) => isObject(item) && typeof item.id === 'string';
const zoneOk = (item: unknown) => isObject(item) && typeof item.id === 'string' && typeof item.name === 'string' && item.name.trim() !== '' && Number.isFinite(Number(item.fee));
const paymentOk = (item: unknown) => isObject(item) && (item.code === 'pix' || item.code === 'cash' || item.code === 'card' || item.code === 'pix_online' || item.code === 'card_online');

type ContentFromApi = {
  store?: unknown;
  site?: unknown;
  hero?: unknown;
  banners?: unknown;
  cover_banners?: unknown;
  zones?: unknown;
  payments?: unknown;
};

export function normalizeContent(raw: ContentFromApi): Omit<ShopData, 'products'> {
  const payments = list<PaymentOption>(raw.payments, paymentOk);
  return {
    store: normalizeStore(raw.store),
    site: normalizeSite(raw.site),
    hero: normalizeHero(raw.hero),
    banners: list<Banner>(raw.banners, bannerOk),
    coverBanners: list<Banner>(raw.cover_banners, bannerOk),
    zones: list<DeliveryZone>(raw.zones, zoneOk).map((zone) => ({ ...zone, fee: Number(zone.fee) })),
    payments: payments.length ? payments : DEFAULT_PAYMENTS,
  };
}

function readCache(): ShopData | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!isObject(parsed) || !isObject(parsed.store) || !isObject(parsed.site) || !isObject(parsed.hero) || !Array.isArray(parsed.products)) return null;
    // A cópia salva passa pelas mesmas conferências da resposta da API (um formato antigo ou corrompido não derruba a página).
    const content = normalizeContent({ ...parsed, cover_banners: parsed.coverBanners });
    const products = (parsed.products as unknown[])
      .filter(
        (p): p is Product =>
          isObject(p) && typeof p.id === 'string' && typeof p.name === 'string' && Number.isFinite(Number(p.price)) && typeof p.category === 'string' && typeof p.iceRequired === 'boolean',
      )
      // A cópia salva por uma versão de antes da troca de energético não tem esse campo.
      .map((p) => ({
        ...p,
        swapBaseId: typeof p.swapBaseId === 'string' ? p.swapBaseId : null,
        swapBasePrice: Number.isFinite(Number(p.swapBasePrice)) && p.swapBasePrice !== null ? Number(p.swapBasePrice) : null,
        swapOptionIds: Array.isArray(p.swapOptionIds) ? p.swapOptionIds.filter((x): x is string => typeof x === 'string') : [],
      }));
    return { ...EMPTY, ...content, products };
  } catch {
    return null;
  }
}

type ProductRowFromDb = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  promo_price: number | null;
  image_url: string | null;
  featured: boolean;
  sold_out: boolean;
  position: number;
  swap_base_product_id?: string | null;
  swap_base_price?: number | string | null;
  swap_option_ids?: string[] | null;
};

function toProducts(rows: ProductRowFromDb[], categories: Category[]): Product[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return rows
    .filter((row) => isObject(row) && typeof row.id === 'string' && typeof row.name === 'string' && Number.isFinite(Number(row.price)))
    .map((row) => {
      const category = row.category_id ? byId.get(row.category_id) : undefined;
      return {
        id: row.id,
        name: row.name,
        category: category?.name ?? OTHER_CATEGORY,
        categoryPosition: category ? category.position : Number.MAX_SAFE_INTEGER,
        price: Number(row.price),
        promoPrice: row.promo_price === null ? null : Number(row.promo_price),
        description: row.description?.trim() || undefined,
        image: row.image_url || undefined,
        featured: row.featured,
        soldOut: row.sold_out,
        position: row.position,
        iceRequired: category?.ice_choice_required === true,
        swapBaseId: typeof row.swap_base_product_id === 'string' ? row.swap_base_product_id : null,
        swapBasePrice: row.swap_base_price === null || row.swap_base_price === undefined || !Number.isFinite(Number(row.swap_base_price)) ? null : Number(row.swap_base_price),
        swapOptionIds: Array.isArray(row.swap_option_ids) ? row.swap_option_ids.filter((x): x is string => typeof x === 'string') : [],
      };
    })
    .sort(
      (a, b) =>
        a.categoryPosition - b.categoryPosition ||
        a.category.localeCompare(b.category, 'pt-BR') ||
        a.position - b.position ||
        a.name.localeCompare(b.name, 'pt-BR'),
    );
}

// `bypassCache`: pede direto ao servidor, sem a cópia de poucos segundos que a borda da Vercel guarda (usado quando o preço mudou).
async function fetchShop(bypassCache = false): Promise<ShopData> {
  const bust = bypassCache ? `?t=${Date.now()}` : '';
  const [catalog, content] = await Promise.all([
    api.get<{ categories?: Category[]; products?: ProductRowFromDb[] }>(`/api/products${bust}`),
    api.get<ContentFromApi>(`/api/site${bust}`),
  ]);
  const categories = list<Category>(catalog.categories, (c) => isObject(c) && typeof c.id === 'string' && typeof c.name === 'string');
  const visibleCategories = new Set(categories.map((c) => c.id));
  const rows = list<ProductRowFromDb>(catalog.products, isObject);
  return {
    ...normalizeContent(content),
    products: toProducts(
      rows.filter((p) => !p.category_id || visibleCategories.has(p.category_id)),
      categories,
    ),
  };
}

// Carrega tudo de uma vez; usa a última cópia salva no navegador enquanto a nova não chega e
// atualiza de novo quando a pessoa volta para a aba (preço, estoque e textos sempre em dia).
function useShopData() {
  const [state, setState] = useState(() => {
    const cached = readCache();
    return { data: cached ?? EMPTY, fresh: false, cached: !!cached, failed: false };
  });
  const lastFetch = useRef(0);

  const refresh = useCallback(async (bypassCache = false) => {
    lastFetch.current = Date.now();
    try {
      const data = await fetchShop(bypassCache);
      setState({ data, fresh: true, cached: true, failed: false });
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(data));
      } catch {
        /* sem espaço ou modo privado */
      }
    } catch {
      setState((s) => ({ ...s, fresh: true, failed: true }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetch.current > 30_000) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  return { ...state, refresh };
}

// ---- Pedido (carrinho): guardado no navegador ------------------------------------------------

const CART_KEY = 'copocheio:pedido';

// Uma linha do pedido é "produto + gelo" ou "combo + energético trocado". Produto que não pede o gelo, sem troca, tem `ice: null` e a chave
// é só o id (o formato de sempre).
export type CartLine = {
  key: string;
  product: Product;
  qty: number;
  ice: IceChoice | null;
  // Combo com o energético trocado: o energético escolhido (o preço da linha já leva a diferença).
  swap: Product | null;
  // Preço de UMA unidade desta linha, em reais (o produto; no combo trocado, o combo + a diferença).
  unit: number;
  // O produto pede o gelo e a linha está sem escolha (ex.: pedido guardado antes de existir a pergunta): precisa escolher.
  needsIce: boolean;
};

function loadCart(): Cart {
  try {
    return normalizeCart(JSON.parse(localStorage.getItem(CART_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function useCart(products: Product[], ready: boolean) {
  const [cart, setCart] = useState<Cart>(loadCart);
  // Aviso que aparece depois de adicionar um produto que tem observação (hoje, os combos); some sozinho.
  const [notice, setNotice] = useState<{ id: number; text: string; productId: string } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const dismissNotice = useCallback(() => setNotice(null), []);

  // Depois de carregar o cardápio, tira o que não está mais nele e acerta o gelo ao que cada produto pede agora.
  useEffect(() => {
    if (!ready) return;
    const byId = new Map(products.map((p) => [p.id, p.iceRequired]));
    // A troca de energético de uma linha só vale se o combo ainda tem energético definido e o novo ainda existe (e é de 2L).
    setCart((prev) => settleCart(prev, (id) => byId.get(id), (id, swapTo) => swapStillValid(products, id, swapTo)));
  }, [products, ready]);

  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* modo privado: o pedido só não fica guardado */
    }
  }, [cart]);

  // Quantidade de uma linha (a chave é o id do produto, ou id:gelo). Zero ou menos tira a linha.
  const setQty = useCallback((key: string, qty: number) => setCart((prev) => setLineQty(prev, key, qty)), []);
  // Põe unidades de um produto no pedido; `ice` só vale (e é obrigatório) para produto que pede o gelo.
  const add = useCallback((product: Product, ice: IceChoice | null, qty = 1) => setCart((prev) => addToCart(prev, product.id, product.iceRequired ? ice : null, qty)), []);
  // Chamado pelos cartões de produto quando a pessoa aumenta a quantidade: se o produto tem observação (hoje, os combos), mostra o aviso.
  const announce = useCallback((product: Product) => {
    const text = comboNote(product.category);
    if (text) setNotice({ id: Date.now(), text, productId: product.id });
  }, []);
  // Pedir de novo: o combo já com o energético trocado (se a troca ainda vale; senão o chamador põe o combo normal).
  const addSwapped = useCallback((product: Product, swapTo: string, qty = 1) => setCart((prev) => swapUnits(addToCart(prev, product.id, null, qty), product.id, swapTo, qty)), []);
  // Combo: passa `delta` unidades entre o energético que vem nele (delta < 0 volta a ele) e o energético `energeticId` (delta > 0).
  const swapBy = useCallback((productId: string, energeticId: string, delta: number) => setCart((prev) => swapUnits(prev, productId, energeticId, delta)), []);
  // O contador do cartão do produto (soma todas as linhas do produto): aumentar entra na linha normal; diminuir tira primeiro dela.
  const setTotal = useCallback((productId: string, total: number) => setCart((prev) => setProductTotal(prev, productId, total)), []);
  // Troca o gelo de uma linha que já está no pedido (a quantidade vai junto).
  const changeIce = useCallback((key: string, ice: IceChoice) => setCart((prev) => changeLineIce(prev, key, ice)), []);
  const clear = useCallback(() => setCart({}), []);
  // Quantas unidades do produto estão no pedido, somando todos os gelos.
  const countOf = useCallback((productId: string) => countFor(cart, productId), [cart]);

  const lines: CartLine[] = useMemo(() => {
    const byId = new Map(products.map((p) => [p.id, p]));
    const byProduct = new Map<string, { key: string; qty: number; ice: IceChoice | null; swap: Product | null }[]>();
    for (const [key, qty] of Object.entries(cart)) {
      const parsed = parseLineKey(key);
      if (!parsed) continue;
      const swap = parsed.swapTo ? byId.get(parsed.swapTo) ?? null : null;
      if (parsed.swapTo && !swap) continue;
      const list = byProduct.get(parsed.productId) ?? [];
      list.push({ key, qty, ice: parsed.ice, swap });
      byProduct.set(parsed.productId, list);
    }
    // Na ordem do cardápio; do mesmo produto, primeiro a linha sem escolha, depois gelo normal e gelo de sabor e, por fim, as de energético trocado.
    const rank = (ice: IceChoice | null, swap: Product | null) => (swap ? 3 : ice === null ? 0 : ice === 'normal' ? 1 : 2);
    return products.flatMap((product) =>
      (byProduct.get(product.id) ?? [])
        .sort((a, b) => rank(a.ice, a.swap) - rank(b.ice, b.swap) || (a.swap?.name ?? '').localeCompare(b.swap?.name ?? '', 'pt-BR'))
        .map(({ key, qty, ice, swap }) => {
          // O combo trocado custa o combo + a diferença de preço dos energéticos (o banco recalcula igual ao criar o pedido).
          const basePrice = swap ? swapBasePrice(products, product) : null;
          const unit = swap && basePrice !== null ? (Math.round(unitPrice(product) * 100) + Math.round(swapDifference(swap, basePrice) * 100)) / 100 : unitPrice(product);
          return { key, product, qty, ice, swap, unit, needsIce: product.iceRequired && ice === null };
        }),
    );
  }, [products, cart]);
  const count = lines.reduce((sum, line) => sum + line.qty, 0);
  const total = lines.reduce((sum, line) => sum + Math.round(line.unit * 100) * line.qty, 0) / 100;
  const unavailable = lines.filter((line) => line.product.soldOut || line.swap?.soldOut === true);
  const incomplete = lines.filter((line) => line.needsIce);

  return { cart, setQty, add, addSwapped, swapBy, setTotal, changeIce, countOf, clear, lines, count, total, unavailable, incomplete, notice, announce, dismissNotice };
}

// ---- Contexto ---------------------------------------------------------------------------------

type Shop = ShopData & {
  // ready: o cardápio já veio da API (ou da cópia salva) e pode ser mostrado.
  ready: boolean;
  fresh: boolean;
  failed: boolean;
  // A API não respondeu e não há cópia salva: os dados na tela são só os padrões. Nada de "Fechado" ou horário inventado.
  offline: boolean;
  refresh: (bypassCache?: boolean) => Promise<void>;
  logo: string;
  isOpen: boolean;
  cart: ReturnType<typeof useCart>;
};

const ShopContext = createContext<Shop | null>(null);

export function ShopProvider({ children }: { children: ReactNode }) {
  const { data, fresh, cached, failed, refresh } = useShopData();
  const cart = useCart(data.products, fresh && !failed);
  const [now, setNow] = useState(() => Date.now());

  // Recalcula "aberto/fechado" a cada minuto.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const isOpen = useMemo(
    () => !data.store.orders_paused && isOpenNow(data.store.opening_hours, data.store.timezone, new Date(now)),
    [data.store, now],
  );

  const value: Shop = {
    ...data,
    ready: fresh || cached,
    fresh,
    failed,
    offline: failed && !cached,
    refresh,
    logo: data.site.logo_url || DEFAULT_LOGO,
    isOpen,
    cart,
  };
  return <ShopContext.Provider value={value}>{children}</ShopContext.Provider>;
}

export function useShop(): Shop {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error('useShop precisa do ShopProvider');
  return shop;
}

// ---- WhatsApp e Instagram da loja ---------------------------------------------------------------

// Sem número configurado o link abre o WhatsApp para a pessoa escolher o contato.
export const storeWhatsappUrl = (store: StoreSettings, text: string) =>
  `https://wa.me/${(store.whatsapp ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;

export const instagramHandle = (store: StoreSettings) => (store.instagram ?? '').replace(/^@/, '');

export const fullAddress = (store: StoreSettings) =>
  [store.address, [store.city, store.state].filter(Boolean).join(' - '), store.cep ? store.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '']
    .filter(Boolean)
    .join(', ');
