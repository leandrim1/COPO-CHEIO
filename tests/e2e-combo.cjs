// Aviso dos combos no navegador (celular e computador): ao adicionar um produto da categoria "Combos" aparece a observação
// "CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA."; ela também fica na linha do pedido (gaveta e checkout). Produtos de
// outras categorias não recebem nada. O aviso se fecha, some sozinho e não bloqueia a página. O botão "QUERO TROCAR O ENERGÉTICO" (no aviso e na
// linha do combo) abre a lista dos energéticos de 2L do site (só 2L): "Trocar" passa UMA unidade do combo para o energético novo e o preço do
// combo passa a levar a diferença entre os dois energéticos (o banco calcula igual); dá para trocar mais, voltar ao original, mudar na gaveta
// e no checkout, e o pedido enviado e gravado leva a troca.
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
  const catEnergy = await mkCat('ENERGÉTICOS');
  const catCopaoEnergy = await mkCat('COPÃO COM ENERGÉTICO 2L JACK POWER');
  // Energéticos: só os de 2L entram na lista (o de 473 ml, 250 ml, 2,5L e o refrigerante de 2L ficam de fora); o Jack Power é o que vem nos combos
  const jack = await mk('Energético Jack Power 2L', 12, catEnergy, { promo_price: 11 });
  const en1 = await mk('Energético Monster 473ml', 9.5, catEnergy);
  const en2 = await mk('Energético Red Bull 250ml', 10, catEnergy);
  const tropical = await mk('Energético Tropical 2L', 12.5, catEnergy);
  const fusion = await mk('Energético Fusion 2L', 13, catEnergy, { sold_out: true });
  const baly = await mk('Energético Baly 2 Litros', 14, catOther); // fora da categoria, mas o nome começa com "Energético"
  const en7 = await mk('Energético Gigante 2,5L', 15, catEnergy);
  const soda = await mk('Refrigerante Guaraná 2L', 9, catBeer);
  const copaoEn = await mk('Copão com Energético Jack Power 2L', 30, catCopaoEnergy);
  const combo = await mk('COMBO BUSCA BRISA ( 4 gelos, 1 Busca Brisa, 1 Energético Jack Power 2L )', 90, catCombos, { featured: true });
  const combo2 = await mk('COMBO GIN INVICTUS ( 4 gelos, 1 Gin Invictus, 1 Energético Jack Power 2L )', 50, catCombos);
  const combo3 = await mk('COMBO SEM ENERGÉTICO ( 4 gelos, 1 Vodka )', 60, catCombos);
  const beer = await mk('Heineken Long Neck', 8, catBeer, { featured: true });
  const other = await mk('Kit Cerveja Especial', 40, catOther);
  for (const c of [combo, combo2]) await api('PATCH', `/api/admin/products/${c.id}`, { swap_base_product_id: jack.id });
  ok([combo, combo2, combo3, beer, other, jack, en1, en2, tropical, fusion, baly, en7, soda, copaoEn].every((p) => !!p?.id), 'dados de teste criados (5 categorias, 14 produtos; os 2 combos com o Jack Power como energético)');
  const browser = await chromium.launch();
  const notice = (page) => page.locator('[data-add-notice]');
  const swapDialog = (page) => page.getByRole('dialog', { name: 'Trocar o energético' });
  const R = (n) => 'R\\$\\s*' + n.toFixed(2).replace('.', ',');
  const flat = (text) => text.replace(/\s+/g, ' ');
  const rowText = (page, id) => page.locator(`li[data-energetic="${id}"]`).evaluate((e) => e.innerText.replace(/\s+/g, ' ').trim());

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

    // Combo sem energético definido: aviso, mas sem o botão de trocar
    await addButton(page, 'COMBO SEM ENERGÉTICO').click();
    ok(await until(async () => (await notice(page).count()) === 1), `${label}: combo sem energético definido mostra o aviso`);
    ok((await notice(page).getByRole('button', { name: 'QUERO TROCAR O ENERGÉTICO' }).count()) === 0, `${label}: ...mas sem o botão "QUERO TROCAR O ENERGÉTICO" (o painel não disse qual energético vem nele)`);
    await notice(page).getByRole('button', { name: 'Fechar aviso' }).click();

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
    ok((await notice(page).getByRole('button', { name: 'QUERO TROCAR O ENERGÉTICO' }).count()) === 1, `${label}: o aviso tem o botão "QUERO TROCAR O ENERGÉTICO"`);
    await page.screenshot({ path: `${SP}/combo-${vp.width}-1-aviso.png` });

    // Fecha, e volta a aparecer ao adicionar outro combo
    await notice(page).getByRole('button', { name: 'Fechar aviso' }).click();
    ok(await until(async () => (await notice(page).count()) === 0), `${label}: o aviso se fecha no X`);
    await addButton(page, 'COMBO GIN INVICTUS').click();
    ok(await until(async () => (await notice(page).count()) === 1), `${label}: outro combo mostra o aviso de novo`);

    // "QUERO TROCAR O ENERGÉTICO": a lista de energéticos de 2L, com a diferença de preço de cada um
    await notice(page).getByRole('button', { name: 'QUERO TROCAR O ENERGÉTICO' }).click();
    const swap = swapDialog(page);
    await swap.waitFor();
    ok((await notice(page).count()) === 0, `${label}: ao abrir a lista, o aviso some`);
    const rows = await swap.locator('li[data-energetic]').evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
    ok(rows.length === 3 && (await Promise.all([tropical, baly, fusion].map((p) => swap.locator(`li[data-energetic="${p.id}"]`).count()))).every((n) => n === 1), `${label}: a lista mostra os 3 outros energéticos de 2L (o Jack Power já vem no combo)`, rows);
    ok(!rows.some((r) => /Jack Power|Monster|Red Bull|2,5L|Guaraná|Copão|Heineken|Kit Cerveja|COMBO/.test(r)), `${label}: só 2L e sem o que já vem no combo: ficam de fora o Jack Power, os de 473 ml, 250 ml e 2,5L, o refrigerante, o copão, o combo e a cerveja`, rows);
    ok(/Vem no combo: Energético Jack Power 2L/.test(await swap.innerText()) && /Energéticos de 2L/.test(await swap.innerText()) && /Obs: CASO QUEIRAM TROCAR O ENERGÉTICO POR OUTRO, PAGAR A DIFERENÇA\./.test(await swap.innerText()), `${label}: a janela diz qual energético vem no combo, que são os de 2L e repete a observação`);
    ok(/Tropical/.test(rows[0]) && /\+ R\$ 1,50/.test(rows[0]) && /Baly/.test(rows[1]) && /\+ R\$ 3,00/.test(rows[1]), `${label}: cada um mostra a diferença POR COMBO (Tropical + R$ 1,50 = 12,50 − 11,00 da promoção; Baly + R$ 3,00), do mais barato ao mais caro`, rows);
    ok(/Fusion/.test(rows[2]) && /ESGOTADO/.test(rows[2]) && (await swap.locator(`li[data-energetic="${fusion.id}"] button`).count()) === 0, `${label}: o esgotado vai para o fim, marcado e sem botão`, rows[2]);
    ok((await swap.getAttribute('aria-modal')) === 'true' && (await page.evaluate(() => document.body.style.overflow === 'hidden')), `${label}: janela modal e a página de trás não rola`);
    ok(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Fechar a lista de energéticos'), `${label}: o foco vai para o botão de fechar`);
    const sbox = await swap.boundingBox();
    ok(sbox && sbox.x >= 0 && sbox.x + sbox.width <= vp.width + 1 && sbox.y >= 0 && sbox.y + sbox.height <= vp.height + 1, `${label}: a lista cabe na tela (${Math.round(sbox?.width)}x${Math.round(sbox?.height)})`, sbox);
    await page.screenshot({ path: `${SP}/combo-${vp.width}-1b-lista.png` });

    // Trocar: UMA unidade do combo passa para o energético novo
    await swap.getByRole('button', { name: /^Trocar por Energético Tropical 2L/ }).click();
    const kt = `${combo2.id}@${tropical.id}`;
    ok(await until(async () => { const c = await cartOf(page); return c[kt] === 1 && !(combo2.id in c); }), `${label}: "Trocar" passa o combo para a linha "combo@Tropical" (continua 1 combo no total)`, await cartOf(page));
    ok(await until(async () => (await swap.locator(`li[data-energetic="${tropical.id}"] [data-qty]`).innerText()) === '1'), `${label}: o botão vira o contador (1 combo com o Tropical)`);
    ok((await swap.getByRole('button', { name: /^Trocar mais um combo por Energético Tropical/ }).isDisabled()) && /Todos os combos já estão com energético trocado/.test(await swap.innerText()), `${label}: com todos os combos trocados o "+" fica desligado e a janela explica`);
    ok((await swap.getByRole('button', { name: /^Trocar por Energético Baly/ }).isDisabled()), `${label}: ...e trocar por outro também fica desligado até voltar um`);
    await swap.getByRole('button', { name: /^Voltar ao energético original/ }).click();
    ok(await until(async () => { const c = await cartOf(page); return c[combo2.id] === 1 && !(kt in c); }), `${label}: "−" volta ao energético original (a linha normal volta)`, await cartOf(page));
    await swap.getByRole('button', { name: /^Trocar por Energético Tropical 2L/ }).click();
    ok(await until(async () => (await cartOf(page))[kt] === 1), `${label}: trocar de novo`);
    ok(/Pronto \(1 de 1 combo trocado\)/.test(await swap.getByRole('button', { name: /^Pronto/ }).innerText()), `${label}: o rodapé diz quantos combos já estão trocados`);
    await page.keyboard.press('Escape');
    ok(await until(async () => (await swapDialog(page).count()) === 0), `${label}: Esc fecha a lista`);
    ok(await page.evaluate(() => document.body.style.overflow !== 'hidden'), `${label}: ao fechar, a rolagem volta`);

    // O contador do cartão do combo soma as linhas (1 com troca)
    ok((await page.getByRole('button', { name: /^Adicionar mais COMBO GIN INVICTUS.*\(1 no pedido\)/ }).count()) + (await page.getByRole('group', { name: /^Quantidade de COMBO GIN INVICTUS/ }).count()) >= 1, `${label}: o cartão do combo continua mostrando 1 no pedido`);

    // Gaveta do pedido: preços com a diferença; só o combo normal tem "QUERO TROCAR O ENERGÉTICO"; o trocado tem "Alterar" e "Voltar ao original"
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Seu pedido' });
    await drawer.waitFor();
    ok((await notice(page).count()) === 0, `${label}: com a gaveta aberta o aviso não aparece por cima`);
    ok((await drawer.locator('li[data-line]').count()) === 5, `${label}: gaveta: 5 linhas (2 combos + sem energético + cerveja + kit)`, await drawer.locator('li[data-line]').count());
    const line2 = drawer.locator(`li[data-line="${kt}"]`);
    ok(new RegExp(R(51.5)).test(await line2.innerText()) && /Energético Tropical 2L \(\+ R\$ 1,50\)/.test(flat(await line2.innerText())), `${label}: gaveta: o combo trocado custa R$ 50,00 + R$ 1,50 = R$ 51,50 e mostra "Energético Tropical 2L (+ R$ 1,50)"`, await line2.innerText());
    ok((await line2.locator('[data-swap-undo]').count()) === 1 && (await line2.locator('[data-swap-change]').count()) === 1 && (await line2.locator('[data-swap-energetic]').count()) === 0, `${label}: gaveta: o combo trocado tem "Alterar" e "Voltar ao original" (e não o botão de trocar)`);
    ok((await drawer.locator(`li[data-line="${combo.id}"] [data-swap-energetic]`).count()) === 1 && (await drawer.locator(`li[data-line="${combo3.id}"] [data-swap-energetic]`).count()) === 0, `${label}: gaveta: o combo normal tem o botão de trocar; o sem energético definido não`);
    ok(new RegExp(R(90 + 51.5 + 60 + 8 + 40)).test(await drawer.innerText()), `${label}: gaveta: o subtotal soma a troca (90 + 51,50 + 60 + 8 + 40 = R$ 249,50)`, (await drawer.innerText()).slice(-200));
    await page.screenshot({ path: `${SP}/combo-${vp.width}-2-gaveta.png` });

    // Trocar o outro combo, de dentro da gaveta: a lista abre por cima dela
    await drawer.locator(`li[data-line="${combo.id}"] [data-swap-energetic]`).click();
    await swapDialog(page).waitFor();
    ok((await page.getByRole('dialog', { name: 'Seu pedido' }).count()) === 1, `${label}: a lista abre por cima da gaveta`);
    await swapDialog(page).getByRole('button', { name: /^Trocar por Energético Baly/ }).click();
    const kb = `${combo.id}@${baly.id}`;
    ok(await until(async () => (await cartOf(page))[kb] === 1), `${label}: trocou o outro combo pelo Baly`, await cartOf(page));
    await page.keyboard.press('Escape');
    ok(await until(async () => (await swapDialog(page).count()) === 0), `${label}: Esc fecha só a lista`);
    ok((await drawer.isVisible()) && (await page.evaluate(() => document.body.style.overflow === 'hidden')), `${label}: a gaveta continua aberta (e a página de trás travada)`);
    ok(await until(async () => new RegExp(R(93)).test(await drawer.locator(`li[data-line="${kb}"]`).innerText())), `${label}: gaveta: o combo com o Baly custa R$ 90,00 + R$ 3,00 = R$ 93,00`);
    ok(await until(async () => new RegExp(R(93 + 51.5 + 60 + 8 + 40)).test(await drawer.innerText())), `${label}: gaveta: o subtotal acompanha (93 + 51,50 + 60 + 8 + 40 = R$ 252,50)`);
    // Voltar ao original pela gaveta
    await drawer.locator(`li[data-line="${kt}"] [data-swap-undo]`).click();
    ok(await until(async () => { const c = await cartOf(page); return c[combo2.id] === 1 && !(kt in c); }), `${label}: gaveta: "Voltar ao original" devolve o combo ao energético que vem nele`, await cartOf(page));
    ok(await until(async () => new RegExp(R(93 + 50 + 60 + 8 + 40)).test(await drawer.innerText())), `${label}: ...e o preço volta a R$ 50,00 (subtotal R$ 251,00)`);
    // Tira o combo sem energético, para o resto do teste
    await drawer.getByRole('button', { name: /^Remover COMBO SEM ENERGÉTICO/ }).click();
    ok(await until(async () => !((combo3.id) in (await cartOf(page)))), `${label}: combo sem energético removido do pedido`);
    // Troca de novo o combo 2 (para ir ao checkout com duas trocas)
    await drawer.locator(`li[data-line="${combo2.id}"] [data-swap-energetic]`).click();
    await swapDialog(page).waitFor();
    await swapDialog(page).getByRole('button', { name: /^Trocar por Energético Tropical 2L/ }).click();
    await swapDialog(page).getByRole('button', { name: /^Pronto/ }).click();
    ok(await until(async () => (await cartOf(page))[kt] === 1), `${label}: o combo 2 volta a ficar com o Tropical`);

    // Checkout: os preços já levam a diferença; o pedido enviado e o gravado também
    await drawer.getByRole('link', { name: /Finalizar pedido/ }).click();
    await page.waitForURL('**/checkout');
    await page.waitForSelector('[data-swap-tag]');
    const tags = (await page.locator('[data-swap-tag]').allInnerTexts()).map(flat);
    ok(tags.length === 2 && tags.some((t) => /Energético Baly 2 Litros \(\+ R\$ 3,00\)/.test(t)) && tags.some((t) => /Energético Tropical 2L \(\+ R\$ 1,50\)/.test(t)), `${label}: checkout: as duas linhas trocadas mostram o energético e a diferença`, tags);
    ok(await noHScroll(page), `${label}: checkout sem rolagem horizontal`);
    await page.getByLabel('Nome *').fill('Cliente Troca ' + label.slice(-3));
    await page.getByLabel('Telefone / WhatsApp *').fill(vp.width === 390 ? '34 99444-0001' : '34 99444-0002');
    await page.getByText('Retirar na loja', { exact: true }).click();
    const expected = 93 + 51.5 + 8 + 40;
    ok(await until(async () => new RegExp(R(expected)).test(await page.locator('main').innerText())), `${label}: checkout: o total é a soma com as duas trocas (93 + 51,50 + 8 + 40 = R$ ${expected.toFixed(2).replace('.', ',')})`, (await page.locator('main').innerText()).slice(-300));
    await page.screenshot({ path: `${SP}/combo-${vp.width}-3-checkout.png`, fullPage: true });
    let posted = null;
    page.on('request', (r) => { if (r.url().endsWith('/api/orders') && r.method() === 'POST') posted = JSON.parse(r.postData() || '{}'); });
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    await page.waitForURL('**/pedido/**', { timeout: 15000 });
    ok(!!posted && posted.items.length === 4 && posted.items.find((i) => i.product_id === combo.id)?.swap_to === baly.id && posted.items.find((i) => i.product_id === combo2.id)?.swap_to === tropical.id && !('swap_to' in posted.items.find((i) => i.product_id === beer.id)), `${label}: o pedido enviado leva "swap_to" nos combos trocados (e a cerveja sem o campo)`, posted?.items);
    ok(String(posted?.expected_total) === expected.toFixed(2), `${label}: o total que a pessoa viu (R$ ${expected.toFixed(2)}) vai junto para o servidor conferir`, posted?.expected_total);
    ok(await until(async () => Object.keys(await cartOf(page)).length === 0), `${label}: depois de enviar, o pedido (carrinho) é esvaziado`);
    const orderText = await page.locator('main').innerText();
    ok(/troca do energético por Energético Baly 2 Litros \(\+ R\$ 3,00\)/.test(orderText) && /troca do energético por Energético Tropical 2L \(\+ R\$ 1,50\)/.test(orderText), `${label}: a página do pedido mostra as trocas e as diferenças`, orderText);
    const number = Number((await page.locator('h1').first().innerText()).match(/#?(\d{4,})/)?.[1] ?? (await page.locator('body').innerText()).match(/#(\d{4,})/)?.[1]);
    const saved = (await api('GET', `/api/admin/orders/${number}`)).data;
    ok(Math.abs(Number(saved?.order?.total) - expected) < 0.001, `${label}: o servidor gravou o MESMO total que a tela mostrava (R$ ${expected.toFixed(2)})`, saved?.order?.total);
    ok(saved?.items?.filter((i) => /troca do energético/.test(i.product_name)).length === 2, `${label}: o banco gravou as duas linhas trocadas`, saved?.items?.map((i) => i.product_name));
    const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]')].map((a) => a.href).find((h) => /Itens/.test(decodeURIComponent(h))) ?? '');
    ok(/troca do energético por Energético Baly 2 Litros/.test(decodeURIComponent(wa)), `${label}: a mensagem de WhatsApp para a loja traz a troca`);
    await ctx.close();
  }

  // O aviso some sozinho (9 s)
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'COMBO BUSCA BRISA').click();
    ok(await until(async () => (await notice(page).count()) === 1), 'o aviso aparece');
    ok(await until(async () => (await notice(page).count()) === 0, 12000), 'o aviso some sozinho depois de alguns segundos');
    await ctx.close();
  }

  // O preço da troca vem do banco: promoção que muda entre a tela e o envio é avisada (409) e o total novo é mostrado
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'COMBO BUSCA BRISA').click();
    await page.getByRole('button', { name: 'QUERO TROCAR O ENERGÉTICO' }).click();
    await swapDialog(page).getByRole('button', { name: /^Trocar por Energético Baly/ }).click();
    await swapDialog(page).getByRole('button', { name: /^Pronto/ }).click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').fill('Cliente Preço');
    await page.getByLabel('Telefone / WhatsApp *').fill('34 99555-0001');
    await page.getByText('Retirar na loja', { exact: true }).click();
    await api('PATCH', `/api/admin/products/${baly.id}`, { price: 15 }); // o energético subiu R$ 1,00 depois de a pessoa montar o pedido
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    ok(await until(async () => /mudaram|mudou|novo total/i.test(await page.locator('main').innerText())), 'preço da troca mudou antes de enviar: a tela avisa e não envia');
    ok(/COMBO BUSCA BRISA.*Baly.*R\$\s*93,00\s*→\s*R\$\s*94,00/s.test(await page.locator('main').innerText()), 'o aviso diz qual linha mudou: o combo com o Baly de R$ 93,00 para R$ 94,00', (await page.locator('main').innerText()).slice(0, 600));
    await api('PATCH', `/api/admin/products/${baly.id}`, { price: 14 });
    await ctx.close();
  }

  // Painel: o campo "Energético que vem neste combo" no cadastro do produto
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await page.waitForURL('**/admin/dashboard');
    await page.goto(BASE + `/admin/produtos/${combo3.id}`, { waitUntil: 'networkidle' });
    const field = page.getByLabel('Energético que vem neste combo');
    await field.waitFor();
    const opts = (await field.locator('option').allInnerTexts()).map(flat);
    ok(opts.length === 5 && /^Nenhum/.test(opts[0]) && ['Jack Power 2L', 'Tropical 2L', 'Fusion 2L', 'Baly 2 Litros'].every((n) => opts.some((o) => o.includes(n))), 'painel: o combo tem o campo "Energético que vem neste combo" só com energéticos de 2L (e "Nenhum")', opts);
    ok(!opts.some((o) => /Monster|Red Bull|2,5L|Guaraná|Copão/.test(o)), 'painel: nada que não seja energético de 2L na lista do campo', opts);
    ok(/Nenhum/.test(await field.evaluate((el) => el.selectedOptions[0].textContent)), 'painel: o combo sem energético definido mostra "Nenhum"');
    await field.selectOption({ label: opts.find((o) => o.includes('Jack Power 2L')) });
    await page.getByRole('button', { name: /^Salvar/ }).first().click();
    ok(await until(async () => (await api('GET', `/api/admin/products/${combo3.id}`)).data.product.swap_base_product_id === jack.id), 'painel: salvar grava o energético do combo (o combo passa a aceitar a troca)');
    await page.goto(BASE + `/admin/produtos/${beer.id}`, { waitUntil: 'networkidle' });
    await page.getByLabel('Nome').first().waitFor();
    ok((await page.getByLabel('Energético que vem neste combo').count()) === 0, 'painel: um produto que não é combo (cerveja) não mostra o campo');
    await ctx.close();
  }

  // Sem energéticos de 2L no site (categorias desativadas): o aviso e a observação continuam, mas não há botão de trocar
  {
    const patched = await api('PATCH', `/api/admin/categories/${catEnergy.id}`, { name: 'ENERGÉTICOS', active: false });
    const patched2 = await api('PATCH', `/api/admin/categories/${catOther.id}`, { name: 'Combos de cerveja', active: false });
    ok(patched.status === 200 && patched2.status === 200, 'categorias com energéticos de 2L desativadas', [patched.status, patched2.status]);
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'COMBO BUSCA BRISA').click();
    ok(await until(async () => (await notice(page).count()) === 1), 'sem energéticos de 2L: o aviso do combo continua aparecendo');
    ok((await notice(page).getByRole('button', { name: 'QUERO TROCAR O ENERGÉTICO' }).count()) === 0, 'sem energéticos de 2L: o botão "QUERO TROCAR O ENERGÉTICO" não aparece no aviso');
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Seu pedido' });
    await drawer.waitFor();
    ok((await drawer.locator('[data-combo-note]').count()) === 1 && (await drawer.locator('[data-swap-energetic]').count()) === 0, 'sem energéticos de 2L: a observação fica na linha do combo e o botão não aparece');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de página nem de console em todo o teste', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
