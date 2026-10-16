// Segundo passo do login do cliente nos testes de navegador: depois da senha, a tela "Confirme que é você" pede o código de 6 dígitos que o
// servidor mandou por e-mail (caixa simulada do servidor de teste). `to` filtra pelo destinatário; sem ele vale o e-mail de código mais recente.
const BASE = process.env.BASE || 'http://127.0.0.1:4180';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function latestLoginCode(to = '', ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(to.toLowerCase())}`)).json();
    const message = list.filter((m) => /código para entrar/.test(m.subject)).pop();
    if (message) return /\b(\d{6})\b/.exec(message.text)[1];
    await wait(120);
  }
  throw new Error('o e-mail com o código de acesso não chegou');
}

// Na tela do código: lê o e-mail, digita o código e toca em "Entrar".
async function finishLogin(page, to = '') {
  const field = page.getByLabel('Código de acesso');
  await field.waitFor({ timeout: 15000 });
  await field.fill(await latestLoginCode(to));
  await page.locator('[data-login-code-form]').getByRole('button', { name: 'Entrar', exact: true }).click();
}

// ---- Painel (administradores) ---------------------------------------------------------------------------------------------------------------
// O login do painel também tem dois passos: depois da senha, a tela pede o código de 6 dígitos enviado ao e-mail da conta administrativa.
async function latestAdminCode(to = '', ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await (await fetch(`${BASE}/__mail?to=${encodeURIComponent(to.toLowerCase())}`)).json();
    const message = list.filter((m) => /código de acesso ao painel/.test(m.subject)).pop();
    if (message) return /\b(\d{6})\b/.exec(message.text)[1];
    await wait(120);
  }
  throw new Error('o e-mail com o código de acesso ao painel não chegou');
}

// Na tela do código do painel: lê o e-mail, digita o código e toca em "Verificar e entrar".
async function finishAdminLogin(page, to = '') {
  const field = page.locator('#login-codigo-email');
  await field.waitFor({ timeout: 15000 });
  await field.fill(await latestAdminCode(to));
  await page.getByRole('button', { name: 'Verificar e entrar' }).click();
}

// Login do painel pela API, nos dois passos, com o `api(método, caminho, corpo)` do próprio teste (que guarda os cookies).
// `cookieArg: true` para os testes cujo `api(método, caminho, corpo, cookie)` NÃO guarda cookies: o cookie do desafio (devolvido pelo 1º passo) vai no 4º argumento.
async function adminLoginViaApi(api, creds, { cookieArg = false } = {}) {
  const first = await api('POST', '/api/auth/login', creds);
  if (first.status !== 202 || first.data?.status !== 'code_required') return first;
  const code = await latestAdminCode(creds.email);
  return cookieArg ? api('POST', '/api/auth/login/code', { code }, first.cookies ?? first.cookie) : api('POST', '/api/auth/login/code', { code });
}

module.exports = { finishLogin, latestLoginCode, latestAdminCode, finishAdminLogin, adminLoginViaApi };
