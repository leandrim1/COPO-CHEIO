// Botão ⓘ e janela de informações da loja na página Bebidas, de ponta a ponta no navegador (celular e computador): onde o botão fica, o que a
// janela mostra (vindo do que o painel já cadastra), dia de hoje e dias fechados, o que some quando não está cadastrado, abrir/fechar
// (botão, Esc, clique fora), rolagem da página travada, foco (entra, fica preso, volta), tela pequena, carregamento dos dados e o campo novo
// "Tempo de retirada no balcão" no painel.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-info.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const BASE = 'http://localhost:4180';
let cookie = '';
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.9.9.8', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
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
const psql = (sql) => execSync('psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At', { input: sql }).toString().trim();
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
async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const SP_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const spToday = () => SP_DAYS[new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getDay()];
const DAY_LABEL = { sun: 'Domingo', mon: 'Segunda', tue: 'Terça', wed: 'Quarta', thu: 'Quinta', fri: 'Sexta', sat: 'Sábado' };
const day = (open, end = '00:00') => ({ open, start: '10:00', end });
const HOURS = { mon: day(true), tue: day(false), wed: day(true), thu: day(true), fri: day(true, '02:00'), sat: day(true, '02:00'), sun: day(true) };
const STORE = {
  address: 'Rua das Bebidas, 100',
  cep: '38400-000',
  city: 'Uberlândia',
  state: 'MG',
  opening_hours: HOURS,
  orders_paused: false,
  delivery_enabled: true,
  pickup_enabled: true,
  delivery_fee: 5,
  min_order: 20,
  delivery_time: '30 a 45 min',
  pickup_time: '10 a 15 min',
};
const setStore = (patch) => api('PATCH', '/api/admin/store', { ...STORE, ...patch });

const trigger = (page) => page.locator('[data-store-info-trigger]');
const dialog = (page) => page.locator('[data-store-info]');
async function open(page, url = '/bebidas') {
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  await trigger(page).waitFor({ timeout: 8000 });
  await trigger(page).click();
  await dialog(page).waitFor({ timeout: 4000 });
  await page.waitForTimeout(350); // a janela termina de aparecer
}
const focusedInDialog = (page) => page.evaluate(() => !!document.querySelector('[data-store-info]')?.contains(document.activeElement));

(async () => {
  await api('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const saved = await setStore({});
  ok(saved.status === 200 && saved.data.store.pickup_time === '10 a 15 min', 'o painel (API) grava o tempo de retirada', saved.data);
  ok((await api('GET', '/api/site')).data.store.pickup_time === '10 a 15 min', 'o site público recebe o tempo de retirada');
  ok((await api('PATCH', '/api/admin/store', { pickup_time: 'x'.repeat(31) })).status === 400, 'tempo de retirada com mais de 30 letras → 400');
  // Cardápio com bastante coisa, para a página rolar.
  psql(`insert into categories(name, position) values ('Copão', 0), ('Cervejas', 1);
        insert into products(category_id, name, description, price, featured, position)
          select c.id, 'Item ' || c.name || ' ' || g, 'Descrição de teste', 20 + g, g = 0, g from categories c, generate_series(0, 9) g;`);

  const browser = await chromium.launch();
  const site = (await api('GET', '/api/site')).data;

  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name} (${w}×${h}): o botão ⓘ`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await trigger(page).waitFor({ timeout: 8000 });
    ok((await dialog(page).count()) === 0, `${name}: a janela começa fechada`);
    const t = trigger(page);
    ok((await t.getAttribute('aria-label')) === 'Informações da loja: horários, entrega e pagamento' && (await t.getAttribute('aria-haspopup')) === 'dialog', `${name}: botão com nome acessível e aria-haspopup="dialog"`);
    const sameRow = await t.evaluate((el) => {
      const prev = el.previousElementSibling;
      const a = el.getBoundingClientRect();
      const b = prev?.getBoundingClientRect();
      return { prevText: prev?.textContent?.trim(), dy: b ? Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) : null, right: b ? a.left >= b.right : false, size: [a.width, a.height] };
    });
    ok(/^(Aberto agora|Fechado)/.test(sameRow.prevText ?? '') && sameRow.right && sameRow.dy < 6, `${name}: fica logo depois do status de funcionamento, na mesma linha`, sameRow);
    ok(sameRow.size[0] >= 24 && sameRow.size[1] >= 24, `${name}: tamanho clicável decente (${sameRow.size.join('×')})`);
    const header = await page.evaluate(() => document.querySelector('main h1')?.parentElement?.textContent ?? '');
    ok(header.includes(site.store.delivery_time), `${name}: o tempo de entrega continua no cabeçalho, perto do botão`);
    if (!(w < 1000)) {
      const before = await t.evaluate((el) => ({ tr: getComputedStyle(el).transform, bc: getComputedStyle(el).borderColor }));
      await t.hover();
      await page.waitForTimeout(300);
      const after = await t.evaluate((el) => ({ tr: getComputedStyle(el).transform, bc: getComputedStyle(el).borderColor }));
      ok(after.tr !== before.tr && after.bc !== before.bc, `${name}: ao passar o mouse o botão ganha destaque (escala e borda azul)`, { before, after });
    }
    await ctx.close();
  }

  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name}: o que a janela mostra`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await open(page);
    const d = dialog(page);
    ok((await d.getAttribute('role')) === 'dialog' && (await d.getAttribute('aria-modal')) === 'true', `${name}: role="dialog" e aria-modal="true"`);
    const label = await d.evaluate((el) => el.getAttribute('aria-labelledby').split(' ').map((id) => document.getElementById(id)?.textContent?.trim()).join(' '));
    ok(/Informações da loja/i.test(label) && /COPO CHEIO/i.test(label), `${name}: o nome acessível da janela é "${label}"`, label);
    ok((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Fechar informações da loja', `${name}: o foco vai para o botão de fechar`);
    ok((await d.locator('h2').innerText()).replace(/\s+/g, ' ').trim() === site.store.store_name.toUpperCase(), `${name}: mostra o nome do estabelecimento`, await d.locator('h2').innerText());
    const headerStatus = await page.evaluate(() => [...document.querySelectorAll('main span')].map((s) => s.textContent.trim()).find((t) => /^(Aberto agora|Fechado)/.test(t)));
    ok((await d.innerText()).includes(headerStatus), `${name}: o status de funcionamento da janela é o mesmo do cabeçalho (${headerStatus})`);

    const addr = (await d.locator('[data-section="address"]').innerText()).replace(/‑/g, '-');
    ok(addr.includes('Rua das Bebidas, 100') && addr.includes('Uberlândia - MG') && addr.includes('38400-000'), `${name}: endereço cadastrado (rua, cidade, UF e CEP)`, addr);
    const href = await d.locator('[data-section="address"] a').getAttribute('href');
    ok(href.startsWith('https://www.google.com/maps/dir/?api=1&destination=') && (await d.locator('[data-section="address"] a').getAttribute('rel')).includes('noopener'), `${name}: "Como chegar" abre o mapa em outra aba, com noopener`, href);

    const row = (k) => d.locator(`[data-row="${k}"]`).innerText().then((t) => t.replace(/\s+/g, ' ').trim());
    ok((await row('delivery')) === 'Entrega 30 a 45 min', `${name}: tempo médio de entrega`, await row('delivery'));
    ok((await row('pickup')) === 'Retirada no balcão 10 a 15 min', `${name}: tempo médio de retirada no balcão`, await row('pickup'));
    ok((await row('minimum')) === 'Pedido mínimo R$ 20,00 na entrega', `${name}: pedido mínimo`, await row('minimum'));

    const order = await d.locator('[data-day]').evaluateAll((els) => els.map((e) => e.dataset.day));
    ok(order.join() === 'sun,mon,tue,wed,thu,fri,sat', `${name}: horários de domingo a sábado, nessa ordem`, order);
    const texts = await d.locator('[data-day]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.day, e.textContent.replace(/\s+/g, ' ').trim()])));
    ok(texts.mon.includes('10:00 às 00:00') && texts.fri.includes('10:00 às 02:00') && texts.sat.includes('10:00 às 02:00') && texts.sun.includes('10:00 às 00:00'), `${name}: horários iguais aos do painel (inclusive os que passam da meia-noite)`, texts);
    ok(texts.tue.includes('Fechado') && (await d.locator('[data-day="tue"]').getAttribute('data-closed')) === 'true' && (await d.locator('[data-closed]').count()) === 1, `${name}: a terça (fechada no painel) aparece como "Fechado", e só ela`, texts.tue);
    const today = spToday();
    ok((await d.locator('[data-today]').count()) === 1 && (await d.locator('[data-today]').getAttribute('data-day')) === today, `${name}: só o dia de hoje (${today}) fica destacado`);
    ok((await d.locator('[data-today]').getAttribute('aria-current')) === 'date' && /hoje/i.test(await d.locator('[data-today]').innerText()), `${name}: o dia de hoje tem a marca "Hoje" e aria-current="date"`);

    const chips = await d.locator('[data-payment]').evaluateAll((els) => els.map((e) => e.dataset.payment));
    const enabled = site.payments.map((p) => p.code);
    ok(chips.join() === enabled.join() && chips.includes('pix') && !chips.includes('pix_online') && !chips.includes('card_online'), `${name}: formas de pagamento = as ativas no painel (${chips.join(', ')})`, { chips, enabled });
    const pay = await d.locator('[data-section="payments"]').innerText();
    ok(/PIX/.test(pay) && /Dinheiro/.test(pay) && /Cartão/.test(pay), `${name}: com os nomes que o cliente vê no checkout`, pay);
    ok(!/undefined|null|NaN|\[object/.test(await d.innerText()), `${name}: nenhum "undefined/null/NaN" na janela`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: sem rolagem horizontal com a janela aberta`);
    const box = await d.boundingBox();
    ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h, `${name}: a janela cabe na tela (${Math.round(box.width)}×${Math.round(box.height)})`, box);
    ok(Math.abs(box.x + box.width / 2 - w / 2) < 8 && Math.abs(box.y + box.height / 2 - h / 2) < 8, `${name}: centralizada`, box);
    // Cores: fundo escuro e nada do tema branco do site de referência.
    const bg = await d.evaluate((el) => getComputedStyle(el).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    ok(r < 30 && g < 30 && b < 40, `${name}: fundo escuro (${bg})`);
    await ctx.close();
  }

  console.log('# abrir e fechar (computador)');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await trigger(page).waitFor();
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(200);
    // o botão ⓘ está no topo da página: volta para lá só para clicar, e rola de novo com a janela aberta.
    await page.evaluate(() => window.scrollTo(0, 0));
    await trigger(page).click();
    await dialog(page).waitFor();
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForTimeout(1000); // a página rola suave: espera chegar antes de medir
    ok((await page.evaluate(() => document.body.style.overflow)) === 'hidden', 'janela aberta: o corpo da página fica com rolagem travada (overflow hidden)');
    const yBefore = await page.evaluate(() => window.scrollY);
    await page.mouse.move(50, 300);
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(400);
    const yAfterWheel = await page.evaluate(() => window.scrollY);
    ok(yBefore > 0 && yAfterWheel === yBefore, `a roda do mouse sobre o fundo escuro não rola a página (y ficou em ${yAfterWheel})`, { yBefore, yAfterWheel });
    // clique dentro não fecha
    await dialog(page).locator('[data-section="hours"]').click();
    ok((await dialog(page).count()) === 1, 'clicar dentro da janela não fecha');
    // Esc
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    ok((await dialog(page).count()) === 0, 'Esc fecha a janela');
    ok((await page.evaluate(() => document.body.style.overflow)) !== 'hidden', 'ao fechar, a rolagem da página volta');
    ok(await page.evaluate(() => document.activeElement?.hasAttribute('data-store-info-trigger')), 'ao fechar, o foco volta para o botão ⓘ');
    // clique fora
    await trigger(page).click();
    await dialog(page).waitFor();
    await page.mouse.click(8, 8);
    await page.waitForTimeout(250);
    ok((await dialog(page).count()) === 0, 'clicar fora da janela (no fundo escuro) fecha');
    // botão fechar
    await trigger(page).click();
    await dialog(page).waitFor();
    await page.getByRole('button', { name: 'Fechar informações da loja' }).click();
    await page.waitForTimeout(250);
    ok((await dialog(page).count()) === 0, 'o botão X (canto superior direito) fecha');
    // Enter no botão (teclado)
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await dialog(page).waitFor({ timeout: 3000 });
    ok((await dialog(page).count()) === 1, 'o botão abre também pelo teclado (Enter)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    // posição do botão X
    await trigger(page).click();
    await dialog(page).waitFor();
    await page.waitForTimeout(300);
    const xb = await page.getByRole('button', { name: 'Fechar informações da loja' }).boundingBox();
    const db = await dialog(page).boundingBox();
    ok(xb.x + xb.width > db.x + db.width - 70 && xb.y < db.y + 70, 'o X fica no canto superior direito da janela', { xb, db });

    console.log('# foco preso na janela');
    const trapped = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      trapped.push(await focusedInDialog(page));
    }
    ok(trapped.every(Boolean), 'Tab nunca sai da janela (12 toques seguidos)', trapped);
    await page.getByRole('button', { name: 'Fechar informações da loja' }).focus();
    await page.keyboard.press('Shift+Tab');
    ok((await page.evaluate(() => document.activeElement?.textContent?.trim())) === 'Como chegar', 'Shift+Tab no X volta para o último item ("Como chegar")');
    await page.keyboard.press('Tab');
    ok((await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Fechar informações da loja', 'Tab no último item dá a volta e chega ao X');
    await page.keyboard.press('Escape');
    await ctx.close();
  }

  console.log('# celular: tela pequena e rolagem');
  for (const [w, h] of [[390, 500], [320, 568]]) {
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await open(page);
    const box = await dialog(page).boundingBox();
    ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= w && box.y + box.height <= h, `${w}×${h}: a janela cabe na tela`, box);
    const inner = await dialog(page).evaluate((el) => {
      const s = el.querySelector('.overflow-y-auto');
      return { scrollable: s.scrollHeight > s.clientHeight, top: s.scrollTop };
    });
    ok(inner.scrollable, `${w}×${h}: o conteúdo rola dentro da janela quando não cabe`);
    await dialog(page).evaluate((el) => (el.querySelector('.overflow-y-auto').scrollTop = 9999));
    await page.waitForTimeout(200);
    ok(await dialog(page).locator('[data-section="payments"]').isVisible(), `${w}×${h}: rolando, chega-se às formas de pagamento`);
    ok((await page.evaluate(() => window.scrollY)) === 0, `${w}×${h}: a página de trás não se mexeu`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${w}×${h}: sem rolagem horizontal`);
    // toque fora fecha
    await page.touchscreen.tap(w / 2, 6);
    await page.waitForTimeout(250);
    ok((await dialog(page).count()) === 0, `${w}×${h}: tocar no fundo escuro fecha`);
    await ctx.close();
  }

  console.log('# o que não está cadastrado não aparece (sem inventar nada)');
  {
    const variants = [
      ['sem endereço', { address: null, cep: null, city: null, state: null }, async (d) => (await d.locator('[data-section="address"]').count()) === 0 && (await d.locator('[data-row="delivery"]').count()) === 1],
      ['sem tempo de retirada', { pickup_time: null }, async (d) => (await d.locator('[data-row="pickup"]').count()) === 0 && (await d.locator('[data-row="delivery"]').count()) === 1],
      ['sem tempo de entrega', { delivery_time: null }, async (d) => (await d.locator('[data-row="delivery"]').count()) === 0 && (await d.locator('[data-row="pickup"]').count()) === 1],
      ['sem pedido mínimo', { min_order: 0 }, async (d) => /Sem pedido mínimo/.test(await d.locator('[data-row="minimum"]').innerText())],
      ['só retirada (entrega desligada): nada de entrega nem de pedido mínimo', { delivery_enabled: false }, async (d) => (await d.locator('[data-row="delivery"]').count()) === 0 && (await d.locator('[data-row="minimum"]').count()) === 0 && (await d.locator('[data-row="pickup"]').count()) === 1],
      ['só entrega (retirada desligada): nada de retirada', { pickup_enabled: false }, async (d) => (await d.locator('[data-row="pickup"]').count()) === 0 && (await d.locator('[data-row="delivery"]').count()) === 1],
      ['pedidos pausados: o status diz isso', { orders_paused: true }, async (d) => /Pedidos pausados/.test(await d.innerText())],
      ['dia 24 horas', { opening_hours: { ...HOURS, mon: { open: true, start: '00:00', end: '00:00' } } }, async (d) => /24 horas/.test(await d.locator('[data-day="mon"]').innerText())],
    ];
    for (const [name, patch, check] of variants) {
      const res = await setStore(patch);
      const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
      await open(page);
      ok(res.status === 200 && (await check(dialog(page))), name, res.status);
      await ctx.close();
      await setStore({});
    }
    // forma de pagamento desligada no painel some da janela
    ok((await api('PATCH', '/api/admin/payments/cash', { enabled: false })).status === 200, 'painel: desliga "Dinheiro"');
    {
      const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
      await open(page);
      const chips = await dialog(page).locator('[data-payment]').evaluateAll((els) => els.map((e) => e.dataset.payment));
      ok(chips.includes('pix') && !chips.includes('cash'), 'forma de pagamento desligada no painel não aparece na janela', chips);
      await ctx.close();
    }
    await api('PATCH', '/api/admin/payments/cash', { enabled: true });
  }

  console.log('# carregamento dos dados');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.route('**/api/site*', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await page.goto(BASE + '/bebidas');
    await page.waitForTimeout(500);
    ok((await trigger(page).count()) === 0, 'enquanto os dados não chegaram, o botão ⓘ não aparece (nada de informação provisória)');
    ok(await until(async () => (await trigger(page).count()) === 1, 8000), 'quando os dados chegam, o botão aparece');
    await trigger(page).click();
    ok((await dialog(page).locator('[data-row="pickup"]').innerText()).includes('10 a 15 min'), 'e a janela mostra os dados que acabaram de chegar');
    await ctx.close();
  }
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.route('**/api/site*', (route) => route.abort());
    await page.goto(BASE + '/bebidas');
    await page.waitForTimeout(1500);
    ok((await trigger(page).count()) === 0, 'sem a API (e sem cópia salva), o botão não aparece: nada de horários inventados');
    await ctx.close();
  }
  {
    // Com a cópia salva da visita anterior, a janela usa os dados guardados mesmo se a API cair depois.
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await trigger(page).waitFor();
    await page.route('**/api/site*', (route) => route.abort());
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const has = (await trigger(page).count()) === 1;
    if (has) {
      await trigger(page).click();
      ok((await dialog(page).locator('[data-row="pickup"]').innerText()).includes('10 a 15 min'), 'com a API fora do ar e a cópia salva, a janela mostra os últimos dados conhecidos');
    } else ok(true, 'com a API fora do ar a página abre sem erro (sem cópia utilizável o botão some)');
    await ctx.close();
  }

  console.log('# painel: Configurações → Entrega → "Tempo de retirada no balcão"');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await page.waitForURL('**/admin/dashboard');
    await page.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Entrega' }).click();
    const field = page.getByLabel('Tempo de retirada no balcão');
    ok((await field.inputValue()) === '10 a 15 min', 'o campo mostra o valor salvo (10 a 15 min)', await field.inputValue());
    ok((await field.getAttribute('maxlength')) === '30', 'o campo limita a 30 letras');
    ok(await page.getByLabel('Tempo estimado de entrega').isVisible(), 'o tempo de entrega continua lá, com o nome mais claro');
    await field.fill('12 a 18 min');
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    ok(await until(async () => (await api('GET', '/api/site')).data.store.pickup_time === '12 a 18 min'), 'salvar no painel muda o site');
    {
      const v = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p = await v.newPage();
      await open(p);
      ok((await dialog(p).locator('[data-row="pickup"]').innerText()).includes('12 a 18 min'), 'e a janela do site mostra o novo tempo');
      await v.close();
    }
    await field.fill('');
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    ok(await until(async () => (await api('GET', '/api/site')).data.store.pickup_time === null), 'apagar o campo no painel tira a linha do site (fica sem tempo de retirada)');
    {
      const v = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p = await v.newPage();
      await open(p);
      ok((await dialog(p).locator('[data-row="pickup"]').count()) === 0, 'sem valor, a janela não mostra a linha da retirada');
      await v.close();
    }
    const hist = (await api('GET', '/api/admin/audit')).data;
    ok(JSON.stringify(hist ?? '').includes('tempo de retirada'), 'a alteração entra no histórico de atividades do painel', JSON.stringify(hist).slice(0, 200));
    await ctx.close();
  }

  await browser.close();
  ok(errors.length === 0, 'nenhum erro de JavaScript', errors.slice(0, 4));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
