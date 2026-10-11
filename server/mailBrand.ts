// A marca nos e-mails: nome, logo e contatos reais da loja.
//
// Tudo vem do banco (Painel → Configurações e Site) ou do próprio site; o que não estiver cadastrado simplesmente não aparece.
// Nada aqui inventa endereço, telefone, rede social ou link.
import { one } from './db.js';
import { MissingConfig } from './env.js';

export type Contact = { label: string; text: string; url?: string };

export type Brand = {
  name: string;
  tagline: string;
  siteUrl: string;
  siteHost: string;
  logoUrl: string;
  // WhatsApp, Instagram e endereço, só os que estiverem cadastrados, na ordem em que aparecem no rodapé.
  contacts: Contact[];
  year: number;
  // Fuso horário da loja (para datas e horas escritas no e-mail).
  timezone: string;
};

// Endereço do site nos links e nas imagens do e-mail: SITE_URL (se definida) → domínio de produção da Vercel → endereço da
// implantação na Vercel. NUNCA vem do cabeçalho da requisição (Host / X-Forwarded-Host): quem controla a requisição controlaria o
// link que chega por e-mail (por exemplo, o de "Esqueci minha senha") e o levaria a um site falso. A única exceção é o computador de
// quem desenvolve (fora da Vercel), onde vale o endereço local (localhost).
const loopback = (host: string) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';

// "https://meusite.com.br/" → "https://meusite.com.br". Aceita sem o "https://" na frente e ignora o resto do caminho.
function baseOf(value: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function siteUrl(req: Request): string {
  const configured = baseOf((process.env.SITE_URL ?? '').trim());
  if (configured) return configured;
  const production = (process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '').trim();
  if (process.env.VERCEL_ENV === 'production' && production) {
    const base = baseOf(production);
    if (base) return base;
  }
  if (process.env.VERCEL) {
    const deployment = baseOf((process.env.VERCEL_URL ?? '').trim());
    if (deployment) return deployment;
  } else {
    const origin = new URL(req.url);
    if (loopback(origin.hostname)) return origin.origin;
  }
  console.error('[config] Falta a variável SITE_URL (endereço do site, ex.: https://www.seusite.com.br): sem ela os links dos e-mails não podem ser montados.');
  throw new MissingConfig(['SITE_URL'], 'Falta definir o endereço do site para montar os links dos e-mails (variável SITE_URL).');
}

// Logo oficial reduzida para e-mail (mesma arte de public/logo.png, 256×256 = 2x do tamanho exibido, PNG de 32 bits com
// transparência, ~64 KB), servida pelo próprio site.
export const EMAIL_LOGO_PATH = '/email/logo.png';

// Formatos que todo leitor de e-mail abre (o Outlook para Windows, por exemplo, não abre WebP, que é o que o painel gera).
const EMAIL_SAFE_IMAGE = /\.(png|jpe?g|gif)(\?.*)?$/i;

type Row = {
  store_name: string | null;
  tagline: string | null;
  whatsapp: string | null;
  instagram: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  cep: string | null;
  logo_url: string | null;
  timezone: string | null;
};

// "5534999990000" → "(34) 99999-0000"; números de fora do Brasil aparecem com "+".
export function formatWhatsapp(digits: string): string {
  const local = digits.startsWith('55') && (digits.length === 12 || digits.length === 13) ? digits.slice(2) : null;
  if (!local) return `+${digits}`;
  const ddd = local.slice(0, 2);
  const rest = local.slice(2);
  return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
}

const isHttpUrl = (value: string | null | undefined): value is string => Boolean(value) && /^https?:\/\/[^\s"'<>]+$/i.test(value as string);

// Mesma montagem que o site usa em "Contato": rua, cidade - UF, CEP.
function fullAddress(row: Row): string {
  const cep = row.cep ? row.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
  return [row.address, [row.city, row.state].filter(Boolean).join(' - '), cep].filter(Boolean).join(', ');
}

export function buildBrand(base: string, row: Row | null, now = new Date()): Brand {
  const contacts: Contact[] = [];
  const whatsapp = row?.whatsapp && /^[0-9]{10,15}$/.test(row.whatsapp) ? row.whatsapp : null;
  if (whatsapp) contacts.push({ label: 'WhatsApp', text: formatWhatsapp(whatsapp), url: `https://wa.me/${whatsapp}` });
  const instagram = (row?.instagram ?? '').replace(/^@/, '');
  if (/^[A-Za-z0-9._]{1,30}$/.test(instagram)) contacts.push({ label: 'Instagram', text: `@${instagram}`, url: `https://instagram.com/${instagram}` });
  const address = row ? fullAddress(row) : '';
  if (address) contacts.push({ label: 'Endereço', text: address });

  // Logo trocada no painel só vale no e-mail se for PNG/JPG/GIF; senão, a logo oficial em PNG.
  const custom = row?.logo_url;
  const logoUrl = isHttpUrl(custom) && EMAIL_SAFE_IMAGE.test(custom) ? custom : `${base}${EMAIL_LOGO_PATH}`;

  let siteHost = base;
  try {
    siteHost = new URL(base).host;
  } catch {
    /* mantém o endereço como veio */
  }
  return {
    name: row?.store_name?.trim() || 'Copo Cheio',
    tagline: row ? (row.tagline ?? '').trim() : 'Disk Bebidas',
    siteUrl: base,
    siteHost,
    logoUrl,
    contacts,
    year: now.getFullYear(),
    timezone: row?.timezone || 'America/Sao_Paulo',
  };
}

export async function loadBrand(req: Request): Promise<Brand> {
  const row = await one<Row>(
    `select s.store_name, s.tagline, s.whatsapp, s.instagram, s.address, s.city, s.state, s.cep, s.timezone, t.logo_url
       from store_settings s left join site_settings t on t.id = 1
      where s.id = 1`,
  );
  return buildBrand(siteUrl(req), row);
}
