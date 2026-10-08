// Painel: envio de imagens para o Vercel Blob. O navegador manda o arquivo ao servidor; o servidor
// confere que é mesmo uma imagem, grava no Blob e devolve a URL pública, que depois é salva no Neon.
import { FOLDERS, MAX_IMAGE_BYTES, releaseImages, uploadImage } from '../blob.js';
import type { Folder } from '../blob.js';
import { HttpError, json, readBytes, readJson } from '../http.js';
import type { Router } from '../http.js';

export function registerUpload(r: Router) {
  r.post('/api/admin/upload', 'admin', async (ctx) => {
    const folder = ctx.url.searchParams.get('folder') as Folder;
    if (!FOLDERS.includes(folder)) throw new HttpError(400, 'Pasta inválida.');
    const bytes = await readBytes(ctx.req, MAX_IMAGE_BYTES);
    if (!bytes.byteLength) throw new HttpError(400, 'Arquivo vazio.');
    return json(await uploadImage(folder, bytes), 201);
  });

  // Descarta uma imagem enviada que acabou não sendo usada (ex.: o formulário não chegou a salvar).
  // Só apaga se nenhum produto, banner ou configuração usa essa URL.
  r.delete('/api/admin/upload', 'admin', async (ctx) => {
    const body = await readJson(ctx.req, 4 * 1024);
    if (typeof body.url !== 'string') throw new HttpError(400, 'Link inválido.');
    await releaseImages([body.url]);
    return json({ ok: true });
  });
}
