// Preferências de e-mail por endereço: consentimento para promoções e "não quero e-mails sobre pedidos".
//
// • Promoções só saem para quem consentiu (e o dono do e-mail provou que lê a caixa: conta confirmada). O consentimento fica registrado
//   com data, origem e a versão do texto que a pessoa viu.
// • O link de preferências/descadastro de cada endereço é "<id>.<chave>" (chave aleatória de 128 bits guardada no banco): não depende de
//   nenhuma variável de ambiente, então continua valendo em e-mails antigos mesmo se a senha do banco for trocada.
import { timingSafeEqual } from 'node:crypto';
import { one, query } from '../db.js';

// Texto mostrado ao lado da caixa de consentimento. Ao mudar o texto, troque a versão (fica gravada junto de cada consentimento).
export const CONSENT_TEXT_VERSION = 'v1';
export const CONSENT_TEXT = 'Quero receber novidades e promoções da Copo Cheio por e-mail. Posso cancelar quando quiser.';

export type Preferences = {
  id: string;
  email: string;
  link_key: string;
  marketing: boolean;
  marketing_consent_at: string | null;
  marketing_consent_source: string | null;
  marketing_pending_at: string | null;
  marketing_unsubscribed_at: string | null;
  notify_orders: boolean;
};

const COLUMNS = 'id, email, link_key, marketing, marketing_consent_at, marketing_consent_source, marketing_pending_at, marketing_unsubscribed_at, notify_orders';

export async function getPreferences(email: string): Promise<Preferences | null> {
  return one<Preferences>(`select ${COLUMNS} from email_preferences where email = $1`, [email]);
}

// Cria a linha do endereço se ainda não existe (é ela que dá o link de preferências). Nunca liga o consentimento.
export async function ensurePreferences(email: string): Promise<Preferences> {
  const row = await one<Preferences>(
    `insert into email_preferences (email) values ($1)
     on conflict (email) do update set updated_at = now()
     returning ${COLUMNS}`,
    [email],
  );
  return row!;
}

export const preferenceToken = (p: Pick<Preferences, 'id' | 'link_key'>): string => `${p.id}.${p.link_key}`;

const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{32})$/;

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Acha o endereço do link. Link inventado, adulterado ou de outro endereço: null (a resposta é a mesma para todos).
export async function preferencesByToken(token: unknown): Promise<Preferences | null> {
  const m = typeof token === 'string' ? TOKEN.exec(token) : null;
  if (!m) return null;
  const row = await one<Preferences>(`select ${COLUMNS} from email_preferences where id = $1`, [m[1]]);
  return row && sameKey(row.link_key, m[2]) ? row : null;
}

export type UnsubscribeVia = 'link' | 'one_click' | 'painel' | 'conta' | 'reclamacao';
export type ConsentSource = 'cadastro' | 'conta' | 'link' | 'painel';

// Liga ou desliga as promoções. Ligar só por ação do dono do e-mail (conta, link do próprio e-mail, confirmação do cadastro).
export async function setMarketing(email: string, on: boolean, via: { consent?: ConsentSource; unsubscribe?: UnsubscribeVia }): Promise<Preferences> {
  const row = on
    ? await one<Preferences>(
        `insert into email_preferences (email, marketing, marketing_consent_at, marketing_consent_source, marketing_consent_text, marketing_pending_at, marketing_unsubscribed_at, marketing_unsubscribed_via)
         values ($1, true, now(), $2, $3, null, null, null)
         on conflict (email) do update
           set marketing = true, marketing_consent_at = now(), marketing_consent_source = $2, marketing_consent_text = $3,
               marketing_pending_at = null, marketing_unsubscribed_at = null, marketing_unsubscribed_via = null
         returning ${COLUMNS}`,
        [email, via.consent ?? 'conta', CONSENT_TEXT_VERSION],
      )
    : await one<Preferences>(
        `insert into email_preferences (email, marketing, marketing_unsubscribed_at, marketing_unsubscribed_via)
         values ($1, false, now(), $2)
         on conflict (email) do update
           set marketing = false, marketing_pending_at = null, marketing_unsubscribed_at = now(), marketing_unsubscribed_via = $2
         returning ${COLUMNS}`,
        [email, via.unsubscribe ?? 'link'],
      );
  return row!;
}

export async function setNotifyOrders(email: string, on: boolean): Promise<Preferences> {
  const row = await one<Preferences>(
    `insert into email_preferences (email, notify_orders, notify_orders_changed_at) values ($1, $2, now())
     on conflict (email) do update set notify_orders = $2, notify_orders_changed_at = now()
     returning ${COLUMNS}`,
    [email, on],
  );
  return row!;
}

// Cadastro com a caixa marcada: ainda NÃO é consentimento (quem digitou o e-mail pode não ser o dono dele). Só vira quando o código ou o
// link do e-mail de confirmação, que cita a escolha, for usado. Sem a caixa marcada, qualquer pedido pendente anterior é apagado.
export async function setMarketingPending(email: string, wanted: boolean): Promise<void> {
  if (wanted) {
    await query(
      `insert into email_preferences (email, marketing_pending_at) values ($1, now())
       on conflict (email) do update set marketing_pending_at = case when email_preferences.marketing then email_preferences.marketing_pending_at else now() end`,
      [email],
    );
  } else {
    await query('update email_preferences set marketing_pending_at = null where email = $1 and marketing_pending_at is not null', [email]);
  }
}

// Confirmação do e-mail concluída pelo código/link: o pedido de promoções feito no cadastro (até 7 dias atrás) vira consentimento.
export async function confirmPendingMarketing(email: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `update email_preferences
        set marketing = true, marketing_consent_at = now(), marketing_consent_source = 'cadastro', marketing_consent_text = $2,
            marketing_pending_at = null, marketing_unsubscribed_at = null, marketing_unsubscribed_via = null
      where email = $1 and marketing_pending_at is not null and marketing_pending_at > now() - interval '7 days' and not marketing
      returning id`,
    [email, CONSENT_TEXT_VERSION],
  );
  return Boolean(row);
}

// O endereço é de uma conta de cliente ativa com e-mail confirmado? (só essas podem receber promoções)
export async function isVerifiedCustomerEmail(email: string): Promise<boolean> {
  const row = await one('select 1 as ok from customers where lower(email) = $1 and active and email_verified_at is not null', [email]);
  return Boolean(row);
}
