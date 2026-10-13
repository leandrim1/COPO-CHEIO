// Formato dos dados que a API devolve (tabelas do Neon: ver db/migrations).
import type { IceChoice } from './ice';

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
  // Os produtos desta categoria só são pedidos com a escolha do gelo (gelo normal ou de sabor).
  ice_choice_required?: boolean;
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
  // Janela da promoção (vazio = sem limite de data).
  promo_starts_at?: string | null;
  promo_ends_at?: string | null;
  // Combos: o energético que vem no produto (base da troca de energético com diferença de preço). Vazio = não aceita troca.
  swap_base_product_id?: string | null;
  // Combos: o VALOR do energético que vem no combo (quando ele não é um produto do cardápio) e os energéticos que o cliente pode escolher
  // na troca (lista vazia = qualquer energético de 2L).
  swap_base_price?: number | null;
  swap_option_ids?: string[];
  created_at: string;
  updated_at: string;
};

// Onde o banner aparece: 'menu' = carrossel abaixo do título "Bebidas"; 'cover' = faixa azul do topo da página.
export type BannerPlacement = 'menu' | 'cover';

export type Banner = {
  id: string;
  placement: BannerPlacement;
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

// awaiting_payment: pedido de pagamento online que ainda não foi pago. A loja só o vê como "novo" depois que o pagamento é confirmado.
export type OrderStatus = 'awaiting_payment' | 'new' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
// pix_online: o cliente paga pelo site (QR Code ou copia e cola) e a operadora confirma; os outros três são pagos na entrega/retirada.
export type PaymentMethod = 'pix' | 'cash' | 'card' | 'pix_online';
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
  // Escolha do gelo (só nos produtos de categorias que pedem).
  ice_choice?: IceChoice | null;
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
  // Verificação em duas etapas ligada?
  two_factor?: boolean;
};

// Histórico de atividades do painel (só o owner vê).
export type AuditEntry = {
  id: number;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  summary: string;
  ip: string | null;
};

// Pedido de acesso, correção ou exclusão de dados (LGPD).
export type PrivacyRequest = {
  id: string;
  created_at: string;
  kind: 'access' | 'correction' | 'deletion' | 'other';
  name: string;
  contact: string;
  message: string | null;
  status: 'open' | 'done' | 'rejected';
  handled_by_name: string | null;
  handled_at: string | null;
  handled_note: string | null;
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
  items: { product_id?: string | null; product_name: string; quantity: number; unit_price: number; total_price: number; ice_choice?: IceChoice | null; swap_to_product_id?: string | null }[];
  history: { status: OrderStatus; at: string }[];
  // Resumo do pagamento online (só existe quando já houve uma cobrança). Os detalhes vêm de /api/tracking/:código/payment.
  payment?: { method: 'pix'; status: PaymentState; expires_at: string | null; paid_at: string | null; attempt: number };
};

// ---- Pagamento online (Pix) -----------------------------------------------------------------------------------------------------

// creating: gerando · pending: aguardando o cliente pagar · paid: confirmado · expired: venceu · cancelled · failed · refunded: estornado
export type PaymentState = 'creating' | 'pending' | 'paid' | 'expired' | 'cancelled' | 'failed' | 'refunded';

// O pagamento como o cliente vê (GET e POST /api/tracking/:código/payment). Nunca traz comissão, tarifas nem códigos da operadora.
export type PaymentView = {
  id: string;
  status: PaymentState;
  method: 'pix';
  amount: number;
  attempt: number;
  expires_at: string | null;
  // O Pix "copia e cola": só enquanto aguarda o pagamento.
  pix: { payload: string } | null;
  can_retry: boolean;
  retry_until: string | null;
  message: string | null;
};

export type CustomerPayment = { payment: PaymentView | null; order_status: OrderStatus; payment_status: PaymentStatus };

// Painel: uma cobrança. Todo administrador vê a situação; só o owner recebe comissão, tarifas e códigos da operadora (os campos opcionais).
// calculated: só calculada · confirmed: a operadora confirmou o repasse · failed: o repasse falhou · not_applicable: sem divisão
export type CommissionState = 'calculated' | 'confirmed' | 'failed' | 'not_applicable';
export type AdminPayment = {
  id: string;
  order_id: string;
  order_number: number;
  attempt: number;
  method: 'pix';
  status: PaymentState;
  amount_cents: number;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
  needs_attention: boolean;
  attention_reason?: string | null;
  provider?: string;
  provider_charge_id?: string | null;
  provider_status?: string | null;
  commission_bps?: number;
  commission_cents?: number;
  commission_state?: CommissionState;
  commission_confirmed_cents?: number | null;
  fee_cents?: number | null;
  net_cents?: number | null;
  refunded_cents?: number;
  checked_at?: string | null;
  closed_at?: string | null;
  last_error?: string | null;
};

export type MerchantAccount = {
  id: string;
  provider: string;
  kind: 'pf' | 'pj' | null;
  status: 'draft' | 'submitted' | 'pending' | 'approved' | 'rejected' | 'duplicate' | 'error' | 'suspended';
  status_detail: string | null;
  proposal_id: string | null;
  provider_account_id: string | null;
  // A operadora não respondeu ao enviar o cadastro: ele PODE ter sido criado (e cobrado).
  ambiguous?: boolean;
  authorized_at: string | null;
  fees_acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PaymentsOverview = {
  payments: AdminPayment[];
  has_more: boolean;
  summary: {
    pending: number;
    paid: number;
    expired: number;
    failed: number;
    refunded: number;
    attention: number;
    paid_cents: number;
    commission_calculated_cents: number;
    commission_confirmed_cents: number;
    commission_waiting_cents: number;
    commission_failed_cents: number;
    fee_cents: number;
  };
  // Taxa atual da comissão, em pontos-base (200 = 2%); vem do banco.
  commission_bps: number;
  merchant: MerchantAccount | null;
  provider: {
    configured: boolean;
    name: string | null;
    environment: 'sandbox' | 'production' | null;
    // Só os NOMES das variáveis de ambiente que faltam (nunca valores).
    missing: string[];
    note: string | null;
    manages_accounts: boolean;
  };
  // Tarifa de criação de uma conta nova, em centavos (0 no sandbox; null: a operadora não informa).
  account_fee_cents: number | null;
  readiness: { provider: string | null; merchant: string | null; ready: boolean };
  method: { code: 'pix_online'; label: string; enabled: boolean } | null;
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
