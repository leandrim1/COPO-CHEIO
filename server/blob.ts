// Imagens no Vercel Blob (copocheio-uploads). A credencial fica só no ambiente do servidor (token clássico ou
// OIDC + BLOB_STORE_ID); no Neon fica só a URL pública do arquivo.
import { BlobError, del, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { MissingConfig, blobConfigured, blobToken } from './env.js';
import { HttpError } from './http.js';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // a Vercel limita o corpo de uma função a 4,5 MB
export const FOLDERS = ['products', 'banners', 'hero', 'site'] as const;
export type Folder = (typeof FOLDERS)[number];

const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };

// O tipo vem dos primeiros bytes do arquivo, não do que o navegador diz (e SVG nunca entra: pode carregar script).
export function sniffImage(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b.length > 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length > 12 && ascii(4, 8) === 'ftyp' && (ascii(8, 12) === 'avif' || ascii(8, 12) === 'avis')) return 'image/avif';
  return null;
}

// Com token clássico passa o token; sem ele o SDK usa OIDC + BLOB_STORE_ID sozinho.
const auth = () => {
  const token = blobToken();
  return token ? { token } : {};
};

export async function uploadImage(folder: Folder, bytes: Uint8Array): Promise<{ url: string; pathname: string }> {
  if (!blobConfigured()) {
    throw new MissingConfig(['BLOB_READ_WRITE_TOKEN'], 'Falta a credencial do Vercel Blob: conecte o armazenamento copocheio-uploads ao projeto (variável BLOB_READ_WRITE_TOKEN ou BLOB_STORE_ID).');
  }
  const type = sniffImage(bytes);
  if (!type) throw new HttpError(400, 'Envie uma imagem JPG, PNG, WebP, GIF ou AVIF.');
  try {
    const blob = await put(`${folder}/${randomUUID()}.${EXTENSION[type]}`, Buffer.from(bytes), {
      ...auth(),
      access: 'public',
      contentType: type,
      addRandomSuffix: false,
      cacheControlMaxAge: 60 * 60 * 24 * 365,
    });
    return { url: blob.url, pathname: blob.pathname };
  } catch (error) {
    console.error('[blob] upload falhou:', error);
    const detail = error instanceof BlobError ? error.message : '';
    if (/private/i.test(detail)) {
      throw new HttpError(502, 'O Blob "copocheio-uploads" é privado. As imagens do site precisam de um Blob público.');
    }
    // A mensagem do SDK não traz segredo e ajuda a achar o problema (credencial, OIDC, loja...).
    throw new HttpError(502, `Não foi possível enviar a imagem para o armazenamento.${detail ? ` (${detail})` : ' Tente de novo.'}`);
  }
}

export const isBlobUrl = (value: string | null | undefined): value is string => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
};

// Apaga do Blob as imagens que não são mais usadas por nenhum produto, banner, logo, SEO ou Hero.
// Depois de uma troca ou exclusão: o arquivo antigo não fica ocupando espaço, e uma imagem
// compartilhada (produto duplicado) só sai quando o último uso some.
export async function releaseImages(urls: (string | null | undefined)[]): Promise<void> {
  if (!blobConfigured()) return;
  const unique = [...new Set(urls.filter(isBlobUrl))];
  const orphans: string[] = [];
  for (const url of unique) {
    const used = await query<{ used: boolean }>(
      `select (
         exists (select 1 from products where image_url = $1)
         or exists (select 1 from banners where image_desktop_url = $1 or image_mobile_url = $1)
         or exists (select 1 from site_settings where logo_url = $1 or og_image_url = $1 or favicon_url = $1)
         or exists (select 1 from hero_settings where images ? $1)
       ) as used`,
      [url],
    );
    if (!used[0]?.used) orphans.push(url);
  }
  if (!orphans.length) return;
  try {
    await del(orphans, auth());
  } catch (error) {
    // Arquivo sobrando no Blob não afeta o site; só registra.
    console.error('[blob] não foi possível apagar', orphans, error);
  }
}
