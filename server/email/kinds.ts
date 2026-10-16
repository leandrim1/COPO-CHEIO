// Os tipos de e-mail do sistema. UM lugar diz, para cada tipo: se é transacional (conta/pedido) ou promocional, se leva segredo (código,
// link de senha: nunca é guardado nem reenviado), se entra na fila com nova tentativa e quais tetos valem.
//
// Para criar um tipo novo: acrescente aqui, escreva o texto em `server/mailTemplates.ts` (ou `server/email/templates.ts`), faça
// `server/email/render.ts` montá-lo a partir da "receita" e envie com `deliver()` (server/email/service.ts).
import type { Audience, Category } from './types.js';

export type KindName =
  | 'verification'
  | 'login_code'
  | 'already_registered'
  | 'password_reset'
  | 'password_changed'
  | 'admin_login_code'
  | 'admin_new_login'
  | 'admin_reset_notice'
  | 'mail_test'
  | 'order_received'
  | 'order_confirmed'
  | 'order_out_for_delivery'
  | 'order_delivered'
  | 'order_cancelled'
  | 'payment_confirmed'
  | 'payment_refunded'
  | 'deliverability_alert'
  | 'campaign'
  | 'campaign_test'
  | 'template_test';

export type KindDef = {
  category: Category;
  audience: Audience;
  // Nome em português (painel).
  label: string;
  // Leva código, link de senha ou outro segredo no assunto ou no corpo: o registro NUNCA guarda o assunto (só o nome do tipo) e a
  // mensagem nunca vai para a fila (se falhar, a pessoa pede de novo).
  sensitive: boolean;
  // sync: o e-mail já vem pronto de quem chamou e é tentado UMA vez, na hora. queued: entra na fila com uma "receita" e pode ser
  // refeito em nova tentativa (espera crescente).
  mode: 'sync' | 'queued';
  // A própria pessoa pediu (código de confirmação, link de senha): as preferências de "não quero avisos" não valem para ela.
  userInitiated: boolean;
  maxAttempts: number;
  // Teto de mensagens deste tipo para o mesmo endereço em 24 h.
  perRecipientDay: number;
  // Tipos do mesmo grupo dividem um teto comum (ver GROUP_DAY).
  group?: 'order';
  // Respeita "não quero e-mails sobre pedidos" (preferência do destinatário).
  respectsOrderPref?: boolean;
  // Confere se o domínio do endereço existe e não é descartável antes de enviar (endereço que ninguém confirmou, como o digitado no pedido).
  checkDomain?: boolean;
  // Só para os cabeçalhos: o teste de uma promoção precisa chegar com os cabeçalhos de uma promoção (sem "e-mail automático"), senão o teste não mostra o que o cliente recebe.
  headerCategory?: Category;
  // Teste que o painel manda para o próprio e-mail de quem pediu (nunca para um terceiro): não conta no teto geral por endereço, para que alguns
  // cliques em "Enviar exemplos" não bloqueiem os avisos de verdade (como o alerta de entregabilidade).
  test?: boolean;
};

export const KINDS: Record<KindName, KindDef> = {
  // ---- Conta do cliente ----
  verification: { category: 'transactional', audience: 'customer', label: 'Confirmação de e-mail (código)', sensitive: true, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 12 },
  // Código para ENTRAR na conta, a cada login (depois da senha certa). Vale 10 minutos; o servidor também limita 10 por hora por conta.
  login_code: { category: 'transactional', audience: 'customer', label: 'Código para entrar na conta', sensitive: true, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 25 },
  already_registered: { category: 'transactional', audience: 'customer', label: 'Aviso: você já tem uma conta', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 4, perRecipientDay: 3 },
  password_reset: { category: 'transactional', audience: 'customer', label: 'Redefinição de senha (link)', sensitive: true, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 12 },
  password_changed: { category: 'transactional', audience: 'customer', label: 'Aviso: senha alterada', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 5 },
  admin_reset_notice: { category: 'transactional', audience: 'customer', label: 'Aviso: a loja gerou link de nova senha', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 5 },
  // ---- Painel (equipe da loja) ----
  // Código para ENTRAR NO PAINEL, a cada login (depois da senha certa). Vale 5 minutos; o servidor também limita 8 por hora por conta.
  admin_login_code: { category: 'transactional', audience: 'staff', label: 'Código de acesso ao painel', sensitive: true, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 25 },
  admin_new_login: { category: 'transactional', audience: 'staff', label: 'Aviso: novo acesso ao painel', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 10 },
  mail_test: { category: 'transactional', audience: 'staff', label: 'E-mail de teste do painel', sensitive: true, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 10, test: true },
  deliverability_alert: { category: 'transactional', audience: 'staff', label: 'Alerta de entregabilidade', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 4, perRecipientDay: 3 },
  // ---- Pedido e pagamento ----
  order_received: { category: 'transactional', audience: 'customer', label: 'Pedido recebido', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  order_confirmed: { category: 'transactional', audience: 'customer', label: 'Pedido confirmado pela loja', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  order_out_for_delivery: { category: 'transactional', audience: 'customer', label: 'Pedido saiu para entrega', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  order_delivered: { category: 'transactional', audience: 'customer', label: 'Pedido entregue', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  order_cancelled: { category: 'transactional', audience: 'customer', label: 'Pedido cancelado', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  payment_confirmed: { category: 'transactional', audience: 'customer', label: 'Pagamento confirmado', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  payment_refunded: { category: 'transactional', audience: 'customer', label: 'Reembolso registrado', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 6, perRecipientDay: 4, group: 'order', respectsOrderPref: true, checkDomain: true },
  // ---- Promoções ----
  campaign: { category: 'promotional', audience: 'customer', label: 'Campanha promocional', sensitive: false, mode: 'queued', userInitiated: false, maxAttempts: 3, perRecipientDay: 2 },
  campaign_test: { category: 'transactional', audience: 'staff', label: 'Teste de campanha', sensitive: false, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 20, headerCategory: 'promotional', test: true },
  // Exemplos de cada modelo de e-mail que o owner manda para si mesmo (painel → Autenticação) para conferir no Gmail e no Outlook.
  template_test: { category: 'transactional', audience: 'staff', label: 'Exemplo de modelo de e-mail (painel)', sensitive: false, mode: 'sync', userInitiated: true, maxAttempts: 1, perRecipientDay: 30, test: true },
};

// Teto combinado (por endereço, em 24 h) dos tipos de um mesmo grupo: 5 e-mails de um pedido + pagamento + estorno cabem; um pedido
// feito 4 vezes com o e-mail de outra pessoa não vira uma enxurrada.
export const GROUP_DAY: Record<NonNullable<KindDef['group']>, number> = { order: 12 };

// Teto de qualquer mensagem para o mesmo endereço em 24 h, somando todos os tipos (último recurso contra abuso).
export const RECIPIENT_HARD_DAY = 40;

export const isKind = (value: string): value is KindName => Object.prototype.hasOwnProperty.call(KINDS, value);
