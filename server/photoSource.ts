// Leitura segura da foto de um produto para o painel gerar as miniaturas (GET /api/admin/image-source).
//
// O navegador do painel não consegue baixar a foto sozinho (a política de segurança só deixa falar com o próprio site, e o canvas não lê imagem de outro endereço sem CORS),
// então o servidor busca e repassa. Para isso nunca virar um "proxy aberto" ou uma porta para a rede interna:
//  • só vale o endereço que JÁ É a foto de algum produto cadastrado (quem chama escolhe um produto, não um endereço qualquer);
//  • só https, porta padrão, sem usuário e senha na frente do endereço;
//  • o nome do site precisa apontar SOMENTE para endereços da internet pública (nada de 127.x, 10.x, 192.168.x, 169.254.x, redes privadas ou "localhost");
//  • sem seguir redirecionamento (um site público não pode mandar o servidor para um endereço interno), com tempo limite e tamanho máximo;
//  • o que volta precisa ser uma imagem de verdade (tipo conferido pelos primeiros bytes), nunca o texto que o endereço responder.
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { HttpError } from './http.js';
import { inspectImage } from './images.js';

// IPv4 que não é da internet pública (privados, loopback, link-local, CGNAT, documentação, teste de rede, multicast e reservados).
function privateV4(parts: number[]): boolean {
  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !privateV4(address.split('.').map(Number));
  if (kind !== 6) return false;
  const lower = address.toLowerCase();
  // ::ffff:a.b.c.d (IPv4 embutido) e NAT64 64:ff9b::a.b.c.d: vale a regra do IPv4 que está dentro.
  const embedded = /(?:::ffff:|^64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return !privateV4(embedded[1].split('.').map(Number));
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    return !privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  if (lower === '::' || lower === '::1') return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 (privado)
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 (link-local)
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 (multicast)
  if (lower.startsWith('2001:db8:') || lower.startsWith('2001:0db8:')) return false; // documentação
  if (first === 0x2002) return false; // 6to4: carrega um IPv4 qualquer
  return true;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw refused();
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new HttpError(502, 'Não foi possível encontrar o site onde a foto está.');
    }
  }
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a))) throw refused();
}

const refused = () => new HttpError(400, 'Esse endereço de foto não pode ser lido pelo painel.');

// Corpo da resposta com tamanho máximo (não carrega um arquivo gigante na memória só para descobrir que é grande).
async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw tooBig();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
const tooBig = () => new HttpError(413, 'A foto é grande demais para gerar a miniatura por aqui. Troque por uma foto menor (até 4 MB) no cadastro do produto.');

// Busca a foto e confere que é uma imagem. `trusted`: o endereço é do Blob da própria loja (não precisa conferir o nome do site).
export async function fetchProductPhoto(url: URL, max: number, trusted: boolean): Promise<{ bytes: Uint8Array; type: string }> {
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw refused();
  if (!trusted) await assertPublicHost(url.hostname);
  let res: Response;
  try {
    res = await fetch(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { accept: 'image/*' } });
  } catch {
    throw new HttpError(502, 'Não foi possível ler a foto no endereço onde ela está. Tente de novo.');
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, res.status === 404 ? 'A foto não existe mais no endereço onde estava.' : 'Não foi possível ler a foto no endereço onde ela está.');
  const bytes = await readLimited(res, max);
  // O tipo vem da estrutura do arquivo (como no envio), não do que o endereço de origem disser.
  const info = inspectImage(bytes);
  if (!info) throw new HttpError(415, 'O arquivo não é uma imagem válida.');
  return { bytes, type: info.type };
}
