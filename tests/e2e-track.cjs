// End-to-end do acompanhamento de pedidos e contas de clientes (navegador real, Neon local + Blob falso).
// usage: bash tests/fresh.sh && node tests/e2e-track.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('node:fs').mkdirSync(SP, { recursive: true });
const BASE = 'http://localhost:4180';
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -c "${q}"`).toString().trim();
let fails = 0;
let passes = 0;
// Espera (até 5 s) por algo que a tela mostra depois de um clique: a leitura imediata perde a corrida em máquinas lentas, como as do GitHub Actions.
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* a tela ainda está mudando: tenta de novo */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
};
const ok = (c, msg, extra) => {
  if (!c) fails++;
  else passes++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = /[0-9A-HJKMNP-TV-Z]{5}(?:-[0-9A-HJKMNP-TV-Z]{5}){3}/;

// ---- API do painel (para preparar dados e conferir) ----
let cookie = '';
async function admin(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function newContext(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route('**/*.mp4', (r) => r.abort());
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => undefined);
  return ctx;
}
// ---- E-mail de confirmação: lê o código no servidor SMTP de mentira e digita na tela ----
const sinkMails = async (to) => (await fetch(`${BASE}/__mail?to=${encodeURIComponent(to.toLowerCase())}`)).json();
async function confirmEmail(page, email) {
  await page.waitForSelector('text=Confirme seu e-mail');
  let list = [];
  for (let n = 0; n < 60 && !list.length; n++) {
    list = await sinkMails(email);
    if (!list.length) await wait(150);
  }
  const code = /\b(\d{6})\b/.exec(list[list.length - 1].text)[1];
  await page.getByLabel('Código de confirmação').fill(code);
  await page.getByRole('button', { name: 'Confirmar e-mail' }).click();
  // O login pede o código de acesso (outro e-mail): conclui a entrada.
  await finishLogin(page);
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const body = (page) => page.evaluate(() => document.body.innerText);

const { finishLogin, latestLoginCode } = require('./e2e-code.cjs');
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const track = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|503|429|404|401/.test(m.text())) errors.push(m.text());
    });
    return page;
  };

  // ---- preparação ----
  await admin('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await admin('PATCH', '/api/admin/store', { opening_hours: allDays, delivery_fee: 5, whatsapp: '5534988887777', delivery_time: '30 a 45 min' });
  const cat = (await admin('POST', '/api/admin/categories', { name: 'Bebidas teste' })).data.category;
  const coca = (await admin('POST', '/api/admin/products', { name: 'Coca 2L', price: 12, category_id: cat.id })).data.product;
  const gelo = (await admin('POST', '/api/admin/products', { name: 'Gelo 5kg', price: 10, category_id: cat.id })).data.product;
  console.log('# preparação ok');

  // =====================================================================================================
  console.log('# 1. visitante faz o pedido e vê a confirmação');
  const ctxA = await newContext(browser);
  const a = track(await ctxA.newPage());
  await a.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await a.click('button[aria-label="Adicionar Coca 2L ao pedido"]');
  await a.click('button[aria-label="Aumentar Coca 2L"]');
  await a.click('button[aria-label="Adicionar Gelo 5kg ao pedido"]');
  await a.waitForTimeout(300);
  await a.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  ok(/Você pode finalizar sem conta/.test(await body(a)), 'checkout offers an account but never requires it');
  await a.getByLabel('Nome *').fill('Ana Souza');
  await a.getByLabel('Telefone / WhatsApp *').fill('34988881111');
  await a.getByLabel('E-mail (opcional)').fill('ana@exemplo.com');
  await a.getByLabel('Rua / Avenida *').fill('Rua das Flores');
  await a.getByLabel('Número *').fill('45');
  await a.getByLabel('Bairro *').fill('Centro');
  await a.waitForTimeout(700); // o site só aceita pedido depois de 0,6 s na tela
  await a.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await a.waitForURL(/\/pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, { timeout: 15000 });
  await a.waitForSelector('text=Pedido recebido!');
  const confirmPath = new URL(a.url()).pathname;
  const token = TOKEN.exec(confirmPath)[0];
  const link = `${BASE}/acompanhar-pedido/${token}`;
  const text1 = await body(a);
  const num = Number((/Seu pedido #(\d+) foi enviado/.exec(text1) || [])[1]);
  ok(num >= 1001, 'confirmation: "Pedido recebido!" + order number #' + num);
  ok(/R\$\s?39,00/.test(text1), 'confirmation: total R$ 39,00 (24 + 10 + 5 de entrega)', text1.match(/R\$\s?\d+,\d\d/g));
  ok(/2x Coca 2L/.test(text1) && /1x Gelo 5kg/.test(text1), 'confirmation: items summary');
  ok(/Rua das Flores, 45/.test(text1) && /Delivery/.test(text1), 'confirmation: delivery address');
  ok(/PIX/.test(text1) && /Pagamento pendente/.test(text1), 'confirmation: payment method and status');
  const steps = await a.locator('ol[aria-label="Andamento do pedido"] li').allInnerTexts();
  ok(steps.length === 5 && /Novo/.test(steps[0]) && /Confirmado/.test(steps[1]) && /Em preparo/.test(steps[2]) && /Saiu para entrega/.test(steps[3]) && /Entregue/.test(steps[4]), 'confirmation: 5-step timeline', steps);
  ok((await a.locator('li[data-state="current"]').innerText()).includes('Novo') && /Próxima etapa: Confirmado/.test(text1), 'timeline: current = Novo, next = Confirmado');
  ok(/Última atualização/.test(text1) && /verificado às \d{2}:\d{2}/.test(text1), 'shows last update + last check');
  for (const name of ['Acompanhar meu pedido', 'Compartilhar pelo WhatsApp', 'Copiar link de acompanhamento', 'Fazer outro pedido']) {
    ok((await a.getByRole(name.startsWith('Copiar') ? 'button' : 'link', { name }).count()) >= 1, `confirmation button: ${name}`);
  }
  ok((await a.getByRole('textbox', { name: 'Link de acompanhamento' }).inputValue()) === link, 'confirmation shows the permanent tracking link');
  ok(new RegExp(`Código de acompanhamento[\\s\\S]*${token}`).test(text1), 'confirmation shows the tracking code');
  await a.getByRole('button', { name: 'Copiar link de acompanhamento' }).click();
  await a.waitForSelector('text=Link copiado!');
  ok((await a.evaluate(() => navigator.clipboard.readText())) === link, 'copy button puts the link on the clipboard');
  const wa = await a.getByRole('link', { name: 'Compartilhar pelo WhatsApp' }).first().getAttribute('href');
  const waMsg = decodeURIComponent(wa.split('?text=')[1]);
  ok(wa.startsWith('https://wa.me/5534988887777?text=') && waMsg.includes(`#${num}`) && waMsg.includes(link), 'WhatsApp opens the store chat with the order number and the link');
  ok(!/enviado pelo WhatsApp|mensagem enviada/i.test(text1), 'page does not claim the WhatsApp message was sent');
  ok(/não confirma nada sozinho/.test(text1), 'page explains WhatsApp is optional');
  ok(await noHScroll(a), 'confirmation fits the phone width (390px)');
  await a.screenshot({ path: `${SP}/track-confirmacao.png`, fullPage: true });

  // persistência no Neon: só o hash
  ok(psql(`select count(*) from order_tracking_tokens where token_hash = encode(sha256('${token}'::bytea),'hex')`) === '1', 'Neon has the SHA-256 of the code');
  ok(execSync('pg_dump -h 127.0.0.1 -p 5433 -U postgres -d copocheio_test --data-only').toString().includes(token) === false, 'plain code is nowhere in the database');

  // =====================================================================================================
  console.log('# 2. fecha o navegador, limpa os dados e volta');
  await a.evaluate(() => localStorage.clear());
  await a.reload({ waitUntil: 'networkidle' });
  ok(/Pedido recebido!/.test(await body(a)) && (await body(a)).includes(`#${num}`), 'reload with cleared local data keeps the order');
  await ctxA.close();
  const ctxB = await newContext(browser, { width: 1280, height: 800 });
  const b = track(await ctxB.newPage());
  await b.goto(link, { waitUntil: 'networkidle' });
  const textB = await body(b);
  ok(/Pedido #\d+/.test(textB) && textB.includes(`#${num}`) && /Novo/.test(textB) && /2x Coca 2L/.test(textB), 'link opens on another device (new browser profile, no cookies)');
  ok(/Opção|Seu link de acompanhamento/.test(textB) && (await b.getByRole('textbox', { name: 'Link de acompanhamento' }).inputValue()) === link, 'tracking page shows the link to save');
  ok((await b.locator('meta[name="robots"]').getAttribute('content')) === 'noindex, nofollow' && (await b.locator('meta[name="referrer"]').getAttribute('content')) === 'no-referrer', 'tracking page is noindex + no-referrer');
  await b.screenshot({ path: `${SP}/track-pagina-desktop.png`, fullPage: true });

  // número + código
  await b.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  const lookupText = await body(b);
  ok(/Já tenho uma conta/.test(lookupText) && /Quero acompanhar sem cadastro/.test(lookupText), 'lookup page shows option A (account) and option B (no signup)');
  ok(/guarde o link/i.test(lookupText), 'lookup page explains saving the link');
  await b.getByLabel('Número do pedido').fill(String(num));
  await b.getByLabel('Código de acompanhamento').fill('00000-00000-00000-00000');
  await b.getByRole('button', { name: 'Consultar pedido' }).click();
  await b.waitForSelector('[role=alert]');
  const wrongMsg = await b.locator('[role=alert]').innerText();
  ok(/Não encontramos um pedido com esses dados/.test(wrongMsg) && new URL(b.url()).pathname === '/acompanhar-pedido', 'wrong code: generic error, no access', wrongMsg);
  await b.getByLabel('Código de acompanhamento').fill('abc');
  await b.getByRole('button', { name: 'Consultar pedido' }).click();
  ok(await until(async () => (await b.locator('#' + (await b.getByLabel('Código de acompanhamento').getAttribute('id')) + '-erro').count()) === 1), 'malformed code: field error before calling the server');
  // O envio anterior move o foco para o campo inválido num requestAnimationFrame. Espera isso acabar antes de esvaziar o outro campo:
  // o fill('') do Playwright seleciona o texto e só depois aperta "Delete", e um foco roubado no meio faria o Delete ir para o campo errado.
  await b.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true', undefined, { timeout: 3000 }).catch(() => undefined);
  const numberField = b.getByLabel('Número do pedido');
  await numberField.fill('');
  await until(async () => (await numberField.inputValue()) === '');
  await b.getByRole('button', { name: 'Consultar pedido' }).click();
  ok(
    await until(async () => /Informe o número do pedido/.test(await body(b))),
    'empty number: field error',
    await b.evaluate(() => ({
      url: location.href,
      number: document.querySelector('input[inputmode=numeric]')?.value,
      active: document.activeElement?.getAttribute('placeholder') ?? document.activeElement?.tagName,
      text: document.body.innerText.slice(0, 700),
    })),
  );
  await b.getByLabel('Número do pedido').fill('#' + num);
  await b.getByLabel('Código de acompanhamento').fill(token.toLowerCase().replace(/-/g, ' '));
  await b.getByRole('button', { name: 'Consultar pedido' }).click();
  await b.waitForURL(`**/acompanhar-pedido/${token}`);
  ok((await body(b)).includes(`#${num}`), 'number + code (lowercase, spaces, #) opens the order');
  await b.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  ok(/Pedidos feitos neste aparelho/.test(await body(b)) && (await b.getByRole('link', { name: 'Acompanhar', exact: true }).count()) === 1, 'lookup remembers the order on this device (shortcut only)');
  await b.getByRole('button', { name: 'Esquecer todos' }).click();
  ok(await until(async () => !/Pedidos feitos neste aparelho/.test(await body(b))), 'shortcut list can be cleared');
  await b.goto(BASE + `/acompanhar-pedido/${num}`, { waitUntil: 'networkidle' });
  ok(/Pedido não encontrado/.test(await body(b)), 'order number alone gives no access');
  await b.goto(BASE + '/acompanhar-pedido/AAAAA-BBBBB-CCCCC-DDDDD', { waitUntil: 'networkidle' });
  ok(/Pedido não encontrado/.test(await body(b)) && !(await body(b)).includes('Ana'), 'unknown code: not found, no data');
  await b.screenshot({ path: `${SP}/track-nao-encontrado.png` });

  // =====================================================================================================
  console.log('# 3. admin muda o status → a página do cliente muda sozinha');
  const ctxC = await newContext(browser);
  const c = track(await ctxC.newPage());
  await c.goto(link, { waitUntil: 'networkidle' });
  const ctxAdmin = await newContext(browser, { width: 1440, height: 900 });
  const ad = track(await ctxAdmin.newPage());
  await ad.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await ad.getByLabel('E-mail').fill('dono@copocheio.local');
  await ad.locator('#login-senha').fill('senha-forte-123');
  await ad.getByRole('button', { name: 'Entrar' }).click();
  await ad.waitForURL('**/admin/dashboard');
  await ad.goto(BASE + `/admin/pedidos/${num}`, { waitUntil: 'networkidle' });
  ok(/Visitante/.test(await body(ad)) && /Pedido de visitante/.test(await body(ad)), 'admin identifies the order as a visitor order');
  await ad.getByRole('button', { name: 'CONFIRMAR PEDIDO', exact: true }).click();
  await ad.waitForSelector('text=Pedido atualizado.');
  const t0 = Date.now();
  await c.waitForSelector('li[data-state="current"]:has-text("Confirmado")', { timeout: 25000 });
  ok(true, `customer page updated by itself, no reload (${Math.round((Date.now() - t0) / 1000)}s after the admin click)`);
  const cText = await body(c);
  ok(/Pedido confirmado!/.test(cText) && /Próxima etapa: Em preparo/.test(cText), 'headline + next step follow the status');
  ok((await c.locator('li[data-state="done"]').count()) === 1 && /\d{2}:\d{2}/.test(await c.locator('li[data-state="done"]').innerText()), 'completed steps are marked and show the time');
  await ad.getByRole('button', { name: 'EM PREPARO', exact: true }).click();
  await ad.waitForSelector('text=Pedido atualizado.');
  await ad.getByRole('button', { name: 'SAIU PARA ENTREGA', exact: true }).click();
  await ad.waitForTimeout(700);
  await ad.getByRole('button', { name: 'ENTREGUE', exact: true }).click();
  await c.waitForSelector('li[data-state="current"]:has-text("Entregue")', { timeout: 25000 });
  ok(/Pedido entregue/.test(await body(c)) && (await c.locator('li[data-state="done"]').count()) === 4, 'all steps done at the end; final headline');
  await c.getByText('Ver todas as atualizações').click();
  const all = await c.locator('details').innerText();
  ok(/Novo/.test(all) && /Confirmado/.test(all) && /Em preparo/.test(all) && /Saiu para entrega/.test(all) && /Entregue/.test(all) && /\d{2}\/\d{2}\/\d{4}/.test(all), 'full history with date and time of each update');
  await ad.getByRole('button', { name: 'Pago', exact: true }).click();
  await ad.waitForSelector('text=Pagamento atualizado.');
  await c.waitForSelector('text=Pagamento confirmado', { timeout: 150000 });
  ok(true, 'payment status also follows the panel (final orders refresh every 120s)');
  await c.screenshot({ path: `${SP}/track-entregue.png`, fullPage: true });

  // cancelado
  await c.evaluate(() => undefined);
  await ctxC.close();
  const o2 = await (async () => {
    const r = await fetch(BASE + '/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.7.7.7' },
      body: JSON.stringify({ customer_name: 'Bruno Cancelado', customer_phone: '34977776666', delivery_type: 'pickup', payment_method: 'cash', items: [{ product_id: gelo.id, quantity: 1 }] }),
    });
    return r.json();
  })();
  const ctxD = await newContext(browser);
  const d = track(await ctxD.newPage());
  await d.goto(`${BASE}/acompanhar-pedido/${o2.token}`, { waitUntil: 'networkidle' });
  ok(/Pagar na retirada/.test(await body(d)) && /Retirada/.test(await body(d)), 'pickup + cash: pays on pickup');
  const id2 = (await admin('GET', `/api/admin/orders/${o2.order.order_number}`)).data.order.id;
  await admin('PATCH', `/api/admin/orders/${id2}`, { status: 'cancelled' });
  await d.waitForSelector('text=Pedido cancelado', { timeout: 25000 });
  ok(/Qualquer dúvida, fale com a loja/.test(await body(d)) && (await d.locator('li[data-state="current"]').count()) === 0, 'cancelled order shows the cancellation message');
  await d.screenshot({ path: `${SP}/track-cancelado.png`, fullPage: true });

  // =====================================================================================================
  console.log('# 4. falhas de rede e indisponibilidade temporária');
  const o3 = await (async () => {
    const r = await fetch(BASE + '/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.7.7.8' }, body: JSON.stringify({ customer_name: 'Carla Rede', customer_phone: '34966665555', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: coca.id, quantity: 1 }] }) });
    return r.json();
  })();
  const ctxE = await newContext(browser);
  const e = track(await ctxE.newPage());
  await e.goto(`${BASE}/acompanhar-pedido/${o3.token}`, { waitUntil: 'networkidle' });
  ok(/Carla Rede/.test(await body(e)) || /Pedido #/.test(await body(e)), 'tracking page loaded');
  await ctxE.setOffline(true);
  await e.waitForSelector('text=Sem conexão com o servidor', { timeout: 25000 });
  ok(/Mostrando a última atualização/.test(await body(e)) && /1x Coca 2L/.test(await body(e)), 'offline: banner + last known data stay on screen');
  ok(/tentando de novo em \d+s/.test(await body(e)), 'offline: retry countdown');
  await ctxE.setOffline(false);
  await e.getByRole('button', { name: 'Tentar agora' }).click({ timeout: 4000 }).catch(() => undefined);
  await e.waitForSelector('text=Sem conexão com o servidor', { state: 'detached', timeout: 15000 });
  ok(true, 'connection back: banner disappears after "Tentar agora"');
  await e.route('**/api/tracking/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Indisponível' }) }));
  await e.getByRole('button', { name: /Atualizar|Tentar/ }).first().click({ timeout: 1500 }).catch(() => undefined);
  await e.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await e.waitForSelector('text=Sem conexão com o servidor', { timeout: 25000 });
  ok(/Pedido #/.test(await body(e)), 'server 503: keeps showing the order, warns, retries with backoff');
  await e.unroute('**/api/tracking/**');
  await e.getByRole('button', { name: 'Tentar agora' }).click({ timeout: 4000 }).catch(() => undefined); // pode já ter reconectado sozinho
  await e.waitForSelector('text=Sem conexão com o servidor', { state: 'detached', timeout: 15000 });
  ok(true, 'server back: recovers on its own');
  // primeira carga com servidor fora do ar
  const ctxF = await newContext(browser);
  const f = track(await ctxF.newPage());
  await f.route('**/api/tracking/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'x' }) }));
  await f.goto(`${BASE}/acompanhar-pedido/${o3.token}`, { waitUntil: 'networkidle' });
  await f.waitForSelector('text=Não foi possível carregar o pedido agora', { timeout: 15000 });
  ok(/Seu pedido está salvo/.test(await body(f)), 'first load with server down: friendly message (order is saved)');
  await f.unroute('**/api/tracking/**');
  await f.getByRole('button', { name: 'Tentar agora' }).click({ timeout: 4000 }).catch(() => undefined);
  await f.waitForSelector('text=Carla Rede, text=1x Coca 2L', { timeout: 15000 }).catch(() => undefined);
  ok(/1x Coca 2L/.test(await body(f)), 'then loads normally');
  await ctxF.close();
  await ctxE.close();
  await ctxD.close();

  // =====================================================================================================
  console.log('# 5. conta: cadastro, vincular pedido, meus pedidos');
  const ctxG = await newContext(browser);
  const g = track(await ctxG.newPage());
  await g.goto(link, { waitUntil: 'networkidle' });
  await g.waitForSelector('text=Quer guardar o histórico');
  await g.getByRole('link', { name: 'Criar conta' }).click();
  await g.waitForURL(/\/conta\?aba=cadastro&voltar=/);
  await g.getByLabel('Nome *').fill('Ana Souza');
  await g.getByLabel('Telefone / WhatsApp *').fill('34988881111');
  await g.getByLabel('E-mail *').fill('ana@exemplo.com');
  await g.getByLabel('Senha *').fill('curta');
  await g.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  ok(await until(async () => /Use pelo menos 8 caracteres/.test(await body(g))), 'register validates the password');
  await g.getByLabel('Senha *').fill('ana-senha-123');
  await g.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  await confirmEmail(g, 'ana@exemplo.com');
  await g.waitForURL(`**/acompanhar-pedido/${token}`);
  ok(true, 'after signing up and confirming the e-mail, goes back to the order page');
  await g.waitForSelector('text=Você entrou como');
  ok((await g.evaluate(() => JSON.stringify({ ...localStorage }))).match(/senha|password|session|cookie|ana@/i) === null, 'no credentials in localStorage');
  ok((await ctxG.cookies()).some((x) => x.name === 'copocheio_cliente' && x.httpOnly && x.sameSite === 'Lax'), 'session cookie is HttpOnly + SameSite=Lax');
  ok(await g.evaluate(() => !document.cookie.includes('copocheio_cliente')), 'JavaScript cannot read the session cookie');
  await g.getByRole('button', { name: 'Salvar na minha conta' }).click();
  await g.waitForSelector('text=Este pedido está salvo na sua conta.');
  ok(true, 'guest order claimed (code + matching phone)');
  await g.getByRole('link', { name: 'Ver em Meus pedidos' }).click();
  await g.waitForURL(`**/conta/pedidos/${num}`);
  await g.waitForSelector('text=Pedir de novo');
  ok((await body(g)).includes(`Pedido #${num}`) && /Pedir de novo/.test(await body(g)), 'order detail inside the account');
  await g.getByRole('button', { name: 'Pedir novamente' }).click();
  await g.waitForURL('**/checkout');
  await g.waitForFunction(() => document.querySelector('input[autocomplete="name"]')?.value === 'Ana Souza');
  ok((await g.getByLabel('Nome *').inputValue()) === 'Ana Souza' && (await g.getByLabel('Telefone / WhatsApp *').inputValue()) === '(34) 98888-1111' && (await g.getByLabel('E-mail (opcional)').inputValue()) === 'ana@exemplo.com', 'checkout comes pre-filled from the account');
  ok(/Você entrou como/.test(await body(g)) && /Coca 2L/.test(await body(g)) && /Gelo 5kg/.test(await body(g)), '"order again" put the same items in the cart');
  await g.getByLabel('Rua / Avenida *').fill('Rua B');
  await g.getByLabel('Número *').fill('9');
  await g.getByLabel('Bairro *').fill('Centro');
  await g.waitForTimeout(700); // o site só aceita pedido depois de 0,6 s na tela
  await g.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await g.waitForURL(/\/pedido\//);
  await g.waitForSelector('text=Pedido recebido!');
  await g.waitForSelector('text=Este pedido está salvo na sua conta.', { timeout: 15000 }).catch(() => undefined);
  ok((await g.getByText('Este pedido está salvo na sua conta.').count()) >= 1, 'order placed while logged in is linked automatically');
  await g.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
  const listText = await body(g);
  ok((listText.match(/Pedido #\d+/g) || []).length === 2 && /2x Coca 2L/.test(listText), '"Meus pedidos" lists both orders with summary');
  ok(await noHScroll(g), '"Meus pedidos" fits the phone width');
  await g.screenshot({ path: `${SP}/track-meus-pedidos.png`, fullPage: true });
  await g.goto(BASE + '/conta/pedidos/9999', { waitUntil: 'networkidle' });
  ok(/Pedido não encontrado/.test(await body(g)), "someone else's / unknown order is not found");
  await g.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  ok(/Olá, Ana!/.test(await body(g)), 'account page shows the logged-in customer');
  ok(/Seu pedido em andamento/.test(await body(g)) && /Pedido #\d+/.test(await g.locator('section[aria-labelledby="atual"]').innerText()) && !(await g.locator('section[aria-labelledby="atual"]').innerText()).includes(`#${num}`), 'account page shows the current (in progress) order, not the delivered one');
  // /acompanhar-pedido logado: sem a opção "sem cadastro", sem o atalho de pedidos do aparelho
  await g.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  const trackLogged = await body(g);
  ok(/Você entrou como/.test(trackLogged) && /Ana Souza/.test(trackLogged) && /Seu pedido em andamento/.test(trackLogged), 'logged in: "Acompanhar pedido" shows the account and the order in progress');
  ok(!/Quero acompanhar sem cadastro/.test(trackLogged) && !/Opção B/i.test(trackLogged) && (await g.getByRole('button', { name: 'Consultar pedido' }).count()) === 0 && (await g.getByLabel('Código de acompanhamento').count()) === 0, 'logged in: the "track without signing up" option is gone (no number/code form)');
  ok(!/Pedidos feitos neste aparelho/.test(trackLogged) && !/Já tenho uma conta/.test(trackLogged), 'logged in: no device shortcuts and no "I have an account" option either');
  ok((await g.getByRole('link', { name: /Ver todos os meus pedidos/ }).count()) === 1, 'logged in: link to "Meus pedidos"');
  ok(await noHScroll(g), 'logged in: "Acompanhar pedido" fits the phone width');
  await g.screenshot({ path: `${SP}/track-acompanhar-logado.png`, fullPage: true });
  await g.locator('section[aria-labelledby="em-andamento"] a[href^="/conta/pedidos/"]').first().click();
  await g.waitForURL(/\/conta\/pedidos\/\d+$/);
  await g.waitForSelector('text=Pedir de novo');
  ok(true, 'logged in: the order in progress opens its details');
  await g.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await g.screenshot({ path: `${SP}/track-conta.png`, fullPage: true });

  // novo deploy: servidor reiniciado, sessões e links vêm do banco
  console.log('# 6. depois de reiniciar o servidor (novo deploy)');
  execSync('bash ' + JSON.stringify(require('node:path').join(__dirname, 'serve.sh')) + ' >/dev/null');
  await g.reload({ waitUntil: 'networkidle' });
  ok(/Olá, Ana!/.test(await body(g)), 'customer session survives a server restart');
  await ctxG.close();
  const ctxH = await newContext(browser);
  const h = track(await ctxH.newPage());
  await h.goto(link, { waitUntil: 'networkidle' });
  ok((await body(h)).includes(`#${num}`) && /Entregue/.test(await body(h)), 'tracking link survives a server restart');
  ok(execSync('cd ' + JSON.stringify(require('node:path').join(__dirname, '..')) + ' && TEST_PG_URL=postgres://postgres@127.0.0.1:5433/copocheio_test node tests/with-neon-proxy.mjs scripts/migrate.mjs').toString().includes('Banco já está atualizado'), 'running migrations again changes nothing');
  await ctxH.close();

  // =====================================================================================================
  console.log('# 7. outro cliente não enxerga os pedidos da Ana');
  const ctxI = await newContext(browser);
  const i = track(await ctxI.newPage());
  await i.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await i.getByLabel('Nome *').fill('Beto Outro');
  await i.getByLabel('Telefone / WhatsApp *').fill('34911112222');
  await i.getByLabel('E-mail *').fill('beto@exemplo.com');
  await i.getByLabel('Senha *').fill('beto-senha-123');
  await i.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  await confirmEmail(i, 'beto@exemplo.com');
  await i.waitForSelector('text=Olá, Beto!');
  await i.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
  ok(/Nenhum pedido na sua conta ainda/.test(await body(i)) && !(await body(i)).includes(`#${num}`), 'second customer sees none of the first customer’s orders');
  await i.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  ok(/Você não tem nenhum pedido em andamento agora/.test(await body(i)) && !/Quero acompanhar sem cadastro/.test(await body(i)), 'logged in without orders: friendly empty state, still no "without signing up" option');
  await i.goto(BASE + `/conta/pedidos/${num}`, { waitUntil: 'networkidle' });
  ok(/Pedido não encontrado/.test(await body(i)), 'second customer cannot open the first customer’s order by number');
  await i.goto(BASE + `/acompanhar-pedido/${token}`, { waitUntil: 'networkidle' });
  ok(!(await i.getByRole('button', { name: 'Salvar na minha conta' }).count()) && !(await body(i)).includes('Este pedido está salvo na sua conta'), 'order owned by another account offers no "save to my account"');
  await i.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
  await i.getByLabel('Número do pedido').fill(String(num));
  await i.getByLabel('Código de acompanhamento').fill(token);
  await i.getByRole('button', { name: 'Vincular pedido' }).click();
  await i.waitForSelector('[role=alert]');
  ok(/Não encontramos um pedido com esses dados/.test(await i.locator('[role=alert]').first().innerText()), 'cannot claim an order that belongs to another account, even with the code');
  // sair
  await i.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await i.getByRole('button', { name: 'Sair' }).click();
  await i.waitForURL(BASE + '/');
  await i.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
  ok(new URL(i.url()).pathname === '/conta' && /Minha conta/.test(await body(i)), 'logged out: "Meus pedidos" sends to the login');
  await i.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  const trackOut = await body(i);
  ok(/Já tenho uma conta/.test(trackOut) && /Quero acompanhar sem cadastro/.test(trackOut) && (await i.getByRole('button', { name: 'Consultar pedido' }).count()) === 1, 'logged out: both options (account / without signing up) are back');
  await ctxI.close();

  // =====================================================================================================
  console.log('# 8. painel: filtros, tipo de cliente, link de acompanhamento, clientes');
  await ad.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  ok((await ad.getByText('Conta', { exact: true }).count()) >= 1 && (await ad.getByText('Visitante', { exact: true }).count()) >= 1, 'list tells account orders from visitor orders');
  await ad.locator('select').selectOption('account');
  await ad.waitForTimeout(800);
  const accRows = await ad.locator('tbody tr').count();
  ok(accRows === 2, 'filter "Com conta" shows the 2 orders of the account', accRows);
  await ad.locator('select').selectOption('guest');
  await ad.waitForTimeout(800);
  ok((await ad.locator('tbody tr').count()) === 2, 'filter "Visitantes" shows the visitor orders');
  await ad.locator('select').selectOption('all');
  await ad.locator('input[type=date]').first().fill('2000-01-01');
  await ad.locator('input[type=date]').last().fill('2000-01-02');
  await ad.waitForTimeout(800);
  ok((await ad.locator('tbody tr').count()) === 0 && /Nenhum pedido encontrado/.test(await body(ad)), 'date filter (old range) shows nothing');
  await ad.locator('input[type=date]').first().fill(today);
  await ad.locator('input[type=date]').last().fill(today);
  await ad.waitForTimeout(800);
  ok((await ad.locator('tbody tr').count()) === 4, 'date filter (today) shows all 4 orders');
  await ad.getByRole('button', { name: 'Limpar filtros' }).click();
  await ad.getByPlaceholder('Número, nome, telefone ou e-mail').fill('ana@exemplo.com');
  await ad.waitForTimeout(800);
  ok((await ad.locator('tbody tr').count()) === 2, 'search by e-mail finds the customer’s orders (2 with that e-mail)');
  await ad.getByPlaceholder('Número, nome, telefone ou e-mail').fill('');

  await ad.goto(BASE + `/admin/pedidos/${num}`, { waitUntil: 'networkidle' });
  ok(/Cliente com conta/.test(await body(ad)), 'admin detail shows the customer account');
  ok(/Acompanhamento do cliente/.test(await body(ad)) && /1 link ativo/.test(await body(ad)), 'admin detail: tracking card with active link count');
  ok(!(await body(ad)).includes(token), 'admin never sees the stored code (only a hash exists)');
  await ad.getByRole('button', { name: 'Gerar link', exact: true }).click();
  await ad.waitForSelector('input[aria-label="Link de acompanhamento"]');
  const adminLink = await ad.getByRole('textbox', { name: 'Link de acompanhamento' }).inputValue();
  ok(new RegExp(`^${BASE}/acompanhar-pedido/${TOKEN.source}$`).test(adminLink), 'admin generates a fresh link', adminLink);
  const waAdmin = await ad.getByRole('link', { name: 'Enviar por WhatsApp' }).getAttribute('href');
  ok(waAdmin.startsWith('https://wa.me/5534988881111?text=') && decodeURIComponent(waAdmin).includes(adminLink), 'admin can send the link to the customer on WhatsApp');
  await ad.getByRole('button', { name: 'Copiar', exact: true }).click();
  ok(await until(async () => (await ad.evaluate(() => navigator.clipboard.readText().catch(() => ''))) === adminLink), 'admin copy button');
  const ctxJ = await newContext(browser);
  const j = track(await ctxJ.newPage());
  await j.goto(adminLink, { waitUntil: 'networkidle' });
  ok((await body(j)).includes(`#${num}`), 'admin link opens the customer page');
  await j.goto(link, { waitUntil: 'networkidle' });
  ok((await body(j)).includes(`#${num}`), 'the customer’s own link keeps working after the admin generated another');
  await ad.getByRole('button', { name: 'Trocar link', exact: true }).click();
  await ad.getByRole('button', { name: 'Trocar link', exact: true }).last().click();
  await ad.waitForSelector('text=Link trocado.');
  await j.goto(link, { waitUntil: 'networkidle' });
  ok(/Pedido não encontrado/.test(await body(j)), '"Trocar link" invalidates the old links');
  const newLink = await ad.getByRole('textbox', { name: 'Link de acompanhamento' }).inputValue();
  await j.goto(newLink, { waitUntil: 'networkidle' });
  ok((await body(j)).includes(`#${num}`), 'the new link works');
  await ctxJ.close();

  await ad.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  ok(/Ana Souza/.test(await body(ad)) && /ana@exemplo\.com/.test(await body(ad)) && /2 pedidos/.test(await body(ad)), 'admin "Clientes" lists the account with its order count');
  await ad.locator('li', { hasText: 'ana@exemplo.com' }).getByRole('button', { name: 'Link para nova senha' }).click();
  await ad.waitForSelector('input[aria-label="Link de redefinição"]');
  const resetLink = await ad.getByLabel('Link de redefinição').inputValue();
  ok(/\/conta\/redefinir\/[\w-]{20,}$/.test(resetLink), 'admin generates a password reset link');
  const ctxK = await newContext(browser);
  const k = track(await ctxK.newPage());
  await k.goto(resetLink, { waitUntil: 'networkidle' });
  await k.locator('input[type=password]').fill('nova-senha-456');
  await k.getByRole('button', { name: 'Salvar senha nova' }).click();
  await k.waitForSelector('text=Senha redefinida');
  await k.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await k.getByLabel('E-mail *').fill('ana@exemplo.com');
  await k.getByLabel('Senha *').fill('ana-senha-123');
  await k.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await k.waitForSelector('[role=alert]');
  ok(/E-mail ou senha incorretos/.test(await k.locator('[role=alert]').innerText()), 'old password no longer works');
  await k.getByLabel('Senha *').fill('nova-senha-456');
  await k.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(k);
  await k.waitForSelector('text=Olá, Ana!');
  ok(true, 'new password works');
  await k.goto(resetLink, { waitUntil: 'networkidle' });
  await k.waitForSelector('[role=alert]');
  ok(/não vale mais/.test(await k.locator('[role=alert]').innerText()) && (await k.locator('input[type=password]').count()) === 0, 'reset link works only once (the page says so before asking for a password)');
  await ctxK.close();

  // =====================================================================================================
  console.log('# 9. layout em celular e computador');
  const ctxL = await newContext(browser);
  const l = track(await ctxL.newPage());
  const pages = ['/acompanhar-pedido', `/acompanhar-pedido/${newLink.split('/').pop()}`, '/conta', '/conta/recuperar', '/bebidas', '/'];
  for (const w of [320, 360, 390, 768, 1024, 1440]) {
    await l.setViewportSize({ width: w, height: 900 });
    for (const p of pages) {
      await l.goto(BASE + p, { waitUntil: 'networkidle' });
      if (!(await noHScroll(l))) ok(false, `no horizontal scroll at ${w}px: ${p}`);
    }
  }
  ok(true, `no horizontal scroll on ${pages.length} pages × 6 widths (320–1440px)`);
  await l.setViewportSize({ width: 390, height: 844 });
  await l.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  await l.screenshot({ path: `${SP}/track-acompanhar-mobile.png`, fullPage: true });
  await l.setViewportSize({ width: 1280, height: 800 });
  await l.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
  await l.screenshot({ path: `${SP}/track-acompanhar-desktop.png`, fullPage: true });
  await l.goto(BASE + '/', { waitUntil: 'networkidle' });
  await l.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await l.waitForTimeout(500);
  const foot = await l.locator('footer').innerText();
  ok(/Acompanhar pedido/.test(foot) && /Minha conta/.test(foot), 'footer links to "Acompanhar pedido" and "Minha conta"');
  await l.setViewportSize({ width: 390, height: 844 });
  await l.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  ok((await l.getByRole('link', { name: 'Acompanhar' }).count()) >= 1, 'Bebidas page has an "Acompanhar" shortcut');
  await ctxL.close();

  ok(errors.length === 0, 'no console/page errors', errors.slice(0, 5));
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log('CRASH', err);
  process.exit(2);
});
