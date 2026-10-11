// Verificação em duas etapas do painel (TOTP, RFC 6238): o código de 6 dígitos que um aplicativo autenticador (Google Authenticator,
// Authy, Microsoft Authenticator, 1Password...) gera a cada 30 segundos a partir de uma chave que só o aplicativo e o servidor têm.
//
// Nada de biblioteca nem de serviço externo: é HMAC-SHA1 do contador de tempo, como manda o padrão.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// Chave nova: 160 bits (20 bytes) em base32, o tamanho que os aplicativos esperam.
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

// Código do passo `step` (número de intervalos de 30 s desde 1970).
export function totpAtStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  if (!key) throw new Error('chave inválida');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

// "123 456", "123-456" e "123456" valem.
export function cleanTotp(input: unknown): string | null {
  const code = typeof input === 'string' ? input.replace(/[\s-]/g, '') : '';
  return /^\d{6}$/.test(code) ? code : null;
}

// Passo cujo código bate (aceita um passo antes e um depois, por causa de relógios um pouco fora de hora), ou null.
// Confere todos os candidatos, sempre, para o tempo de resposta não revelar qual deles acertou.
export function matchTotpStep(secret: string, code: string, nowMs = Date.now(), tolerance = 1): number | null {
  const current = stepAt(nowMs);
  let found: number | null = null;
  for (let delta = -tolerance; delta <= tolerance; delta++) {
    const expected = Buffer.from(totpAtStep(secret, current + delta));
    const given = Buffer.from(code);
    if (given.length === expected.length && timingSafeEqual(expected, given)) found = current + delta;
  }
  return found;
}

// Endereço que o aplicativo lê (também vira QR code no painel).
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---- Códigos de recuperação (para quem perdeu o celular) -------------------------------------------------

const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // sem 0/O/1/I/L
export const RECOVERY_CODE_COUNT = 8;

// 16 letras/números = 80 bits de aleatoriedade, escritos "ABCD-EFGH-JKMN-PQRS".
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 16 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return chars.match(/.{4}/g)!.join('-');
  });
}

// Forma canônica do que a pessoa digitou (sem hífen/espaço, maiúsculas), ou null se não parece um código de recuperação.
export function cleanRecoveryCode(input: unknown): string | null {
  const code = typeof input === 'string' ? input.replace(/[\s-]/g, '').toUpperCase() : '';
  return /^[2-9A-HJKMNP-Z]{16}$/.test(code) ? code : null;
}

// Só o hash vai para o banco (o código tem 80 bits, então SHA-256 simples basta).
export const recoveryHash = (canonical: string): string => createHash('sha256').update(`recovery:${canonical}`).digest('hex');
