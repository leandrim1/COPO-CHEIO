// Botão "Login" / "Minha conta" no cabeçalho da página Bebidas, de ponta a ponta no navegador (celular e computador): onde ele fica (canto superior
// direito da área de informações da loja, sem cobrir nada), como se comporta (leva para /conta, a tela de entrada que o site já tem), o que acontece
// com quem já tem sessão ("Minha conta", sem pedir a senha de novo, sem piscar "Login"), criar conta e confirmar o e-mail a partir dele, sair, e que
// o acompanhamento sem cadastro, o botão "Acompanhar pedido" e o carrinho continuam como eram.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-login.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const BASE = 'http://localhost:4180';
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
      /* a tela ainda está mudando */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 120));
  }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let ipN = 0;
async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  // Cada "visitante" do teste vem de um IP próprio (os limites por IP do servidor não misturam os cenários).
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.60.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}` });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|40[0-9]|50[0-9]/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}
const link = (page) => page.locator('[data-account-link]');
const rectOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
  }, selector);
const overlaps = (a, b) => a && b && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const mails = async (to) => (await fetch(`${BASE}/__mail?to=${encodeURIComponent(to.toLowerCase())}`)).json();
async function nextMail(to, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await mails(to);
    if (list.length) return list[list.length - 1];
    await wait(150);
  }
  return null;
}

const { finishLogin, latestLoginCode } = require('./e2e-code.cjs');
(async () => {
  // Cardápio com bastante coisa, para a página rolar e dar para pôr algo no carrinho.
  psql(`insert into categories(name, position) values ('Copão', 0), ('Cervejas', 1);
        insert into products(category_id, name, description, price, featured, position)
          select c.id, 'Item ' || c.name || ' ' || g, 'Descrição de teste', 20 + g, g = 0, g from categories c, generate_series(0, 9) g;`);
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  require('./e2e-age.cjs').patchBrowser(browser);

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 1. visitante: onde o botão "Login" fica, em vários tamanhos de tela');
  const sizes = [[1440, 900, 'computador 1440'], [1280, 800, 'computador 1280'], [1024, 768, 'computador 1024'], [768, 1024, 'tablet 768'], [390, 844, 'celular 390'], [360, 740, 'celular 360'], [320, 640, 'celular 320']];
  for (const [w, h, name] of sizes) {
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    let meCalls = 0;
    page.on('request', (r) => {
      if (/\/api\/account\/me$/.test(r.url())) meCalls++;
    });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await link(page).waitFor({ timeout: 8000 });
    const t = link(page);
    ok((await t.innerText()).trim() === 'Login' && (await t.getAttribute('data-account-link')) === 'out', `${name}: o botão diz "Login" para quem não tem sessão`);
    ok(/\/conta$/.test(await t.evaluate((a) => a.href)) && !(await t.evaluate((a) => a.search)), `${name}: leva para /conta, a tela de entrada que já existe (sem ?voltar, para não haver vai e volta)`);
    ok(meCalls >= 1, `${name}: a sessão é conferida no servidor (/api/account/me), nada guardado no navegador`, meCalls);
    const R = {
      btn: await rectOf(page, '[data-account-link]'),
      h1: await rectOf(page, 'main h1'),
      logo: await rectOf(page, 'main img[alt^="COPO CHEIO"]'),
      tagline: await page.evaluate(() => { const p = document.querySelector('main h1')?.nextElementSibling; const r = p?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null; }),
      info: await page.evaluate(() => { const li = document.querySelector('main h1')?.closest('div.flex')?.parentElement?.querySelector('ul'); const r = li?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null; }),
      status: await page.evaluate(() => { const s = [...document.querySelectorAll('main span')].find((e) => /^(Aberto agora|Fechado)/.test(e.textContent.trim())); const r = s?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null; }),
      info_btn: await rectOf(page, '[data-store-info-trigger]'),
      search: await rectOf(page, 'input[type=search]'),
      cover: await rectOf(page, 'main > div:first-child'),
      acomp: await rectOf(page, 'main a[href="/acompanhar-pedido"]'),
      inicio: await rectOf(page, 'main a[href="/"]'),
    };
    ok(R.btn.left >= 0 && R.btn.right <= w && R.btn.top >= 0, `${name}: o botão está inteiro dentro da tela`, R.btn);
    ok(await noHScroll(page), `${name}: sem rolagem horizontal`);
    ok(R.btn.width <= 110 && R.btn.height <= 44, `${name}: tamanho compacto (${Math.round(R.btn.width)}×${Math.round(R.btn.height)})`, R.btn);
    ok(!['h1', 'logo', 'tagline', 'info', 'status', 'info_btn', 'search', 'acomp', 'inicio'].some((k) => overlaps(R.btn, R[k])), `${name}: não cobre logotipo, nome, descrição, entrega, status, ⓘ, busca nem os botões do topo`, R);
    ok(R.btn.top >= R.cover.bottom - 1 && !(await page.locator('main > div:first-child [data-account-link]').count()), `${name}: fica abaixo da faixa azul do topo (a de "Início" e "Acompanhar pedido"), não dentro dela`, { btn: R.btn, cover: R.cover });
    const lines = await page.evaluate(() => { const h = document.querySelector('main h1'); return Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)); });
    ok(lines === 1, `${name}: o nome da loja continua numa linha só (o layout da loja foi preservado)`, lines);
    // O contêiner do cabeçalho só é "relative" no computador (onde o botão é posicionado). No celular, "relative" faria o cabeçalho cobrir os pontinhos do carrossel da capa.
    const pos = await page.evaluate(() => getComputedStyle(document.querySelector('main h1').closest('div[class*="lg:grid"]')).position);
    ok(pos === (w >= 1024 ? 'relative' : 'static'), `${name}: o contêiner do cabeçalho é ${pos} (não cobre a faixa azul do topo no celular)`, pos);
    const inside = await t.evaluate((a) => !a.closest('label, [role=group], ul, form') && !a.closest('#cardapio'));
    ok(inside, `${name}: não está dentro de busca, categorias, produtos nem formulários`);
    ok(R.acomp && R.acomp.top < 80 && R.acomp.right > w - 90 && R.acomp.right <= w, `${name}: "Acompanhar pedido" continua no canto superior direito da faixa azul`, R.acomp);
    ok(Math.abs(R.btn.right - R.search.right) <= 2, `${name}: alinhado à direita, na mesma borda direita da busca (a borda do conteúdo da loja)`, { btn: R.btn.right, search: R.search.right });
    ok(Math.abs((R.btn.top + R.btn.bottom) / 2 - (R.h1.top + R.h1.bottom) / 2) <= 16, `${name}: na altura da linha do nome da loja (topo da área de informações)`, { btn: R.btn, h1: R.h1 });
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 2. aparência, mouse e teclado');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const t = link(page);
    await t.waitFor();
    const css = await t.evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor, radius: parseFloat(s.borderTopLeftRadius), border: s.borderTopColor, cursor: s.cursor, weight: s.fontWeight }; });
    ok(css.color === 'rgb(255, 255, 255)' && css.bg === 'rgb(0, 0, 0)', 'texto branco sobre fundo preto (a identidade do site)', css);
    ok(css.radius >= 6 && css.radius <= 12, `cantos levemente arredondados (${css.radius}px)`, css);
    ok(css.cursor === 'pointer', 'cursor de clique');
    const before = await t.evaluate((el) => ({ bc: getComputedStyle(el).borderColor, bg: getComputedStyle(el).backgroundColor }));
    await t.hover();
    await page.waitForTimeout(300);
    const after = await t.evaluate((el) => ({ bc: getComputedStyle(el).borderColor, bg: getComputedStyle(el).backgroundColor }));
    ok(after.bc !== before.bc && after.bg !== before.bg, 'ao passar o mouse a borda e o fundo mudam de leve (azul da marca)', { before, after });
    await page.mouse.move(5, 5);
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement?.hasAttribute('data-account-link'));
    }
    ok(reached, 'dá para chegar no botão só com o teclado (Tab)');
    ok((await t.evaluate((el) => getComputedStyle(el).boxShadow)) !== 'none', 'com o teclado o botão mostra o anel de foco');
    const accName = await t.evaluate((el) => el.getAttribute('aria-label') ?? el.textContent.trim());
    ok(accName === 'Login' && /conta/i.test((await t.getAttribute('title')) ?? ''), 'nome acessível = o texto visível ("Login", exigência WCAG 2.5.3) e a dica explica "entrar ou criar conta"', accName);
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 3. o clique abre o fluxo de entrada existente; criar conta e confirmar o e-mail a partir dele');
  const email = 'maria.login@exemplo.com';
  // Login da conta de teste pela API, nos dois passos (senha → código do e-mail → sessão); devolve a resposta do segundo passo.
  const apiLogin = async (ctx) => {
    const first = await ctx.request.post(BASE + '/api/account/login', { data: { email, password: 'maria-senha-123' } });
    if (first.status() !== 202) return first;
    return ctx.request.post(BASE + '/api/account/login/code', { data: { code: await latestLoginCode(email) } });
  };
  let cookies = [];
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await link(page).click();
    await page.waitForURL('**/conta');
    ok(new URL(page.url()).pathname === '/conta' && new URL(page.url()).search === '', 'Login leva a /conta (a mesma tela de entrada do site)');
    ok((await page.getByRole('tab', { name: 'Entrar' }).getAttribute('aria-selected')) === 'true', 'abre na aba "Entrar"');
    ok((await page.getByRole('tab', { name: 'Criar conta' }).count()) === 1, 'a opção de criar conta continua lá');
    ok((await page.getByLabel('E-mail *').count()) === 1 && (await page.getByLabel('Senha *').count()) === 1, 'formulário de login existente (e-mail e senha)');
    // validação e mensagem de erro existentes
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    ok(/Confira o e-mail/.test(await page.innerText('body')), 'as validações existentes continuam (e-mail vazio é barrado)');
    await page.getByLabel('E-mail *').fill('ninguem@exemplo.com');
    await page.getByLabel('Senha *').fill('senha-errada-123');
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    ok(await until(async () => /e-mail ou senha|incorret|não confere/i.test(await page.innerText('body'))), 'senha/conta errada mostra a mensagem de erro existente', (await page.innerText('body')).slice(0, 200));
    // criar conta
    await page.getByRole('tab', { name: 'Criar conta' }).click();
    await page.getByLabel('Nome *').fill('Maria Login');
    await page.getByLabel('Telefone / WhatsApp *').fill('34988887777');
    await page.getByLabel('E-mail *').fill(email);
    await page.getByLabel('Senha *').fill('maria-senha-123');
    await page.getByRole('button', { name: /Criar conta e receber o código/ }).click();
    await page.waitForSelector('text=Confirme seu e-mail');
    ok(true, 'criar conta continua pedindo a confirmação do e-mail (a conta nasce pendente)');
    ok(psql(`select status from customers where email='${email}'`) === 'pending_verification', 'banco: conta pendente até confirmar');
    ok((await (await fetch(BASE + '/api/account/me')).json()).customer === null, 'sem sessão enquanto o e-mail não é confirmado');
    const mail = await nextMail(email);
    ok(!!mail, 'o e-mail com o código chegou');
    const code = /\b(\d{6})\b/.exec(mail.text)[1];
    await page.getByLabel('Código de confirmação').fill(code);
    await page.getByRole('button', { name: 'Confirmar e-mail' }).click();
    // O login pede o código de acesso (outro e-mail, já a caminho): a tela do código aparece direto, sem voltar ao formulário.
    await page.getByLabel('Código de acesso').waitFor();
    ok(/Confirme que é você/.test(await page.innerText('body')) && /E-mail confirmado/.test(await page.innerText('body')), 'depois de confirmar o e-mail, a tela pede o código de acesso (o login pede o código a cada entrada)');
    ok((await (await fetch(BASE + '/api/account/me')).json()).customer === null, '...e ainda não há sessão até o código ser digitado');
    await finishLogin(page, email);
    await page.waitForSelector('text=Olá, Maria!');
    ok(new URL(page.url()).pathname === '/conta', 'com o código, o cliente entra na conta (área útil)');
    ok(psql(`select status from customers where email='${email}'`) === 'active', 'banco: conta ativa');
    const body = await page.innerText('body');
    ok(/Meus pedidos/.test(body) && /Sair/.test(body) && !/Entrar na minha conta/.test(body), 'na conta: "Meus pedidos" e "Sair", e o formulário de login não aparece de novo');
    cookies = await ctx.cookies();
    // De volta ao cardápio: "Minha conta".
    await page.getByRole('link', { name: 'Fazer um pedido' }).click();
    await page.waitForURL('**/bebidas');
    await link(page).waitFor();
    ok((await link(page).getAttribute('data-account-link')) === 'in' && /Minha conta/.test(await link(page).innerText()), 'já logado, o botão vira "Minha conta"');
    ok((await link(page).getAttribute('aria-label')) === 'Minha conta', '...com o nome acessível "Minha conta"');
    // a sessão continua depois de recarregar e de navegar
    await page.reload({ waitUntil: 'networkidle' });
    await link(page).waitFor();
    ok((await link(page).getAttribute('data-account-link')) === 'in', 'a sessão continua depois de recarregar a página');
    // clicar em "Minha conta": cai na conta, sem pedir senha
    await link(page).click();
    await page.waitForURL('**/conta');
    ok(await until(async () => /Olá, Maria!/.test(await page.innerText('body'))), '"Minha conta" abre a conta direto, sem pedir senha');
    ok((await page.getByLabel('Senha *').count()) === 0, 'e o formulário de login não é mostrado a quem já tem sessão');
    await page.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
    ok(!/Entrar na minha conta/.test(await page.innerText('body')) && new URL(page.url()).pathname === '/conta/pedidos', '"Meus pedidos" abre com a sessão existente');
    await page.goto(BASE + '/acompanhar-pedido', { waitUntil: 'networkidle' });
    ok(new URL(page.url()).pathname === '/acompanhar-pedido', '/acompanhar-pedido abre para quem está logado');
    // sair
    await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Sair' }).click();
    await page.waitForURL((u) => u.pathname === '/');
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await link(page).waitFor();
    ok((await link(page).getAttribute('data-account-link')) === 'out' && (await link(page).innerText()).trim() === 'Login', 'depois de sair, o botão volta a "Login"');
    ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, 'e o servidor não reconhece mais a sessão');
    // entrar de novo pelo botão (login de conta válida)
    await link(page).click();
    await page.waitForURL('**/conta');
    await page.getByLabel('E-mail *').fill(email);
    await page.getByLabel('Senha *').fill('maria-senha-123');
    await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await page.getByLabel('Código de acesso').waitFor();
    ok((await (await fetch(BASE + '/api/account/me')).json()).customer === null, 'entrar de novo pelo botão: a senha certa sozinha NÃO abre a conta (pede o código)');
    await finishLogin(page, email);
    await page.waitForSelector('text=Olá, Maria!');
    ok(new URL(page.url()).pathname === '/conta', 'login de conta válida pelo botão: entra e fica na conta (sem laço entre login e Bebidas)');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 4. quem já tem sessão nunca vê "Login" piscar enquanto o servidor responde');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    const r = await apiLogin(ctx);
    ok(r.ok(), 'sessão criada para o teste');
    await page.route('**/api/account/me', async (route) => {
      await wait(1500);
      await route.continue();
    });
    await page.goto(BASE + '/bebidas');
    const seen = new Set();
    const end = Date.now() + 3500;
    while (Date.now() < end) {
      const v = await page.evaluate(() => document.querySelector('[data-account-link]')?.getAttribute('data-account-link') ?? 'nenhum');
      seen.add(v);
      await wait(80);
    }
    ok(seen.has('nenhum') && seen.has('in') && !seen.has('out'), 'primeiro nada, depois "Minha conta" (nunca "Login" para quem está logado)', [...seen]);
    await ctx.close();
  }
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.route('**/api/account/me', (route) => route.abort());
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    ok(await page.locator('main h1').isVisible(), 'a página abre normalmente mesmo se a conferência da sessão falhar');
    ok((await link(page).count()) === 1 && (await link(page).getAttribute('data-account-link')) === 'out', 'e o botão leva ao login (a tela /conta decide)');
    await ctx.close();
  }
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.route('**/api/site*', (route) => route.abort());
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    ok((await link(page).count()) === 0, 'sem os dados da loja (API fora do ar e sem cópia salva) o botão não aparece');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 5. nada do resto mudou: acompanhar pedido (com e sem cadastro), carrinho e cardápio');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await link(page).waitFor();
    const before = await page.evaluate(() => ({ cats: document.querySelectorAll('[role=group][aria-label="Categorias"] button').length, items: document.querySelectorAll('section[id^="cat-"] li').length }));
    await page.getByRole('link', { name: /Acompanhar/ }).first().click();
    await page.waitForURL('**/acompanhar-pedido');
    await page.waitForSelector('text=Quero acompanhar sem cadastro', { timeout: 8000 }).catch(() => {});
    const body = await page.innerText('body');
    ok(/Já tenho uma conta/.test(body) && /Quero acompanhar sem cadastro/.test(body), 'o acompanhamento mostra as duas opções: conta e sem cadastro');
    ok((await page.getByLabel('Número do pedido').count()) === 1 && (await page.getByLabel('Código de acompanhamento').count()) === 1, 'o formulário "sem cadastro" (número + código) continua lá');
    ok((await page.getByRole('link', { name: 'Entrar na conta' }).getAttribute('href')) === '/conta?voltar=%2Fconta%2Fpedidos', 'e o "Entrar na conta" daqui segue levando aos pedidos (comportamento de antes, intacto)');
    await page.goBack();
    await page.waitForURL('**/bebidas');
    const after = await page.evaluate(() => ({ cats: document.querySelectorAll('[role=group][aria-label="Categorias"] button').length, items: document.querySelectorAll('section[id^="cat-"] li').length }));
    ok(before.items > 0 && JSON.stringify(before) === JSON.stringify(after), 'o cardápio (categorias e produtos) é o mesmo', { before, after });
    // carrinho
    await page.getByRole('button', { name: /^Adicionar/ }).first().click();
    await page.waitForTimeout(300);
    ok(/Ver pedido/.test(await page.innerText('body')), 'o carrinho continua funcionando (adicionar mostra "Ver pedido")');
    await page.getByRole('button', { name: /Ver pedido/ }).first().click().catch(() => {});
    await ctx.close();
  }
  {
    // O link "Login" é só um <a>: com o JavaScript do site ele troca de tela sem recarregar; com um clique "do meio" abre a conta em outra aba.
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await link(page).waitFor();
    const [popup] = await Promise.all([ctx.waitForEvent('page'), link(page).click({ modifiers: ['Control'] })]);
    await popup.waitForURL(/\/conta$/, { timeout: 6000 }).catch(() => {});
    ok(new URL(popup.url()).pathname === '/conta', 'Ctrl+clique abre /conta em outra aba (é um link de verdade)', popup.url());
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 5b. o botão "Início" das páginas de login/conta e de acompanhar pedido volta para a página Bebidas');
  {
    const homeOf = (page) => page.locator('header > a').first();
    const check = async (page, path, label) => {
      await page.goto(BASE + path, { waitUntil: 'networkidle' });
      await homeOf(page).waitFor({ timeout: 8000 });
      const href = await homeOf(page).evaluate((a) => new URL(a.href).pathname);
      ok((await homeOf(page).innerText()).trim() === 'Início' && href === '/bebidas', `${label}: o botão "Início" aponta para /bebidas`, href);
      const logo = await page.locator('header > a').nth(1).evaluate((a) => new URL(a.href).pathname);
      ok(logo === '/', `${label}: a logo do canto continua levando à página inicial`, logo);
    };
    // visitante
    {
      const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
      await check(page, '/conta', 'visitante, tela de login (/conta)');
      await check(page, '/acompanhar-pedido', 'visitante, acompanhar pedido (/acompanhar-pedido)');
      await check(page, '/acompanhar-pedido/ABCDEFGHIJKLMNOPQRSTUVWXYZ123456', 'visitante, link de pedido inválido');
      await homeOf(page).click();
      await page.waitForURL('**/bebidas');
      ok(new URL(page.url()).pathname === '/bebidas', 'tocar em "Início" leva à página Bebidas');
      await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
      await homeOf(page).click();
      await page.waitForURL('**/bebidas');
      ok(await link(page).waitFor({ timeout: 8000 }).then(() => true).catch(() => false), 'e a página Bebidas abre inteira (com o botão Login)');
      await page.goto(BASE + '/privacidade', { waitUntil: 'networkidle' });
      await homeOf(page).waitFor({ timeout: 8000 });
      ok((await homeOf(page).evaluate((a) => new URL(a.href).pathname)) === '/', 'a política de privacidade (fora do login e do acompanhamento) segue voltando para a página inicial');
      await ctx.close();
    }
    // logado: as duas telas das imagens (Acompanhar pedido com a conta, e "Olá, ...!")
    {
      const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
      const r = await apiLogin(ctx);
      ok(r.ok(), 'sessão criada para o teste');
      await check(page, '/conta', 'logado, conta (Olá, ...!)');
      await check(page, '/acompanhar-pedido', 'logado, acompanhar pedido (Você entrou como ...)');
      ok(/Você entrou como/.test(await page.innerText('body')), 'a tela de acompanhar do logado é a dos pedidos da conta');
      await homeOf(page).click();
      await page.waitForURL('**/bebidas');
      ok(new URL(page.url()).pathname === '/bebidas', 'logado: tocar em "Início" também leva à página Bebidas');
      await ctx.close();
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# 6. com banners no cardápio (outra disposição no computador): sem cobrir o carrossel');
  {
    psql(`insert into banners(placement, title, image_desktop_url, active, position) values ('menu', 'Promoção de teste', '/img/hero-1.webp', true, 0);`);
    for (const [w, h] of [[1440, 900], [1024, 768]]) {
      const { ctx, page } = await newCtx(browser, { width: w, height: h });
      await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
      await link(page).waitFor();
      await page.waitForSelector('section[aria-label="Promoções"]');
      const R = { btn: await rectOf(page, '[data-account-link]'), banner: await rectOf(page, 'section[aria-label="Promoções"]'), h1: await rectOf(page, 'main h1'), status: await rectOf(page, '[data-store-info-trigger]') };
      ok(!overlaps(R.btn, R.banner) && !overlaps(R.btn, R.h1) && !overlaps(R.btn, R.status), `${w}px com banners: o botão não cobre o carrossel, o nome nem o ⓘ`, R);
      ok(R.btn.right <= R.banner.left, `${w}px com banners: fica na ponta direita da coluna da loja (antes do carrossel)`, R);
      ok(await noHScroll(page), `${w}px com banners: sem rolagem horizontal`);
      await ctx.close();
    }
    psql(`delete from banners where placement = 'menu';`);
  }

  await browser.close();
  ok(errors.length === 0, 'nenhum erro de JavaScript no console durante todo o teste', errors.slice(0, 4));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
