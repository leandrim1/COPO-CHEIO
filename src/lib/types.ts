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
  // Frete grátis na entrega a partir de um subtotal (já com o desconto do cupom). Desligado por padrão.
  free_delivery_enabled: boolean;
  free_delivery_min: number;
  // Agendamento de pedidos ligado? (as faixas de horário vêm de GET /api/schedule)
  scheduling_enabled: boolean;
  // Só o painel recebe estes (antecedência mínima, dias à frente, tamanho da faixa e pedidos por faixa).
  schedule_lead_minutes?: number;
  schedule_max_days?: number;
  schedule_slot_minutes?: number;
  schedule_slot_capacity?: number | null;
  // Estoque baixo: até quantas unidades o produto aparece como "baixo" (cada produto pode ter o seu).
  low_stock_default?: number;
  // Dias especiais (feriado fechado ou horário especial) dos próximos dias, para o site saber se está aberto.
  exceptions: StoreException[];
  delivery_time: string | null;
  tracking_retention_days: number;
  updated_at?: string;
};

export type StoreException = { day: string; kind: 'closed' | 'custom'; start_time: string | null; end_time: string | null; reason?: string | null };

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
  // Miniaturas da mesma foto (400 px e 720 px de largura), geradas pelo painel; vazias = só a foto original (migration 0025).
  image_sm_url?: string | null;
  image_md_url?: string | null;
  sku: string | null;
  stock: number | null;
  featured: boolean;
  active: boolean;
  sold_out: boolean;
  position: number;
  // Aviso de estoque baixo deste produto (vazio = vale o padrão da loja).
  low_stock_threshold?: number | null;
  // Janela da promoção (vazio = sem limite de data).
  promo_starts_at?: string | null;
  promo_ends_at?: string | null;
  // Combos: o energético que vem no produto (base da troca de energético com diferença de preço). Vazio = não aceita troca.
  swap_base_product_id?: string | null;
  // Combos: o VALOR do energético que vem no combo (quando ele não é um produto do cardápio) e os energéticos que o cliente pode escolher
  // na troca (lista vazia = qualquer energético de 2L).
  swap_base_price?: number | null;
  swap_option_ids?: string[];
  // Quem pede este produto precisa escolher o gelo (gelo normal ou de sabor). Cada produto liga a sua no painel; a categoria não decide.
  ice_choice_required?: boolean;
  // Gelos saborizados: o produto é um gelo saborizado (aparece na escolha dos combos) e, nos combos, quantos gelos saborizados vêm nele (0 = nenhum).
  flavored_ice?: boolean;
  combo_ice_count?: number;
  // Bebida alcoólica (migration 0027): o pedido com ela exige a declaração de maioridade e a conferência do documento na entrega. Ausente = sim.
  alcoholic?: boolean;
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

export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'out_for_delivery' | 'delivered' | 'cancelled';
// Todas as formas são pagas à loja: o Pix da loja (chave), o dinheiro e o cartão na entrega ou na retirada.
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
  // Maioridade (migration 0027): o pedido tem bebida alcoólica (o documento com foto é conferido na entrega); quando o cliente declarou ter 18 anos ou
  // mais e qual versão do texto viu; quem conferiu o documento e quando (só o fato da conferência: nenhum dado do documento é guardado).
  age_required?: boolean;
  age_declared_at?: string | null;
  age_declaration_version?: string | null;
  // Cupom do pedido (código gravado no pedido) e a taxa de entrega que deixou de ser cobrada.
  coupon_code?: string | null;
  delivery_fee_waived?: number | string | null;
  // Pedido agendado: o início da faixa escolhida pelo cliente (vazio = o quanto antes).
  scheduled_for?: string | null;
  // Entregador do pedido (nome gravado no pedido) e o id dele.
  courier_id?: string | null;
  courier_name?: string | null;
  age_checked_at?: string | null;
  age_checked_by_name?: string | null;
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
  // Escolha do gelo (só nos produtos que pedem).
  ice_choice?: IceChoice | null;
  // Gelos saborizados escolhidos nesta linha de combo (por unidade do combo); null nos demais itens.
  ice_flavors?: IceFlavor[] | null;
};

export type StatusChange = {
  id: string;
  order_id: string;
  from_status: OrderStatus | null;
  to_status: OrderStatus;
  changed_by_name: string | null;
  // Motivo da mudança (cancelamento pelo cliente ou entrega recusada), quando há.
  reason?: string | null;
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
  // Cupom usado no pedido (código) e a taxa de entrega que deixou de ser cobrada (cupom de entrega grátis ou frete grátis por valor). Só vêm quando existem.
  coupon_code?: string;
  delivery_fee_waived?: number;
  scheduled_for?: string;
  // Entregador (só o primeiro nome, só enquanto o pedido está a caminho).
  courier_name?: string;
  total: number;
  created_at: string;
  updated_at: string;
  // Já está na conta de algum cliente?
  linked: boolean;
  // Pedido com bebida alcoólica: o documento com foto será conferido na entrega ou na retirada (migration 0027).
  age_check_required?: boolean;
  // O cliente pode cancelar agora? `why` (quando não pode): cancelled · final (já entregue) · in_progress (a loja já confirmou: só ela cancela) ·
  // paid (o pagamento já foi marcado como recebido: a devolução é combinada com a loja).
  cancel?: { allowed: boolean; why: 'cancelled' | 'final' | 'in_progress' | 'paid' | null };
  // Por quantos dias, depois da última atualização, o link continua valendo.
  retention_days: number;
  // product_id só vem para o dono da conta (para "pedir de novo").
  items: { product_id?: string | null; product_name: string; quantity: number; unit_price: number; total_price: number; ice_choice?: IceChoice | null; swap_to_product_id?: string | null; ice_flavors?: IceFlavor[] | null }[];
  history: { status: OrderStatus; at: string }[];
};

// Os gelos saborizados escolhidos numa linha de combo (por unidade do combo): nome da hora do pedido e quantidade (product_id só para a própria conta).
export type IceFlavor = { product_id?: string | null; name: string; quantity: number };
export type Courier = { id: string; name: string; phone: string | null; active: boolean; on_route?: number };
export type ReviewRow = { id: string; rating: number; comment: string | null; status: 'pending' | 'published' | 'hidden'; created_at: string; moderated_at: string | null; order_number: number; customer_name: string };

// Cupom de desconto (painel, só o owner). `used` = pedidos que usaram o cupom e não foram cancelados.
export type CouponKind = 'percent' | 'fixed' | 'free_delivery';
export type Coupon = {
  id: string;
  code: string;
  description: string | null;
  kind: CouponKind;
  value: number | string;
  max_discount: number | string | null;
  min_order: number | string;
  starts_at: string | null;
  ends_at: string | null;
  usage_limit: number | null;
  per_customer_limit: number | null;
  excludes_promo: boolean;
  active: boolean;
  created_at: string;
  used: number;
  category_ids: string[];
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

// ---- Painel: E-mails e Entregabilidade ----------------------------------------------------------------------------------------------
export type EmailStatus = 'queued' | 'sending' | 'accepted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'blocked' | 'cancelled';
export type EmailCategory = 'transactional' | 'promotional';
export type EmailCounts = { total: number; queued: number; accepted: number; delivered: number; delayed: number; bounced: number; complained: number; failed: number; blocked: number; cancelled: number };
export type EmailAlertSeverity = 'info' | 'warning' | 'critical';
export type EmailAlert = { code: string; severity: EmailAlertSeverity; opened_at: string; last_seen_at: string; last_notified_at: string | null; title: string; detail: string; hint: string; data: Record<string, unknown> | null };
export type EmailKindInfo = { kind: string; label: string; category: EmailCategory };

export type EmailOverview = {
  generated_at: string;
  period_days: number;
  kinds: EmailKindInfo[];
  transport: {
    name: 'smtp' | 'resend';
    label: string;
    capabilities: { acceptance: boolean; delivery: boolean; bounces: boolean; complaints: boolean; opens: boolean; clicks: boolean };
    configured: boolean;
    missing: string[];
    host: string | null;
    from_name: string | null;
    from_email: string | null;
    from_domain: string | null;
    free_sender: boolean;
    order_notices_paused: boolean;
  };
  totals: EmailCounts;
  by_category: Partial<Record<EmailCategory, Omit<EmailCounts, never>>>;
  by_kind: (EmailCounts & { kind: string; label: string; category: EmailCategory | null })[];
  by_day: { day: string; total: number; ok: number; failed: number; blocked: number }[];
  top_domains: { domain: string; total: number; failed: number; rejected: number }[];
  rates: { accepted_percent: number | null; delivered_percent: number | null; bounced_percent: number | null; complaint_percent: number | null };
  budget: { limit: number; used: number | null; promo_limit: number; promo_used: number };
  queue: { queued: number; due: number; oldest_due_minutes: number | null; sending: number };
  suppressions: Record<string, number>;
  consent: { marketing: number; pending: number; unsubscribed: number };
  webhook: { applicable: boolean; configured: boolean; last_ok_at: string | null; last_error_at: string | null; last_error: string | null; ok_count: number; error_count: number; last_event_at: string | null };
  alerts: EmailAlert[];
};

export type EmailMessageRow = {
  id: string;
  created_at: string;
  kind: string;
  kind_label: string;
  category: EmailCategory;
  audience: 'customer' | 'staff';
  recipient_email: string | null;
  recipient_domain: string | null;
  subject: string | null;
  status: EmailStatus;
  transport: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  opens: number;
  clicks: number;
  bounce_type: string | null;
  error_kind: string | null;
  error_code: string | null;
  error_detail: string | null;
  block_reason: string | null;
  block_label: string | null;
  campaign_id: string | null;
  order_number: number | null;
  // Só no detalhe:
  message_id?: string | null;
  provider_id?: string | null;
  can_retry?: boolean;
};

export type EmailEvent = { id: string; provider: string; type: string; occurred_at: string; received_at: string; detail: Record<string, unknown> | null };
export type EmailSuppression = { email: string; reason: 'hard_bounce' | 'complaint' | 'repeated_soft' | 'manual'; source: 'smtp' | 'webhook' | 'admin'; detail: string | null; created_at: string; expires_at: string | null };

export type EmailCampaignStatus = 'draft' | 'sending' | 'done' | 'cancelled';
export type EmailCampaign = {
  id: string;
  created_at: string;
  created_by_name: string | null;
  name: string;
  subject: string;
  status: EmailCampaignStatus;
  audience_total: number | null;
  started_at: string | null;
  finished_at: string | null;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  // Só no detalhe:
  preheader?: string | null;
  title?: string;
  body?: string;
  cta_label?: string | null;
  cta_url?: string | null;
};

export type DnsFinding = { level: 'ok' | 'info' | 'warning' | 'error'; text: string };
export type DnsReport =
  | { applicable: false; domain: string; reason: string }
  | {
      applicable: true;
      domain: string;
      checked_at: string;
      status: 'ok' | 'attention' | 'problem' | 'unknown';
      spf: { record: string | null; findings: DnsFinding[] };
      dkim: { found: { selector: string; via: 'txt' | 'cname' }[]; tried: string[]; findings: DnsFinding[] };
      dmarc: { record: string | null; policy: string | null; findings: DnsFinding[] };
      mx: { hosts: string[]; findings: DnsFinding[] };
    };

// Preferências de e-mail (página do link do e-mail e "Minha conta").
export type EmailPreferences = { marketing: boolean; notify_orders: boolean; consent_text: string; can_enable_marketing?: boolean; email_masked?: string };
