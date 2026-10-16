// Banner da capa da página Bebidas, de ponta a ponta no navegador: cadastro no painel (formulário, validação, prévia),
// a capa no site (celular × computador, link, carrossel, pausa, menos animação, imagem quebrada, sem "piscar" ao abrir),
// o carrossel do cardápio intacto, mover entre lugares, reordenar, desativar, excluir.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-cover.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const { execSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('node:fs').mkdirSync(SP, { recursive: true });
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180';
const BLOB = 'http://127.0.0.1:4181';
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -c "${q}"`).toString().trim();
let fails = 0;
// Espera (até 5 s) por algo que a tela mostra depois de um clique: a leitura imediata perde a corrida em máquinas lentas, como as do GitHub Actions.
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* a tela ainda está mudando: tenta de novo */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};

// ---- API do painel (para montar cenários rápido) ----------------------------------------------------
let cookie = '';
async function api(method, path, body, raw) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
const upload = async (name) => (await api('POST', '/api/admin/upload?folder=banners', fs.readFileSync(`${FX}/${name}`), true)).data.url;
const clearBanners = async () => {
  for (const b of (await api('GET', '/api/admin/banners')).data.banners) await api('DELETE', `/api/admin/banners/${b.id}`);
};

// ---- navegador ------------------------------------------------------------------------------------
const errors = [];
async function newCtx(browser, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000, deviceScaleFactor: 1, ...opts.context });
  const dead = opts.dead ?? [];
  // As imagens do Vercel Blob vêm do Blob falso local; os endereços em `dead` respondem 404 (imagem quebrada).
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (dead.some((d) => path.includes(d))) return route.fulfill({ status: 404, body: 'nope' });
    await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + path }) });
  });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  if (opts.apiDelay) {
    await page.route('**/api/site', async (route) => {
      await new Promise((r) => setTimeout(r, opts.apiDelay));
      await route.continue();
    });
  }
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}
const coverBox = (page) => page.locator('div.relative.h-44').filter({ has: page.locator('a[href="/acompanhar-pedido"]') }).first();
const iceCubes = (page) => coverBox(page).locator('img[src="/gelo.webp"]');
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const opacityOf = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).opacity));

async function adminLogin(page) {
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'dono@copocheio.local');
  await page.fill('#login-senha', 'senha-forte-123');
  await page.click('button[type=submit]');
  await finishAdminLogin(page);
  await page.waitForURL('**/admin/dashboard', { timeout: 15000 });
}
const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"] [role=status], [aria-live="polite"] [role=alert]')].map((t) => t.textContent).join(' | '));

const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  await clearBanners();
  const browser = await chromium.launch();

  // =============================================================================================
  console.log('# sem banner de capa: a capa de sempre (gelos)');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    ok((await iceCubes(page).count()) === 2, 'dois gelos na capa');
    ok((await coverBox(page).locator('picture').count()) === 0, 'nenhuma imagem de banner na capa');
    ok((await opacityOf(coverBox(page).locator('> div').first())) === 1, 'a decoração está visível depois de carregar');
    const box = await coverBox(page).boundingBox();
    ok(Math.round(box.height) === 176 && Math.round(box.width) === 390, 'capa 390 × 176 no celular', box);
    await page.screenshot({ path: `${SP}/e2ecover-0-sem.png`, clip: { x: 0, y: 0, width: 390, height: 360 } });
    await ctx.close();
  }

  // =============================================================================================
  console.log('# painel: criar o banner da capa pelo formulário');
  const { ctx: actx, page: a } = await newCtx(browser, { width: 1280, height: 900 });
  await adminLogin(a);
  await a.goto(BASE + '/admin/banners', { waitUntil: 'networkidle' });
  ok(await a.getByRole('heading', { name: 'Capa da página Bebidas' }).isVisible(), 'seção "Capa da página Bebidas"');
  ok(await a.getByRole('heading', { name: 'Carrossel do cardápio' }).isVisible(), 'seção "Carrossel do cardápio"');
  ok(await a.getByText('No site agora: a capa azul com os gelos').isVisible(), 'diz que o site mostra a capa azul com gelos');
  ok(await a.getByText('Nenhum banner de capa').isVisible(), 'estado vazio da capa');
  await a.getByRole('button', { name: 'Adicionar banner de capa' }).click();
  ok(await a.getByRole('dialog').getByRole('heading', { name: 'Novo banner de capa' }).isVisible(), 'abre "Novo banner de capa"');
  ok(await a.getByRole('radio', { name: /Capa da página/ }).isChecked(), '"Onde aparece" já vem em Capa');
  ok((await a.getByLabel('Subtítulo').count()) === 0 && (await a.getByLabel('Texto do botão').count()) === 0, 'a capa não pede subtítulo nem botão');
  ok(await a.getByTestId('cover-preview').locator('text=Envie uma imagem para ver a prévia.').isVisible(), 'prévia pede uma imagem');

  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('[role=alert]:has-text("Coloque uma imagem para a capa")');
  ok(true, 'sem imagem: "Coloque uma imagem para a capa…"');
  ok(Number(psql('select count(*) from banners')) === 0, 'nada foi criado');

  await a.setInputFiles('input[type=file][aria-label="Imagem no celular"]', `${FX}/cover-mob.webp`);
  const previewSrc = await a.getByTestId('cover-preview').locator('img').getAttribute('src');
  ok(/^blob:/.test(previewSrc ?? ''), 'a prévia mostra a imagem escolhida antes de salvar', previewSrc);
  const mobBox = await a.getByTestId('cover-preview').boundingBox();
  ok(Math.abs(mobBox.width / mobBox.height - 390 / 176) < 0.03, 'prévia do celular na proporção 390:176', mobBox);
  await a.getByText('Computador', { exact: true }).click();
  await a.waitForTimeout(150);
  const deskBox = await a.getByTestId('cover-preview').boundingBox();
  ok(Math.abs(deskBox.width / deskBox.height - 4) < 0.03, 'prévia do computador na proporção 4:1 (capa em largura total)', deskBox);
  ok(/^blob:/.test((await a.getByTestId('cover-preview').locator('img').getAttribute('src')) ?? ''), 'sem imagem de computador, a prévia usa a do celular');
  await a.setInputFiles('input[type=file][aria-label="Imagem no computador (opcional)"]', `${FX}/cover-desk.webp`);
  await a.screenshot({ path: `${SP}/e2ecover-1-form.png` });
  await a.getByLabel('Descrição da imagem').fill('Cerveja gelada em dobro');
  await a.getByLabel('Link (opcional)').fill('javascript:alert(1)');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('[role=alert]:has-text("O link precisa começar com")');
  ok(true, 'link inválido é recusado no formulário');
  await a.getByLabel('Link (opcional)').fill('/#contato');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner criado.');
  ok(/Já aparece no topo da página Bebidas/.test(await toasts(a)), 'aviso: "Já aparece no topo da página Bebidas."', await toasts(a));
  await a.waitForSelector('[data-testid=cover-card]');
  ok((await a.getByTestId('cover-card').count()) === 1, 'o banner aparece na lista da capa');
  ok(await a.getByText('No site agora: 1 banner na capa').isVisible(), 'status: 1 banner na capa');
  const row = psql("select placement || '|' || coalesce(title,'') || '|' || coalesce(link,'') || '|' || active || '|' || (image_mobile_url is not null) || '|' || (image_desktop_url is not null) from banners");
  ok(row === 'cover|Cerveja gelada em dobro|/#contato|true|true|true', 'gravado como capa, com título, link e as duas imagens', row);
  const urls = psql("select image_mobile_url || ' ' || image_desktop_url from banners").split(' ');
  ok(urls.every((u) => /^https:\/\/teststore\.public\.blob\.vercel-storage\.com\/banners\/[0-9a-f-]+\.webp$/.test(u)), 'imagens guardadas no Blob (URL https)', urls);
  const [mobUrl, deskUrl] = urls;
  await a.screenshot({ path: `${SP}/e2ecover-2-lista.png` });

  // =============================================================================================
  console.log('# site: a capa no celular e no computador');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const img = coverBox(page).locator('img[alt="Cerveja gelada em dobro"]');
    ok((await img.count()) === 1, 'a imagem do banner está na capa');
    ok((await img.evaluate((el) => el.currentSrc)) === mobUrl, 'no celular usa a imagem de celular', await img.evaluate((el) => el.currentSrc));
    ok((await img.evaluate((el) => el.naturalWidth)) > 0, 'a imagem carregou');
    ok((await opacityOf(img)) === 1, 'a imagem apareceu (fade-in terminou)');
    ok((await iceCubes(page).count()) === 0, 'os gelos saíram da capa');
    const box = await coverBox(page).boundingBox();
    ok(Math.round(box.height) === 176 && Math.round(box.width) === 390, 'a capa continua 390 × 176 (sem pulo de layout)', box);
    const imgBox = await img.boundingBox();
    ok(Math.round(imgBox.width) === 390 && Math.round(imgBox.height) === 176, 'a imagem preenche a capa', imgBox);
    const home = coverBox(page).getByRole('link', { name: 'Início' });
    const track = coverBox(page).getByRole('link', { name: /Acompanhar/ });
    ok((await home.isVisible()) && (await track.isVisible()), '"Início" e "Acompanhar" continuam por cima');
    ok((await home.getAttribute('href')) === '/' && (await track.getAttribute('href')) === '/acompanhar-pedido', 'os botões levam aos mesmos lugares');
    // o botão fica na frente da imagem: tocar nele não abre o link do banner
    const homeBox = await home.boundingBox();
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), [homeBox.x + homeBox.width / 2, homeBox.y + homeBox.height / 2]);
    ok(hit === '/', 'no ponto do botão "Início", quem recebe o toque é o botão (e não o link do banner)', hit);
    ok((await coverBox(page).locator('a[href="/#contato"]:has(img)').count()) === 1, 'a imagem é um link para /#contato');
    ok(await noHScroll(page), 'sem rolagem horizontal');
    ok(await page.locator('img[alt^="COPO CHEIO"]').isVisible(), 'a logo continua sobre a capa');
    await page.screenshot({ path: `${SP}/e2ecover-3-celular.png`, clip: { x: 0, y: 0, width: 390, height: 420 } });
    // clicar na capa segue o link
    await img.click({ position: { x: 195, y: 110 } });
    await page.waitForURL(/\/#contato$/);
    ok(true, 'tocar na capa leva ao link (/#contato)');
    await ctx.close();
  }
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    const img = coverBox(page).locator('img[alt="Cerveja gelada em dobro"]');
    ok((await img.evaluate((el) => el.currentSrc)) === deskUrl, 'no computador usa a imagem de computador', await img.evaluate((el) => el.currentSrc));
    const box = await coverBox(page).boundingBox();
    ok(Math.round(box.width) === 1280 && Math.round(box.height) === 320, 'capa em largura total (1280 × 320, proporção 4:1) no computador', box);
    ok((await coverBox(page).locator('img[alt="Cerveja gelada em dobro"]').evaluate((el) => getComputedStyle(el).objectFit)) === 'contain', 'no computador a imagem aparece inteira (object-fit: contain), sem cortes');
    await page.screenshot({ path: `${SP}/e2ecover-4-computador.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } });
    await ctx.close();
  }

  // =============================================================================================
  console.log('# site: o carrossel do cardápio não mudou (e não mistura com a capa)');
  {
    await api('POST', '/api/admin/banners', { placement: 'menu', title: 'Combo da semana', subtitle: '2 Heineken + gelo', button_text: 'Aproveitar', link: '/bebidas', image_desktop_url: await upload('b.webp') });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const carousel = page.locator('section[aria-label="Promoções"]');
    ok((await carousel.count()) === 1, 'o carrossel do cardápio existe');
    ok(/Combo da semana/.test(await carousel.innerText()) && /Aproveitar/.test(await carousel.innerText()), 'mostra título, subtítulo e botão do banner do cardápio');
    ok(!(await carousel.locator('img[alt="Cerveja gelada em dobro"]').count()), 'o banner da capa não aparece no carrossel do cardápio');
    ok((await coverBox(page).locator('img[alt="Cerveja gelada em dobro"]').count()) === 1, 'e o do cardápio não vai para a capa');
    await ctx.close();
  }

  // =============================================================================================
  console.log('# carrossel da capa: dois banners');
  const second = (await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Combo festa', image_mobile_url: await upload('cover2-mob.webp'), image_desktop_url: await upload('cover2-desk.webp') })).data.banner;
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const group = page.getByRole('group', { name: 'Destaques da loja' });
    ok((await group.count()) === 1, 'com dois banners vira carrossel (grupo "Destaques da loja")');
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    ok((await dots.count()) === 2, 'dois pontos de navegação');
    ok((await dots.nth(0).getAttribute('aria-current')) === 'true', 'o primeiro está ativo');
    const slideA = coverBox(page).locator('a:has(img[alt="Cerveja gelada em dobro"])');
    const slideB = coverBox(page).locator('div:has(> picture img[alt="Combo festa"])');
    ok((await opacityOf(slideA)) === 1 && (await opacityOf(slideB)) === 0, 'só o primeiro aparece');
    ok((await slideB.getAttribute('aria-hidden')) === 'true' && (await slideA.getAttribute('aria-hidden')) === 'false', 'o escondido sai da leitura de tela');
    ok((await slideA.getAttribute('tabindex')) === '0', 'o link do banner ativo é focável');
    await dots.nth(1).click();
    await page.waitForTimeout(900);
    ok((await dots.nth(1).getAttribute('aria-current')) === 'true' && (await opacityOf(slideB)) === 1 && (await opacityOf(slideA)) === 0, 'tocar no 2º ponto mostra o 2º banner');
    await page.screenshot({ path: `${SP}/e2ecover-5-dois.png`, clip: { x: 0, y: 0, width: 390, height: 260 } });
    // pausa com o mouse em cima não se aplica a toque; aqui o relógio roda sozinho
    await page.mouse.move(5, 700);
    await page.waitForTimeout(7200);
    ok((await dots.nth(0).getAttribute('aria-current')) === 'true' && (await opacityOf(slideA)) === 1, 'sozinho, volta para o 1º depois de ~6 s');
    await ctx.close();
  }
  {
    // teclado: com o foco num ponto (foco visível), o carrossel para; sair do foco, volta
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    await page.mouse.move(5, 5);
    await page.keyboard.press('Tab');
    await page.evaluate(() => document.querySelector('button[aria-label^="Ver destaque"]').focus({ focusVisible: true }));
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    ok(await until(() => page.evaluate(() => document.activeElement?.matches('button[aria-label^="Ver destaque"]:focus-visible'))), 'foco do teclado está num ponto');
    await page.waitForTimeout(6800);
    ok((await dots.nth(0).getAttribute('aria-current')) === 'true', 'com o foco do teclado nos pontos, o carrossel fica parado');
    await page.evaluate(() => document.activeElement.blur());
    await page.waitForTimeout(6600);
    ok((await dots.nth(1).getAttribute('aria-current')) === 'true', 'tirou o foco, volta a girar');
    await ctx.close();
  }
  {
    // menos animação: não troca sozinho
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { context: { reducedMotion: 'reduce' } });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(7000);
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    ok((await dots.nth(0).getAttribute('aria-current')) === 'true', 'com "reduzir movimento", não troca sozinho (7 s depois ainda no 1º)');
    await dots.nth(1).click();
    await page.waitForTimeout(400);
    ok((await dots.nth(1).getAttribute('aria-current')) === 'true', '…mas os pontos continuam funcionando');
    await ctx.close();
  }
  {
    // mouse em cima pausa
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    const box = await coverBox(page).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(7000);
    ok((await dots.nth(0).getAttribute('aria-current')) === 'true', 'com o mouse em cima, o carrossel fica parado');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200); // fora da capa (ela agora ocupa a largura toda)
    await page.waitForTimeout(6600);
    ok((await dots.nth(1).getAttribute('aria-current')) === 'true', 'tirou o mouse, volta a girar');
    await ctx.close();
  }

  // =============================================================================================
  console.log('# painel: ordem, ativar/desativar, mover de lugar, excluir');
  await a.goto(BASE + '/admin/banners', { waitUntil: 'networkidle' });
  const coverTitles = () => a.getByTestId('cover-card').locator('img').evaluateAll((imgs) => imgs.map((i) => i.alt));
  ok(JSON.stringify(await coverTitles()) === JSON.stringify(['Capa: Cerveja gelada em dobro', 'Capa: Combo festa']), 'lista da capa na ordem de criação', await coverTitles());
  ok((await a.getByRole('button', { name: 'Subir' }).first().isDisabled()), 'o primeiro não sobe');
  await a.getByTestId('cover-card').first().getByRole('button', { name: 'Descer' }).click();
  await a.waitForTimeout(500);
  ok(JSON.stringify(await coverTitles()) === JSON.stringify(['Capa: Combo festa', 'Capa: Cerveja gelada em dobro']), 'Descer troca a ordem na tela', await coverTitles());
  const siteCover = (await api('GET', '/api/site')).data.cover_banners.map((b) => b.title);
  ok(JSON.stringify(siteCover) === JSON.stringify(['Combo festa', 'Cerveja gelada em dobro']), 'e no site (a ordem foi salva)', siteCover);
  ok((await a.getByRole('heading', { name: 'Carrossel do cardápio' }).isVisible()) && (await a.getByText('Combo da semana').count()) === 1, 'o carrossel do cardápio não foi mexido');

  // desativar pelo interruptor
  await a.getByTestId('cover-card').first().getByRole('switch').click();
  await a.waitForSelector('text=Banner desativado.');
  ok((await api('GET', '/api/site')).data.cover_banners.length === 1, 'desativado: sai do site');
  ok(await a.getByTestId('cover-card').first().getByText('Inativo').isVisible(), 'o cartão mostra "Inativo"');
  ok(await a.getByText('No site agora: 1 banner na capa').isVisible(), 'o status acompanha (1 banner na capa)');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    ok((await coverBox(page).locator('button[aria-label^="Ver destaque"]').count()) === 0 && (await coverBox(page).locator('img[alt="Cerveja gelada em dobro"]').count()) === 1, 'com um só banner ativo: sem pontos e sem carrossel');
    ok((await page.getByRole('group', { name: 'Destaques da loja' }).count()) === 0, 'e sem o papel de carrossel');
    await ctx.close();
  }
  await a.getByTestId('cover-card').first().getByRole('switch').click();
  await a.waitForSelector('text=Banner ativado.');

  // mover o banner do cardápio para a capa (editar → Onde aparece)
  const menuCard = a.locator('li').filter({ hasText: 'Combo da semana' });
  await menuCard.getByRole('button', { name: 'Editar banner' }).click();
  ok(await a.getByRole('radio', { name: /Carrossel do cardápio/ }).isChecked(), 'ao editar, "Onde aparece" mostra o lugar atual');
  await a.getByRole('radio', { name: /Capa da página/ }).check({ force: true });
  ok(await a.getByRole('dialog').getByRole('heading', { name: 'Editar banner de capa' }).isVisible(), 'o título do formulário acompanha');
  ok((await a.getByTestId('cover-preview').locator('img').count()) === 1, 'a prévia já mostra a imagem que o banner tinha');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner salvo.');
  await a.waitForTimeout(400);
  ok((await a.getByTestId('cover-card').count()) === 3, 'o banner passou para a lista da capa');
  const moved = psql("select placement || '|' || position from banners where title = 'Combo da semana'");
  ok(moved === 'cover|2', 'foi para o fim da fila da capa (posição 2)', moved);
  ok((await api('GET', '/api/site')).data.banners.length === 0, 'e saiu do carrossel do cardápio');
  ok(/Aproveitar|2 Heineken/.test(psql("select coalesce(button_text,'') || coalesce(subtitle,'') from banners where title = 'Combo da semana'")), 'subtítulo e botão antigos ficam guardados (não são apagados)');
  // e volta
  await a.getByTestId('cover-card').nth(2).getByRole('button', { name: 'Editar banner' }).click();
  await a.getByRole('radio', { name: /Carrossel do cardápio/ }).check({ force: true });
  ok((await a.getByLabel('Subtítulo').inputValue()) === '2 Heineken + gelo', 'voltando ao cardápio, o subtítulo está lá');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner salvo.');
  await a.waitForTimeout(400);
  ok((await a.getByTestId('cover-card').count()) === 2, 'voltou para o carrossel do cardápio');
  ok((await api('GET', '/api/site')).data.banners.length === 1, 'e para o site');

  // um banner do cardápio só com título não pode ir para a capa
  await api('POST', '/api/admin/banners', { placement: 'menu', title: 'Só texto' });
  await a.reload({ waitUntil: 'networkidle' });
  await a.locator('li').filter({ hasText: 'Só texto' }).getByRole('button', { name: 'Editar banner' }).click();
  await a.getByRole('radio', { name: /Capa da página/ }).check({ force: true });
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('[role=alert]:has-text("Coloque uma imagem para a capa")');
  ok(psql("select placement from banners where title = 'Só texto'") === 'menu', 'sem imagem não vai para a capa (e nada muda no banco)');
  await a.getByRole('button', { name: 'Cancelar' }).click();

  // editar sem mexer em nada mantém o link vazio (antes o formulário inventava /bebidas)
  const noLink = (await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Sem link', image_mobile_url: await upload('a.png') })).data.banner;
  await a.reload({ waitUntil: 'networkidle' });
  await a.getByTestId('cover-card').filter({ has: a.locator('img[alt="Capa: Sem link"]') }).getByRole('button', { name: 'Editar banner' }).click();
  ok((await a.getByLabel('Link (opcional)').inputValue()) === '', 'banner sem link abre com o link vazio');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner salvo.');
  ok(psql(`select coalesce(link,'(vazio)') from banners where id = '${noLink.id}'`) === '(vazio)', 'e continua sem link depois de salvar');

  // trocar a imagem pelo formulário apaga a antiga do Blob
  const blobList = async () => (await (await fetch(`${BLOB}/__files`)).json());
  const beforeFiles = await blobList();
  const oldMobile = psql(`select image_mobile_url from banners where id = '${noLink.id}'`);
  await a.getByTestId('cover-card').filter({ has: a.locator('img[alt="Capa: Sem link"]') }).getByRole('button', { name: 'Editar banner' }).click();
  await a.setInputFiles('input[type=file][aria-label="Imagem no celular"]', `${FX}/cover2-mob.webp`);
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner salvo.');
  const afterFiles = await blobList();
  const oldPath = new URL(oldMobile).pathname.slice(1);
  ok(beforeFiles.includes(oldPath) && !afterFiles.includes(oldPath), 'trocar a imagem no formulário apaga a antiga do Blob');
  ok(psql(`select image_mobile_url from banners where id = '${noLink.id}'`) !== oldMobile, 'e grava a nova URL');

  // excluir pelo painel
  await clearBanners();
  await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Para excluir', image_mobile_url: await upload('a.png') });
  await a.reload({ waitUntil: 'networkidle' });
  const doomed = psql("select image_mobile_url from banners where title = 'Para excluir'");
  await a.getByTestId('cover-card').getByRole('button', { name: 'Excluir banner' }).click();
  await a.getByRole('dialog').getByRole('button', { name: 'Excluir banner' }).click();
  await a.waitForSelector('text=Banner excluído.');
  await a.waitForSelector('text=Nenhum banner de capa');
  ok(Number(psql('select count(*) from banners')) === 0, 'excluído do banco');
  ok(!(await blobList()).includes(new URL(doomed).pathname.slice(1)), 'e a imagem saiu do Blob');
  ok(await a.getByText('No site agora: a capa azul com os gelos').isVisible(), 'o status volta a "capa azul com os gelos"');
  ok((await api('GET', '/api/site')).data.cover_banners.length === 0, 'o site volta à capa de sempre');
  ok(await noHScroll(a), 'painel sem rolagem horizontal (1280)');

  // =============================================================================================
  console.log('# site: imagem que não abre → volta a capa de sempre');
  {
    await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Quebrado', image_desktop_url: 'https://teststore.public.blob.vercel-storage.com/banners/nao-existe.webp' });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { dead: ['nao-existe'] });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    ok((await coverBox(page).locator('picture').count()) === 0, 'a imagem quebrada sai da capa (nada de ícone de imagem quebrada)');
    ok((await iceCubes(page).count()) === 2 && (await opacityOf(coverBox(page).locator('> div').first())) === 1, 'os gelos voltam e ficam visíveis');
    await page.screenshot({ path: `${SP}/e2ecover-6-quebrada.png`, clip: { x: 0, y: 0, width: 390, height: 300 } });
    await ctx.close();
    // uma boa e uma quebrada: só a boa fica
    await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Boa', image_mobile_url: await upload('cover-mob.webp') });
    const two = await newCtx(browser, { width: 390, height: 844 }, { dead: ['nao-existe'] });
    await two.page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await two.page.waitForTimeout(900);
    ok((await coverBox(two.page).locator('img[alt="Boa"]').count()) === 1 && (await coverBox(two.page).locator('img[alt="Quebrado"]').count()) === 0, 'com uma boa e uma quebrada, só a boa aparece');
    ok((await coverBox(two.page).locator('button[aria-label^="Ver destaque"]').count()) === 0, 'e sem pontos (ficou um só)');
    ok((await iceCubes(two.page).count()) === 0, 'sem gelos');
    await two.ctx.close();
  }

  // =============================================================================================
  console.log('# site: a capa não "pisca" na primeira abertura');
  {
    await clearBanners();
    const goodMob = await upload('cover-mob.webp');
    await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Sem piscar', image_mobile_url: goodMob });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { apiDelay: 1500 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'commit' });
    await page.waitForTimeout(700);
    const earlyIce = await iceCubes(page).count();
    const earlyOpacity = earlyIce ? await opacityOf(coverBox(page).locator('> div').first()) : 0;
    ok(earlyIce === 0 || earlyOpacity === 0, 'sem cópia salva, enquanto o site carrega os gelos NÃO aparecem (só o azul liso)', { earlyIce, earlyOpacity });
    ok((await coverBox(page).locator('picture').count()) === 0, 'e o banner ainda não chegou');
    await page.waitForSelector('img[alt="Sem piscar"]', { timeout: 8000 });
    await page.waitForTimeout(900);
    ok((await opacityOf(coverBox(page).locator('img[alt="Sem piscar"]'))) === 1 && (await iceCubes(page).count()) === 0, 'depois que chega, aparece o banner (e nunca os gelos)');
    // segunda visita: usa a cópia salva e já abre com o banner, mesmo com a API demorando
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(700);
    ok((await coverBox(page).locator('img[alt="Sem piscar"]').count()) === 1 && (await iceCubes(page).count()) === 0, 'segunda visita: o banner já está lá antes da API responder');
    await ctx.close();
  }
  {
    // sem banner e sem cópia: os gelos entram suavemente quando o site termina de carregar
    await clearBanners();
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { apiDelay: 1500 });
    const answered = page.waitForResponse((r) => r.url().includes('/api/site'));
    await page.goto(BASE + '/bebidas', { waitUntil: 'commit' });
    await page.waitForTimeout(700);
    const o1 = (await iceCubes(page).count()) ? await opacityOf(coverBox(page).locator('> div').first()) : 0;
    await answered;
    await page.waitForTimeout(900);
    const o2 = await opacityOf(coverBox(page).locator('> div').first());
    ok(o1 === 0 && o2 === 1, 'sem banner: a capa de gelos entra depois de carregar (antes invisível, depois visível)', { o1, o2 });
    await ctx.close();
  }

  // =============================================================================================
  console.log('# painel no celular');
  {
    await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Celular', image_mobile_url: await upload('cover-mob.webp') });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await adminLogin(page);
    await page.goto(BASE + '/admin/banners', { waitUntil: 'networkidle' });
    ok(await noHScroll(page), 'lista sem rolagem horizontal (390)');
    await page.getByRole('button', { name: 'Adicionar banner de capa' }).click();
    ok(await page.getByTestId('cover-preview').isVisible(), 'a prévia aparece no celular');
    const modalOverflow = await page.getByRole('dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    ok(modalOverflow, 'o formulário cabe na largura do celular');
    await page.screenshot({ path: `${SP}/e2ecover-7-painel-celular.png` });
    await ctx.close();
  }

  await actx.close();
  await clearBanners();
  await browser.close();
  ok(errors.length === 0, 'nenhum erro de JavaScript no console', errors.slice(0, 5));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
