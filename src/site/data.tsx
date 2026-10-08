import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { DEFAULT_HERO, DEFAULT_LOGO, DEFAULT_PAYMENTS, DEFAULT_SITE, DEFAULT_STORE } from '../lib/defaults';
import { isOpenNow } from '../lib/hours';
import type { Banner, Category, DeliveryZone, HeroSettings, PaymentOption, SiteSettings, StoreSettings } from '../lib/types';

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
};

export const unitPrice = (p: Product) => p.promoPrice ?? p.price;
export const OTHER_CATEGORY = 'Outros';

type ShopData = {
  store: StoreSettings;
  site: SiteSettings;
  hero: HeroSettings;
  products: Product[];
  banners: Banner[];
  zones: DeliveryZone[];
  payments: PaymentOption[];
};

const CACHE_KEY = 'copocheio:site-v2';
const EMPTY: ShopData = { store: DEFAULT_STORE, site: DEFAULT_SITE, hero: DEFAULT_HERO, products: [], banners: [], zones: [], payments: DEFAULT_PAYMENTS };

function readCache(): ShopData | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as ShopData | null;
    return parsed && parsed.store && parsed.site && parsed.hero && Array.isArray(parsed.products) ? { ...EMPTY, ...parsed } : null;
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
};

function toProducts(rows: ProductRowFromDb[], categories: Category[]): Product[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return rows
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

async function fetchShop(): Promise<ShopData> {
  const [catalog, content] = await Promise.all([
    api.get<{ categories: Category[]; products: ProductRowFromDb[] }>('/api/products'),
    api.get<{ store: StoreSettings; site: SiteSettings; hero: HeroSettings; banners: Banner[]; zones: DeliveryZone[]; payments: PaymentOption[] }>('/api/site'),
  ]);
  const visibleCategories = new Set(catalog.categories.map((c) => c.id));
  return {
    store: { ...DEFAULT_STORE, ...content.store },
    site: { ...DEFAULT_SITE, ...content.site },
    hero: { ...DEFAULT_HERO, ...content.hero },
    products: toProducts(
      catalog.products.filter((p) => !p.category_id || visibleCategories.has(p.category_id)),
      catalog.categories,
    ),
    banners: content.banners,
    zones: content.zones,
    payments: content.payments.length ? content.payments : DEFAULT_PAYMENTS,
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

  const refresh = useCallback(async () => {
    lastFetch.current = Date.now();
    try {
      const data = await fetchShop();
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

export type CartLine = { product: Product; qty: number };

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

  // Depois de carregar o cardápio, tira o que não está mais nele.
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
      /* modo privado: o pedido só não fica guardado */
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
  const total = lines.reduce((sum, line) => sum + line.qty * unitPrice(line.product), 0);
  const unavailable = lines.filter((line) => line.product.soldOut);

  return { cart, setQty, clear, lines, count, total, unavailable };
}

// ---- Contexto ---------------------------------------------------------------------------------

type Shop = ShopData & {
  // ready: o cardápio já veio da API (ou da cópia salva) e pode ser mostrado.
  ready: boolean;
  fresh: boolean;
  failed: boolean;
  refresh: () => Promise<void>;
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
