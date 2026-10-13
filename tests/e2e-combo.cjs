// Aviso dos combos no navegador (celular e computador): ao adicionar um produto da categoria "Combos" aparece a observação
// "CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA."; ela também fica na linha do pedido (gaveta e checkout). Produtos de
// outras categorias não recebem nada. O aviso se fecha, some sozinho e não bloqueia a página.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-combo.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
fs.mkdirSync(SP, { recursive: true });
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180', BLOB = 'http://127.0.0.1:4181';
const NOTE = 'CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA.';
let cookie = '';
async function api(method, path, body, raw) {
  const init = { method, headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) };
  let res;
  for (let i = 0; ; i++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)); } }
  const set = res.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const t = await res.text(); return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
const ok = (c, msg, extra) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
// Espera (até 6 s) por algo que a tela mostra depois de um clique: a leitura imediata perde a corrida em máquinas lentas.
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch { /* a tela ainda está mudando */ }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const errors = [];
async function newCtx(browser, viewport, init) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => { await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + new URL(route.request().url()).pathname }) }); });
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}

const dialog = (page) => page.getByRole('dialog');
const cartOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('copocheio:pedido') || '{}'));
const addButton = (page, name) => page.getByRole('button', { name: new RegExp(`^Adicionar (mais )?${name}`) }).first();
const money = (n) => n.toFixed(2).replace('.', ',');
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  await api('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
  const img = (await api('POST', '/api/admin/upload?folder=products', fs.readFileSync(FX + '/lata.webp'), true)).data.url;
  const mkCat = async (name) => (await api('POST', '/api/admin/categories', { name })).data.category;
  const catCombos = await mkCat('COMBOS');
  const catBeer = await mkCat('Cervejas');
  const catOther = await mkCat('Combos de cerveja');
  const mk = async (name, price, category, extra = {}) => (await api('POST', '/api/admin/products', { name, price, category_id: category.id, image_url: img, description: 'Descrição de teste.', confirm_duplicate: true, ...extra })).data.product;
  const combo = await mk('COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L )', 90, catCombos, { featured: true });
  const combo2 = await mk('COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L )', 50, catCombos);
  const beer = await mk('Heineken Long Neck', 8, catBeer, { featured: true });
  const other = await mk('Kit Cerveja Especial', 40, catOther);
  ok(!!combo?.id && !!combo2?.id && !!beer?.id && !!other?.id, 'dados de teste criados (3 categorias, 4 produtos)');
  const browser = await chromium.launch();
  const notice = (page) => page.locator('[data-add-notice]');

  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# ${label}`);
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });

    // Produto de outra categoria: nada de aviso
    await addButton(page, 'Heineken Long Neck').click();
    ok(await until(async () => (await cartOf(page))[beer.id] === 1), `${label}: cerveja entra no pedido`, await cartOf(page));
    await page.waitForTimeout(500);
    ok((await notice(page).count()) === 0, `${label}: cerveja NÃO mostra o aviso dos combos`);
    await addButton(page, 'Kit Cerveja Especial').click();
    ok(await until(async () => (await cartOf(page))[other.id] === 1), `${label}: produto de "Combos de cerveja" entra no pedido`);
    await page.waitForTimeout(500);
    ok((await notice(page).count()) === 0, `${label}: categoria parecida ("Combos de cerveja") também NÃO mostra o aviso (só a categoria "Combos")`);

    // Combo: aviso na hora de adicionar
    await addButton(page, 'COMBO BUSCA BRISA').click();
    ok(await until(async () => (await cartOf(page))[combo.id] === 1), `${label}: combo entra no pedido`, await cartOf(page));
    ok(await until(async () => (await notice(page).count()) === 1), `${label}: ao adicionar o combo aparece o aviso`);
    const text = await notice(page).innerText();
    ok(text.includes('Combo adicionado ao pedido.') && text.includes(`Obs: ${NOTE}`), `${label}: o aviso traz "Obs: ${NOTE}"`, text);
    ok((await page.getByRole('status').filter({ has: page.locator('[data-add-notice]') }).count()) === 1, `${label}: o aviso fica numa região role="status" (leitor de tela anuncia sem tirar o foco)`);
    const box = await notice(page).boundingBox();
    ok(box && box.x >= 0 && box.x + box.width <= vp.width + 1 && box.y >= 0 && box.y + box.height <= vp.height, `${label}: o aviso cabe na tela (${Math.round(box?.width)}x${Math.round(box?.height)})`, box);
    ok(await noHScroll(page), `${label}: sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/combo-${vp.width}-1-aviso.png` });

    // Fecha, e volta a aparecer ao adicionar outro combo
    await notice(page).getByRole('button', { name: 'Fechar aviso' }).click();
    ok(await until(async () => (await notice(page).count()) === 0), `${label}: o aviso se fecha no X`);
    await addButton(page, 'COMBO GIN INVICTUS').click();
    ok(await until(async () => (await notice(page).count()) === 1), `${label}: outro combo mostra o aviso de novo`);

    // Gaveta do pedido: o aviso some e a observação fica na linha de cada combo (só dos combos)
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Seu pedido' });
    await drawer.waitFor();
    ok((await notice(page).count()) === 0, `${label}: com a gaveta aberta o aviso não aparece por cima`);
    const notes = await drawer.locator('[data-combo-note]').allInnerTexts();
    ok(notes.length === 2 && notes.every((n) => n.trim() === `Obs: ${NOTE}`), `${label}: gaveta: os 2 combos mostram "Obs: ${NOTE}"`, notes);
    ok((await drawer.locator('li[data-line]').count()) === 4, `${label}: gaveta: 4 linhas (2 combos + cerveja + kit); só os combos têm a observação`);
    await page.screenshot({ path: `${SP}/combo-${vp.width}-2-gaveta.png` });

    // Checkout: a observação também aparece no resumo
    await drawer.getByRole('link', { name: /Finalizar pedido/ }).click();
    await page.waitForURL('**/checkout');
    await page.waitForSelector('[data-combo-note]');
    const cnotes = await page.locator('[data-combo-note]').allInnerTexts();
    ok(cnotes.length === 2 && cnotes.every((n) => n.trim() === `Obs: ${NOTE}`), `${label}: checkout: os 2 combos mostram a observação`, cnotes);
    ok(await noHScroll(page), `${label}: checkout sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/combo-${vp.width}-3-checkout.png` });
    await ctx.close();
  }

  // O aviso some sozinho (9 s) — e o texto do pedido não é alterado (o aviso é só da tela)
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'COMBO BUSCA BRISA').click();
    ok(await until(async () => (await notice(page).count()) === 1), 'o aviso aparece');
    ok(await until(async () => (await notice(page).count()) === 0, 12000), 'o aviso some sozinho depois de alguns segundos');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de página nem de console em todo o teste', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
