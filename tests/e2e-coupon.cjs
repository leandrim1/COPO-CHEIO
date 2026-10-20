// Cupons e entrega grátis, de ponta a ponta no navegador (celular e computador):
//  • painel (owner): cria, desliga/liga e confere cupom pela tela; configura a entrega grátis por valor em Configurações → Entrega;
//  • checkout: campo de cupom (código errado mostra o motivo; certo mostra o desconto vindo do servidor e o novo total), remover, cupom digitado e não aplicado
//    bloqueia o envio, aviso "faltam R$ X para a entrega grátis", entrega riscada e "Grátis" quando vale;
//  • o pedido grava e mostra o cupom e o desconto (página do cliente e painel); nada de rolagem lateral no celular.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-coupon.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
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
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.30.30.30', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
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
const brl = (n) => n.toFixed(2).replace('.', ',');
const text = (page) => page.evaluate(() => document.body.innerText);

async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}

async function addToCart(page, productName, times = 1) {
  await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  // O primeiro toque coloca no pedido; a partir daí o cartão do produto mostra "Aumentar"/"Diminuir".
  await page.locator(`button[aria-label="Adicionar ${productName} ao pedido"]`).first().click();
  for (let i = 1; i < times; i++) {
    await page.waitForTimeout(250);
    await page.locator(`button[aria-label="Aumentar ${productName}"]`).first().click();
  }
  await page.waitForTimeout(250);
}
async function fillCheckout(page, suffix, { pickup = true } = {}) {
  await page.getByLabel('Nome *').fill('Cliente Cupom ' + suffix);
  await page.getByLabel('Telefone / WhatsApp *').fill('3498' + String(7000000 + Math.floor(Math.random() * 999999)));
  if (pickup) await page.getByText('Retirar na loja', { exact: true }).click();
  await page.waitForTimeout(700); // o site só aceita pedido depois de 0,6 s na tela
}
const orderNumberOf = async (page) => {
  await page.waitForURL(/\/pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, { timeout: 15000 });
  await page.waitForSelector('text=Pedido recebido!');
  return Number((/Seu pedido #(\d+) foi enviado/.exec(await text(page)) || [])[1]);
};

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const store = await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 6, min_order: 0, free_delivery_enabled: false, free_delivery_min: 0 });
  ok(store.status === 200, 'preparo: loja aberta, taxa única de R$ 6, entrega grátis desligada', store.data);
  const cat = (await api('POST', '/api/admin/categories', { name: 'Teste Cupom' })).data.category;
  const mk = async (name, price, extra) => (await api('POST', '/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, stock: 200, ...extra })).data.product;
  const water = await mk('Água Cupom', 20, { alcoholic: false });
  await mk('Gelo Cupom', 10, { alcoholic: false });

  const browser = patchBrowser(await chromium.launch());

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel (owner): Cupons pela tela');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await finishAdminLogin(page);
    await page.waitForURL('**/admin/dashboard');
    ok((await page.locator('nav[aria-label="Menu do painel"] a:visible', { hasText: 'Cupons' }).count()) === 1, 'o menu do owner tem "Cupons"');
    await page.locator('nav[aria-label="Menu do painel"] a:visible', { hasText: 'Cupons' }).click();
    await page.waitForURL('**/admin/cupons');
    await page.waitForSelector('text=Nenhum cupom', { timeout: 8000 }).catch(() => undefined);
    ok(/Nenhum cupom/.test(await text(page)), 'começa sem nenhum cupom');

    await page.locator('[data-coupon-new]').first().click();
    await page.locator('[data-coupon-code]').waitFor();
    await page.locator('[data-coupon-save]').click();
    ok(/O código precisa ter de 3 a 30/.test(await page.locator('[data-coupon-error]').innerText()), 'salvar sem código: explica o formato');
    await page.locator('[data-coupon-code]').fill('bem vindo');
    await page.locator('[data-coupon-save]').click();
    ok((await page.locator('[data-coupon-error]').count()) === 1, 'código com espaço: recusado na tela');
    await page.locator('[data-coupon-code]').fill('bemvindo10');
    ok((await page.locator('[data-coupon-code]').inputValue()) === 'BEMVINDO10', 'o código vira maiúsculas ao digitar');
    await page.locator('[data-coupon-value]').fill('150');
    await page.locator('[data-coupon-save]').click();
    ok(/entre 1 e 100/.test(await page.locator('[data-coupon-error]').innerText()), 'porcentagem acima de 100: recusada');
    await page.locator('[data-coupon-value]').fill('10');
    await page.locator('[data-coupon-save]').click();
    await page.waitForSelector('text=Cupom criado.');
    const row = page.locator('[data-coupon="BEMVINDO10"]');
    await row.waitFor();
    const rowText = await row.innerText();
    ok(/Valendo/.test(rowText) && /10% de desconto/.test(rowText) && /0 uso/.test(rowText), 'o cupom aparece valendo, com 10% e 0 uso', rowText);
    ok(psql("select count(*) from coupons where code = 'BEMVINDO10' and kind = 'percent' and value = 10") === '1', 'e foi gravado no banco');

    await page.locator('[data-coupon-new]').first().click();
    await page.locator('[data-coupon-code]').fill('BEMVINDO10');
    await page.locator('[data-coupon-value]').fill('5');
    await page.locator('[data-coupon-save]').click();
    ok(/já existe um cupom/i.test(await page.locator('[data-coupon-error]').innerText()), 'código repetido: o servidor recusa e a tela explica');
    await page.keyboard.press('Escape');

    await row.getByRole('switch').click();
    await page.waitForSelector('text=Cupom desligado.');
    ok(/Desligado/.test(await row.innerText()) && psql("select active from coupons where code = 'BEMVINDO10'") === 'f', 'desligar: a lista e o banco mostram desligado');
    await row.getByRole('switch').click();
    await page.waitForSelector('text=Cupom ligado.');
    ok(psql("select active from coupons where code = 'BEMVINDO10'") === 't', 'ligar de novo');

    // Entrega grátis por valor, pela tela de Configurações → Entrega
    await page.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /Entrega/ }).click().catch(async () => page.getByText('Entrega', { exact: true }).first().click());
    await page.locator('[data-free-delivery-settings]').waitFor({ timeout: 8000 });
    await page.locator('[data-free-delivery-settings]').getByRole('switch').click();
    await page.locator('[data-free-delivery-min]').fill('100');
    await page.getByRole('button', { name: /^Salvar/ }).first().click();
    await page.waitForSelector('text=Entrega salva.');
    ok(psql('select free_delivery_enabled::text || free_delivery_min::text from store_settings') === 'true100.00', 'entrega grátis a partir de R$ 100 gravada');
    await ctx.close();
  }

  // Outros cupons pela API (o foco da tela é o checkout)
  await api('POST', '/api/admin/coupons', { code: 'FRETE', kind: 'free_delivery', value: 0 });
  await api('POST', '/api/admin/coupons', { code: 'VENCIDO', kind: 'percent', value: 50, ends_at: new Date(Date.now() - 3600_000).toISOString() });

  // ---------------------------------------------------------------------------------------------------------------------------------
  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name} (${w}×${h}): cupom no checkout`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await addToCart(page, 'Água Cupom', 2); // R$ 40
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-coupon-input]').waitFor({ timeout: 8000 });
    await fillCheckout(page, name, { pickup: false });
    await page.getByLabel('Rua / Avenida *').fill('Rua das Flores');
    await page.getByLabel('Número *').fill('10');
    await page.getByLabel('Bairro *').fill('Centro');

    // entrega: R$ 6, aviso de entrega grátis
    let t = await text(page);
    ok(/R\$\s?40,00/.test(t) && /R\$\s?6,00/.test(t), `${name}: sem cupom o total é R$ 46,00 (itens R$ 40 + entrega R$ 6)`, t.slice(-400));
    ok(/Entrega grátis a partir de R\$\s?100,00: faltam R\$\s?60,00/.test(await page.locator('[data-free-delivery-hint]').first().innerText()), `${name}: o resumo avisa quanto falta para a entrega grátis`);

    // código errado
    await page.locator('[data-coupon-input]').fill('naoexiste');
    ok((await page.locator('[data-coupon-input]').inputValue()) === 'NAOEXISTE', `${name}: o campo põe em maiúsculas`);
    await page.locator('[data-coupon-apply]').click();
    await page.locator('[data-coupon-message]').waitFor();
    ok(/Cupom inválido ou expirado/.test(await page.locator('[data-coupon-message]').innerText()), `${name}: código que não existe: mensagem do servidor`);
    await page.locator('[data-coupon-input]').fill('vencido');
    await page.locator('[data-coupon-apply]').click();
    await page.waitForFunction(() => /inválido ou expirado/.test(document.querySelector('[data-coupon-message]')?.textContent ?? ''));
    ok(true, `${name}: cupom vencido dá a MESMA mensagem (não revela que o código existe)`);

    // código certo
    await page.locator('[data-coupon-input]').fill('BEMVINDO10');
    await page.keyboard.press('Enter');
    await page.locator('[data-coupon-applied="BEMVINDO10"]').waitFor({ timeout: 8000 });
    t = await text(page);
    ok(/Desconto \(BEMVINDO10\)/.test(t) && /−\s?R\$\s?4,00/.test(t), `${name}: mostra "Desconto (BEMVINDO10) − R$ 4,00" (10% de R$ 40)`, t.slice(-500));
    ok(/R\$\s?42,00/.test(await page.locator('aside').innerText()), `${name}: o total passa a R$ 42,00 (40 − 4 + 6)`);
    ok((await page.locator('[data-coupon-input]').count()) === 0, `${name}: depois de aplicar, o campo some (um cupom por pedido)`);
    if (w < 1000) ok(await noHScroll(page), `${name}: sem rolagem lateral com o cupom aplicado`);

    // remover e digitar sem aplicar
    await page.locator('[data-coupon-remove]').click();
    await page.locator('[data-coupon-input]').waitFor();
    ok(/R\$\s?46,00/.test(await page.locator('aside').innerText()), `${name}: remover o cupom volta ao total sem desconto`);
    await page.locator('[data-coupon-input]').fill('BEMVINDO10');
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    await page.locator('[data-coupon-message]').waitFor();
    ok(/Toque em “Aplicar”/.test(await page.locator('[data-coupon-message]').innerText()) && !/\/pedido\//.test(page.url()), `${name}: cupom digitado e não aplicado bloqueia o envio e explica`);
    await page.locator('[data-coupon-apply]').click();
    await page.locator('[data-coupon-applied="BEMVINDO10"]').waitFor();

    // finalizar
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    const o = psql(`select discount, total, coupon_code, delivery_fee, delivery_fee_waived from orders where order_number = ${number}`);
    ok(o === '4.00|42.00|BEMVINDO10|6.00|0.00', `${name}: o pedido #${number} grava o desconto, o cupom e o total que a pessoa viu (${o})`);
    t = await text(page);
    ok(/Desconto \(BEMVINDO10\)/.test(t) && /−\s?R\$\s?4,00/.test(t), `${name}: a página do pedido mostra o cupom e o desconto`);
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# entrega grátis: por valor e por cupom');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await addToCart(page, 'Água Cupom', 5); // R$ 100
    // O carrinho (gaveta) fica no HTML mesmo fechado: lê o texto dele sem depender de estar visível.
    const drawer = (await page.locator('[data-free-delivery-hint]').first().textContent().catch(() => '')) ?? '';
    ok(/Entrega grátis neste pedido/.test(drawer) && !/Faltam/.test(drawer), 'o carrinho diz "Entrega grátis neste pedido!" (e não "faltam") quando já chegou no valor', drawer);
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await fillCheckout(page, 'gratis', { pickup: false });
    await page.getByLabel('Rua / Avenida *').fill('Rua das Flores');
    await page.getByLabel('Número *').fill('11');
    await page.getByLabel('Bairro *').fill('Centro');
    const dl = page.locator('[data-delivery-line="waived"]');
    await dl.waitFor({ timeout: 8000 });
    const d = await dl.innerText();
    ok(/R\$\s?6,00/.test(d) && /Grátis/.test(d), 'R$ 100 de itens: a entrega aparece riscada (R$ 6,00) e "Grátis"', d);
    ok(/R\$\s?100,00/.test(await page.locator('aside').innerText()), 'o total é R$ 100,00');
    ok((await page.locator('[data-free-delivery-hint]').count()) === 0, 'não mostra mais o aviso de quanto falta');
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    ok(psql(`select delivery_fee, delivery_fee_waived, total from orders where order_number = ${number}`) === '0.00|6.00|100.00', `o pedido #${number} grava a entrega dispensada (0,00 cobrada, 6,00 dispensada)`);
    ok(/Grátis/.test(await text(page)), 'a página do pedido mostra a entrega grátis');
    await ctx.close();
  }
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await addToCart(page, 'Água Cupom', 1); // R$ 20: abaixo do valor
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await fillCheckout(page, 'cupom-frete', { pickup: false });
    await page.getByLabel('Rua / Avenida *').fill('Rua das Flores');
    await page.getByLabel('Número *').fill('12');
    await page.getByLabel('Bairro *').fill('Centro');
    ok(/R\$\s?26,00/.test(await page.locator('aside').innerText()), 'R$ 20 + entrega R$ 6 = R$ 26,00 (abaixo do valor da entrega grátis)');
    await page.locator('[data-coupon-input]').fill('FRETE');
    await page.locator('[data-coupon-apply]').click();
    await page.locator('[data-coupon-applied="FRETE"]').waitFor();
    ok((await page.locator('[data-delivery-line="waived"]').count()) === 1 && /R\$\s?20,00/.test(await page.locator('aside').innerText()), 'cupom de entrega grátis: a entrega some e o total é R$ 20,00');
    // trocar para retirada: o cupom de entrega deixa de valer e a tela avisa
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-coupon-applied]'), null, { timeout: 8000 });
    ok(/vale só para entrega/.test(await page.locator('[data-coupon-message]').innerText()), 'ao mudar para retirada o cupom de entrega sai com o motivo');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: o pedido mostra o cupom');
  {
    const number = Number(psql("select order_number from orders where coupon_code = 'BEMVINDO10' order by order_number limit 1"));
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await finishAdminLogin(page);
    await page.waitForURL('**/admin/dashboard');
    await page.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
    const t = await text(page);
    ok(/Desconto \(cupom BEMVINDO10\)/.test(t) && /R\$\s?4,00/.test(t), 'o detalhe do pedido no painel mostra "Desconto (cupom BEMVINDO10)"', t.slice(0, 300));
    await page.goto(BASE + '/admin/cupons', { waitUntil: 'networkidle' });
    ok(/[1-9] uso/.test(await page.locator('[data-coupon="BEMVINDO10"]').innerText()), 'a lista de cupons conta o uso');
    await ctx.close();
  }

  await browser.close();
  ok(errors.length === 0, 'nenhum erro de JavaScript nas páginas', errors.slice(0, 3));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH', e.message);
  console.log(e.stack?.split('\n').slice(0, 4).join('\n'));
  process.exit(2);
});
