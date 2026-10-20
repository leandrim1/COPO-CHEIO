// Programa de pontos no navegador (celular e computador):
//  • painel (owner): ligar sem as regras mostra o que falta; com as quatro regras liga e grava; acerto manual com motivo; resumo e movimentos;
//  • conta do cliente: o painel "Meus pontos" só aparece com o programa ligado, mostra saldo e regras; trocar gera um cupom pessoal e debita; o cupom vale no checkout dessa conta;
//  • nada de rolagem lateral no celular.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-loyalty.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { adminLoginViaApi, finishAdminLogin, finishLogin } = require('./e2e-code.cjs');
const { patchBrowser } = require('./e2e-age.cjs');
const BASE = process.env.BASE || 'http://127.0.0.1:4180';
const DB = process.env.TEST_DB || 'copocheio_test';
const { execSync } = require('child_process');
const psql = (sql) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres ${DB} -At`, { input: sql }).toString().trim();

let cookie = '';
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.61.61.61', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
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
  await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 5, min_order: 0, free_delivery_enabled: false });
  const cat = (await api('POST', '/api/admin/categories', { name: 'Pontos' })).data.category;
  const prod = (await api('POST', '/api/admin/products', { name: 'Água Pontos', price: 50, category_id: cat.id, confirm_duplicate: true, stock: 100, alcoholic: false })).data.product;
  const email = 'pontos.cliente@exemplo.com';
  const { Client, registerVerified } = await import('./lib.mjs');
  const shopper = new Client(BASE, '10.61.61.70');
  await registerVerified(shopper, { name: 'Cliente Pontos', email, phone: '34981118888', password: 'senha-forte-123' });
  const place = async (qty) => {
    const r = await shopper.post('/api/orders', { customer_name: 'Cliente Pontos', customer_phone: '34981118888', delivery_type: 'pickup', payment_method: 'cash', items: [{ product_id: prod.id, quantity: qty }] });
    if (r.status !== 201) throw new Error('pedido recusado ' + JSON.stringify(r.data));
    return r.data.order.order_number;
  };
  const deliver = async (n) => {
    const id = psql(`select id from orders where order_number = ${n}`);
    for (const s of ['confirmed', 'preparing', 'out_for_delivery', 'delivered']) await api('PATCH', `/api/admin/orders/${id}`, { status: s, ...(s === 'delivered' ? { age_checked: true } : {}) });
  };

  const browser = patchBrowser(await chromium.launch());

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# desligado: a conta não mostra nada de pontos');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await page.getByLabel('E-mail *').fill(email);
    await page.getByLabel('Senha *').fill('senha-forte-123');
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await page.getByLabel('Código de acesso').waitFor();
    await finishLogin(page, email);
    await page.locator('[data-address-add]').waitFor({ timeout: 15000 });
    ok((await page.locator('[data-loyalty]').count()) === 0 && !/Meus pontos/.test(await text(page)), 'com o programa desligado a conta não tem "Meus pontos"');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: regras');
  {
    const { ctx, page } = await adminPage(browser);
    await page.goto(BASE + '/admin/fidelidade', { waitUntil: 'networkidle' });
    await page.locator('[data-loyalty-admin]').waitFor({ timeout: 8000 });
    ok(/Nada está ligado até você definir as regras/.test(await text(page)) && (await page.locator('[data-loyalty-per]').inputValue()) === '', 'a tela nasce sem nenhuma regra preenchida');
    await page.getByRole('switch').first().click();
    await page.locator('[data-loyalty-save]').click();
    await page.locator('[data-loyalty-error]').waitFor();
    ok(/preencha/i.test(await page.locator('[data-loyalty-error]').innerText()), 'ligar sem as regras: o servidor diz o que falta');
    ok(psql('select loyalty_enabled::text from store_settings') === 'false', '...e nada foi ligado');
    await page.locator('[data-loyalty-per]').fill('1');
    await page.locator('[data-loyalty-redeem]').fill('100');
    await page.locator('[data-loyalty-reward]').fill('5,00');
    await page.locator('[data-loyalty-days]').fill('30');
    await page.locator('[data-loyalty-save]').click();
    await page.waitForSelector('text=Regras salvas.');
    ok(psql("select loyalty_enabled::text || ':' || loyalty_points_per_real || ':' || loyalty_redeem_points || ':' || loyalty_reward_value || ':' || loyalty_coupon_days from store_settings") === 'true:1.00:100:5.00:30', 'com as quatro regras o programa liga e grava');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  const n1 = await place(4); // R$ 200 → 200 pontos
  await deliver(n1);
  ok(psql(`select coalesce(sum(points), 0) from loyalty_ledger l join customers c on c.id = l.customer_id where c.email = '${email}'`) === '200', 'preparo: pedido entregue creditou 200 pontos');

  for (const [name, viewport] of [['computador', { width: 1280, height: 900 }], ['celular', { width: 390, height: 780 }]]) {
    console.log(`# conta (${name}): saldo, troca e cupom pessoal`);
    const { ctx, page } = await newCtx(browser, viewport);
    await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await page.getByLabel('E-mail *').fill(email);
    await page.getByLabel('Senha *').fill('senha-forte-123');
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await page.getByLabel('Código de acesso').waitFor();
    await finishLogin(page, email);
    const panel = page.locator('[data-loyalty]');
    await panel.waitFor({ timeout: 15000 });
    const start = Number((await page.locator('[data-loyalty-balance]').innerText()).replace(/\D/g, ''));
    ok(start === (name === 'computador' ? 200 : 100), `${name}: o saldo aparece (${start})`, start);
    ok(/1 ponto a cada R\$ 1,00/.test(await panel.innerText()) && /100 pontos viram um cupom de R\$\s?5,00, válido por 30 dias/.test(await panel.innerText()), `${name}: as regras do dono aparecem escritas`);
    ok(/Pedido #\d+/.test(await page.locator('[data-loyalty-movements]').innerText()), `${name}: o extrato mostra o pedido que deu os pontos`);
    ok(await noHScroll(page), `${name}: sem rolagem lateral`);
    await page.locator('[data-loyalty-redeem]').click();
    await page.locator('[data-loyalty-new]').waitFor({ timeout: 8000 });
    const code = (await page.locator('[data-loyalty-new] strong').innerText()).trim();
    ok(/^PTS[0-9A-F]{8}$/.test(code), `${name}: a troca mostra o cupom pessoal (${code})`);
    const after = Number((await page.locator('[data-loyalty-balance]').innerText()).replace(/\D/g, ''));
    ok(after === start - 100, `${name}: o saldo caiu 100 (${start} → ${after})`);
    ok((await page.locator('[data-loyalty-coupons] li', { hasText: code }).count()) === 1, `${name}: o cupom também fica na lista "Seus cupons de troca"`);
    ok(await noHScroll(page), `${name}: sem rolagem lateral depois da troca`);

    // vale no checkout dessa conta
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.locator('button[aria-label="Adicionar Água Pontos ao pedido"]').first().click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-coupon-input]').waitFor({ timeout: 8000 });
    await page.locator('[data-coupon-input]').fill(code);
    await page.locator('[data-coupon-apply]').click();
    await page.locator(`[data-coupon-applied="${code}"]`).waitFor({ timeout: 8000 });
    ok(/Desconto/.test(await text(page)) && /−\s?R\$\s?5,00/.test(await text(page)), `${name}: no checkout o cupom de troca desconta R$ 5,00`);
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# o cupom pessoal não vale para visitante');
  {
    const code = psql(`select code from coupons where customer_id is not null order by created_at limit 1`);
    const { ctx, page } = await newCtx(browser, { width: 390, height: 780 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.locator('button[aria-label="Adicionar Água Pontos ao pedido"]').first().click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-coupon-input]').waitFor({ timeout: 8000 });
    await page.locator('[data-coupon-input]').fill(code);
    await page.locator('[data-coupon-apply]').click();
    await page.locator('[data-coupon-message]').waitFor();
    ok(/inválido ou expirado/.test(await page.locator('[data-coupon-message]').innerText()), 'visitante (sem a conta): "Cupom inválido ou expirado"');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: acerto manual e movimentos');
  for (const [name, viewport] of [['computador', { width: 1280, height: 900 }], ['celular', { width: 390, height: 780 }]]) {
    const { ctx, page } = await adminPage(browser, viewport);
    await page.goto(BASE + '/admin/fidelidade', { waitUntil: 'networkidle' });
    await page.locator('[data-loyalty-admin]').waitFor({ timeout: 8000 });
    ok(await noHScroll(page), `${name}: a tela de fidelidade não rola para o lado`);
    if (name === 'computador') {
      await page.locator('[data-adjust-email]').fill(email);
      await page.locator('[data-adjust-points]').fill('abc');
      await page.locator('[data-adjust-note]').fill('cortesia');
      await page.locator('[data-adjust-save]').click();
      await page.locator('[data-adjust-error]').waitFor();
      ok(/número inteiro/.test(await page.locator('[data-adjust-error]').innerText()), 'acerto com pontos que não são número: a tela explica');
      await page.locator('[data-adjust-points]').fill('25');
      await page.locator('[data-adjust-save]').click();
      await page.waitForSelector('text=Acerto registrado.');
      ok(psql("select count(*) from loyalty_ledger where kind = 'adjust' and points = 25") === '1', 'o acerto de +25 foi gravado');
      ok(/Acerto/.test(await page.locator('[data-loyalty-movements]').first().innerText()) && /cortesia/.test(await page.locator('[data-loyalty-movements]').first().innerText()), 'e aparece nos movimentos, com o motivo');
      ok(Number((await page.locator('[data-loyalty-outstanding]').innerText()).replace(/\D/g, '')) > 0, 'o resumo mostra os pontos em circulação');
    }
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
