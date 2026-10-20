// Login do PAINEL com código por e-mail, na tela (celular e computador): o design de sempre (logo, fundo escuro, campos com ícones, botão azul) com a segunda
// etapa do código de 6 dígitos (seis caixas, colar o código inteiro, contador de validade, reenviar com espera, voltar), código errado/bloqueado/expirado,
// e-mail fora do ar, a terceira etapa para quem usa o aplicativo autenticador, a sessão (HttpOnly, nada no armazenamento do navegador), logout e acesso direto
// ao painel sem entrar.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-adminlogin.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const { latestAdminCode, finishAdminLogin } = require('./e2e-code.cjs');
const BASE = 'http://localhost:4180';
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('fs').mkdirSync(SP, { recursive: true });
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
const PASS = 'Caixa#Segura-2026';
const OWNER = { email: 'dono@copocheio.local', password: 'senha-forte-123' };

async function newCtx(browser, viewport, extra = {}) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, ...extra });
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.90.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}` });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_|net::|Failed to load resource|40[0-9]|42[0-9]|50[0-9]/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}

const adminMails = async (email) => (await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email)}`)).json()).filter((m) => /código de acesso ao painel/.test(m.subject));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const boxes = (page) => page.locator('[data-code-box]');
const boxText = async (page) => (await boxes(page).allInnerTexts()).join('');
const field = (page) => page.locator('#login-codigo-email');

async function api(method, path, body, cookie = '') {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.91.0.1', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, data: await res.json().catch(() => null), setCookie };
}
const cookiePair = (setCookie) => setCookie.map((c) => c.split(';')[0]).join('; ');
async function ownerSession() {
  const first = await api('POST', '/api/auth/login', OWNER);
  const jar = cookiePair(first.setCookie);
  const code = await latestAdminCode(OWNER.email);
  const done = await api('POST', '/api/auth/login/code', { code }, jar);
  return cookiePair(done.setCookie.filter((c) => c.startsWith('copocheio_admin=')));
}

async function fillPassword(page, email, password) {
  await page.fill('#login-email', email);
  await page.fill('#login-senha', password);
  await page.click('button[type=submit]');
}

async function run(browser, label, viewport, tag) {
  console.log(`# ${label}`);
  const { ctx, page } = await newCtx(browser, viewport);
  await page.clock.install();
  // Administrador de teste (criado pelo owner pela API, como no painel)
  const cookie = await ownerSession();
  const email = `${tag}.tela@copocheio.local`;
  const created = await api('POST', '/api/admin/admins', { email, name: `Admin ${tag}`, password: PASS, role: 'admin' }, cookie);
  ok(created.status === 201, `${label}: administrador de teste criado`, created.data);
  const adminId = psql(`select id from admins where email = '${email}'`);
  psql(`delete from admin_email_challenges where admin_id = '${adminId}'`);
  const base = (await adminMails(email)).length;

  // ---- 1. a tela de sempre -----------------------------------------------------------------------------------------------------------
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  const text = await page.innerText('body');
  ok(/COPO\s+CHEIO/.test(text) && /Painel administrativo/.test(text) && (await page.locator('img[src="/logo-512.webp"]').count()) === 1, `${label}: a tela de login continua com a logo, o título e o fundo de sempre`);
  ok((await page.locator('#login-email').count()) === 1 && (await page.locator('#login-senha').count()) === 1 && (await page.getByRole('button', { name: 'Entrar', exact: true }).count()) === 1 && /Voltar para o site/.test(text), `${label}: campos de e-mail e senha, botão Entrar e o link para voltar ao site`);
  ok((await page.getByRole('button', { name: 'Mostrar senha' }).count()) === 1, `${label}: o botão de mostrar a senha continua lá`);
  await page.screenshot({ path: `${SP}/adminlogin-${viewport.width}-1-senha.png`, fullPage: true });

  // senha errada: mensagem genérica
  await fillPassword(page, email, 'senha-errada-123');
  ok(await until(async () => /E-mail ou senha incorretos/.test(await page.locator('[role=alert]').first().innerText())), `${label}: senha errada: a mesma mensagem genérica de sempre`);
  ok((await adminMails(email)).length === base, `${label}: ...e nenhum e-mail de código foi enviado`);
  await fillPassword(page, 'ninguem.mesmo@copocheio.local', PASS);
  ok(await until(async () => /E-mail ou senha incorretos/.test(await page.locator('[role=alert]').first().innerText())), `${label}: e-mail que não existe: a MESMA mensagem (não revela se o administrador existe)`);

  // ---- 2. senha certa: a tela do código ------------------------------------------------------------------------------------------------
  await fillPassword(page, email, PASS);
  await field(page).waitFor();
  const step = await page.innerText('body');
  ok(new RegExp(`${email[0]}\\*+@copocheio\\.local`).test(step) && !step.includes(email), `${label}: a tela diz que o código foi enviado ao e-mail, mascarado (nunca inteiro)`, step.slice(0, 300));
  ok((await boxes(page).count()) === 6, `${label}: seis caixas para o código`);
  ok(await field(page).evaluate((el) => el === document.activeElement), `${label}: o foco já está no campo do código`);
  ok((await field(page).getAttribute('autocomplete')) === 'one-time-code' && (await field(page).getAttribute('inputmode')) === 'numeric', `${label}: o campo sugere o código do e-mail/SMS e abre o teclado numérico`);
  ok((await page.locator('#login-senha').count()) === 0 && !/Caixa#Segura/.test(await page.content()), `${label}: o campo da senha sai da tela e a senha não fica na página`);
  ok((await adminMails(email)).length === base + 1, `${label}: chegou um e-mail com o código`);
  ok((await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin === null, `${label}: ainda não há sessão (a senha sozinha não entra)`);
  const timer = page.locator('[data-code-timer]');
  ok(/O código expira em [45]:\d\d/.test(await timer.innerText()), `${label}: contador de validade do código (5 minutos)`, await timer.innerText());
  const resend = page.getByRole('button', { name: /Reenviar código/ });
  ok((await resend.isDisabled()) && /em [01]:\d\d/.test(await resend.innerText()), `${label}: "Reenviar código" começa desativado com a contagem`, await resend.innerText());
  ok((await page.getByRole('button', { name: 'Voltar' }).count()) === 1 && (await page.getByRole('button', { name: 'Verificar e entrar' }).count()) === 1, `${label}: botões "Voltar" e "Verificar e entrar"`);
  ok(await noHScroll(page), `${label}: a tela do código cabe na largura (sem rolagem horizontal)`);
  const real = await latestAdminCode(email);
  await page.screenshot({ path: `${SP}/adminlogin-${viewport.width}-2-codigo.png`, fullPage: true });

  // ---- 3. digitar, colar e corrigir ------------------------------------------------------------------------------------------------------
  await page.keyboard.type('12a3');
  ok((await boxText(page)) === '123', `${label}: digitar mostra os dígitos nas caixas (letras são ignoradas)`, await boxText(page));
  await page.keyboard.press('Backspace');
  ok((await boxText(page)) === '12', `${label}: Backspace apaga o último dígito`);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  ok((await boxText(page)) === '', `${label}: dá para apagar tudo`);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }).catch(() => undefined);
  const clipboardOk = await page.evaluate(async (v) => {
    try {
      await navigator.clipboard.writeText(v);
      return true;
    } catch {
      return false;
    }
  }, '123 456 789');
  await field(page).focus();
  if (clipboardOk) await page.keyboard.press('Control+V');
  else await page.keyboard.insertText('123 456 789');
  ok((await boxText(page)) === '123456', `${label}: colar o código inteiro ("123 456 789") preenche as seis caixas com os 6 primeiros dígitos`, await boxText(page));
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');

  // ---- 4. código errado ----------------------------------------------------------------------------------------------------------------
  await field(page).fill(wrongOf(real));
  await page.keyboard.press('Enter');
  ok(await until(async () => /Código incorreto ou expirado/.test(await page.locator('[role=alert]').first().innerText())), `${label}: código errado (Enter envia): mensagem em português`);
  ok((await field(page).inputValue()) === '' && (await field(page).getAttribute('aria-invalid')) === 'true', `${label}: o campo é limpo e fica marcado como inválido`);
  ok((await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin === null, `${label}: continua sem sessão`);
  await field(page).fill('12');
  await page.keyboard.press('Enter');
  ok(await until(async () => /Digite os 6 dígitos/.test(await page.locator('[role=alert]').first().innerText())), `${label}: código curto: pede os 6 dígitos`);

  // ---- 5. validade e reenvio -----------------------------------------------------------------------------------------------------------------
  await page.clock.fastForward(61000);
  ok(await until(async () => !(await resend.isDisabled())), `${label}: passados 60 s o "Reenviar código" é liberado`);
  await resend.click();
  ok(await until(async () => /Aguarde \d+ segundo/.test(await page.locator('[role=alert]').first().innerText())), `${label}: o servidor ainda segura o reenvio (pedido de verdade com menos de 60 s): mensagem de espera`);
  ok((await adminMails(email)).length === base + 1, `${label}: e nenhum e-mail novo saiu`);
  psql(`update admin_email_challenges set last_sent_at = last_sent_at - interval '2 minutes' where admin_id = '${adminId}'`);
  await page.clock.fastForward(61000);
  await until(async () => !(await resend.isDisabled()));
  await resend.click();
  ok(await until(async () => /Enviamos um novo código/.test(await page.innerText('body'))), `${label}: depois de 60 s o reenvio funciona e a tela avisa`);
  ok(await until(async () => (await adminMails(email)).length === base + 2), `${label}: chegou o e-mail novo`);
  ok((await resend.isDisabled()) && /O código expira em [45]:\d\d/.test(await timer.innerText()), `${label}: a contagem de reenvio e a de validade recomeçam`, await timer.innerText());
  const fresh = await latestAdminCode(email);
  await page.clock.fastForward(5 * 60 * 1000 + 5000);
  ok(await until(async () => /O código expirou/.test(await timer.innerText())), `${label}: passados 5 minutos o contador avisa que o código expirou`);
  ok((await page.getByRole('button', { name: /Reenviar código/ }).count()) === 1, `${label}: ...e o "Reenviar código" continua à mão`);
  await page.screenshot({ path: `${SP}/adminlogin-${viewport.width}-3-expirou.png`, fullPage: true });
  psql(`update admin_email_challenges set code_expires_at = now() + interval '3 minutes' where admin_id = '${adminId}'`);

  // ---- 6. voltar e entrar de novo (o mesmo navegador não recebe outro e-mail) ------------------------------------------------------------------
  await page.getByRole('button', { name: 'Voltar' }).click();
  await page.locator('#login-senha').waitFor();
  ok((await page.locator('#login-email').inputValue()) === email && (await page.locator('#login-senha').inputValue()) === '', `${label}: "Voltar" devolve o e-mail e deixa a senha em branco`);
  await page.fill('#login-senha', PASS);
  await page.click('button[type=submit]');
  await field(page).waitFor();
  ok((await adminMails(email)).length === base + 2, `${label}: entrar de novo logo em seguida NÃO manda outro e-mail (o código enviado continua valendo)`);

  // ---- 7. bloqueio por 5 erros -------------------------------------------------------------------------------------------------------------------
  for (let i = 0; i < 5; i++) {
    await field(page).fill(wrongOf(fresh));
    await page.keyboard.press('Enter');
    if (i < 4) await until(async () => /Código incorreto ou expirado/.test(await page.locator('[role=alert]').first().innerText()));
  }
  ok(await until(async () => (await page.locator('#login-senha').count()) === 1), `${label}: o 5º erro leva de volta ao e-mail e à senha`);
  ok(/Muitas tentativas incorretas com este código/.test(await page.locator('[role=alert]').first().innerText()) && (await page.locator('#login-senha').inputValue()) === '', `${label}: ...com a explicação e a senha em branco`);

  // ---- 8. entrar de verdade --------------------------------------------------------------------------------------------------------------------
  await page.fill('#login-senha', PASS);
  await page.click('button[type=submit]');
  await finishAdminLogin(page, email);
  await page.waitForURL('**/admin/dashboard');
  ok(await until(async () => /Dashboard|Pedidos|Produtos/.test(await page.innerText('body'))), `${label}: com o código certo entra e vai para o painel`);
  const me = await (await ctx.request.get(BASE + '/api/auth/me')).json();
  ok(me.admin?.email === email, `${label}: o servidor reconhece a sessão`);
  const cookies = await ctx.cookies();
  const session = cookies.find((c) => c.name === 'copocheio_admin');
  ok(session?.httpOnly === true && session?.sameSite === 'Strict' && !cookies.some((c) => c.name === 'copocheio_admin_login'), `${label}: cookie da sessão HttpOnly + SameSite=Strict e o cookie do desafio some`, session);
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  ok(!/Caixa#Segura|copocheio_admin|token/i.test(stored) && !stored.includes(session?.value ?? '@@'), `${label}: nada sensível (senha, código, token) no localStorage nem no sessionStorage`, stored.slice(0, 200));
  ok(!(await page.content()).includes(session?.value ?? '@@'), `${label}: o token da sessão não aparece na página`);
  await page.screenshot({ path: `${SP}/adminlogin-${viewport.width}-4-painel.png` });

  // ---- 9. logout e acesso direto sem entrar ------------------------------------------------------------------------------------------------------
  await page.getByRole('button', { name: 'Sair' }).first().click();
  await page.waitForURL('**/admin/login');
  ok((await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin === null, `${label}: logout: a sessão deixa de valer no servidor`);
  const replay = await api('GET', '/api/admin/dashboard', undefined, `copocheio_admin=${session?.value}`);
  ok(replay.status === 401, `${label}: o cookie de antes do logout não abre mais nada (401)`);
  for (const path of ['/admin/dashboard', '/admin/pedidos', '/admin/produtos', '/admin/configuracoes', '/admin/clientes']) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForURL('**/admin/login');
    ok(new URL(page.url()).pathname === '/admin/login' && (await page.locator('#login-email').count()) === 1, `${label}: abrir ${path} sem entrar leva ao login`);
  }
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  await run(browser, 'celular 390', { width: 390, height: 844 }, 'cel');
  await run(browser, 'computador 1280', { width: 1280, height: 800 }, 'pc');

  // ---- e-mail fora do ar: sem código não há acesso --------------------------------------------------------------------------------------------
  console.log('# e-mail fora do ar');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await fetch(`${BASE}/__mail/mode`, { method: 'POST', body: JSON.stringify({ failure: 'down', delayMs: 0 }) });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await fillPassword(page, OWNER.email, OWNER.password);
    ok(await until(async () => /Tente de novo/.test(await page.locator('[role=alert]').first().innerText())), 'com o servidor de e-mail fora do ar a tela avisa para tentar de novo (e não entra)');
    ok((await page.locator('#login-senha').count()) === 1 && (await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin === null, '...continua na tela da senha e sem sessão');
    await fetch(`${BASE}/__mail/mode`, { method: 'POST', body: JSON.stringify({ failure: null, delayMs: 0 }) });
    await page.fill('#login-senha', OWNER.password);
    await page.click('button[type=submit]');
    ok(await field(page).waitFor({ timeout: 8000 }).then(() => true, () => false), 'com o e-mail de volta, a mesma tentativa pode ser repetida na hora e a tela do código aparece');
    await ctx.close();
  }

  // ---- aplicativo autenticador: terceira etapa ----------------------------------------------------------------------------------------------------
  console.log('# aplicativo autenticador (3 etapas)');
  {
    const { load } = await import('./unit/load.mjs');
    const totp = await load('server/totp.ts');
    const cookie = await ownerSession();
    const email = 'dois.fatores.tela@copocheio.local';
    await api('POST', '/api/admin/admins', { email, name: 'Dois Fatores', password: PASS, role: 'admin' }, cookie);
    // liga o aplicativo nessa conta (pela API, com uma sessão dela)
    const first = await api('POST', '/api/auth/login', { email, password: PASS });
    const jar = cookiePair(first.setCookie);
    const done = await api('POST', '/api/auth/login/code', { code: await latestAdminCode(email) }, jar);
    const mine = cookiePair(done.setCookie.filter((c) => c.startsWith('copocheio_admin=')));
    const setup = await api('POST', '/api/auth/2fa/setup', { password: PASS }, mine);
    const secret = setup.data.secret;
    const enabled = await api('POST', '/api/auth/2fa/enable', { code: totp.totpAtStep(secret, totp.stepAt(Date.now())) }, mine);
    ok(enabled.status === 200, '(preparação) o aplicativo autenticador foi ligado nessa conta', enabled.data);

    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await fillPassword(page, email, PASS);
    await field(page).waitFor();
    ok(true, 'senha certa → primeiro o código do e-mail (e não já o do aplicativo)');
    await finishAdminLogin(page, email);
    await page.locator('#login-codigo').waitFor();
    ok(/verificação em duas etapas/.test(await page.innerText('body')) && (await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin === null, 'código do e-mail certo → pede o código do APLICATIVO (ainda sem sessão)');
    ok(/Usar um código de recuperação/.test(await page.innerText('body')), '...com a opção de usar um código de recuperação');
    await page.fill('#login-codigo', totp.totpAtStep(secret, totp.stepAt(Date.now()) + 1));
    await page.getByRole('button', { name: 'Verificar e entrar' }).click();
    await page.waitForURL('**/admin/dashboard');
    ok((await (await ctx.request.get(BASE + '/api/auth/me')).json()).admin?.email === email, 'com o código do aplicativo (3ª etapa) a sessão abre e o painel aparece');
    await ctx.close();
  }

  console.log('# erros de página');
  ok(errors.length === 0, 'nenhum erro de JavaScript nem de console nas telas', errors.slice(0, 5));
  await browser.close();
  console.log(fails ? '\nFALHOU' : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
