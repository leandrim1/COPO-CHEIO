// Escolha dos gelos saborizados dos combos no navegador (celular e computador).
// Ao tocar em "Adicionar" num combo que traz gelos abre "Escolha os 4 gelos saborizados": só aparecem os produtos cadastrados como gelo saborizado (nada de lista
// fixa: o tradicional, os combos e os produtos de fora não entram; esgotado aparece e não se escolhe); contador "Gelos selecionados: X de 4"; o botão de confirmar só liga
// com exatamente 4 e uma quinta unidade não entra; cancelar não adiciona nada. Cada unidade do combo é uma linha com a SUA escolha (carrinho, checkout, pedido enviado,
// acompanhamento, painel e banco); editar uma unidade não mexe nas outras; o preço do combo não muda; sabor que esgota antes de finalizar é avisado e pede nova escolha;
// combo sem gelos segue direto; o cadastro do painel manda (marcar/ desmarcar gelo e combo muda o site na hora).
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-flavors.cjs
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
fs.mkdirSync(SP, { recursive: true });
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180', BLOB = 'http://127.0.0.1:4181';
for (const event of ['unhandledRejection', 'uncaughtException']) process.on(event, (e) => { console.error('CRASH (' + event + ')', e); process.exit(2); });
let cookie = '';
async function api(method, path, body, raw) {
  const init = { method, headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) };
  let res;
  for (let i = 0; ; i++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)); } }
  const set = res.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const t = await res.text(); return { status: res.status, data: t ? JSON.parse(t) : null };
}
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -F '|' -c "${q}"`).toString().trim();
let fails = 0;
let ordersBefore = 0;
const ok = (c, msg, extra) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch { /* a tela ainda está mudando */ }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const errors = [];
async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => { try { await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + new URL(route.request().url()).pathname }) }); } catch { /* aborto ao navegar */ } });
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const cartOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('copocheio:pedido') || '{}'));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
  const img = (await api('POST', '/api/admin/upload?folder=products', fs.readFileSync(FX + '/lata.webp'), true)).data.url;
  const mkCat = async (name) => (await api('POST', '/api/admin/categories', { name })).data.category;
  const catGelos = await mkCat('Gelos');
  const catCombos = await mkCat('Combos');
  const catCerveja = await mkCat('Cervejas');
  const mk = async (name, price, category, extra = {}) => (await api('POST', '/api/admin/products', { name, price, category_id: category.id, image_url: img, description: 'Descrição de teste.', alcoholic: false, confirm_duplicate: true, ...extra })).data.product;
  const morango = await mk('Gelo de morango', 3, catGelos, { flavored_ice: true });
  const limao = await mk('Gelo de limão', 3, catGelos, { flavored_ice: true });
  const melancia = await mk('Gelo de melancia', 3, catGelos, { flavored_ice: true });
  const maracuja = await mk('Gelo de maracujá', 3, catGelos, { flavored_ice: true, sold_out: true });
  const tradicional = await mk('Gelo tradicional 4 kg', 8, catGelos);
  const redLabel = await mk('COMBO RED LABEL', 100, catCombos, { combo_ice_count: 4, featured: true });
  const smirnoff = await mk('COMBO SMIRNOFF', 80, catCombos, { combo_ice_count: 4 });
  const semGelos = await mk('COMBO SEM GELOS', 60, catCombos);
  const cerveja = await mk('Heineken Long Neck', 8, catCerveja);
  ok([morango, limao, melancia, maracuja, tradicional, redLabel, smirnoff, semGelos, cerveja].every((p) => !!p?.id), 'dados de teste criados (3 categorias; 4 gelos saborizados, 1 tradicional, 2 combos com 4 gelos, 1 combo sem gelos, 1 cerveja)');
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  const sheet = (page) => page.locator('[data-flavor-sheet]');
  const counter = (page) => page.locator('[data-flavor-counter]');
  const card = (page, name) => sheet(page).locator('li[data-flavor]').filter({ hasText: name });
  const plus = (page, name) => card(page, name).getByRole('button', { name: new RegExp(`^(Adicionar um|.*${name} esgotado)`) });
  const minus = (page, name) => card(page, name).getByRole('button', { name: /^Tirar um/ });
  const confirmBtn = (page) => sheet(page).getByRole('button', { name: /^Confirmar sabores/ });
  const addBtn = (page, name) => page.getByRole('button', { name: new RegExp(`^Adicionar (mais )?${name}`) }).first();
  const lines = (page) => page.locator('li[data-line]');
  const flatText = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ').trim();
  const pickN = async (page, name, n) => { for (let i = 0; i < n; i++) await plus(page, name).click(); };

  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# ${label}`);
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });

    // ---- Abrir a escolha ----
    await addBtn(page, 'COMBO RED LABEL').click();
    ok(await until(async () => (await sheet(page).count()) === 1), `${label}: "Adicionar" no combo com 4 gelos abre a escolha dos gelos`);
    ok(await sheet(page).getByRole('heading', { name: 'Escolha os 4 gelos saborizados' }).isVisible(), `${label}: título "Escolha os 4 gelos saborizados"`);
    ok(/Escolha os sabores dos 4 gelos que acompanham seu combo\./.test(await sheet(page).innerText()), `${label}: a instrução curta aparece`);
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 0 de 4'), `${label}: contador começa em "Gelos selecionados: 0 de 4"`, await flatText(counter(page)));
    ok(await confirmBtn(page).isDisabled(), `${label}: "Confirmar sabores e adicionar ao carrinho" começa desabilitado`);
    ok((await cartOf(page)) && Object.keys(await cartOf(page)).length === 0, `${label}: nada foi para o pedido ainda`);

    // ---- Só os sabores que existem no cadastro ----
    const names = await sheet(page).locator('li[data-flavor] p').allInnerTexts();
    ok(JSON.stringify(names.map((n) => n.trim()).sort()) === JSON.stringify(['Gelo de limão', 'Gelo de maracujá', 'Gelo de melancia', 'Gelo de morango']), `${label}: os sabores são exatamente os gelos saborizados cadastrados (sem o tradicional, sem combos, sem produtos de fora)`, names);
    ok(/ESGOTADO/.test(await card(page, 'maracujá').innerText()) && (await plus(page, 'maracujá').isDisabled()), `${label}: o sabor esgotado aparece marcado e não dá para escolher`);
    ok((await card(page, 'morango').locator('img').count()) === 1, `${label}: cada cartão traz a foto do produto`);
    ok(await noHScroll(page), `${label}: sem rolagem lateral com a janela aberta`);

    // ---- Menos de 4 ----
    await pickN(page, 'morango', 1); await pickN(page, 'limão', 1); await pickN(page, 'melancia', 1);
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 3 de 4'), `${label}: o contador atualiza na hora (3 de 4)`, await flatText(counter(page)));
    ok(await confirmBtn(page).isDisabled(), `${label}: com 3 unidades o botão continua desabilitado`);
    await confirmBtn(page).click({ force: true }).catch(() => undefined);
    ok(Object.keys(await cartOf(page)).length === 0, `${label}: tentar confirmar com menos de 4 não adiciona o combo`);

    // ---- 4 e a quinta unidade ----
    await pickN(page, 'morango', 1);
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 4 de 4') && (await confirmBtn(page).isEnabled()), `${label}: com 4 o contador fecha e o botão liga`);
    ok((await plus(page, 'limão').isDisabled()) && (await plus(page, 'melancia').isDisabled()) && (await plus(page, 'morango').isDisabled()), `${label}: com 4 escolhidos não dá para escolher uma quinta unidade`);
    await minus(page, 'morango').click();
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 3 de 4') && (await confirmBtn(page).isDisabled()) && (await plus(page, 'limão').isEnabled()), `${label}: tirando uma, o contador volta a 3 e a escolha reabre`);
    await pickN(page, 'morango', 1);

    // ---- Cancelar ----
    await sheet(page).getByRole('button', { name: 'Cancelar' }).click();
    ok(await until(async () => (await sheet(page).count()) === 0), `${label}: "Cancelar" fecha a janela`);
    ok(Object.keys(await cartOf(page)).length === 0, `${label}: cancelar não adiciona nada ao pedido`);
    await addBtn(page, 'COMBO RED LABEL').click();
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 0 de 4'), `${label}: abrir de novo começa zerado`);
    await page.keyboard.press('Escape');
    ok(await until(async () => (await sheet(page).count()) === 0), `${label}: Esc também fecha`);

    // ---- Confirmar 2 + 1 + 1 ----
    await addBtn(page, 'COMBO RED LABEL').click();
    await pickN(page, 'morango', 2); await pickN(page, 'limão', 1); await pickN(page, 'melancia', 1);
    if (vp.width === 390) {
      const box = await sheet(page).boundingBox();
      const cb = await confirmBtn(page).boundingBox();
      ok(box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 844 + 1, `${label}: a janela cabe na tela do celular`, box);
      ok(cb && cb.y >= 0 && cb.y + cb.height <= 844, `${label}: o botão de confirmar fica à vista sem rolar a página`, cb);
      ok(cb.height >= 44, `${label}: o botão de confirmar tem área de toque de 44 px ou mais`, cb.height);
      await sheet(page).screenshot({ path: `${SP}/flavors-${vp.width}-1-janela.png` });
    }
    await confirmBtn(page).click();
    ok(await until(async () => (await sheet(page).count()) === 0), `${label}: confirmar fecha a janela`);
    let cart = await cartOf(page);
    ok(Object.keys(cart).length === 1 && Object.keys(cart)[0].includes('|') && Object.values(cart)[0] === 1, `${label}: o combo entrou no pedido como UMA unidade com os sabores na linha`, cart);
    ok(Object.keys(cart)[0].startsWith(redLabel.id), `${label}: a linha é do combo escolhido`);

    // ---- Gaveta do pedido ----
    await page.getByRole('button', { name: /Ver pedido/ }).first().click().catch(() => undefined);
    ok(await until(async () => (await lines(page).count()) === 1), `${label}: o pedido (gaveta) tem a linha do combo`);
    let text = await flatText(lines(page).first());
    ok(/COMBO RED LABEL/.test(text) && /4 gelos saborizados:/.test(text) && /2 × Gelo de morango/.test(text) && /1 × Gelo de limão/.test(text) && /1 × Gelo de melancia/.test(text), `${label}: a gaveta mostra "4 gelos saborizados" e as quantidades de cada sabor`, text);
    ok(/R\$\s*100,00/.test(text), `${label}: o preço do combo continua R$ 100,00`, text);
    ok(await lines(page).first().getByRole('button', { name: /^Alterar os gelos de/ }).isVisible(), `${label}: dá para alterar os sabores`);

    // ---- Segunda unidade com outra escolha: linhas independentes ----
    await lines(page).first().getByRole('button', { name: /^Adicionar outro COMBO RED LABEL/ }).click();
    ok(await until(async () => (await sheet(page).count()) === 1), `${label}: "+" no pedido abre a escolha de uma NOVA unidade (não copia a anterior)`);
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 0 de 4'), `${label}: a nova unidade começa sem sabores`);
    await pickN(page, 'limão', 4);
    await confirmBtn(page).click();
    ok(await until(async () => (await lines(page).count()) === 2), `${label}: a segunda unidade é outra linha`);
    text = await flatText(lines(page).nth(1));
    ok(/4 × Gelo de limão/.test(text) && !/morango/.test(text), `${label}: a segunda linha tem só os SEUS sabores`, text);
    ok(/2 × Gelo de morango/.test(await flatText(lines(page).first())) && !/4 × Gelo de limão/.test(await flatText(lines(page).first())), `${label}: a primeira linha não mudou`);
    cart = await cartOf(page);
    ok(Object.keys(cart).length === 2 && Object.values(cart).every((q) => q === 1), `${label}: o carrinho guarda duas unidades independentes`, cart);

    // ---- Editar a segunda ----
    await lines(page).nth(1).getByRole('button', { name: /^Alterar os gelos de/ }).click();
    ok(await until(async () => (await sheet(page).count()) === 1), `${label}: "Alterar sabores" reabre a escolha`);
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 4 de 4') && (await card(page, 'limão').getAttribute('data-flavor-qty')) === '4', `${label}: a escolha daquela unidade já vem preenchida (4 de limão)`);
    await minus(page, 'limão').click(); await minus(page, 'limão').click();
    await pickN(page, 'melancia', 2);
    await confirmBtn(page).click();
    ok(await until(async () => /2 × Gelo de limão/.test(await flatText(lines(page).nth(1))) && /2 × Gelo de melancia/.test(await flatText(lines(page).nth(1)))), `${label}: a segunda linha ficou com 2 de limão e 2 de melancia`, await flatText(lines(page).nth(1)));
    ok(/2 × Gelo de morango/.test(await flatText(lines(page).first())), `${label}: editar uma unidade não mexe na outra`);

    // ---- Combo sem gelos e outro produto ----
    await page.keyboard.press('Escape');
    await addBtn(page, 'COMBO SEM GELOS').click();
    ok((await sheet(page).count()) === 0 && Object.keys(await cartOf(page)).length === 3, `${label}: combo SEM gelos entra direto, sem escolha`, await cartOf(page));
    await addBtn(page, 'Heineken Long Neck').click();
    ok((await sheet(page).count()) === 0 && Object.keys(await cartOf(page)).length === 4, `${label}: cerveja entra direto`);

    // ---- Checkout ----
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    ok(await until(async () => (await lines(page).count()) === 4), `${label}: o checkout lista as 4 linhas`);
    const checkoutText = await flatText(page.locator('main'));
    ok(/2 × Gelo de morango/.test(checkoutText) && /2 × Gelo de melancia/.test(checkoutText) && /COMBO SEM GELOS/.test(checkoutText), `${label}: o checkout mostra os sabores de cada unidade`);
    ok(await noHScroll(page), `${label}: checkout sem rolagem lateral`);
    await page.getByLabel('Nome *').fill('Cliente Gelos ' + label.slice(-3));
    await page.getByLabel('Telefone / WhatsApp *').fill(vp.width === 390 ? '34 99222-0001' : '34 99222-0002');
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.waitForTimeout(900);
    const expected = 100 + 100 + 60 + 8;
    ok(await until(async () => new RegExp('R\\$\\s*' + expected.toFixed(2).replace('.', ',')).test(await page.locator('main').innerText())), `${label}: o total é a soma dos preços dos itens (R$ 268,00): os gelos não acrescentam nada`, (await page.locator('main').innerText()).slice(-300));
    await page.screenshot({ path: `${SP}/flavors-${vp.width}-2-checkout.png`, fullPage: true });

    // ---- Um sabor esgota antes de finalizar ----
    await api('PATCH', `/api/admin/products/${limao.id}`, { sold_out: true });
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Gelo de limão esgotou/.test(await flatText(page.locator('main')))), `${label}: sabor que esgotou é avisado na linha do pedido`, (await flatText(page.locator('main'))).slice(0, 400));
    const countBefore = Number(psql('select count(*) from orders'));
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    ok(await until(async () => /Escolha os sabores dos gelos do combo para continuar\./.test(await flatText(page.locator('main')))), `${label}: não envia e pede nova escolha`);
    ok(Number(psql('select count(*) from orders')) === countBefore, `${label}: nenhum pedido foi criado`);
    // As duas unidades com limão precisam de nova escolha: em cada uma troca o limão (esgotado) por morango.
    let fixed = 0;
    for (let guard = 0; guard < 4 && (await lines(page).filter({ hasText: 'Gelo de limão' }).count()) > 0; guard++) {
      await lines(page).filter({ hasText: 'Gelo de limão' }).first().getByRole('button', { name: /^Alterar os gelos de/ }).click();
      ok(await until(async () => (await sheet(page).count()) === 1) && (await plus(page, 'limão').isDisabled()), `${label}: na nova escolha o sabor esgotado não pode ser escolhido`);
      if (guard === 0) ok(/Gelo de limão esgotou/.test(await sheet(page).innerText()), `${label}: a janela avisa qual sabor esgotou`);
      const had = Number(await card(page, 'limão').getAttribute('data-flavor-qty'));
      for (let i = 0; i < had; i++) await minus(page, 'limão').click();
      await pickN(page, 'morango', had);
      await confirmBtn(page).click();
      ok(await until(async () => (await sheet(page).count()) === 0), `${label}: nova escolha confirmada`);
      fixed += 1;
    }
    ok(fixed === 2, `${label}: as duas unidades com o sabor esgotado foram refeitas`, fixed);
    ok(!/esgotou/.test(await flatText(page.locator('main'))), `${label}: o aviso de esgotado some depois da nova escolha`);
    await api('PATCH', `/api/admin/products/${limao.id}`, { sold_out: false });

    // ---- Enviar ----
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').fill('Cliente Gelos ' + label.slice(-3));
    await page.getByLabel('Telefone / WhatsApp *').fill(vp.width === 390 ? '34 99222-0001' : '34 99222-0002');
    await page.getByText('Retirar na loja', { exact: true }).click();
    let posted = null;
    page.on('request', (r) => { if (r.url().endsWith('/api/orders') && r.method() === 'POST') posted = JSON.parse(r.postData() || '{}'); });
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    try {
      await page.waitForURL('**/pedido/**', { timeout: 15000 });
    } catch (e) {
      console.log('FAIL o pedido não foi enviado: ' + (await flatText(page.locator('main'))).slice(-700));
      throw e;
    }
    const combos = (posted?.items ?? []).filter((i) => i.product_id === redLabel.id);
    ok(combos.length === 2 && combos.every((i) => i.quantity === 1 && Array.isArray(i.ice_flavors) && i.ice_flavors.reduce((n, f) => n + f.quantity, 0) === 4), `${label}: o pedido enviado leva os sabores de cada unidade no próprio item (não nas observações)`, posted?.items);
    ok(!(posted?.items ?? []).some((i) => i.product_id === semGelos.id && 'ice_flavors' in i) && !/gelo|sabor/i.test(posted?.notes ?? ''), `${label}: o combo sem gelos não leva sabores e as observações ficam vazias`);
    ok(await until(async () => Object.keys(await cartOf(page)).length === 0), `${label}: depois de enviar, o pedido (carrinho) é esvaziado`);
    const orderText = await flatText(page.locator('main'));
    ok(/4 gelos saborizados/.test(orderText) && /Gelo de morango/.test(orderText) && /Gelo de melancia/.test(orderText), `${label}: a página do pedido (acompanhamento) mostra os sabores`, orderText.slice(0, 500));
    const number = Number((await page.locator('body').innerText()).match(/#(\d{4,})/)?.[1]);
    const saved = (await api('GET', `/api/admin/orders/${number}`)).data;
    const savedCombos = saved.items.filter((i) => i.product_id === redLabel.id);
    ok(savedCombos.length === 2 && savedCombos.every((i) => i.ice_flavors.reduce((n, f) => n + f.quantity, 0) === 4), `${label}: o banco gravou os sabores nas duas linhas do combo`, savedCombos.map((i) => i.ice_flavors));
    ok(Math.abs(Number(saved.order.total) - expected) < 0.001, `${label}: o total gravado é o mesmo da tela (R$ 268,00)`, saved.order.total);
    ok(savedCombos.some((i) => i.ice_flavors.some((f) => f.name === 'Gelo de morango' && f.quantity === 2)) && savedCombos.some((i) => i.ice_flavors.some((f) => f.name === 'Gelo de melancia' && f.quantity === 2)), `${label}: cada linha guarda os SEUS sabores`);
    const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]')].map((a) => a.href).find((h) => /Itens/.test(decodeURIComponent(h))) ?? '');
    ok(/gelos saborizados: .*2 × Gelo de morango/.test(decodeURIComponent(wa)), `${label}: a mensagem de WhatsApp para a loja traz os sabores`);

    // ---- Painel do dono ----
    const a = await newCtx(browser, { width: 1280, height: 900 });
    await a.page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await a.page.fill('#login-email', 'dono@copocheio.local');
    await a.page.fill('#login-senha', 'senha-forte-123');
    await a.page.click('button[type=submit]');
    await finishAdminLogin(a.page);
    await a.page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    await a.page.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
    ok(await until(async () => (await a.page.locator('[data-ice-flavors]').count()) === 2), `${label}: o painel mostra os sabores de cada linha do combo no pedido`, await a.page.locator('[data-ice-flavors]').count());
    const adminText = await flatText(a.page.locator('main'));
    ok(/2 × Gelo de morango/.test(adminText) && /2 × Gelo de melancia/.test(adminText), `${label}: painel: sabores e quantidades certos`);
    await a.ctx.close();
    await ctx.close();
  }

  // ---- O cadastro manda: o site acompanha o painel ----
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await api('PATCH', `/api/admin/products/${melancia.id}`, { active: false });
    const coco = await mk('Gelo de coco', 3, catGelos, { flavored_ice: true });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addBtn(page, 'COMBO SMIRNOFF').click();
    const names = (await sheet(page).locator('li[data-flavor] p').allInnerTexts()).map((n) => n.trim()).sort();
    ok(JSON.stringify(names) === JSON.stringify(['Gelo de coco', 'Gelo de limão', 'Gelo de maracujá', 'Gelo de morango']), 'sabor desativado sai da escolha e sabor novo cadastrado entra, sem mexer no código', names);
    await page.keyboard.press('Escape');
    await api('PATCH', `/api/admin/products/${smirnoff.id}`, { combo_ice_count: 2 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addBtn(page, 'COMBO SMIRNOFF').click();
    ok(await sheet(page).getByRole('heading', { name: 'Escolha os 2 gelos saborizados' }).isVisible(), 'a quantidade de gelos vem do cadastro do combo (2 gelos: "Escolha os 2 gelos saborizados")');
    await plus(page, 'coco').click();
    ok(await confirmBtn(page).isDisabled(), 'com 1 de 2 o botão continua desabilitado');
    await plus(page, 'coco').click();
    ok((await flatText(counter(page))).startsWith('Gelos selecionados: 2 de 2') && (await confirmBtn(page).isEnabled()), 'com 2 de 2 o botão liga');
    await sheet(page).getByRole('button', { name: 'Cancelar' }).click();
    await api('PATCH', `/api/admin/products/${smirnoff.id}`, { combo_ice_count: 0 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addBtn(page, 'COMBO SMIRNOFF').click();
    ok((await sheet(page).count()) === 0 && Object.keys(await cartOf(page)).length === 1, 'combo com 0 gelos no cadastro volta a ser adicionado direto');
    await ctx.close();
  }

  // ---- Painel: cadastro do produto ----
  {
    const a = await newCtx(browser, { width: 390, height: 844 });
    await a.page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await a.page.fill('#login-email', 'dono@copocheio.local');
    await a.page.fill('#login-senha', 'senha-forte-123');
    await a.page.click('button[type=submit]');
    await finishAdminLogin(a.page);
    await a.page.waitForURL('**/admin/dashboard', { timeout: 15000 });
    await a.page.goto(BASE + `/admin/produtos/${redLabel.id}`, { waitUntil: 'networkidle' });
    await a.page.screenshot({ path: `${SP}/flavors-admin-produto.png`, fullPage: true });
    const field = a.page.getByLabel('Gelos saborizados que vêm neste combo');
    ok((await field.inputValue()) === '4', 'painel: o combo mostra "Gelos saborizados que vêm neste combo = 4"');
    ok(await a.page.getByRole('switch', { name: 'Este produto é um gelo saborizado' }).isVisible(), 'painel: existe a chave "Este produto é um gelo saborizado"');
    await field.fill('5');
    await a.page.getByRole('button', { name: /^Salvar/ }).first().click();
    ok(await until(async () => Number(psql(`select combo_ice_count from products where id = '${redLabel.id}'`)) === 5), 'painel: salvar grava a nova quantidade de gelos do combo no banco');
    // Salvar leva de volta à lista: abre o produto de novo para devolver o valor.
    await a.page.goto(BASE + `/admin/produtos/${redLabel.id}`, { waitUntil: 'networkidle' });
    await a.page.getByLabel('Gelos saborizados que vêm neste combo').fill('4');
    await a.page.getByRole('button', { name: /^Salvar/ }).first().click();
    ok(await until(async () => Number(psql(`select combo_ice_count from products where id = '${redLabel.id}'`)) === 4), 'painel: e volta para 4');
    await a.page.goto(BASE + `/admin/produtos/${limao.id}`, { waitUntil: 'networkidle' });
    ok(await a.page.getByLabel('Gelos saborizados que vêm neste combo').isDisabled(), 'painel: num gelo saborizado o campo dos gelos do combo fica desabilitado (uma coisa ou outra)');
    await a.page.goto(BASE + '/admin/produtos', { waitUntil: 'networkidle' });
    await a.page.getByLabel('Filtrar por situação').selectOption('combo-ice');
    ok(await until(async () => (await a.page.getByText('COMBO RED LABEL').count()) > 0 && (await a.page.getByText('COMBO SEM GELOS').count()) === 0), 'painel: o filtro "Combos com gelos" mostra só combos com gelos');
    await a.page.getByLabel('Filtrar por situação').selectOption('flavored');
    ok(await until(async () => (await a.page.getByText('Gelo de limão').count()) > 0 && (await a.page.getByText('Gelo tradicional 4 kg').count()) === 0), 'painel: o filtro "Gelos saborizados" não mostra o gelo tradicional');
    await a.ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro no console ou na página', errors);
  await browser.close();
  console.log(fails ? `${fails} FALHA(S)` : 'TUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
