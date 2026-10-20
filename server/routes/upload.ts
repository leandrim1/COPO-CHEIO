// Painel: envio de imagens para o Vercel Blob. O navegador manda o arquivo ao servidor; o servidor
// confere que é mesmo uma imagem, grava no Blob e devolve a URL pública, que depois é salva no Neon.
import { reserve } from '../auth.js';
import { FOLDERS, MAX_IMAGE_BYTES, isBlobUrl, releaseImages, uploadImage } from '../blob.js';
import { one } from '../db.js';
import type { Folder } from '../blob.js';
import { HttpError, json, readBytes, readJson } from '../http.js';
import type { Router } from '../http.js';
import { fetchProductPhoto } from '../photoSource.js';

export function registerUpload(r: Router) {
  r.post('/api/admin/upload', 'admin', async (ctx) => {
    const folder = ctx.url.searchParams.get('folder') as Folder;
    if (!FOLDERS.includes(folder)) throw new HttpError(400, 'Pasta inválida.');
    const bytes = await readBytes(ctx.req, MAX_IMAGE_BYTES);
    if (!bytes.byteLength) throw new HttpError(400, 'Arquivo vazio.');
    return json(await uploadImage(folder, bytes), 201);
  });

  // O painel precisa dos bytes de uma foto de produto para gerar as miniaturas dela (botão "Gerar miniaturas"). O navegador não consegue baixá-la sozinho: a política de
  // segurança só deixa o site falar com o próprio endereço, e o canvas só lê imagem de outro endereço se ele mandar CORS. Por isso o servidor busca e repassa.
  // Vale para a foto de QUALQUER produto cadastrado, no Blob da loja ou em outro endereço (cardápio importado): o endereço precisa ser exatamente o de um produto, só https
  // e só de endereço público. Não é um proxy aberto (veja server/photoSource.ts), e exige quem está logado no painel.
  r.get('/api/admin/image-source', 'admin', async (ctx) => {
    await reserve('image-source', ctx.admin!.id, 600, 1000, 'Muitas fotos lidas em pouco tempo. Aguarde alguns minutos.');
    const raw = ctx.url.searchParams.get('url');
    let url: URL;
    try {
      url = new URL(raw ?? '');
    } catch {
      throw new HttpError(400, 'Link inválido.');
    }
    if (url.protocol !== 'https:' || (raw ?? '').length > 1000) throw new HttpError(400, 'Link inválido.');
    const registered = await one<{ ok: boolean }>('select exists (select 1 from products where image_url = $1) as ok', [url.toString()]);
    if (!registered?.ok) throw new HttpError(400, 'Esse endereço não é a foto de nenhum produto.');
    const photo = await fetchProductPhoto(url, MAX_IMAGE_BYTES, isBlobUrl(url.toString()));
    return new Response(photo.bytes, { status: 200, headers: { 'content-type': photo.type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
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
