import { createClient } from '@supabase/supabase-js';
import { MEDIA_BUCKET, SUPABASE_KEY, SUPABASE_URL, supabaseConfigured } from '../lib/supabase';

// Cliente do painel: guarda a sessão do administrador no navegador. Ele usa a mesma chave pública
// do site; o que o administrador pode fazer é decidido pelas policies (RLS) do banco.
export const admin = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_KEY || 'missing', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'copocheio-admin' },
});

export { supabaseConfigured };

// ---- Imagens (Supabase Storage, bucket "media") -----------------------------------------------

export type ImageValue = { url: string | null; path: string | null; file?: File | null };
export const emptyImage = (url: string | null = null, path: string | null = null): ImageValue => ({ url, path, file: null });

const PUBLIC_PREFIX = `/storage/v1/object/public/${MEDIA_BUCKET}/`;

// Caminho no bucket a partir do link público (para apagar arquivos antigos).
export function pathFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const at = url.indexOf(PUBLIC_PREFIX);
  return at >= 0 ? decodeURIComponent(url.slice(at + PUBLIC_PREFIX.length).split('?')[0]) : null;
}

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const RASTER = ['image/png', 'image/jpeg', 'image/webp'];
export const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/webp,image/gif';

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

const EXT: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

export function checkImageFile(file: File): string | null {
  if (!Object.keys(EXT).includes(file.type)) return 'Use uma imagem PNG, JPG, WebP ou GIF.';
  if (file.size > MAX_INPUT_BYTES) return 'A imagem passa de 10 MB. Escolha uma menor.';
  return null;
}

export async function uploadImage(file: File, folder: string, maxSide = 1600): Promise<{ url: string; path: string }> {
  const problem = checkImageFile(file);
  if (problem) throw new Error(problem);
  const blob = await optimize(file, maxSide);
  if (blob.size > 5 * 1024 * 1024) throw new Error('A imagem ficou maior que 5 MB. Escolha uma menor.');
  const type = blob.type || file.type;
  const path = `${folder}/${crypto.randomUUID()}.${EXT[type] ?? 'img'}`;
  const { error } = await admin.storage.from(MEDIA_BUCKET).upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false });
  if (error) throw new Error('Não foi possível enviar a imagem.');
  return { url: admin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl, path };
}

export async function removeImages(paths: (string | null | undefined)[]) {
  const list = paths.filter((p): p is string => Boolean(p));
  if (list.length) await admin.storage.from(MEDIA_BUCKET).remove(list);
}

// Envia a imagem nova (se houver) antes de salvar. Devolve o que gravar no banco.
export async function commitImage(value: ImageValue, folder: string, maxSide?: number) {
  if (value.file) return { ...(await uploadImage(value.file, folder, maxSide)), uploaded: true };
  return { url: value.url, path: value.path ?? pathFromUrl(value.url), uploaded: false };
}
