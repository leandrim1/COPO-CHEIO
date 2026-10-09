// Login do painel: senha com scrypt, sessão opaca guardada (só o hash) no Neon e entregue em cookie HttpOnly.
// Nada de JWT nem de segredo extra: o servidor consulta a sessão no banco a cada requisição administrativa.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';
import { HttpError } from './http.js';
import type { Admin } from './http.js';

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

export const MIN_PASSWORD = 8;
export function checkNewPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw new HttpError(400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
  if (password.length > 200) throw new HttpError(400, 'A senha é longa demais.');
  return password;
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
    `select a.id, a.name, a.email, a.role
       from admin_sessions s join admins a on a.id = s.admin_id
      where s.token_hash = $1 and s.expires_at > now() and a.active`,
    [sha256(token)],
  );
}

export async function destroySession(req: Request): Promise<void> {
  const token = readCookie(req, COOKIE);
  if (token) await query('delete from admin_sessions where token_hash = $1', [sha256(token)]);
}

// ---- Limite de tentativas --------------------------------------------------------------------------

// Quantas tentativas já houve nessa janela? (não registra)
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
