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

// ---- Miniaturas das fotos de produto -------------------------------------------------------------
// A foto fica com até 1200 px de largura (como sempre) e o painel grava mais duas cópias da MESMA foto, com 400 px e 720 px de largura:
// o site escolhe a que cabe no espaço (srcset). A lista mostra a foto em até 176 px; baixar e decodificar 1200 px para isso era 7 a 13
// vezes o necessário. A miniatura que não precisa existir (a foto já é desse tamanho ou menor) usa a própria foto original.

export const THUMB_SM = 400;
export const THUMB_MD = 720;
const THUMB_QUALITY = 0.86;

const uploadBlob = (blob: Blob) => api.upload<{ url: string }>('/api/admin/upload?folder=products', blob);

// Reduz a imagem para `width` px de largura (a altura acompanha) e devolve WebP. Se o navegador não sabe gerar WebP (o Safari devolve PNG),
// LANÇA o erro: não dá para confundir com "a foto já é pequena" e marcar como pronta uma foto que nunca ganhou miniatura.
async function scaledWebp(bitmap: ImageBitmap, width: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Este navegador não conseguiu preparar a miniatura.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', THUMB_QUALITY));
  if (!blob || blob.type !== 'image/webp') throw new Error('Este navegador não gera miniaturas (não cria imagens WebP). Use o Chrome, o Edge ou o Firefox.');
  return blob;
}

// As duas miniaturas de uma foto. Cada uma é `null` quando a foto original já serve (não é maior que a miniatura) ou quando a
// imagem não é do tipo que o navegador sabe reduzir (GIF animado, por exemplo): quem chama usa a própria foto no lugar.
export async function makeThumbnails(source: Blob): Promise<{ sm: Blob | null; md: Blob | null }> {
  if (!RASTER.includes(source.type)) return { sm: null, md: null };
  const bitmap = await createImageBitmap(source).catch(() => null);
  if (!bitmap) return { sm: null, md: null };
  try {
    const make = async (width: number) => {
      if (bitmap.width <= width) return null;
      const blob = await scaledWebp(bitmap, width);
      // Miniatura que não ficou menor que o original não adianta nada.
      return blob.size < source.size ? blob : null;
    };
    return { sm: await make(THUMB_SM), md: await make(THUMB_MD) };
  } finally {
    bitmap.close();
  }
}

export type ProductPhoto = {
  // A foto a gravar no produto e as miniaturas dela; `changed` é falso quando não há foto nova (nada a gravar além do que já está).
  url: string | null;
  sm: string | null;
  md: string | null;
  changed: boolean;
  // Tudo que foi enviado agora para o Blob (para descartar se o produto não chegar a ser salvo).
  uploaded: string[];
};

// Foto do produto: envia a foto nova (até 1200 px) e as miniaturas. Se as miniaturas falharem, o produto ainda é salvo com a foto
// (o site usa a original e o botão "Gerar miniaturas" da lista de produtos faz o resto depois).
export async function commitProductPhoto(value: ImageValue): Promise<ProductPhoto> {
  if (!value.file) return { url: value.url, sm: null, md: null, changed: false, uploaded: [] };
  const full = await uploadImage(value.file, 'products', 1200);
  try {
    const thumbs = await makeThumbnails(value.file);
    const sent = await Promise.allSettled([thumbs.sm ? uploadBlob(thumbs.sm) : null, thumbs.md ? uploadBlob(thumbs.md) : null]);
    const urls = sent.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value.url] : []));
    if (sent.some((r) => r.status === 'rejected')) {
      // As duas ou nenhuma: uma miniatura sozinha deixaria o site escolher mal. A que subiu é descartada.
      await discardImages(urls);
      return { url: full.url, sm: null, md: null, changed: true, uploaded: [full.url] };
    }
    const [sm, md] = sent.map((r) => (r.status === 'fulfilled' ? r.value : null));
    return { url: full.url, sm: sm?.url ?? full.url, md: md?.url ?? full.url, changed: true, uploaded: [full.url, ...urls] };
  } catch {
    return { url: full.url, sm: null, md: null, changed: true, uploaded: [full.url] };
  }
}

// Gera as miniaturas de uma foto que já está cadastrada num produto, no Blob da loja ou em outro endereço (o servidor repassa os bytes: ver /api/admin/image-source) e devolve as URLs.
export async function generateThumbnailsFor(photoUrl: string): Promise<{ sm: string; md: string }> {
  const res = await fetch(`/api/admin/image-source?url=${encodeURIComponent(photoUrl)}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(res.status === 404 ? 'A foto não existe mais no armazenamento.' : 'Não foi possível ler a foto.');
  const thumbs = await makeThumbnails(await res.blob());
  const sent = await Promise.allSettled([thumbs.sm ? uploadBlob(thumbs.sm) : null, thumbs.md ? uploadBlob(thumbs.md) : null]);
  const urls = sent.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value.url] : []));
  const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    await discardImages(urls);
    throw failed.reason instanceof Error ? failed.reason : new Error('Não foi possível enviar a miniatura.');
  }
  const [sm, md] = sent.map((r) => (r.status === 'fulfilled' ? r.value : null));
  return { sm: sm?.url ?? photoUrl, md: md?.url ?? photoUrl };
}
