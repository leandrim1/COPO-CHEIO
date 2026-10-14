// Configuração do envio de e-mails (variáveis do SERVIDOR; nunca chegam ao navegador).
//
// O SMTP continua configurado como sempre (server/mail.ts: SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM...). Aqui ficam só os acréscimos,
// todos opcionais:
//   EMAIL_DAILY_LIMIT        teto de e-mails aceitos pelo servidor em 24 h. Sem ela: 450 para Gmail (o limite de contas pessoais é de
//                            ~500/dia) e sem teto para os demais. 0 = sem teto.
//   EMAIL_PROMO_DAILY_LIMIT  parte desse teto que as PROMOÇÕES podem usar por dia (o resto fica para códigos e avisos). Sem ela:
//                            40% do teto diário, ou 300 quando não há teto.
//   MAIL_REPLY_TO            endereço de resposta (Reply-To). Sem ela, não é enviado.
//   EMAIL_PROVIDER           "smtp" (padrão) ou "resend" (API + avisos de entrega; precisa de RESEND_API_KEY e de um domínio verificado).
//   EMAIL_ORDER_NOTICES      "off" PAUSA os e-mails de pedido e de pagamento (interruptor de segurança): nada novo sai e cada um fica no
//                            histórico como "bloqueado: pausado". Não afeta códigos de confirmação, nova senha, avisos de segurança nem promoções.
//                            Sem ela, ou com qualquer outro valor: ligados.
import { mailConfig } from '../mail.js';

const env = (name: string): string => (process.env[name] ?? '').trim();

// Provedores de e-mail gratuitos (o DNS deles não é seu: SPF/DKIM/DMARC são do provedor, e o limite de envio é o da conta pessoal).
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.br', 'icloud.com', 'me.com',
  'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br', 'proton.me', 'protonmail.com', 'zoho.com', 'gmx.com', 'mail.com',
]);

// Quem enviou: "Copo Cheio <loja@x.com.br>" → { display, email, domain }.
export function parseFrom(from: string | null | undefined): { display: string; email: string; domain: string } | null {
  const text = String(from ?? '').trim();
  if (!text) return null;
  const angle = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(text);
  const email = (angle ? angle[2] : text).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return null;
  return { display: angle ? angle[1].trim().replace(/^"|"$/g, '') : '', email, domain: email.slice(email.lastIndexOf('@') + 1) };
}

export function fromAddress() {
  return parseFrom(mailConfig()?.from);
}

const intEnv = (name: string): number | null => {
  const raw = env(name);
  if (!/^\d{1,7}$/.test(raw)) return null;
  return Number(raw);
};

export function isGmailHost(host: string | null | undefined): boolean {
  return /(^|\.)(gmail|googlemail)\.com$/i.test(host ?? '');
}

// Teto de e-mails aceitos em 24 h (0 = sem teto).
export function dailyLimit(): number {
  const configured = intEnv('EMAIL_DAILY_LIMIT');
  if (configured !== null) return configured;
  return isGmailHost(mailConfig()?.host) ? 450 : 0;
}

// Quanto desse teto as promoções podem usar por dia.
export function promoDailyLimit(): number {
  const configured = intEnv('EMAIL_PROMO_DAILY_LIMIT');
  if (configured !== null) return configured;
  const total = dailyLimit();
  return total > 0 ? Math.floor(total * 0.4) : 300;
}

export const replyTo = (): string | undefined => {
  const value = env('MAIL_REPLY_TO');
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? value : undefined;
};

// Interruptor de segurança: com EMAIL_ORDER_NOTICES=off (ou false, 0, no, pause, paused) os e-mails de pedido e pagamento não saem.
export const orderNoticesPaused = (): boolean => /^(off|false|0|no|pause|paused)$/i.test(env('EMAIL_ORDER_NOTICES'));

export type TransportName = 'smtp' | 'resend';
export const transportName = (): TransportName => (env('EMAIL_PROVIDER').toLowerCase() === 'resend' ? 'resend' : 'smtp');

// O remetente é uma conta de e-mail gratuita (Gmail, Outlook...)? Então não existe domínio da loja para autenticar.
export const sendsFromFreemail = (): boolean => {
  const from = fromAddress();
  return Boolean(from && FREEMAIL_DOMAINS.has(from.domain));
};
