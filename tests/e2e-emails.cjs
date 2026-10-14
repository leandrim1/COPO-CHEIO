// Navegador real: e-mails e entregabilidade.
//  1. cliente: caixa de promoções desmarcada no cadastro (vale só depois do código), "Minha conta → E-mails", página do link do e-mail;
//  2. painel "E-mails" no celular e no computador: visão geral (o que o SMTP não informa), mensagens, promoções (teste, envio, andamento),
//     supressões, autenticação (DNS); e o administrador comum, que só consulta.
// usage: bash tests/fresh.sh && node tests/e2e-emails.cjs
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
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim();
let fails = 0;
let passes = 0;
const until = async (fn, ms = 8000) => {
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

let ipCounter = 0;
async function newContext(browser, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route('**/*.mp4', (r) => r.abort());
  await ctx.setExtraHTTPHeaders({ 'x-real-ip': `10.90.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}` });
  return ctx;
}
async function api(method, p, bodyData, cookie) {
  const res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', 'x-real-ip': `10.91.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(cookie ? { cookie } : {}) }, body: bodyData === undefined ? undefined : JSON.stringify(bodyData) });
  return { status: res.status, data: await res.json().catch(() => null), cookie: res.headers.getSetCookie?.()[0]?.split(';')[0] ?? '' };
}
async function verifiedAccount(name, email, password, optIn) {
  const reg = await api('POST', '/api/account/register', { name, email, phone: '34999990000', password, marketing_opt_in: optIn });
  const m = (await nextMails(email, 1))[0];
  const v = await api('POST', '/api/account/verify-email', { email, code: codeOf(m) }, reg.cookie);
  if (v.status !== 200) throw new Error('confirmação falhou ' + JSON.stringify(v));
}
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const track = (page) => {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource|503|429|404|401|403|400|409/.test(m.text())) errors.push(m.text());
    });
  };

  // ---- preparação pela API ----
  const ownerLogin = await api('POST', '/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const ownerCookie = ownerLogin.cookie;
  await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true }, ownerCookie);
  const cat = (await api('POST', '/api/admin/categories', { name: 'Cervejas' }, ownerCookie)).data.category;
  const prod = (await api('POST', '/api/admin/products', { name: 'Heineken Long Neck', price: 8.5, category_id: cat.id, stock: 100, confirm_duplicate: true }, ownerCookie)).data.product;
  await api('POST', '/api/admin/admins', { email: 'atendente-e@copocheio.local', name: 'Atendente E', password: 'Atendente!Segura-2026', role: 'admin' }, ownerCookie);
  await verifiedAccount('Fã Um', 'fa1@exemplo.com', 'senha-fa-1-123', true);
  await verifiedAccount('Fã Dois', 'fa2@exemplo.com', 'senha-fa-2-123', true);
  const place = async (email, name = 'Pedro Pedido') => {
    const r = await api('POST', '/api/orders', { customer_name: name, customer_phone: `3499${String(1000000 + Math.floor(Math.random() * 8999999))}`.slice(0, 11), customer_email: email, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: prod.id, quantity: 2 }], idempotency_key: `e2e-chave-${Math.random().toString(36).slice(2)}-${Date.now()}` });
    if (r.status !== 201) throw new Error('pedido recusado ' + JSON.stringify(r));
    return r.data.order.order_number;
  };
  const orderNumber = await place('hospede@exemplo.com');

  // =====================================================================================================
  console.log('# 1. cliente: consentimento no cadastro');
  const ctxA = await newContext(browser);
  const a = await ctxA.newPage();
  track(a);
  await a.goto(BASE + '/conta?aba=cadastro', { waitUntil: 'networkidle' });
  const box = a.getByRole('checkbox', { name: /Quero receber novidades e promoções da Copo Cheio por e-mail/ });
  ok((await box.count()) === 1, 'cadastro: a caixa de promoções existe');
  ok(!(await box.isChecked()), 'cadastro: a caixa vem DESMARCADA');
  ok(/Opcional/.test(await body(a)) && /só vale depois que você confirmar o e-mail/i.test(await body(a)), 'cadastro: o texto explica que é opcional e que vale só depois de confirmar o e-mail');
  ok(await noHScroll(a), 'cadastro: cabe na largura do celular');
  await a.getByLabel('Nome *').fill('Joana Promo');
  await a.getByLabel('Telefone / WhatsApp *').fill('34988887777');
  await a.getByLabel('E-mail *').fill('joana@exemplo.com');
  await a.getByLabel('Senha *').fill('joana-senha-123');
  await box.check();
  await a.getByRole('button', { name: /Criar conta e receber o código/ }).click();
  await a.waitForSelector('text=Confirme seu e-mail');
  ok(psql("select marketing::text || ':' || (marketing_pending_at is not null)::text from email_preferences where email = 'joana@exemplo.com'") === 'false:true', 'banco: marcada no cadastro = pedido PENDENTE, ainda não é consentimento');
  const joanaMail = (await nextMails('joana@exemplo.com', 1))[0];
  ok(/promoções/i.test(joanaMail.text) && /Ao confirmar o seu e-mail/.test(joanaMail.text), 'o e-mail do código cita a escolha de receber promoções');
  await a.getByLabel('Código de confirmação').fill(codeOf(joanaMail));
  await a.getByRole('button', { name: 'Confirmar e-mail' }).click();
  await a.waitForSelector('text=Olá, Joana!');
  ok(psql("select marketing::text || ':' || marketing_consent_source || ':' || marketing_consent_text from email_preferences where email = 'joana@exemplo.com'") === 'true:cadastro:v1', 'banco: confirmando o código, vira consentimento (origem cadastro, texto v1)');

  console.log('# 2. cliente: Minha conta → E-mails');
  const panel = a.locator('section[aria-labelledby="emails"]');
  await panel.waitFor();
  const promo = panel.getByRole('switch', { name: 'Novidades e promoções' });
  const orders = panel.getByRole('switch', { name: 'Avisos dos meus pedidos' });
  await until(async () => (await promo.getAttribute('aria-checked')) === 'true');
  ok((await promo.getAttribute('aria-checked')) === 'true' && (await orders.getAttribute('aria-checked')) === 'true', 'Minha conta: promoções ligadas (consentiu no cadastro) e avisos de pedido ligados');
  await promo.click();
  ok(await until(async () => /você não vai mais receber promoções/.test(await body(a))), 'desligar promoções mostra a confirmação');
  ok(await until(() => psql("select marketing::text || ':' || marketing_unsubscribed_via from email_preferences where email = 'joana@exemplo.com'") === 'false:conta'), 'banco: promoções desligadas pela conta');
  await promo.click();
  ok(await until(() => psql("select marketing::text || ':' || marketing_consent_source from email_preferences where email = 'joana@exemplo.com'") === 'true:conta'), 'banco: ligar de novo na conta registra o consentimento (origem conta)');
  await orders.click();
  ok(await until(() => psql("select notify_orders::text from email_preferences where email = 'joana@exemplo.com'") === 'false'), 'banco: avisos de pedido desligados');
  await orders.click();
  await until(() => psql("select notify_orders::text from email_preferences where email = 'joana@exemplo.com'") === 'true');
  ok(await noHScroll(a), 'Minha conta com o painel de e-mails cabe no celular');
  await a.screenshot({ path: `${SP}/emails-conta.png`, fullPage: true });
  await ctxA.close();

  console.log('# 3. cliente sem conta: página do link do e-mail');
  const orderMail = (await nextMails('hospede@exemplo.com', 1))[0];
  const link = /(https?:\/\/[^\s"<>]+\/conta\/emails\/[0-9a-f-]{36}_[0-9a-f]{32})/.exec(orderMail.html)[1].replace(/^https?:\/\/[^/]+/, BASE);
  const ctxB = await newContext(browser);
  const b = await ctxB.newPage();
  track(b);
  await b.goto(link, { waitUntil: 'networkidle' });
  ok(await until(async () => /Preferências de e-mail/.test(await body(b))), 'o link do e-mail abre a página de preferências (sem login)');
  const txt = await body(b);
  ok(/h\*+@exemplo\.com|h[^@]*\*[^@]*@exemplo\.com/.test(txt) && !txt.includes('hospede@exemplo.com'), 'o endereço aparece mascarado', txt.slice(0, 200));
  ok((await b.evaluate(() => document.querySelector('meta[name=robots]')?.getAttribute('content') ?? '')).includes('noindex'), 'a página não é indexável (noindex)');
  const bPromo = b.getByRole('switch', { name: 'Novidades e promoções' });
  const bOrders = b.getByRole('switch', { name: 'Avisos dos meus pedidos' });
  ok((await bPromo.isDisabled()) && (await bPromo.getAttribute('aria-checked')) === 'false' && /entre na sua conta com o e-mail confirmado/.test(await body(b)), 'sem conta, NÃO dá para ligar promoções por este link (explica o caminho)');
  ok((await bOrders.getAttribute('aria-checked')) === 'true', 'avisos de pedido começam ligados');
  await bOrders.click();
  ok(await until(async () => /não vai mais receber avisos de pedidos neste endereço/.test(await body(b))), 'desligar os avisos de pedido mostra a confirmação');
  ok(psql("select notify_orders::text from email_preferences where email = 'hospede@exemplo.com'") === 'false', 'banco: avisos de pedido desligados para o endereço');
  ok(await noHScroll(b), 'página de preferências cabe no celular');
  await b.screenshot({ path: `${SP}/emails-preferencias.png`, fullPage: true });
  await b.goto(BASE + '/conta/emails/00000000-0000-4000-8000-000000000000_00000000000000000000000000000000', { waitUntil: 'networkidle' });
  ok(await until(async () => /Link inválido ou vencido/.test(await body(b))), 'link inventado: "Link inválido ou vencido"');
  await ctxB.close();
  // Depois de desligar, o próximo aviso de pedido desse endereço fica bloqueado (e o cliente não recebe).
  const n2 = await place('hospede@exemplo.com');
  await api('PATCH', `/api/admin/orders/${psql(`select id from orders where order_number = ${n2}`)}`, { status: 'confirmed' }, ownerCookie);
  ok(await until(() => psql(`select count(*) from email_messages where recipient_email = 'hospede@exemplo.com' and status = 'blocked' and block_reason = 'order_notices_off'`) >= '1'), 'depois de desligar, os avisos seguintes do endereço ficam bloqueados');

  // =====================================================================================================
  console.log('# 4. painel (owner), celular');
  const ctxM = await newContext(browser);
  const m = await ctxM.newPage();
  track(m);
  await m.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await m.fill('#login-email', 'dono@copocheio.local');
  await m.fill('#login-senha', 'senha-forte-123');
  await m.click('button[type=submit]');
  await m.waitForURL('**/admin/dashboard');
  await m.goto(BASE + '/admin/emails', { waitUntil: 'networkidle' });
  await m.waitForSelector('text=E-mails e Entregabilidade');
  ok(await until(async () => /Como os e-mails saem: SMTP/.test(await body(m))), 'visão geral: mostra que o envio é SMTP');
  let t = await body(m);
  ok(/Entregue na caixa do destinatário/.test(t) && /Não informado: o SMTP comum não avisa a entrega/.test(t), 'visão geral: diz que o SMTP NÃO informa a entrega');
  ok(/Não informado/.test(t) && /Aceitas pelo servidor/.test(t) && /Taxa de aceitação/.test(t), 'visão geral: números honestos (aceitas pelo servidor; entrega "não informado")');
  ok(/“aceito pelo servidor” não é “chegou na caixa de entrada”/i.test(t), 'visão geral: explica que aceito não é entregue');
  ok(!/Taxa de entrega \(provedor\)/.test(t), 'visão geral: não inventa taxa de entrega');
  for (const tab of ['Visão geral', 'Mensagens', 'Promoções', 'Supressões', 'Autenticação']) {
    await m.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await wait(500);
    ok(await noHScroll(m), `celular: aba "${tab}" cabe na largura`);
  }
  await m.getByRole('tab', { name: /^Visão geral/ }).click();
  await m.screenshot({ path: `${SP}/emails-painel-celular.png`, fullPage: true });
  ok((await m.getByRole('button', { name: 'Processar fila agora' }).count()) === 1, 'owner vê "Processar fila agora"');
  await m.getByRole('button', { name: 'Processar fila agora' }).click();
  ok(await until(async () => /Nada para processar agora|processada/.test(await body(m))), 'processar a fila responde com um resumo');

  console.log('# 5. painel: mensagens');
  await m.getByRole('tab', { name: 'Mensagens' }).click();
  ok(await until(async () => /Pedido recebido/.test(await body(m))), 'mensagens: lista os e-mails enviados (pedido recebido)');
  ok(/Confirmação de e-mail \(código\)/.test(await body(m)), 'mensagens: lista também as confirmações de e-mail');
  const listText = () => m.locator('main ul').first().innerText();
  await m.getByPlaceholder('E-mail ou nº do pedido').fill('hospede@exemplo.com');
  ok(await until(async () => !/Confirmação de e-mail \(código\)/.test(await listText()) && /hospede@exemplo\.com/.test(await listText())), 'mensagens: a busca por e-mail filtra');
  ok(/Bloqueado \(não enviado\)/.test(await listText()) && /pediu para não receber e-mails de pedidos/.test(await listText()), 'mensagens: o bloqueio mostra o motivo em português');
  await m.locator('main ul li button', { hasText: 'Aceito pelo servidor' }).first().click();
  const dialog = m.getByRole('dialog');
  await dialog.waitFor();
  ok(await until(async () => /Linha do tempo/.test(await dialog.innerText())), 'detalhe: carrega');
  t = await dialog.innerText();
  ok(/Linha do tempo/.test(t) && /Aceito pelo servidor de e-mail/.test(t) && /Message-ID/.test(t), 'detalhe: linha do tempo e Message-ID', t.slice(0, 300));
  ok(!/Heineken|R\$|\b\d{6}\b/.test(t), 'detalhe: não mostra corpo, itens, valores nem códigos', t.slice(0, 300));
  await m.keyboard.press('Escape');
  await m.getByPlaceholder('E-mail ou nº do pedido').fill(String(orderNumber));
  ok(await until(async () => new RegExp(`pedido #${orderNumber}`).test(await body(m))), 'mensagens: a busca pelo número do pedido funciona');

  console.log('# 6. painel: promoções (campanha de ponta a ponta)');
  await m.getByRole('tab', { name: /^Promoções/ }).click();
  await m.waitForSelector('text=Promoções por e-mail');
  ok(/2 pessoa\(s\)|3 pessoa\(s\)/.test(await body(m)), 'promoções: mostra quantas pessoas podem receber', (await body(m)).match(/Hoje a lista tem[^.]*\./)?.[0]);
  await m.getByRole('button', { name: 'Nova campanha' }).click();
  const ed = m.getByRole('dialog', { name: 'Nova campanha' });
  await ed.waitFor();
  await ed.getByLabel('Nome (só para você)', { exact: true }).fill('Promo e2e');
  await ed.getByLabel('Assunto', { exact: true }).fill('PROMOÇÃO IMPERDÍVEL SÓ HOJE');
  ok(/Assunto todo em maiúsculas cai no spam/.test(await ed.innerText()), 'editor: avisa sobre assunto em maiúsculas');
  await ed.getByLabel('Assunto', { exact: true }).fill('Cerveja gelada com preço especial');
  await ed.getByLabel('Título dentro do e-mail', { exact: true }).fill('Sexta de promoção');
  await ed.getByLabel('Texto', { exact: true }).fill('Hoje tem cerveja gelada.\n\nPeça pelo site e receba em casa.');
  await ed.getByLabel('Texto do botão (opcional)', { exact: true }).fill('Ver ofertas');
  await ed.getByLabel('Endereço do botão (https)', { exact: true }).fill('http://exemplo.com/ofertas');
  ok(/só aceita link https/.test(await ed.innerText()), 'editor: avisa que o botão só aceita https');
  await ed.getByLabel('Endereço do botão (https)', { exact: true }).fill('https://copocheio-nu.vercel.app/bebidas');
  await ed.getByRole('button', { name: 'Salvar rascunho' }).click();
  ok(await until(async () => /Promo e2e/.test(await m.locator('main ul').first().innerText())), 'promoções: o rascunho aparece na lista');
  await m.getByRole('button', { name: 'Enviar teste para mim' }).click();
  ok(await until(async () => (await mails('dono@copocheio.local')).some((x) => /^\[Teste\] Cerveja gelada/.test(x.subject))), 'o teste chegou só para o dono, com [Teste] no assunto');
  await m.getByRole('button', { name: 'Enviar para a lista' }).click();
  const send = m.getByRole('dialog', { name: /Enviar “Promo e2e”/ });
  await send.waitFor();
  ok(/3 pessoa\(s\)/.test(await send.innerText()), 'confirmação: mostra o número exato de destinatários', (await send.innerText()).slice(0, 200));
  await send.getByRole('button', { name: /Enviar para 3 pessoa\(s\)/ }).click();
  ok(await until(async () => /Concluída/.test(await body(m)), 30000), 'a campanha termina ("Concluída") com a página aberta');
  ok(/3 enviada\(s\)/.test(await body(m)), 'andamento: 3 enviadas', (await body(m)).match(/\d+ enviada[^·]*/)?.[0]);
  const fa1 = (await mails('fa1@exemplo.com')).find((x) => x.subject === 'Cerveja gelada com preço especial');
  ok(Boolean(fa1) && /<https?:\/\/[^>]+\/api\/email\/unsubscribe\//.test(fa1.headers['list-unsubscribe']) && fa1.headers['list-unsubscribe-post'] === 'List-Unsubscribe=One-Click', 'quem aceitou recebeu a promoção com o "Cancelar inscrição" de um clique (List-Unsubscribe)');
  ok((await mails('hospede@exemplo.com')).every((x) => x.subject !== 'Cerveja gelada com preço especial'), 'quem não aceitou (visitante de pedido) NÃO recebeu a promoção');
  await m.screenshot({ path: `${SP}/emails-campanhas-celular.png`, fullPage: true });

  console.log('# 7. painel: supressões e autenticação');
  await m.getByRole('tab', { name: /^Supressões/ }).click();
  await m.getByPlaceholder('pessoa@exemplo.com').fill('bloqueado-e2e@exemplo.com');
  await m.getByRole('button', { name: 'Adicionar' }).click();
  ok(await until(async () => /bloqueado-e2e@exemplo\.com/.test(await body(m))), 'supressões: o endereço entra na lista');
  ok(psql("select reason || ':' || source from email_suppressions where email = 'bloqueado-e2e@exemplo.com'") === 'manual:admin', 'banco: motivo "manual" pelo painel');
  await m.getByRole('button', { name: 'Liberar' }).first().click();
  await m.getByRole('button', { name: 'Liberar endereço' }).click();
  ok(await until(() => psql("select count(*) from email_suppressions where email = 'bloqueado-e2e@exemplo.com'") === '0'), 'supressões: liberar o endereço o tira da lista (com confirmação)');
  await m.getByRole('tab', { name: /^Autenticação/ }).click();
  await m.getByRole('button', { name: 'Verificar agora' }).click();
  ok(await until(async () => /Base certa/.test(await body(m))), 'autenticação: o DNS de teste aparece como "Base certa"');
  t = await body(m);
  ok(/SPF presente/.test(t) && /DMARC em modo de monitoramento \(p=none\)/.test(t) && /Chave DKIM encontrada/.test(t), 'autenticação: SPF, DKIM e DMARC (p=none) explicados');
  ok(/Mostrar original/.test(t) && /Authentication-Results/.test(t), 'autenticação: traz o passo a passo para conferir o cabeçalho no Gmail e no Outlook');
  ok(await noHScroll(m), 'autenticação cabe no celular');
  ok((await m.getByRole('button', { name: 'Enviar exemplos para mim' }).count()) === 1, 'autenticação: o owner vê "Enviar exemplos para mim"');
  const testes = async () => (await mails('dono@copocheio.local')).filter((x) => x.subject.startsWith('[Teste] ')).length;
  const antesExemplos = await testes();
  await m.getByRole('button', { name: 'Enviar exemplos para mim' }).click();
  ok(await until(async () => (await testes()) - antesExemplos === 7, 30000), 'exemplos: chegaram 7 e-mails de teste para o dono');
  const listaExemplos = m.locator('ul[aria-live="polite"]').filter({ hasText: 'Pedido saiu para entrega' });
  ok(await until(async () => (await listaExemplos.locator('li').count()) === 7), 'exemplos: a tela lista os 7 modelos enviados');
  const textoExemplos = await listaExemplos.innerText();
  ok(['Confirmação de e-mail', 'Nova senha', 'Pedido recebido', 'Pagamento confirmado', 'Pedido saiu para entrega', 'Pedido cancelado', 'Promoção'].every((l) => textoExemplos.includes(l)) && !/falhou/.test(textoExemplos), 'exemplos: todos os modelos aparecem como enviados, sem falha', textoExemplos);
  ok(await noHScroll(m), 'autenticação com os exemplos cabe no celular');
  await m.screenshot({ path: `${SP}/emails-autenticacao-celular.png`, fullPage: true });

  console.log('# 7b. painel: atalhos "E-mails enviados" em Clientes e no pedido');
  await m.goto(BASE + '/admin/clientes', { waitUntil: 'networkidle' });
  const linkCliente = m.locator('a[href="/admin/emails?aba=mensagens&q=fa1%40exemplo.com"]');
  ok(await until(async () => (await linkCliente.count()) === 1), 'clientes: o cartão do cliente tem o atalho "E-mails enviados"');
  await linkCliente.click();
  await m.waitForURL('**/admin/emails?aba=mensagens&q=fa1%40exemplo.com');
  ok(await until(async () => (await m.getByPlaceholder('E-mail ou nº do pedido').inputValue()) === 'fa1@exemplo.com'), 'o atalho abre as mensagens já filtradas pelo e-mail do cliente');
  ok(await until(async () => /fa1@exemplo\.com/.test(await m.locator('main ul').first().innerText()) && !/fa2@exemplo\.com/.test(await m.locator('main ul').first().innerText())), 'e só aparecem os e-mails daquele cliente');
  await m.goto(BASE + `/admin/pedidos/${orderNumber}`, { waitUntil: 'networkidle' });
  const linkPedido = m.locator(`a[href="/admin/emails?aba=mensagens&q=${orderNumber}"]`);
  ok(await until(async () => (await linkPedido.count()) === 1), 'pedido: o detalhe tem o atalho "E-mails enviados deste pedido"');
  await linkPedido.click();
  await m.waitForURL(`**/admin/emails?aba=mensagens&q=${orderNumber}`);
  ok(await until(async () => new RegExp(`pedido #${orderNumber}`).test(await m.locator('main ul').first().innerText())), 'o atalho abre as mensagens daquele pedido');
  ok(await noHScroll(m), 'mensagens filtradas cabem no celular');
  await ctxM.close();

  console.log('# 8. painel (owner), computador');
  const ctxD = await newContext(browser, { width: 1280, height: 900 });
  const d = await ctxD.newPage();
  track(d);
  await d.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await d.fill('#login-email', 'dono@copocheio.local');
  await d.fill('#login-senha', 'senha-forte-123');
  await d.click('button[type=submit]');
  await d.waitForURL('**/admin/dashboard');
  ok((await d.getByRole('link', { name: 'E-mails' }).count()) >= 1, 'o menu do painel tem "E-mails"');
  await d.getByRole('link', { name: 'E-mails' }).first().click();
  await d.waitForURL('**/admin/emails');
  ok(await until(async () => /Mensagens por dia/.test(await body(d))), 'computador: visão geral com o gráfico por dia');
  await d.screenshot({ path: `${SP}/emails-painel-desktop.png`, fullPage: true });
  ok(await noHScroll(d), 'computador: sem rolagem horizontal');
  await ctxD.close();

  console.log('# 9. administrador comum: só consulta');
  const ctxT = await newContext(browser);
  const tpage = await ctxT.newPage();
  track(tpage);
  await tpage.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await tpage.fill('#login-email', 'atendente-e@copocheio.local');
  await tpage.fill('#login-senha', 'Atendente!Segura-2026');
  await tpage.click('button[type=submit]');
  await tpage.waitForURL('**/admin/dashboard');
  await tpage.goto(BASE + '/admin/emails', { waitUntil: 'networkidle' });
  ok(await until(async () => /Como os e-mails saem/.test(await body(tpage))), 'administrador comum vê a visão geral');
  ok((await tpage.getByRole('button', { name: 'Processar fila agora' }).count()) === 0, 'administrador comum NÃO vê "Processar fila agora"');
  await tpage.getByRole('tab', { name: /^Promoções/ }).click();
  await tpage.waitForSelector('text=Promoções por e-mail');
  ok((await tpage.getByRole('button', { name: 'Nova campanha' }).count()) === 0 && /Só o owner cria, testa e envia campanhas/.test(await body(tpage)), 'administrador comum NÃO vê "Nova campanha" e a tela explica por quê');
  await tpage.getByRole('tab', { name: /^Supressões/ }).click();
  await tpage.waitForSelector('text=Lista de supressão');
  ok((await tpage.getByRole('button', { name: 'Adicionar' }).count()) === 0 && /Só o owner coloca ou libera endereços/.test(await body(tpage)), 'administrador comum NÃO vê "Adicionar" na lista de supressão');
  await tpage.getByRole('tab', { name: /^Autenticação/ }).click();
  ok(await until(async () => /Conferir os e-mails de verdade/.test(await body(tpage))), 'administrador comum vê a aba Autenticação');
  ok((await tpage.getByRole('button', { name: 'Enviar exemplos para mim' }).count()) === 0 && /Só o owner envia os exemplos/.test(await body(tpage)), 'administrador comum NÃO vê "Enviar exemplos para mim" e a tela explica por quê');
  const directSamples = await tpage.evaluate(() => fetch('/api/admin/emails/samples', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status));
  ok(directSamples === 403, 'e o servidor recusa os exemplos pedidos direto pelo administrador comum (403)');
  const direct = await tpage.evaluate(() => fetch('/api/admin/emails/process', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.status));
  ok(direct === 403, 'e o servidor recusa a ação direta do administrador comum (403)');
  await ctxT.close();

  ok(errors.length === 0, 'nenhum erro de JavaScript/console nas telas', errors.slice(0, 5));
  await browser.close();
  console.log(`\n${fails ? 'FALHOU' : 'OK'}: ${passes} checks passaram, ${fails} falharam`);
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
