// Login do painel: senha com scrypt, sessão opaca guardada (só o hash) no Neon e entregue em cookie HttpOnly.
// Nada de JWT nem de segredo extra: o servidor consulta a sessão no banco a cada requisição administrativa.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import type { Admin } from './http.js';
import { passwordProblem } from './passwordPolicy.js';
import type { PasswordContext } from './passwordPolicy.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const KEYLEN = 32;
const COST = { N: 65536, r: 8, p: 1 };
const maxmem = (c: { N: number; r: number }) => 256 * c.N * c.r;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { ...COST, maxmem: maxmem(COST) });
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((v) => Number.isInteger(v) && v > 0) || cost.N > 1 << 20) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { ...cost, maxmem: maxmem(cost) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Hash de uma senha que não existe: login com e-mail desconhecido gasta o mesmo tempo que um com e-mail válido.
let decoy: Promise<string> | null = null;
export const decoyHash = () => (decoy ??= hashPassword(randomBytes(12).toString('hex')));

// Senha nova: tamanho, senhas comuns e e-mail/nome da pessoa (regras em passwordPolicy.ts). O painel exige mais que a conta de cliente.
export function checkNewPassword(password: unknown, ctx?: PasswordContext): string {
  const problem = passwordProblem(password, ctx);
  if (problem) throw new HttpError(400, problem, { code: 'weak_password' });
  return password as string;
}

// ---- Sessões -------------------------------------------------------------------------------------

export const COOKIE = 'copocheio_admin';
const SESSION_DAYS = 14;

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export async function createSession(adminId: string): Promise<{ token: string; maxAge: number }> {
  const token = randomBytes(32).toString('base64url');
  await query(`insert into admin_sessions (token_hash, admin_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [sha256(token), adminId, SESSION_DAYS]);
  // Limpeza de sessões vencidas, de vez em quando.
  if (Math.random() < 0.05) await query('delete from admin_sessions where expires_at < now()');
  return { token, maxAge: SESSION_DAYS * 86400 };
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Cookie HttpOnly (o JavaScript do navegador nunca lê), SameSite=Lax e Secure em https.
export function cookieHeader(req: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export const sessionCookie = (req: Request, token: string, maxAge: number): string => cookieHeader(req, COOKIE, token, maxAge);

export async function adminFromRequest(req: Request): Promise<Admin | null> {
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 100) return null;
  return one<Admin>(
    `select a.id, a.name, a.email, a.role, (a.totp_enabled_at is not null) as two_factor
       from admin_sessions s join admins a on a.id = s.admin_id
      where s.token_hash = $1 and s.expires_at > now() and a.active`,
    [sha256(token)],
  );
}

export async function destroySession(req: Request): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) await query('delete from admin_sessions where token_hash = $1', [sha256(token)]);
}

// ---- Cookie do aparelho ----------------------------------------------------------------------------

// Identifica o navegador de quem já entrou no painel (só o hash fica no banco). Serve para avisar por e-mail quando entram de um
// aparelho novo e para não barrar o dono quando outra pessoa erra a senha dele de outro lugar.
export const DEVICE_COOKIE = 'copocheio_dispositivo';
const DEVICE_DAYS = 400; // o máximo que os navegadores guardam um cookie

export const deviceCookie = (req: Request, token: string): string => cookieHeader(req, DEVICE_COOKIE, token, DEVICE_DAYS * 86400);

// ---- Limite de tentativas --------------------------------------------------------------------------

export type Hit = { allowed: boolean; count: number; retryAfter: number };

// Registra uma tentativa E diz se ainda cabe, tudo de uma vez dentro do banco (rate_limit_hit): tentativas simultâneas entram numa fila,
// então a 9ª de 8 permitidas já é barrada. (Antes o servidor contava e só depois registrava: 40 tentativas ao mesmo tempo passavam.)
export async function hit(bucket: string, key: string, windowSeconds: number, max: number): Promise<Hit> {
  const row = await one<{ r: { allowed: boolean; count: number; retry_after: number } }>('select rate_limit_hit($1, $2, $3::integer, $4::integer) as r', [bucket, key, windowSeconds, max]);
  if (Math.random() < 0.02) await query(`delete from rate_limits where created_at < now() - interval '1 day'`);
  return { allowed: row!.r.allowed, count: row!.r.count, retryAfter: row!.r.retry_after };
}

// Reserva uma tentativa antes de fazer o trabalho (conferir a senha, gastar um e-mail...). Passou do limite: erro 429 com Retry-After.
// Se o trabalho der certo e não deve contar como falha, devolva a vaga com `refund`.
export async function reserve(bucket: string, key: string, windowSeconds: number, max: number, message: string, code = 'rate_limited'): Promise<void> {
  const result = await hit(bucket, key, windowSeconds, max);
  if (!result.allowed) {
    throw new HttpError(429, message, { code, retry_after: result.retryAfter }, { 'retry-after': String(result.retryAfter) });
  }
}

export async function refund(bucket: string, key: string): Promise<void> {
  await query('select rate_limit_refund($1, $2)', [bucket, key]);
}

// Quantas tentativas já houve nessa janela? (só consulta, não registra: para limites que não precisam ser exatos sob concorrência)
export async function attempts(bucket: string, key: string, windowSeconds: number): Promise<number> {
  const row = await one<{ n: number }>(`select count(*) as n from rate_limits where bucket = $1 and key = $2 and created_at > now() - make_interval(secs => $3)`, [bucket, key, windowSeconds]);
  return row?.n ?? 0;
}

export async function recordAttempt(bucket: string, key: string): Promise<void> {
  await query('insert into rate_limits (bucket, key) values ($1, $2)', [bucket, key]);
  if (Math.random() < 0.02) await query(`delete from rate_limits where created_at < now() - interval '1 day'`);
}

export async function clearAttempts(bucket: string, key: string): Promise<void> {
  await query('delete from rate_limits where bucket = $1 and key = $2', [bucket, key]);
}

// Apaga as tentativas de todas as chaves que começam com `prefix` (ex.: "maria@x.com|" limpa o e-mail em todas as redes).
export async function clearAttemptsByPrefix(bucket: string, prefix: string): Promise<void> {
  await query(`delete from rate_limits where bucket = $1 and left(key, $3::integer) = $2`, [bucket, prefix, prefix.length]);
}
