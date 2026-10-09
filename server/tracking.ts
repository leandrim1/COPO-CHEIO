// Código de acompanhamento do pedido.
//
// • Gerado aqui, no servidor, com 100 bits de aleatoriedade criptográfica (20 caracteres de um alfabeto de 32,
//   sem letras que se confundem: nada de O/0, I/L/1). Aparece assim para o cliente: "7K3M9-QX2VB-4HRD6-WTP8N".
// • No banco fica só o SHA-256 dele (order_tracking_tokens.token_hash). Quem tiver o banco não consegue
//   montar os links dos clientes.
// • Os links antigos (/pedido/<uuid>) continuam valendo: o UUID também é aceito e comparado pelo hash.
import { createHash, randomBytes } from 'node:crypto';
import { attempts, recordAttempt } from './auth.js';
import type { Statement } from './db.js';
import { HttpError } from './http.js';
import type { Ctx } from './http.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 20;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newTrackingToken(): string {
  const bytes = randomBytes(13); // 104 bits; usamos 100
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  bits >>= 4n;
  let out = '';
  for (let i = 0; i < LENGTH; i++) {
    out = ALPHABET[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return out.match(/.{5}/g)!.join('-');
}

// Forma canônica do que a pessoa digitou ou colou, ou null se não parece um código. Aceita minúsculas,
// espaços, hifens e as confusões clássicas (O→0, I/L→1).
export function normalizeToken(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > 64) return null;
  if (UUID_TEXT.test(text)) return text.toLowerCase();
  const compact = text
    .toUpperCase()
    .replace(/[\s_-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(compact)) return null;
  return compact.match(/.{5}/g)!.join('-');
}

export const hashToken = (canonical: string): string => createHash('sha256').update(canonical, 'utf8').digest('hex');

// SHA-256 do código digitado, ou null se o formato é inválido.
export function tokenHash(input: unknown): string | null {
  const canonical = normalizeToken(input);
  return canonical ? hashToken(canonical) : null;
}

// ---- Limite de tentativas ---------------------------------------------------------------------------

const BUCKET = 'track-miss';
const WINDOW = 15 * 60;
const MAX_MISSES = 30;

// Consulta de tentativas recentes, para rodar na mesma ida ao banco que a busca do pedido.
export const missesStatement = (ctx: Ctx): Statement => [
  'select count(*) as n from rate_limits where bucket = $1 and key = $2 and created_at > now() - make_interval(secs => $3)',
  [BUCKET, ctx.ip, WINDOW],
];
export const throttled = (misses: number): boolean => misses >= MAX_MISSES;

export const NOT_FOUND = 'Não encontramos um pedido com esses dados. Confira o número e o código, ou o link.';

// Só as consultas que erram contam. Quem passou do limite recebe 429 sem saber se a próxima tentativa
// acertaria (a verificação do limite vem antes da consulta).
export async function assertNotThrottled(ctx: Ctx): Promise<void> {
  if ((await attempts(BUCKET, ctx.ip, WINDOW)) >= MAX_MISSES) {
    throw new HttpError(429, 'Muitas tentativas de consulta. Aguarde alguns minutos e tente de novo.');
  }
}

export async function recordMiss(ctx: Ctx): Promise<void> {
  await recordAttempt(BUCKET, ctx.ip);
}
