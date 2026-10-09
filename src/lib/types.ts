// Formato dos dados que a API devolve (tabelas do Neon: ver db/migrations).

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
  tracking_retention_days: number;
  updated_at?: string;
};

export type SiteSettings = {
  logo_url: string | null;
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
  favicon_url: string | null;
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
  image_mobile_url: string | null;
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
  customer_id: string | null;
  customer_linked_at: string | null;
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

// Forma de pagamento como o site mostra (só as ativas) e como o painel edita.
export type PaymentOption = {
  code: PaymentMethod;
  label: string;
  // PIX: a chave que o cliente vê depois do pedido.
  details: string | null;
  enabled?: boolean;
};

export type AdminAccount = {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin';
  active: boolean;
  last_login_at: string | null;
  created_at: string;
};

// O pedido como o cliente vê (POST /api/orders, GET /api/tracking/:código e /api/account/orders/:número).
// Nunca traz telefone, e-mail, ids internos nem o código de acompanhamento.
export type PublicOrder = {
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
  updated_at: string;
  // Já está na conta de algum cliente?
  linked: boolean;
  // Por quantos dias, depois da última atualização, o link continua valendo.
  retention_days: number;
  // product_id só vem para o dono da conta (para "pedir de novo").
  items: { product_id?: string | null; product_name: string; quantity: number; unit_price: number; total_price: number }[];
  history: { status: OrderStatus; at: string }[];
};

// Conta do cliente (opcional).
export type CustomerAccount = {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string | null;
  address_number: string | null;
  neighborhood: string | null;
  complement: string | null;
  reference: string | null;
};

export type AccountOrderSummary = {
  order_number: number;
  order_status: OrderStatus;
  payment_status: PaymentStatus;
  payment_method: PaymentMethod;
  delivery_type: DeliveryType;
  total: number;
  created_at: string;
  updated_at: string;
  summary: string | null;
};

// Situação da conta: só "active" entra. "pending_verification" ainda não provou acesso ao e-mail.
export type AccountStatus = 'active' | 'pending_verification' | 'disabled';

// Resposta do cadastro (202) e do login de uma conta cujo e-mail ainda não foi confirmado (403 "email_not_verified").
export type VerificationInfo = {
  email: string;
  email_masked: string;
  resend_in: number;
  code_minutes: number;
};

// Painel: contas de clientes.
export type CustomerRow = {
  id: string;
  name: string;
  email: string;
  phone: string;
  active: boolean;
  status: AccountStatus;
  email_verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
  orders: number;
};

export type TrackingLinkInfo = { id: string; source: 'checkout' | 'admin' | 'legacy'; created_at: string; revoked_at: string | null; created_by_name: string | null };
