// Envio de e-mail (confirmação de conta). SMTP comum, que funciona com qualquer provedor: Gmail, Brevo, Resend
// (smtp.resend.com), Amazon SES, SendGrid, Postmark, Zoho, o e-mail do seu domínio...
//
// Variáveis do SERVIDOR (nunca chegam ao navegador):
//   SMTP_HOST    servidor SMTP, ex.: smtp.gmail.com                                   (obrigatória)
//   SMTP_USER    usuário do SMTP (no Gmail, o seu e-mail)                              (obrigatória)
//   SMTP_PASS    senha do SMTP (no Gmail, uma "senha de app")                          (obrigatória)
//   SMTP_PORT    465 (padrão, conexão segura) ou 587 (STARTTLS)                        (opcional)
//   SMTP_SECURE  "true"/"false"; padrão: true na porta 465, false nas outras            (opcional)
//   MAIL_FROM    remetente, ex.: Copo Cheio <loja@seudominio.com.br>; se faltar e SMTP_USER for um
//                e-mail, usa "Copo Cheio <SMTP_USER>"                                  (opcional)
import nodemailer from 'nodemailer';
import { MissingConfig } from './env.js';

export type MailConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string };

const env = (name: string): string => (process.env[name] ?? '').trim();

// Nomes das variáveis que ainda faltam (vazio = tudo certo).
export function mailMissing(): string[] {
  const missing: string[] = [];
  for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']) if (!env(name)) missing.push(name);
  // MAIL_FROM só é exigida quando o usuário do SMTP não é um e-mail (aí não dá para usá-lo como remetente).
  if (!env('MAIL_FROM') && env('SMTP_USER') && !env('SMTP_USER').includes('@')) missing.push('MAIL_FROM');
  return missing;
}

export function mailConfig(): MailConfig | null {
  if (mailMissing().length) return null;
  const host = env('SMTP_HOST');
  const port = Number(env('SMTP_PORT')) || 465;
  const secureEnv = env('SMTP_SECURE').toLowerCase();
  const secure = secureEnv ? ['true', '1', 'yes', 'sim'].includes(secureEnv) : port === 465;
  let pass = env('SMTP_PASS');
  // O Gmail mostra a senha de app em grupos de 4 letras separados por espaço; os espaços não fazem parte dela.
  if (/(^|\.)gmail\.com$/i.test(host)) pass = pass.replace(/\s+/g, '');
  const user = env('SMTP_USER');
  return { host, port, secure, user, pass, from: env('MAIL_FROM') || `Copo Cheio <${user}>` };
}

export const mailConfigured = (): boolean => mailMissing().length === 0;

// Resumo sem segredos (para o painel).
export function mailStatus() {
  const config = mailConfig();
  return { configured: Boolean(config), missing: mailMissing(), from: config?.from ?? null, host: config?.host ?? null };
}

export type MailKind = 'recipient' | 'auth' | 'network' | 'other';
export class MailError extends Error {
  constructor(
    public kind: MailKind,
    message: string,
  ) {
    super(message);
  }
}

export type Message = { to: string; subject: string; text: string; html: string };

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '::1';

// Um envio por chamada (sem conexão guardada: funções da Vercel não vivem entre uma chamada e outra).
export async function sendMail(message: Message): Promise<void> {
  const config = mailConfig();
  if (!config) throw new MissingConfig(mailMissing(), `Envio de e-mail não configurado. Faltam: ${mailMissing().join(', ')}.`);
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // STARTTLS obrigatório fora da conexão segura (nunca manda senha ou código em texto puro; só localhost, nos testes, dispensa).
    requireTLS: !config.secure && !loopback(config.host),
    // Curtos de propósito: a função da Vercel tem tempo limite (10 s no plano gratuito sem Fluid Compute); se o servidor de
    // e-mail travar, a pessoa recebe a mensagem "tente de novo" em vez de um erro 504 da plataforma.
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 7000,
  });
  try {
    await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
    });
  } catch (error) {
    const e = error as { code?: string; command?: string; responseCode?: number; response?: string };
    // Nunca registra senha, código, corpo da mensagem nem endereço de e-mail: só o motivo técnico.
    const reason = String(e.response ?? (error as Error).message).replace(/[^\s<>"']+@[^\s<>"']+/g, '<e-mail>').slice(0, 200);
    console.error('[mail] falha ao enviar:', e.code ?? 'sem código', e.command ?? '', e.responseCode ?? '', reason);
    if (e.code === 'EAUTH') throw new MailError('auth', 'O servidor de e-mail recusou o usuário/senha (SMTP_USER / SMTP_PASS).');
    if (e.code === 'EENVELOPE' || (e.command === 'RCPT TO' && e.responseCode && e.responseCode >= 500 && e.responseCode < 600)) {
      throw new MailError('recipient', 'O servidor de e-mail recusou o endereço de destino.');
    }
    if (['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'ECONNRESET'].includes(e.code ?? '')) {
      throw new MailError('network', 'Não foi possível falar com o servidor de e-mail.');
    }
    throw new MailError('other', 'O servidor de e-mail não aceitou a mensagem.');
  } finally {
    transport.close();
  }
}
