// Monta a mensagem de um tipo "enfileirável" a partir da receita (`spec`) guardada no registro. É por aqui que uma nova tentativa
// refaz o e-mail sem que nenhum segredo precise ter ficado no banco: a receita só tem ids e dados sem segredo (nome, data, aparelho).
import { one, query } from '../db.js';
import { UUID } from '../http.js';
import { loadBrand } from '../mailBrand.js';
import type { Brand } from '../mailBrand.js';
import type { Message } from '../mail.js';
import { adminResetLinkNoticeMessage, alreadyRegisteredMessage, newAdminLoginMessage, passwordChangedMessage } from '../mailTemplates.js';
import { hashToken, trackingTokenFromKey } from '../tracking.js';
import { describeAlert } from './alertText.js';
import { isKind } from './kinds.js';
import { isEmptyState, readOpsState } from '../opsState.js';
import type { KindName } from './kinds.js';
import { ensurePreferences, preferenceToken } from './preferences.js';
import { alertMessage, campaignMessage, opsAlertMessage, orderMessage } from './templates.js';
import type { OrderKind } from './templates.js';

export type RenderInput = { kind: string; to: string | null; spec: Record<string, unknown> | null };

const text = (value: unknown, max = 120): string => (typeof value === 'string' ? value.slice(0, max) : '');
const when = (value: unknown): Date => {
  const d = new Date(typeof value === 'string' ? value : NaN);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

// Posição de cada etapa do pedido: e-mail de uma etapa que o pedido já deixou para trás não faz mais sentido (a mensagem fica na fila
// por causa de uma falha do servidor de e-mail e, quando sai, o pedido já avançou).
const STAGE: Record<string, number> = { new: 0, confirmed: 1, preparing: 2, out_for_delivery: 3, delivered: 4, cancelled: 99 };
// Não envia o e-mail do tipo se o pedido já está nesta etapa ou além dela.
const OBSOLETE_AT: Partial<Record<OrderKind, number>> = { order_received: 3, order_confirmed: 3, order_out_for_delivery: 4 };

type OrderRow = {
  order_number: number;
  customer_name: string;
  delivery_type: 'delivery' | 'pickup';
  neighborhood: string | null;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  payment_method: string;
  payment_status: 'pending' | 'paid' | 'refunded';
  order_status: string;
  idempotency_key: string | null;
  payment_label: string | null;
};

// Link do acompanhamento: o código é DERIVADO da chave de idempotência do pedido (o mesmo cálculo do checkout), então não precisa estar
// guardado em lugar nenhum. Só vale se o código existe mesmo (pedido antigo sem chave, ou chave de outra senha de banco: link genérico).
async function trackingUrl(brand: Brand, orderId: string, key: string | null): Promise<string> {
  if (key && /^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    const token = trackingTokenFromKey(key);
    const found = await one<{ id: string | null }>('select order_id_for_token($1) as id', [hashToken(token)]);
    if (found?.id === orderId) return `${brand.siteUrl}/acompanhar-pedido/${token}`;
  }
  return `${brand.siteUrl}/acompanhar-pedido`;
}

async function renderOrder(kind: OrderKind, to: string, spec: Record<string, unknown>, brand: Brand): Promise<Message | null> {
  const orderId = text(spec.order_id, 40);
  if (!UUID.test(orderId)) return null;
  const o = await one<OrderRow>(
    `select o.order_number, o.customer_name, o.delivery_type, o.neighborhood, o.subtotal, o.delivery_fee, o.discount, o.total, o.payment_method, o.payment_status,
            o.order_status, o.idempotency_key, pm.label as payment_label
       from orders o left join payment_methods pm on pm.code = o.payment_method where o.id = $1`,
    [orderId],
  );
  if (!o) return null;
  const stage = STAGE[o.order_status] ?? 0;
  const limit = OBSOLETE_AT[kind];
  if ((limit !== undefined && stage >= limit) || (o.order_status === 'cancelled' && kind !== 'order_cancelled' && kind !== 'payment_refunded')) return null;
  const items = await query<{ quantity: number; product_name: string; total_price: number; ice_choice: string | null; ice_flavors: { name: string; quantity: number }[] | null }>(
    'select quantity, product_name, total_price, ice_choice, ice_flavors from order_items where order_id = $1 order by created_at, product_name, ice_choice nulls first',
    [orderId],
  );
  const prefs = await ensurePreferences(to);
  return orderMessage(brand, {
    kind,
    to,
    name: o.customer_name,
    number: o.order_number,
    lines: items.map((i) => ({
      qty: i.quantity,
      // Combo com gelos saborizados: os sabores escolhidos vão no nome da linha ("— gelos: 2 × Morango, 1 × Limão").
      name: `${i.product_name}${i.ice_choice === 'normal' ? ' (gelo normal)' : i.ice_choice === 'flavored' ? ' (gelo de sabor)' : ''}${
        i.ice_flavors?.length ? ` — gelos: ${i.ice_flavors.map((f) => `${f.quantity} × ${f.name}`).join(', ')}` : ''
      }`,
      total: Number(i.total_price),
    })),
    subtotal: Number(o.subtotal),
    deliveryFee: Number(o.delivery_fee),
    discount: Number(o.discount),
    total: Number(o.total),
    delivery: o.delivery_type,
    neighborhood: o.neighborhood,
    paymentLabel: o.payment_label ?? o.payment_method,
    paymentStatus: o.payment_status,
    trackUrl: await trackingUrl(brand, orderId, o.idempotency_key),
    prefsUrl: `${brand.siteUrl}/conta/emails/${preferenceToken(prefs)}`,
  });
}

async function renderCampaign(kind: 'campaign' | 'campaign_test', to: string, spec: Record<string, unknown>, brand: Brand): Promise<Message | null> {
  const id = text(spec.campaign_id, 40);
  if (!UUID.test(id)) return null;
  const c = await one<{ subject: string; preheader: string | null; title: string; body: string; cta_label: string | null; cta_url: string | null; status: string }>(
    'select subject, preheader, title, body, cta_label, cta_url, status from email_campaigns where id = $1',
    [id],
  );
  // Campanha cancelada (ou que não está sendo enviada): o que sobrou na fila não sai.
  if (!c || (kind === 'campaign' && c.status !== 'sending')) return null;
  const prefs = await ensurePreferences(to);
  const token = preferenceToken(prefs);
  return campaignMessage(brand, {
    to,
    subject: c.subject,
    preheader: c.preheader,
    title: c.title,
    body: c.body,
    ctaLabel: c.cta_label,
    ctaUrl: c.cta_url,
    preferencesUrl: `${brand.siteUrl}/conta/emails/${token}`,
    oneClickUrl: `${brand.siteUrl}/api/email/unsubscribe/${token}`,
    sample: spec.sample === true || kind === 'campaign_test',
  });
}

async function renderAlert(to: string, spec: Record<string, unknown>, brand: Brand): Promise<Message | null> {
  const codes = Array.isArray(spec.codes) ? spec.codes.filter((c): c is string => typeof c === 'string').slice(0, 10) : [];
  if (!codes.length) return null;
  const rows = await query<{ code: string; severity: 'info' | 'warning' | 'critical'; detail: Record<string, unknown> | null }>(
    'select code, severity, detail from email_alerts where code = any($1::text[]) and resolved_at is null',
    [codes],
  );
  // Todos os alertas já se resolveram sozinhos: não há o que avisar.
  if (!rows.length) return null;
  return alertMessage(brand, {
    to,
    name: text(spec.name),
    alerts: rows.map((r) => ({ severity: r.severity, ...describeAlert(r.code, r.detail ?? {}) })),
    panelUrl: `${brand.siteUrl}/admin/emails`,
  });
}

// Estoque baixo/esgotado e rotina automática: o conteúdo é lido AGORA (na hora de enviar, inclusive numa nova tentativa); se tudo já voltou ao normal, não há o que avisar.
async function renderOps(to: string, spec: Record<string, unknown>, brand: Brand): Promise<Message | null> {
  const state = await readOpsState();
  if (isEmptyState(state)) return null;
  const when = (iso: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso));
  return opsAlertMessage(brand, {
    to,
    name: text(spec.name),
    low: state.low,
    out: state.out,
    job: state.job ? { problem: state.job.problem, lastRun: when(state.job.lastRunAt), detail: state.job.detail } : null,
    stockUrl: `${brand.siteUrl}/admin/estoque`,
    systemUrl: `${brand.siteUrl}/admin/configuracoes`,
  });
}

// Devolve a mensagem pronta, ou null quando não há mais o que enviar (destinatário esquecido, pedido apagado, etapa que já passou...): a
// mensagem é cancelada.
export async function renderMessage(input: RenderInput, req: Request): Promise<Message | null> {
  if (!input.to || !isKind(input.kind)) return null;
  const kind: KindName = input.kind;
  const spec = input.spec ?? {};
  const brand = await loadBrand(req);
  switch (kind) {
    case 'already_registered':
      return alreadyRegisteredMessage(brand, { to: input.to, name: text(spec.name), loginUrl: `${brand.siteUrl}/conta` });
    case 'password_changed':
      return passwordChangedMessage(brand, { to: input.to, name: text(spec.name), loginUrl: `${brand.siteUrl}/conta`, when: when(spec.at) });
    case 'admin_reset_notice':
      return adminResetLinkNoticeMessage(brand, { to: input.to, name: text(spec.name), when: when(spec.at), loginUrl: `${brand.siteUrl}/conta` });
    case 'admin_new_login':
      return newAdminLoginMessage(brand, { to: input.to, name: text(spec.name), when: when(spec.at), device: text(spec.device, 80) || 'Navegador não identificado', ip: text(spec.ip, 64), panelUrl: `${brand.siteUrl}/admin` });
    case 'order_received':
    case 'order_confirmed':
    case 'order_out_for_delivery':
    case 'order_delivered':
    case 'order_cancelled':
    case 'payment_confirmed':
    case 'payment_refunded':
      return renderOrder(kind, input.to, spec, brand);
    case 'campaign':
    case 'campaign_test':
      return renderCampaign(kind, input.to, spec, brand);
    case 'deliverability_alert':
      return renderAlert(input.to, spec, brand);
    case 'ops_alert':
      return renderOps(input.to, spec, brand);
    default:
      // verification, password_reset e mail_test têm segredo ou são montados por quem chama: nada a refazer aqui.
      return null;
  }
}
