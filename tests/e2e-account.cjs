// Conta do estabelecimento na operadora, no navegador (celular e computador): o painel Pagamentos mostra operadora e ambiente, o owner vincula uma
// conta que já existe (conferida na lista oficial) ou cadastra uma nova (PF/PJ) com a autorização do titular, acompanha o andamento e a conta só
// vira "Aprovada" com a confirmação oficial. Também confere o aviso de variáveis de ambiente que faltam (só os nomes).
//
// ATENÇÃO: a ValidaPay é um servidor FALSO (tests/validapay-fake.mjs) que segue a documentação. Isto prova as telas e a lógica da loja; não prova a
// integração com a ValidaPay de verdade (isso só no sandbox dela).
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-account.cjs   (reinicia o servidor de teste e, no fim, volta ao normal)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
fs.mkdirSync(SP, { recursive: true });
const ROOT = require('node:path').join(__dirname, '..') + '/';
const BASE = 'http://localhost:4180';
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
const serve = (env = {}) => execSync(`bash ${ROOT}tests/serve.sh`, { env: { ...process.env, ...env }, stdio: 'ignore' });
let fails = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
async function until(fn, ms = 8000) {
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
const errors = [];
async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR|40[0-9]|50[0-9]/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page };
}
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
async function loginOwner(page) {
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'dono@copocheio.local');
  await page.fill('#login-senha', 'senha-forte-123');
  await page.click('button[type=submit]');
  await finishAdminLogin(page);
  await page.waitForURL('**/admin/dashboard');
}
const card = (page) => page.locator('dl').first();

const { finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  const { FAKE, postWebhook, startFakeValidaPay } = await import('./validapay-fake.mjs');
  const fake = await startFakeValidaPay();
  const startServer = (env = {}) => serve({ PAYMENTS_SIM: 'validapay', FAKE_VALIDAPAY_URL: fake.url, FAKE_VALIDAPAY_WEBHOOK_SECRET: FAKE.webhookSecret, FAKE_VALIDAPAY_TIMEOUT_MS: '2500', ...env });
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);

  // ---- 1. Sem as variáveis: só os NOMES do que falta ---------------------------------------------------------------------------------
  console.log('# 1. Operadora não conectada: a página diz exatamente o que falta (só nomes)');
  serve({ PAYMENTS_SIM: 'off' });
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await loginOwner(page);
    await page.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    const text = await page.innerText('body');
    ok(/Não conectada/.test(text) && /Faltam estas variáveis de ambiente/.test(text), 'mostra "Não conectada" e o aviso das variáveis que faltam');
    ok((await page.locator('code', { hasText: 'VALIDAPAY_ENV' }).count()) === 1, 'o NOME da variável aparece (em destaque), sem nenhum valor');
    ok((await page.getByRole('button', { name: 'Vincular conta existente' }).count()) === 0, 'sem operadora conectada não há botão de vincular ou cadastrar conta');
    ok(await page.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).isDisabled(), 'o Pix online não pode ser ligado');
    await ctx.close();
  }

  // ---- 2. Operadora conectada (sandbox): vincular uma conta que já existe -------------------------------------------------------------
  console.log('# 2. Vincular uma conta existente (celular e computador)');
  startServer();
  const { page: ownerApi } = await newCtx(browser, { width: 1280, height: 800 });
  await loginOwner(ownerApi);
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    const { ctx, page } = await newCtx(browser, vp);
    await loginOwner(page);
    await page.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    const text = await page.innerText('body');
    ok(/Conectada/.test(text) && /validapay-sandbox/.test(text) && /Testes \(sandbox\)/.test(text), `${label}: operadora conectada, com o ambiente de TESTES bem visível`);
    ok(/Sem cadastro/.test(text) && (await page.getByRole('button', { name: 'Vincular conta existente' }).count()) === 1 && (await page.getByRole('button', { name: 'Cadastrar conta nova' }).count()) === 1, `${label}: sem conta ainda: os dois caminhos (vincular ou cadastrar)`);
    ok(await noHScroll(page), `${label}: a página não tem rolagem horizontal`);
    await page.getByRole('button', { name: 'Vincular conta existente' }).click();
    const dialog = page.getByRole('dialog', { name: 'Vincular uma conta que já existe' });
    await dialog.waitFor();
    ok(await until(async () => /Estabelecimento Teste Ltda/.test(await dialog.innerText())), `${label}: lista as contas informadas pela operadora`);
    const dtext = await dialog.innerText();
    ok(/documento ••••••••••0195/.test(dtext) && !/12345678000195|52998224725/.test(dtext), `${label}: o documento aparece SEMPRE mascarado`);
    ok(await dialog.getByRole('radio').nth(1).isDisabled() && /Ainda não confirmada/.test(dtext), `${label}: conta ainda não confirmada pela operadora não pode ser escolhida`);
    ok(await noHScroll(page), `${label}: janela de vincular sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-1-vincular.png` });
    await dialog.getByRole('button', { name: 'Vincular esta conta' }).click();
    ok(await until(async () => /Escolha a conta e marque as confirmações/.test(await dialog.innerText())), `${label}: sem escolher nem confirmar, explica o que falta e não envia nada`);
    ok(fake.state.calls.filter((c) => c.path === '/v1/accounts/subaccounts').length >= 1 && psql('select count(*) from merchant_accounts') === '0', `${label}: nada foi gravado`);
    if (label.startsWith('celular')) {
      await ctx.close();
      continue;
    }
    await dialog.getByRole('radio').first().check();
    await dialog.getByRole('button', { name: 'Vincular esta conta' }).click();
    ok(await until(async () => /Marque as confirmações abaixo/.test(await dialog.innerText())), `${label}: escolheu a conta mas não marcou a autorização do titular: continua pedindo`);
    await dialog.getByLabel(/autorizou/).check();
    await dialog.getByRole('button', { name: 'Vincular esta conta' }).click();
    ok(await until(async () => (await dialog.count()) === 0), `${label}: com a autorização do titular, a janela fecha`);
    ok(await until(async () => /Aprovada/.test(await card(page).innerText())), `${label}: a conta aparece "Aprovada"`);
    ok(psql(`select status || ':' || provider_account_id from merchant_accounts`) === 'approved:4960589', `${label}: no banco, aprovada com o número da conta`);
    ok(await page.getByRole('switch', { name: 'Oferecer Pix online no checkout' }).isEnabled(), `${label}: agora o Pix online pode ser ligado`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-2-aprovada.png`, fullPage: true });
    await ctx.close();
  }

  // ---- 3. Cadastrar uma conta nova ------------------------------------------------------------------------------------------------------
  console.log('# 3. Cadastrar uma conta nova: formulário, erros por campo, andamento e aprovação oficial');
  psql(`update merchant_accounts set status = 'suspended'`);
  for (const [label, vp] of [['celular 390', { width: 390, height: 844 }], ['computador 1280', { width: 1280, height: 800 }]]) {
    const { ctx, page } = await newCtx(browser, vp);
    await loginOwner(page);
    await page.goto(BASE + '/admin/pagamentos', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Cadastrar conta nova' }).click();
    const dialog = page.getByRole('dialog', { name: 'Cadastrar a conta do estabelecimento' });
    await dialog.waitFor();
    ok(/NÃO ficam guardados neste site/.test(await dialog.innerText()), `${label}: avisa que os dados vão direto para a operadora e não ficam guardados aqui`);
    ok((await dialog.getByLabel('Razão social').count()) === 1 && (await dialog.getByLabel('Faturamento da empresa').count()) === 1, `${label}: empresa (PJ) é o padrão, com sócio e faturamento`);
    ok(await noHScroll(page), `${label}: formulário PJ sem rolagem horizontal`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-3-formulario-pj.png` });
    await dialog.getByLabel('Pessoa física (CPF)').check();
    ok((await dialog.getByLabel('Razão social').count()) === 0 && (await dialog.getByLabel('Renda mensal', { exact: true }).count()) === 1, `${label}: trocar para pessoa física troca os campos`);
    await dialog.getByRole('button', { name: 'Enviar cadastro à operadora' }).click();
    ok(await until(async () => /Marque as confirmações no fim do formulário/.test(await dialog.innerText())), `${label}: sem a autorização do titular não envia`);
    ok(fake.state.calls.filter((c) => c.path === '/v1/proposals').length === 0, `${label}: nada foi para a operadora`);
    await dialog.getByLabel(/autorizou este cadastro/).check();
    await dialog.getByLabel('CPF', { exact: true }).fill('111.111.111-11');
    await dialog.getByLabel('Nome completo', { exact: true }).fill('Fulano de Tal da Silva');
    await dialog.getByRole('button', { name: 'Enviar cadastro à operadora' }).click();
    ok(await until(async () => /Confira os campos destacados/.test(await dialog.innerText())), `${label}: formulário incompleto: o servidor aponta os campos`);
    const dtext = await dialog.innerText();
    ok(/Informe o CPF válido/.test(dtext) && /Informe o e-mail válido/.test(dtext) && /Escolha a ocupação/.test(dtext), `${label}: a mensagem aparece junto de cada campo com erro`);
    ok(fake.state.calls.filter((c) => c.path === '/v1/proposals').length === 0, `${label}: formulário inválido nunca chega à operadora`);
    ok((await dialog.getByLabel('CPF', { exact: true }).getAttribute('aria-invalid')) === 'true', `${label}: o campo com erro é marcado para leitores de tela (aria-invalid)`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-4-erros.png` });

    if (label.startsWith('celular')) {
      await ctx.close();
      continue;
    }
    const fill = async (name, value) => dialog.getByLabel(name, { exact: true }).fill(value);
    await fill('CPF', '529.982.247-25');
    await fill('Data de nascimento', '1990-12-31');
    await fill('Nome da mãe', 'Maria da Silva Sauro');
    await fill('E-mail do titular', 'titular@exemplo.com.br');
    await fill('Celular com DDD', '(34) 99128-3384');
    await dialog.getByLabel('É pessoa politicamente exposta?').selectOption('nao');
    await fill('CEP', '38400-000');
    await fill('Rua', 'Rua das Flores Secretas');
    await fill('Número', '45');
    await fill('Bairro', 'Centro');
    await fill('Cidade', 'Uberlândia');
    await fill('UF', 'MG');
    await dialog.getByLabel('Renda mensal', { exact: true }).selectOption('DINP02');
    await dialog.getByLabel('Ocupação', { exact: true }).selectOption('ONP27');
    await dialog.getByLabel('Patrimônio', { exact: true }).selectOption('NWNP02');
    await dialog.getByRole('button', { name: 'Enviar cadastro à operadora' }).click();
    ok(await until(async () => (await dialog.count()) === 0), `${label}: formulário válido e autorizado: enviado e a janela fecha`);
    ok(await until(async () => /Aguardando aprovação/.test(await card(page).innerText())), `${label}: a conta aparece "Aguardando aprovação"`);
    const sent = fake.state.calls.filter((c) => c.path === '/v1/proposals');
    ok(sent.length === 1 && sent[0].body.documentNumber === '52998224725' && sent[0].body.birthDate === '31-12-1990' && sent[0].body.phoneNumber === '+5534991283384', `${label}: a operadora recebeu UM cadastro, no formato da documentação`, sent[0]?.body);
    ok((await page.getByRole('button', { name: 'Cadastrar conta nova' }).count()) === 0 && (await page.getByRole('button', { name: 'Atualizar andamento' }).count()) === 1, `${label}: com cadastro em andamento só dá para "Atualizar andamento" (não duplica)`);
    await page.getByRole('button', { name: 'Atualizar andamento' }).click();
    ok(await until(async () => /A operadora pede os documentos do titular/.test(await card(page).innerText())), `${label}: "Atualizar andamento" traz a página de envio dos documentos (que não é guardada)`);
    ok(/documentos\.exemplo\.invalid/.test(await card(page).innerHTML()) && !psql('select coalesce(string_agg(status_detail, \'|\'), \'\') from merchant_accounts').includes('documentos.exemplo'), `${label}: o endereço não fica no banco`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-5-pendente.png`, fullPage: true });

    // Etapas e aprovação oficial (avisos assinados da operadora).
    const formId = psql(`select proposal_id from merchant_accounts where status = 'pending'`);
    const stage = (event, data, id) => postWebhook(BASE, { event, timestamp: new Date().toISOString(), accountId: '4231833', data: { formId, proposalId: 'p-1', documentNumber: '52998224725', ...data } }, { id });
    await stage('onboarding.proposal', { status: 'APPROVED', proposalType: 'PF' }, 'e2e-1');
    await page.reload({ waitUntil: 'networkidle' });
    ok(/Aguardando aprovação/.test(await card(page).innerText()) && !/Aprovada/.test(await card(page).innerText()), `${label}: "proposta aprovada" não aprova a conta`);
    await stage('onboarding.create', { status: 'CONFIRMED', account: { number: '483918595', branch: '0001', name: 'Fulano' } }, 'e2e-2');
    await page.reload({ waitUntil: 'networkidle' });
    ok(await until(async () => /Aprovada/.test(await card(page).innerText())), `${label}: só o aviso oficial de conta aberta aprova (aparece "Aprovada")`);
    const approved = await card(page).innerText();
    ok(/483…|••••/.test(approved) || /\d{3}…\d{4}|••••/.test(approved), `${label}: o número da conta aparece mascarado`);
    ok(!/52998224725|Maria da Silva Sauro|titular@exemplo/.test(await page.innerText('body')), `${label}: nenhum dado pessoal do titular aparece na página`);
    await page.screenshot({ path: `${SP}/conta-${vp.width}-6-aprovada.png`, fullPage: true });
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de página nem de console em todo o teste', errors);
  await browser.close();
  serve();
  await fake.stop();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
