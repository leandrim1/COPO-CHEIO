// Login do cliente com código por e-mail, na tela (celular e computador): depois da senha certa a tela pede o código de 6 dígitos que chegou por
// e-mail (a CADA entrada); código errado, curto, vencido e bloqueado; reenviar com espera; voltar; entrar de novo logo em seguida; ir para o
// destino de `?voltar=`; e que nada sensível (senha, código) fica guardado no navegador.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-logincode.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const { finishLogin, latestLoginCode } = require('./e2e-code.cjs');
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
const PASS = 'Senha-Forte-2026!';

async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.70.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}` });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|40[0-9]|42[0-9]|50[0-9]/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}

// Cria uma conta já confirmada, pela API (o contexto guarda o cookie do cadastro, que a confirmação exige), e sem deixar sessão aberta.
async function makeAccount(ctx, name, email, phone) {
  const reg = await ctx.request.post(BASE + '/api/account/register', { data: { name, email, phone, password: PASS } });
  let code = '';
  for (let i = 0; i < 60 && !code; i++) {
    const list = await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email)}`)).json();
    code = /\b(\d{6})\b/.exec(list[list.length - 1]?.text ?? '')?.[1] ?? '';
    if (!code) await wait(120);
  }
  const ver = await ctx.request.post(BASE + '/api/account/verify-email', { data: { email, code } });
  psql(`delete from customer_login_challenges where customer_id = (select id from customers where lower(email) = '${email}')`);
  return reg.status() === 202 && ver.status() === 200;
}
const ageResend = (email) => psql(`update customer_login_challenges set last_sent_at = last_sent_at - interval '2 minutes' where customer_id = (select id from customers where lower(email) = '${email}')`);
const loginMails = async (email) => (await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email)}`)).json()).filter((m) => /código para entrar/.test(m.subject));
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function fillLogin(page, email, password = PASS) {
  await page.getByLabel('E-mail *').fill(email);
  await page.getByLabel('Senha *').fill(password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
}
const codeForm = (page) => page.locator('[data-login-code-form]');

async function run(browser, label, viewport, tag) {
  console.log(`# ${label}`);
  const { ctx, page } = await newCtx(browser, viewport);
  // O relógio da página anda sozinho, mas dá para adiantar: a contagem de 60 s do "Reenviar código" não precisa esperar 60 s de verdade.
  await page.clock.install();
  const email = `${tag}.logincode@exemplo.com`;
  ok(await makeAccount(ctx, `Cliente ${tag}`, email, `3498${String(1000000 + ipN).slice(-7)}`), `${label}: conta de teste criada e confirmada`);

  // ---- 1. a senha certa leva à tela do código ----------------------------------------------------------------------------------------
  await page.goto(BASE + '/conta?voltar=%2Fbebidas', { waitUntil: 'networkidle' });
  await fillLogin(page, email);
  await page.getByLabel('Código de acesso').waitFor();
  const text = await page.innerText('body');
  ok(/Confirme que é você/.test(text) && /código de 6 dígitos/.test(text), `${label}: depois da senha certa a tela pede o código de acesso`);
  ok(new RegExp(`${email[0]}\\*+@exemplo\\.com`).test(text) && !text.includes(email), `${label}: o e-mail aparece mascarado (nunca inteiro)`, text.slice(0, 300));
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: ainda não há sessão (a senha sozinha não entra)`);
  const field = page.getByLabel('Código de acesso');
  ok((await field.getAttribute('autocomplete')) === 'one-time-code' && (await field.getAttribute('inputmode')) === 'numeric', `${label}: o campo sugere o código do SMS/e-mail e abre o teclado numérico`);
  ok(await field.evaluate((el) => el === document.activeElement), `${label}: o foco já está no campo do código`);
  ok((await page.getByLabel('Senha *').count()) === 0 && !/Senha-Forte/.test(await page.content()), `${label}: o formulário e a senha saem da tela`);
  const resend = page.getByRole('button', { name: /Reenviar código/ });
  ok((await resend.isDisabled()) && /em [01]:\d\d/.test(await resend.innerText()), `${label}: "Reenviar código" começa desativado com a contagem (60 s)`, await resend.innerText());
  ok((await page.getByRole('button', { name: 'Voltar' }).count()) === 1, `${label}: há o botão "Voltar"`);
  if (viewport.width < 1000) ok(await noHScroll(page), `${label}: a tela do código cabe no celular`);
  await page.screenshot({ path: `${SP}/logincode-${viewport.width}-1-codigo.png`, fullPage: true });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  ok(!/Senha-Forte|logincode/.test(stored), `${label}: nada de senha nem e-mail no armazenamento do navegador`, stored.slice(0, 200));
  const real = await latestLoginCode(email);

  // ---- 2. código curto e código errado ------------------------------------------------------------------------------------------------
  await field.fill('12345');
  await codeForm(page).getByRole('button', { name: 'Entrar', exact: true }).click();
  ok(await until(async () => /Digite os 6 dígitos/.test(await page.innerText('body'))), `${label}: código curto: pede os 6 dígitos (sem ir ao servidor)`);
  await field.fill(wrongOf(real));
  await field.press('Enter');
  ok(await until(async () => /Código incorreto ou expirado/.test(await page.locator('[role=alert]').first().innerText())), `${label}: código errado (Enter envia): mensagem em português`);
  ok((await field.inputValue()) === '' && (await field.evaluate((el) => el === document.activeElement)), `${label}: o campo é limpo e o foco volta nele`);
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: continua sem sessão`);
  ok(await page.locator('[role=alert]').first().isVisible(), `${label}: o erro é anunciado (role=alert)`);

  // ---- 3. reenviar ----------------------------------------------------------------------------------------------------------------------
  await page.clock.fastForward(61000);
  ok(await until(async () => !(await resend.isDisabled())), `${label}: passados 60 s a tela libera "Reenviar código"`, await resend.innerText());
  await resend.click();
  ok(await until(async () => /Aguarde \d+ segundo/.test(await page.innerText('body'))), `${label}: o servidor ainda segura o reenvio (pedido de verdade com menos de 60 s): mensagem de espera`);
  ok((await loginMails(email)).length === 1, `${label}: e nenhum e-mail novo saiu`);
  ageResend(email);
  await page.clock.fastForward(61000);
  await until(async () => !(await resend.isDisabled()));
  await resend.click();
  ok(await until(async () => /Enviamos um novo código/.test(await page.innerText('body'))), `${label}: depois de 60 s o reenvio funciona e a tela avisa`);
  ok(await until(async () => (await loginMails(email)).length === 2), `${label}: chegou o e-mail novo`);
  ok((await resend.isDisabled()) && /em [01]:\d\d/.test(await resend.innerText()), `${label}: a contagem recomeça depois do reenvio`);
  const fresh = await latestLoginCode(email);
  await page.screenshot({ path: `${SP}/logincode-${viewport.width}-2-reenviado.png`, fullPage: true });

  // ---- 4. voltar e entrar de novo logo em seguida (mesmo navegador: não manda outro e-mail) --------------------------------------
  await page.getByRole('button', { name: 'Voltar' }).click();
  await page.getByLabel('Senha *').waitFor();
  ok((await page.getByLabel('E-mail *').inputValue()) === email && (await page.getByLabel('Senha *').inputValue()) === '', `${label}: "Voltar" devolve o e-mail e deixa a senha em branco`);
  ok(!(await page.locator('[role=alert]').count()), `${label}: ...sem mensagem de erro`);
  await page.getByLabel('Senha *').fill(PASS);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.getByLabel('Código de acesso').waitFor();
  ok((await loginMails(email)).length === 2, `${label}: entrar de novo logo em seguida NÃO manda outro e-mail (o código enviado continua valendo)`);
  ok(/em [01]:\d\d/.test(await page.getByRole('button', { name: /Reenviar código/ }).innerText()), `${label}: e a espera de reenvio continua contando`);

  // ---- 5. bloqueio: 5 erros devolvem ao e-mail e senha ---------------------------------------------------------------------------
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Código de acesso').fill(wrongOf(fresh));
    await codeForm(page).getByRole('button', { name: 'Entrar', exact: true }).click();
    if (i < 4) await until(async () => /Código incorreto ou expirado/.test(await page.innerText('body')));
  }
  ok(await until(async () => (await page.getByLabel('Senha *').count()) === 1), `${label}: o 5º erro leva de volta ao e-mail e à senha`);
  ok(/Muitas tentativas incorretas com este código/.test(await page.locator('[role=alert]').first().innerText()), `${label}: ...com a explicação`);
  ok((await page.getByLabel('Senha *').inputValue()) === '', `${label}: e a senha fica em branco`);
  await page.screenshot({ path: `${SP}/logincode-${viewport.width}-3-bloqueado.png`, fullPage: true });

  // ---- 6. desafio vencido -----------------------------------------------------------------------------------------------------------
  await page.getByLabel('Senha *').fill(PASS);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.getByLabel('Código de acesso').waitFor();
  const third = await latestLoginCode(email);
  ok((await loginMails(email)).length === 3, `${label}: depois do bloqueio, a senha de novo abre um desafio novo (e-mail novo)`);
  psql(`update customer_login_challenges set expires_at = now() - interval '1 second' where customer_id = (select id from customers where lower(email) = '${email}')`);
  await page.getByLabel('Código de acesso').fill(third);
  await codeForm(page).getByRole('button', { name: 'Entrar', exact: true }).click();
  ok(await until(async () => /Código incorreto ou expirado/.test(await page.locator('[role=alert]').first().innerText())), `${label}: desafio vencido: mesmo com o código certo não entra (a mensagem é a mesma de código errado)`);
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: e continua sem sessão`);
  await page.clock.fastForward(61000);
  await until(async () => !(await page.getByRole('button', { name: /Reenviar código/ }).isDisabled()));
  await page.getByRole('button', { name: /Reenviar código/ }).click();
  ok(await until(async () => (await page.getByLabel('Senha *').count()) === 1 && /tempo para digitar o código acabou/.test(await page.locator('[role=alert]').first().innerText())), `${label}: pedir outro código num desafio vencido volta ao e-mail e à senha, explicando`);

  // ---- 7. entrar de verdade e ir para o destino de ?voltar= -------------------------------------------------------------------------
  await page.getByLabel('Senha *').fill(PASS);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(page, email);
  await page.waitForURL('**/bebidas');
  ok(new URL(page.url()).pathname === '/bebidas', `${label}: com o código certo, entra e vai para o destino de ?voltar= (/bebidas)`);
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer?.email === email, `${label}: o servidor reconhece a sessão`);
  const names = (await ctx.cookies()).map((c) => c.name);
  ok(names.includes('copocheio_cliente') && !names.includes('copocheio_login'), `${label}: o cookie do desafio some depois de entrar`, names);
  const cookie = (await ctx.cookies()).find((c) => c.name === 'copocheio_cliente');
  ok(cookie?.httpOnly === true && cookie?.sameSite === 'Lax', `${label}: o cookie da sessão é HttpOnly e SameSite=Lax`, cookie);
  const after = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  ok(!/Senha-Forte/.test(after), `${label}: nenhuma senha no armazenamento do navegador`, after.slice(0, 200));

  // ---- 8. sair e entrar de novo: pede outro código ---------------------------------------------------------------------------------
  await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await fillLogin(page, email);
  await page.getByLabel('Código de acesso').waitFor();
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: depois de sair, a senha certa de novo NÃO entra: pede outro código`);
  const last = await latestLoginCode(email);
  ok((await loginMails(email)).length === 5 && last !== third, `${label}: um e-mail de código por entrada (5 no total: entrada, reenvio, depois do bloqueio, depois do vencimento e depois de sair)`);
  await finishLogin(page, email);
  await page.waitForSelector('text=Olá,');
  ok(true, `${label}: e entra com o código novo`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  await run(browser, 'celular 390', { width: 390, height: 844 }, 'cel');
  await run(browser, 'computador 1280', { width: 1280, height: 800 }, 'pc');

  console.log('# erros de página');
  ok(errors.length === 0, 'nenhum erro de JavaScript nem de console nas telas', errors.slice(0, 5));
  await browser.close();
  console.log(fails ? '\nFALHOU' : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
