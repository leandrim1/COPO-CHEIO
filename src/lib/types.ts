// Formato das tabelas do Supabase (ver supabase/migrations).

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type DayHours = { open: boolean; start: string; end: string };
export type OpeningHours = Record<DayKey, DayHours>;

export type StoreSettings = {
  store_name: string;
  tagline: string;
  whatsapp: string | null;
  instagram: string | null;
  address: string | null;
  cep: string | null;
  city: string | null;
  state: string | null;
  opening_hours: OpeningHours;
  timezone: string;
  orders_paused: boolean;
  delivery_enabled: boolean;
  pickup_enabled: boolean;
  delivery_fee: number;
  min_order: number;
  delivery_time: string | null;
  pix_enabled: boolean;
  cash_enabled: boolean;
  card_enabled: boolean;
  pix_key: string | null;
  updated_at?: string;
};

export type SiteSettings = {
  logo_url: string | null;
  logo_path: string | null;
  bebidas_title: string;
  bebidas_highlight: string | null;
  bebidas_subtitle: string | null;
  featured_title: string;
  featured_limit: number;
  contato_title: string;
  contato_highlight: string | null;
  contato_subtitle: string | null;
  cta_title: string;
  cta_highlight: string | null;
  cta_subtitle: string | null;
  cta_button: string;
  seo_title: string;
  seo_description: string | null;
  og_image_url: string | null;
  og_image_path: string | null;
  favicon_url: string | null;
  favicon_path: string | null;
  updated_at?: string;
};

export type HeroSettings = {
  title: string;
  title_highlight: string | null;
  subtitle: string | null;
  primary_button_text: string;
  secondary_button_text: string;
  show_secondary_button: boolean;
  badge_text: string;
  show_badge: boolean;
  images: string[];
  updated_at?: string;
};

export type Category = {
  id: string;
  name: string;
  position: number;
  active: boolean;
  created_at?: string;
};

export type ProductRecord = {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  promo_price: number | null;
  image_url: string | null;
  image_path: string | null;
  sku: string | null;
  stock: number | null;
  featured: boolean;
  active: boolean;
  sold_out: boolean;
  position: number;
  created_at: string;
  updated_at: string;
};

export type Banner = {
  id: string;
  title: string | null;
  subtitle: string | null;
  image_desktop_url: string | null;
  image_desktop_path?: string | null;
  image_mobile_url: string | null;
  image_mobile_path?: string | null;
  button_text: string | null;
  link: string | null;
  active: boolean;
  position: number;
};

export type DeliveryZone = {
  id: string;
  name: string;
  fee: number;
  active: boolean;
  position: number;
};

export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
export type PaymentMethod = 'pix' | 'cash' | 'card';
export type PaymentStatus = 'pending' | 'paid' | 'refunded';
export type DeliveryType = 'delivery' | 'pickup';

export type Order = {
  id: string;
  order_number: number;
  public_token: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  delivery_type: DeliveryType;
  address: string | null;
  address_number: string | null;
  neighborhood: string | null;
  complement: string | null;
  reference: string | null;
  notes: string | null;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  payment_method: PaymentMethod;
  change_for: number | null;
  payment_status: PaymentStatus;
  order_status: OrderStatus;
  created_at: string;
  updated_at: string;
};

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
};

export type StatusChange = {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by_name: string | null;
  created_at: string;
};

export type AdminUser = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin';
  active: boolean;
  created_at: string;
};

// O pedido como o cliente vê (função get_public_order / create_order).
export type PublicOrder = {
  token: string;
  order_number: number;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod;
  change_for: number | null;
  delivery_type: DeliveryType;
  customer_name: string;
  address: string | null;
  address_number: string | null;
  neighborhood: string | null;
  complement: string | null;
  reference: string | null;
  notes: string | null;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  created_at: string;
  items: { product_name: string; quantity: number; unit_price: number; total_price: number }[];
  history: { status: OrderStatus; at: string }[];
};
