// Miniaturas das fotos de produto (migration 0025: products.image_sm_url / image_md_url, 400 e 720 px de largura): validação, a regra de que
// as miniaturas SEMPRE pertencem à foto atual (trocar ou tirar a foto zera as duas), a API pública, a cópia ao duplicar, o Blob liberado
// ao trocar/excluir (foto e miniaturas) e a rota do painel que repassa os bytes de uma foto para gerar as miniaturas dela.
// usage: bash tests/fresh.sh && node tests/api-test27.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, check, section, summary } from './lib.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const BLOB = process.env.BLOB_BASE ?? 'http://127.0.0.1:4181';
const blobFiles = async () => (await (await fetch(`${BLOB}/__files`)).json()).sort();
const QUIET = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
const psql = (sql, db = 'copocheio_test') => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', db, '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], QUIET).trim();

const anon = new Client();
const owner = new Client();
await owner.login();

// Envia uma imagem para a pasta products/ do Blob falso e devolve a URL pública.
const upload = async (name = 'a.webp') => {
  const r = await owner.post('/api/admin/upload?folder=products', fx(name), { raw: true, headers: { 'content-type': 'image/webp' } });
  if (r.status !== 201) throw new Error(`upload falhou: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.url;
};
const pathOf = (url) => new URL(url).pathname.slice(1);
const make = async (extra = {}, name = `Produto ${Math.random().toString(36).slice(2, 8)}`) => {
  const r = await owner.post('/api/admin/products', { name, price: 9.9, ...extra });
  if (r.status !== 201) throw new Error(`criar produto falhou: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.product;
};
const get = async (id) => (await owner.get(`/api/admin/products/${id}`)).data.product;
const pub = async (id) => (await anon.get('/api/products')).data.products.find((p) => p.id === id);

// ------------------------------------------------------------------------------------------------
section('Estrutura no banco (migration 0025)');
{
  const cols = psql("select string_agg(column_name || ':' || is_nullable, ',' order by column_name) from information_schema.columns where table_name='products' and column_name in ('image_sm_url','image_md_url')");
  check('as duas colunas existem e são opcionais', cols === 'image_md_url:YES,image_sm_url:YES', cols);
  check('a migration 0025 está registrada', psql("select count(*) from schema_migrations where version = '0025_image_variants'") === '1');
}

// ------------------------------------------------------------------------------------------------
section('Cadastro com miniaturas');
const full = await upload('a.webp');
const md = await upload('b.webp');
const sm = await upload('lata.webp');
let p1;
{
  p1 = await make({ image_url: full, image_md_url: md, image_sm_url: sm });
  check('o produto guarda a foto e as duas miniaturas', p1.image_url === full && p1.image_md_url === md && p1.image_sm_url === sm, p1);
  const seen = await pub(p1.id);
  check('a API pública entrega a foto e as duas miniaturas', seen?.image_url === full && seen?.image_md_url === md && seen?.image_sm_url === sm, seen);
  check('a API pública continua sem estoque, SKU e datas', seen && !('stock' in seen) && !('sku' in seen) && !('created_at' in seen), Object.keys(seen ?? {}));
  const list = (await owner.get('/api/admin/products')).data.products.find((x) => x.id === p1.id);
  check('a lista do painel traz as miniaturas', list?.image_sm_url === sm && list?.image_md_url === md);
  const none = await make({});
  check('produto sem foto: as duas miniaturas ficam vazias', none.image_url === null && none.image_sm_url === null && none.image_md_url === null);
  const onlyFull = await make({ image_url: await upload('a.webp') });
  check('produto só com a foto (cadastro antigo): miniaturas vazias, nada quebra', onlyFull.image_sm_url === null && onlyFull.image_md_url === null);
  const ghost = await make({ image_sm_url: sm, image_md_url: md });
  check('miniaturas sem foto não valem: o servidor zera', ghost.image_url === null && ghost.image_sm_url === null && ghost.image_md_url === null, ghost);
}

// ------------------------------------------------------------------------------------------------
section('Validação dos endereços das miniaturas');
{
  const bad = async (body, label) => {
    const r = await owner.post('/api/admin/products', { name: `x${Math.random()}`, price: 5, image_url: full, ...body });
    check(`recusa ${label}`, r.status === 400, [r.status, r.data?.error]);
  };
  await bad({ image_sm_url: 'http://exemplo.com/a.webp' }, 'miniatura sem https');
  await bad({ image_md_url: 'javascript:alert(1)' }, 'miniatura com esquema perigoso');
  await bad({ image_sm_url: 'https://exemplo.com/' + 'a'.repeat(1100) }, 'miniatura com endereço enorme');
  await bad({ image_sm_url: 42 }, 'miniatura que não é texto');
  const r = await owner.patch(`/api/admin/products/${p1.id}`, { image_md_url: 'ftp://x/y.webp' });
  check('recusa também na edição', r.status === 400, [r.status, r.data?.error]);
  check('e nada mudou depois da recusa', (await get(p1.id)).image_md_url === md);
}

// ------------------------------------------------------------------------------------------------
section('As miniaturas sempre pertencem à foto atual');
{
  const p = await make({ image_url: await upload('a.webp'), image_sm_url: await upload('b.webp'), image_md_url: await upload('lata.webp') });
  // Nome mexe só no nome.
  let r = await owner.patch(`/api/admin/products/${p.id}`, { name: p.name + ' novo' });
  check('mudar só o nome mantém foto e miniaturas', r.status === 200 && r.data.product.image_sm_url === p.image_sm_url && r.data.product.image_md_url === p.image_md_url);
  // Foto nova SEM miniaturas na mesma requisição (cliente antigo, API): as antigas saem, para o site nunca mostrar a miniatura da foto anterior.
  const novaFoto = await upload('lata.webp');
  r = await owner.patch(`/api/admin/products/${p.id}`, { image_url: novaFoto });
  check('foto nova sem miniaturas zera as duas', r.status === 200 && r.data.product.image_url === novaFoto && r.data.product.image_sm_url === null && r.data.product.image_md_url === null, r.data.product);
  check('e a API pública também já não entrega as antigas', (await pub(p.id))?.image_sm_url === null);
  // Foto nova COM as miniaturas dela.
  const f2 = await upload('a.webp');
  const s2 = await upload('b.webp');
  const m2 = await upload('lata.webp');
  r = await owner.patch(`/api/admin/products/${p.id}`, { image_url: f2, image_sm_url: s2, image_md_url: m2 });
  check('foto nova com miniaturas novas: as três valem', r.status === 200 && r.data.product.image_sm_url === s2 && r.data.product.image_md_url === m2);
  // Mandar a mesma foto de novo não mexe nas miniaturas.
  r = await owner.patch(`/api/admin/products/${p.id}`, { image_url: f2 });
  check('mandar a mesma foto não zera as miniaturas', r.status === 200 && r.data.product.image_sm_url === s2, r.data.product);
  // Tirar a foto tira as miniaturas.
  r = await owner.patch(`/api/admin/products/${p.id}`, { image_url: null });
  check('tirar a foto zera as miniaturas', r.status === 200 && r.data.product.image_url === null && r.data.product.image_sm_url === null && r.data.product.image_md_url === null, r.data.product);
}

// ------------------------------------------------------------------------------------------------
section('"Gerar miniaturas" para uma foto que já existia (thumbnails_for)');
{
  const photo = await upload('a.webp');
  const p = await make({ image_url: photo });
  const s = await upload('b.webp');
  const m = await upload('lata.webp');
  let r = await owner.patch(`/api/admin/products/${p.id}`, { image_sm_url: s, image_md_url: m, thumbnails_for: 'https://teststore.public.blob.vercel-storage.com/products/outra-foto.webp' });
  check('se a foto mudou nesse meio tempo, recusa (409 photo_changed)', r.status === 409 && r.data?.code === 'photo_changed', [r.status, r.data]);
  check('e nada foi gravado', (await get(p.id)).image_sm_url === null);
  r = await owner.patch(`/api/admin/products/${p.id}`, { image_sm_url: s, image_md_url: m, thumbnails_for: photo });
  check('com a foto certa, grava as miniaturas sem tocar na foto', r.status === 200 && r.data.product.image_url === photo && r.data.product.image_sm_url === s && r.data.product.image_md_url === m, r.data.product);
  const q = await make({ image_url: await upload('a.webp') });
  r = await owner.patch(`/api/admin/products/${q.id}`, { image_sm_url: s, image_md_url: m });
  check('a API também aceita só as miniaturas (sem thumbnails_for)', r.status === 200 && r.data.product.image_sm_url === s);
  // Miniatura igual à própria foto (foto que já era pequena): vale, e liberar depois não dá erro.
  const small = await upload('b.webp');
  const t = await make({ image_url: small, image_sm_url: small, image_md_url: small });
  check('a própria foto pode ser a miniatura (foto já pequena)', t.image_sm_url === small && t.image_md_url === small);
}

// ------------------------------------------------------------------------------------------------
section('Duplicar copia as miniaturas');
{
  const a = await upload('a.webp');
  const s = await upload('b.webp');
  const m = await upload('lata.webp');
  const p = await make({ image_url: a, image_sm_url: s, image_md_url: m });
  const r = await owner.post(`/api/admin/products/${p.id}/duplicate`, {});
  check('a cópia nasce com a mesma foto e as mesmas miniaturas', r.status === 201 && r.data.product.image_url === a && r.data.product.image_sm_url === s && r.data.product.image_md_url === m, r.data.product);
  // O arquivo é compartilhado: sair do original não apaga do Blob enquanto a cópia usa.
  await owner.del(`/api/admin/products/${p.id}`);
  let files = await blobFiles();
  check('excluir o original NÃO apaga os arquivos que a cópia ainda usa', [a, s, m].every((u) => files.includes(pathOf(u))), files);
  await owner.del(`/api/admin/products/${r.data.product.id}`);
  files = await blobFiles();
  check('excluir a cópia (o último uso) apaga a foto e as duas miniaturas', [a, s, m].every((u) => !files.includes(pathOf(u))), files);
}

// ------------------------------------------------------------------------------------------------
section('Blob: trocar a foto libera a foto e as miniaturas antigas');
{
  const a = await upload('a.webp');
  const s = await upload('b.webp');
  const m = await upload('lata.webp');
  const p = await make({ image_url: a, image_sm_url: s, image_md_url: m });
  const a2 = await upload('a.webp');
  const s2 = await upload('b.webp');
  const m2 = await upload('lata.webp');
  let files = await blobFiles();
  check('antes da troca os seis arquivos estão no Blob', [a, s, m, a2, s2, m2].every((u) => files.includes(pathOf(u))));
  const r = await owner.patch(`/api/admin/products/${p.id}`, { image_url: a2, image_sm_url: s2, image_md_url: m2 });
  check('troca aceita', r.status === 200);
  files = await blobFiles();
  check('os três arquivos antigos saíram do Blob', [a, s, m].every((u) => !files.includes(pathOf(u))), files);
  check('os três novos ficaram', [a2, s2, m2].every((u) => files.includes(pathOf(u))), files);
  await owner.del(`/api/admin/products/${p.id}`);
  files = await blobFiles();
  check('excluir o produto libera os três', [a2, s2, m2].every((u) => !files.includes(pathOf(u))), files);
  // Foto pequena que serve de miniatura dela mesma: o arquivo único sai uma vez, sem erro.
  const one = await upload('b.webp');
  const q = await make({ image_url: one, image_sm_url: one, image_md_url: one });
  const del = await owner.del(`/api/admin/products/${q.id}`);
  check('foto que é a própria miniatura: excluir funciona e libera o arquivo', del.status === 200 && !(await blobFiles()).includes(pathOf(one)));
}

// ------------------------------------------------------------------------------------------------
section('Rota do painel que repassa a foto (/api/admin/image-source)');
{
  const url = await upload('a.webp');
  let r = await anon.get(`/api/admin/image-source?url=${encodeURIComponent(url)}`);
  check('sem login: 401', r.status === 401, r.status);
  r = await owner.get(`/api/admin/image-source?url=${encodeURIComponent(url)}`, { headers: {} });
  check('logado: 200, com o tipo certo e sem cache', r.status === 200 && r.headers.get('content-type') === 'image/webp' && /no-store/.test(r.headers.get('cache-control') ?? ''), [r.status, r.headers.get('content-type'), r.headers.get('cache-control')]);
  // O corpo volta idêntico (o helper do teste lê como texto; confere pelo tamanho com uma leitura crua).
  const raw = await fetch(`${owner.base}/api/admin/image-source?url=${encodeURIComponent(url)}`, { headers: { cookie: owner.cookie, 'x-real-ip': owner.ip } });
  const bytes = Buffer.from(await raw.arrayBuffer());
  check('os bytes são os da foto enviada', Buffer.compare(bytes, fx('a.webp')) === 0, [bytes.length, fx('a.webp').length]);
  const bad = async (value, label, status = 400) => {
    const x = await owner.get(`/api/admin/image-source?url=${encodeURIComponent(value)}`);
    check(`recusa ${label}`, x.status === status, [x.status, x.data]);
  };
  await bad('http://teststore.public.blob.vercel-storage.com/products/x.webp', 'endereço sem https');
  await bad('https://exemplo.com/products/a.webp', 'endereço fora do Blob da loja');
  await bad('https://teststore.public.blob.vercel-storage.com/banners/a.webp', 'pasta que não é de produtos');
  await bad('https://teststore.public.blob.vercel-storage.com.exemplo.com/products/a.webp', 'domínio que só imita o do Blob');
  await bad('http://127.0.0.1:4181/f/products/a.webp', 'endereço interno');
  await bad('não é um link', 'texto que não é um link');
  r = await owner.get('/api/admin/image-source');
  check('recusa pedido sem endereço', r.status === 400, r.status);
  r = await owner.get(`/api/admin/image-source?url=${encodeURIComponent('https://teststore.public.blob.vercel-storage.com/products/nao-existe.webp')}`);
  check('foto que não existe mais no Blob: 404 claro', r.status === 404, [r.status, r.data]);
}

// ------------------------------------------------------------------------------------------------
section('Cache e conteúdo públicos continuam os de sempre');
{
  const r = await anon.get('/api/products');
  check('lista pública com o cache curto de borda de antes', /s-maxage=10/.test(r.headers.get('cache-control') ?? '') && /max-age=0/.test(r.headers.get('cache-control') ?? ''), r.headers.get('cache-control'));
  const row = r.data.products.find((x) => x.id === p1.id);
  check('as colunas públicas incluem as miniaturas e nada administrativo', row && 'image_sm_url' in row && 'image_md_url' in row && !('sku' in row) && !('stock' in row));
}

summary();
