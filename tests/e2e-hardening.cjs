// Navegador real: o que as correções da auditoria mudaram na tela.
//   painel: verificação em duas etapas, configurações salvas ao mesmo tempo, atividades, produtos (tabela, promoção com datas, repetido,
//   importação com relatório), privacidade (clientes) e alertas;
//   site: política de privacidade, página não encontrada, checkout (total conferido, envio repetido), dados quebrados, API fora do ar,
//   tela de erro e política de segurança do navegador (CSP) sem bloqueios.
// usage: bash tests/fresh.sh && node tests/e2e-hardening.cjs   (precisa de `npm run build` feito)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { execSync } = require('child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const BASE = process.env.BASE || 'http://localhost:4180';
const SP = process.env.TEST_OUT || path.join(os.tmpdir(), 'copocheio-tests');
fs.mkdirSync(SP, { recursive: true });
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
let fails = 0;
let passes = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  else passes++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const body = (page) => page.evaluate(() => document.body.innerText);
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const OWNER = { email: 'dono@copocheio.local', password: 'senha-forte-123' };

let ipCounter = 0;
const nextIp = () => `10.90.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
const cspProblems = [];
async function newContext(browser, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route('**/*.mp4', (r) => r.abort());
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': nextIp() });
  return ctx;
}
const track = (page, errors) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) cspProblems.push(t.slice(0, 200));
    else if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|40\d|50\d/.test(t)) errors.push(t);
  });
  return page;
};

// API do painel com cookie próprio (para preparar dados sem passar pela tela)
let apiCookie = '';
async function api(method, p, data, cookie = apiCookie, ip = '10.91.0.1') {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...(cookie ? { cookie } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const set = res.headers.getSetCookie?.() ?? [];
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, cookies: set.map((c) => c.split(';')[0]).join('; ') };
}

async function uiLogin(page, creds = OWNER, code) {
  await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await page.fill('#login-email', creds.email);
  await page.fill('#login-senha', creds.password);
  await page.keyboard.press('Enter');
  // 2º passo: código enviado por e-mail (sempre); 3º passo: código do aplicativo, só para quem ligou a verificação em duas etapas.
  await finishAdminLogin(page);
  if (code) {
    await page.waitForSelector('#login-codigo');
    await page.fill('#login-codigo', code);
    await page.keyboard.press('Enter');
  }
  await page.waitForURL('**/admin/dashboard', { timeout: 20000 });
}

const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  const { load } = await import('./unit/load.mjs');
  const totp = await load('server/totp.ts');
  const browser = await chromium.launch();
  require('./e2e-age.cjs').patchBrowser(browser);
  const errors = [];

  const login = await adminLoginViaApi(api, OWNER, { cookieArg: true });
  apiCookie = login.cookies;
  const days = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await api('PATCH', '/api/admin/store', { opening_hours: days, delivery_fee: 5, min_order: 0 });
  const cat = (await api('POST', '/api/admin/categories', { name: 'Cervejas' })).data.category;
  const p1 = (await api('POST', '/api/admin/products', { name: 'Heineken Long Neck', price: 9, category_id: cat.id })).data.product;
  const p2 = (await api('POST', '/api/admin/products', { name: 'Gelo 5kg', price: 10, category_id: cat.id })).data.product;

  // =====================================================================================================
  console.log('# 1. verificação em duas etapas pela tela');
  const ctxA = await newContext(browser);
  const a = track(await ctxA.newPage(), errors);
  await uiLogin(a);
  await a.goto(BASE + '/admin/configuracoes#painel', { waitUntil: 'networkidle' });
  await a.waitForSelector('text=Verificação em duas etapas');
  ok(/DESATIVADA/.test(await body(a)), 'começa DESATIVADA');
  ok(/Mínimo de 10 caracteres/.test(await body(a)), 'a dica da senha do painel diz 10 caracteres');
  await a.getByRole('button', { name: 'Ativar verificação em duas etapas' }).click();
  await a.getByLabel('Senha atual').last().fill('senha-errada-123');
  await a.getByRole('button', { name: 'Continuar' }).click();
  await a.waitForSelector('[role=alert]');
  ok(/senha está incorreta/i.test(await a.locator('[role=alert]').last().innerText()), 'senha errada: avisa e não gera a chave');
  await a.getByLabel('Senha atual').last().fill(OWNER.password);
  await a.getByRole('button', { name: 'Continuar' }).click();
  await a.waitForSelector('[aria-label="QR code para o aplicativo autenticador"] svg');
  const qrPath = await a.locator('[aria-label="QR code para o aplicativo autenticador"] svg path').first().getAttribute('d');
  ok((qrPath ?? '').length > 300, 'o QR code foi desenhado (SVG com os módulos)', (qrPath ?? '').length);
  const secret = (await a.locator('p.select-all').innerText()).replace(/\s+/g, '');
  ok(/^[A-Z2-7]{32}$/.test(secret), 'a chave para digitar à mão aparece (32 letras)', secret);
  await a.screenshot({ path: `${SP}/hardening-2fa-qr.png` });
  await a.getByLabel('Código do aplicativo').fill('000000');
  await a.getByRole('button', { name: 'Ativar', exact: true }).click();
  await a.waitForSelector('text=Código incorreto');
  ok(true, 'código errado não liga');
  const step = totp.stepAt(Date.now());
  await a.getByLabel('Código do aplicativo').fill(totp.totpAtStep(secret, step));
  await a.getByRole('button', { name: 'Ativar', exact: true }).click();
  await a.waitForSelector('ul[aria-label="Códigos de recuperação"]');
  const codes = await a.locator('ul[aria-label="Códigos de recuperação"] li').allInnerTexts();
  ok(codes.length === 8 && codes.every((c) => /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){3}$/.test(c)), '8 códigos de recuperação aparecem', codes);
  ok(await a.getByRole('button', { name: 'Concluir' }).isDisabled(), '"Concluir" só libera depois de marcar que guardou os códigos');
  await a.getByLabel('Guardei os códigos em um lugar seguro.').check();
  await a.screenshot({ path: `${SP}/hardening-2fa-codes.png` });
  await a.getByRole('button', { name: 'Concluir' }).click();
  await a.waitForSelector('text=Protegida');
  ok(/Protegida\. Você tem 8 código/.test(await body(a)) && !/DESATIVADA/.test(await body(a)), 'painel mostra ATIVADA e quantos códigos sobram');

  // Entrar de novo (outro navegador): senha e depois o código
  const ctxB = await newContext(browser);
  const b = track(await ctxB.newPage(), errors);
  await b.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await b.fill('#login-email', OWNER.email);
  await b.fill('#login-senha', OWNER.password);
  await b.keyboard.press('Enter');
  await finishAdminLogin(b);
  await b.waitForSelector('#login-codigo');
  ok(/verificação em duas etapas/i.test(await body(b)) && !b.url().includes('/dashboard'), 'senha certa: a tela pede o código e ainda não entra');
  await b.fill('#login-codigo', '123456');
  await b.keyboard.press('Enter');
  await b.waitForSelector('[role=alert], [aria-live] :text("incorreto")', { timeout: 10000 }).catch(() => undefined);
  ok(/incorreto/i.test(await body(b)), 'código errado: mensagem de erro');
  await b.fill('#login-codigo', totp.totpAtStep(secret, step + 1));
  await b.keyboard.press('Enter');
  await b.waitForURL('**/admin/dashboard', { timeout: 20000 });
  ok(true, 'código do aplicativo certo: entra no painel');
  await b.context().clearCookies();
  await b.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await b.fill('#login-email', OWNER.email);
  await b.fill('#login-senha', OWNER.password);
  await b.keyboard.press('Enter');
  await finishAdminLogin(b);
  await b.waitForSelector('#login-codigo');
  await b.getByRole('button', { name: 'Usar um código de recuperação' }).click();
  await b.fill('#login-codigo', codes[0]);
  await b.keyboard.press('Enter');
  await b.waitForURL('**/admin/dashboard', { timeout: 20000 });
  ok(true, 'código de recuperação também entra');
  await ctxB.close();

  // Desativar pela tela (senha + código de recuperação)
  await a.goto(BASE + '/admin/configuracoes#painel', { waitUntil: 'networkidle' });
  await a.getByRole('button', { name: 'Desativar', exact: true }).click();
  await a.getByLabel('Senha atual').last().fill(OWNER.password);
  await a.getByLabel('Código do aplicativo ou de recuperação').fill(codes[1]);
  await a.getByRole('dialog').getByRole('button', { name: 'Desativar' }).click();
  await a.waitForSelector('text=DESATIVADA');
  await a.waitForTimeout(300);
  ok(psql("select totp_enabled_at is null from admins where email='dono@copocheio.local'") === 't', 'desativada: o banco não tem mais a chave ativa');

  // =====================================================================================================
  console.log('# 2. configurações salvas ao mesmo tempo (a tela antiga não desfaz o que mudou)');
  const ctxC = await newContext(browser);
  const c1 = track(await ctxC.newPage(), errors);
  await uiLogin(c1);
  const c2 = track(await ctxC.newPage(), errors);
  await c1.goto(BASE + '/admin/configuracoes#horarios', { waitUntil: 'networkidle' });
  await c2.goto(BASE + '/admin/configuracoes#horarios', { waitUntil: 'networkidle' });
  await c1.getByRole('switch', { name: 'Sábado: aberto' }).waitFor();
  const satBefore = await c1.getByRole('switch', { name: 'Sábado: aberto' }).getAttribute('aria-checked');
  await c1.getByRole('switch', { name: 'Sábado: aberto' }).click();
  await c1.getByRole('button', { name: 'Salvar' }).click();
  await c1.waitForSelector('text=Horários salvos.');
  ok(true, 'primeira tela salva os horários');
  await c2.getByRole('switch', { name: 'Domingo: aberto' }).click();
  await c2.getByRole('button', { name: 'Salvar' }).click();
  await c2.waitForSelector('text=Outra pessoa alterou estas configurações.');
  ok(true, 'a segunda tela (antiga) é avisada em vez de sobrescrever');
  const sat = psql("select opening_hours->'sat'->>'open' from store_settings where id=1");
  ok(sat === (satBefore === 'true' ? 'false' : 'true'), 'o horário salvo primeiro foi mantido', sat);
  await c2.waitForTimeout(500);
  ok((await c2.getByRole('switch', { name: 'Sábado: aberto' }).getAttribute('aria-checked')) === (satBefore === 'true' ? 'false' : 'true'), 'a tela antiga mostra agora os dados atuais');
  await c2.getByRole('switch', { name: 'Domingo: aberto' }).click();
  await c2.getByRole('button', { name: 'Salvar' }).click();
  await c2.waitForSelector('text=Horários salvos.');
  ok(true, 'depois de conferir, a segunda pessoa consegue salvar');
  // devolve o horário aberto o tempo todo para os testes seguintes
  await api('PATCH', '/api/admin/store', { opening_hours: days });

  // =====================================================================================================
  console.log('# 3. atividades (só o owner)');
  await c1.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await c1.getByRole('tab', { name: 'Atividades' }).click();
  await c1.waitForSelector('text=Atividades do painel');
  // O título aparece antes de a lista chegar da API: espera as linhas (sem isso, em máquina lenta, a contagem sai 0).
  await c1.waitForSelector('ul.divide-y li', { timeout: 10000 }).catch(() => undefined);
  const rows = await c1.locator('ul.divide-y li').count();
  ok(rows >= 3, 'o owner vê a lista de atividades', rows);
  ok(/Configurações da loja/.test(await body(c1)) && /Dono Teste/.test(await body(c1)), 'cada linha diz o que mudou e quem mudou');
  await c1.getByLabel('Buscar').fill('Heineken');
  await c1.waitForTimeout(900);
  ok(/Heineken/.test(await body(c1)) && !/Configurações da loja/.test(await body(c1)), 'a busca filtra a lista');
  await c1.getByLabel('Buscar').fill('');
  await c1.getByLabel('Assunto').selectOption('product');
  await c1.waitForTimeout(700);
  ok(!/Configurações da loja/.test(await body(c1)) && /Cadastrou o produto/.test(await body(c1)), 'o filtro por assunto funciona');
  const staffC = await api('POST', '/api/admin/admins', { email: 'comum@copocheio.local', name: 'Atendente Comum', password: 'Atendente!Segura-2026', role: 'admin' });
  ok(staffC.status === 201, 'administrador comum criado');
  const ctxS = await newContext(browser);
  const s = track(await ctxS.newPage(), errors);
  await uiLogin(s, { email: 'comum@copocheio.local', password: 'Atendente!Segura-2026' });
  await s.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  ok((await s.getByRole('tab', { name: 'Atividades' }).count()) === 0, 'administrador comum não vê a aba Atividades');
  ok((await s.evaluate(() => fetch('/api/admin/audit').then((r) => r.status))) === 403, '...e o servidor recusa (403)');
  await s.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  ok(/só pode ser gerado pelo owner/.test(await body(s)), 'em Clientes, o comum é avisado de que o link de nova senha é do owner');
  await ctxS.close();

  // =====================================================================================================
  console.log('# 4. produtos');
  const longName = 'Cerveja Artesanal Edição Limitada Safra Especial 2026 Lata 473ml';
  await api('POST', '/api/admin/products', { name: longName, price: 12.9, category_id: cat.id, sku: 'LONGO-1', stock: 4 });
  for (const w of [1024, 1280, 1366, 1536, 1920]) {
    await c1.setViewportSize({ width: w, height: 800 });
    await c1.goto(BASE + '/admin/produtos', { waitUntil: 'networkidle' });
    await c1.waitForSelector('table');
    const m = await c1.evaluate(() => {
      const btn = [...document.querySelectorAll('button[aria-label="Mais ações"]')].find((el) => el.getBoundingClientRect().width > 0);
      const r = btn?.getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, vw: innerWidth, right: r ? Math.round(r.right) : null, thActions: [...document.querySelectorAll('th')].some((th) => /Ações/.test(th.textContent) && th.getBoundingClientRect().right <= innerWidth + 1) };
    });
    ok(m.sw <= m.vw + 1 && m.right !== null && m.right <= m.vw && m.thActions, `produtos @${w}: nome comprido, sem rolagem horizontal e "Ações" visível`, m);
  }
  await c1.setViewportSize({ width: 1440, height: 900 });
  await c1.goto(BASE + '/admin/produtos/novo', { waitUntil: 'networkidle' });
  await c1.getByLabel('Nome *').fill('Vinho Teste');
  await c1.getByLabel('Preço *').fill('0');
  await c1.getByRole('button', { name: 'Salvar produto' }).click();
  await c1.waitForSelector('text=Informe um preço maior que zero.');
  ok(true, 'preço zero: a tela pede um preço maior que zero');
  await c1.getByLabel('Preço *').fill('50');
  await c1.getByLabel('Preço promocional').fill('40');
  await c1.getByLabel('A promoção começa em').waitFor();
  await c1.getByLabel('A promoção começa em').fill('2099-01-10T10:00');
  await c1.getByLabel('A promoção termina em').fill('2099-01-05T10:00');
  await c1.getByRole('button', { name: 'Salvar produto' }).click();
  await c1.waitForSelector('text=O fim precisa ser depois do início.');
  ok(true, 'fim antes do início é recusado na tela');
  await c1.getByLabel('A promoção termina em').fill('2099-01-20T10:00');
  await c1.getByRole('button', { name: 'Salvar produto' }).click();
  await c1.waitForURL('**/admin/produtos');
  const stored = psql("select promo_starts_at at time zone 'America/Sao_Paulo' from products where name='Vinho Teste'");
  ok(/2099-01-10 10:00/.test(stored), 'a promoção agendada guarda o horário de Brasília digitado', stored);
  await c1.waitForSelector('text=Promoção agendada');
  ok(true, 'a lista marca "Promoção agendada" e mostra o preço normal');
  ok(!/R\$\s?40,00/.test(await c1.locator('tr', { hasText: 'Vinho Teste' }).innerText()) || /R\$\s?50,00/.test(await c1.locator('tr', { hasText: 'Vinho Teste' }).innerText()), 'preço normal visível enquanto a promoção não começou');
  // repetido
  await c1.goto(BASE + '/admin/produtos/novo', { waitUntil: 'networkidle' });
  await c1.getByLabel('Nome *').fill('vinho teste');
  await c1.getByLabel('Preço *').fill('55');
  await c1.getByRole('button', { name: 'Salvar produto' }).click();
  await c1.waitForSelector('text=Já existe um produto com este nome');
  ok(true, 'nome repetido na mesma categoria: a tela pergunta antes de salvar');
  await c1.getByRole('button', { name: 'Salvar mesmo assim' }).click();
  await c1.waitForURL('**/admin/produtos');
  ok(psql("select count(*) from products where lower(name)='vinho teste'") === '2', 'confirmando, o segundo é cadastrado');
  // importação
  await c1.getByRole('button', { name: 'Importar', exact: true }).click();
  const csv = 'nome;preço;categoria;estoque\nImportado Um;10,50;Importados;5\nImportado Dois;abc;Importados;1\nImportado Um;11;Importados;1\n;7;Importados;2';
  await c1.getByLabel('Conteúdo a importar (JSON ou planilha)').fill(csv);
  ok(/4 linha\(s\) lido\(s\)/.test(await body(c1)), 'a planilha colada é lida (4 linhas)');
  await c1.getByRole('button', { name: /Importar 4 produtos/ }).click();
  await c1.waitForSelector('text=Resultado da importação');
  const report = await c1.getByRole('dialog').innerText();
  ok(/Criados\s*1/.test(report.replace(/\n/g, ' ')) || /1\s*Criados/.test(report.replace(/\n/g, ' ')), 'relatório: 1 criado', report.slice(0, 200));
  ok(/Linha 2/.test(report) && /Linha 3/.test(report) && /Linha 4/.test(report), 'relatório: cada linha com problema aparece com o número', report);
  ok(/Preço: precisa ser maior que zero/.test(report) && /Repetido no arquivo/.test(report) && /Nome: preencha este campo/.test(report), 'relatório: o motivo de cada uma', report);
  await c1.screenshot({ path: `${SP}/hardening-import-report.png` });
  await c1.getByRole('dialog').getByRole('button', { name: 'Fechar' }).last().click();

  // =====================================================================================================
  console.log('# 5. privacidade (site e painel)');
  const ctxP = await newContext(browser, { width: 390, height: 844 });
  const pv = track(await ctxP.newPage(), errors);
  await pv.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  const footerLink = pv.getByRole('contentinfo').getByRole('link', { name: 'Política de privacidade' });
  ok((await footerLink.count()) === 1, 'rodapé tem o link "Política de privacidade" (na linha do ©, sem mexer nos links nem na altura)');
  await footerLink.click();
  await pv.waitForURL('**/privacidade');
  await pv.waitForSelector('h1:has-text("Política de privacidade")');
  ok(/Atualizada em/.test(await body(pv)) && /Google Maps/.test(await body(pv)) && /Vercel/.test(await body(pv)) && /Neon/.test(await body(pv)), 'a política descreve os dados e os serviços de terceiros');
  ok(/Política de privacidade/.test(await pv.title()), 'o título da aba é "Política de privacidade – …"');
  ok(await noHScroll(pv), 'a página cabe no celular');
  await pv.evaluate(() => { localStorage.setItem('copocheio:pedido', '{"x":1}'); localStorage.setItem('copocheio:cliente', '{"name":"Teste"}'); localStorage.setItem('outra-coisa', 'fica'); });
  await pv.getByRole('button', { name: 'Apagar os dados deste aparelho' }).click();
  await pv.waitForSelector('text=Pronto: carrinho e dados salvos aqui foram apagados.');
  const left = await pv.evaluate(() => ({ cart: localStorage.getItem('copocheio:pedido'), cli: localStorage.getItem('copocheio:cliente'), other: localStorage.getItem('outra-coisa') }));
  ok(left.cli === null && (left.cart === null || left.cart === '{}') && left.other === 'fica', 'o botão apaga só os dados do site neste aparelho', left);
  await pv.getByLabel('Seu nome *').fill('Pedro Titular');
  await pv.getByLabel('Telefone ou e-mail para a resposta *').fill('123');
  await pv.getByRole('button', { name: 'Enviar pedido' }).click();
  await pv.waitForSelector('text=Informe um telefone com DDD ou um e-mail válido.');
  ok(true, 'contato inválido: erro no campo');
  await pv.getByLabel('Telefone ou e-mail para a resposta *').fill('(34) 97777-1234');
  await pv.getByLabel('O que você precisa?').selectOption('deletion');
  await pv.getByLabel('Mensagem (opcional)').fill('Quero apagar meus dados, por favor.');
  await pv.screenshot({ path: `${SP}/hardening-privacidade-390.png`, fullPage: true });
  await pv.getByRole('button', { name: 'Enviar pedido' }).click();
  await pv.waitForSelector('text=Pedido enviado.');
  ok(psql("select count(*) from privacy_requests where name='Pedro Titular' and kind='deletion' and contact='34977771234'") === '1', 'o pedido chegou ao banco (telefone só com números)');
  ok((await pv.locator('input[tabindex="-1"]').count()) === 0, 'depois de enviar, o formulário some (e o campo-armadilha nunca aparece para pessoas)');
  await ctxP.close();

  await c1.goto(BASE + '/admin/dashboard', { waitUntil: 'networkidle' });
  ok(/1 pedido de privacidade espera resposta/.test(await body(c1)), 'o dashboard avisa do pedido de privacidade');
  await c1.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  await c1.waitForSelector('text=Privacidade (LGPD)');
  ok(/Pedro Titular/.test(await body(c1)) && /Quer apagar os dados/.test(await body(c1)) && /1 em aberto/.test(await body(c1)), 'Clientes lista o pedido, com o assunto e a contagem');
  ok((await c1.getByRole('link', { name: /Responder no WhatsApp/ }).getAttribute('href')).includes('wa.me/5534977771234'), 'botão de responder abre o WhatsApp do titular');
  await c1.getByRole('button', { name: 'Marcar como atendido' }).click();
  await c1.getByLabel('Observação (opcional)').fill('Atendido por WhatsApp');
  await c1.getByRole('button', { name: 'Confirmar' }).click();
  await c1.waitForSelector('text=Marcado como atendido.');
  ok(psql("select status || '|' || handled_note from privacy_requests where name='Pedro Titular'") === 'done|Atendido por WhatsApp', 'atendimento registrado com a observação');
  // anonimizar
  const order = await api('POST', '/api/orders', { customer_name: 'Pedro Titular', customer_phone: '34977771234', customer_email: 'pedro@exemplo.com', delivery_type: 'pickup', payment_method: 'pix', age_confirmed: true, fill_ms: 5000, items: [{ product_id: p2.id, quantity: 1 }] }, '', nextIp());
  ok(order.status === 201, 'pedido de visitante criado para o teste de anonimização');
  await c1.getByRole('button', { name: 'Anonimizar uma pessoa' }).click();
  await c1.getByLabel('Telefone com DDD').fill('34977771234');
  await c1.getByRole('dialog').getByRole('button', { name: 'Anonimizar' }).click();
  await c1.waitForSelector('text=Dados anonimizados.');
  ok(psql("select customer_name from orders where order_number=" + order.data.order.order_number) === 'Cliente removido', 'o pedido do visitante foi anonimizado pela tela');

  // =====================================================================================================
  console.log('# 6. checkout: valor que mudou e envio repetido');
  const ctxK = await newContext(browser, { width: 390, height: 844 });
  const k = track(await ctxK.newPage(), errors);
  const goCheckout = async (page) => {
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.click(`button[aria-label="Adicionar ${p1.name} ao pedido"] >> nth=0`);
    await page.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await page.getByLabel('Nome *').fill('João Silva');
    await page.getByLabel('Telefone / WhatsApp *').fill('34999990000');
    await page.getByLabel('Rua / Avenida *').fill('Rua A');
    await page.getByLabel('Número *').fill('123');
    await page.getByLabel('Bairro *').fill('Centro');
    await page.waitForTimeout(800);
  };
  await goCheckout(k);
  ok(/política de privacidade/.test(await body(k)) && (await k.locator('a[href="/privacidade"]').count()) >= 1, 'o checkout tem o aviso e o link da política de privacidade');
  const trapBox = await k.locator('input[name="apelido_interno"]').boundingBox();
  ok(trapBox && trapBox.x + trapBox.width < 0 && (await k.locator('input[name="apelido_interno"]').evaluate((el) => el.tabIndex === -1 && el.closest('[aria-hidden="true"]') !== null)), 'o campo-armadilha fica fora da tela, fora da ordem do Tab e escondido de leitores de tela', trapBox);
  ok(/R\$\s?14,00/.test(await k.locator('aside').innerText()), 'resumo: 9,00 + entrega 5,00 = 14,00');
  await api('PATCH', `/api/admin/products/${p1.id}`, { price: 12 });
  await k.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await k.waitForSelector('text=Os valores mudaram desde que você abriu esta tela');
  const notice = await k.locator('aside').innerText();
  ok(/subiu de R\$\s?14,00 para\s*R\$\s?17,00/.test(notice.replace(/\n/g, ' ')), 'aviso: o total subiu de 14,00 para 17,00', notice.slice(0, 300));
  ok(/Heineken Long Neck: R\$\s?9,00 → R\$\s?12,00/.test(notice), 'aviso lista o item que mudou (9,00 → 12,00)');
  ok(/Confirmar novo total · R\$\s?17,00/.test(notice), 'o botão passa a ser "Confirmar novo total"');
  ok(psql("select count(*) from orders where customer_phone='34999990000'") === '0', 'nenhum pedido foi criado com o valor antigo');
  await k.screenshot({ path: `${SP}/hardening-checkout-preco.png`, fullPage: true });
  await k.getByRole('button', { name: /Confirmar novo total/ }).click();
  await k.waitForURL(/\/pedido\//, { timeout: 15000 });
  ok(psql("select total from orders where customer_phone='34999990000' order by created_at desc limit 1") === '17.00', 'confirmando, o pedido sai com o total novo (17,00)');
  await api('PATCH', `/api/admin/products/${p1.id}`, { price: 9 });

  // resposta perdida: o servidor cria o pedido, o navegador não recebe; ao tentar de novo vem o MESMO pedido
  const ctxL = await newContext(browser, { width: 390, height: 844 });
  const l = track(await ctxL.newPage(), errors);
  await goCheckout(l);
  let dropped = 0;
  await l.route('**/api/orders', async (route) => {
    if (dropped++ === 0) {
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  const before = Number(psql('select count(*) from orders'));
  await l.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await l.waitForSelector('text=Sem conexão');
  ok(Number(psql('select count(*) from orders')) === before + 1, 'o servidor criou o pedido, mas a resposta se perdeu');
  await l.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await l.waitForURL(/\/pedido\//, { timeout: 15000 });
  ok(Number(psql('select count(*) from orders')) === before + 1, 'tocar de novo NÃO criou um segundo pedido (mesma chave de envio)');
  await l.waitForSelector('text=Pedido recebido!');
  ok(true, 'e a pessoa chega à confirmação do pedido que já existia');
  await ctxL.close();
  await ctxK.close();

  // =====================================================================================================
  console.log('# 7. dados quebrados, API fora do ar, página não encontrada e tela de erro');
  const ctxD = await newContext(browser, { width: 1280, height: 800 });
  const d = track(await ctxD.newPage(), errors);
  await d.addInitScript(() => {
    try {
      localStorage.setItem('copocheio:site-v2', JSON.stringify({ store: { opening_hours: null, delivery_fee: 'x', store_name: null }, site: { featured_limit: 'abc' }, hero: {}, products: [{ id: 'x' }, null, { id: 'ok', name: 'Item', price: 5, category: 'Teste', categoryPosition: 0, position: 0, featured: false, soldOut: false }], banners: null, coverBanners: null, zones: null, payments: null }));
    } catch {}
  });
  await d.route('**/api/site*', async (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ store: null, site: null, hero: null, banners: null, cover_banners: null, zones: null, payments: null }) }));
  await d.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await d.waitForTimeout(600);
  ok(!/Algo deu errado por aqui/.test(await body(d)) && (await d.locator('h1').count()) >= 1, 'cópia salva e resposta da API quebradas (nulos): a página abre, sem tela branca');
  await d.goto(BASE + '/', { waitUntil: 'networkidle' });
  ok(!/Algo deu errado por aqui/.test(await body(d)) && (await d.locator('main').count()) >= 1, '...a página inicial também');
  await ctxD.close();

  const ctxO = await newContext(browser, { width: 1280, height: 800 });
  const o = track(await ctxO.newPage(), errors);
  await o.route('**/api/products*', (r) => r.abort('failed'));
  await o.route('**/api/site*', (r) => r.abort('failed'));
  await o.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await o.waitForSelector('text=Não conseguimos carregar o cardápio');
  ok(!/Fechado|Aberto agora/.test(await body(o)), 'API fora do ar e sem cópia: não mostra "Fechado" nem "Aberto" inventados');
  await o.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  ok(!/Estamos fechados agora/.test(await body(o)), 'o checkout não diz que a loja está fechada só porque a API não respondeu');
  await ctxO.close();

  const ctxN = await newContext(browser, { width: 390, height: 844 });
  const n = track(await ctxN.newPage(), errors);
  await n.goto(BASE + '/pagina-que-nao-existe', { waitUntil: 'networkidle' });
  await n.waitForSelector('h1:has-text("Página não encontrada")');
  ok((await n.locator('meta[name="robots"]').getAttribute('content')) === 'noindex, nofollow', 'página não encontrada: fora do Google (noindex)');
  ok(await noHScroll(n), '...e cabe no celular');
  await n.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  ok((await n.locator('meta[name="robots"]').count()) === 0, '/bebidas não tem noindex');
  await n.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  ok((await n.locator('meta[name="robots"]').count()) === 1, '/checkout tem exatamente um noindex');
  await ctxN.close();

  // Tela de erro: monta o componente de verdade com uma peça que quebra
  const bundle = await (async () => {
    const { build } = await import('esbuild');
    const entry = path.join(os.tmpdir(), 'copocheio-boundary-entry.tsx');
    fs.writeFileSync(
      entry,
      `import { createRoot } from 'react-dom/client';
       import { ErrorBoundary } from '${path.resolve(__dirname, '../src/ErrorBoundary.tsx')}';
       const Bomb = () => { throw new Error('falha de teste em /pedido/SEGREDO123'); };
       createRoot(document.getElementById('root')!).render(<ErrorBoundary><Bomb /></ErrorBoundary>);`,
    );
    const out = await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', jsx: 'automatic', platform: 'browser', logLevel: 'silent', nodePaths: [path.resolve(__dirname, '../node_modules')], absWorkingDir: path.resolve(__dirname, '..') });
    return out.outputFiles[0].text;
  })();
  const ctxE = await newContext(browser, { width: 390, height: 844 });
  const e = await ctxE.newPage();
  let beacon = null;
  await e.route('**/api/client-error', async (route) => {
    beacon = route.request().postData();
    await route.fulfill({ status: 202, body: '{}' });
  });
  // Página de teste sem os cabeçalhos do site (o CSP bloquearia o script embutido do teste), no mesmo endereço do site.
  await e.route(BASE + '/__limite-de-erro', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${bundle}</script>` }));
  await e.goto(BASE + '/__limite-de-erro', { waitUntil: 'load' });
  await e.waitForSelector('text=Algo deu errado por aqui');
  ok(await e.getByRole('button', { name: 'Recarregar a página' }).isVisible() && (await e.getByRole('link', { name: 'Ir para o início' }).count()) === 1, 'tela de erro: mensagem, botão de recarregar e caminho para o início');
  await wait(500);
  ok(beacon && /"kind":"render"/.test(beacon) && !/SEGREDO123/.test(beacon), 'o erro foi avisado ao servidor, com o código do endereço mascarado', beacon);
  await e.screenshot({ path: `${SP}/hardening-erro.png` });
  await ctxE.close();

  // =====================================================================================================
  console.log('# 8. política de segurança do navegador (CSP): nenhuma página é bloqueada');
  const ctxV = await newContext(browser, { width: 1280, height: 800 });
  const v = track(await ctxV.newPage(), errors);
  await v.addInitScript(([id]) => { try { localStorage.setItem('copocheio:pedido', JSON.stringify({ [id]: 1 })); } catch {} }, [p1.id]);
  for (const p of ['/', '/bebidas', '/checkout', '/conta', '/conta/recuperar', '/acompanhar-pedido', '/privacidade', '/pagina-que-nao-existe']) {
    await v.goto(BASE + p, { waitUntil: 'networkidle' });
    await v.waitForTimeout(300);
  }
  const csrf = await newContext(browser);
  const av = track(await csrf.newPage(), errors);
  await uiLogin(av);
  for (const p of ['/admin/dashboard', '/admin/pedidos', '/admin/produtos', '/admin/produtos/novo', '/admin/categorias', '/admin/estoque', '/admin/clientes', '/admin/site', '/admin/banners', '/admin/configuracoes#loja', '/admin/configuracoes#painel', '/admin/configuracoes#atividades']) {
    await av.goto(BASE + p, { waitUntil: 'networkidle' });
    await av.waitForTimeout(300);
  }
  await av.getByRole('button', { name: 'Ativar verificação em duas etapas' }).click().catch(() => undefined);
  ok(cspProblems.length === 0, 'nenhum bloqueio de CSP em 20 páginas do site e do painel (inclui o QR code)', cspProblems.slice(0, 3));
  await ctxV.close();
  await csrf.close();

  ok(errors.length === 0, 'nenhum erro de console/página', errors.slice(0, 5));
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} ok, ${fails} falhas`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH', e.message);
  process.exit(2);
});
