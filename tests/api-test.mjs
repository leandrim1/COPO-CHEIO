import { readFileSync } from 'node:fs';
import { BASE, Client, check, section, summary, loginAdmin } from './lib.mjs';

// big.webp não fica no repositório: 5 MB de bytes sem sentido com cabeçalho de WebP, só para testar o limite de tamanho.
const fx = (n) => (n === 'big.webp' ? Buffer.concat([Buffer.from('RIFF\xff\xff\xff\xffWEBPVP8 ', 'latin1'), Buffer.alloc(5 * 1024 * 1024)]) : readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const BLOB = process.env.BLOB_BASE ?? 'http://127.0.0.1:4181';
const blobFiles = async () => (await (await fetch(`${BLOB}/__files`)).json()).sort();

const anon = new Client();
const owner = new Client();

// ------------------------------------------------------------------------------------------------
section('Públicas sem login e sem dados administrativos');
{
  const h = await anon.get('/api/health');
  check('health: database ok e blob ok', h.data.database === 'ok' && h.data.blob === 'ok', h.data);
  const site = await anon.get('/api/site');
  check('site: 200 e conteúdo inicial', site.status === 200 && site.data.store.store_name === 'Copo Cheio' && site.data.hero.title.startsWith('Sua bebida'), site.status);
  check('site: preços numéricos (taxa 5)', site.data.store.delivery_fee === 5 && typeof site.data.store.min_order === 'number', site.data.store.delivery_fee);
  check('site: pagamentos ativos com label', site.data.payments.length === 3 && site.data.payments[0].code === 'pix', site.data.payments);
  check('site: sem campos administrativos', !('password_hash' in site.data) && !JSON.stringify(site.data).includes('password'));
  const p = await anon.get('/api/products');
  check('products: lista vazia (nenhum produto inventado)', p.status === 200 && p.data.products.length === 0 && p.data.categories.length === 0, p.data);
  // O cardápio e o conteúdo do site são listas públicas e podem ficar uns segundos na borda da Vercel; tudo o mais nunca é guardado.
  check('listas públicas: cache curto na borda, sem guardar no navegador', /s-maxage=\d+/.test(p.headers.get('cache-control') ?? '') && /max-age=0/.test(p.headers.get('cache-control') ?? ''), p.headers.get('cache-control'));
  check('a sessão (/api/auth/me) nunca é guardada: no-store', ((await anon.get('/api/auth/me')).headers.get('cache-control') ?? '').includes('no-store'));
  check('rota inexistente 404', (await anon.get('/api/nada')).status === 404);
  check('método errado 405', (await anon.req('DELETE', '/api/products')).status === 405);
}

section('Rotas administrativas exigem login no servidor');
{
  for (const path of ['/api/admin/dashboard', '/api/admin/orders', '/api/admin/orders/1001', '/api/admin/products', '/api/admin/categories', '/api/admin/settings', '/api/admin/banners', '/api/admin/admins', '/api/admin/live']) {
    const r = await anon.get(path);
    check(`GET ${path} sem login → 401`, r.status === 401, r.status);
  }
  for (const [m, path, body] of [
    ['POST', '/api/admin/products', { name: 'x', price: 1 }],
    ['PATCH', '/api/admin/store', { store_name: 'Hack' }],
    ['PATCH', '/api/admin/site', { seo_title: 'Hack' }],
    ['PATCH', '/api/admin/orders/00000000-0000-0000-0000-000000000000', { status: 'delivered' }],
    ['POST', '/api/admin/categories', { name: 'x' }],
    ['POST', '/api/admin/admins', { name: 'x', email: 'x@x.com', password: '12345678' }],
    ['PUT', '/api/admin/banners/order', { ids: [] }],
  ]) {
    const r = await anon.req(m, path, body);
    check(`${m} ${path} sem login → 401`, r.status === 401, r.status);
  }
  const up = await anon.post('/api/admin/upload?folder=products', fx('a.webp'), { raw: true, headers: { 'content-type': 'image/webp' } });
  check('upload sem login → 401', up.status === 401, up.status);
  const forged = new Client();
  forged.cookie = 'copocheio_admin=abcdefghijklmnopqrstuvwxyz';
  check('cookie falso → 401', (await forged.get('/api/admin/orders')).status === 401);
  check('/api/auth/me sem login → admin null', (await anon.get('/api/auth/me')).data.admin === null);
}

// ------------------------------------------------------------------------------------------------
section('Login, sessão e proteção contra força bruta');
{
  const bad = await loginAdmin(new Client(), { email: 'dono@copocheio.local', password: 'errada-errada' });
  check('senha errada → 401', bad.status === 401 && /incorretos/.test(bad.data.error), bad.data);
  const unknown = await loginAdmin(new Client(), { email: 'ninguem@x.com', password: 'qualquer-coisa' });
  check('e-mail desconhecido → mesma mensagem', unknown.status === 401 && unknown.data.error === bad.data.error);
  check('login sem corpo → 400', (await new Client().req('POST', '/api/auth/login', 'oi', { raw: true, headers: { 'content-type': 'application/json' } })).status === 400);

  const r = await owner.login();
  check('login ok → 200 com admin', r.data.admin.role === 'owner' && r.data.admin.name === 'Dono Teste' && !('password_hash' in r.data.admin));
  const sc = owner.lastSetCookie;
  check('cookie HttpOnly + SameSite=Lax + Path=/', /HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\//.test(sc), sc);
  check('cookie não guarda o hash (token opaco longo)', owner.cookie.length > 40);
  const me = await owner.get('/api/auth/me');
  check('me → admin', me.data.admin?.email === 'dono@copocheio.local');

  // Força bruta: 8 erros do mesmo e-mail, da mesma rede, bloqueiam essa rede (até com a senha certa).
  const attacker = new Client(undefined, '198.51.100.201');
  for (let i = 0; i < 8; i++) await loginAdmin(attacker, { email: 'dono@copocheio.local', password: 'tentativa-' + i });
  const blocked = await loginAdmin(attacker, { email: 'dono@copocheio.local', password: 'outra-vez' });
  check('8 falhas da mesma rede → 429', blocked.status === 429 && Number(blocked.headers.get('retry-after')) > 0, blocked.status);
  check('...e nem a senha certa entra a partir dessa rede', (await loginAdmin(attacker, { email: 'dono@copocheio.local', password: 'senha-forte-123' })).status === 429);
  // O dono, em outra rede, não é trancado para fora por quem erra a senha dele de longe.
  const stillOk = await new Client().login();
  check('o dono, em outra rede, continua entrando', stillOk.status === 200);
  const victim = 'forca@bruta.com';
  for (let i = 0; i < 8; i++) await loginAdmin(new Client(undefined, '198.51.100.202'), { email: victim, password: 'tentativa-' + i });
  check('8 falhas num e-mail desconhecido bloqueiam só essa rede também', (await loginAdmin(new Client(undefined, '198.51.100.202'), { email: victim, password: 'outra-vez' })).status === 429);

  // Origem estranha não escreve.
  const cross = await owner.post('/api/admin/categories', { name: 'CSRF' }, { headers: { origin: 'https://evil.example' } });
  check('POST com Origin de outro site → 403', cross.status === 403, cross.status);
  const same = await owner.post('/api/admin/categories', { name: 'Origem ok' }, { headers: { origin: BASE } });
  check('POST com a própria Origin → 201', same.status === 201, same.data);
  await owner.del(`/api/admin/categories/${same.data.category.id}`);

  // Logout mata a sessão no servidor.
  const other = new Client();
  await other.login();
  const savedCookie = other.cookie;
  check('sessão extra funciona', (await other.get('/api/admin/orders')).status === 200);
  await other.post('/api/auth/logout');
  const replay = new Client();
  replay.cookie = savedCookie;
  check('logout → cookie antigo deixa de valer', (await replay.get('/api/admin/orders')).status === 401);
  check('logout limpou o cookie da sessão', !other.cookie.includes('copocheio_admin='));
}

// ------------------------------------------------------------------------------------------------
section('Categorias');
let cat1, cat2;
{
  const a = await owner.post('/api/admin/categories', { name: 'Refrigerantes' });
  check('cria categoria', a.status === 201 && a.data.category.position === 0, a.data);
  cat1 = a.data.category;
  const b = await owner.post('/api/admin/categories', { name: 'Cervejas' });
  cat2 = b.data.category;
  check('segunda categoria com posição 1', cat2.position === 1);
  const dup = await owner.post('/api/admin/categories', { name: ' refrigerantes ' });
  check('nome repetido (sem diferenciar maiúsculas) → 409', dup.status === 409 && /categoria/i.test(dup.data.error), dup.data);
  check('nome vazio → 400', (await owner.post('/api/admin/categories', { name: '   ' })).status === 400);
  check('nome longo → 400', (await owner.post('/api/admin/categories', { name: 'x'.repeat(41) })).status === 400);
  const ord = await owner.put('/api/admin/categories/order', { ids: [cat2.id, cat1.id] });
  const list = await owner.get('/api/admin/categories');
  check('reordenar', ord.status === 200 && list.data.categories[0].id === cat2.id && list.data.categories[1].position === 1, list.data);
  const pat = await owner.patch(`/api/admin/categories/${cat2.id}`, { name: 'Cervejas Geladas', active: true });
  check('editar', pat.data.category.name === 'Cervejas Geladas');
  check('product_count presente', list.data.categories.every((c) => c.product_count === 0));
}

// ------------------------------------------------------------------------------------------------
section('Produtos: validação, preços e estoque');
let coca, heineken;
{
  const noName = await owner.post('/api/admin/products', { price: 5 });
  check('sem nome → 400', noName.status === 400, noName.data);
  check('sem preço → 400', (await owner.post('/api/admin/products', { name: 'X' })).status === 400);
  check('preço negativo → 400', (await owner.post('/api/admin/products', { name: 'X', price: -1 })).status === 400);
  check('preço "abc" → 400', (await owner.post('/api/admin/products', { name: 'X', price: 'abc' })).status === 400);
  check('promo >= preço → 400', (await owner.post('/api/admin/products', { name: 'X', price: 10, promo_price: 10 })).status === 400);
  check('imagem http (não https) → 400', (await owner.post('/api/admin/products', { name: 'X', price: 10, image_url: 'http://x.com/a.png' })).status === 400);
  check('imagem javascript: → 400', (await owner.post('/api/admin/products', { name: 'X', price: 10, image_url: 'javascript:alert(1)' })).status === 400);
  check('categoria inexistente → erro', [400, 409].includes((await owner.post('/api/admin/products', { name: 'X', price: 10, category_id: '11111111-1111-4111-8111-111111111111' })).status));

  const c = await owner.post('/api/admin/products', { name: 'Coca-Cola 2L', price: '12,00', category_id: cat1.id, description: 'Gelada', featured: true, stock: 10, sku: 'COCA2L' });
  check('cria produto (preço "12,00" → 12)', c.status === 201 && c.data.product.price === 12 && typeof c.data.product.price === 'number', c.data);
  coca = c.data.product;
  check('SKU repetido → 409', (await owner.post('/api/admin/products', { name: 'Outra', price: 3, sku: 'coca2l' })).status === 409);
  const h = await owner.post('/api/admin/products', { name: 'Heineken Long Neck', price: 9.9, category_id: cat2.id });
  heineken = h.data.product;
  check('segundo produto, sem estoque controlado', heineken.stock === null && heineken.sold_out === false && heineken.position === 1, heineken);

  const pub = await anon.get('/api/products');
  const pc = pub.data.products.find((p) => p.id === coca.id);
  check('site vê o produto novo com preço', pc?.price === 12 && pc.name === 'Coca-Cola 2L' && pc.featured === true, pc);
  check('site NÃO vê estoque nem SKU', pc && !('stock' in pc) && !('sku' in pc) && !('active' in pc), Object.keys(pc ?? {}));

  const up = await owner.patch(`/api/admin/products/${coca.id}`, { price: 13 });
  check('alterar preço', up.data.product.price === 13);
  check('site mostra R$ 13', (await anon.get('/api/products')).data.products.find((p) => p.id === coca.id).price === 13);
  const promo = await owner.patch(`/api/admin/products/${coca.id}`, { promo_price: 11.5 });
  check('preço promocional', promo.data.product.promo_price === 11.5);
  check('promo maior que o preço (só promo no patch) → erro', (await owner.patch(`/api/admin/products/${coca.id}`, { promo_price: 20 })).status === 400);
  check('baixar o preço abaixo da promo → erro do banco', [400].includes((await owner.patch(`/api/admin/products/${coca.id}`, { price: 11 })).status));
  await owner.patch(`/api/admin/products/${coca.id}`, { promo_price: null });

  const so = await owner.patch(`/api/admin/products/${coca.id}`, { sold_out: true });
  check('marcar esgotado', so.data.product.sold_out === true);
  check('site mostra esgotado', (await anon.get('/api/products')).data.products.find((p) => p.id === coca.id).sold_out === true);
  await owner.patch(`/api/admin/products/${coca.id}`, { sold_out: false });

  const off = await owner.patch(`/api/admin/products/${heineken.id}`, { active: false });
  check('desativar some do site', off.data.product.active === false && !(await anon.get('/api/products')).data.products.some((p) => p.id === heineken.id));
  await owner.patch(`/api/admin/products/${heineken.id}`, { active: true });

  // estoque
  const minus = await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: -4 });
  check('estoque −4 → 6', minus.data.product.stock === 6, minus.data);
  const plus = await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: 2 });
  check('estoque +2 → 8', plus.data.product.stock === 8);
  check('retirar mais que o estoque → 400', (await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: -99 })).status === 400);
  check('delta 0 → 400', (await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: 0 })).status === 400);
  const zero = await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: -8 });
  check('estoque 0 → ESGOTADO automático', zero.data.product.stock === 0 && zero.data.product.sold_out === true, zero.data.product);
  const back = await owner.post(`/api/admin/products/${coca.id}/stock`, { delta: 5 });
  check('repôs → volta a vender', back.data.product.stock === 5 && back.data.product.sold_out === false, back.data.product);
  const untrack = await owner.patch(`/api/admin/products/${coca.id}`, { stock: null });
  check('parar de controlar estoque', untrack.data.product.stock === null);
  await owner.patch(`/api/admin/products/${coca.id}`, { stock: 20 });

  // admin lista tudo
  const all = await owner.get('/api/admin/products');
  check('admin vê estoque/SKU', all.data.products.find((p) => p.id === coca.id).sku === 'COCA2L' && all.data.featured_limit === 4 && all.data.categories.length === 2, all.data.featured_limit);
  const dupe = await owner.post(`/api/admin/products/${coca.id}/duplicate`);
  check('duplicar: cópia desativada, sem SKU, sem destaque', dupe.status === 201 && dupe.data.product.name === 'Coca-Cola 2L (cópia)' && dupe.data.product.active === false && dupe.data.product.sku === null && dupe.data.product.featured === false, dupe.data);
  check('cópia não aparece no site', !(await anon.get('/api/products')).data.products.some((p) => p.id === dupe.data.product.id));
  await owner.del(`/api/admin/products/${dupe.data.product.id}`);
  check('excluir cópia', (await owner.get(`/api/admin/products/${dupe.data.product.id}`)).status === 404);
  check('id inválido → 404', (await owner.get('/api/admin/products/não-é-uuid')).status === 404);
}

// ------------------------------------------------------------------------------------------------
section('Upload para o Vercel Blob (servidor) e URL no Neon');
{
  const baseline = (await blobFiles()).length;
  const post = (name, folder = 'products', type = 'image/webp') => owner.post(`/api/admin/upload?folder=${folder}`, fx(name), { raw: true, headers: { 'content-type': type } });
  const u1 = await post('a.webp');
  check('webp → 201 com URL do Blob', u1.status === 201 && /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/products\/[0-9a-f-]+\.webp$/.test(u1.data.url), u1.data);
  const u2 = await post('a.png', 'banners', 'application/octet-stream');
  check('png (tipo declarado errado) → vira .png pelos bytes', u2.status === 201 && u2.data.url.endsWith('.png') && u2.data.url.includes('/banners/'), u2.data);
  const u3 = await post('a.jpg', 'site', 'text/plain');
  check('jpg → .jpg', u3.status === 201 && u3.data.url.endsWith('.jpg'));
  check('SVG recusado', (await post('evil.svg', 'products', 'image/svg+xml')).status === 400);
  check('texto com nome .png recusado', (await post('fake.png', 'products', 'image/png')).status === 400);
  check('arquivo de 5 MB → 413', (await post('big.webp')).status === 413);
  check('pasta inválida → 400', (await post('a.webp', '../etc')).status === 400);
  check('corpo vazio → 400', (await owner.post('/api/admin/upload?folder=products', new Uint8Array(0), { raw: true, headers: { 'content-type': 'image/webp' } })).status === 400);
  const files = await blobFiles();
  check('arquivos realmente no Blob', files.length === baseline + 3, files);

  // Produto com imagem do Blob; o Neon guarda só a URL.
  const withImg = await owner.patch(`/api/admin/products/${coca.id}`, { image_url: u1.data.url });
  check('image_url = URL do Blob no produto', withImg.data.product.image_url === u1.data.url);
  const pubImg = (await anon.get('/api/products')).data.products.find((p) => p.id === coca.id);
  check('site recebe a URL do Blob', pubImg.image_url === u1.data.url);

  // Troca a imagem: a antiga sai do Blob.
  const u4 = await post('b.webp');
  await owner.patch(`/api/admin/products/${coca.id}`, { image_url: u4.data.url });
  let after = await blobFiles();
  check('trocar imagem apaga a antiga do Blob', !after.includes(u1.data.pathname) && after.includes(u4.data.pathname), after);

  // Duplicar compartilha a imagem; excluir o original NÃO apaga enquanto a cópia usa.
  const copy = (await owner.post(`/api/admin/products/${coca.id}/duplicate`)).data.product;
  check('cópia aponta para a mesma imagem', copy.image_url === u4.data.url);
  await owner.del(`/api/admin/products/${coca.id}`);
  after = await blobFiles();
  check('excluir original mantém a imagem usada pela cópia', after.includes(u4.data.pathname));
  await owner.del(`/api/admin/products/${copy.id}`);
  after = await blobFiles();
  check('excluir a última cópia apaga a imagem do Blob', !after.includes(u4.data.pathname), after);

  // Recria o Coca-Cola para os próximos testes.
  const c = await owner.post('/api/admin/products', { name: 'Coca-Cola 2L', price: 12, category_id: cat1.id, featured: true, stock: 20 });
  coca = c.data.product;

  // Descartar upload não usado.
  const orphan = await post('a.png');
  const del = await owner.del('/api/admin/upload', { url: orphan.data.url });
  check('descartar upload não usado apaga', del.status === 200 && !(await blobFiles()).includes(orphan.data.pathname));
  const keep = await post('a.webp');
  await owner.patch(`/api/admin/products/${heineken.id}`, { image_url: keep.data.url });
  await owner.del('/api/admin/upload', { url: keep.data.url });
  check('descartar NÃO apaga imagem em uso', (await blobFiles()).includes(keep.data.pathname));
  await owner.patch(`/api/admin/products/${heineken.id}`, { image_url: null });
  check('imagem solta é removida ao ficar sem uso', !(await blobFiles()).includes(keep.data.pathname));
}

summary();
