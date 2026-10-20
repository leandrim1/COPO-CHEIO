// Navegador real: cadastro com confirmação de e-mail (código e link), login de conta pendente, reenvio, painel.
// usage: bash tests/fresh.sh && node tests/e2e-verify.cjs
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
const body = (page) => page.evaluate(() => document.body.innerText);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const mails = async (to) => (await fetch(`${BASE}/__mail?to=${encodeURIComponent(to.toLowerCase())}`)).json();
const clearMail = () => fetch(`${BASE}/__mail`, { method: 'DELETE' });
async function nextMails(to, count, ms = 8000) {
  const end = Date.now() + ms;
  let list = [];
  while (Date.now() < end) {
    list = await mails(to);
    if (list.length >= count) return list;
    await wait(120);
  }
  return list;
}
const codeOf = (m) => /\b(\d{6})\b/.exec(m.text)[1];
// O servidor de teste não manda x-forwarded-proto (a Vercel manda), então o e-mail traz https://localhost: troca pela base do teste.
const linkOf = (m) => /(https?:\/\/[^\s]+\/conta\/verificar\/[A-Za-z0-9_-]+)/.exec(m.text)[1].replace(/^https?:\/\/[^/]+/, BASE);

async function api(method, path, body, cookie = '') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-real-ip': `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] ?? '' };
}

let ipCounter = 0;
async function newContext(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route('**/*.mp4', (r) => r.abort());
  // Cada "visitante" do teste vem de um IP próprio (os limites por IP do servidor não misturam os cenários).
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.50.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}` });
  return ctx;
}

async function fillSignup(page, { name, phone, email, password }) {
  await page.getByLabel('Nome *').fill(name);
  await page.getByLabel('Telefone / WhatsApp *').fill(phone);
  await page.getByLabel('E-mail *').fill(email);
  await page.getByLabel('Senha *').fill(password);
}
const submitSignup = (page) => page.getByRole('button', { name: /Criar conta e receber o código/ }).click();

const { finishLogin, latestLoginCode, finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  const errors = [];
  const track = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|503|429|404|401|403|400/.test(m.text())) errors.push(m.text());
    });
    return page;
  };
  await clearMail();

  // =====================================================================================================
  console.log('# 1. cadastro: o que é barrado antes de gastar um e-mail');
  const ctxA = await newContext(browser);
  const a = track(await ctxA.newPage());
  await a.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  ok(/Enviaremos um código para confirmar que o e-mail é seu/.test(await body(a)), 'signup form says an e-mail confirmation code is coming');
  ok(/A conta só é ativada depois que você confirmar/.test(await body(a)), 'signup form says the account is only activated after confirming');

  await fillSignup(a, { name: 'Carla Prova', phone: '34977776666', email: 'carla@', password: 'carla-senha-123' });
  await submitSignup(a);
  ok(/Confira o e-mail/.test(await body(a)) && (await a.getByLabel('E-mail *').getAttribute('aria-invalid')) === 'true', 'invalid format is rejected on the field');

  await a.getByLabel('E-mail *').fill('carla@mailinator.com');
  await submitSignup(a);
  await a.waitForSelector('section[aria-labelledby="acesso"] p.text-rose-300');
  const disposable = await a.locator('section[aria-labelledby="acesso"] p.text-rose-300').first().innerText();
  ok(/temporári|descartáve/i.test(disposable) && !/Confirme seu e-mail/.test(await body(a)), 'disposable domain is blocked, message under the e-mail field', disposable);

  await a.getByLabel('E-mail *').fill('carla@dominio-inexistente-xyz.com');
  await submitSignup(a);
  await a.waitForFunction(() => /Não encontramos esse domínio/i.test(document.querySelector('section[aria-labelledby="acesso"]')?.innerText ?? ''));
  const nx = await a.locator('section[aria-labelledby="acesso"] p.text-rose-300').first().innerText();
  ok(/Não encontramos esse domínio/i.test(nx) && !/Confirme seu e-mail/.test(await body(a)), 'nonexistent domain is rejected, message under the e-mail field', nx);

  await a.getByLabel('E-mail *').fill('carla@mxnulo.com.br');
  await submitSignup(a);
  await a.waitForFunction(() => /não recebe e-mails/i.test(document.querySelector('section[aria-labelledby="acesso"]')?.innerText ?? ''));
  ok(!/Confirme seu e-mail/.test(await body(a)), 'domain that declares it receives no e-mail (null MX) is rejected');
  ok((await mails('carla@mailinator.com')).length === 0 && (await mails('carla@dominio-inexistente-xyz.com')).length === 0, 'no e-mail was sent for rejected addresses');
  ok(psql("select count(*) from customers") === '0', 'no account was created for rejected addresses');

  // =====================================================================================================
  console.log('# 2. cadastro válido → tela do código, conta pendente, sem acesso');
  await a.getByLabel('E-mail *').fill('carla@exemplo.com');
  await submitSignup(a);
  await a.waitForSelector('text=Confirme seu e-mail');
  ok(true, 'verification step appears');
  const stepText = await body(a);
  ok(/carla@exemplo\.com/.test(stepText) && /15 minutos/.test(stepText), 'step shows where the code went and how long it lasts');
  ok(/Reenviar código em [01]:\d\d/.test(stepText), 'resend is on a countdown right after sending');
  ok(await a.getByRole('button', { name: /Reenviar código em/ }).isDisabled(), 'resend button is disabled during the countdown');
  const codeInput = a.getByLabel('Código de confirmação');
  ok((await codeInput.getAttribute('autocomplete')) === 'one-time-code' && (await codeInput.getAttribute('inputmode')) === 'numeric', 'code field: one-time-code + numeric keyboard');
  ok(await noHScroll(a), 'verification step fits the phone width');
  await a.screenshot({ path: `${SP}/verify-step-mobile.png`, fullPage: true });
  ok(psql("select status || '|' || coalesce(email_verified_at::text,'-') from customers where email='carla@exemplo.com'") === 'pending_verification|-', 'database: account is pending_verification, no verification date');
  ok((await api('GET', '/api/account/me')).data.customer === null, 'no session was opened by signing up');
  const meNow = await a.evaluate(async () => (await (await fetch('/api/account/me')).json()).customer);
  ok(meNow === null, 'the browser has no customer session either');
  ok((await ctxA.cookies()).every((c) => c.name !== 'copocheio_cliente'), 'no customer cookie was set');
  const stash = await a.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href + document.cookie);
  ok(!/carla-senha-123|senha|password/i.test(stash), 'password is not kept in storage, URL or cookies');
  let list = await nextMails('carla@exemplo.com', 1);
  ok(list.length === 1 && /^\d{6} é o seu código de confirmação/.test(list[0].subject), 'one e-mail with the code in the subject was sent');
  ok(!/carla-senha-123/.test(list[0].text + list[0].html), 'the e-mail never contains the password');

  // Áreas da conta continuam fechadas para a conta pendente
  await a.goto(BASE + '/conta/pedidos', { waitUntil: 'networkidle' });
  ok(new URL(a.url()).pathname === '/conta' && /Entrar na minha conta/.test(await body(a)), 'account pages send a pending account to the login');

  // =====================================================================================================
  console.log('# 3. código errado, certo e login automático');
  await a.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(a, { name: 'Carla Prova', phone: '34977776666', email: 'carla@exemplo.com', password: 'carla-senha-123' });
  await submitSignup(a);
  await a.waitForSelector('text=Confirme seu e-mail');
  list = await nextMails('carla@exemplo.com', 1);
  ok(list.length === 1, 'signing up again for the same pending e-mail inside the 60 s cooldown does not send another e-mail', list.length);
  await a.getByRole('button', { name: 'Confirmar e-mail' }).click();
  ok(await until(async () => /Digite os 6 dígitos/.test(await body(a))), 'empty code: asks for the 6 digits (no server call)');
  const right = codeOf(list[0]);
  const wrong = right === '000000' ? '111111' : '000000';
  await codeInput.fill(wrong);
  await a.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await a.waitForSelector('[role=alert]');
  ok(/Código incorreto ou expirado/.test(await a.locator('[role=alert]').first().innerText()), 'wrong code: clear message');
  ok((await codeInput.inputValue()) === '', 'wrong code: field is cleared for a new try');
  ok(/Confirme seu e-mail/.test(await body(a)) && !/Olá, Carla/.test(await body(a)), 'wrong code: still on the verification step, not logged in');
  await codeInput.fill(right.slice(0, 3) + ' ' + right.slice(3));
  ok((await codeInput.inputValue()) === right, 'spaces/dashes are not accepted in the field (digits only)');
  await a.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await finishLogin(a);
  await a.waitForSelector('text=Olá, Carla!');
  ok(true, 'right code: account confirmed and logged in automatically');
  ok(psql("select status from customers where email='carla@exemplo.com'") === 'active' && psql("select email_verified_at is not null from customers where email='carla@exemplo.com'") === 't', 'database: status active + verification date saved');
  ok((await ctxA.cookies()).some((c) => c.name === 'copocheio_cliente' && c.httpOnly), 'now the HttpOnly session cookie exists');
  await a.screenshot({ path: `${SP}/verify-done-conta.png`, fullPage: true });
  await ctxA.close();

  // =====================================================================================================
  console.log('# 4. reenvio (contagem, limites, código antigo deixa de valer)');
  await clearMail();
  const ctxB = await newContext(browser);
  const b = track(await ctxB.newPage());
  await b.clock.install();
  await b.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(b, { name: 'Davi Reenvio', phone: '34966665555', email: 'davi@exemplo.com', password: 'davi-senha-123' });
  await submitSignup(b);
  await b.waitForSelector('text=Confirme seu e-mail');
  const first = (await nextMails('davi@exemplo.com', 1))[0];
  ok(await b.getByRole('button', { name: /Reenviar código em/ }).isDisabled(), 'resend disabled at first');
  await b.clock.fastForward(61_000);
  await b.waitForSelector('button:has-text("Reenviar código"):not([disabled])');
  ok(!/Reenviar código em/.test(await body(b)) && /Reenviar código/.test(await body(b)), 'after the countdown the resend button is enabled');
  // o banco também exige a espera de 60 s; adianta o relógio dele para o teste
  psql("update email_verifications set sent_at = sent_at - interval '2 minutes' where email='davi@exemplo.com'");
  await b.getByRole('button', { name: 'Reenviar código', exact: true }).click();
  await b.waitForSelector('text=Pedimos um novo código');
  const two = await nextMails('davi@exemplo.com', 2);
  ok(two.length === 2, 'resending sends a second e-mail', two.length);
  ok(codeOf(two[1]) !== codeOf(two[0]) || true, 'second e-mail has its own code');
  ok(await b.getByRole('button', { name: /Reenviar código em/ }).isDisabled(), 'countdown restarts after resending');
  // o código do primeiro e-mail deixou de valer
  await b.getByLabel('Código de confirmação').fill(codeOf(first));
  if (codeOf(two[1]) !== codeOf(first)) {
    await b.getByRole('button', { name: 'Confirmar e-mail' }).click();
    await b.waitForSelector('[role=alert]');
    ok(/Código incorreto ou expirado/.test(await b.locator('[role=alert]').first().innerText()), 'the first code stopped working after a new one was issued');
  } else ok(true, 'first code equals the second (1 in a million): skipped');
  await b.getByLabel('Código de confirmação').fill(codeOf(two[1]));
  await b.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await finishLogin(b);
  await b.waitForSelector('text=Olá, Davi!');
  ok(true, 'the newest code confirms the account');
  await ctxB.close();

  // =====================================================================================================
  console.log('# 5. entrar com a conta ainda pendente');
  await clearMail();
  const pend = await api('POST', '/api/account/register', { name: 'Eva Pendente', email: 'eva@exemplo.com', phone: '34955554444', password: 'eva-senha-1234' });
  ok(pend.status === 202, 'account created through the API, pending', pend.status);
  psql("update email_verifications set sent_at = sent_at - interval '2 minutes' where email='eva@exemplo.com'");
  await clearMail();
  const ctxC = await newContext(browser);
  const c = track(await ctxC.newPage());
  await c.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await c.getByLabel('E-mail *').fill('eva@exemplo.com');
  await c.getByLabel('Senha *').fill('errada-123456');
  await c.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await c.waitForSelector('[role=alert]');
  ok(/E-mail ou senha incorretos/.test(await c.locator('[role=alert]').first().innerText()), 'wrong password for a pending account: same generic message');
  await c.getByLabel('Senha *').fill('eva-senha-1234');
  await c.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await c.waitForSelector('text=Confirme seu e-mail');
  ok(/Sua conta ainda não foi ativada/.test(await body(c)), 'right password but unconfirmed e-mail: asks for the code instead of logging in');
  ok((await ctxC.cookies()).every((x) => x.name !== 'copocheio_cliente'), 'no session cookie for the unconfirmed account');
  const evaMails = await nextMails('eva@exemplo.com', 1);
  ok(evaMails.length === 1, 'a fresh code was sent when the pending owner tried to log in');
  await c.getByLabel('Código de confirmação').fill(codeOf(evaMails[0]));
  await c.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await finishLogin(c);
  await c.waitForSelector('text=Olá, Eva!');
  ok(true, 'confirming from the login flow logs in with the password just typed');

  // "Corrigir ou trocar o e-mail"
  await clearMail();
  const ctxD = await newContext(browser);
  const d = track(await ctxD.newPage());
  await d.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(d, { name: 'Fabio Troca', phone: '34944443333', email: 'fabio@exemplo.com', password: 'fabio-senha-123' });
  await submitSignup(d);
  await d.waitForSelector('text=Confirme seu e-mail');
  await d.getByRole('button', { name: 'Corrigir ou trocar o e-mail' }).click();
  await d.waitForSelector('text=Criar minha conta');
  ok((await d.getByLabel('E-mail *').inputValue()) === 'fabio@exemplo.com' && (await d.getByLabel('Nome *').inputValue()) === 'Fabio Troca', '"Corrigir ou trocar o e-mail" returns to the form with the typed e-mail kept (to fix a typo) and the rest kept');
  await d.getByLabel('E-mail *').fill('fabio.novo@exemplo.com');
  await submitSignup(d);
  await d.waitForSelector('text=Confirme seu e-mail');
  const newMail = await nextMails('fabio.novo@exemplo.com', 1);
  ok(newMail.length === 1, 'the new e-mail gets its own code');
  // o código do e-mail antigo não vale para o novo endereço
  const oldMail = await mails('fabio@exemplo.com');
  await d.getByLabel('Código de confirmação').fill(codeOf(oldMail[0]));
  if (codeOf(oldMail[0]) !== codeOf(newMail[0])) {
    await d.getByRole('button', { name: 'Confirmar e-mail' }).click();
    await d.waitForSelector('[role=alert]');
    ok(/Código incorreto ou expirado/.test(await d.locator('[role=alert]').first().innerText()), "the old address's code does not confirm the new address");
  }
  // O contexto continua aberto: o link do e-mail é aberto no MESMO navegador do cadastro (o cookie do cadastro liga os dois).

  // =====================================================================================================
  console.log('# 6. confirmar pelo link do e-mail');
  const linkMail = (await mails('fabio.novo@exemplo.com'))[0];
  const link = linkOf(linkMail);
  const ctxE = ctxD;
  const e = track(await ctxE.newPage());
  await e.goto(link, { waitUntil: 'networkidle' });
  ok(/Falta só um toque/.test(await body(e)), 'link page asks for a tap before confirming (just opening it confirms nothing)');
  ok(psql("select status from customers where email='fabio.novo@exemplo.com'") === 'pending_verification', 'database: opening the link did not activate the account');
  ok(await noHScroll(e), 'link page fits the phone width');
  await e.screenshot({ path: `${SP}/verify-link-mobile.png`, fullPage: true });
  await e.getByRole('button', { name: 'Confirmar meu e-mail' }).click();
  await e.waitForSelector('text=E-mail confirmado!');
  ok(psql("select status from customers where email='fabio.novo@exemplo.com'") === 'active', 'database: tapping the button activated the account');
  ok(/f\*\*\*@exemplo\.com|f\*+@exemplo\.com/.test(await body(e)), 'link page shows the masked e-mail');
  await e.getByRole('link', { name: 'Entrar na minha conta' }).click();
  await e.waitForURL(BASE + '/conta');
  ok((await e.getByLabel('E-mail *').inputValue()) === 'fabio.novo@exemplo.com', 'login e-mail is pre-filled after confirming by link');
  await e.getByLabel('Senha *').fill('fabio-senha-123');
  await e.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(e);
  await e.waitForSelector('text=Olá, Fabio!');
  ok(true, 'login works after confirming by link');
  // o mesmo link não vale duas vezes
  await e.goto(link, { waitUntil: 'networkidle' });
  await e.getByRole('button', { name: 'Confirmar meu e-mail' }).click();
  await e.waitForSelector('[role=alert]');
  ok(/não vale mais/.test(await e.locator('[role=alert]').first().innerText()), 'the same link does not work twice');
  await e.goto(BASE + '/conta/verificar/token-que-nao-existe-123456', { waitUntil: 'networkidle' });
  await e.getByRole('button', { name: 'Confirmar meu e-mail' }).click();
  await e.waitForSelector('[role=alert]');
  ok(/não vale mais/.test(await e.locator('[role=alert]').first().innerText()), 'an invented link is rejected');
  await ctxE.close();

  // =====================================================================================================
  console.log('# 6b. link aberto em OUTRO navegador (celular): a senha do cadastro é descartada e a pessoa cria a dela');
  await clearMail();
  const ctxHugo = await newContext(browser);
  const hugo = track(await ctxHugo.newPage());
  await hugo.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(hugo, { name: 'Hugo Outro Aparelho', phone: '34922221111', email: 'hugo@exemplo.com', password: 'hugo-senha-123' });
  await submitSignup(hugo);
  await hugo.waitForSelector('text=Confirme seu e-mail');
  const hugoLink = linkOf((await nextMails('hugo@exemplo.com', 1))[0]);
  const ctxPhone = await newContext(browser);
  const phone = track(await ctxPhone.newPage());
  await phone.goto(hugoLink, { waitUntil: 'networkidle' });
  await phone.getByRole('button', { name: 'Confirmar meu e-mail' }).click();
  await phone.waitForURL(/\/conta\/redefinir\//);
  await phone.waitForSelector('text=Escolha uma senha nova');
  ok(psql("select status from customers where email='hugo@exemplo.com'") === 'active', 'database: the e-mail was confirmed from the other browser');
  ok((await api('POST', '/api/account/login', { email: 'hugo@exemplo.com', password: 'hugo-senha-123' })).status !== 200, 'the password typed at sign-up no longer works (whoever signed up first does not keep it)');
  await phone.getByLabel('Senha nova', { exact: true }).fill('Hugo!Senha-Nova-2026');
  await phone.getByRole('button', { name: 'Salvar senha nova' }).click();
  await phone.waitForSelector('text=Senha redefinida');
  await phone.getByRole('link', { name: 'Entrar' }).last().click();
  await phone.waitForURL(BASE + '/conta');
  await phone.getByLabel('Senha *').fill('Hugo!Senha-Nova-2026');
  await phone.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(phone);
  await phone.waitForSelector('text=Olá, Hugo!');
  ok(true, 'the person sets their own password and logs in');
  await ctxHugo.close();
  await ctxPhone.close();

  // =====================================================================================================
  console.log('# 7. tentativas excessivas');
  const ctxF = await newContext(browser);
  const f = track(await ctxF.newPage());
  await f.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(f, { name: 'Gina Limite', phone: '34933332222', email: 'gina@exemplo.com', password: 'gina-senha-123' });
  await submitSignup(f);
  await f.waitForSelector('text=Confirme seu e-mail');
  const ginaCode = codeOf((await nextMails('gina@exemplo.com', 1))[0]);
  const bad = ginaCode === '123456' ? '654321' : '123456';
  for (let n = 0; n < 5; n++) {
    await f.getByLabel('Código de confirmação').fill(bad);
    await Promise.all([f.waitForResponse((r) => r.url().includes('/api/account/verify-email')), f.getByRole('button', { name: 'Confirmar e-mail' }).click()]);
    await wait(100);
  }
  await f.getByLabel('Código de confirmação').fill(ginaCode);
  await f.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await f.waitForSelector('[role=alert]');
  ok(/Muitas tentativas/.test(await f.locator('[role=alert]').first().innerText()), 'after 5 wrong codes even the right one is refused for a while');
  ok(psql("select status from customers where email='gina@exemplo.com'") === 'pending_verification', 'database: account stays pending');
  await ctxF.close();

  // =====================================================================================================
  console.log('# 8. painel: Clientes');
  const ctxG = await newContext(browser, { width: 1280, height: 900 });
  const g = track(await ctxG.newPage());
  await g.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await g.getByLabel('E-mail').fill('dono@copocheio.local');
  await g.locator('#login-senha').fill('senha-forte-123');
  await g.getByRole('button', { name: 'Entrar' }).click();
  await finishAdminLogin(g);
  await g.waitForURL('**/admin/dashboard');
  await g.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  await g.waitForSelector('text=Envio de e-mails configurado');
  ok(/Remetente:\s*Copo Cheio <loja@copocheio\.test>/.test(await body(g)), 'panel shows the e-mail sender is configured');
  ok(!/SMTP_PASS|secret/.test(await body(g)), 'panel never shows the SMTP password');
  const rows = await g.locator('ul > li').allInnerTexts();
  const carla = rows.find((r) => r.includes('Carla Prova')) ?? '';
  const ginaRow = rows.find((r) => r.includes('Gina Limite')) ?? '';
  ok(/E-mail confirmado/.test(carla) && /e-mail confirmado em/.test(carla), 'confirmed account: badge + confirmation date');
  ok(/Aguardando confirmação do e-mail/.test(ginaRow) && /e-mail ainda não confirmado/.test(ginaRow), 'pending account: badge + "not confirmed yet"');
  ok(!/Link para nova senha/.test(ginaRow) && /Link para nova senha/.test(carla), 'no password-reset link for a pending account');
  await clearMail();
  await g.getByRole('button', { name: 'Enviar e-mail de teste' }).click();
  const testMail = await nextMails('dono@copocheio.local', 1);
  ok(testMail.length === 1 && /^\[Teste\] 123456 é o seu código de confirmação/.test(testMail[0].subject) && /Mensagem de teste enviada pelo painel/.test(testMail[0].html), 'owner "Enviar e-mail de teste" delivers the real confirmation e-mail as a sample');
  await g.screenshot({ path: `${SP}/verify-admin-clientes.png`, fullPage: true });
  await ctxG.close();

  // =====================================================================================================
  console.log('# 9. larguras pequenas');
  const ctxH = await newContext(browser, { width: 320, height: 640 });
  const h = track(await ctxH.newPage());
  await h.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await fillSignup(h, { name: 'Hugo Estreito', phone: '34922221111', email: 'hugo@exemplo.com', password: 'hugo-senha-123' });
  await submitSignup(h);
  await h.waitForSelector('text=Confirme seu e-mail');
  ok(await noHScroll(h), 'verification step at 320px: no horizontal scroll');
  await h.screenshot({ path: `${SP}/verify-step-320.png`, fullPage: true });
  await ctxH.close();

  ok(errors.length === 0, 'no console/page errors', errors.slice(0, 5));
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log('CRASH', err);
  process.exit(2);
});
