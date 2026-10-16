// Confirmação do e-mail das contas de clientes.
//
// A conta só passa a valer depois que a pessoa prova que lê aquela caixa de e-mail: o servidor manda um código
// de 6 dígitos e um link; o banco guarda só o hash de cada um (com validade, uso único, limite de tentativas e
// de reenvios). Nada aqui confia no navegador: login e rotas da conta conferem `email_verified_at` no servidor.
import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { refund, reserve, sha256 } from './auth.js';
import { one, query } from './db.js';
import { databaseUrl } from './env.js';
import { HttpError } from './http.js';
import { deliver } from './email/service.js';
import { getPreferences } from './email/preferences.js';
import type { DeliverResult } from './email/service.js';
import { mailConfigured } from './mail.js';
import { loadBrand } from './mailBrand.js';
import { verificationMessage } from './mailTemplates.js';

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

function mailFailure(): HttpError {
  return new HttpError(503, 'Não conseguimos enviar o e-mail agora. Tente de novo em instantes.', { code: 'mail_failed' });
}

// O que a pessoa vê quando o serviço de e-mails não conseguiu entregar a mensagem ao servidor de e-mail.
export function deliveryError(result: DeliverResult): HttpError {
  if (result.blocked === 'recipient_limit') {
    return new HttpError(429, 'Já enviamos vários e-mails para este endereço hoje. Aguarde um pouco e tente de novo mais tarde.', { code: 'rate_limited' });
  }
  if (result.blocked || (result.failure?.kind === 'recipient' && !result.failure.retryable)) {
    return new HttpError(400, 'O servidor de e-mail desse endereço recusou a mensagem. Confira se digitou certo ou use outro e-mail (de qualquer provedor).', { code: 'mail_recipient_rejected' });
  }
  return mailFailure();
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
  // A vaga do limite por rede é reservada antes (atômico) e devolvida se nenhum e-mail chegar a sair.
  await reserve(MAIL_IP_BUCKET, ip, 3600, MAIL_IP_MAX, 'Muitos e-mails de confirmação pedidos desta rede. Aguarde um pouco e tente de novo.');
  const code = newCode();
  const token = newLinkToken();
  // O código é amarrado ao endereço em minúsculas (é assim que a pessoa o digita ao confirmar).
  const row = await one<{ r: Begin }>('select begin_email_verification($1::uuid, $2, $3, $4, $5) as r', [customer.id, codeHash(customer.email.toLowerCase(), code), sha256(token), CODE_MINUTES, LINK_HOURS]);
  const begin = row!.r;
  if (!begin.ok) {
    await refund(MAIL_IP_BUCKET, ip);
    if (begin.reason === 'cooldown') return { sent: false, reason: 'cooldown', retryAfter: begin.retry_after };
    return { sent: false, reason: begin.reason === 'not_pending' ? 'not_pending' : 'limit' };
  }
  try {
    const brand = await loadBrand(req);
    const prefs = await getPreferences(begin.email.toLowerCase()).catch(() => null);
    const message = verificationMessage(brand, {
      to: begin.email,
      name: begin.name,
      code,
      link: `${brand.siteUrl}/conta/verificar/${token}`,
      codeMinutes: CODE_MINUTES,
      linkHours: LINK_HOURS,
      marketingNotice: Boolean(prefs?.marketing_pending_at),
    });
    const result = await deliver({ kind: 'verification', to: begin.email, message, req, customerId: customer.id });
    if (!result.ok) throw deliveryError(result);
  } catch (error) {
    // O código novo é descartado; o que a pessoa já tinha continua valendo.
    await query('select finish_email_verification($1::uuid, false)', [begin.id]);
    await refund(MAIL_IP_BUCKET, ip);
    throw error instanceof HttpError ? error : mailFailure();
  }
  await query('select finish_email_verification($1::uuid, true)', [begin.id]);
  return { sent: true };
}

// Aviso para quem já tem conta e foi usado num cadastro: vai só para a caixa do dono (no máximo 1 por hora por endereço).
export async function sendAlreadyRegisteredNotice(req: Request, customer: { email: string; name: string }): Promise<void> {
  if (!mailConfigured()) return;
  try {
    // No máximo 1 aviso por hora por endereço (a reserva é atômica: cadastros simultâneos não mandam vários).
    await reserve('notice-email', customer.email, 3600, 1, 'aviso já enviado');
    // Tenta agora (o tempo de resposta do cadastro não pode revelar se o endereço já existe) e, se o servidor de e-mail falhar, o serviço
    // refaz em segundo plano.
    await deliver({ kind: 'already_registered', to: customer.email, spec: { name: customer.name }, req });
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

export type BoundCode = { result: CodeResult; bound?: boolean; customer_id?: string };

// Confirma com o código e, na mesma transação, descarta a senha do cadastro se a confirmação não veio do navegador que fez o
// cadastro (`nonceHash` é o hash do cookie secreto do cadastro). `bound: false` = a pessoa precisa criar uma senha agora.
export async function checkCodeBound(email: string, code: string, nonceHash: string | null): Promise<BoundCode> {
  const row = await one<{ r: BoundCode }>('select verify_email_code_bound($1, $2, $3) as r', [email, codeHash(email, code), nonceHash]);
  return row!.r;
}

export async function checkLink(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await one<{ r: string | null }>('select verify_email_link($1) as r', [sha256(token)]);
  return row?.r ?? null;
}

export type BoundLink = { email: string; bound: boolean; customer_id: string };

export async function checkLinkBound(token: string, nonceHash: string | null): Promise<BoundLink | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const row = await one<{ r: BoundLink | null }>('select verify_email_link_bound($1, $2) as r', [sha256(token), nonceHash]);
  return row?.r ?? null;
}
