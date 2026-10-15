// Cartão de crédito online no navegador, em celular e computador: o resumo do checkout muda em tempo real (taxa do cartão e total), a tela /pagar
// (formulário, SDK da operadora, aprovado, recusado, recarga no meio do pagamento, pendente, clique duplo), o que NUNCA chega ao servidor da loja
// (número do cartão, CVV) e o painel (taxa do cartão, Pagamentos, detalhe do pedido).
//
// ATENÇÃO: a operadora é um SERVIDOR FALSO (tests/validapay-fake.mjs) e o SDK da ValidaPay (@validapay/tokenize) é o de verdade, mas as chamadas dele
// para https://sandbox.validapay.com.br são interceptadas e respondidas pelo servidor falso. O antifraude (online-metrix.net) é bloqueado. Isto prova as
// telas e a lógica da loja contra o contrato documentado; NÃO prova a integração real, que só o sandbox da ValidaPay pode provar.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-card.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const path = require('node:path');
const { execFileSync, execSync } = require('child_process');
const SP = process.env.TEST_OUT || path.join(require('node:os').tmpdir(), 'copocheio-tests');
fs.mkdirSync(SP, { recursive: true });
const FX = path.join(__dirname, 'fixtures');
const ROOT = path.join(__dirname, '..');
const BASE = 'http://localhost:4180', BLOB = 'http://127.0.0.1:4181';
const PAN = '4111111111111111';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
let cookie = '';
async function api(method, p, body, raw) {
  const init = { method, headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) };
  let res;
  for (let i = 0; ; i++) { try { res = await fetch(BASE + p, init); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)); } }
  const set = res.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const t = await res.text(); return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
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
const leaks = [];
const storeRequests = [];
const sdkCalls = [];
let fake;
const text = async (page) => (await page.innerText('body')).replace(/\s+/g, ' ');
const money = (cents) => `R$ ${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}`;
// A conta de cima para baixo, escrita de outro jeito de propósito (inteiros).
const feeOf = (base, bps = 537, fixed = 37) => { const n = (base + fixed) * 10000, d = 10000 - bps; return Math.floor((2 * n + d) / (2 * d)) - base; };

async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => { await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + new URL(route.request().url()).pathname }) }); });
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  // O SDK da ValidaPay fala com a API dela direto do navegador: aqui essas chamadas vão para o servidor falso.
  await ctx.route('https://sandbox.validapay.com.br/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': BASE, 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    sdkCalls.push({ method: req.method(), path: u.pathname });
    const res = await fetch(fake.url + u.pathname, { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.postData() ?? undefined });
    return route.fulfill({ status: res.status, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
  });
  // O antifraude carrega de fora: bloqueado nos testes (a CSP só precisa permitir; o domínio não responde daqui).
  await ctx.route(/online-metrix\.net/, (route) => route.abort());
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|online-metrix/.test(m.text())) errors.push(m.text()); });
  // O que sai para o servidor DA LOJA nunca leva o número do cartão.
  page.on('request', (req) => {
    if (!req.url().startsWith(BASE)) return;
    storeRequests.push({ method: req.method(), url: req.url() });
    const blob = `${req.url()} ${req.postData() ?? ''}`;
    if (blob.includes(PAN) || /"cvv"|"number"/.test(blob)) leaks.push(`${req.method()} ${req.url()}`);
  });
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const addButton = (page, name) => page.getByRole('button', { name: new RegExp(`^Adicionar (mais )?${name}`) }).first();
let phone = 0;
const nextPhone = () => `3498${String(3000000 + ++phone).slice(-7)}`;
const summary = (page) => page.locator('aside').first();

// Do cardápio ao checkout com a garrafa de R$ 100 no pedido.
async function toCheckout(page) {
  await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await addButton(page, 'Garrafa Cem').click();
  await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
}
async function fillCustomer(page, name = 'Cliente Cartão Teste', email = 'cartao.e2e@exemplo.com') {
  await page.getByLabel('Nome *').fill(name);
  await page.getByLabel('Telefone / WhatsApp *').fill(nextPhone());
  await page.getByLabel(/^E-mail/).fill(email);
  await page.getByText('Retirar na loja', { exact: true }).click();
}
const pickCard = (page) => page.locator('label').filter({ hasText: /Cartão online/ }).first().click();

// Faz o pedido no cartão e cai na tela /pagar (carregamento completo).
async function orderToCardPage(page, opts) {
  await toCheckout(page);
  await fillCustomer(page, opts?.name);
  await pickCard(page);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: /^Finalizar e pagar com cartão/ }).click();
  await page.waitForURL('**/pagar/**', { timeout: 15000 });
  await page.getByRole('heading', { level: 1 }).waitFor();
}
async function fillCard(page, { number = PAN, holder = 'MARIA TESTE', expiry = '12/30', cvv = '123', document = '529.982.247-25' } = {}) {
  await page.getByLabel('Número do cartão *').fill(number);
  await page.getByLabel('Nome impresso no cartão *').fill(holder);
  await page.getByLabel('Validade *').fill(expiry);
  await page.getByLabel('Código de segurança *').fill(cvv);
  await page.getByLabel('CPF ou CNPJ de quem paga *').fill(document);
}
const lastOrder = () => JSON.parse(psql(`select row_to_json(o) from orders o where payment_method = 'card_online' order by order_number desc limit 1`));

(async () => {
  const { startFakeValidaPay, FAKE, postWebhook, paymentSuccess, paymentSuccessCard } = await import(path.join(ROOT, 'tests/validapay-fake.mjs'));
  fake = await startFakeValidaPay();
  execSync(`bash ${ROOT}/tests/serve.sh`, { env: { ...process.env, PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500', FAKE_VALIDAPAY_CARD_TIMEOUT_MS: '2500' }, stdio: 'ignore' });

  await api('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
  const img = (await api('POST', '/api/admin/upload?folder=products', fs.readFileSync(FX + '/lata.webp'), true)).data.url;
  const cat = (await api('POST', '/api/admin/categories', { name: 'Garrafas' })).data.category;
  const bottle = (await api('POST', '/api/admin/products', { name: 'Garrafa Cem', price: 100, category_id: cat.id, image_url: img, description: 'Teste.', featured: true, stock: 100, confirm_duplicate: true })).data.product;
  ok(!!bottle?.id, 'dados de teste criados');
  const browser = await chromium.launch();

  // ---- 1. Desligado: o checkout é o de sempre ---------------------------------------------------------------------------------------------
  console.log('# 1. Cartão online desligado: nada muda no checkout');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await toCheckout(page);
    const radios = await page.getByRole('radiogroup', { name: 'Forma de pagamento' }).getByRole('radio').count();
    ok(radios === 3, 'só as 3 formas de sempre (PIX, Dinheiro, Cartão na entrega)', radios);
    const body = await text(page);
    ok(!/Cartão online|Taxa do cartão/.test(body), 'nenhuma menção ao cartão online nem à taxa do cartão');
    ok(/Total/.test(body) && /R\$ 100,00/.test(body), 'o total é o de sempre (R$ 100,00)');
    await ctx.close();
  }

  // ---- 2. O dono liga (pelo painel) --------------------------------------------------------------------------------------------------------
  console.log('# 2. O dono confere a taxa e liga o cartão online pelo painel');
  const { ctx: actx, page: admin } = await newCtx(browser, { width: 1280, height: 800 });
  await admin.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await admin.fill('#login-email', 'dono@copocheio.local');
  await admin.fill('#login-senha', 'senha-forte-123');
  await admin.click('button[type=submit]');
  await admin.waitForURL('**/admin/dashboard');
  // O cartão é cobrado na SUBCONTA do estabelecimento (a mesma do Pix; só o Pix tem split): sem ela, o cartão não liga.
  await admin.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
  ok(/conta aprovada/.test(await admin.locator('[data-card-missing]').getAttribute('data-card-missing')), 'sem a subconta, o cartão online pede "conta aprovada" (como o Pix)');
  const link = await api('POST', '/api/admin/payments/account/link', { account_number: '4960589', authorized: true });
  ok(link.status === 201, 'a subconta do estabelecimento é vinculada (sandbox falso)', link);
  await admin.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
  {
    const body = await text(admin);
    ok(/Cartão de crédito online/.test(body) && /Taxa do cartão repassada ao cliente/.test(body), 'a página Pagamentos tem o bloco "Cartão de crédito online" com a taxa do cartão');
    ok(/Ainda NÃO conferida/.test(body), 'a taxa aparece como "Ainda NÃO conferida"');
    ok(await admin.getByRole('switch', { name: 'Oferecer cartão de crédito online no checkout' }).isDisabled(), 'o interruptor do cartão online fica desabilitado enquanto a taxa não for conferida');
    const missing = await admin.locator('[data-card-missing]').getAttribute('data-card-missing');
    ok(missing === 'taxa do cartão conferida', 'com a subconta aprovada, o que falta para ligar o cartão é só "taxa do cartão conferida"', missing);
    ok(/Confira no painel ou no contrato da ValidaPay/.test(body), 'o aviso manda conferir 5,37% + R$ 0,37 no contrato da ValidaPay');
    const percent = await admin.getByLabel('Percentual (%)').inputValue();
    const fixed = await admin.getByLabel('Tarifa fixa por venda (R$)').inputValue();
    ok(percent === '5,37' && fixed === '0,37', 'os valores de referência vêm do banco: 5,37 e 0,37', [percent, fixed]);
    const rows = await admin.locator('[data-card-examples] tbody tr').allInnerTexts();
    ok(rows.length === 3 && /R\$\s*10,00\s+R\$\s*0,96\s+R\$\s*10,96/.test(rows[0].replace(/\s+/g, ' ')) && /R\$\s*100,00\s+R\$\s*6,07\s+R\$\s*106,07/.test(rows[2].replace(/\s+/g, ' ')), 'exemplos ao vivo: R$ 10 → R$ 10,96 e R$ 100 → R$ 106,07', rows);
    // Mudar o valor atualiza os exemplos na hora, sem salvar.
    await admin.getByLabel('Percentual (%)').fill('3');
    ok(await until(async () => new RegExp(`R\\$\\s*100,00\\s+${money(feeOf(10000, 300, 37)).replace('$', '\\$')}\\s+${money(10000 + feeOf(10000, 300, 37)).replace('$', '\\$')}`).test(await text(admin))), `digitar outro percentual mostra os exemplos novos na hora (3% + R$ 0,37 → taxa ${money(feeOf(10000, 300, 37))}, total ${money(10000 + feeOf(10000, 300, 37))})`);
    await admin.getByLabel('Percentual (%)').fill('5,37');
    ok(await admin.locator('[data-card-save]').isDisabled(), 'sem mudança e sem marcar a conferência, o botão fica desabilitado');
    await admin.screenshot({ path: `${SP}/card-admin-1-taxa.png`, fullPage: true });
    await admin.locator('[data-card-confirm]').check();
    await admin.locator('[data-card-save]').click();
    ok(await until(async () => /Conferida/.test(await text(admin)) && !/Ainda NÃO conferida/.test(await text(admin))), 'marcando "Conferi no contrato" e salvando, a taxa fica "Conferida"');
    ok(await until(async () => !(await admin.getByRole('switch', { name: 'Oferecer cartão de crédito online no checkout' }).isDisabled())), 'o interruptor do cartão online é liberado');
    await admin.getByRole('switch', { name: 'Oferecer cartão de crédito online no checkout' }).click();
    ok(await until(async () => (await admin.getByRole('switch', { name: 'Oferecer cartão de crédito online no checkout' }).getAttribute('aria-checked')) === 'true'), 'o owner liga o cartão online');
    ok((await (await fetch(BASE + '/api/site')).json()).payments.some((p) => p.code === 'card_online'), '...e o site passa a oferecê-lo');
    ok(await noHScroll(admin), 'a página Pagamentos não tem rolagem horizontal');
  }
  await admin.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await admin.getByRole('tab', { name: /Pagamento/ }).click().catch(() => admin.getByText('Pagamento', { exact: true }).first().click());
  await admin.waitForTimeout(400);
  ok(!/Cartão online|Cartão de crédito online|Pix online/.test(await text(admin)), 'Configurações → Pagamento continua só com as formas de sempre');

  // ---- 3. Checkout: resumo em tempo real ---------------------------------------------------------------------------------------------------
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# 3. ${label}: resumo do checkout em tempo real`);
    const { ctx, page } = await newCtx(browser, vp);
    await toCheckout(page);
    await page.getByText('Retirar na loja', { exact: true }).click();
    const group = page.getByRole('radiogroup', { name: 'Forma de pagamento' });
    ok((await group.getByRole('radio').count()) === 4, `${label}: agora são 4 formas; a nova é o Cartão online`);
    ok(/Pague agora, pelo site · com taxa do cartão/.test(await text(page)), `${label}: a opção diz que é pagar agora, pelo site, com taxa do cartão`);
    const pixFirst = await text(summary(page));
    ok(!/Taxa do cartão/.test(pixFirst) && /Total R\$ 100,00/.test(pixFirst), `${label}: com Pix (a forma inicial) não há taxa: total R$ 100,00`, pixFirst);
    await pickCard(page);
    await page.waitForTimeout(150);
    let s = await text(summary(page));
    ok(/Taxa do cartão R\$ 6,07/.test(s) && /Total R\$ 106,07/.test(s), `${label}: ao escolher o cartão online, a taxa (R$ 6,07) e o total (R$ 106,07) aparecem NA HORA`, s);
    ok(/Subtotal R\$ 100,00/.test(s), `${label}: o subtotal continua R$ 100,00`);
    const notice = await text(page.locator('[data-card-notice]'));
    ok(/^Os dados do cartão vão direto para a operadora de pagamento: este site não guarda número nem código de segurança\.$/.test(notice.trim()), `${label}: o aviso do cartão tem SÓ a frase de que os dados vão direto para a operadora e o site não guarda o cartão`, notice);
    ok(!/taxa/i.test(notice), `${label}: o aviso azul não repete a taxa (ela aparece no resumo, no total e abaixo do botão)`, notice);
    ok(/Você será cobrado\(a\) R\$ 106,07 no cartão de crédito, à vista, com a taxa do cartão de R\$ 6,07 incluída/.test(await text(page.locator('[data-card-total-note]'))), `${label}: ao lado do botão, a frase final com o valor exato`);
    ok(await page.getByRole('button', { name: /^Finalizar e pagar com cartão · R\$ 106,07$/ }).count() === 1, `${label}: o botão mostra o total COM a taxa`);
    // Quantidade
    await page.getByRole('button', { name: 'Aumentar Garrafa Cem' }).click();
    await page.waitForTimeout(150);
    s = await text(summary(page));
    ok(new RegExp(`Subtotal R\\$ 200,00`).test(s) && s.includes(`Taxa do cartão ${money(feeOf(20000))}`) && s.includes(`Total ${money(20000 + feeOf(20000))}`), `${label}: 2 garrafas → taxa ${money(feeOf(20000))} e total ${money(20000 + feeOf(20000))}, na hora`, s);
    // Entrega: entra na base da taxa (2 garrafas + R$ 5,00 de entrega)
    await page.getByText('Delivery', { exact: true }).click();
    await page.waitForTimeout(150);
    s = await text(summary(page));
    ok(s.includes('Entrega R$ 5,00') && s.includes(`Taxa do cartão ${money(feeOf(20500))}`) && s.includes(`Total ${money(20500 + feeOf(20500))}`), `${label}: com entrega de R$ 5,00 a taxa incide sobre itens + entrega: ${money(feeOf(20500))} e total ${money(20500 + feeOf(20500))}`, s);
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.getByRole('button', { name: 'Diminuir Garrafa Cem' }).click();
    await page.waitForTimeout(150);
    // Forma de pagamento: Pix some com a taxa
    await page.locator('label').filter({ hasText: /^PIX/ }).first().click();
    await page.waitForTimeout(150);
    s = await text(summary(page));
    ok(!/Taxa do cartão/.test(s) && /Total R\$ 100,00/.test(s), `${label}: voltando ao Pix a taxa some e o total volta a R$ 100,00`, s);
    ok(!(await page.locator('[data-card-notice]').count()), `${label}: o aviso do cartão some junto`);
    await pickCard(page);
    await page.waitForTimeout(150);
    ok(/Total R\$ 106,07/.test(await text(summary(page))), `${label}: de volta ao cartão: R$ 106,07`);
    ok(await noHScroll(page), `${label}: checkout sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/card-${vp.width}-1-checkout.png`, fullPage: true });

    // E-mail é obrigatório no cartão
    await page.getByLabel('Nome *').fill('Cliente Sem Email');
    await page.getByLabel('Telefone / WhatsApp *').fill(nextPhone());
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.getByRole('button', { name: /^Finalizar e pagar com cartão/ }).click();
    ok(await until(async () => /Informe o e-mail para pagar com cartão de crédito/.test(await text(page))), `${label}: sem e-mail, o cartão não segue: "Informe o e-mail para pagar com cartão de crédito"`);
    ok(psql(`select count(*) from orders where customer_name = 'Cliente Sem Email'`) === '0', `${label}: nenhum pedido foi criado`);
    await ctx.close();
  }

  // ---- 4. Pedido aprovado, do checkout à confirmação ---------------------------------------------------------------------------------------
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# 4. ${label}: do checkout ao pagamento aprovado`);
    const { ctx, page } = await newCtx(browser, vp);
    let docHeaders = null;
    page.on('response', (r) => { if (r.url().includes('/pagar/') && r.request().resourceType() === 'document') docHeaders = r.headers(); });
    const chargesBefore = fake.state.cardChargeCount;
    await orderToCardPage(page);
    const order = lastOrder();
    ok(order.payment_method === 'card_online' && order.total === 106.07 && order.payment_fee === 6.07 && order.subtotal === 100 && order.order_status === 'awaiting_payment', `${label}: o pedido gravado: subtotal 100, taxa 6,07, total 106,07, aguardando pagamento`, order);
    ok(/\/pagar\/[A-Z0-9-]+$/.test(new URL(page.url()).pathname), `${label}: depois do pedido abre a tela /pagar (carregamento completo)`, page.url());
    ok(/online-metrix\.net/.test(docHeaders?.['content-security-policy'] ?? '') && /script-src 'self' https:\/\/\*\.online-metrix\.net/.test(docHeaders?.['content-security-policy'] ?? ''), `${label}: a tela do cartão veio com a CSP própria (SDK e antifraude permitidos)`, docHeaders?.['content-security-policy']);
    const body = await text(page);
    ok(/Pedido #\d+/.test(body) && /Total no cartão R\$ 106,07/.test(body) && /Taxa do cartão R\$ 6,07/.test(body) && /Subtotal R\$ 100,00/.test(body), `${label}: o resumo da tela do cartão: subtotal, taxa do cartão e total`, body.slice(0, 400));
    ok(/Ambiente de testes/.test(body), `${label}: no sandbox a tela avisa que é ambiente de testes (nenhuma cobrança real)`);
    ok(await page.getByRole('button', { name: /^Pagar R\$ 106,07 no cartão$/ }).count() === 1, `${label}: o botão diz o valor exato: "Pagar R$ 106,07 no cartão"`);
    ok(/Você será cobrado\(a\) uma única vez/.test(body), `${label}: avisa que a cobrança é uma só`);
    ok(await noHScroll(page), `${label}: a tela do cartão não tem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/card-${vp.width}-2-pagar.png`, fullPage: true });

    // Validação no navegador (nada vai à operadora)
    const sdkBefore = sdkCalls.filter((c) => c.path.endsWith('/payment-methods')).length;
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Confira o número do cartão/.test(await text(page)) && /Confira a validade/.test(await text(page)) && /Confira o CPF/.test(await text(page))), `${label}: campos vazios/ruins são apontados antes de enviar`);
    ok(fake.state.cardChargeCount === chargesBefore && sdkCalls.filter((c) => c.path.endsWith('/payment-methods')).length === sdkBefore, `${label}: nada foi enviado à operadora`);
    await fillCard(page, { number: '4111111111111112' });
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Confira o número do cartão/.test(await text(page))), `${label}: número de cartão com dígito trocado (Luhn) é recusado no navegador`);

    // Aprovado
    await fillCard(page, { number: PAN });
    const reqBefore = storeRequests.length;
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page)), 20000), `${label}: "Pagamento aprovado!"`, (await text(page)).slice(0, 300));
    ok(fake.state.cardChargeCount === chargesBefore + 1, `${label}: UMA cobrança na operadora`, fake.state.cardChargeCount - chargesBefore);
    const sent = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/v1/charges').at(-1);
    ok(sent.body.amount === 106.07 && sent.body.installments === 1 && /^[0-9a-f-]{36}$/.test(sent.body.deviceId) && sent.body.cardToken.startsWith('ctk_') && !JSON.stringify(sent.body).includes(PAN), `${label}: a cobrança foi de 106.07 à vista, com token e dispositivo; sem número de cartão`, sent.body);
    const placed = lastOrder();
    ok(placed.order_status === 'new' && placed.payment_status === 'paid', `${label}: no banco o pedido virou "novo" e "pago"`, placed);
    ok(psql(`select status || '/' || amount_cents || '/' || customer_fee_cents || '/' || coalesce(fee_cents::text, '-') from payments where order_id = '${placed.id}'`) === 'paid/10607/607/607', `${label}: pagamento: pago, R$ 106,07 cobrados, R$ 6,07 de taxa do cliente, R$ 6,07 de tarifa da operadora`);
    ok(await page.getByRole('link', { name: 'Acompanhar meu pedido' }).count() === 1, `${label}: aparece o link para acompanhar o pedido`);
    ok((await page.locator('[data-card-form]').count()) === 0, `${label}: o formulário some depois de pago`);
    const card = await page.evaluate(() => document.body.innerHTML);
    ok(!card.includes('4111'), `${label}: o número do cartão não ficou na página`);
    ok(storeRequests.length > reqBefore && leaks.length === 0, `${label}: nenhuma requisição ao servidor da loja levou número ou CVV do cartão`, leaks);
    ok(sdkCalls.some((c) => c.path === '/v1/payment-sessions') && sdkCalls.some((c) => c.path === '/v1/payment-sessions/payment-methods'), `${label}: o SDK falou com a operadora (sessão e tokenização)`, sdkCalls);
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage }, c: document.cookie }));
    ok(!stored.includes(PAN) && !stored.includes('"cvv"'), `${label}: o cartão não foi guardado no navegador (localStorage, sessionStorage, cookies)`);
    await page.screenshot({ path: `${SP}/card-${vp.width}-3-aprovado.png`, fullPage: true });
    // Voltar para /pagar depois de pago: só mostra o resultado
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page))) && (await page.locator('[data-card-form]').count()) === 0, `${label}: recarregar a tela depois de pago mostra "aprovado", sem formulário e sem cobrar de novo`);
    ok(fake.state.cardChargeCount === chargesBefore + 1, `${label}: continua UMA cobrança`);
    // O acompanhamento mostra a taxa
    await page.getByRole('link', { name: 'Acompanhar meu pedido' }).click();
    await page.waitForURL('**/pedido/**');
    ok(await until(async () => /Pedido recebido!/.test(await text(page))), `${label}: o pedido aparece como recebido`);
    ok(/Taxa do cartão R\$ 6,07/.test(await text(page)) && /R\$ 106,07/.test(await text(page)), `${label}: o acompanhamento mostra a taxa do cartão e o total`);
    await ctx.close();
  }

  // ---- 5. Recusado, e tentar de novo ---------------------------------------------------------------------------------------------------------
  console.log('# 5. Cartão recusado e nova tentativa');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await orderToCardPage(page, { name: 'Cliente Recusa' });
    const before = fake.state.cardChargeCount;
    await fillCard(page, { number: '4000000000000002' });
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /O cartão não foi aprovado/.test(await text(page)), 20000), 'cartão recusado: "O cartão não foi aprovado. Confira os dados ou use outro cartão."', (await text(page)).slice(0, 300));
    ok(!/card_declined|declined/i.test(await text(page)), '...sem o texto técnico da operadora');
    ok((await page.locator('[data-card-form]').count()) === 1 && (await page.getByLabel('Número do cartão *').inputValue()) === '' && (await page.getByLabel('Código de segurança *').inputValue()) === '', '...o formulário continua e o número e o CVV foram apagados da tela');
    ok((await page.getByLabel('Nome impresso no cartão *').inputValue()) === 'MARIA TESTE' && (await page.getByLabel('CPF ou CNPJ de quem paga *').inputValue()) === '529.982.247-25', '...nome, validade e CPF continuam preenchidos (menos digitação)');
    ok(lastOrder().order_status === 'awaiting_payment' && fake.state.cardChargeCount === before + 1, '...o pedido segue aguardando pagamento');
    await page.screenshot({ path: `${SP}/card-390-4-recusado.png`, fullPage: true });
    await fillCard(page, { number: PAN });
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page)), 20000), 'com outro cartão o MESMO pedido é pago');
    const rows = psql(`select string_agg(status, ',' order by attempt) from payments where order_id = '${lastOrder().id}'`);
    ok(rows === 'failed,paid', 'no banco: tentativa 1 recusada e tentativa 2 paga (duas cobranças, uma só paga)', rows);
    await ctx.close();
  }

  // ---- 6. Clique duplo: uma única cobrança ----------------------------------------------------------------------------------------------------
  console.log('# 6. Clique duplo no botão de pagar');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    const posts = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/payment\/card$/.test(r.url())) posts.push(r.url()); });
    await orderToCardPage(page, { name: 'Cliente Duplo' });
    const before = fake.state.cardChargeCount;
    await fillCard(page);
    await page.getByRole('button', { name: /^Pagar R\$/ }).dblclick();
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page)), 20000), 'clique duplo: o pagamento é aprovado');
    ok(posts.length === 1 && fake.state.cardChargeCount === before + 1, 'clique duplo = UMA requisição à loja e UMA cobrança', [posts.length, fake.state.cardChargeCount - before]);
    await ctx.close();
  }

  // ---- 7. Recarregar no meio do pagamento e resposta perdida ---------------------------------------------------------------------------------
  console.log('# 7. Conexão perdida no meio do pagamento e recarga da página');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await orderToCardPage(page, { name: 'Cliente Recarga' });
    const number = lastOrder().order_number;
    await fake.control('mode', { card: 'lose' });
    await fillCard(page);
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Estamos processando o pagamento/.test(await text(page)), 20000), 'resposta perdida: a tela diz "Estamos processando o pagamento" (e NÃO deixa pagar de novo)', (await text(page)).slice(0, 400));
    ok((await page.locator('[data-card-form]').count()) === 0, '...sem formulário durante a espera');
    ok(/Não conseguimos confirmar o pagamento agora\. Não pague de novo ainda/.test(await text(page)), '...com o aviso "Não pague de novo ainda"');
    const charges = fake.state.cardChargeCount;
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Estamos processando o pagamento/.test(await text(page))) && (await page.locator('[data-card-form]').count()) === 0, 'recarregar a página: continua "processando", sem formulário');
    ok(fake.state.cardChargeCount === charges, '...e recarregar não cobra de novo');
    await page.screenshot({ path: `${SP}/card-390-5-processando.png`, fullPage: true });
    await fake.control('mode', { card: null });
    // Passado o tempo, a tentativa refeita reaproveita a cobrança que a operadora já criou (via API, como a tela faz depois de 1 minuto).
    psql(`update payments set last_attempt_at = now() - interval '2 minutes', created_at = now() - interval '2 minutes' where order_id = (select id from orders where order_number = ${number}) and status = 'creating'`);
    const tracking = new URL(page.url()).pathname.split('/pagar/')[1];
    const t = await (await fetch(`${fake.url}/__fake/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ number: PAN }) })).json();
    const retry = await fetch(`${BASE}/api/tracking/${tracking}/payment/card`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.7.7.7' }, body: JSON.stringify({ card_token: t.cardToken, device_id: t.deviceId, document: '52998224725' }) });
    ok(retry.status === 200 && fake.state.cardChargeCount === charges, 'a nova tentativa reaproveita a cobrança que já existia (nenhuma segunda cobrança)', [retry.status, fake.state.cardChargeCount - charges]);
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page)), 20000), 'e a tela que estava esperando passa sozinha para "Pagamento aprovado!"');
    ok(lastOrder().order_status === 'new', 'o pedido foi liberado uma vez');
    await ctx.close();
  }

  // ---- 8. Pendente: a tela espera e só o servidor aprova -------------------------------------------------------------------------------------
  console.log('# 8. Pagamento pendente (a operadora ainda não decidiu)');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await orderToCardPage(page, { name: 'Cliente Pendente' });
    const number = lastOrder().order_number;
    await fake.control('mode', { card: 'processing' });
    await fillCard(page);
    await page.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Aguardando a confirmação do banco/.test(await text(page)), 20000), 'pendente: "Aguardando a confirmação do banco"', (await text(page)).slice(0, 300));
    ok((await page.locator('[data-card-form]').count()) === 0 && lastOrder().order_status === 'awaiting_payment', '...sem formulário e o pedido segue aguardando pagamento');
    await fake.control('mode', { card: null });
    const chargeId = psql(`select provider_charge_id from payments where order_id = '${lastOrder().id}'`);
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Aguardando a confirmação do banco/.test(await text(page))), 'voltar/recarregar a tela NÃO aprova: continua aguardando');
    ok(lastOrder().order_status === 'awaiting_payment', '...no banco também');
    // A operadora conclui e avisa.
    await fake.control('pay', { chargeId });
    const wh = await postWebhook(BASE, paymentSuccessCard(fake.state.charges.get(chargeId)), { id: 'wh-e2e-card-pendente' });
    ok(wh.status === 200, 'o aviso assinado da operadora é aceito');
    ok(await until(async () => /Pagamento aprovado!/.test(await text(page)), 20000), 'a tela que esperava muda sozinha para "Pagamento aprovado!" (sem recarregar)');
    ok(lastOrder().order_status === 'new' && psql(`select count(*) from order_status_history h join orders o on o.id = h.order_id where o.order_number = ${number} and h.to_status = 'new'`) === '1', 'o pedido foi liberado uma única vez');
    await ctx.close();
  }

  // ---- 9. Pelo acompanhamento: caminho até o cartão -------------------------------------------------------------------------------------------
  console.log('# 9. Link "Pagar no cartão" da página do pedido');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await orderToCardPage(page, { name: 'Cliente Acompanha' });
    const token = new URL(page.url()).pathname.split('/pagar/')[1];
    await page.goto(`${BASE}/pedido/${token}`, { waitUntil: 'networkidle' });
    ok(await until(async () => /Falta o pagamento/.test(await page.getByRole('heading', { level: 1 }).innerText())), 'a página do pedido diz "Falta o pagamento"');
    ok(/Pague com o cartão abaixo/.test(await text(page)) && /Aguardando o cartão/.test(await text(page)), '...e que é com o cartão');
    const linkText = await text(page.locator('[data-card-panel]'));
    ok(/Total de R\$ 106,07, já com a taxa do cartão de R\$ 6,07/.test(linkText), 'o painel do cartão repete o total e a taxa', linkText);
    let docHeaders = null;
    page.on('response', (r) => { if (r.url().includes('/pagar/') && r.request().resourceType() === 'document') docHeaders = r.headers(); });
    await page.locator('[data-card-pay-link]').click();
    await page.waitForURL('**/pagar/**');
    await page.getByRole('heading', { level: 1 }).waitFor();
    ok(/online-metrix/.test(docHeaders?.['content-security-policy'] ?? ''), 'o link abre a tela do cartão por carregamento COMPLETO (veio com a CSP própria, não por troca de tela)', docHeaders && Object.keys(docHeaders));
    // Saindo da tela do cartão também é carregamento completo.
    const nav = page.waitForNavigation();
    await page.getByRole('link', { name: /Meu pedido/ }).click();
    await nav;
    ok(await until(async () => /Falta o pagamento/.test(await page.getByRole('heading', { level: 1 }).innerText())), 'voltar ao pedido funciona');
    await ctx.close();
  }

  // ---- 10. Painel: pedido e pagamentos no cartão -----------------------------------------------------------------------------------------------
  console.log('# 10. Painel: detalhe do pedido pago no cartão e página Pagamentos');
  {
    const paidNumber = psql(`select o.order_number from orders o join payments p on p.order_id = o.id where o.payment_method = 'card_online' and p.status = 'paid' order by o.order_number limit 1`);
    await admin.goto(BASE + `/admin/pedidos/${paidNumber}`, { waitUntil: 'networkidle' });
    const body = await text(admin);
    ok(/Pagamento online \(cartão de crédito\)/.test(body), 'o detalhe do pedido mostra "Pagamento online (cartão de crédito)"');
    ok(/Taxa do cartão \(paga pelo cliente\)/.test(body) && /R\$ 6,07/.test(body) && /5,37% \+ R\$ 0,37 usados no cálculo/.test(body), 'o owner vê a taxa cobrada do cliente e os valores usados no cálculo');
    ok(/Total cobrado no cartão R\$ 106,07/.test(body), '...e o total cobrado');
    ok(/Valor cobrado R\$ 106,07/.test(body) && /Taxa do cartão \(cliente\) R\$ 6,07/.test(body) && /Tarifa da operadora R\$ 6,07/.test(body) && /Líquido R\$ 100,00/.test(body), '...e valor cobrado, tarifa da operadora e líquido (R$ 100,00) da cobrança');
    ok((await admin.getByRole('group', { name: 'Situação do pagamento' }).count()) === 0, 'não oferece marcar pago à mão');
    await admin.screenshot({ path: `${SP}/card-admin-2-pedido.png`, fullPage: true });
    await admin.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    const list = await text(admin);
    ok(/Cartão\s+Taxa do cartão \(cliente\) R\$ 6,07/.test(list), 'a lista de Pagamentos mostra as cobranças no cartão com a taxa do cliente');
    ok(await noHScroll(admin), 'a página Pagamentos continua sem rolagem horizontal');
    await admin.screenshot({ path: `${SP}/card-admin-3-pagamentos.png`, fullPage: true });
    // Atendente: vê a taxa cobrada do cliente, mas não percentual, tarifa nem códigos
    await api('POST', '/api/admin/admins', { name: 'Atendente', email: 'atendente@copocheio.local', password: 'senha-forte-456', role: 'admin' });
    const { ctx: sctx, page: staff } = await newCtx(browser, { width: 1280, height: 800 });
    await staff.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await staff.fill('#login-email', 'atendente@copocheio.local');
    await staff.fill('#login-senha', 'senha-forte-456');
    await staff.click('button[type=submit]');
    await staff.waitForURL('**/admin/dashboard');
    await staff.goto(BASE + `/admin/pedidos/${paidNumber}`, { waitUntil: 'networkidle' });
    const sb = await text(staff);
    ok(/Taxa do cartão \(paga pelo cliente\)/.test(sb) && /R\$ 6,07/.test(sb) && !/5,37%/.test(sb) && !/Tarifa da operadora/.test(sb) && (await staff.getByRole('button', { name: 'Atualizar pagamento' }).count()) === 0, 'o atendente vê a taxa que o cliente pagou, SEM percentual, tarifa da operadora nem botões do owner');
    await staff.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    ok(/Só o dono da loja vê esta página/.test(await text(staff)) && !/Taxa do cartão repassada/.test(await text(staff)), 'a configuração da taxa do cartão é só do owner (o atendente vê o aviso, nenhum dado)');
    await sctx.close();
  }

  // ---- 12. Os dois fluxos no mesmo site: Pix (split na subconta) e cartão (subconta, sem split) ----------------------------------------
  console.log('# 12. Pix com split e cartão sem split, de ponta a ponta, no mesmo site');
  {
    const on = await api('PATCH', '/api/admin/payments/pix_online', { enabled: true });
    ok(on.status === 200 && on.data.payment.enabled === true, 'o Pix online liga (e o cartão online segue ligado)', on);
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await fake.control('calls/clear', {});
    await toCheckout(page);
    await page.getByLabel('Nome *').fill('Cliente Pix Split');
    await page.getByLabel('Telefone / WhatsApp *').fill(nextPhone());
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.locator('label').filter({ hasText: /Pix online/ }).first().click();
    await page.waitForTimeout(150);
    const pixSummary = await text(summary(page));
    ok(!/Taxa do cartão/.test(pixSummary) && /Taxa de serviço R\$ 2,50/.test(pixSummary) && /Total R\$ 102,50/.test(pixSummary), 'Pix online: R$ 100,00 + taxa de serviço de 2,5% (R$ 2,50) = R$ 102,50, e nada de taxa de cartão', pixSummary);
    await page.getByRole('button', { name: /^Finalizar e pagar com Pix/ }).click();
    await page.waitForURL('**/pedido/**', { timeout: 15000 });
    ok(await page.locator('[data-pix-qr] svg').first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'a tela do Pix mostra o QR Code (fluxo do Pix)');
    const pixCall = fake.state.calls.find((c) => c.method === 'POST' && c.path === '/v1/charges/pix');
    ok(!!pixCall && pixCall.body.amount === 102.5 && pixCall.subAccount === '4960589' && JSON.stringify(pixCall.body.split) === JSON.stringify([{ type: 'fixed', amount: 5 }]), 'Pix: R$ 102,50 na SUBCONTA, com a divisão de 5% (R$ 5,00) para a master: a subconta fica com R$ 97,50', pixCall && { a: pixCall.body.amount, s: pixCall.subAccount, sp: pixCall.body.split });
    ok(fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/v1/charges').length === 0, '...e nenhuma cobrança de cartão foi chamada para o Pix');
    const pixOrderNumber = Number((await page.innerText('body')).match(/pedido #(\d+)/i)?.[1]);
    const pixCharge = psql(`select p.provider_charge_id from payments p join orders o on o.id = p.order_id where o.order_number = ${pixOrderNumber}`);
    await fake.control('pay', { chargeId: pixCharge });
    const whPix = await postWebhook(BASE, paymentSuccess(fake.state.charges.get(pixCharge)), { id: 'wh-e2e-fluxos-pix' });
    ok(whPix.status === 200 && (await until(async () => /Pagamento confirmado!/.test(await text(page)), 20000)), 'o aviso do Pix confirma o pagamento e a tela muda sozinha para "Pagamento confirmado!"');
    ok(psql(`select p.method || '/' || p.commission_cents || '/' || p.customer_fee_cents from payments p join orders o on o.id = p.order_id where o.order_number = ${pixOrderNumber}`) === 'pix/500/250', 'no banco: pagamento Pix, taxa de R$ 5,00 para a master (R$ 2,50 pagos pelo cliente + R$ 2,50 pelo estabelecimento)');
    await ctx.close();

    await fake.control('calls/clear', {});
    const { ctx: cctx, page: cardPage } = await newCtx(browser, { width: 390, height: 844 });
    await orderToCardPage(cardPage, { name: 'Cliente Cartão Depois' });
    await fillCard(cardPage);
    await cardPage.getByRole('button', { name: /^Pagar R\$/ }).click();
    ok(await until(async () => /Pagamento aprovado!/.test(await text(cardPage)), 20000), 'cartão: "Pagamento aprovado!" (fluxo do cartão)');
    const cardCall = fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/v1/charges').at(-1);
    ok(!!cardCall && cardCall.body.amount === 106.07 && cardCall.subAccount === '4960589' && !('split' in cardCall.body) && cardCall.body.paymentMethod === 'creditcard', 'cartão: R$ 106,07 (subtotal + taxa) na SUBCONTA do estabelecimento, sem split', cardCall && { a: cardCall.body.amount, s: cardCall.subAccount, sp: cardCall.body.split });
    ok(fake.state.calls.filter((c) => c.method === 'POST' && c.path === '/v1/charges/pix').length === 0, '...e nenhuma cobrança de Pix foi chamada para o cartão');
    const cardOrderNumber = lastOrder().order_number;
    ok(psql(`select p.method || '/' || p.commission_state || '/' || p.customer_fee_cents || '/' || case when p.merchant_account_id is null then 'sem-subconta' else 'com-subconta' end from payments p join orders o on o.id = p.order_id where o.order_number = ${cardOrderNumber}`) === 'card/not_applicable/607/com-subconta', 'no banco: pagamento de cartão, sem comissão, taxa de R$ 6,07 e ligado à subconta');
    await cctx.close();
  }

  // ---- 11. O que sobrou ---------------------------------------------------------------------------------------------------------------------------
  console.log('# 11. Erros de página e vazamentos');
  ok(errors.length === 0, 'nenhum erro de JavaScript/console nas telas', errors.slice(0, 5));
  ok(leaks.length === 0, 'nenhuma requisição ao servidor da loja levou o número ou o CVV do cartão', leaks);
  const log = fs.readFileSync(path.join(__dirname, 'server.log'), 'utf8');
  ok(!log.includes(PAN) && !/ctk_[0-9a-f]{16}/.test(log), 'o log do servidor não tem número nem token de cartão');

  await actx.close();
  await browser.close();
  execSync(`bash ${ROOT}/tests/serve.sh`, { stdio: 'ignore' });
  await fake.stop();
  console.log(fails ? `${fails} FALHA(S)` : 'TUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH ' + (e && e.stack ? e.stack : e));
  try { execSync(`bash ${ROOT}/tests/serve.sh`, { stdio: 'ignore' }); } catch { /* servidor de teste */ }
  process.exit(1);
});
