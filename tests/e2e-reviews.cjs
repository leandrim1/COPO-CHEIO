// Avaliações e entregadores no navegador (celular e computador):
//  • painel: cadastrar o entregador (Configurações → Entrega), escolhê-lo no pedido de entrega;
//  • site: o cliente vê só o PRIMEIRO nome do entregador enquanto o pedido está a caminho; depois de entregue avalia com estrelas e comentário (uma vez);
//  • painel: a avaliação chega "aguardando", é publicada, e o público só recebe nota, comentário e data (nunca nome, telefone ou número do pedido); estado das rotinas em "Estado do sistema".
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-reviews.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
const { patchBrowser } = require('./e2e-age.cjs');
const BASE = process.env.BASE || 'http://127.0.0.1:4180';
const DB = process.env.TEST_DB || 'copocheio_test';
const { execSync } = require('child_process');
const psql = (sql) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres ${DB} -At`, { input: sql }).toString().trim();

let cookie = '';
async function api(method, path, body, headers = {}) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.51.51.51', ...(cookie && !headers.nocookie ? { cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined };
  delete init.headers.nocookie;
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
  if (set && !headers.nocookie) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const errors = [];
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const text = (page) => page.evaluate(() => document.body.innerText);

async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
async function adminPage(browser, viewport = { width: 1280, height: 900 }) {
  const { ctx, page } = await newCtx(browser, viewport);
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'dono@copocheio.local');
  await page.fill('#login-senha', 'senha-forte-123');
  await page.click('button[type=submit]');
  await finishAdminLogin(page);
  await page.waitForURL('**/admin/dashboard');
  return { ctx, page };
}

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 5, min_order: 0 });
  const cat = (await api('POST', '/api/admin/categories', { name: 'Avaliar' })).data.category;
  const beer = (await api('POST', '/api/admin/products', { name: 'Cerveja Avaliar', price: 10, category_id: cat.id, confirm_duplicate: true, stock: 100, alcoholic: false })).data.product;
  const placed = await api('POST', '/api/orders', {
    customer_name: 'Marina Souza Lima',
    customer_phone: '34988776655',
    delivery_type: 'delivery',
    address: 'Rua das Flores',
    address_number: '10',
    neighborhood: 'Centro',
    payment_method: 'pix',
    items: [{ product_id: beer.id, quantity: 2 }],
    age_confirmed: true,
  }, { nocookie: '1' });
  ok(placed.status === 201, 'preparo: pedido de entrega criado', placed.data);
  const number = placed.data.order.order_number;
  const token = placed.data.token;
  const orderId = psql(`select id from orders where order_number = ${number}`);
  const patch = (status) => api('PATCH', `/api/admin/orders/${orderId}`, { status });
  await patch('confirmed');
  await patch('preparing');

  const browser = patchBrowser(await chromium.launch());

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: cadastrar o entregador e escolhê-lo no pedido');
  {
    const { ctx, page } = await adminPage(browser);
    await page.goto(BASE + '/admin/configuracoes#entrega', { waitUntil: 'networkidle' });
    await page.locator('[data-couriers]').waitFor({ timeout: 8000 });
    await page.locator('[data-courier-new]').click();
    await page.locator('[data-courier-name]').fill('José Carlos da Silva');
    await page.locator('button[form="entregador-form"]').click();
    await page.locator('[data-courier="José Carlos da Silva"]').waitFor({ timeout: 8000 });
    ok(psql(`select count(*) from couriers where name = 'José Carlos da Silva'`) === '1', 'o entregador foi cadastrado pela tela');
    await patch('out_for_delivery');
    await page.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
    const picker = page.locator('[data-courier-picker] select');
    await picker.waitFor({ timeout: 8000 });
    await picker.selectOption({ label: 'José Carlos da Silva' });
    await page.getByText('Atual: José Carlos da Silva').waitFor({ timeout: 8000 });
    ok(psql(`select courier_name from orders where order_number = ${number}`) === 'José Carlos da Silva', 'o nome do entregador ficou gravado no pedido');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# site: primeiro nome do entregador, depois avaliação');
  for (const [name, viewport] of [['celular', { width: 390, height: 780 }], ['computador', { width: 1280, height: 900 }]]) {
    const { ctx, page } = await newCtx(browser, viewport);
    await page.goto(BASE + `/acompanhar-pedido/${token}`, { waitUntil: 'networkidle' });
    const notice = page.locator('[data-courier-notice]');
    await notice.waitFor({ timeout: 8000 });
    ok(/José/.test(await notice.innerText()) && !/Carlos|Silva/.test(await text(page)), `${name}: a pessoa vê só o primeiro nome do entregador`);
    ok((await page.locator('[data-review-form]').count()) === 0, `${name}: antes da entrega não há avaliação`);
    ok(await noHScroll(page), `${name}: sem rolagem lateral`);
    await ctx.close();
  }
  await patch('delivered');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 780 });
    await page.goto(BASE + `/acompanhar-pedido/${token}`, { waitUntil: 'networkidle' });
    ok((await page.locator('[data-courier-notice]').count()) === 0, 'entregue: o nome do entregador deixa de aparecer');
    const form = page.locator('[data-review-form]');
    await form.waitFor({ timeout: 8000 });
    await page.locator('[data-review-send]').click();
    ok(/Toque nas estrelas/.test(await text(page)), 'enviar sem nota: explica o que fazer');
    await page.locator('[data-star="4"]').click();
    ok((await page.locator('[data-star="4"]').getAttribute('aria-checked')) === 'true', 'a estrela escolhida fica marcada (para leitor de tela também)');
    await page.locator('[data-review-comment]').fill('Chegou geladinha e rápido!');
    ok(await noHScroll(page), 'celular: sem rolagem lateral no formulário de avaliação');
    await page.locator('[data-review-send]').click();
    await page.locator('[data-review-done]').waitFor({ timeout: 8000 });
    ok(/Obrigado pela avaliação/.test(await text(page)) && /Chegou geladinha/.test(await text(page)), 'depois de enviar aparece o agradecimento com a nota');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-review-done]').waitFor({ timeout: 8000 });
    ok((await page.locator('[data-review-form]').count()) === 0, 'recarregar: avalia uma vez só (o formulário não volta)');
    await ctx.close();
  }
  const pending = await api('GET', '/api/reviews', undefined, { nocookie: '1' });
  ok(pending.status === 200 && pending.data.summary.count === 0 && pending.data.reviews.length === 0, 'aguardando: o público ainda não vê nada', pending.data);

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: moderar a avaliação');
  for (const [name, viewport] of [['computador', { width: 1280, height: 900 }], ['celular', { width: 390, height: 780 }]]) {
    const { ctx, page } = await adminPage(browser, viewport);
    await page.goto(BASE + '/admin/avaliacoes', { waitUntil: 'networkidle' });
    // O filtro nasce em "Aguardando"; no segundo passo (celular) a avaliação já foi publicada, então se olha em "Publicadas".
    if (name === 'celular') await page.getByRole('button', { name: 'Publicadas' }).click();
    const row = page.locator('[data-review]').first();
    await row.waitFor({ timeout: 8000 });
    ok(/Chegou geladinha/.test(await row.innerText()) && new RegExp(`#${number}`).test(await row.innerText()), `${name}: a avaliação aparece com o número do pedido`);
    ok(await noHScroll(page), `${name}: lista sem rolagem lateral`);
    if (name === 'computador') {
      await row.locator('[data-review-publish]').click();
      await page.waitForFunction(() => !document.querySelector('[data-review-publish]'), null, { timeout: 8000 });
      ok(psql(`select status from order_reviews`) === 'published', 'publicar muda o estado no banco');
    }
    await ctx.close();
  }
  const published = await api('GET', '/api/reviews', undefined, { nocookie: '1' });
  const body = JSON.stringify(published.data);
  ok(published.data.summary.count === 1 && published.data.summary.average === 4 && published.data.reviews[0].comment === 'Chegou geladinha e rápido!', 'publicada: o público recebe nota, média e comentário', published.data);
  ok(!/Marina|Souza|34988776655|"order/.test(body) && Object.keys(published.data.reviews[0]).sort().join() === 'comment,created_at,rating', 'o público NUNCA recebe nome, telefone nem número do pedido', published.data);

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# estado das rotinas automáticas');
  {
    const { ctx, page } = await adminPage(browser);
    await page.goto(BASE + '/admin/configuracoes#painel', { waitUntil: 'networkidle' });
    await page.getByText('Rotina automática').first().waitFor({ timeout: 8000 });
    ok(/Nunca rodou|Não configurado|Atrasada/.test(await text(page)), 'sem a rotina ter rodado, o painel avisa em vez de dizer que está tudo bem');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de JavaScript na página', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(1);
});
