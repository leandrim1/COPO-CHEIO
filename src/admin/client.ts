import { api } from '../lib/api';

// ---- Imagens (Vercel Blob, via servidor) -------------------------------------------------------
// O navegador manda o arquivo para /api/admin/upload; o servidor grava no Blob e devolve a URL pública,
// que depois é salva no Neon junto com o produto/banner/configuração. Nada de token no navegador.

export type ImageFolder = 'products' | 'banners' | 'hero' | 'site';

// `file` = imagem escolhida que ainda não foi enviada (o envio acontece ao salvar).
export type ImageValue = { url: string | null; file?: File | null };
export const emptyImage = (url: string | null = null): ImageValue => ({ url, file: null });

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // limite do corpo de uma função na Vercel é 4,5 MB
const RASTER = ['image/png', 'image/jpeg', 'image/webp'];
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ACCEPTED_IMAGES = ACCEPTED.join(',');

// Fotos grandes do celular viram WebP de até `maxSide` px (transparência preservada).
async function optimize(file: File, maxSide: number): Promise<Blob> {
  if (!RASTER.includes(file.type)) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.88));
  // Navegadores sem WebP devolvem PNG; se não ficou menor, manda o original.
  return blob && blob.size < file.size ? blob : file;
}

export function checkImageFile(file: File): string | null {
  if (!ACCEPTED.includes(file.type)) return 'Use uma imagem PNG, JPG, WebP ou GIF.';
  if (file.size > MAX_INPUT_BYTES) return 'A imagem passa de 10 MB. Escolha uma menor.';
  return null;
}

export async function uploadImage(file: File, folder: ImageFolder, maxSide = 1600): Promise<{ url: string }> {
  const problem = checkImageFile(file);
  if (problem) throw new Error(problem);
  const blob = await optimize(file, maxSide);
  if (blob.size > MAX_UPLOAD_BYTES) throw new Error('A imagem ficou maior que 4 MB. Escolha uma menor.');
  return api.upload<{ url: string }>(`/api/admin/upload?folder=${folder}`, blob);
}

// Descarta no servidor imagens enviadas que acabaram não sendo usadas (ex.: o formulário falhou ao
// salvar). O servidor só apaga o que nenhum produto, banner ou configuração usa.
export async function discardImages(urls: (string | null | undefined)[]) {
  await Promise.all(urls.filter((u): u is string => Boolean(u)).map((url) => api.delete('/api/admin/upload', { url }).catch(() => undefined)));
}

// Envia a imagem nova (se houver) antes de salvar. Devolve a URL a gravar no banco.
export async function commitImage(value: ImageValue, folder: ImageFolder, maxSide?: number): Promise<{ url: string | null; uploaded: boolean }> {
  if (value.file) return { url: (await uploadImage(value.file, folder, maxSide)).url, uploaded: true };
  return { url: value.url, uploaded: false };
}
