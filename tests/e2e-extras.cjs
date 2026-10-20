// Extras da Etapa C, de ponta a ponta no navegador (celular e computador):
//  • painel: agendamento ligado pela tela de Entrega, feriado cadastrado e removido em Horários, estoque baixo (padrão da loja e por produto) e o aviso no painel inicial,
//    exportação CSV baixada de verdade (BOM, ";", fórmula neutralizada), edição dos termos e anotação de revisão;
//  • site: "Agendar" no checkout (dia + faixa) com o pedido mostrando o horário, loja fechada que ainda aceita agendar, CEP que preenche rua e bairro (ViaCEP falso),
//    endereço extra salvo na conta e escolhido no checkout, páginas de termos e políticas com os links no rodapé; sem rolagem lateral no celular.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-extras.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
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
const TZ = 'America/Sao_Paulo';

let cookie = '';
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.31.31.31', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
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
const dayOf = (n) => psql(`select ((now() at time zone '${TZ}')::date + ${n})::text`);

async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
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
async function addToCart(page, name) {
  await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await page.locator(`button[aria-label="Adicionar ${name} ao pedido"]`).first().click();
  await page.waitForTimeout(250);
}
async function fillBasics(page, suffix) {
  await page.getByLabel('Nome *').fill('Cliente Extras ' + suffix);
  await page.getByLabel('Telefone / WhatsApp *').fill('3498' + String(6000000 + Math.floor(Math.random() * 999999)));
  await page.waitForTimeout(700);
}
const orderNumberOf = async (page) => {
  await page.waitForURL(/\/pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, { timeout: 15000 });
  await page.waitForSelector('text=Pedido recebido!');
  return Number((/Seu pedido #(\d+) foi enviado/.exec(await text(page)) || [])[1]);
};

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const st = await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 6, min_order: 0, scheduling_enabled: false });
  ok(st.status === 200, 'preparo: loja aberta 24h, agendamento desligado', st.data);
  const cat = (await api('POST', '/api/admin/categories', { name: 'Extras' })).data.category;
  const mk = async (name, price, extra) => (await api('POST', '/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, stock: 100, alcoholic: false, ...extra })).data.product;
  const agua = await mk('Água Extras', 20);
  const gelo = await mk('Gelo Extras', 9, { stock: 4 });
  const browser = patchBrowser(await chromium.launch());

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# painel: agendamento, feriado, estoque, CSV e termos');
  {
    const { ctx, page } = await adminPage(browser);
    // Entrega → agendamento
    await page.goto(BASE + '/admin/configuracoes#entrega', { waitUntil: 'networkidle' });
    const card = page.locator('[data-scheduling-card]');
    await card.waitFor({ timeout: 8000 });
    await card.getByRole('switch').click();
    await card.getByLabel('Pedidos por faixa (opcional)').fill('1');
    await card.getByLabel('Até quantos dias à frente').selectOption('3');
    await card.getByRole('button', { name: 'Salvar agendamento' }).click();
    await page.waitForSelector('text=Agendamento salvo.');
    ok(psql('select scheduling_enabled::text || schedule_max_days || schedule_slot_capacity from store_settings') === 'true31', 'agendamento ligado pela tela (3 dias à frente, 1 pedido por faixa)');

    // Horários → feriado
    await page.getByRole('tab', { name: 'Horários' }).click();
    await page.locator('[data-special-days]').waitFor();
    await page.locator('[data-special-save]').click();
    ok(/Escolha o dia/.test(await page.locator('[data-special-error]').innerText()), 'dia especial sem data: a tela pede o dia');
    await page.locator('[data-special-day]').fill(dayOf(2));
    await page.locator('[data-special-kind]').selectOption('closed');
    await page.getByPlaceholder('Ex.: Natal').fill('Feriado de teste');
    await page.locator('[data-special-save]').click();
    await page.waitForSelector('text=Dia especial salvo.');
    ok((await page.locator(`[data-special-row="${dayOf(2)}"]`).innerText()).includes('Fechado'), 'o feriado aparece na lista como "Fechado"');
    ok(psql(`select kind from store_exceptions where day = '${dayOf(2)}'`) === 'closed', 'e foi gravado');

    // Estoque → padrão e por produto, aviso no painel inicial
    await page.goto(BASE + '/admin/estoque', { waitUntil: 'networkidle' });
    await page.locator('[data-low-default-input]').waitFor();
    ok((await page.locator('[data-low-default-input]').inputValue()) === '5', 'o padrão da loja começa em 5');
    // Aviso por e-mail aos donos (liga e desliga pela tela)
    const emailSwitch = page.locator('[data-low-email]').getByRole('switch');
    await emailSwitch.waitFor();
    ok((await emailSwitch.getAttribute('aria-checked')) === 'true' && psql('select low_stock_email::text from store_settings') === 'true', 'o aviso de estoque por e-mail começa ligado');
    await emailSwitch.click();
    await page.waitForSelector('text=Aviso por e-mail desligado.');
    ok(psql('select low_stock_email::text from store_settings') === 'false', 'desligar pela tela grava no banco');
    await emailSwitch.click();
    await page.waitForSelector('text=Aviso por e-mail ligado.');
    ok(psql('select low_stock_email::text from store_settings') === 'true', 'ligar de novo também');
    const row = page.locator('li', { hasText: 'Gelo Extras' });
    ok(/Estoque baixo/.test(await row.innerText()), 'Gelo Extras (4 un.) aparece como estoque baixo com o padrão 5');
    await row.locator('[data-low-threshold]').fill('2');
    await row.locator('[data-low-threshold]').blur();
    await page.waitForSelector('text=Aviso com até 2 un.');
    ok(!/Estoque baixo/.test(await page.locator('li', { hasText: 'Gelo Extras' }).innerText()), 'com limite próprio de 2 ele deixa de ser "baixo"');
    await page.locator('[data-low-default-input]').fill('120');
    await page.getByRole('button', { name: 'Salvar padrão' }).click();
    await page.waitForSelector('text=Padrão salvo.');
    ok(psql('select low_stock_default from store_settings') === '120', 'padrão da loja alterado para 120');
    await page.goto(BASE + '/admin/dashboard', { waitUntil: 'networkidle' });
    await page.locator('[data-low-stock-alert]').waitFor({ timeout: 8000 });
    ok(/estoque baixo/i.test(await page.locator('[data-low-stock-alert]').innerText()), 'o painel inicial avisa dos produtos com estoque baixo');
    await api('PATCH', '/api/admin/store', { low_stock_default: 5 });

    // CSV de verdade
    await api('POST', '/api/orders', { customer_name: '=1+1 Planilha', customer_phone: '34977771111', delivery_type: 'pickup', payment_method: 'pix', age_confirmed: true, items: [{ product_id: agua.id, quantity: 1 }] });
    await page.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
    await page.locator('[data-export="orders"]').click();
    await page.locator('[data-export-run]').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-export-run]').click()]);
    const fs = require('fs');
    const file = await download.path();
    const bytes = fs.readFileSync(file);
    const content = bytes.toString('utf8');
    ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, 'o arquivo baixado começa com o BOM de UTF-8');
    ok(/^pedidos-\d{4}-\d{2}-\d{2}_a_\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), 'nome do arquivo: ' + download.suggestedFilename());
    ok(/;'=1\+1 Planilha;/.test(content), 'o nome que começa com "=" saiu neutralizado (com apóstrofo) na planilha', content.slice(0, 400));
    ok(/Pedido;Data;Situação;/.test(content.replace(/^﻿/, '')), 'cabeçalho em português');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  for (const [w, h, name] of [[1280, 800, 'computador'], [390, 844, 'celular']]) {
    console.log(`# ${name} (${w}×${h}): agendar o pedido`);
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await addToCart(page, 'Água Extras');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-schedule]').waitFor({ timeout: 8000 });
    await fillBasics(page, name);
    await page.getByText('Retirar na loja', { exact: true }).click();
    await page.locator('[data-schedule-mode="later"]').check({ force: true });
    await page.locator('[data-schedule-day]').waitFor({ timeout: 8000 });
    const days = await page.locator('[data-schedule-day] option').allInnerTexts();
    ok(days.length >= 1 && days.length <= 4, `${name}: o seletor de dia mostra até 4 dias (${days.join(' | ')})`);
    ok(!days.some((d) => d.includes(dayOf(2).slice(8, 10) + '/' + dayOf(2).slice(5, 7))), `${name}: o feriado cadastrado NÃO aparece como dia disponível`);
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    ok(/Escolha o dia e o horário/.test(await page.locator('[data-schedule-error]').innerText()), `${name}: sem escolher o horário, nada é enviado e a tela explica`);
    await page.locator('[data-schedule-day]').selectOption({ index: Math.min(1, days.length - 1) });
    const slotValue = await page.locator('[data-schedule-time] option:not([disabled])').nth(5).getAttribute('value');
    await page.locator('[data-schedule-time]').selectOption(slotValue);
    ok(/agendado para/i.test(await page.locator('[data-schedule-summary]').innerText()), `${name}: o resumo repete o horário escolhido`);
    if (w < 1000) ok(await noHScroll(page), `${name}: sem rolagem lateral`);
    await page.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
    const number = await orderNumberOf(page);
    ok(psql(`select scheduled_for = '${slotValue}'::timestamptz from orders where order_number = ${number}`) === 't', `${name}: o pedido #${number} grava o horário escolhido`);
    ok((await page.locator('[data-scheduled-notice]').count()) === 1 && /agendada para/.test(await page.locator('[data-scheduled-notice]').innerText()), `${name}: a confirmação mostra "agendada para …"`);
    await ctx.close();
  }

  console.log('# faixa lotada some da lista e loja fechada agora ainda aceita agendar');
  {
    const slot = psql("select to_char(scheduled_for at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from orders where scheduled_for is not null order by order_number limit 1");
    const info = (await (await fetch(BASE + '/api/schedule')).json()).days.flatMap((d) => d.slots);
    const taken = info.find((s) => new Date(s.at).getTime() === new Date(slot).getTime());
    ok(taken && taken.available === false, 'a faixa já usada (1 pedido por faixa) aparece lotada', taken);
    const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][Number(psql(`select extract(dow from (now() at time zone '${TZ}'))::int`))];
    await api('PATCH', '/api/admin/store', { opening_hours: { ...ALL_DAYS, [dow]: { open: false, start: '00:00', end: '00:00' } } });
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await addToCart(page, 'Água Extras');
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.locator('[data-closed-notice]').waitFor({ timeout: 8000 });
    ok(/fechados/.test(await page.locator('[data-closed-notice]').innerText()) && /agendar/.test(await page.locator('[data-closed-notice]').innerText()), 'o aviso diz que está fechado e que dá para agendar');
    ok((await page.locator('[data-schedule-mode="now"]').isDisabled()) && (await page.locator('[data-schedule-mode="later"]').isChecked()), '"O quanto antes" fica desligado e "Agendar" já vem escolhido');
    await ctx.close();
    await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# CEP e endereços extras salvos na conta');
  {
    await api('PATCH', '/api/admin/store', { scheduling_enabled: false });
    await api('POST', '/api/admin/zones', { name: 'Centro', fee: 4 });
    const email = 'extras.cliente@exemplo.com';
    // Cadastro pela API (o foco aqui é o endereço); o login é feito pela tela, com o código enviado por e-mail.
    const { Client, registerVerified } = await import('./lib.mjs');
    const c = { name: 'Cliente Extras', email, phone: '34981119999', password: 'senha-forte-123' };
    await registerVerified(new Client(BASE, '10.31.31.40'), c);
    ok(psql(`select count(*) from customers where email = '${email}' and email_verified_at is not null`) === '1', 'preparo: conta de cliente criada e confirmada');
    const { ctx: c2, page: p2 } = await newCtx(browser, { width: 1280, height: 900 });
    await p2.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await p2.getByLabel('E-mail *').fill(email);
    await p2.getByLabel('Senha *').fill(c.password);
    await p2.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await p2.getByLabel('Código de acesso').waitFor();
    await finishLogin(p2, email);
    await p2.locator('[data-address-add]').waitFor({ timeout: 15000 });
    await p2.locator('[data-address-add]').click();
    await p2.locator('[data-address-label]').fill('Trabalho');
    const form = p2.locator('[data-address-form]');
    await form.getByLabel('CEP (opcional)').fill('38400-000');
    await p2.waitForFunction(() => document.querySelector('[data-address-form] input[maxlength="120"]')?.value === 'Avenida Teste', null, { timeout: 8000 });
    ok(true, 'na conta: o CEP 38400-000 preencheu a rua com "Avenida Teste"');
    await form.getByLabel('Número', { exact: true }).fill('500');
    await p2.getByRole('button', { name: 'Salvar endereço' }).click();
    await p2.waitForSelector('[data-address="Trabalho"]');
    ok(/Avenida Teste, 500/.test(await p2.locator('[data-address="Trabalho"]').innerText()), 'o endereço extra aparece na lista da conta');
    ok(psql("select count(*) from customer_addresses where label = 'Trabalho'") === '1', 'e foi gravado');

    // Checkout: escolher o endereço salvo
    await addToCart(p2, 'Água Extras');
    await p2.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await p2.locator('[data-saved-address]').waitFor({ timeout: 8000 });
    await p2.locator('[data-saved-address]').selectOption({ label: 'Trabalho · Avenida Teste, 500' });
    ok((await p2.getByLabel('Rua / Avenida *').inputValue()) === 'Avenida Teste' && (await p2.getByLabel('Número *').inputValue()) === '500', 'no checkout: escolher o endereço salvo preenche rua e número');
    // CEP no checkout (bairro com lista: casa com "Centro")
    await p2.locator('[data-saved-address]').selectOption('');
    await p2.getByLabel('Rua / Avenida *').fill('');
    await p2.locator('[data-cep-input]').fill('38400000');
    await p2.waitForSelector('[data-cep-note="ok"]', { timeout: 8000 });
    ok((await p2.getByLabel('Rua / Avenida *').inputValue()) === 'Avenida Teste', 'no checkout: o CEP preenche a rua');
    ok((await p2.getByLabel('Bairro *').inputValue()) === 'Centro', 'e escolhe o bairro "Centro" da lista de entrega');
    await p2.locator('[data-cep-input]').fill('38400-222');
    await p2.waitForSelector('[data-cep-note="warn"]', { timeout: 8000 });
    ok(/não está na nossa lista de entrega/.test(await p2.locator('[data-cep-note]').innerText()), 'bairro que a loja não atende: a tela avisa para escolher da lista');
    await p2.locator('[data-cep-input]').fill('99999999');
    await p2.waitForSelector('[data-cep-note="warn"]:has-text("Não encontramos")', { timeout: 8000 });
    ok(true, 'CEP inexistente: "Não encontramos esse CEP"');
    await p2.evaluate(() => fetch('/__viacep/mode', { method: 'POST', body: JSON.stringify({ mode: 'down' }) }));
    await p2.locator('[data-cep-input]').fill('38400-333');
    await p2.waitForSelector('[data-cep-note="warn"]:has-text("à mão")', { timeout: 8000 });
    ok(true, 'serviço de CEP fora do ar: a tela manda preencher à mão (o pedido segue possível)');
    await p2.evaluate(() => fetch('/__viacep/mode', { method: 'POST', body: JSON.stringify({ mode: 'ok' }) }));
    await c2.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# termos e políticas');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/privacidade', { waitUntil: 'networkidle' });
    for (const [label, path] of [['Termos de uso', '/termos'], ['Cancelamento e trocas', '/trocas-e-cancelamentos'], ['Entrega e retirada', '/entrega'], ['Pagamento e reembolso', '/pagamento-e-reembolso']]) {
      ok((await page.locator(`footer a[href="${path}"]`, { hasText: label }).count()) === 1, `rodapé tem o link "${label}"`);
    }
    await page.locator('footer a[href="/termos"]').click();
    await page.waitForURL('**/termos');
    await page.locator('[data-legal="termos"]').waitFor({ timeout: 8000 });
    const t = await text(page);
    ok(/Termos de uso/.test(t) && /Bebidas alcoólicas/.test(t) && /documento oficial com foto/.test(t), 'a página de termos mostra o texto padrão (maioridade e documento)');
    ok((await page.locator('[data-legal="termos"] h2').count()) >= 3 && (await page.locator('[data-legal="termos"] li').count()) >= 3, 'seções e listas desenhadas a partir do texto');
    ok(await noHScroll(page), 'sem rolagem lateral no celular');
    await ctx.close();

    const { ctx: a, page: ap } = await adminPage(browser);
    await ap.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
    await ap.getByRole('tab', { name: 'Termos e políticas' }).click();
    await ap.locator('[data-legal-editor="termos"]').waitFor({ timeout: 8000 });
    ok(/Ainda não revisado juridicamente/.test(await text(ap)) && /não são parecer jurídico/.test(await text(ap)), 'o painel avisa que o texto ainda não foi revisado e que não é parecer jurídico');
    const body = ap.locator('[data-legal-editor="termos"] [data-legal-body]');
    await body.fill('## Regras da casa\n- Entregamos só com documento\n\nTexto novo e curtinho para o teste do painel.');
    await ap.locator('[data-legal-editor="termos"] [data-legal-save]').click();
    await ap.waitForSelector('text=Texto salvo.');
    await ap.getByLabel('Revisado por (nome)').first().fill('Dra. Teste');
    await ap.getByRole('button', { name: 'Anotar como revisado' }).first().click();
    await ap.waitForSelector('text=Anotado como revisado.');
    ok(/Revisado por Dra\. Teste/.test(await ap.locator('[data-legal-editor="termos"]').locator('xpath=ancestor::*[contains(@class,"rounded")][1]').innerText().catch(() => text(ap))) || /Revisado por Dra\. Teste/.test(await text(ap)), 'anota quem revisou');
    await a.close();
    const pub = await (await fetch(BASE + '/api/legal/termos')).json();
    ok(pub.page.body.startsWith('## Regras da casa'), 'o texto editado já é o que o público lê');
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
