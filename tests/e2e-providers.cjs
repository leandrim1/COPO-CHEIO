// Cadastro e login do cliente na TELA com e-mail de qualquer provedor (celular e computador): Gmail, iCloud, Outlook, Hotmail, Yahoo e domínio próprio.
// A tela diz que qualquer provedor serve, o campo de e-mail não sofre autocorreção do celular, o código chega na caixa do endereço digitado, a conta ativa só
// com ele, o login pede outro código a cada entrada (válido por 5 minutos, com contagem), dá para corrigir o e-mail antes de concluir, e a falha de envio
// aparece com uma mensagem clara (sem abrir sessão).
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-providers.cjs
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* a tela ainda está mudando */
    }
    if (Date.now() > end) return false;
    await wait(120);
  }
}
const errors = [];
let ipN = 0;
const PASS = 'Senha-Forte-2026!';
const mailsOf = async (email) => (await fetch(`${BASE}/__mail?to=${encodeURIComponent(email)}`)).json();
const setMode = (failure) => fetch(`${BASE}/__mail/mode`, { method: 'POST', body: JSON.stringify({ failure }) });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

async function confirmCode(email) {
  let code = '';
  await until(async () => {
    const list = (await mailsOf(email)).filter((m) => /código de confirmação|confirm/i.test(m.subject));
    code = /\b(\d{6})\b/.exec(list[list.length - 1]?.text ?? '')?.[1] ?? '';
    return Boolean(code);
  });
  return code;
}

async function newCtx(browser, viewport) {
  const mobile = viewport.width < 1000;
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile });
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.71.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}` });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|40[0-9]|42[0-9]|50[0-9]/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}

const PROVIDERS = [
  ['Gmail', 'Ana.Souza@Gmail.com', 'ana.souza@gmail.com'],
  ['iCloud', 'bruno.lima@icloud.com', 'bruno.lima@icloud.com'],
  ['Outlook', 'carla_dias@outlook.com', 'carla_dias@outlook.com'],
  ['Hotmail', 'diego-m@hotmail.com', 'diego-m@hotmail.com'],
  ['Yahoo', 'elisa@yahoo.com.br', 'elisa@yahoo.com.br'],
  ['domínio próprio', 'fabio@minhaempresa.com.br', 'fabio@minhaempresa.com.br'],
];

async function run(browser, label, viewport) {
  console.log(`# ${label}`);
  const { ctx, page } = await newCtx(browser, viewport);
  const mobile = viewport.width < 1000;

  // ---- 1. A tela diz que qualquer provedor serve e o campo de e-mail é "à prova de celular" -----------------------------------------
  await page.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  const body = await page.innerText('body');
  ok(/qualquer provedor/i.test(body) && /Gmail, iCloud, Outlook, Hotmail, Yahoo/.test(body) && /não precisa ter Gmail nem instalar nenhum aplicativo/i.test(body), `${label}: o cadastro avisa que qualquer provedor serve (sem exigir Gmail nem aplicativo)`);
  const email = page.getByLabel('E-mail *');
  const attrs = await email.evaluate((el) => ({ type: el.type, inputmode: el.inputMode, autocapitalize: el.getAttribute('autocapitalize'), autocorrect: el.getAttribute('autocorrect'), spellcheck: el.spellcheck, autocomplete: el.autocomplete }));
  ok(attrs.type === 'email' && attrs.inputmode === 'email' && attrs.autocapitalize === 'none' && attrs.autocorrect === 'off' && attrs.spellcheck === false && attrs.autocomplete === 'email', `${label}: o campo de e-mail abre o teclado de e-mail, sem maiúscula nem autocorreção (iPhone/Android)`, attrs);
  await page.getByRole('tab', { name: 'Entrar' }).click();
  ok(/qualquer provedor/i.test(await page.innerText('body')), `${label}: a tela de entrar também avisa que qualquer provedor serve`);
  if (mobile) ok(await noHScroll(page), `${label}: a tela cabe no celular`);
  await page.screenshot({ path: `${SP}/providers-${viewport.width}-1-entrar.png`, fullPage: true });

  // ---- 2. Dica de erro de digitação (só sugere; qualquer provedor vale) ------------------------------------------------------------
  await page.getByRole('tab', { name: 'Criar conta' }).click();
  await email.fill('maria@gmial.com');
  await email.blur();
  const suggestion = page.locator('[data-email-suggestion]');
  ok((await suggestion.count()) === 1 && /Você quis dizer\s*maria@gmail\.com/.test(await suggestion.innerText()), `${label}: "maria@gmial.com" sugere "maria@gmail.com"`, await suggestion.allInnerTexts());
  await suggestion.getByRole('button').click();
  ok((await email.inputValue()) === 'maria@gmail.com' && (await suggestion.count()) === 0, `${label}: tocar na sugestão corrige o campo`);
  await email.fill('maria@pequena-padaria-do-ze.com.br');
  await email.blur();
  ok((await suggestion.count()) === 0, `${label}: um domínio desconhecido NÃO recebe sugestão nenhuma (nada é barrado por ser pouco conhecido)`);

  // ---- 3. Mensagens de formato e de domínio, sem preferir provedor --------------------------------------------------------------------
  const fill = async (data) => {
    await page.getByLabel('Nome *').fill(data.name);
    await page.getByLabel('Telefone / WhatsApp *').fill(data.phone);
    await email.fill(data.email);
    await page.getByLabel('Senha *').fill(PASS);
  };
  const submit = () => page.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  for (const [typed, expected] of [
    ['maria@gmail.c', /Confira o domínio do e-mail/],
    ['maria..silva@icloud.com', /Confira a parte do e-mail antes do @/],
  ]) {
    await fill({ name: 'Teste Formato', phone: '34911110000', email: typed });
    await submit();
    await page.waitForSelector('[aria-invalid="true"]');
    const formatMsg = await page.locator('p.text-rose-300').first().innerText();
    ok(expected.test(formatMsg) && !/gmail|outlook|yahoo|hotmail|icloud/i.test(formatMsg), `${label}: "${typed}": mensagem clara, que não prefere provedor`, formatMsg);
  }
  await fill({ name: 'Teste Temporário', phone: '34911110001', email: 'x@mailinator.com' });
  await submit();
  await until(async () => /temporários ou descartáveis/.test(await page.innerText('body')));
  const disposableMsg = await page.locator('p.text-rose-300').first().innerText();
  ok(/temporários ou descartáveis/.test(disposableMsg) && /qualquer provedor/.test(disposableMsg), `${label}: e-mail temporário: explica o motivo e diz que qualquer provedor serve`, disposableMsg);

  // ---- 4. Corrigir o endereço antes de concluir -------------------------------------------------------------------------------------
  const fix = { name: 'Gilda Corrige', phone: '34922220000', typed: 'gilda@icloud.con', fixed: 'gilda@icloud.com' };
  await fill({ name: fix.name, phone: fix.phone, email: fix.typed });
  await email.blur();
  ok(/Você quis dizer\s*gilda@icloud\.com/.test(await suggestion.innerText()), `${label}: "gilda@icloud.con" sugere "gilda@icloud.com"`);
  await submit();
  await page.getByLabel('Código de confirmação').waitFor({ timeout: 15000 });
  ok(new RegExp(fix.typed.replace(/\./g, '\\.')).test(await page.innerText('body')), `${label}: a tela mostra para qual endereço o código foi enviado`);
  await page.getByRole('button', { name: 'Corrigir ou trocar o e-mail' }).click();
  await page.waitForSelector('text=Criar minha conta');
  ok((await email.inputValue()) === fix.typed && (await page.getByLabel('Nome *').inputValue()) === fix.name, `${label}: "Corrigir ou trocar o e-mail" volta com o endereço digitado (para consertar) e o resto preenchido`, await email.inputValue());
  ok(await email.evaluate((el) => el === document.activeElement), `${label}: ...com o foco no campo do e-mail`);
  await email.fill(fix.fixed);
  await submit();
  await page.getByLabel('Código de confirmação').waitFor({ timeout: 15000 });
  ok(await until(async () => (await mailsOf(fix.fixed)).length === 1), `${label}: o código novo chegou na caixa do endereço corrigido`);

  // ---- 5. Provedores diferentes: cadastro → código → login com código → sair → entrar de novo ------------------------------------------
  for (const [name, , saved] of viewport.width < 1000 ? PROVIDERS.slice(0, 3) : PROVIDERS.slice(2)) {
    const person = { name: `${name} Cliente`, phone: `3497${String(3000000 + ++ipN).slice(-7)}` };
    const tag = `${label}/${name}`;
    // Endereço próprio de cada rodada, digitado com a primeira letra maiúscula (o celular costuma fazer isso); o sistema guarda em minúsculas.
    const email2 = `${saved.split('@')[0]}.${viewport.width}@${saved.split('@')[1]}`;
    const typed2 = email2.replace(/^./, (c) => c.toUpperCase());
    const p = await newCtx(browser, viewport);
    const pg = p.page;
    await pg.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
    await pg.getByLabel('Nome *').fill(person.name);
    await pg.getByLabel('Telefone / WhatsApp *').fill(person.phone);
    await pg.getByLabel('E-mail *').fill(typed2);
    await pg.getByLabel('Senha *').fill(PASS);
    await pg.getByRole('button', { name: /Criar conta e receber o código/ }).click();
    await pg.getByLabel('Código de confirmação').waitFor({ timeout: 15000 });
    const code = await confirmCode(email2);
    ok(/^\d{6}$/.test(code), `${tag}: o código de confirmação chegou na caixa de ${email2}`);
    // código errado: mensagem clara; certo: conta ativa e já segue para o código de acesso
    await pg.getByLabel('Código de confirmação').fill(wrongOf(code));
    await pg.getByRole('button', { name: 'Confirmar e-mail' }).click();
    await pg.waitForSelector('[role=alert]');
    ok(/Código incorreto ou expirado/.test(await pg.locator('[role=alert]').first().innerText()), `${tag}: código errado: "incorreto ou expirado", sem ativar`);
    await pg.getByLabel('Código de confirmação').fill(code);
    await pg.getByRole('button', { name: 'Confirmar e-mail' }).click();
    await pg.getByLabel('Código de acesso').waitFor({ timeout: 15000 });
    const notice = await pg.innerText('body');
    ok(/E-mail confirmado!/.test(notice) && new RegExp(`${email2[0]}\\*+@${email2.split('@')[1].replace(/\./g, '\\.')}`).test(notice) && !notice.includes(email2), `${tag}: conta ativada; o código de acesso é pedido e o endereço aparece mascarado`, notice.slice(0, 280));
    ok(/restam [0-5]:\d\d/.test(notice) && /5 minutos/.test(notice), `${tag}: a tela mostra a validade (5 minutos) com a contagem do que resta`, notice.match(/O código vale[^.]*\./)?.[0]);
    await finishLogin(pg, email2);
    await pg.waitForSelector('text=Olá,');
    ok(true, `${tag}: com o código de acesso a sessão abre`);
    // sair e entrar de novo: outro código
    await pg.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await pg.getByRole('button', { name: 'Sair' }).click();
    await pg.waitForURL((u) => u.pathname === '/');
    await pg.goto(BASE + '/conta', { waitUntil: 'networkidle' });
    await pg.getByLabel('E-mail *').fill(typed2.toUpperCase());
    await pg.getByLabel('Senha *').fill(PASS);
    await pg.getByRole('button', { name: 'Entrar', exact: true }).last().click();
    await pg.getByLabel('Código de acesso').waitFor({ timeout: 15000 });
    ok((await (await p.ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${tag}: depois de sair, a senha certa NÃO entra sozinha (pede outro código)`);
    const logins = (await mailsOf(email2)).filter((m) => /código para entrar/.test(m.subject));
    ok(logins.length === 2, `${tag}: um e-mail de código por entrada (2 no total)`, logins.length);
    await finishLogin(pg, email2);
    await pg.waitForSelector('text=Olá,');
    ok(true, `${tag}: entrou de novo com o código novo`);
    await p.ctx.close();
  }

  // ---- 6. Código de login: validade de 5 minutos, vencido, reenvio --------------------------------------------------------------------
  const accountEmail = `validade.${viewport.width}@yahoo.com`;
  {
    const r = await ctx.request.post(BASE + '/api/account/register', { data: { name: 'Validade Cliente', email: accountEmail, phone: `3496${String(4000000 + ++ipN).slice(-7)}`, password: PASS } });
    const code = await confirmCode(accountEmail);
    const v = await ctx.request.post(BASE + '/api/account/verify-email', { data: { email: accountEmail, code } });
    ok(r.status() === 202 && v.status() === 200, `${label}: conta de teste (Yahoo) criada e ativada`);
    psql(`delete from customer_login_challenges where customer_id = (select id from customers where lower(email) = '${accountEmail}')`);
  }
  await page.clock.install();
  await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await page.getByLabel('E-mail *').fill(accountEmail);
  await page.getByLabel('Senha *').fill(PASS);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.getByLabel('Código de acesso').waitFor({ timeout: 15000 });
  ok(/vale por 5 minutos \(restam [45]:\d\d\)/.test(await page.innerText('body')), `${label}: login: "O código vale por 5 minutos (restam 4:5x)"`, (await page.innerText('body')).match(/O código vale[^.]*\./)?.[0]);
  const oldCode = await latestLoginCode(accountEmail);
  // passaram 5 minutos: o servidor vence o código e a tela avisa que expirou (e o código antigo é recusado)
  psql(`update customer_login_challenges set code_expires_at = now() - interval '1 second', last_sent_at = last_sent_at - interval '2 minutes' where customer_id = (select id from customers where lower(email) = '${accountEmail}') and used_at is null`);
  await page.clock.fastForward(5 * 60 * 1000 + 2000);
  ok(await until(async () => /Este código expirou/.test(await page.innerText('body'))), `${label}: passados os 5 minutos a tela avisa "Este código expirou"`);
  await page.getByLabel('Código de acesso').fill(oldCode);
  await page.locator('[data-login-code-form]').getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.waitForSelector('[role=alert]');
  ok(/expirou/.test(await page.locator('[role=alert]').first().innerText()) && (await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: o código vencido é recusado com a mensagem "expirou" (nenhuma sessão)`);
  await page.screenshot({ path: `${SP}/providers-${viewport.width}-2-expirou.png`, fullPage: true });
  const resend = page.getByRole('button', { name: /Reenviar código/ });
  await until(async () => !(await resend.isDisabled()));
  await resend.click();
  ok(await until(async () => (await mailsOf(accountEmail)).filter((m) => /código para entrar/.test(m.subject)).length === 2), `${label}: "Reenviar código" manda um código novo para o mesmo endereço`);
  ok(await until(async () => /restam [45]:\d\d/.test(await page.innerText('body'))), `${label}: a contagem da validade recomeça (5 minutos)`, (await page.innerText('body')).match(/O código vale[^.]*\.|Este código expirou[^.]*\./)?.[0]);
  await finishLogin(page, accountEmail);
  await page.waitForSelector('text=Olá,');
  ok(true, `${label}: com o código novo a sessão abre`);

  // ---- 7. Falha no envio: mensagem clara, nada de sessão ------------------------------------------------------------------------------
  await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Sair' }).click();
  await page.waitForURL((u) => u.pathname === '/');
  await setMode('down');
  await page.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await page.getByLabel('E-mail *').fill(accountEmail);
  await page.getByLabel('Senha *').fill(PASS);
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.waitForSelector('[role=alert]');
  await setMode(null);
  const failure = await page.locator('[role=alert]').first().innerText();
  ok(/Não conseguimos enviar o e-mail agora/.test(failure) && (await page.getByLabel('Código de acesso').count()) === 0, `${label}: servidor de e-mail fora do ar: "Não conseguimos enviar o e-mail agora" e a tela do código NÃO abre`, failure);
  ok((await (await ctx.request.get(BASE + '/api/account/me')).json()).customer === null, `${label}: ...e nenhuma sessão foi aberta`);
  await page.screenshot({ path: `${SP}/providers-${viewport.width}-3-falha.png`, fullPage: true });
  await page.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await page.getByLabel('Código de acesso').waitFor({ timeout: 15000 });
  ok(true, `${label}: passada a falha, tentar de novo funciona e a tela do código abre`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  await run(browser, 'celular 390', { width: 390, height: 844 });
  await run(browser, 'computador 1280', { width: 1280, height: 800 });
  await browser.close();
  ok(errors.length === 0, 'nenhum erro no console do navegador', errors.slice(0, 5));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH ' + (e?.stack ?? e));
  process.exit(2);
});
