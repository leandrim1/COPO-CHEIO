// Navegador real: recuperação de senha por e-mail (pedir o link, conferir o e-mail, criar a senha nova, entrar).
// usage: bash tests/fresh.sh && node tests/e2e-recover.cjs
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
async function nextMails(to, count, ms = 12000) {
  const end = Date.now() + ms;
  let list = [];
  while (Date.now() < end) {
    list = await mails(to);
    if (list.length >= count) return list;
    await wait(150);
  }
  return list;
}
const codeOf = (m) => /\b(\d{6})\b/.exec(m.text)[1];
const resetLinkOf = (m) => /(https?:\/\/[^\s]+\/conta\/redefinir\/[A-Za-z0-9_-]+)/.exec(m.text)[1].replace(/^https?:\/\/[^/]+/, BASE);
const resetMails = (list) => list.filter((m) => /^Redefinir sua senha/.test(m.subject));

let ipCounter = 0;
async function newContext(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route('**/*.mp4', (r) => r.abort());
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.80.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}` });
  return ctx;
}
async function api(method, p, bodyData, cookie) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-real-ip': `10.81.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) }, body: bodyData === undefined ? undefined : JSON.stringify(bodyData) });
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] ?? '' };
}
// Conta confirmada pela API (o foco aqui é a recuperação, não o cadastro).
async function verifiedAccount(name, email, password) {
  // O cookie do cadastro volta junto na confirmação, como num navegador (é ele que liga a confirmação a quem se cadastrou).
  const reg = await api('POST', '/api/account/register', { name, email, phone: '34999990000', password });
  const m = (await nextMails(email, 1))[0];
  const v = await api('POST', '/api/account/verify-email', { email, code: codeOf(m) }, reg.cookie);
  if (v.status !== 200) throw new Error('confirmação falhou ' + JSON.stringify(v));
}
const age = (email) => psql(`update customer_password_resets set sent_at = sent_at - interval '2 minutes', created_at = created_at - interval '2 minutes' where email = '${email}'`);

const { finishLogin, latestLoginCode } = require('./e2e-code.cjs');
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const track = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|503|429|404|401|403|400/.test(m.text())) errors.push(m.text());
    });
    return page;
  };
  await fetch(`${BASE}/__mail`, { method: 'DELETE' });
  await verifiedAccount('ana souza', 'ana.recupera@exemplo.com', 'senha-antiga-123');

  // =====================================================================================================
  console.log('# 1. da tela de entrada até o pedido do link');
  const ctxA = await newContext(browser);
  const a = track(await ctxA.newPage());
  await a.clock.install();
  await a.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await a.getByLabel('E-mail *').fill('ana.recupera@exemplo.com');
  await a.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await a.waitForURL(BASE + '/conta/recuperar');
  ok((await a.getByLabel('E-mail da conta').first().inputValue()) === 'ana.recupera@exemplo.com', '"Esqueci minha senha" leva o e-mail digitado para a tela de recuperação');
  const stash0 = await a.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
  ok(!/ana\.recupera/.test(stash0), 'o e-mail não vai para o endereço da página nem para o armazenamento do navegador');
  ok(/Receber o link por e-mail/.test(await body(a)) && /Não consigo acessar meu e-mail/.test(await body(a)), 'tela oferece o link por e-mail e a alternativa sem e-mail');
  await a.getByLabel('E-mail da conta').first().fill('isto-nao-e-email');
  await a.getByRole('button', { name: 'Enviar link de recuperação' }).click();
  ok(await until(async () => /Confira o e-mail/.test(await body(a)) && (await a.getByLabel('E-mail da conta').first().getAttribute('aria-invalid')) === 'true'), 'e-mail inválido: erro no campo, nada é enviado');
  ok((await mails('isto-nao-e-email')).length === 0, 'nenhum e-mail saiu para o endereço inválido');

  const t0 = Date.now();
  await a.getByLabel('E-mail da conta').first().fill('ana.recupera@exemplo.com');
  await a.getByRole('button', { name: 'Enviar link de recuperação' }).click();
  await a.waitForSelector('text=Verifique seu e-mail');
  ok(Date.now() - t0 >= 1500, 'a resposta demora o mesmo tempo com ou sem conta (não dá para descobrir quem tem cadastro)', Date.now() - t0);
  const sentText = await body(a);
  ok(/Se existir uma conta com ana\.recupera@exemplo\.com/.test(sentText) && /60 minutos/.test(sentText) && /uma vez/.test(sentText), 'mensagem diz "se existir uma conta", validade de 60 minutos e uso único');
  ok(/Reenviar link em [01]:\d\d/.test(sentText) && (await a.getByRole('button', { name: /Reenviar link em/ }).isDisabled()), 'reenvio em contagem regressiva (desabilitado)');
  ok(await noHScroll(a), 'tela "Verifique seu e-mail" cabe na largura do celular');
  await a.screenshot({ path: `${SP}/recover-sent-mobile.png`, fullPage: true });
  const first = resetMails(await nextMails('ana.recupera@exemplo.com', 2))[0];
  ok(Boolean(first) && /conta\/redefinir\/[A-Za-z0-9_-]{43}$/.test(first.text.match(/https?:\/\/[^\s]+\/conta\/redefinir\/[A-Za-z0-9_-]+/)[0]), 'o e-mail com o link de redefinição chegou (no layout da marca)');
  ok(/<h1[^>]*>Redefina sua senha<\/h1>/.test(first.html) && /Criar nova senha/.test(first.html) && /60 minutos/.test(first.text) && /<img /.test(first.html), 'e-mail: título, botão "Criar nova senha", validade e logo');

  // Conta que não existe: mesma tela, nenhum e-mail
  const ctxB = await newContext(browser);
  const b = track(await ctxB.newPage());
  await b.goto(BASE + '/conta/recuperar', { waitUntil: 'networkidle' });
  await b.getByLabel('E-mail da conta').first().fill('ninguem.tem.esta.conta@exemplo.com');
  await b.getByRole('button', { name: 'Enviar link de recuperação' }).click();
  await b.waitForSelector('text=Verifique seu e-mail');
  ok(/Se existir uma conta com ninguem\.tem\.esta\.conta@exemplo\.com/.test(await body(b)), 'e-mail sem conta: a tela é igual (nada revela que ele não existe)');
  ok((await mails('ninguem.tem.esta.conta@exemplo.com')).length === 0, '...e nenhum e-mail sai para ele');
  await b.getByRole('button', { name: 'Usar outro e-mail' }).click();
  await b.waitForSelector('text=Receber o link por e-mail');
  ok((await b.getByLabel('E-mail da conta').first().inputValue()) === '', '"Usar outro e-mail" volta ao formulário com o campo vazio');
  await ctxB.close();

  // =====================================================================================================
  console.log('# 2. reenviar o link: o anterior deixa de valer');
  await a.clock.fastForward(61_000);
  await a.waitForSelector('button:has-text("Reenviar link"):not([disabled])');
  ok(!/Reenviar link em/.test(await body(a)), 'depois da contagem o botão "Reenviar link" volta a funcionar');
  age('ana.recupera@exemplo.com'); // o banco também exige a espera de 60 s
  await a.getByRole('button', { name: 'Reenviar link', exact: true }).click();
  await a.waitForSelector('text=Pedimos um novo link');
  const second = resetMails(await nextMails('ana.recupera@exemplo.com', 3, 15000)).at(-1);
  ok(resetMails(await mails('ana.recupera@exemplo.com')).length === 2 && resetLinkOf(second) !== resetLinkOf(first), 'o reenvio manda um segundo e-mail, com outro link');
  const oldCheck = await api('POST', '/api/account/reset-check', { token: resetLinkOf(first).split('/').pop() });
  ok(oldCheck.status === 400 && oldCheck.data.code === 'invalid_link', 'o link do primeiro e-mail deixou de valer');
  await ctxA.close();

  // =====================================================================================================
  console.log('# 3. abrir o link e criar a senha nova');
  const ctxOld = await newContext(browser); // aparelho em que a Ana já estava logada
  const oldDevice = track(await ctxOld.newPage());
  await oldDevice.goto(BASE + '/conta', { waitUntil: 'networkidle' });
  await oldDevice.getByLabel('E-mail *').fill('ana.recupera@exemplo.com');
  await oldDevice.getByLabel('Senha *').fill('senha-antiga-123');
  await oldDevice.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(oldDevice);
  await oldDevice.waitForSelector('text=Olá, Ana!');

  const ctxC = await newContext(browser);
  const c = track(await ctxC.newPage());
  await c.goto(resetLinkOf(second), { waitUntil: 'networkidle' });
  await c.waitForSelector('text=Escolha uma senha nova');
  ok(/Conta a\*\*\*@exemplo\.com/.test(await body(c)), 'o link mostra para qual conta é (e-mail mascarado) antes de pedir a senha');
  ok(await noHScroll(c), 'tela da senha nova cabe na largura do celular');
  await c.screenshot({ path: `${SP}/recover-reset-mobile.png`, fullPage: true });
  await c.getByLabel('Senha nova', { exact: true }).fill('curta');
  await c.getByRole('button', { name: 'Salvar senha nova' }).click();
  ok(await until(async () => /pelo menos 8 caracteres/.test(await body(c))), 'senha curta: erro claro, o link não é gasto');
  ok((await api('POST', '/api/account/reset-check', { token: resetLinkOf(second).split('/').pop() })).status === 200, '...e o link continua valendo');
  await c.getByLabel('Senha nova', { exact: true }).fill('senha-nova-456');
  await c.getByRole('button', { name: 'Salvar senha nova' }).click();
  await c.waitForSelector('text=Senha redefinida');
  const doneText = await body(c);
  ok(/Pronto! Entre com a senha nova\./.test(doneText) && /desconectado dos aparelhos/.test(doneText), 'senha redefinida: mensagem e aviso de que os outros aparelhos foram desconectados');
  const notices = await nextMails('ana.recupera@exemplo.com', 3, 15000);
  ok(notices.some((m) => /^Sua senha foi alterada/.test(m.subject)), 'a Ana recebe um e-mail avisando que a senha foi alterada');
  // o aparelho antigo perdeu a sessão
  await oldDevice.reload({ waitUntil: 'networkidle' });
  ok(!/Olá, Ana!/.test(await body(oldDevice)) && /Entrar na minha conta/.test(await body(oldDevice)), 'o aparelho que estava logado foi desconectado');
  await c.getByRole('link', { name: 'Entrar' }).last().click();
  await c.waitForURL(BASE + '/conta');
  ok((await c.getByLabel('E-mail *').inputValue()) === 'ana.recupera@exemplo.com', 'a tela de entrada já vem com o e-mail preenchido');
  await c.getByLabel('Senha *').fill('senha-antiga-123');
  await c.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await c.waitForSelector('[role=alert]');
  ok(/E-mail ou senha incorretos/.test(await c.locator('[role=alert]').first().innerText()), 'a senha antiga não entra mais');
  await c.getByLabel('Senha *').fill('senha-nova-456');
  await c.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(c);
  await c.waitForSelector('text=Olá, Ana!');
  ok(true, 'a senha nova entra');

  // link usado / vencido: a tela avisa antes de pedir qualquer coisa
  const ctxD = await newContext(browser);
  const d = track(await ctxD.newPage());
  await d.goto(resetLinkOf(second), { waitUntil: 'networkidle' });
  await d.waitForSelector('text=Este link não vale mais');
  ok((await d.getByLabel('Senha nova', { exact: true }).count()) === 0 && /já foi usado|expirou/.test(await body(d)), 'link já usado: a tela diz que não vale mais e nem mostra o campo de senha');
  await d.getByRole('link', { name: 'Pedir um novo link' }).click();
  await d.waitForURL(BASE + '/conta/recuperar');
  ok(true, '"Pedir um novo link" leva de volta à recuperação');
  await d.goto(BASE + '/conta/redefinir/token-que-nao-existe-1234567890', { waitUntil: 'networkidle' });
  await d.waitForSelector('text=Este link não vale mais');
  ok(true, 'link inventado: mesma tela');
  // vencido de verdade (60 minutos)
  await api('POST', '/api/account/forgot-password', { email: 'ana.recupera@exemplo.com' }).catch(() => undefined);
  age('ana.recupera@exemplo.com');
  await api('POST', '/api/account/forgot-password', { email: 'ana.recupera@exemplo.com' });
  const third = resetMails(await nextMails('ana.recupera@exemplo.com', 5, 15000)).at(-1);
  psql("update customer_password_resets set expires_at = now() - interval '1 second' where used_at is null and email = 'ana.recupera@exemplo.com'");
  await d.goto(resetLinkOf(third), { waitUntil: 'networkidle' });
  await d.waitForSelector('text=Este link não vale mais');
  ok(true, 'link vencido (60 minutos): mesma tela');
  await ctxD.close();
  await ctxC.close();
  await ctxOld.close();

  // =====================================================================================================
  console.log('# 4. conta que nunca confirmou o e-mail: o link de e-mail também confirma');
  await api('POST', '/api/account/register', { name: 'Paulo Pendente', email: 'paulo.pendente@exemplo.com', phone: '34999991111', password: 'senha-do-paulo-1' });
  ok(psql("select status from customers where email = 'paulo.pendente@exemplo.com'") === 'pending_verification', 'conta de teste está pendente (sem confirmar o e-mail)');
  const ctxE = await newContext(browser);
  const e = track(await ctxE.newPage());
  await e.goto(BASE + '/conta/recuperar', { waitUntil: 'networkidle' });
  await e.getByLabel('E-mail da conta').first().fill('paulo.pendente@exemplo.com');
  await e.getByRole('button', { name: 'Enviar link de recuperação' }).click();
  await e.waitForSelector('text=Verifique seu e-mail');
  const pLink = resetLinkOf(resetMails(await nextMails('paulo.pendente@exemplo.com', 2, 15000))[0]);
  await e.goto(pLink, { waitUntil: 'networkidle' });
  await e.getByLabel('Senha nova', { exact: true }).fill('senha-nova-do-paulo');
  await e.getByRole('button', { name: 'Salvar senha nova' }).click();
  await e.waitForSelector('text=Senha redefinida');
  ok(/o seu e-mail foi confirmado/.test(await body(e)), 'a tela diz que a senha foi trocada E o e-mail foi confirmado');
  ok(psql("select status from customers where email = 'paulo.pendente@exemplo.com'") === 'active', 'banco: a conta passou a active');
  await e.getByRole('link', { name: 'Entrar' }).last().click();
  await e.getByLabel('Senha *').fill('senha-nova-do-paulo');
  await e.getByRole('button', { name: 'Entrar', exact: true }).last().click();
  await finishLogin(e);
  await e.waitForSelector('text=Olá, Paulo!');
  ok(true, 'entra direto com a senha nova (sem pedir código de confirmação)');
  await ctxE.close();

  // =====================================================================================================
  console.log('# 5. alternativa sem e-mail (telefone + pedido) continua disponível');
  const ctxF = await newContext(browser);
  const f = track(await ctxF.newPage());
  await f.goto(BASE + '/conta/recuperar', { waitUntil: 'networkidle' });
  ok((await f.getByLabel('Telefone cadastrado').count()) === 0, 'a alternativa começa fechada');
  await f.getByRole('button', { name: 'Não consigo acessar meu e-mail' }).click();
  await f.waitForSelector('text=Telefone cadastrado');
  ok((await f.getByLabel('Nº do pedido').count()) === 1 && (await f.getByLabel('Código de acompanhamento').count()) === 1 && /pelo WhatsApp/.test(await body(f)), 'ao abrir, aparecem telefone, pedido, código e o atalho do WhatsApp');
  await f.screenshot({ path: `${SP}/recover-alt-mobile.png`, fullPage: true });
  await ctxF.close();

  // =====================================================================================================
  console.log('# 6. larguras pequenas');
  const ctxG = await newContext(browser, { width: 320, height: 640 });
  const g = track(await ctxG.newPage());
  for (const url of ['/conta/recuperar', '/conta/redefinir/token-que-nao-existe-1234567890']) {
    await g.goto(BASE + url, { waitUntil: 'networkidle' });
    await g.waitForSelector('h1');
    ok(await noHScroll(g), `${url.slice(0, 22)}… a 320px: sem rolagem horizontal`);
  }
  await ctxG.close();
  await ctxOld.close().catch(() => undefined);

  ok(errors.length === 0, 'sem erros no console/página', errors.slice(0, 5));
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log('CRASH', err);
  process.exit(2);
});
