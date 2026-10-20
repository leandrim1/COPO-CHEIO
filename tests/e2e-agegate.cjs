// Venda responsável (18+) e cancelamento pelo cliente, de ponta a ponta no navegador (celular e computador):
//  • a pergunta de maioridade aparece em /, /bebidas e /checkout (e SÓ nelas: privacidade, conta, acompanhamento e "não encontrada" ficam livres), é uma
//    janela de verdade (role=dialog, foco preso, o resto da página inerte e sem rolagem, Esc não fecha), lembra a resposta e não deixa a interface ser a única barreira
//    (o servidor também recusa, ver api-test28);
//  • "menos de 18 anos" não entra, mostra o aviso e deixa ler a privacidade; "voltar" pergunta de novo;
//  • checkout: com bebida alcoólica no pedido pede a declaração (sem ela nada é enviado); só com produto sem álcool não pede;
//  • acompanhamento: aviso do documento, cancelamento pelo cliente (até a loja confirmar) e o motivo do bloqueio depois disso;
//  • painel: entrega só concluída com a conferência do documento; entrega recusada cancela com o motivo.
// Esta suíte NÃO usa e2e-age.cjs: ela responde à pergunta de maioridade por conta própria.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-agegate.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
const BASE = process.env.BASE || 'http://127.0.0.1:4180';
const DB = process.env.TEST_DB || 'copocheio_test';
const { execSync } = require('child_process');
const psql = (sql) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres ${DB} -At`, { input: sql }).toString().trim();
const AGE_KEY = 'copocheio:age-v1';

let cookie = '';
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.28.28.28', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(BASE + path, init);
      break;
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* ainda não */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const errors = [];
async function newCtx(browser, viewport, { init } = {}) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const gate = (page) => page.locator('[data-age-gate]');
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

async function fillCheckout(page, suffix) {
  await page.getByLabel('Nome *').fill('Cliente Maioridade ' + suffix);
  await page.getByLabel('Telefone / WhatsApp *').fill('3499' + String(9000000 + Math.floor(Math.random() * 999999)));
  await page.getByText('Retirar na loja', { exact: true }).click();
  await page.waitForTimeout(700); // o site só aceita pedido depois de 0,6 s na tela
}

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const store = await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 5, min_order: 0 });
  ok(store.status === 200, 'preparo: loja aberta para os testes', store.data);
  const cat = (await api('POST', '/api/admin/categories', { name: 'Teste Maioridade' })).data.category;
  const mk = async (name, price, extra) => (await api('POST', '/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, ...extra })).data.product;
  const beer = await mk('Cerveja 18 Mais', 9, { stock: 40 });
  const soda = await mk('Guaraná Sem Álcool', 6, { stock: 40, alcoholic: false });
  ok(beer.alcoholic === true && soda.alcoholic === false, 'preparo: cerveja alcoólica e refrigerante sem álcool');
  const stockOf = (id) => Number(psql(`select stock from products where id = '${id}'`));

  const browser = await chromium.launch();

  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name} (${w}×${h}): a pergunta de maioridade`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await gate(page).waitFor({ timeout: 8000 });
    const g = gate(page).locator('[role=dialog]');
    ok((await g.getAttribute('aria-modal')) === 'true', `${name}: é uma janela modal (role=dialog, aria-modal)`);
    const title = await g.evaluate((el) => document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim());
    ok(/Venda proibida para menores de 18 anos/i.test(title ?? ''), `${name}: o título é o aviso de venda proibida para menores (${title})`, title);
    const text = await g.innerText();
    ok(/documento\s+oficial com foto/i.test(text) && /Beba com moderação/i.test(text), `${name}: avisa do documento na entrega e do consumo responsável`, text);
    ok(/menos de 18/.test(text) && /18 anos ou mais/.test(text), `${name}: as duas respostas existem`);
    ok((await page.evaluate(() => document.activeElement?.hasAttribute('data-age-yes'))) === true, `${name}: o foco começa em "Tenho 18 anos ou mais"`);
    ok((await page.evaluate(() => document.getElementById('root')?.hasAttribute('inert'))) === true, `${name}: o resto da página fica inerte (sem foco nem leitor de tela)`);
    ok((await page.evaluate(() => getComputedStyle(document.body).overflow)) === 'hidden', `${name}: a página de trás não rola`);
    ok(await noHScroll(page), `${name}: sem rolagem lateral`);
    const sizes = await gate(page).locator('button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    ok(sizes.every((s) => s >= 44), `${name}: botões com pelo menos 44 px de altura (${sizes.join(', ')})`, sizes);
    // O foco não escapa para a página, nem com Tab nem com Shift+Tab; Esc não dispensa a pergunta.
    let inside = true;
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(i < 5 ? 'Tab' : 'Shift+Tab');
      inside = inside && (await page.evaluate(() => !!document.querySelector('[data-age-gate]')?.contains(document.activeElement)));
    }
    ok(inside, `${name}: Tab e Shift+Tab giram só dentro da janela`);
    await page.keyboard.press('Escape');
    ok((await gate(page).count()) === 1, `${name}: Esc não dispensa a pergunta`);

    console.log(`# ${name}: "menos de 18 anos"`);
    await gate(page).locator('[data-age-no]').click();
    const declined = await g.innerText();
    ok(/Só atendemos maiores de 18 anos/.test(declined) && /Política de privacidade/.test(declined) && !/Tenho 18 anos ou mais/.test(declined), `${name}: mostra que só atende maiores e deixa ler a privacidade`, declined);
    ok((await page.evaluate((k) => localStorage.getItem(k), AGE_KEY)) === null, `${name}: nada é gravado como "confirmado"`);
    await g.getByRole('button', { name: 'Voltar' }).click();
    ok(/Venda proibida para menores/.test(await g.innerText()), `${name}: "Voltar" pergunta de novo`);
    await gate(page).locator('[data-age-no]').click();
    await g.getByRole('link', { name: 'Política de privacidade' }).click();
    await page.waitForURL('**/privacidade');
    await page.waitForTimeout(300);
    ok((await gate(page).count()) === 0 && (await page.getByRole('heading', { name: /privacidade/i }).first().count()) >= 1, `${name}: a página de privacidade abre livre, sem a janela`);
    ok((await page.evaluate(() => !document.getElementById('root')?.hasAttribute('inert') && getComputedStyle(document.body).overflow !== 'hidden')), `${name}: ...e a página volta a rolar e a receber foco`);
    ok(/Maioridade \(18\+\)/.test(await page.evaluate(() => document.body.innerText)), `${name}: a política de privacidade explica o que é (e o que não é) guardado sobre maioridade`);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await gate(page).waitFor({ timeout: 8000 });
    ok(/Venda proibida para menores/.test(await gate(page).locator('[role=dialog]').innerText()), `${name}: ao voltar à /bebidas a pergunta recomeça do início`);

    console.log(`# ${name}: "tenho 18 anos ou mais"`);
    await gate(page).locator('[data-age-yes]').click();
    await page.waitForTimeout(200);
    ok((await gate(page).count()) === 0, `${name}: a janela some`);
    ok((await page.evaluate(() => !document.getElementById('root')?.hasAttribute('inert') && getComputedStyle(document.body).overflow !== 'hidden')), `${name}: a página volta a rolar e a receber foco`);
    ok((await page.evaluate((k) => localStorage.getItem(k), AGE_KEY)) === '1', `${name}: a resposta fica no aparelho (copocheio:age-v1)`);
    for (const url of ['/', '/bebidas', '/checkout']) {
      await page.goto(BASE + url, { waitUntil: 'networkidle' });
      ok((await gate(page).count()) === 0, `${name}: ${url} não pergunta de novo`);
    }
    await ctx.close();

    console.log(`# ${name}: onde a pergunta NÃO aparece`);
    const fresh = await newCtx(browser, { width: w, height: h });
    for (const url of ['/privacidade', '/conta', '/acompanhar-pedido', '/pedido/ABCDE-FGHJK-MNPQR-STVWX', '/pagina-que-nao-existe']) {
      await fresh.page.goto(BASE + url, { waitUntil: 'networkidle' });
      await fresh.page.waitForTimeout(250);
      ok((await gate(fresh.page).count()) === 0, `${name}: ${url} abre livre (sem a pergunta)`);
    }
    for (const url of ['/', '/checkout']) {
      await fresh.page.goto(BASE + url, { waitUntil: 'networkidle' });
      await gate(fresh.page).waitFor({ timeout: 8000 }).then(
        () => ok(true, `${name}: ${url} pergunta`),
        () => ok(false, `${name}: ${url} deveria perguntar`),
      );
    }
    await fresh.ctx.close();
  }

  console.log('# sem armazenamento (aba anônima / dados bloqueados): a pergunta funciona e vale até recarregar');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, {
      init: { fn: () => { Storage.prototype.getItem = () => { throw new Error('bloqueado'); }; Storage.prototype.setItem = () => { throw new Error('bloqueado'); }; } },
    });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await gate(page).waitFor({ timeout: 8000 });
    await gate(page).locator('[data-age-yes]').click();
    await page.waitForTimeout(200);
    ok((await gate(page).count()) === 0, 'a janela some mesmo sem poder gravar no aparelho');
    await page.goto(BASE + '/privacidade', { waitUntil: 'networkidle' }); // recarga completa: sem armazenamento, pergunta de novo
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await gate(page).waitFor({ timeout: 8000 }).then(() => ok(true, 'depois de recarregar, sem armazenamento, pergunta de novo'), () => ok(false, 'depois de recarregar deveria perguntar de novo'));
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  const answered = { fn: (k) => { try { localStorage.setItem(k, '1'); } catch { /* sem armazenamento */ } }, arg: AGE_KEY };
  const addToCart = async (page, productName) => {
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.locator(`button[aria-label="Adicionar ${productName} ao pedido"]`).first().click();
    await page.waitForTimeout(300);
  };
  const orderNumberOf = async (page) => {
    await page.waitForURL(/\/pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, { timeout: 15000 });
    await page.waitForSelector('text=Pedido recebido!');
    return Number((/Seu pedido #(\d+) foi enviado/.exec(await page.evaluate(() => document.body.innerText)) || [])[1]);
  };

  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name}: checkout com bebida alcoólica pede a declaração`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h }, { init: answered });
    await addToCart(page, 'Cerveja 18 Mais');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    const box = page.locator('[data-age-confirm]');
    await box.waitFor({ timeout: 8000 });
    const label = await page.locator('[data-age-declaration]').innerText();
    ok(/18 anos ou mais/.test(label) && /documento oficial com foto/.test(label) && (await box.isChecked()) === false, `${name}: a caixa "Declaro que tenho 18 anos ou mais" vem DESMARCADA e fala do documento`, label);
    ok(await noHScroll(page), `${name}: o checkout com a caixa cabe na tela`);
    const rowHeight = await page.locator('[data-age-declaration] label').evaluate((el) => Math.round(el.getBoundingClientRect().height));
    ok(rowHeight >= 44, `${name}: a linha da caixa é fácil de tocar (${rowHeight}px)`);
    await fillCheckout(page, name);
    const before = Number(psql('select count(*) from orders'));
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    await page.waitForTimeout(600);
    ok(/Confirme que você tem 18 anos ou mais/.test(await page.locator('#age-error').innerText().catch(() => '')), `${name}: sem marcar a caixa, aparece o erro`);
    ok((await box.getAttribute('aria-invalid')) === 'true' && (await page.evaluate(() => document.activeElement?.hasAttribute('data-age-confirm'))) === true, `${name}: a caixa fica inválida (aria-invalid) e recebe o foco`);
    ok(Number(psql('select count(*) from orders')) === before, `${name}: nada foi enviado ao servidor`);
    await box.check();
    ok((await page.locator('#age-error').count()) === 0, `${name}: marcar a caixa limpa o erro`);
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    const row = psql(`select age_required, age_declared_at is not null, age_declaration_version from orders where order_number = ${number}`);
    ok(row === 't|t|v1', `${name}: o pedido #${number} grava só a declaração (${row})`);
    ok(/Deixe um documento oficial com foto à mão/.test(await page.evaluate(() => document.body.innerText)) && (await page.locator('[data-age-notice]').count()) === 1, `${name}: a confirmação avisa para deixar o documento à mão`);
    await ctx.close();
  }

  console.log('# checkout só com produto sem álcool: não pede a declaração');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { init: answered });
    await addToCart(page, 'Guaraná Sem Álcool');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').waitFor({ timeout: 8000 });
    ok((await page.locator('[data-age-confirm]').count()) === 0, 'sem bebida alcoólica no pedido a caixa não aparece');
    await fillCheckout(page, 'soda');
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    ok(psql(`select age_required or age_declared_at is not null from orders where order_number = ${number}`) === 'f', `o pedido #${number} não grava declaração nem exige conferência`);
    ok((await page.locator('[data-age-notice]').count()) === 0, 'e a confirmação não fala de documento');
    await ctx.close();
  }

  console.log('# o servidor é a barreira de verdade: a tela diz "sem álcool" mas o produto é alcoólico');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { init: answered });
    await addToCart(page, 'Guaraná Sem Álcool');
    // O painel liga o álcool no produto DEPOIS de o cardápio ter carregado: a tela ainda não sabe, o servidor sabe.
    await api('PATCH', `/api/admin/products/${soda.id}`, { alcoholic: true });
    await page.goto(BASE + '/checkout', { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Nome *').waitFor({ timeout: 8000 });
    await page.route('**/api/products', (r) => r.abort()); // a tela fica com a cópia antiga do cardápio
    await page.route('**/api/orders', async (route) => {
      // Sem a caixa (a tela achou que não precisava), o pedido sai sem declaração: o servidor recusa e a tela pede a caixa.
      await route.continue();
    });
    await fillCheckout(page, 'server');
    const before = Number(psql('select count(*) from orders'));
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const asked = await until(async () => (await page.locator('[data-age-confirm]').count()) === 1 || /Confirme que você tem 18 anos/.test(await page.evaluate(() => document.body.innerText)), 8000);
    ok(asked, 'o servidor recusou sem a declaração e a tela passou a pedir a caixa de maioridade');
    ok(Number(psql('select count(*) from orders')) === before, 'nenhum pedido foi criado sem a declaração');
    await api('PATCH', `/api/admin/products/${soda.id}`, { alcoholic: false });
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  for (const [w, h, name] of [[390, 844, 'celular'], [1280, 800, 'computador']]) {
    console.log(`# ${name}: cancelamento pelo cliente na tela de acompanhamento`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h }, { init: answered });
    await addToCart(page, 'Cerveja 18 Mais');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-age-confirm]').check();
    await fillCheckout(page, 'cancela ' + name);
    const stockBefore = stockOf(beer.id);
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    ok(stockOf(beer.id) === stockBefore - 1, `${name}: o pedido #${number} reservou 1 unidade no estoque`);
    await page.getByRole('link', { name: 'Acompanhar meu pedido' }).click();
    await page.waitForURL('**/acompanhar-pedido/**');
    const cancelOpen = page.locator('[data-cancel-open]');
    await cancelOpen.waitFor({ timeout: 8000 });
    ok(await noHScroll(page), `${name}: a tela de acompanhamento com o cancelamento cabe na largura`);
    const panel = await page.locator('section[aria-labelledby="cancelar"]').innerText();
    ok(/enquanto a loja ainda não confirmou/.test(panel), `${name}: explica até quando dá para cancelar`, panel);
    ok((await cancelOpen.evaluate((el) => Math.round(el.getBoundingClientRect().height))) >= 44, `${name}: o botão de cancelar tem pelo menos 44 px de altura`);
    await cancelOpen.click();
    ok((await page.locator('[data-cancel-confirm]').count()) === 1, `${name}: pede a confirmação antes de cancelar (nada acontece num toque só)`);
    ok(stockOf(beer.id) === stockBefore - 1, `${name}: ainda nada foi cancelado`);
    await page.locator('#motivo-cancelamento').selectOption({ label: 'Não preciso mais' });
    await page.locator('[data-cancel-confirm-button]').click();
    await page.waitForSelector('text=Pedido cancelado', { timeout: 8000 });
    ok(await until(() => stockOf(beer.id) === stockBefore), `${name}: o estoque voltou`);
    ok(psql(`select order_status from orders where order_number = ${number}`) === 'cancelled', `${name}: o pedido está cancelado`);
    ok(/new>cancelled/.test(psql(`select string_agg(coalesce(h.from_status,'-') || '>' || h.to_status || '|' || coalesce(h.changed_by_name,'') || '|' || coalesce(h.reason,''), ' ; ') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${number}`)) , `${name}: o histórico guarda o estado anterior`);
    ok(/Cliente \(link de acompanhamento\)\|Não preciso mais/.test(psql(`select string_agg(h.changed_by_name || '|' || coalesce(h.reason,''), ' ; ') from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${number}`)), `${name}: ...e quem cancelou e o motivo`);
    ok((await page.locator('[data-cancel-open]').count()) === 0, `${name}: o botão de cancelar some`);
    ok((await page.locator('[data-age-notice]').count()) === 0, `${name}: e o aviso do documento também (o pedido não está mais em andamento)`);
    await page.reload({ waitUntil: 'networkidle' });
    ok((await page.locator('[data-cancel-open]').count()) === 0 && /Pedido cancelado/.test(await page.evaluate(() => document.body.innerText)), `${name}: ao recarregar, continua cancelado e sem botão`);
    await ctx.close();
  }

  console.log('# depois que a loja confirma, o cliente não cancela mais: vê o porquê e fala com a loja');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 }, { init: answered });
    await addToCart(page, 'Guaraná Sem Álcool');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await fillCheckout(page, 'bloqueado');
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    const id = psql(`select id from orders where order_number = ${number}`);
    await page.getByRole('link', { name: 'Acompanhar meu pedido' }).click();
    await page.waitForURL('**/acompanhar-pedido/**');
    await page.locator('[data-cancel-open]').waitFor({ timeout: 8000 });
    await api('PATCH', `/api/admin/orders/${id}`, { status: 'confirmed' });
    ok(await until(async () => (await page.locator('[data-cancel-open]').count()) === 0, 25000), 'a tela atualiza sozinha: o botão de cancelar some quando a loja confirma');
    const why = await page.locator('[data-cancel-blocked]').innerText();
    ok(/já está cuidando do seu pedido/.test(why), 'explica que a loja já está cuidando do pedido', why);
    const href = await page.locator('section[aria-labelledby="cancelar"] a', { hasText: 'Falar com a loja' }).getAttribute('href');
    ok(/^https:\/\/wa\.me\//.test(href ?? ''), 'e leva para o WhatsApp da loja', href);
    ok(psql(`select order_status from orders where order_number = ${number}`) === 'confirmed', 'o pedido continua confirmado');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: entrega só concluída com a conferência do documento; entrega recusada cancela com o motivo');
  {
    const buyer = async (items) => {
      const r = await api('POST', '/api/orders', { customer_name: 'Comprador Painel', customer_phone: '34988' + String(100000 + Math.floor(Math.random() * 899999)), delivery_type: 'pickup', payment_method: 'pix', items, age_confirmed: true });
      return r.data.order.order_number;
    };
    const n1 = await buyer([{ product_id: beer.id, quantity: 2 }]);
    const n2 = await buyer([{ product_id: beer.id, quantity: 3 }]);
    const id1 = psql(`select id from orders where order_number = ${n1}`);
    const id2 = psql(`select id from orders where order_number = ${n2}`);
    for (const id of [id1, id2]) for (const s of ['confirmed', 'preparing', 'out_for_delivery']) await api('PATCH', `/api/admin/orders/${id}`, { status: s });

    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await finishAdminLogin(page);
    await page.waitForURL('**/admin/dashboard');

    await page.goto(BASE + `/admin/pedidos/${n1}`, { waitUntil: 'networkidle' });
    const card = page.locator('[data-age-card]');
    await card.waitFor({ timeout: 8000 });
    ok(/declarou ter 18 anos ou mais/.test(await card.innerText()) && /Ainda não conferido/.test(await card.innerText()), 'o pedido mostra o cartão "Maioridade (18+)" ainda sem conferência');
    ok(/Não guarde nem fotografe o documento/.test(await card.innerText()), '...e orienta a não guardar nem fotografar o documento');
    await page.getByRole('button', { name: /^(ENTREGUE|RETIRADO)$/i }).click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor({ timeout: 5000 });
    ok(/Conferiu o documento do cliente/.test(await dlg.innerText()) && /18 anos ou mais/.test(await dlg.innerText()), 'concluir a entrega pergunta se o documento foi conferido');
    await dlg.getByRole('button', { name: /Cancelar|Voltar/ }).first().click();
    await page.waitForTimeout(300);
    ok(psql(`select order_status from orders where order_number = ${n1}`) === 'out_for_delivery', 'responder que não conferiu: o pedido NÃO é concluído');
    await page.getByRole('button', { name: /^(ENTREGUE|RETIRADO)$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Conferi: 18 anos ou mais/ }).click();
    ok(await until(() => psql(`select order_status from orders where order_number = ${n1}`) === 'delivered'), 'confirmando a conferência: entregue');
    ok(psql(`select age_checked_by_name from orders where order_number = ${n1}`) === 'Dono Teste', 'fica registrado quem conferiu');
    await page.reload({ waitUntil: 'networkidle' });
    ok(/Documento conferido por Dono Teste/.test(await page.locator('[data-age-card]').innerText()), 'e o painel mostra quem conferiu e quando');

    // Lista de pedidos: o aviso "Conferir documento 18+" para os que ainda precisam
    await page.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
    ok((await page.getByText('Conferir documento 18+').count()) >= 1, 'a lista de pedidos marca os pedidos que ainda exigem conferência');

    await page.goto(BASE + `/admin/pedidos/${n2}`, { waitUntil: 'networkidle' });
    await page.locator('[data-age-card]').waitFor({ timeout: 8000 });
    const stockReserved = stockOf(beer.id);
    await page.getByRole('button', { name: /Recusar entrega/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Recusar e cancelar/ }).click();
    ok(await until(() => psql(`select order_status from orders where order_number = ${n2}`) === 'cancelled'), 'recusar a entrega cancela o pedido');
    ok(stockOf(beer.id) === stockReserved + 3, 'e o estoque volta');
    await page.reload({ waitUntil: 'networkidle' });
    ok(/Motivo: Entrega recusada: maioridade não comprovada/.test(await page.evaluate(() => document.body.innerText)), 'o histórico do pedido mostra o motivo');
    ok((await page.getByRole('button', { name: /Recusar entrega/ }).count()) === 0, 'e o botão de recusar some');
    await ctx.close();
  }

  ok(errors.length === 0, `nenhum erro de JavaScript na página (${errors.length})`, errors.slice(0, 3));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((error) => {
  console.error('CRASH', error);
  process.exit(1);
});
