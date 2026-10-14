// Confere a assinatura dos avisos (webhooks) no padrão Svix, o usado pela Resend: cabeçalhos svix-id, svix-timestamp e svix-signature.
//
// O texto assinado é "<svix-id>.<svix-timestamp>.<corpo EXATAMENTE como chegou>"; a chave é a parte em base64 do segredo "whsec_…";
// a assinatura é o HMAC-SHA256 desse texto, em base64, e o cabeçalho pode trazer várias ("v1,<assinatura> v1,<outra>") durante a troca
// do segredo. Aceita só avisos de até 5 minutos (de qualquer lado do relógio), o que impede reaproveitar um aviso capturado.
// Conferido com o exemplo da documentação da Svix (tests/unit/email-webhook.test.mjs).
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SvixHeaders = { id: string | null; timestamp: string | null; signature: string | null };

export const SVIX_TOLERANCE_SECONDS = 300;

export function verifySvix(secret: string, headers: SvixHeaders, body: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = SVIX_TOLERANCE_SECONDS): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || id.length > 200 || signature.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const key = Buffer.from(secret.trim().replace(/^whsec_/, ''), 'base64');
  if (key.length === 0) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  let match = false;
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    // Confere todas (sem parar na primeira) e em tempo constante.
    if (given.length === expected.length && timingSafeEqual(given, expected)) match = true;
  }
  return match;
}
