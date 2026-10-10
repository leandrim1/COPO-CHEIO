// Confirmação do e-mail das contas de clientes.
//
// A conta só passa a valer depois que a pessoa prova que lê aquela caixa de e-mail: o servidor manda um código
// de 6 dígitos e um link; o banco guarda só o hash de cada um (com validade, uso único, limite de tentativas e
// de reenvios). Nada aqui confia no navegador: login e rotas da conta conferem `email_verified_at` no servidor.
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { attempts, recordAttempt, sha256 } from './auth.js';
import { one, query } from './db.js';
import { databaseUrl } from './env.js';
import { HttpError } from './http.js';
import { MailError, mailConfigured, sendMail } from './mail.js';
import { loadBrand } from './mailBrand.js';
import { alreadyRegisteredMessage, verificationMessage } from './mailTemplates.js';

export const CODE_MINUTES = 15;
export const LINK_HOURS = 24;
export const RESEND_SECONDS = 60;

// ---- Códigos e links -----------------------------------------------------------------------------------

// O código tem só 1 milhão de possibilidades; por isso o hash é um HMAC com uma chave que só o servidor conhece
// (derivada de um segredo que já existe, a DATABASE_URL) e que não está no banco: quem só conseguir LER a tabela
// não consegue descobrir os códigos. Se a senha do banco mudar, os códigos em andamento (15 min) deixam de valer.
const pepper = () => createHmac('sha256', 'copocheio:email-code:v1').update(databaseUrl() ?? '').digest();
export const codeHash = (email: string, code: string): string => createHmac('sha256', pepper()).update(`${email}\n${code}`).digest('hex');

export const newCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const newLinkToken = (): string => randomBytes(32).toString('base64url');

// "123 456", "123-456" e "123456" valem; qualquer outra coisa não é código.
export function cleanCode(input: unknown): string | null {
  const code = typeof input === 'string' ? input.replace(/[\s-]/g, '') : '';
  return /^\d{6}$/.test(code) ? code : null;
}

// ---- Erros para o cliente ------------------------------------------------------------------------------

export const mailNotConfigured = () =>
  new HttpError(
    503,
    'O cadastro está temporariamente indisponível porque o envio de e-mails da loja ainda não foi configurado. Você pode fazer pedidos e acompanhá-los sem conta.',
    { code: 'mail_not_configured' },
  );

function mailFailure(error: unknown): HttpError {
  if (error instanceof MailError && error.kind === 'recipient') {
    return new HttpError(400, 'Esse endereço de e-mail não pôde receber a mensagem. Confira se digitou certo.', { code: 'mail_recipient_rejected' });
  }
  return new HttpError(503, 'Não conseguimos enviar o e-mail agora. Tente de novo em instantes.', { code: 'mail_failed' });
}

// ---- Enviar um código ----------------------------------------------------------------------------------

export type Issue = { sent: boolean; reason?: 'cooldown' | 'limit' | 'not_pending'; retryAfter?: number };

// Limite por IP de e-mails pedidos (confirmação de cadastro, reenvio, login e recuperação de senha), contado só quando o e-mail saiu.
export const MAIL_IP_BUCKET = 'mail-ip';
export const MAIL_IP_MAX = 15;

type Begin = { ok: true; id: string; email: string; name: string } | { ok: false; reason: 'not_pending' | 'cooldown' | 'hourly' | 'daily'; retry_after?: number };

// Gera código + link para a conta e envia. Não lança erro quando o banco só pede para esperar (espera de 60 s,
// limites por hora/dia ou conta já confirmada): devolve { sent: false }, e a tela mostra a mesma coisa de qualquer jeito.
export async function sendVerificationEmail(req: Request, ip: string, customer: { id: string; email: string }): Promise<Issue> {
  if (!mailConfigured()) throw mailNotConfigured();
  if ((await attempts(MAIL_IP_BUCKET, ip, 3600)) >= MAIL_IP_MAX) {
    throw new HttpError(429, 'Muitos e-mails de confirmação pedidos desta rede. Aguarde um pouco e tente de novo.', { code: 'rate_limited' });
  }
  const code = newCode();
  const token = newLinkToken();
  // O código é amarrado ao endereço em minúsculas (é assim que a pessoa o digita ao confirmar).
  const row = await one<{ r: Begin }>('select begin_email_verification($1::uuid, $2, $3, $4, $5) as r', [customer.id, codeHash(customer.email.toLowerCase(), code), sha256(token), CODE_MINUTES, LINK_HOURS]);
  const begin = row!.r;
  if (!begin.ok) {
    if (begin.reason === 'cooldown') return { sent: false, reason: 'cooldown', retryAfter: begin.retry_after };
    return { sent: false, reason: begin.reason === 'not_pending' ? 'not_pending' : 'limit' };
  }
  try {
    const brand = await loadBrand(req);
    await sendMail(
      verificationMessage(brand, {
        to: begin.email,
        name: begin.name,
        code,
        link: `${brand.siteUrl}/conta/verificar/${token}`,
        codeMinutes: CODE_MINUTES,
        linkHours: LINK_HOURS,
      }),
    );
  } catch (error) {
    // O código novo é descartado; o que a pessoa já tinha continua valendo.
    await query('select finish_email_verification($1::uuid, false)', [begin.id]);
    throw mailFailure(error);
  }
  await query('select finish_email_verification($1::uuid, true)', [begin.id]);
  await recordAttempt(MAIL_IP_BUCKET, ip);
  return { sent: true };
}

// Aviso para quem já tem conta e foi usado num cadastro: vai só para a caixa do dono (no máximo 1 por hora por endereço).
export async function sendAlreadyRegisteredNotice(req: Request, customer: { email: string; name: string }): Promise<void> {
  if (!mailConfigured()) return;
  if ((await attempts('notice-email', customer.email, 3600)) >= 1) return;
  try {
    const brand = await loadBrand(req);
    await sendMail(alreadyRegisteredMessage(brand, { to: customer.email, name: customer.name, loginUrl: `${brand.siteUrl}/conta` }));
    await recordAttempt('notice-email', customer.email);
  } catch {
    /* quem tentou o cadastro não pode saber se o endereço já existe: falha de envio aqui não vira erro na tela */
  }
}

// ---- Conferir o código / o link ------------------------------------------------------------------------

export type CodeResult = 'ok' | 'invalid' | 'locked';

export async function checkCode(email: string, code: string): Promise<CodeResult> {
  const row = await one<{ r: CodeResult }>('select verify_email_code($1, $2) as r', [email, codeHash(email, code)]);
  return row!.r;
}

export async function checkLink(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await one<{ r: string | null }>('select verify_email_link($1) as r', [sha256(token)]);
  return row?.r ?? null;
}
