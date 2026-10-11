// Imagens no Vercel Blob (copocheio-uploads). A credencial fica só no ambiente do servidor (token clássico ou
// OIDC + BLOB_STORE_ID); no Neon fica só a URL pública do arquivo.
import { BlobError, del, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { MissingConfig, blobConfigured, blobToken } from './env.js';
import { HttpError } from './http.js';
import { inspectImage } from './images.js';

export const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // a Vercel limita o corpo de uma função a 4,5 MB
export const FOLDERS = ['products', 'banners', 'hero', 'site'] as const;
export type Folder = (typeof FOLDERS)[number];

const EXTENSION: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/avif': 'avif' };

// O tipo e o tamanho vêm da ESTRUTURA do arquivo (cabeçalho, dimensões e fim do arquivo no lugar: veja images.ts), não do que o
// navegador diz nem só dos primeiros bytes. SVG nunca entra: pode carregar script.
export function sniffImage(b: Uint8Array): string | null {
  return inspectImage(b)?.type ?? null;
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
  const info = inspectImage(bytes);
  if (!info) throw new HttpError(400, 'O arquivo não é uma imagem válida (ou é grande demais em pixels). Envie uma imagem JPG, PNG, WebP, GIF ou AVIF.');
  const type = info.type;
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
