// Servidor SEM variáveis SMTP: cadastro indisponível com mensagem clara, painel avisa o que falta.
// usage: bash tests/fresh.sh && MAIL_MODE=none bash tests/serve.sh && node tests/e2e-mail-off.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('node:fs').mkdirSync(SP, { recursive: true });
const BASE = 'http://localhost:4180';
let fails = 0;
let passes = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  else passes++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const body = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route('**/*.mp4', (r) => r.abort());
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': '10.60.0.1' });
  const page = await ctx.newPage();
  const health = await (await fetch(BASE + '/api/health')).json();
  ok(health.mail === 'missing', '/api/health reports mail: missing', health);
  await page.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  await page.getByLabel('Nome *').fill('Iara Sem Email');
  await page.getByLabel('Telefone / WhatsApp *').fill('34911110000');
  await page.getByLabel('E-mail *').fill('iara@exemplo.com');
  await page.getByLabel('Senha *').fill('iara-senha-123');
  await page.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  await page.waitForSelector('[role=alert]');
  const msg = await page.locator('[role=alert]').first().innerText();
  ok(/temporariamente indisponível/.test(msg) && /sem conta/.test(msg), 'signup: clear message that sign-up is unavailable (and ordering without an account still works)', msg);
  ok(!/Confirme seu e-mail/.test(await body(page)), 'signup: does not pretend a code was sent');
  await page.screenshot({ path: `${SP}/verify-mail-off-signup.png`, fullPage: true });
  const login = await fetch(BASE + '/api/account/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.60.0.2' }, body: JSON.stringify({ email: 'iara@exemplo.com', password: 'iara-senha-123' }) });
  ok(login.status === 401, 'login for an unknown account is still the generic 401', login.status);

  // recuperação de senha por e-mail: avisa e abre o caminho sem e-mail
  await page.goto(BASE + '/conta/recuperar', { waitUntil: 'networkidle' });
  await page.getByLabel('E-mail da conta').first().fill('iara@exemplo.com');
  await page.getByRole('button', { name: 'Enviar link de recuperação' }).click();
  await page.waitForSelector('text=Use a opção abaixo');
  ok(/recuperação por e-mail está indisponível/.test(await body(page)) && !/Verifique seu e-mail/.test(await body(page)), 'recovery: says e-mail recovery is unavailable (does not pretend a link was sent)');
  await page.waitForSelector('text=Telefone cadastrado');
  ok((await page.getByLabel('Nº do pedido').count()) === 1, 'recovery: the phone + order alternative opens by itself');
  await page.screenshot({ path: `${SP}/verify-mail-off-recover.png`, fullPage: true });

  // painel
  const ad = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await ad.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await ad.getByLabel('E-mail').fill('dono@copocheio.local');
  await ad.locator('#login-senha').fill('senha-forte-123');
  await ad.getByRole('button', { name: 'Entrar' }).click();
  await ad.waitForURL('**/admin/dashboard');
  await ad.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  await ad.waitForSelector('text=O envio de e-mails ainda não está configurado');
  const txt = await body(ad);
  ok(/SMTP_HOST/.test(txt) && /SMTP_USER/.test(txt) && /SMTP_PASS/.test(txt), 'panel lists the missing variables by name', txt.slice(0, 600));
  ok(!(await ad.getByRole('button', { name: 'Enviar e-mail de teste' }).count()), 'panel offers no test button while unconfigured');
  await ad.screenshot({ path: `${SP}/verify-mail-off-admin.png`, fullPage: true });
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
})().catch((err) => {
  console.log('CRASH', err);
  process.exit(2);
});
