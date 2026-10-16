// Painel: envio de imagens para o Vercel Blob. O navegador manda o arquivo ao servidor; o servidor
// confere que é mesmo uma imagem, grava no Blob e devolve a URL pública, que depois é salva no Neon.
import { FOLDERS, MAX_IMAGE_BYTES, isBlobUrl, releaseImages, uploadImage } from '../blob.js';
import type { Folder } from '../blob.js';
import { HttpError, json, readBytes, readJson } from '../http.js';
import type { Router } from '../http.js';
import { inspectImage } from '../images.js';

export function registerUpload(r: Router) {
  r.post('/api/admin/upload', 'admin', async (ctx) => {
    const folder = ctx.url.searchParams.get('folder') as Folder;
    if (!FOLDERS.includes(folder)) throw new HttpError(400, 'Pasta inválida.');
    const bytes = await readBytes(ctx.req, MAX_IMAGE_BYTES);
    if (!bytes.byteLength) throw new HttpError(400, 'Arquivo vazio.');
    return json(await uploadImage(folder, bytes), 201);
  });

  // O painel precisa dos bytes de uma foto de produto que já está no Blob para gerar as miniaturas dela (botão "Gerar miniaturas"). O
  // navegador não consegue baixá-la sozinho: a política de segurança só deixa o site falar com o próprio endereço, e o canvas só lê
  // imagem de outro endereço se ele mandar CORS. Por isso o servidor busca e repassa. Só serve fotos de produto do Blob da loja (a pasta
  // products/ de um endereço *.blob.vercel-storage.com): não é um proxy aberto, e exige quem está logado no painel.
  r.get('/api/admin/image-source', 'admin', async (ctx) => {
    const raw = ctx.url.searchParams.get('url');
    if (!isBlobUrl(raw) || !new URL(raw).pathname.startsWith('/products/')) throw new HttpError(400, 'Link inválido.');
    let res: Response;
    try {
      res = await fetch(raw, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    } catch {
      throw new HttpError(502, 'Não foi possível ler a imagem no armazenamento. Tente de novo.');
    }
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, res.status === 404 ? 'A imagem não existe mais no armazenamento.' : 'Não foi possível ler a imagem no armazenamento.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new HttpError(413, 'A imagem é grande demais.');
    // O tipo vem da estrutura do arquivo (como no envio), não do que o endereço de origem disser.
    const info = inspectImage(bytes);
    if (!info) throw new HttpError(415, 'O arquivo não é uma imagem válida.');
    return new Response(bytes, { status: 200, headers: { 'content-type': info.type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
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
