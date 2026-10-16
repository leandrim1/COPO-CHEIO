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

module.exports = { finishLogin, latestLoginCode };
