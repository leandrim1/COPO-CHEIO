// Login do cliente com código por e-mail, a CADA entrada na conta (migration 0023).
//
// Passos: (1) e-mail + senha (a rota de login confere a senha); (2) com a senha certa, o servidor abre um "desafio" no banco, manda um código
// de 6 dígitos para o e-mail da conta e entrega ao navegador um cookie secreto (HttpOnly) que identifica o desafio; (3) a sessão só nasce quando
// o código certo chega DESSE navegador. O código é amarrado ao cookie: quem só leu o e-mail não entra, e quem só sabe a senha também não.
//
// O banco guarda só o hash do cookie e um HMAC do código (a chave do HMAC vem de um segredo que não está no banco). Validade, uso único,
// limite de erros, espera entre reenvios e tetos por hora são todos conferidos DENTRO do banco (db/migrations/0023_login_code.sql), então
// pedidos simultâneos não furam nenhum limite.
import { createHmac, randomBytes } from 'node:crypto';
import { cookieHeader, readCookie, refund, reserve, sha256 } from './auth.js';
import { one, query } from './db.js';
import { databaseUrl } from './env.js';
import { HttpError } from './http.js';
import { deliver } from './email/service.js';
import { mailConfigured } from './mail.js';
import { loadBrand } from './mailBrand.js';
import { loginCodeMessage } from './mailTemplates.js';
import { cleanCode, deliveryError, newCode } from './verification.js';

export { cleanCode };

export const LOGIN_CODE_MINUTES = 5;
export const LOGIN_RESEND_SECONDS = 60;
// O desafio todo vale 30 minutos (o cookie some junto).
const LOGIN_COOKIE = 'copocheio_login';
const LOGIN_COOKIE_SECONDS = 30 * 60;

// Limite por rede de e-mails de código pedidos (só conta quando o e-mail sai). Folgado de propósito: uma loja ou um prédio inteiro pode
// compartilhar a mesma rede; o teto de verdade por conta (10 por hora) está no banco.
const CODE_IP_BUCKET = 'login-code-ip';
const CODE_IP_MAX = 40;
// Tentativas de código por rede (além das 5 por desafio, que o banco conta).
export const CODE_TRY_BUCKET = 'login-code-try-ip';

// Chave só do servidor (derivada de um segredo que já existe): quem só conseguir LER a tabela não descobre os códigos. Se a senha do banco
// mudar, os desafios em andamento (no máximo 30 min) deixam de valer. Rótulo diferente do da confirmação de e-mail: um código de um tipo nunca
// serve para o outro.
const pepper = () => createHmac('sha256', 'copocheio:login-code:v1').update(databaseUrl() ?? '').digest();
const loginCodeHash = (nonceHash: string, code: string): string => createHmac('sha256', pepper()).update(`${nonceHash}\n${code}`).digest('hex');

export const loginMailUnavailable = () =>
  new HttpError(
    503,
    'O login com código está temporariamente indisponível porque o envio de e-mails da loja ainda não foi configurado. Você pode fazer pedidos e acompanhá-los sem conta.',
    { code: 'mail_not_configured' },
  );

export const loginCookie = (req: Request, nonce: string, maxAge = LOGIN_COOKIE_SECONDS): string => cookieHeader(req, LOGIN_COOKIE, nonce, maxAge);
export const clearLoginCookie = (req: Request): string => cookieHeader(req, LOGIN_COOKIE, '', 0);

// Hash do cookie do desafio deste navegador (ou null, se não tem um cookie que preste).
export function challengeHash(req: Request): string | null {
  const nonce = readCookie(req, LOGIN_COOKIE);
  return nonce && /^[A-Za-z0-9_-]{20,100}$/.test(nonce) ? sha256(nonce) : null;
}

export const expiredChallenge = () => new HttpError(400, 'O tempo para digitar o código acabou. Informe o e-mail e a senha de novo para receber um novo código.', { code: 'login_expired' });

async function sendCodeEmail(req: Request, to: { email: string; name: string }, customerId: string, code: string): Promise<void> {
  const brand = await loadBrand(req);
  const message = loginCodeMessage(brand, { to: to.email, name: to.name, code, codeMinutes: LOGIN_CODE_MINUTES });
  const result = await deliver({ kind: 'login_code', to: to.email, message, req, customerId });
  if (!result.ok) throw deliveryError(result);
}

const TOO_MANY_MAILS = 'Muitos códigos pedidos desta rede. Aguarde um pouco e tente de novo.';
const HOURLY = 'Já enviamos vários códigos para esta conta na última hora. Aguarde um pouco e tente de novo.';

export type Started = {
  // Cookie novo do desafio (null = o navegador já tem um desafio recente e ele continua valendo).
  cookie: string | null;
  resendIn: number;
};

// Senha já conferida: abre o desafio e manda o código. Lança erro (nada de sessão) se não der para mandar.
export async function startLoginChallenge(req: Request, ip: string, customer: { id: string; email: string }): Promise<Started> {
  if (!mailConfigured()) throw loginMailUnavailable();
  // A vaga por rede é reservada antes (atômico) e devolvida se nenhum e-mail chegar a sair.
  await reserve(CODE_IP_BUCKET, ip, 3600, CODE_IP_MAX, TOO_MANY_MAILS);
  const nonce = randomBytes(24).toString('base64url');
  const nonceHash = sha256(nonce);
  const code = newCode();
  type Begin = { ok: true; reused?: boolean; retry_after?: number; id?: string; email?: string; name?: string } | { ok: false; reason: 'hourly' | 'not_active' };
  const row = await one<{ r: Begin }>('select begin_login_challenge($1::uuid, $2, $3, $4, $5) as r', [customer.id, nonceHash, loginCodeHash(nonceHash, code), challengeHash(req), LOGIN_CODE_MINUTES]);
  const begin = row!.r;
  if (!begin.ok) {
    await refund(CODE_IP_BUCKET, ip);
    if (begin.reason === 'hourly') throw new HttpError(429, HOURLY, { code: 'rate_limited' });
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  if (begin.reused) {
    // Mesmo navegador, pedido repetido logo em seguida: vale o código que já foi enviado.
    await refund(CODE_IP_BUCKET, ip);
    return { cookie: null, resendIn: begin.retry_after ?? LOGIN_RESEND_SECONDS };
  }
  try {
    await sendCodeEmail(req, { email: begin.email!, name: begin.name ?? '' }, customer.id, code);
  } catch (error) {
    await query('select finish_login_challenge($1::uuid, false)', [begin.id]);
    await refund(CODE_IP_BUCKET, ip);
    throw error instanceof HttpError ? error : new HttpError(503, 'Não conseguimos enviar o e-mail agora. Tente de novo em instantes.', { code: 'mail_failed' });
  }
  await query('select finish_login_challenge($1::uuid, true)', [begin.id]);
  return { cookie: loginCookie(req, nonce), resendIn: LOGIN_RESEND_SECONDS };
}

// "Reenviar código": outro código para o mesmo desafio (o navegador precisa ter o cookie dele).
export async function resendLoginCode(req: Request, ip: string): Promise<{ resendIn: number }> {
  if (!mailConfigured()) throw loginMailUnavailable();
  const nonceHash = challengeHash(req);
  if (!nonceHash) throw expiredChallenge();
  await reserve(CODE_IP_BUCKET, ip, 3600, CODE_IP_MAX, TOO_MANY_MAILS);
  type Begin = { ok: true; id: string; customer_id: string; email: string; name: string } | { ok: false; reason: 'expired' | 'cooldown' | 'limit' | 'hourly'; retry_after?: number };
  const row = await one<{ r: Begin }>('select begin_login_resend($1) as r', [nonceHash]);
  const begin = row!.r;
  if (!begin.ok) {
    await refund(CODE_IP_BUCKET, ip);
    if (begin.reason === 'expired') throw expiredChallenge();
    if (begin.reason === 'cooldown') {
      const wait = begin.retry_after ?? LOGIN_RESEND_SECONDS;
      throw new HttpError(429, `Aguarde ${wait} segundo(s) para pedir outro código.`, { code: 'cooldown', retry_after: wait }, { 'retry-after': String(wait) });
    }
    if (begin.reason === 'limit') throw new HttpError(429, 'Você já pediu o máximo de códigos desta tentativa. Informe o e-mail e a senha de novo para começar outra.', { code: 'resend_limit' });
    throw new HttpError(429, HOURLY, { code: 'rate_limited' });
  }
  const code = newCode();
  try {
    await sendCodeEmail(req, { email: begin.email, name: begin.name }, begin.customer_id, code);
  } catch (error) {
    await refund(CODE_IP_BUCKET, ip);
    throw error instanceof HttpError ? error : new HttpError(503, 'Não conseguimos enviar o e-mail agora. Tente de novo em instantes.', { code: 'mail_failed' });
  }
  await query('select finish_login_resend($1::uuid, $2, $3, true)', [begin.id, loginCodeHash(nonceHash, code), LOGIN_CODE_MINUTES]);
  return { resendIn: LOGIN_RESEND_SECONDS };
}

export type CodeCheck = { result: 'ok'; customer_id: string } | { result: 'invalid' | 'locked' };

export async function checkLoginCode(nonceHash: string, code: string): Promise<CodeCheck> {
  const row = await one<{ r: CodeCheck }>('select verify_login_code($1, $2) as r', [nonceHash, loginCodeHash(nonceHash, code)]);
  return row!.r;
}
