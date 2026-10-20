// Pagamento online (Pix) no navegador, em celular e computador: o checkout só oferece o Pix online depois de ligado, a tela do Pix (QR Code,
// copia e cola, contagem, "já paguei"), a confirmação sem recarregar, o Pix vencido e a nova tentativa, o aviso de pedido pago no painel,
// a página Pagamentos (só owner) e o detalhe do pedido.
//
// ATENÇÃO: a operadora é um SIMULADOR (tests/payments-sim.mjs), não a ValidaPay. Isto prova as telas e a lógica da loja; não prova a integração real.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-pix.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const { execFileSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
fs.mkdirSync(SP, { recursive: true });
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180', BLOB = 'http://127.0.0.1:4181';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
let cookie = '';
async function api(method, path, body, raw) {
  const init = { method, headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) };
  let res;
  for (let i = 0; ; i++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)); } }
  const set = res.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const t = await res.text(); return { status: res.status, data: t ? JSON.parse(t) : null };
}
const sim = (path, body) => fetch(`${BASE}/__pay/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
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
async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => undefined);
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => { await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + new URL(route.request().url()).pathname }) }); });
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const addButton = (page, name) => page.getByRole('button', { name: new RegExp(`^Adicionar (mais )?${name}`) }).first();
let phone = 0;
const nextPhone = () => `3496${String(3000000 + ++phone).slice(-7)}`;

// Do cardápio até a página do pedido, pagando com o meio indicado.
async function order(page, { method = /Pix online/, name = 'Cliente Pix Teste' } = {}) {
  await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await addButton(page, 'Cerveja Pix').click();
  await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  await page.getByLabel('Nome *').fill(name);
  await page.getByLabel('Telefone / WhatsApp *').fill(nextPhone());
  await page.getByText('Retirar na loja', { exact: true }).click();
  await page.locator('label').filter({ hasText: method }).first().click();
  await page.waitForTimeout(900);
  await page.getByRole('button', { name: /^Finalizar/ }).click();
  await page.waitForURL('**/pedido/**', { timeout: 15000 });
}
const orderNumber = async (page) => Number((await page.locator('h1, [data-order-number]').allInnerTexts()).join(' ').match(/#(\d+)/)?.[1] ?? (await page.innerText('body')).match(/#(\d{4,})/)?.[1]);
const chargeOf = async (number) => (await sim('state')).charges.find((c) => c.orderNumber === number);
const pay = async (chargeId, eventId) => {
  await sim(`charge/${chargeId}`, { status: 'paid' });
  return sim('webhook', { id: eventId, type: 'charge.paid', chargeId });
};

const { finishLogin, latestLoginCode, adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
  const img = (await api('POST', '/api/admin/upload?folder=products', fs.readFileSync(FX + '/lata.webp'), true)).data.url;
  const cat = (await api('POST', '/api/admin/categories', { name: 'Cervejas' })).data.category;
  const beer = (await api('POST', '/api/admin/products', { name: 'Cerveja Pix', price: 25, category_id: cat.id, image_url: img, description: 'Teste.', featured: true, stock: 100, confirm_duplicate: true })).data.product;
  ok(!!beer?.id, 'dados de teste criados');
  await sim('reset', {});
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);

  // ---- 1. Desligado: o checkout é o de sempre -------------------------------------------------------------------------------------------
  console.log('# 1. Pix online desligado: nada muda no checkout');
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'Cerveja Pix').click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    const radios = await page.getByRole('radiogroup', { name: 'Forma de pagamento' }).getByRole('radio').count();
    ok(radios === 3, `${label}: só as 3 formas de sempre (PIX, Dinheiro, Cartão)`, radios);
    ok(!/Pix online/.test(await page.innerText('body')), `${label}: nenhuma menção a "Pix online"`);
    const grid = await page.getByRole('radiogroup', { name: 'Forma de pagamento' }).evaluate((el) => el.className);
    ok(/sm:grid-cols-3/.test(grid) && !/sm:grid-cols-2/.test(grid), `${label}: a grade de pagamento é a de sempre (3 colunas)`, grid);
    ok(await page.getByRole('button', { name: /^Finalizar pedido/ }).count() === 1, `${label}: o botão continua "Finalizar pedido"`);
    await ctx.close();
  }

  // ---- 2. Liga: operadora conectada (simulador) + conta aprovada -----------------------------------------------------------------------------
  const early = await api('PATCH', '/api/admin/payments/pix_online', { enabled: true });
  ok(early.status === 409, 'sem conta aprovada, ligar o Pix online é recusado (409)', early);
  psql(`insert into merchant_accounts (provider, kind, status, provider_account_id, proposal_id) values ('simulador', 'pj', 'approved', 'sim-sub-e2e', 'sim-prop-e2e')`);
  const on = await api('PATCH', '/api/admin/payments/pix_online', { enabled: true });
  ok(on.status === 200 && on.data.payment.enabled === true, 'com conta aprovada, o Pix online liga');

  // ---- 3. Checkout, tela do Pix, pagamento e confirmação (celular e computador) -----------------------------------------------------------
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    console.log(`# 3. ${label}: do checkout ao pagamento confirmado`);
    const { ctx, page } = await newCtx(browser, vp);
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await addButton(page, 'Cerveja Pix').click();
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    const group = page.getByRole('radiogroup', { name: 'Forma de pagamento' });
    ok((await group.getByRole('radio').count()) === 4, `${label}: agora são 4 formas, a quarta é o Pix online`);
    const gridClass = await group.evaluate((el) => el.className);
    ok(/sm:grid-cols-2/.test(gridClass), `${label}: com 4 formas a grade passa para 2 colunas`, gridClass);
    ok(/Pague agora, pelo site/.test(await page.innerText('body')), `${label}: a opção explica que se paga agora, pelo site`);
    await page.locator('label').filter({ hasText: /Pix online/ }).first().click();
    ok(/Você paga na próxima tela/.test(await page.innerText('body')), `${label}: ao escolher, avisa que o pedido só vai para a loja depois do pagamento`);
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.waitForTimeout(900);
    const pixNotice = await page.locator('[data-pix-notice]').innerText();
    ok(/^Você paga na próxima tela, com QR Code ou Pix copia e cola\. O pedido só é enviado para a loja depois que o pagamento for confirmado\.$/.test(pixNotice.trim()), `${label}: o aviso azul do Pix tem SÓ a frase de que se paga na próxima tela, com QR Code ou copia e cola, e que o pedido só vai para a loja depois da confirmação`, pixNotice);
    ok(!/taxa/i.test(pixNotice), `${label}: o aviso azul não repete a taxa (ela aparece no resumo, no total e no botão)`, pixNotice);
    const pixSummary = await page.locator('[data-fee-line]').innerText();
    ok(/Taxa de serviço/.test(pixSummary) && /0,63/.test(pixSummary) && !/cartão/i.test(pixSummary), `${label}: o resumo tem a linha "Taxa de serviço" de R$ 0,63 (e não "taxa do cartão")`, pixSummary);
    ok((await page.locator('[data-pix-total-note]').count()) === 0 && !/Você pagará/.test(await page.innerText('body')), `${label}: abaixo do botão não há a frase "Você pagará…" (o total está no resumo e no botão)`);
    ok((await page.getByRole('button', { name: /^Finalizar e pagar com Pix · R\$\s*25,63/ }).count()) === 1, `${label}: o botão traz o total com a taxa (R$ 25,63)`);
    await page.locator('label').filter({ hasText: /Dinheiro/ }).first().click();
    ok((await page.locator('[data-fee-line]').count()) === 0 && (await page.locator('[data-pix-notice]').count()) === 0, `${label}: trocando para Dinheiro a taxa some do resumo e do aviso`);
    await page.locator('label').filter({ hasText: /Pix online/ }).first().click();
    ok(await page.getByRole('button', { name: /^Finalizar e pagar com Pix · R\$/ }).count() === 1, `${label}: o botão vira "Finalizar e pagar com Pix"`);
    ok(await noHScroll(page), `${label}: checkout sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/pix-${vp.width}-1-checkout.png`, fullPage: true });
    await page.getByLabel('Nome *').fill('Cliente Pix Teste');
    await page.getByLabel('Telefone / WhatsApp *').fill(nextPhone());
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^Finalizar e pagar com Pix/ }).click();
    await page.waitForURL('**/pedido/**', { timeout: 15000 });

    // A página do pedido mostra o Pix
    ok(await until(async () => /Falta o pagamento/.test(await page.getByRole('heading', { level: 1 }).innerText())), `${label}: a página do pedido diz "Falta o pagamento"`);
    ok(await page.locator('[data-pix-qr] svg').first().waitFor({ timeout: 8000 }).then(() => true, () => false), `${label}: o QR Code aparece`);
    ok((await page.getByRole('img', { name: /QR Code do Pix de R\$ 25,63/ }).count()) === 1, `${label}: o QR Code tem descrição para leitor de tela (com o valor)`);
    const area = page.getByLabel('Pix copia e cola');
    const payload = await area.inputValue();
    ok(/^SIMULADO-NAO-PAGAVEL\|sim_ch_\d+\|2563$/.test(payload), `${label}: o "copia e cola" aparece (somente leitura) e é o da cobrança de R$ 25,63`, payload);
    ok((await area.getAttribute('readonly')) !== null, `${label}: o campo do "copia e cola" é só leitura`);
    const number = Number((await page.innerText('body')).match(/pedido #(\d+)/i)?.[1]);
    ok(number >= 1001, `${label}: o número do pedido aparece (#${number})`);
    const text = await page.innerText('body');
    ok(/Aguardando o pagamento/.test(text) && /Vence em 1[45]:\d\d/.test(text), `${label}: "Aguardando o pagamento…" e a contagem para vencer`, text.match(/Vence em [\d:]+/)?.[0]);
    ok(!/Compartilhar pelo WhatsApp/.test(text), `${label}: sem botão de WhatsApp enquanto o pedido não foi pago`);
    ok(/Aguardando pagamento/i.test(text), `${label}: o andamento mostra "Aguardando pagamento"`);
    ok(await noHScroll(page), `${label}: a página do Pix não tem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/pix-${vp.width}-2-pix.png`, fullPage: true });

    // Copiar
    await page.getByRole('button', { name: 'Copiar código Pix' }).click();
    ok(await until(async () => /Código copiado!/.test(await page.innerText('body'))), `${label}: "Copiar código Pix" avisa que copiou`);
    ok((await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === payload, `${label}: o que foi copiado é o "copia e cola"`);

    // "Já paguei" não confirma nada
    await page.getByRole('button', { name: /Já paguei, conferir agora/ }).click();
    ok(await until(async () => /Ainda não recebemos o pagamento/.test(await page.innerText('body'))), `${label}: "Já paguei" só confere: diz que ainda não recebeu`);
    const ch = await chargeOf(number);
    ok(!!ch && ch.amountCents === 2563 && ch.commissionCents === 125, `${label}: a operadora recebeu R$ 25,63 com a taxa de 5% de R$ 1,25 para a conta master`, ch && { a: ch.amountCents, c: ch.commissionCents });
    ok(psql(`select order_status || '/' || payment_status from orders where order_number = ${number}`) === 'awaiting_payment/pending', `${label}: o pedido continua aguardando pagamento`);

    // O cliente paga e a operadora avisa: a tela confirma sozinha, sem recarregar
    await pay(ch.id, `evt-e2e-${vp.width}`);
    ok(await until(async () => /Pagamento confirmado!/.test(await page.innerText('body')), 15000), `${label}: a tela mostra "Pagamento confirmado!" sozinha (sem recarregar)`);
    ok(await until(async () => /Pedido recebido!/.test(await page.getByRole('heading', { level: 1 }).innerText()), 15000), `${label}: o título passa para "Pedido recebido!"`);
    ok(await until(async () => (await page.getByText('Compartilhar pelo WhatsApp').count()) > 0, 15000), `${label}: agora o WhatsApp para a loja aparece`);
    ok((await page.locator('[data-pix-qr]').count()) === 0, `${label}: o QR Code some depois de pago`);
    ok(psql(`select order_status || '/' || payment_status from orders where order_number = ${number}`) === 'new/paid', `${label}: no banco o pedido é "novo" e "pago"`);
    await page.screenshot({ path: `${SP}/pix-${vp.width}-3-pago.png`, fullPage: true });
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Pagamento confirmado!/.test(await page.innerText('body'))), `${label}: recarregar a página continua mostrando o pagamento confirmado`);
    ok(await noHScroll(page), `${label}: confirmação sem rolagem horizontal`);
    await ctx.close();
  }

  // ---- 4. Pix vencido e nova tentativa --------------------------------------------------------------------------------------------------
  console.log('# 4. Pix vencido, nova tentativa');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await order(page);
    await page.locator('[data-pix-qr] svg').first().waitFor();
    const number = Number((await page.innerText('body')).match(/pedido #(\d+)/i)?.[1]);
    const first = await chargeOf(number);
    psql(`update payments set expires_at = now() - interval '1 minute' where order_id = (select id from orders where order_number = ${number})`);
    await sim(`charge/${first.id}`, { status: 'expired' });
    ok(await until(async () => /O Pix venceu/.test(await page.innerText('body')), 15000), 'a tela troca sozinha para "O Pix venceu"');
    ok(await page.getByRole('button', { name: 'Gerar novo Pix' }).count() === 1 && (await page.locator('[data-pix-qr]').count()) === 0, 'oferece "Gerar novo Pix" e esconde o QR Code vencido');
    await page.screenshot({ path: `${SP}/pix-390-4-venceu.png`, fullPage: true });
    const button = page.getByRole('button', { name: 'Gerar novo Pix' });
    await button.dblclick();
    ok(await page.locator('[data-pix-qr] svg').first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'um novo QR Code aparece');
    const second = (await sim('state')).charges.filter((c) => c.orderNumber === number);
    ok(second.length === 2 && psql(`select count(*) from payments p join orders o on o.id = p.order_id where o.order_number = ${number}`) === '2', 'clique duplo gerou UMA nova cobrança (2 no total, nunca 3)', second.length);
    ok((await page.getByLabel('Pix copia e cola').inputValue()) !== `SIMULADO-NAO-PAGAVEL|${first.id}|2563`, 'o "copia e cola" novo é diferente do vencido');
    await ctx.close();
  }

  // ---- 5. Painel: aviso de pedido pago, pedido, Pagamentos, atendente ----------------------------------------------------------------
  console.log('# 5. Painel');
  {
    const { ctx: actx, page: admin } = await newCtx(browser, { width: 1280, height: 800 });
    await admin.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await admin.fill('#login-email', 'dono@copocheio.local');
    await admin.fill('#login-senha', 'senha-forte-123');
    await admin.click('button[type=submit]');
    await finishAdminLogin(admin);
    await admin.waitForURL('**/admin/dashboard');
    await admin.waitForTimeout(1500);
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await order(page);
    await page.locator('[data-pix-qr] svg').first().waitFor();
    const number = Number((await page.innerText('body')).match(/pedido #(\d+)/i)?.[1]);
    await admin.waitForTimeout(9500);
    ok((await admin.getByText(`Pedido #${number} recebido`).count()) === 0, 'o painel NÃO avisa de "pedido novo" enquanto o cliente não pagou');
    await admin.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
    ok((await admin.getByRole('button', { name: /Aguardando pagamento/ }).count()) === 1, 'a aba "Aguardando pagamento" aparece quando há pedido nesse estado');
    await admin.getByRole('button', { name: /Aguardando pagamento/ }).click();
    ok(await until(async () => (await admin.getByText(`#${number}`).count()) > 0), 'o pedido está na aba "Aguardando pagamento"');
    await admin.screenshot({ path: `${SP}/pix-admin-1-aguardando.png` });
    await admin.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
    ok(/Pagamento online \(Pix\)/.test(await admin.innerText('body')) && (await admin.getByRole('group', { name: 'Situação do pagamento' }).count()) === 0, 'o detalhe do pedido mostra o "Pagamento online" e NÃO oferece marcar pago à mão');
    ok(await admin.getByRole('button', { name: /^CONFIRMAR PEDIDO$/ }).isDisabled(), 'o pedido não pago não pode ser "confirmado" no painel');
    ok(await admin.getByRole('button', { name: /^CANCELAR$/ }).isEnabled(), '...mas pode ser cancelado');
    await admin.screenshot({ path: `${SP}/pix-admin-2-pedido-aguardando.png`, fullPage: true });

    // Paga: o painel avisa (toast) e o pedido vira "novo"
    const ch = await chargeOf(number);
    await pay(ch.id, 'evt-e2e-admin');
    ok(await until(async () => (await admin.getByText(/recebido \(Pix pago\)/).count()) > 0, 20000), 'o painel avisa do pedido pago ("recebido (Pix pago)")');
    await admin.reload({ waitUntil: 'networkidle' });
    const body = await admin.innerText('body');
    ok(/Efetivada/.test(body) && /Taxa \(5%\)/.test(body) && !/Comissão/.test(body) && /R\$\s*1,25/.test(body) && /cliente R\$\s*0,63/.test(body) && /estabelecimento R\$\s*0,62/.test(body), 'o detalhe mostra a taxa de 5% (R$ 1,25) como EFETIVADA, e quem paga: cliente R$ 0,63 e estabelecimento R$ 0,62');
    ok(await admin.getByRole('button', { name: 'Atualizar pagamento' }).count() === 1, 'o owner tem o botão "Atualizar pagamento"');
    await admin.screenshot({ path: `${SP}/pix-admin-3-pedido-pago.png`, fullPage: true });

    await admin.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    const pagamentos = await admin.innerText('body');
    ok(/Pagamentos online/.test(pagamentos) && /Conectada/.test(pagamentos) && /Aprovada/.test(pagamentos), 'a página Pagamentos mostra a operadora conectada e a conta aprovada');
    ok(await admin.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).getAttribute('aria-checked') === 'true', 'o interruptor do Pix online está ligado');
    ok(/Taxa do Pix \(5% do total do pedido\)/.test(pagamentos) && !/Comissão/.test(pagamentos) && /Efetivada/.test(pagamentos), 'o resumo separa taxa calculada e efetivada (a palavra "comissão" não aparece na tela)');
    ok(await noHScroll(admin), 'a página Pagamentos não tem rolagem horizontal');
    await admin.screenshot({ path: `${SP}/pix-admin-4-pagamentos.png`, fullPage: true });
    await admin.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).click();
    ok(await until(async () => (await admin.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).getAttribute('aria-checked')) === 'false'), 'o owner desliga o Pix online por aqui');
    ok(!(await (await fetch(BASE + '/api/site')).json()).payments.some((p) => p.code === 'pix_online'), '...e o site deixa de oferecer');
    await admin.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).click();
    ok(await until(async () => (await admin.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).getAttribute('aria-checked')) === 'true'), '...e liga de novo');

    // Em Configurações, o pagamento online não aparece (fica em Pagamentos)
    await admin.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
    await admin.getByRole('tab', { name: /Pagamento/ }).click().catch(() => admin.getByText('Pagamento', { exact: true }).first().click());
    await admin.waitForTimeout(400);
    ok(!/Pix online/.test(await admin.innerText('body')), 'Configurações → Pagamento continua só com as formas de sempre');

    // Atendente (não owner)
    await api('POST', '/api/admin/admins', { name: 'Atendente', email: 'atendente@copocheio.local', password: 'senha-forte-456', role: 'admin' });
    const { ctx: sctx, page: staff } = await newCtx(browser, { width: 1280, height: 800 });
    await staff.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await staff.fill('#login-email', 'atendente@copocheio.local');
    await staff.fill('#login-senha', 'senha-forte-456');
    await staff.click('button[type=submit]');
    await finishAdminLogin(staff);
    await staff.waitForURL('**/admin/dashboard');
    ok((await staff.getByRole('link', { name: 'Pagamentos' }).count()) === 0, 'o atendente não vê "Pagamentos" no menu');
    await staff.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    ok(/Só o dono da loja vê esta página/.test(await staff.innerText('body')), 'abrindo o endereço direto, o atendente vê o aviso (e nenhum dado)');
    await staff.goto(BASE + `/admin/pedidos/${number}`, { waitUntil: 'networkidle' });
    const sb = await staff.innerText('body');
    ok(/Pagamento online \(Pix\)/.test(sb) && !/Taxa \(\d/.test(sb) && !/Comissão/.test(sb) && !/Tarifas/.test(sb) && (await staff.getByRole('button', { name: 'Atualizar pagamento' }).count()) === 0, 'o atendente vê a situação do pagamento, SEM comissão, tarifas nem botões do owner');
    await sctx.close();
    await ctx.close();
    await actx.close();
  }

  // ---- 6. Operadora indisponível ----------------------------------------------------------------------------------------------------------
  console.log('# 6. Operadora fora do ar');
  {
    await sim('mode', { createFail: 'unavailable' });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await order(page);
    ok(await until(async () => /Não foi possível gerar o Pix/.test(await page.getByRole('heading', { level: 2 }).first().innerText()), 12000), 'sem conseguir gerar o Pix: título claro');
    ok(await until(async () => /Não foi possível gerar o Pix agora\. Tente de novo em instantes\./.test(await page.getByRole('alert').first().innerText())), '...e o motivo, num aviso para leitores de tela');
    ok((await page.locator('[data-pix-qr]').count()) === 0 && (await page.getByRole('button', { name: 'Tentar de novo' }).count()) === 1, '...sem QR Code falso e com botão para tentar de novo');
    await page.screenshot({ path: `${SP}/pix-390-6-erro.png`, fullPage: true });
    await sim('mode', { createFail: null });
    await page.getByRole('button', { name: 'Tentar de novo' }).click();
    ok(await page.locator('[data-pix-qr] svg').first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'a operadora volta e "Tentar de novo" gera o Pix');
    await ctx.close();
  }

  // ---- 7. Conta do cliente: pagar por "Meus pedidos" ---------------------------------------------------------------------------------
  console.log('# 7. Conta: pagar por "Meus pedidos"');
  {
    const email = 'cliente.conta@exemplo.com.br';
    // Como um navegador: guarda os cookies (o cadastro amarra a confirmação do e-mail ao aparelho que se cadastrou).
    const jar = new Map();
    const call = async (path, body) => {
      const cookieHeader = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.8.8.8', ...(cookieHeader ? { cookie: cookieHeader } : {}) }, body: JSON.stringify(body) });
      const cookies = res.headers.getSetCookie?.() ?? [];
      for (const c of cookies) {
        const [pair] = c.split(';');
        const [name, ...rest] = pair.split('=');
        if (rest.join('=')) jar.set(name, rest.join('=')); else jar.delete(name);
      }
      return { status: res.status, cookies, data: await res.json().catch(() => null) };
    };
    const reg = await call('/api/account/register', { name: 'Cliente Conta', email, phone: '34991112233', password: 'senha-forte-789' });
    let code;
    for (let i = 0; i < 40 && !code; i++) {
      const mails = await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email)}`)).json();
      code = /\b(\d{6})\b/.exec(mails[mails.length - 1]?.text ?? '')?.[1];
      if (!code) await new Promise((r) => setTimeout(r, 150));
    }
    const verified = await call('/api/account/verify-email', { email, code });
    const login0 = await call('/api/account/login', { email, password: 'senha-forte-789' });
    // O login pede o código enviado por e-mail (segundo passo).
    const login = login0.status === 202 ? await call('/api/account/login/code', { code: await latestLoginCode(email) }) : login0;
    const session = jar.has('copocheio_cliente') ? `copocheio_cliente=${jar.get('copocheio_cliente')}` : undefined;
    ok(reg.status === 202 && verified.status === 200 && login.status === 200 && !!session, 'conta de cliente criada, confirmada e logada', [reg.status, verified.status, login.status]);

    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await ctx.addCookies([{ name: 'copocheio_cliente', value: session.split('=').slice(1).join('='), url: BASE }]);
    await order(page, { name: 'Cliente Conta' });
    await page.locator('[data-pix-qr] svg').first().waitFor();
    const number = Number((await page.innerText('body')).match(/pedido #(\d+)/i)?.[1]);
    const payload = await page.getByLabel('Pix copia e cola').inputValue();
    ok(psql(`select (customer_id is not null)::text from orders where order_number = ${number}`) === 'true', 'o pedido de quem está logado fica na conta');

    // Sai da página do pedido e volta por "Meus pedidos" (sem o código de acompanhamento)
    await page.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
    ok(await until(async () => /AGUARDANDO PAGAMENTO/i.test(await page.innerText('body'))), 'em "Meus pedidos", o pedido aparece como "aguardando pagamento"');
    await page.goto(BASE + `/conta/pedidos/${number}`, { waitUntil: 'networkidle' });
    ok(await page.locator('[data-pix-qr] svg').first().waitFor({ timeout: 10000 }).then(() => true, () => false), 'abrindo o pedido pela conta, o QR Code do Pix está lá');
    ok((await page.getByLabel('Pix copia e cola').inputValue()) === payload, '...e é o MESMO Pix (nenhuma cobrança nova foi criada)');
    ok(psql(`select count(*) from payments p join orders o on o.id = p.order_id where o.order_number = ${number}`) === '1', 'continua 1 cobrança só');
    await page.screenshot({ path: `${SP}/pix-390-7-conta.png`, fullPage: true });
    const ch = await chargeOf(number);
    await pay(ch.id, 'evt-e2e-conta');
    ok(await until(async () => /Pagamento confirmado!/.test(await page.innerText('body')), 15000), 'pago: a página da conta confirma sozinha');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de página nem de console em todo o teste', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
