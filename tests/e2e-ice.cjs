// Escolha obrigatória do gelo (Copão e Copão com Monster) no navegador, em celular e computador: a pergunta ao adicionar, a mensagem ao
// tentar continuar sem escolher, o destaque da opção, trocar a escolha, linhas separadas por gelo, editar no pedido, guardar ao recarregar,
// checkout, página do pedido, WhatsApp, painel (pedido, recibo e Categorias), pedido antigo sem escolha, regra mudando no meio da compra,
// teclado e leitor de tela, e produtos de outras categorias intactos.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-ice.cjs
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
const MESSAGE = 'Escolha o tipo de gelo para continuar.';
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
// Envia o pedido e espera a página do pedido; se não chegar, mostra o aviso que a tela deu (em vez de só estourar o tempo).
async function placeOrder(page) {
  let last = null;
  const onResponse = async (r) => { if (r.url().endsWith('/api/orders') && r.request().method() === 'POST') last = `${r.status()} ${await r.text().catch(() => '')} | enviado: fill_ms=${JSON.parse(r.request().postData() || '{}').fill_ms} website=${JSON.stringify(JSON.parse(r.request().postData() || '{}').website)}`; };
  page.on('response', onResponse);
  // O servidor desconfia de quem envia o formulário em menos de 0,6 s (robô): uma pessoa leva mais que isso, o teste também.
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
  try {
    await page.waitForURL('**/pedido/**', { timeout: 15000 });
    return true;
  } catch {
    console.log('  (o pedido não foi enviado) avisos na tela:', JSON.stringify(await page.getByRole('alert').allInnerTexts()), 'url', page.url(), 'resposta', last);
    return false;
  } finally {
    page.off('response', onResponse);
  }
}
const radioState = (page) => page.getByRole('dialog').getByRole('radio').evaluateAll((els) => els.map((e) => e.checked));

(async () => {
  // ---- dados --------------------------------------------------------------------------------------
  await api('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
  const img = (await api('POST', '/api/admin/upload?folder=products', fs.readFileSync(FX + '/lata.webp'), true)).data.url;
  const mkCat = async (name, ice) => (await api('POST', '/api/admin/categories', { name, ice_choice_required: ice })).data.category;
  const catMonster = await mkCat('Copão com Monster', true);
  const catCopao = await mkCat('Copão', true);
  const catBeer = await mkCat('Cervejas', false);
  const mk = async (name, price, category, extra = {}) => (await api('POST', '/api/admin/products', { name, price, category_id: category.id, image_url: img, description: 'Descrição de teste.', confirm_duplicate: true, ...extra })).data.product;
  const m1 = await mk('Copão Monster Original', 25, catMonster, { featured: true });
  const m2 = await mk('Copão Monster Mango', 27, catMonster);
  const c1 = await mk('Copão de Gin Tônica', 18, catCopao, { promo_price: 15 });
  const beer = await mk('Heineken Long Neck', 8, catBeer, { featured: true });
  const beer2 = await mk('Brahma Lata 350ml', 5, catBeer);
  ok(!!m1?.id && !!c1?.id && !!beer?.id, 'dados de teste criados (3 categorias, 5 produtos)');
  const browser = await chromium.launch();

  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# ${label}: adicionar, escolher, trocar`);
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });

    // Produto de outra categoria: entra direto, sem pergunta
    await addButton(page, 'Heineken Long Neck').click();
    ok(await until(async () => (await cartOf(page))[beer.id] === 1), `${label}: cerveja entra direto no pedido (chave só com o id, como sempre)`, await cartOf(page));
    ok((await dialog(page).count()) === 0, `${label}: nenhuma pergunta de gelo para produto de outra categoria`);

    // Copão: a pergunta aparece
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    const dlgText = await dialog(page).innerText();
    ok(/Qual gelo você prefere\?/.test(dlgText) && /\*/.test(dlgText), `${label}: pergunta "Qual gelo você prefere? *" (com o asterisco de obrigatório)`, dlgText);
    ok(/Gelo normal/.test(dlgText) && /Gelo de sabor/.test(dlgText) && /🧊/.test(dlgText) && /🍓/.test(dlgText), `${label}: duas opções, "🧊 Gelo normal" e "🍓 Gelo de sabor"`, dlgText);
    ok((await dialog(page).getByRole('radio').count()) === 2 && (await radioState(page)).every((c) => !c), `${label}: são dois botões de escolha, nenhum marcado de início`);
    ok((await dialog(page).getAttribute('aria-labelledby')) && /Copão Monster Original/.test(await dialog(page).getByRole('heading').innerText()), `${label}: a janela tem o nome do produto (leitor de tela)`);
    ok((await dialog(page).getByRole('radiogroup').getAttribute('aria-required')) === 'true', `${label}: o grupo está marcado como obrigatório (aria-required)`);
    ok(!Object.keys(await cartOf(page)).some((k) => k.startsWith(m1.id)), `${label}: nada foi para o pedido ainda`);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-1-pergunta.png` });

    // Tenta continuar sem escolher
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await dialog(page).getByRole('alert').innerText()) === MESSAGE), `${label}: sem escolher, aparece "${MESSAGE}"`, await dialog(page).innerText());
    ok((await dialog(page).count()) === 1 && !Object.keys(await cartOf(page)).some((k) => k.startsWith(m1.id)), `${label}: a janela continua aberta e nada foi adicionado`);
    ok((await dialog(page).getByRole('radiogroup').getAttribute('aria-invalid')) === 'true', `${label}: o grupo fica marcado como inválido (leitor de tela)`);
    ok(await page.evaluate(() => document.activeElement?.getAttribute('type') === 'radio'), `${label}: o foco vai para a primeira opção`);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-2-mensagem.png` });

    // Escolhe, destaca, troca
    const border = (sel) => dialog(page).locator(`label[data-ice=${sel}]`).evaluate((el) => getComputedStyle(el).borderColor);
    await dialog(page).locator('label[data-ice=normal]').click();
    ok(await until(async () => (await dialog(page).getByRole('alert').count()) === 0), `${label}: ao escolher, a mensagem some`);
    ok(JSON.stringify(await radioState(page)) === '[true,false]', `${label}: "Gelo normal" fica marcado`, await radioState(page));
    await page.waitForTimeout(350); // a borda muda com uma transição de 200 ms
    const selected = await border('normal');
    const other = await border('flavored');
    ok(/^rgba?\(37, 99, 255(, 1)?\)$/.test(selected) && other !== selected && other.startsWith('rgba(255, 255, 255'), `${label}: a opção escolhida tem destaque (borda azul da marca) e a outra fica discreta`, { selected, other });
    await dialog(page).locator('label[data-ice=flavored]').click();
    ok(JSON.stringify(await radioState(page)) === '[false,true]', `${label}: dá para trocar a escolha antes de adicionar (agora "Gelo de sabor")`, await radioState(page));
    ok(!Object.keys(await cartOf(page)).some((k) => k.startsWith(m1.id)), `${label}: trocar de ideia não adiciona nada`);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-3-escolhido.png` });
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await cartOf(page))[`${m1.id}:flavored`] === 1), `${label}: gelo de sabor adicionado (linha produto:gelo)`, await cartOf(page));
    ok(!(m1.id in (await cartOf(page))), `${label}: sem linha "pura" do copão (a escolha é obrigatória)`);
    ok(await until(async () => (await dialog(page).count()) === 0), `${label}: a janela fecha depois de adicionar`);

    // Segundo copão igual, outro gelo: linha separada
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    ok((await radioState(page)).every((c) => !c), `${label}: ao adicionar de novo, a pergunta volta sem nada marcado (escolha explícita a cada vez)`);
    await dialog(page).locator('label[data-ice=normal]').click();
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => { const c = await cartOf(page); return c[`${m1.id}:normal`] === 1 && c[`${m1.id}:flavored`] === 1; }), `${label}: o mesmo copão com outro gelo vira outra linha (cada personalização separada)`, await cartOf(page));
    ok(await until(async () => (await page.locator(`[data-in-order="2"]`).count()) >= 1), `${label}: o cartão do produto mostra quantos já estão no pedido (2)`);
    await addButton(page, 'Copão Monster Mango').click();
    await dialog(page).waitFor();
    await dialog(page).locator('label[data-ice=flavored]').click();
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await cartOf(page))[`${m2.id}:flavored`] === 1), `${label}: outro copão, com gelo de sabor`);
    // Copão em promoção: a categoria "Copão" também pergunta, e o preço mostrado é o promocional
    await addButton(page, 'Copão de Gin Tônica').click();
    await dialog(page).waitFor();
    ok(/15,00/.test(await dialog(page).innerText()) && /R\$\s15,00/.test(await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).innerText()), `${label}: categoria "Copão" também pergunta; o botão mostra o preço atual (promoção R$ 15,00)`);
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await dialog(page).getByRole('alert').count()) === 1), `${label}: categoria "Copão": sem escolher também mostra a mensagem`);
    await dialog(page).locator('label[data-ice=normal]').click();
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await cartOf(page))[`${c1.id}:normal`] === 1), `${label}: gelo normal no Copão de Gin`);
    ok(await noHScroll(page), `${label}: sem rolagem horizontal`);

    // Gaveta do pedido
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Seu pedido' });
    await drawer.waitFor();
    ok(await until(async () => (await drawer.locator('[data-line]').count()) === 5), `${label}: gaveta com 5 linhas (cerveja + 2 gelos do Original + Mango + Gin)`, await drawer.locator('[data-line]').count());
    const tag = (key) => drawer.locator(`[data-line="${key}"] [data-ice-tag]`);
    ok((await tag(`${m1.id}:normal`).innerText()).includes('Gelo normal') && (await tag(`${m1.id}:flavored`).innerText()).includes('Gelo de sabor'), `${label}: cada linha mostra o seu gelo no resumo do pedido`);
    ok((await drawer.locator(`[data-line="${beer.id}"] [data-ice-tag]`).count()) === 0 && (await drawer.locator(`[data-line="${beer.id}"]`).getByText('Alterar').count()) === 0, `${label}: a cerveja não mostra gelo nem "Alterar"`);
    ok((await drawer.innerText()).includes(money(8 + 25 + 25 + 27 + 15)), `${label}: subtotal soma tudo (R$ ${money(100)}; a promoção vale)`, (await drawer.innerText()).slice(-120));
    await drawer.getByRole('button', { name: 'Aumentar Copão Monster Original, gelo normal' }).click();
    ok(await until(async () => (await cartOf(page))[`${m1.id}:normal`] === 2 && (await cartOf(page))[`${m1.id}:flavored`] === 1), `${label}: o "+" da linha mexe só naquela linha`, await cartOf(page));
    await drawer.getByRole('button', { name: 'Diminuir Copão Monster Original, gelo normal' }).click();
    ok(await until(async () => (await cartOf(page))[`${m1.id}:normal`] === 1), `${label}: o "−" também`);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-4-gaveta.png` });

    // Editar: a escolha anterior vem marcada
    await drawer.locator(`[data-line="${m1.id}:flavored"]`).getByRole('button', { name: /Alterar o gelo/ }).click();
    await dialog(page).first().waitFor();
    const editDialog = page.getByRole('dialog').filter({ hasText: 'Qual gelo você prefere?' });
    ok(/TROCAR O GELO/.test(await editDialog.innerText()) && JSON.stringify(await editDialog.getByRole('radio').evaluateAll((els) => els.map((e) => e.checked))) === '[false,true]', `${label}: editar abre com a escolha anterior marcada ("Gelo de sabor")`);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-5-editar.png` });
    // Esc fecha só esta janela (a gaveta continua) e devolve o foco ao botão
    await page.keyboard.press('Escape');
    ok(await until(async () => (await editDialog.count()) === 0) && (await drawer.isVisible()), `${label}: Esc fecha só a pergunta; a gaveta do pedido continua aberta`);
    ok(await until(() => page.evaluate(() => /Alterar o gelo de Copão Monster Original/.test(document.activeElement?.getAttribute('aria-label') ?? ''))), `${label}: o foco volta ao botão "Alterar"`);
    ok((await cartOf(page))[`${m1.id}:flavored`] === 1, `${label}: fechar sem salvar não muda nada`);
    // Troca de verdade: de sabor para normal; a linha se junta com a do gelo normal
    await drawer.locator(`[data-line="${m1.id}:flavored"]`).getByRole('button', { name: /Alterar o gelo/ }).click();
    await editDialog.waitFor();
    await editDialog.locator('label[data-ice=normal]').click();
    await editDialog.getByRole('button', { name: 'Salvar escolha' }).click();
    ok(await until(async () => { const c = await cartOf(page); return c[`${m1.id}:normal`] === 2 && !(`${m1.id}:flavored` in c); }), `${label}: trocar o gelo leva a quantidade e junta com a linha do mesmo gelo`, await cartOf(page));
    ok(await until(async () => (await drawer.locator('[data-line]').count()) === 4), `${label}: a gaveta passa a ter 4 linhas`);
    // Volta a ter dois gelos do Original para seguir o teste
    await drawer.getByRole('button', { name: 'Fechar pedido' }).click();
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    await dialog(page).locator('label[data-ice=flavored]').click();
    await dialog(page).getByRole('button', { name: /Adicionar ao pedido/ }).click();
    ok(await until(async () => (await cartOf(page))[`${m1.id}:flavored`] === 1), `${label}: dois gelos do Original de novo (2 normais + 1 de sabor)`);

    // Recarregar não perde a escolha
    const before = JSON.stringify(Object.entries(await cartOf(page)).sort());
    await page.reload({ waitUntil: 'networkidle' });
    ok(JSON.stringify(Object.entries(await cartOf(page)).sort()) === before, `${label}: ao recarregar a página, o pedido guarda cada linha com o seu gelo`);
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer2 = page.getByRole('dialog', { name: 'Seu pedido' });
    ok(await until(async () => (await drawer2.locator(`[data-line="${m1.id}:flavored"] [data-ice-tag="flavored"]`).count()) === 1 && (await drawer2.locator(`[data-line="${m1.id}:normal"] [data-ice-tag="normal"]`).count()) === 1), `${label}: depois de recarregar, a gaveta mostra os gelos`);

    // Checkout
    console.log(`# ${label}: checkout e pedido`);
    await drawer2.getByRole('link', { name: /Finalizar pedido/ }).click();
    await page.waitForURL('**/checkout');
    ok(await until(async () => (await page.locator('[data-line] [data-ice-tag]').count()) === 4), `${label}: o checkout lista cada linha com o gelo (3 do Original/Mango/Gin + a do segundo gelo)`, await page.locator('[data-line] [data-ice-tag]').count());
    ok((await page.locator('main').innerText()).includes('Gelo de sabor') && (await page.locator('main').innerText()).includes('Gelo normal'), `${label}: o resumo do checkout mostra "Gelo normal" e "Gelo de sabor"`);
    await page.getByLabel('Nome *').fill('Cliente Gelo ' + label.slice(-3));
    await page.getByLabel('Telefone / WhatsApp *').fill(vp.width === 390 ? '34 99111-0001' : '34 99111-0002');
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.screenshot({ path: `${SP}/ice-${vp.width}-6-checkout.png`, fullPage: true });
    let posted = null;
    page.on('request', (r) => { if (r.url().endsWith('/api/orders') && r.method() === 'POST') posted = JSON.parse(r.postData() || '{}'); });
    ok(await placeOrder(page), `${label}: o pedido é enviado e abre a página do pedido`);
    ok(!!posted && posted.items.length === 5, `${label}: o pedido enviado tem 5 itens`, posted?.items);
    const sent = Object.fromEntries((posted?.items ?? []).map((i) => [`${i.product_id}:${i.ice_choice ?? '-'}`, i.quantity]));
    ok(sent[`${m1.id}:normal`] === 2 && sent[`${m1.id}:flavored`] === 1 && sent[`${m2.id}:flavored`] === 1 && sent[`${c1.id}:normal`] === 1 && sent[`${beer.id}:-`] === 1, `${label}: cada item vai com o seu gelo (e a cerveja sem campo de gelo)`, sent);
    ok(!('ice_choice' in (posted?.items.find((i) => i.product_id === beer.id) ?? {})), `${label}: a cerveja é enviada exatamente como sempre (sem ice_choice)`);
    ok(await until(async () => Object.keys(await cartOf(page)).length === 0), `${label}: depois de enviar, o pedido (carrinho) é esvaziado`);

    // Página do pedido
    ok(await until(async () => (await page.locator('[data-ice-tag]').count()) === 4), `${label}: a página do pedido mostra o gelo de cada item`, await page.locator('[data-ice-tag]').count());
    const itemsText = await page.locator('main').innerText();
    ok(/Copão Monster Original[\s\S]*Gelo normal/.test(itemsText) && /Gelo de sabor/.test(itemsText), `${label}: "Itens" do pedido com os gelos`, itemsText);
    await page.screenshot({ path: `${SP}/ice-${vp.width}-7-pedido.png`, fullPage: true });
    const number = Number((await page.locator('h1').first().innerText()).match(/#?(\d{4,})/)?.[1] ?? (await page.locator('body').innerText()).match(/#(\d{4,})/)?.[1]);
    const wa = await page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]')].map((a) => a.href).find((h) => /Itens/.test(decodeURIComponent(h))) ?? '');
    const waText = decodeURIComponent(wa);
    ok(/2x Copão Monster Original – Gelo normal/.test(waText) && /1x Copão Monster Original – Gelo de sabor/.test(waText) && /1x Heineken Long Neck\n/.test(waText), `${label}: a mensagem de WhatsApp para a loja traz o gelo de cada item`, waText);
    ok(Number.isFinite(number), `${label}: número do pedido lido da página (#${number})`);
    const saved = (await api('GET', `/api/admin/orders/${number}`)).data;
    ok(saved?.items?.length === 5 && saved.items.filter((i) => i.ice_choice).length === 4 && saved.items.find((i) => i.product_name === 'Heineken Long Neck')?.ice_choice === null, `${label}: o banco gravou o gelo de cada item (e nada na cerveja)`, saved?.items?.map((i) => `${i.quantity}x ${i.product_name} ${i.ice_choice}`));
    ok(Math.abs(Number(saved?.order?.total) - (8 + 25 * 3 + 27 + 15)) < 0.001, `${label}: o total não mudou por causa do gelo (R$ ${money(8 + 75 + 27 + 15)} sem frete na retirada)`, saved?.order?.total);

    // Painel: pedido e recibo
    if (vp.width === 1280) {
      console.log('# painel: pedido, recibo e Categorias');
      const { page: a } = await newCtx(browser, { width: 1440, height: 900 });
      await a.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
      await a.fill('#login-email', 'dono@copocheio.local');
      await a.fill('#login-senha', 'senha-forte-123');
      await a.click('button[type=submit]');
      await a.waitForURL('**/admin/dashboard');
      await a.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
      ok(await until(async () => (await a.locator('[data-ice-tag]').count()) === 4), 'painel: o pedido mostra o gelo de cada item', await a.locator('[data-ice-tag]').count());
      const receipt = await a.locator('#recibo').textContent();
      ok(/2x Copão Monster Original \(Gelo normal\)/.test(receipt) && /1x Copão Monster Original \(Gelo de sabor\)/.test(receipt) && /1x Heineken Long Neck(?!\s*\()/.test(receipt), 'painel: o recibo impresso traz o gelo (e a cerveja não)', receipt);
      await a.screenshot({ path: `${SP}/ice-admin-pedido.png`, fullPage: true });

      await a.goto(BASE + '/admin/categorias', { waitUntil: 'networkidle' });
      const rows = await a.locator('li').filter({ hasText: 'produto(s)' }).allInnerTexts();
      ok(rows.filter((t) => /Pede o gelo/.test(t)).length === 2 && !/Pede o gelo/.test(rows.find((t) => /Cervejas/.test(t)) ?? ''), 'painel: Categorias marca "Pede o gelo" em Copão e Copão com Monster, e não em Cervejas', rows);
      await a.getByRole('button', { name: 'Editar Cervejas' }).click();
      const sw = a.getByRole('switch', { name: 'Pedir a escolha do gelo' });
      ok((await sw.getAttribute('aria-checked')) === 'false', 'painel: a chave "Pedir a escolha do gelo" está desligada na Cervejas');
      await sw.click();
      await a.getByRole('button', { name: 'Salvar', exact: true }).click();
      ok(await until(async () => (await api('GET', '/api/products')).data.categories.find((c) => c.id === catBeer.id)?.ice_choice_required === true), 'painel: ligar a chave vale para o site na hora');
      const { page: s } = await newCtx(browser, { width: 390, height: 844 });
      await s.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
      await addButton(s, 'Brahma Lata 350ml').click();
      ok(await until(async () => (await dialog(s).count()) === 1) && /Qual gelo você prefere/.test(await dialog(s).innerText()), 'site: com a regra ligada, a cerveja também pergunta o gelo (a regra é da categoria, qualquer uma serve)');
      await s.keyboard.press('Escape');
      await a.getByRole('button', { name: 'Editar Cervejas' }).click().catch(() => {});
      await a.goto(BASE + '/admin/categorias', { waitUntil: 'networkidle' });
      await a.getByRole('button', { name: 'Editar Cervejas' }).click();
      await a.getByRole('switch', { name: 'Pedir a escolha do gelo' }).click();
      await a.getByRole('button', { name: 'Salvar', exact: true }).click();
      ok(await until(async () => (await api('GET', '/api/products')).data.categories.find((c) => c.id === catBeer.id)?.ice_choice_required === false), 'painel: desligar a chave também vale na hora');
      await a.context().close();
      await s.context().close();
    }
    await ctx.close();
  }

  // ---- pedido antigo (guardado antes da pergunta existir) -------------------------------------------
  console.log('# pedido guardado antes da mudança (copão sem gelo)');
  for (const [label, vp] of [['celular', { width: 390, height: 844 }], ['computador', { width: 1280, height: 800 }]]) {
    const { ctx, page } = await newCtx(browser, vp, { fn: ([k, v]) => { if (!localStorage.getItem('copocheio:legacy-seeded')) { localStorage.setItem(k, v); localStorage.setItem('copocheio:legacy-seeded', '1'); } }, arg: ['copocheio:pedido', JSON.stringify({ [m1.id]: 2, [beer2.id]: 1 })] });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /Ver pedido/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Seu pedido' });
    await drawer.waitFor();
    ok(await until(async () => (await drawer.locator(`[data-line="${m1.id}"] [data-ice-pending]`).count()) === 1), `${label}: o copão que já estava no pedido fica marcado "Escolher o gelo *"`);
    ok((await drawer.locator(`[data-line="${beer2.id}"] [data-ice-pending]`).count()) === 0, `${label}: a cerveja do mesmo pedido segue normal`);
    await drawer.getByRole('link', { name: /Finalizar pedido/ }).click();
    ok(await until(async () => (await drawer.getByRole('alert').innerText()) === MESSAGE), `${label}: tentar finalizar sem o gelo mostra "${MESSAGE}"`);
    ok(new URL(page.url()).pathname === '/bebidas', `${label}: e não segue para o checkout`);
    ok(await until(() => page.evaluate(() => document.activeElement?.hasAttribute('data-ice-pending'))), `${label}: o foco vai para o item que falta`);
    await page.screenshot({ path: `${SP}/ice-legacy-${vp.width}-gaveta.png` });
    await drawer.getByRole('button', { name: 'Fechar pedido' }).click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').fill('Cliente Antigo');
    await page.getByLabel('Telefone / WhatsApp *').fill(vp.width === 390 ? '34 99222-0001' : '34 99222-0002');
    await page.getByText('Retirar na loja', { exact: true }).click();
    let posts = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/orders') && r.method() === 'POST') posts++; });
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    const alertBox = page.getByRole('alert').filter({ hasText: MESSAGE });
    ok(await until(async () => (await alertBox.count()) === 1), `${label}: no checkout, finalizar sem o gelo mostra "${MESSAGE}"`);
    ok(posts === 0, `${label}: nada é enviado ao servidor`, posts);
    ok(await until(() => page.evaluate(() => document.activeElement?.hasAttribute('data-ice-pending'))), `${label}: o foco vai para "Escolher o gelo"`);
    await page.screenshot({ path: `${SP}/ice-legacy-${vp.width}-checkout.png`, fullPage: true });
    await page.locator('[data-ice-pending]').click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Qual gelo você prefere?' });
    await dlg.waitFor();
    ok((await dlg.getByRole('radio').evaluateAll((els) => els.every((e) => !e.checked))) && /Salvar escolha/.test(await dlg.innerText()), `${label}: a pergunta abre sem nada marcado`);
    await dlg.getByRole('button', { name: 'Salvar escolha' }).click();
    ok(await until(async () => (await dlg.getByRole('alert').count()) === 1), `${label}: salvar sem escolher também mostra a mensagem`);
    await dlg.locator('label[data-ice=flavored]').click();
    await dlg.getByRole('button', { name: 'Salvar escolha' }).click();
    ok(await until(async () => (await cartOf(page))[`${m1.id}:flavored`] === 2 && !(m1.id in (await cartOf(page)))), `${label}: a linha antiga passa a ter o gelo escolhido (2 de sabor)`, await cartOf(page));
    ok(await until(async () => (await alertBox.count()) === 0), `${label}: a mensagem some quando todos os itens têm gelo`);
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    await page.waitForURL('**/pedido/**', { timeout: 15000 });
    ok(posts === 1, `${label}: agora o pedido é enviado`, posts);
    await ctx.close();
  }

  // ---- a regra muda no meio da compra: o servidor também confere -----------------------------------
  console.log('# a categoria passa a pedir o gelo com o cliente já no checkout');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { fn: ([k, v]) => { if (!localStorage.getItem('copocheio:seeded2')) { localStorage.setItem(k, v); localStorage.setItem('copocheio:seeded2', '1'); } }, arg: ['copocheio:pedido', JSON.stringify({ [beer2.id]: 2 })] });
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').fill('Cliente Corrida');
    await page.getByLabel('Telefone / WhatsApp *').fill('34 99333-0001');
    await page.getByText('Retirar na loja', { exact: true }).click();
    ok((await page.locator('[data-ice-pending]').count()) === 0, 'cerveja no checkout: sem pergunta de gelo');
    await api('PATCH', `/api/admin/categories/${catBeer.id}`, { ice_choice_required: true });
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    const box = page.getByRole('alert').filter({ hasText: MESSAGE });
    ok(await until(async () => (await box.count()) >= 1), 'o servidor recusa (a página ainda não sabia da regra) e a mesma mensagem aparece', await page.locator('main').innerText());
    ok(await until(async () => (await page.locator('[data-ice-pending]').count()) === 1), 'o cardápio é atualizado e a linha passa a pedir "Escolher o gelo"');
    await page.locator('[data-ice-pending]').click();
    const dlg = page.getByRole('dialog').filter({ hasText: 'Qual gelo você prefere?' });
    await dlg.waitFor();
    await dlg.locator('label[data-ice=normal]').click();
    await dlg.getByRole('button', { name: 'Salvar escolha' }).click();
    await page.getByRole('button', { name: /^Finalizar pedido/ }).click();
    await page.waitForURL('**/pedido/**', { timeout: 15000 });
    ok(true, 'com o gelo escolhido, o pedido passa');
    await api('PATCH', `/api/admin/categories/${catBeer.id}`, { ice_choice_required: false });
    await ctx.close();
  }

  // ---- teclado, foco e telas pequenas --------------------------------------------------------------
  console.log('# teclado, foco e telas pequenas');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const btn = addButton(page, 'Copão Monster Mango');
    await btn.focus();
    await page.keyboard.press('Enter');
    await dialog(page).waitFor();
    ok(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]') && document.activeElement?.getAttribute('type') === 'radio'), 'teclado: ao abrir, o foco entra na janela (na primeira opção)');
    await page.keyboard.press('ArrowRight');
    ok(JSON.stringify(await radioState(page)) === '[false,true]', 'teclado: as setas trocam a opção');
    await page.keyboard.press('ArrowLeft');
    ok(JSON.stringify(await radioState(page)) === '[true,false]', 'teclado: e voltam');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => /Adicionar ao pedido/.test(document.activeElement?.textContent ?? '')), 'teclado: Tab vai para "Adicionar ao pedido"');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]') && document.activeElement?.getAttribute('aria-label') === 'Fechar'), 'teclado: o foco não escapa da janela (volta ao primeiro botão)');
    await page.keyboard.press('Shift+Tab');
    ok(await page.evaluate(() => /Adicionar ao pedido/.test(document.activeElement?.textContent ?? '')), 'teclado: Shift+Tab volta');
    await page.keyboard.press('Escape');
    ok(await until(async () => (await dialog(page).count()) === 0), 'teclado: Esc fecha');
    ok(await until(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Adicionar') ?? false)), 'teclado: e o foco volta ao botão que abriu');
    ok(!Object.keys(await cartOf(page)).some((k) => k.startsWith(m2.id)), 'teclado: fechar não adiciona nada');
    await page.keyboard.press('Enter');
    await dialog(page).waitFor();
    await dialog(page).locator('label[data-ice=normal]').click();
    await page.getByRole('button', { name: /Adicionar ao pedido/ }).focus();
    await page.keyboard.press('Enter');
    ok(await until(async () => (await cartOf(page))[`${m2.id}:normal`] === 1), 'teclado: Enter no botão adiciona com a escolha');
    ok(await until(async () => /adicionado ao pedido com gelo normal/.test(await page.locator('[role=status]').allInnerTexts().then((t) => t.join(' ')))), 'leitor de tela: o aviso "adicionado ao pedido com gelo normal" é anunciado');
    // Clicar fora fecha
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    await page.mouse.click(10, 10);
    ok(await until(async () => (await dialog(page).count()) === 0), 'clicar fora da janela fecha sem adicionar');
    // Posição: no computador a janela fica no centro
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    await page.waitForTimeout(450);
    const box = await dialog(page).boundingBox();
    ok(Math.abs(box.x + box.width / 2 - 640) < 2 && Math.abs(box.y + box.height / 2 - 400) < 60, 'computador: a janela fica centralizada', box);
    await page.keyboard.press('Escape');
    await ctx.close();
  }
  for (const [label, vp] of [['360x640', { width: 360, height: 640 }], ['320x568', { width: 320, height: 568 }], ['paisagem 844x390', { width: 844, height: 390 }]]) {
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'Copão Monster Original').click();
    await dialog(page).waitFor();
    await page.waitForTimeout(450);
    const box = await dialog(page).boundingBox();
    ok(box.width <= vp.width && box.height <= vp.height * 0.93 + 1 && box.y + box.height <= vp.height + 1, `${label}: a janela cabe na tela (${Math.round(box.width)}x${Math.round(box.height)})`, box);
    if (vp.width < 600 && vp.height > vp.width) ok(Math.abs(box.y + box.height - vp.height) < 2, `${label}: no celular ela sobe da borda de baixo`, box);
    const confirm = dialog(page).getByRole('button', { name: /Adicionar ao pedido/ });
    await confirm.scrollIntoViewIfNeeded();
    const cb = await confirm.boundingBox();
    ok(cb && cb.y >= 0 && cb.y + cb.height <= vp.height + 1, `${label}: o botão de adicionar fica ao alcance (rolando a janela, se preciso)`, cb);
    ok(await noHScroll(page), `${label}: sem rolagem horizontal com a janela aberta`);
    ok(await page.evaluate(() => document.body.style.overflow === 'hidden'), `${label}: a página de trás não rola enquanto a pergunta está aberta`);
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.body.style.overflow !== 'hidden'), `${label}: ao fechar, a rolagem volta`);
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de página nem de console em todo o teste', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
