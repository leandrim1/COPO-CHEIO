// De onde veio a requisição: chave dos limites de tentativas e do registro de atividades.
//
// • Na Vercel, quem põe o IP no cabeçalho é a própria plataforma (o cliente não consegue forjar x-vercel-forwarded-for nem x-real-ip),
//   então eles vêm primeiro. Fora da Vercel (desenvolvimento e testes) vale o que o servidor local manda.
// • Endereço que não parece IP vira "unknown" (lixo no cabeçalho nunca cria uma chave nova de limite).
// • IPv6: quem tem uma rede IPv6 domina 2^64 endereços e trocaria de endereço a cada tentativa para fugir do limite. Por isso o
//   limite vale para o prefixo /64 (a "casa" da pessoa), não para o endereço inteiro.
import { isIP } from 'node:net';

// "::ffff:177.12.0.9" (IPv4 dentro de IPv6) volta a ser "177.12.0.9".
function unmap(address: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return m ? m[1] : address;
}

// Expande um IPv6 válido para 8 grupos de 4 dígitos hexadecimais.
function expandV6(address: string): string[] | null {
  let a = address.toLowerCase().split('%')[0];
  if (a.includes('.')) {
    // IPv4 no final ("64:ff9b::1.2.3.4"): converte para dois grupos.
    const tail = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (!tail) return null;
    const [b1, b2, b3, b4] = tail.slice(1).map(Number);
    if ([b1, b2, b3, b4].some((n) => n > 255)) return null;
    a = a.slice(0, tail.index) + ((b1 << 8) | b2).toString(16) + ':' + ((b3 << 8) | b4).toString(16);
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(missing).fill('0'), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => g.padStart(4, '0'));
}

// IP já limpo e pronto para ser chave de limite: IPv4 como veio; IPv6 como "prefixo/64".
export function normalizeIp(raw: string | null | undefined): string {
  const value = unmap((raw ?? '').trim());
  if (!value || value.length > 64) return 'unknown';
  const kind = isIP(value.split('%')[0]);
  if (kind === 4) return value;
  if (kind === 6) {
    const groups = expandV6(value);
    return groups ? `${groups.slice(0, 4).join(':')}::/64` : 'unknown';
  }
  return 'unknown';
}

export function clientIp(req: Request): string {
  const first = (name: string) => req.headers.get(name)?.split(',')[0]?.trim() || null;
  const candidates = process.env.VERCEL
    ? [first('x-vercel-forwarded-for'), first('x-real-ip'), first('x-forwarded-for')]
    : [first('x-real-ip'), first('x-forwarded-for')];
  for (const candidate of candidates) {
    const ip = normalizeIp(candidate);
    if (ip !== 'unknown') return ip;
  }
  return 'unknown';
}
