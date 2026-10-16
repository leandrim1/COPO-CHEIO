// Envio de e-mail por SMTP comum, que funciona com qualquer provedor: Gmail, Brevo, Resend (smtp.resend.com), Amazon SES, SendGrid,
// Postmark, Zoho, o e-mail do seu domínio... Este arquivo só sabe falar com o servidor SMTP; quem decide O QUE enviar, para quem, quando
// e o que fazer se falhar é o serviço central (server/email/service.ts), que usa `smtpSend` abaixo.
//
// Variáveis do SERVIDOR (nunca chegam ao navegador):
//   SMTP_HOST    servidor SMTP, ex.: smtp.gmail.com                                   (obrigatória)
//   SMTP_USER    usuário do SMTP (no Gmail, o seu e-mail)                              (obrigatória)
//   SMTP_PASS    senha do SMTP (no Gmail, uma "senha de app")                          (obrigatória)
//   SMTP_PORT    465 (padrão, conexão segura) ou 587 (STARTTLS)                        (opcional)
//   SMTP_SECURE  "true"/"false"; padrão: true na porta 465, false nas outras            (opcional)
//   MAIL_FROM    remetente, ex.: Copo Cheio <loja@seudominio.com.br>; se faltar e SMTP_USER for um
//                e-mail, usa "Copo Cheio <SMTP_USER>"                                  (opcional)
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

export type Message = {
  to: string;
  subject: string;
  text: string;
  html: string;
  // Cabeçalhos extras (ex.: List-Unsubscribe nas promoções).
  headers?: Record<string, string>;
};

const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '::1';

// Resposta do servidor depois de aceitar a mensagem.
export type SmtpInfo = { messageId: string | null; response: string | null };

// Um envio por chamada (sem conexão guardada: funções da Vercel não vivem entre uma chamada e outra). Devolve o que o servidor
// respondeu ao aceitar a mensagem; em caso de erro LANÇA o erro original do nodemailer (quem chama o classifica com
// `classifyFailure`, server/email/errors.ts). `patient`: tempos maiores, para quem roda em segundo plano (fila).
export async function smtpSend(
  message: Message & { messageId?: string; replyTo?: string },
  opts: { patient?: boolean } = {},
): Promise<SmtpInfo> {
  const config = mailConfig();
  if (!config) throw new MissingConfig(mailMissing(), `Envio de e-mail não configurado. Faltam: ${mailMissing().join(', ')}.`);
  // O nodemailer só é carregado no primeiro envio: levava ~100 ms para iniciar na partida a frio da função, e a maioria das chamadas da API
  // (cardápio, textos do site, pedidos...) nunca envia e-mail.
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    // STARTTLS obrigatório fora da conexão segura (nunca manda senha ou código em texto puro; só localhost, nos testes, dispensa).
    requireTLS: !config.secure && !loopback(config.host),
    // Curtos de propósito: a função da Vercel tem tempo limite (10 s no plano gratuito sem Fluid Compute); se o servidor de
    // e-mail travar, a pessoa recebe a mensagem "tente de novo" em vez de um erro 504 da plataforma.
    connectionTimeout: opts.patient ? 8000 : 5000,
    greetingTimeout: opts.patient ? 8000 : 5000,
    socketTimeout: opts.patient ? 15000 : 7000,
  });
  try {
    const info = (await transport.sendMail({
      from: config.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      headers: message.headers ?? {},
    })) as { messageId?: string; response?: string };
    return { messageId: info.messageId ?? null, response: info.response ?? null };
  } finally {
    transport.close();
  }
}
