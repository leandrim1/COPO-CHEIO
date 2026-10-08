import type { HeroSettings, PaymentOption, SiteSettings, StoreSettings } from './types';

// O mesmo conteúdo inicial de db/migrations/0003_initial_content.sql. Só aparece enquanto os dados do
// banco não chegaram (ou se a API estiver fora do ar): o painel é a fonte.

const weekday = { open: true, start: '09:00', end: '23:00' };
const closed = { open: false, start: '09:00', end: '23:00' };

export const DEFAULT_STORE: StoreSettings = {
  store_name: 'Copo Cheio',
  tagline: 'Disk Bebidas',
  whatsapp: null,
  instagram: 'copocheiodisk',
  address: null,
  cep: null,
  city: null,
  state: null,
  opening_hours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: closed, sun: closed },
  timezone: 'America/Sao_Paulo',
  orders_paused: false,
  delivery_enabled: true,
  pickup_enabled: true,
  delivery_fee: 5,
  min_order: 0,
  delivery_time: '30 a 45 min',
};

export const DEFAULT_SITE: SiteSettings = {
  logo_url: null,
  bebidas_title: 'Bebidas para deixar seu momento ainda melhor',
  bebidas_highlight: 'ainda melhor',
  bebidas_subtitle: 'Escolha sua bebida favorita. A gente entrega gelada e rapidinho na sua casa.',
  featured_title: 'Os favoritos da galera',
  featured_limit: 4,
  contato_title: 'Fale com a Copo Cheio',
  contato_highlight: 'Copo Cheio',
  contato_subtitle: 'Precisa de ajuda com seu pedido? Estamos prontos para atender você.',
  cta_title: 'Deu sede?',
  cta_highlight: 'sede?',
  cta_subtitle: 'Peça agora e receba sua bebida bem gelada.',
  cta_button: 'PEDIR AGORA',
  seo_title: 'COPO CHEIO – Disk Bebidas',
  seo_description: 'COPO CHEIO – Disk Bebidas. Bebidas bem geladas, variedade e entrega rápida na sua casa.',
  og_image_url: null,
  favicon_url: null,
};

export const DEFAULT_HERO: HeroSettings = {
  title: 'Sua bebida gelada chega até você.',
  title_highlight: 'bebida gelada',
  subtitle: 'Bebidas bem geladas, variedade e rapidez para deixar qualquer momento muito melhor.',
  primary_button_text: 'Pedir agora',
  secondary_button_text: 'Ver bebidas',
  show_secondary_button: true,
  badge_text: 'GELADA • RÁPIDA • NA SUA CASA',
  show_badge: true,
  images: [],
};

export const DEFAULT_PAYMENTS: PaymentOption[] = [
  { code: 'pix', label: 'PIX', details: null },
  { code: 'cash', label: 'Dinheiro', details: null },
  { code: 'card', label: 'Cartão na entrega', details: null },
];

export const DEFAULT_LOGO = '/logo.png';
