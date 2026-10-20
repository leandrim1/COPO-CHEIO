// Miniaturas das fotos de produto, de ponta a ponta no navegador: o painel gera as duas cópias (400 e 720 px de largura) ao salvar uma foto,
// o botão "Gerar miniaturas" cobre as fotos que já existiam, uma falha nas miniaturas não impede de salvar o produto, e o site baixa a
// miniatura certa em cada lugar (nunca a foto de 1200 px numa lista), sem mudar nada do que aparece.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-thumbs.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('node:fs').mkdirSync(SP, { recursive: true });
const BASE = 'http://localhost:4180';
const BLOB = 'http://127.0.0.1:4181';
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -F '|' -c "${q}"`).toString().trim();
let fails = 0;
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* a tela ainda está mudando */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};

let cookie = '';
async function api(method, path, body, raw) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(raw ? { 'content-type': raw } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}

// Largura (px) de um WebP, lida do cabeçalho do arquivo.
function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  return null;
}
const blobBytes = async (url) => Buffer.from(await (await fetch(`${BLOB}/f${new URL(url).pathname}`)).arrayBuffer());
const blobList = async () => (await (await fetch(`${BLOB}/__files`)).json()).sort();
const pathOf = (url) => new URL(url).pathname.slice(1);

const errors = [];
async function newCtx(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000, deviceScaleFactor: opts.dpr ?? 1 });
  const blobRequests = [];
  // Nada sai da máquina de teste: a foto "de outro endereço" (https://exemplo.invalid) falha na hora em vez de esperar a internet de verdade (no CI ela pode
  // demorar a responder, e o `networkidle` das páginas esperaria por ela até estourar o tempo).
  await ctx.route(/^https:\/\/(exemplo\.invalid|fotos-externas\.example)\//, (route) => route.abort());
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    blobRequests.push(path);
    await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + path }) });
  });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page, blobRequests };
}

// Imagem de teste desenhada no próprio navegador (degradê com círculos): `type` é image/png ou image/webp.
async function makeImage(browser, w, h, type, seed = 0) {
  const page = await browser.newPage();
  const b64 = await page.evaluate(
    async ({ w, h, type, seed }) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, `hsl(${(seed * 47) % 360},80%,40%)`);
      g.addColorStop(1, `hsl(${(seed * 47 + 90) % 360},85%,20%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 30; i++) {
        ctx.fillStyle = `hsla(${(seed * 47 + i * 12) % 360},70%,60%,0.35)`;
        ctx.beginPath();
        ctx.arc(((i * 197 + seed * 31) % w), ((i * 113 + seed * 17) % h), 20 + ((i * 37) % 120), 0, 7);
        ctx.fill();
      }
      const blob = await new Promise((r) => c.toBlob(r, type, 0.9));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { w, h, type, seed },
  );
  await page.close();
  return Buffer.from(b64, 'base64');
}

const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
async function adminLogin(page) {
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'dono@copocheio.local');
  await page.fill('#login-senha', 'senha-forte-123');
  await page.click('button[type=submit]');
  await finishAdminLogin(page);
  await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
}
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"] [role=status], [aria-live="polite"] [role=alert]')].map((t) => t.textContent).join(' | '));

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const cat = (await api('POST', '/api/admin/categories', { name: 'Bebidas' })).data.category;
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  const big1 = await makeImage(browser, 1800, 1350, 'image/png', 1);
  const big2 = await makeImage(browser, 1600, 1600, 'image/png', 2);
  const small = await makeImage(browser, 300, 300, 'image/png', 3);
  const bigWebp = await makeImage(browser, 1200, 1200, 'image/webp', 4);

  const { ctx: actx, page: a } = await newCtx(browser, { width: 1280, height: 900 });
  await adminLogin(a);

  async function createProduct(name, buffer, price = '8,00', mime = 'image/png', ext = 'png') {
    await a.goto(BASE + '/admin/produtos/novo', { waitUntil: 'networkidle' });
    await a.getByPlaceholder('Ex.: Coca-Cola 2L').fill(name);
    await a.getByLabel('Preço *').fill(price);
    await a.getByLabel('Categoria').selectOption({ label: 'Bebidas' });
    if (buffer) await a.setInputFiles('input[type=file][aria-label="Foto do produto"]', { name: `foto.${ext}`, mimeType: mime, buffer });
    await a.getByRole('button', { name: 'Salvar produto' }).click();
    await a.waitForURL('**/admin/produtos', { timeout: 20000 });
    await a.waitForSelector(`text=${name}`);
    const [id, image, sm, md] = psql(`select id, image_url, image_sm_url, image_md_url from products where name = '${name}'`).split('|');
    return { id, image, sm, md };
  }

  // =============================================================================================
  console.log('# painel: foto grande vira foto de 1200 px + miniaturas de 720 e 400 px');
  const p1 = await createProduct('Foto grande', big1);
  {
    ok(Boolean(p1.image && p1.sm && p1.md), 'o produto guardou a foto e as duas miniaturas', p1);
    ok(new Set([p1.image, p1.sm, p1.md]).size === 3, 'são três arquivos diferentes', p1);
    const [fs, ms, ss] = await Promise.all([blobBytes(p1.image), blobBytes(p1.md), blobBytes(p1.sm)]).then((b) => b.map(webpSize));
    ok(fs?.w === 1200 && fs?.h === 900, 'a foto tem 1200 × 900 (como sempre: até 1200 px no lado maior)', fs);
    ok(ms?.w === 720 && ms?.h === 540, 'a miniatura média tem 720 × 540', ms);
    ok(ss?.w === 400 && ss?.h === 300, 'a miniatura pequena tem 400 × 300', ss);
    const [full, mid, tiny] = await Promise.all([blobBytes(p1.image), blobBytes(p1.md), blobBytes(p1.sm)]);
    ok(tiny.length < mid.length && mid.length < full.length, `os arquivos ficam menores: ${full.length} > ${mid.length} > ${tiny.length} bytes`);
    ok(psql("select count(*) from products where image_sm_url like 'data:%' or image_md_url like 'data:%'") === '0', 'nenhuma imagem em base64 no banco');
  }

  // =============================================================================================
  console.log('# painel: foto pequena usa ela mesma como miniatura');
  const p2 = await createProduct('Foto pequena', small);
  ok(Boolean(p2.image) && p2.sm === p2.image && p2.md === p2.image, 'foto de 300 px: as duas miniaturas são a própria foto', p2);

  // =============================================================================================
  console.log('# painel: salvar sem trocar a foto não mexe nas miniaturas');
  {
    await a.goto(`${BASE}/admin/produtos/${p1.id}`, { waitUntil: 'networkidle' });
    await a.getByLabel('Preço *').fill('9,50');
    await a.getByRole('button', { name: 'Salvar produto' }).click();
    await a.waitForURL('**/admin/produtos', { timeout: 15000 });
    const after = psql(`select image_url, image_sm_url, image_md_url, price from products where id = '${p1.id}'`).split('|');
    ok(after[0] === p1.image && after[1] === p1.sm && after[2] === p1.md && Number(after[3]) === 9.5, 'foto e miniaturas iguais, preço novo', after);
  }

  // =============================================================================================
  console.log('# painel: trocar a foto troca as três (e as antigas saem do Blob)');
  {
    await a.goto(`${BASE}/admin/produtos/${p1.id}`, { waitUntil: 'networkidle' });
    await a.setInputFiles('input[type=file][aria-label="Foto do produto"]', { name: 'outra.png', mimeType: 'image/png', buffer: big2 });
    await a.getByRole('button', { name: 'Salvar produto' }).click();
    await a.waitForURL('**/admin/produtos', { timeout: 20000 });
    const now = psql(`select image_url, image_sm_url, image_md_url from products where id = '${p1.id}'`).split('|');
    ok(now.every(Boolean) && new Set(now).size === 3 && now.every((u) => ![p1.image, p1.sm, p1.md].includes(u)), 'três arquivos novos', now);
    const files = await blobList();
    ok([p1.image, p1.sm, p1.md].every((u) => !files.includes(pathOf(u))), 'os três antigos saíram do Blob', files);
    ok(now.every((u) => files.includes(pathOf(u))), 'os três novos estão no Blob');
    const sizes = await Promise.all(now.map(async (u) => webpSize(await blobBytes(u))));
    ok(sizes[1].w === 400 && sizes[2].w === 720 && sizes[0].w === 1200, 'larguras 1200 / 400 / 720', sizes);
    p1.image = now[0];
    p1.sm = now[1];
    p1.md = now[2];
  }

  // =============================================================================================
  console.log('# painel: se as miniaturas falharem, o produto ainda salva com a foto');
  {
    let calls = 0;
    await a.route('**/api/admin/upload?folder=products', async (route) => {
      calls += 1;
      if (calls === 1) return route.continue();
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'falha de teste' }) });
    });
    await a.goto(BASE + '/admin/produtos/novo', { waitUntil: 'networkidle' });
    await a.getByPlaceholder('Ex.: Coca-Cola 2L').fill('Sem miniatura');
    await a.getByLabel('Preço *').fill('7,00');
    await a.getByLabel('Categoria').selectOption({ label: 'Bebidas' });
    await a.setInputFiles('input[type=file][aria-label="Foto do produto"]', { name: 'foto.png', mimeType: 'image/png', buffer: big1 });
    await a.getByRole('button', { name: 'Salvar produto' }).click();
    await a.waitForURL('**/admin/produtos', { timeout: 20000 });
    await a.unroute('**/api/admin/upload?folder=products');
    const row = psql("select image_url is not null, image_sm_url is null, image_md_url is null from products where name = 'Sem miniatura'");
    ok(row === 't|t|t', 'salvou com a foto e sem miniaturas', row);
    ok(await until(async () => /Gerar miniaturas/.test(await toasts(a))), 'o aviso diz onde gerar as miniaturas depois', await toasts(a));
  }

  // =============================================================================================
  console.log('# painel: "Gerar miniaturas" cobre as fotos que já existiam');
  {
    // Foto antiga (só a original no Blob, como as cadastradas antes das miniaturas existirem) + duas fotos de outro endereço (cardápio importado): uma que o servidor
    // consegue ler (site público) e uma que não (o site não existe).
    const up = await api('POST', '/api/admin/upload?folder=products', bigWebp, 'image/webp');
    const old = (await api('POST', '/api/admin/products', { name: 'Foto antiga', price: 6, category_id: cat.id, image_url: up.data.url })).data.product;
    const outsideUrl = `https://fotos-externas.example${new URL((await api('POST', '/api/admin/upload?folder=products', bigWebp, 'image/webp')).data.url).pathname}`;
    const outside = (await api('POST', '/api/admin/products', { name: 'Foto de fora', price: 6, category_id: cat.id, image_url: outsideUrl })).data.product;
    const outside2Url = `https://fotos-externas.example${new URL((await api('POST', '/api/admin/upload?folder=products', bigWebp, 'image/webp')).data.url).pathname}`;
    const outside2 = (await api('POST', '/api/admin/products', { name: 'Foto de fora dois', price: 6, category_id: cat.id, image_url: outside2Url })).data.product;
    await api('POST', '/api/admin/products', { name: 'Foto quebrada', price: 6, category_id: cat.id, image_url: 'https://exemplo.invalid/foto.webp' });
    // Antes de gerar: no site, a foto antiga é um <img> simples (sem srcset), exatamente como era.
    {
      const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
      await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
      await page.waitForSelector('main ul li h3');
      const plain = page.locator('main li img[alt="Foto antiga"]').first();
      ok((await plain.getAttribute('srcset')) === null && (await plain.getAttribute('sizes')) === null && (await plain.getAttribute('src')) === up.data.url, 'produto sem miniaturas: <img> simples, sem srcset, com a foto original');
      await ctx.close();
    }
    await a.goto(BASE + '/admin/produtos', { waitUntil: 'networkidle' });
    // Contam TODOS os produtos com foto e sem miniatura: "Sem miniatura" (acima), "Foto antiga", as duas "Foto de fora" e "Foto quebrada". As que já têm miniatura não contam.
    const button = a.getByRole('button', { name: /Gerar miniaturas \(5\)/ });
    ok(await button.isVisible(), 'o botão aparece com a contagem certa (5 fotos sem miniatura, inclusive as de outro endereço)');
    ok((await a.getByText('Miniatura pendente').count()) >= 5, 'a lista marca cada produto sem miniatura com "Miniatura pendente"');
    await button.click();
    const dialog = a.getByRole('dialog');
    ok(await dialog.getByText(/5 foto\(s\) ainda não têm miniatura/).isVisible(), 'a confirmação explica o que vai acontecer');
    await dialog.getByRole('button', { name: 'Gerar agora' }).click();
    ok(await until(async () => /ficaram sem miniatura/.test(await toasts(a)), 60000), 'termina avisando de quantas fotos ficaram sem miniatura (a do site que não existe)', await toasts(a));
    ok(/1 de 5 foto\(s\) ficaram sem miniatura/.test(await toasts(a)), 'e diz que foi 1 de 5', await toasts(a));
    const made = psql(`select image_sm_url, image_md_url from products where id = '${old.id}'`).split('|');
    ok(made.every(Boolean) && made[0] !== up.data.url && made[1] !== up.data.url, 'a foto antiga ganhou duas miniaturas novas', made);
    const [mw, sw] = await Promise.all([blobBytes(made[1]), blobBytes(made[0])]).then((b) => b.map(webpSize));
    ok(mw?.w === 720 && sw?.w === 400, 'de 720 e 400 px', [mw, sw]);
    ok(psql(`select image_url from products where id = '${old.id}'`) === up.data.url, 'a foto original não mudou');
    ok(psql("select count(*) from products where name = 'Sem miniatura' and image_sm_url is not null and image_sm_url <> image_url") === '1', 'a outra foto sem miniatura também foi atendida');
    const ext = psql(`select image_url || '|' || image_sm_url || '|' || image_md_url from products where id = '${outside.id}'`).split('|');
    ok(ext[0] === outsideUrl && /\.blob\.vercel-storage\.com\/products\//.test(ext[1]) && /\.blob\.vercel-storage\.com\/products\//.test(ext[2]), 'a foto de outro endereço ganhou miniaturas no armazenamento da loja e continua apontando para o endereço de origem', ext);
    ok(psql("select count(*) from products where name = 'Foto quebrada' and image_sm_url is null") === '1', 'a foto de um site que não existe ficou como estava');
    // O botão NÃO some enquanto houver produto com foto e sem miniatura (era o defeito: sumia por causa das fotos de outro endereço).
    const again = a.getByRole('button', { name: /Gerar miniaturas \(1\)/ });
    await again.waitFor({ timeout: 10000 });
    ok(await again.isVisible(), 'sobrou 1 sem miniatura: o botão continua na tela, com a contagem 1');
    ok((await a.getByText('Miniatura pendente').count()) >= 1, 'e a lista ainda marca o produto pendente');

    // Formulário do produto: a foto sem miniatura oferece gerar só a dela. O lote acima já atendeu este produto; volta a deixá-lo pendente (como uma foto
    // recém-importada) para testar o botão do cadastro.
    ok(psql(`select (image_sm_url is not null)::text || (image_md_url is not null)::text from products where id = '${outside2.id}'`) === 'truetrue', 'o lote já tinha atendido esta foto de outro endereço também');
    const staleThumbs = psql(`select image_sm_url || '|' || image_md_url from products where id = '${outside2.id}'`).split('|');
    await fetch(`${BLOB}/delete`, { method: 'POST', body: JSON.stringify({ urls: staleThumbs }) });
    psql(`update products set image_sm_url = null, image_md_url = null where id = '${outside2.id}'`);
    await a.goto(BASE + `/admin/produtos/${outside2.id}`, { waitUntil: 'networkidle' });
    const here = a.locator('[data-thumbs-here]');
    await here.waitFor({ timeout: 10000 });
    ok(/ainda não tem miniatura/.test(await here.innerText()), 'no cadastro do produto o aviso e o botão "Gerar miniatura desta foto" aparecem');
    await here.getByRole('button', { name: 'Gerar miniatura desta foto' }).click();
    ok(await until(async () => /Miniaturas geradas/.test(await toasts(a)), 60000), 'gera só a deste produto e avisa', await toasts(a));
    ok((await a.locator('[data-thumbs-here]').count()) === 0, 'depois de gerar o aviso some do cadastro');
    ok(psql(`select (image_sm_url is not null)::text || (image_md_url is not null)::text from products where id = '${outside2.id}'`) === 'truetrue', 'e as duas miniaturas ficaram gravadas');
    await a.goto(BASE + '/admin/produtos', { waitUntil: 'networkidle' });
    ok((await a.getByRole('button', { name: /Gerar miniaturas \(1\)/ }).count()) === 1, 'na lista a contagem continua certa (só a quebrada)');
    // Produto com a foto de um site que não existe: o botão do cadastro avisa o motivo em vez de falhar calado.
    const broken = psql("select id from products where name = 'Foto quebrada'");
    await a.goto(BASE + `/admin/produtos/${broken}`, { waitUntil: 'networkidle' });
    await a.locator('[data-thumbs-here]').getByRole('button', { name: 'Gerar miniatura desta foto' }).click();
    ok(await until(async () => /Não foi possível gerar as miniaturas/.test(await toasts(a)), 30000), 'foto que o servidor não consegue ler: aviso claro', await toasts(a));
    ok((await a.locator('[data-thumbs-here]').count()) === 1, 'e o botão continua lá para tentar de novo');
    // Celular (390 px): o aviso do cadastro e o botão da lista cabem na tela, sem rolagem lateral, e o botão do cadastro tem 40 px de altura (tamanho padrão dos botões do painel).
    await a.setViewportSize({ width: 390, height: 844 });
    await a.reload({ waitUntil: 'networkidle' });
    const hereBtn = a.locator('[data-thumbs-here]').getByRole('button', { name: 'Gerar miniatura desta foto' });
    await hereBtn.scrollIntoViewIfNeeded();
    const hb = await hereBtn.boundingBox();
    ok(hb && hb.height >= 40 && hb.x >= 0 && hb.x + hb.width <= 390, 'celular: o botão do cadastro cabe na tela e dá para tocar', hb);
    ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'celular: cadastro do produto sem rolagem horizontal');
    await a.screenshot({ path: `${SP}/e2ethumbs-admin-form-mobile.png` });
    await a.goto(BASE + '/admin/produtos', { waitUntil: 'networkidle' });
    const listBtn = a.getByRole('button', { name: /Gerar miniaturas \(1\)/ });
    await listBtn.waitFor({ timeout: 10000 });
    const lb = await listBtn.boundingBox();
    ok(lb && lb.x >= 0 && lb.x + lb.width <= 390, 'celular: o botão "Gerar miniaturas" da lista cabe na tela', lb);
    ok(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'celular: lista de produtos sem rolagem horizontal');
    await a.screenshot({ path: `${SP}/e2ethumbs-admin-list-mobile.png` });
    await a.setViewportSize({ width: 1280, height: 900 });
  }
  await actx.close();

  // =============================================================================================
  console.log('# site: a lista baixa a miniatura de 400 px, os favoritos a de 720 px (na tela densa)');
  {
    await api('PATCH', `/api/admin/products/${p1.id}`, { featured: true });
    const { ctx, page, blobRequests } = await newCtx(browser, { width: 390, height: 844 }, { dpr: 2.625 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForSelector('main ul li h3');
    await page.waitForTimeout(1200);
    const row = page.locator('main li').filter({ has: page.getByRole('heading', { name: 'Foto grande', exact: true }) }).last();
    const rowImg = row.locator('img[alt="Foto grande"]');
    const attrs = await rowImg.evaluate((i) => ({ src: i.getAttribute('src'), srcset: i.getAttribute('srcset'), sizes: i.getAttribute('sizes'), cur: i.currentSrc, loading: i.loading }));
    // Na lista (dezenas de fotos) o <img> é simples: srcset + sizes em cada foto custa CPU de celular fraco (ver docs/DESEMPENHO.md), e a miniatura de 400 px
    // já cobre o cartão (até 176 px) em tela de 2×.
    ok(attrs.src === p1.sm && attrs.cur === p1.sm, 'o <img> da lista usa direto a miniatura de 400 px', attrs);
    ok(attrs.srcset === null && attrs.sizes === null, 'e é um <img> simples (sem srcset nem sizes)', attrs);
    const feat = page.locator('#favoritos').locator('..').locator('img[alt="Foto grande"]');
    const f = await feat.evaluate((i) => ({ src: i.getAttribute('src'), srcset: i.getAttribute('srcset'), sizes: i.getAttribute('sizes'), cur: i.currentSrc }));
    ok(f.srcset === `${p1.sm} 400w, ${p1.md} 720w`, 'nos favoritos (poucos cartões, grandes) o <img> traz o srcset com as duas miniaturas', f);
    ok(f.sizes === '(min-width: 1280px) 288px, (min-width: 1024px) 256px, (min-width: 640px) 44vw, 62vw', 'e o sizes do cartão dos favoritos', f.sizes);
    ok(f.src === p1.image, 'o src dos favoritos continua sendo a foto original (reserva para navegador sem srcset)', f.src);
    ok(f.cur === p1.md, 'tela densa + cartão largo: escolheu a miniatura de 720 px', f);
    ok(!blobRequests.includes('/' + pathOf(p1.image)) && blobRequests.includes('/' + pathOf(p1.sm)) && blobRequests.includes('/' + pathOf(p1.md)), 'a foto de 1200 px nem foi baixada; as miniaturas foram', blobRequests);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'sem rolagem horizontal');
    await page.screenshot({ path: `${SP}/e2ethumbs-site.png` });
    await ctx.close();
  }

  // =============================================================================================
  console.log('# site: o pedido continua o mesmo (adicionar, quantidade e total) com a lista otimizada');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForSelector('main ul li h3');
    const add = page.getByRole('button', { name: 'Adicionar Foto pequena ao pedido' });
    await add.click();
    await page.getByRole('button', { name: 'Aumentar Foto pequena' }).click();
    ok(await until(async () => (await page.getByRole('group', { name: 'Quantidade de Foto pequena' }).innerText()).includes('2')), 'quantidade 2 no cartão');
    const bar = page.getByRole('button', { name: /Ver pedido/ }).first();
    ok(await bar.isVisible(), 'a barra do pedido aparece');
    ok(/16,00/.test(await bar.innerText()), 'total R$ 16,00 (2 × 8,00)', await bar.innerText());
    // O cartão de outro produto não foi tocado.
    ok((await page.getByRole('button', { name: 'Adicionar Foto grande ao pedido' }).count()) > 0, 'os outros cartões continuam com "Adicionar"');
    await ctx.close();
  }

  // Nenhuma foto nem miniatura sobrando no Blob: tudo que está em products/ pertence a algum produto.
  {
    const used = new Set(psql("select image_url from products where image_url is not null union select image_sm_url from products where image_sm_url is not null union select image_md_url from products where image_md_url is not null").split('\n').filter(Boolean).filter((u) => /blob\.vercel-storage\.com/.test(u)).map(pathOf));
    // As fotos "de outro endereço" (fotos-externas.example) são servidas, neste teste, por arquivos do Blob fake: contam como em uso pelo caminho.
    for (const u of psql("select image_url from products where image_url like 'https://fotos-externas.example/%'").split('\n').filter(Boolean)) used.add(pathOf(u));
    const orphans = (await blobList()).filter((f) => f.startsWith('products/') && !used.has(f));
    ok(orphans.length === 0, 'nenhum arquivo órfão em products/ no Blob', orphans);
  }
  ok(errors.length === 0, 'nenhum erro no console ou na página', errors.slice(0, 5));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH', e);
  process.exit(2);
});
