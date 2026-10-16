// Login do PAINEL com código por e-mail, a cada entrada (migration 0024).
//
// Passos: (1) e-mail + senha (a rota de login confere a senha, a conta ativa e o papel); (2) com a senha certa o servidor abre um "desafio" no banco, manda
// um código de 6 dígitos para o e-mail da PRÓPRIA conta administrativa e entrega ao navegador um cookie secreto (HttpOnly, SameSite=Strict) que identifica a
// tentativa; (3) a sessão só nasce quando o código certo chega DESSE navegador. Quem só leu o e-mail não entra, e quem só sabe a senha também não.
//
// O banco guarda só o hash do cookie e um HMAC do código (a chave do HMAC vem de um segredo que não está no banco). Validade (5 min), uso único, limite de
// erros, espera entre reenvios e tetos por hora são todos conferidos DENTRO do banco (db/migrations/0024_admin_login_code.sql), então pedidos simultâneos não
// furam nenhum limite. Se o e-mail não puder ser enviado, NÃO há sessão (nunca se entra "por falta de e-mail"): a única exceção é o interruptor de emergência
// ADMIN_EMAIL_CODE=off, que só quem tem acesso às variáveis da Vercel pode ligar (veja docs/OPERACAO.md).
//
// Nada aqui escreve o código, a senha ou o cookie em log.
import { createHmac, randomBytes } from 'node:crypto';
import { cookieHeader, readCookie, refund, reserve, sha256 } from './auth.js';
import { one, query } from './db.js';
import { databaseUrl } from './env.js';
import { HttpError } from './http.js';
import { deliver } from './email/service.js';
import { mailConfigured } from './mail.js';
import { loadBrand } from './mailBrand.js';
import { adminLoginCodeMessage } from './mailTemplates.js';
import { describeDevice } from './adminAccess.js';
import { cleanCode, deliveryError, newCode } from './verification.js';

export { cleanCode };

export const ADMIN_CODE_MINUTES = 5;
export const ADMIN_RESEND_SECONDS = 60;
const COOKIE_NAME = 'copocheio_admin_login';
// O desafio todo vale 15 minutos (o cookie some junto).
const COOKIE_SECONDS = 15 * 60;

// Limite por rede de e-mails de código pedidos (só conta quando o e-mail sai); o teto de verdade por conta (8 por hora) está no banco.
const CODE_IP_BUCKET = 'admin-code-ip';
const CODE_IP_MAX = 30;
// Tentativas de código por rede (além das 5 por código, que o banco conta).
export const ADMIN_CODE_TRY_BUCKET = 'admin-code-try-ip';

// O código de e-mail é obrigatório. ÚNICA exceção: ADMIN_EMAIL_CODE=off (escrito exatamente assim) desliga só este passo, para quem perdeu o e-mail da loja e
// precisa entrar para consertar. Qualquer outro valor, inclusive vazio ou com erro de digitação, deixa o passo LIGADO.
export const adminEmailCodeEnabled = (): boolean => (process.env.ADMIN_EMAIL_CODE ?? '').trim() !== 'off';

// Chave só do servidor (derivada de um segredo que já existe): quem só conseguir LER a tabela não descobre os códigos. Rótulo diferente do dos outros
// códigos: um código de um tipo nunca serve para outro.
const pepper = () => createHmac('sha256', 'copocheio:admin-login-code:v1').update(databaseUrl() ?? '').digest();
const codeHash = (nonceHash: string, code: string): string => createHmac('sha256', pepper()).update(`${nonceHash}\n${code}`).digest('hex');

export const adminMailUnavailable = () =>
  new HttpError(503, 'Não foi possível enviar o código de acesso: o envio de e-mails da loja não está configurado. Fale com quem cuida do site.', { code: 'mail_not_configured' });

const mailFailed = () => new HttpError(503, 'Não conseguimos enviar o código por e-mail agora. Tente de novo em instantes.', { code: 'mail_failed' });

export const adminLoginCookie = (req: Request, nonce: string, maxAge = COOKIE_SECONDS): string => cookieHeader(req, COOKIE_NAME, nonce, maxAge, 'Strict');
export const clearAdminLoginCookie = (req: Request): string => cookieHeader(req, COOKIE_NAME, '', 0, 'Strict');

// Hash do cookie do desafio deste navegador (ou null, se não tem um cookie que preste).
export function adminChallengeHash(req: Request): string | null {
  const nonce = readCookie(req, COOKIE_NAME);
  return nonce && /^[A-Za-z0-9_-]{20,100}$/.test(nonce) ? sha256(nonce) : null;
}

export const expiredAdminChallenge = () =>
  new HttpError(400, 'O tempo para digitar o código acabou. Informe o e-mail e a senha de novo para receber um novo código.', { code: 'login_expired' });

async function sendCodeEmail(req: Request, ip: string, to: { email: string; name: string }, code: string): Promise<void> {
  const brand = await loadBrand(req);
  const message = adminLoginCodeMessage(brand, { to: to.email, name: to.name, code, codeMinutes: ADMIN_CODE_MINUTES, device: describeDevice(req.headers.get('user-agent')), ip });
  const result = await deliver({ kind: 'admin_login_code', to: to.email, message, req });
  if (!result.ok) throw deliveryError(result);
}

const TOO_MANY_MAILS = 'Muitos códigos pedidos desta rede. Aguarde um pouco e tente de novo.';
const HOURLY = 'Já enviamos vários códigos para esta conta na última hora. Aguarde um pouco e tente de novo.';

export type AdminStarted = {
  // Cookie novo do desafio (null = o navegador já tem um desafio recente e ele continua valendo).
  cookie: string | null;
  resendIn: number;
  expiresIn: number;
};

// Senha já conferida: abre o desafio e manda o código. Lança erro (nada de sessão) se não der para mandar.
export async function startAdminChallenge(req: Request, ip: string, admin: { id: string; email: string }): Promise<AdminStarted> {
  if (!mailConfigured()) throw adminMailUnavailable();
  // A vaga por rede é reservada antes (atômico) e devolvida se nenhum e-mail chegar a sair.
  await reserve(CODE_IP_BUCKET, ip, 3600, CODE_IP_MAX, TOO_MANY_MAILS);
  const nonce = randomBytes(24).toString('base64url');
  const nonceHash = sha256(nonce);
  const code = newCode();
  type Begin = { ok: true; reused?: boolean; retry_after?: number; expires_in?: number; id?: string; email?: string; name?: string } | { ok: false; reason: 'hourly' | 'not_active' };
  const row = await one<{ r: Begin }>('select begin_admin_email_challenge($1::uuid, $2, $3, $4, $5) as r', [admin.id, nonceHash, codeHash(nonceHash, code), adminChallengeHash(req), ADMIN_CODE_MINUTES]);
  const begin = row!.r;
  if (!begin.ok) {
    await refund(CODE_IP_BUCKET, ip);
    if (begin.reason === 'hourly') throw new HttpError(429, HOURLY, { code: 'rate_limited' });
    throw new HttpError(401, 'E-mail ou senha incorretos.');
  }
  if (begin.reused) {
    // Mesmo navegador, pedido repetido logo em seguida: vale o código que já foi enviado.
    await refund(CODE_IP_BUCKET, ip);
    return { cookie: null, resendIn: begin.retry_after ?? ADMIN_RESEND_SECONDS, expiresIn: begin.expires_in ?? ADMIN_CODE_MINUTES * 60 };
  }
  try {
    await sendCodeEmail(req, ip, { email: begin.email!, name: begin.name ?? '' }, code);
  } catch (error) {
    await query('select finish_admin_email_challenge($1::uuid, false)', [begin.id]);
    await refund(CODE_IP_BUCKET, ip);
    throw error instanceof HttpError ? error : mailFailed();
  }
  await query('select finish_admin_email_challenge($1::uuid, true)', [begin.id]);
  return { cookie: adminLoginCookie(req, nonce), resendIn: ADMIN_RESEND_SECONDS, expiresIn: ADMIN_CODE_MINUTES * 60 };
}

// "Reenviar código": outro código para o mesmo desafio (o navegador precisa ter o cookie dele).
export async function resendAdminCode(req: Request, ip: string): Promise<{ resendIn: number; expiresIn: number }> {
  if (!mailConfigured()) throw adminMailUnavailable();
  const nonceHash = adminChallengeHash(req);
  if (!nonceHash) throw expiredAdminChallenge();
  await reserve(CODE_IP_BUCKET, ip, 3600, CODE_IP_MAX, TOO_MANY_MAILS);
  type Begin = { ok: true; id: string; admin_id: string; email: string; name: string } | { ok: false; reason: 'expired' | 'cooldown' | 'limit' | 'hourly'; retry_after?: number };
  const row = await one<{ r: Begin }>('select begin_admin_email_resend($1) as r', [nonceHash]);
  const begin = row!.r;
  if (!begin.ok) {
    await refund(CODE_IP_BUCKET, ip);
    if (begin.reason === 'expired') throw expiredAdminChallenge();
    if (begin.reason === 'cooldown') {
      const wait = begin.retry_after ?? ADMIN_RESEND_SECONDS;
      throw new HttpError(429, `Aguarde ${wait} segundo(s) para pedir outro código.`, { code: 'cooldown', retry_after: wait }, { 'retry-after': String(wait) });
    }
    if (begin.reason === 'limit') throw new HttpError(429, 'Você já pediu o máximo de códigos desta tentativa. Informe o e-mail e a senha de novo para começar outra.', { code: 'resend_limit' });
    throw new HttpError(429, HOURLY, { code: 'rate_limited' });
  }
  const code = newCode();
  try {
    await sendCodeEmail(req, ip, { email: begin.email, name: begin.name }, code);
  } catch (error) {
    await refund(CODE_IP_BUCKET, ip);
    throw error instanceof HttpError ? error : mailFailed();
  }
  await query('select finish_admin_email_resend($1::uuid, $2, $3, true)', [begin.id, codeHash(nonceHash, code), ADMIN_CODE_MINUTES]);
  return { resendIn: ADMIN_RESEND_SECONDS, expiresIn: ADMIN_CODE_MINUTES * 60 };
}

export type AdminCodeCheck = { result: 'ok'; admin_id: string } | { result: 'invalid' | 'locked' };

export async function checkAdminCode(nonceHash: string, code: string): Promise<AdminCodeCheck> {
  const row = await one<{ r: AdminCodeCheck }>('select verify_admin_email_code($1, $2) as r', [nonceHash, codeHash(nonceHash, code)]);
  return row!.r;
}
