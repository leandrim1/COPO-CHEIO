// End-to-end: painel + site público + checkout + pedidos ao vivo (polling), contra Neon (Postgres local) + Blob (falso).
// usage: tests/serve.sh && tests/reset.sh && node tests/e2e.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const { execSync } = require('child_process');
const SP = process.env.TEST_OUT || require('node:path').join(require('node:os').tmpdir(), 'copocheio-tests');
require('node:fs').mkdirSync(SP, { recursive: true });
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180';
const BLOB = 'http://127.0.0.1:4181';
const psql = (q) => execSync(`psql -h 127.0.0.1 -p 5433 -U postgres copocheio_test -At -c "${q}"`).toString().trim();
let fails = 0;
const requests = [];
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const shot = (page, name) => page.screenshot({ path: `${SP}/e2e-${name}.png`, fullPage: false });

async function newPage(browser, viewport, errors) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  // As imagens do Vercel Blob vêm do Blob falso local.
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const res = await route.fetch({ url: BLOB + '/f' + path });
    await route.fulfill({ response: res });
  });
  // O mapa do Google (iframe da seção Contato) não é carregado de verdade: com internet (como no GitHub Actions) ele puxaria scripts de
  // outros domínios do Google e o teste deixaria de ser hermético. A resposta é uma página vazia e a requisição do iframe continua registrada.
  await ctx.route(/^https:\/\/www\.google\.com\/maps/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>mapa</title>' }));
  page.on('request', (r) => requests.push(r.url()));
  // Respostas de erro da API (menos 401/404 esperados) vão para a saída: ajuda a achar o motivo quando um passo trava.
  page.on('response', async (r) => {
    if (r.url().includes('/api/') && r.status() >= 400 && ![401, 404].includes(r.status())) console.log(`   [api ${r.status()}] ${r.request().method()} ${new URL(r.url()).pathname} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return page;
}

const toastText = (page) => page.evaluate(() => [...document.querySelectorAll('[aria-live="polite"] [role=status], [aria-live="polite"] [role=alert]')].map((t) => t.textContent).join(' | '));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const adminPage = await newPage(browser, { width: 1440, height: 900 }, errors);
  await adminPage.addInitScript(() => {
    window.__osc = 0;
    window.__printed = 0;
    window.print = () => window.__printed++;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__osc++;
      return orig.call(this);
    };
  });
  const a = adminPage;

  console.log('# auth / route protection');
  await a.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
  ok(new URL(a.url()).pathname === '/admin/login', 'not logged in: /admin/pedidos redirects to /admin/login');
  ok(!(await a.evaluate(() => /Pedidos recentes|NOVO PEDIDO|Faturamento/.test(document.body.innerText))), 'login page shows no admin data');
  await a.fill('#login-email', 'dono@copocheio.local');
  await a.fill('#login-senha', 'errada-123');
  await a.click('button[type=submit]');
  await a.waitForSelector('[role=alert]');
  ok(/E-mail ou senha incorretos/.test(await a.textContent('[role=alert]')), 'wrong password shows an error');
  await a.fill('#login-email', 'ninguem@copocheio.local');
  await a.fill('#login-senha', 'senha-forte-123');
  await a.click('button[type=submit]');
  await a.waitForFunction(() => /E-mail ou senha incorretos/.test(document.body.innerText));
  ok(true, 'unknown e-mail gets the same message');
  await shot(a, 'login');
  await a.fill('#login-email', 'dono@copocheio.local');
  await a.fill('#login-senha', 'senha-forte-123');
  await a.click('button[type=submit]');
  await a.waitForURL('**/admin/dashboard', { timeout: 15000 });
  await a.waitForSelector('text=Faturamento do dia');
  ok(true, 'owner logs in → /admin/dashboard');
  ok(!(await a.evaluate(() => document.cookie.includes('copocheio_admin'))), 'session cookie is HttpOnly (not readable by JavaScript)');
  ok(!(await a.evaluate(() => JSON.stringify({ ...localStorage }).match(/token|session|jwt/i))), 'no token/session kept in localStorage');
  await a.reload({ waitUntil: 'networkidle' });
  await a.waitForSelector('text=Faturamento do dia');
  ok(new URL(a.url()).pathname === '/admin/dashboard', 'session survives a reload');
  await a.waitForTimeout(1200);
  await shot(a, 'dashboard-empty');

  console.log('# categories');
  await a.click('nav[aria-label="Menu do painel"] >> text=Categorias');
  await a.waitForSelector('text=Nenhuma categoria');
  for (const name of ['Cervejas', 'Refrigerantes', 'Gelo']) {
    await a.getByRole('button', { name: /Nova categoria|Criar categoria/ }).first().click();
    await a.getByPlaceholder('Ex.: Cervejas').fill(name);
    await a.getByRole('button', { name: 'Salvar' }).click();
    await a.waitForSelector(`li >> text=${name}`);
  }
  ok((await a.locator('main li').count()) === 3, '3 categories created');
  await a.getByRole('button', { name: 'Subir Refrigerantes' }).click();
  await a.waitForTimeout(800);
  const catOrder = await a.$$eval('main li p.truncate', (els) => els.map((e) => e.textContent));
  ok(catOrder.join(',') === 'Refrigerantes,Cervejas,Gelo', 'reorder categories ' + catOrder.join(','));
  await a.getByRole('button', { name: 'Nova categoria' }).click();
  await a.getByPlaceholder('Ex.: Cervejas').fill('gelo');
  await a.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Já existe uma categoria com esse nome.');
  ok(true, 'duplicate category name refused');
  await a.keyboard.press('Escape');

  console.log('# products');
  async function createProduct({ name, price, category, featured, stock, image, description }) {
    await a.goto(BASE + '/admin/produtos/novo', { waitUntil: 'networkidle' });
    await a.getByPlaceholder('Ex.: Coca-Cola 2L').fill(name);
    if (description) await a.getByLabel('Descrição').fill(description);
    await a.getByLabel('Preço *').fill(price);
    await a.getByLabel('Categoria').selectOption({ label: category });
    if (image) await a.setInputFiles('input[type=file][aria-label="Foto do produto"]', image);
    if (stock !== undefined) {
      await a.getByRole('switch', { name: 'Controlar estoque' }).click();
      await a.getByLabel('Estoque atual').fill(String(stock));
    }
    if (featured) await a.getByRole('switch', { name: 'Produto em destaque' }).click();
    await a.getByRole('button', { name: 'Salvar produto' }).click();
    await a.waitForURL('**/admin/produtos', { timeout: 15000 });
    await a.waitForSelector(`text=${name}`);
  }
  await createProduct({ name: 'Coca-Cola 2L', price: '12,00', category: 'Refrigerantes', image: FX + '/lata.webp', description: 'Refrigerante bem gelado.' });
  ok((await toastText(a)).includes('Produto cadastrado.'), 'toast "Produto cadastrado."');
  await createProduct({ name: 'Heineken Long Neck', price: '8,90', category: 'Cervejas', featured: true });
  await createProduct({ name: 'Gelo 5kg', price: '10,00', category: 'Gelo', stock: 3 });
  const thumb = await a.$eval('img[alt="Coca-Cola 2L"]', (img) => img.src);
  ok(/^https:\/\/teststore\.public\.blob\.vercel-storage\.com\/products\/[0-9a-f-]{36}\.webp$/.test(thumb), 'image uploaded to Vercel Blob (WebP) ' + thumb);
  ok(psql("select image_url from products where name='Coca-Cola 2L'") === thumb, 'Neon stores only the Blob URL: ' + thumb);
  ok(Number(psql("select count(*) from products where image_url like 'data:%'")) === 0, 'no base64 image in the database');
  await shot(a, 'produtos');

  const site = await newPage(browser, { width: 1440, height: 900 }, errors);
  const bebidasText = async () => {
    await site.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await site.waitForSelector('text=Coca-Cola 2L');
    return site.evaluate(() => document.body.innerText);
  };
  let text = await bebidasText();
  ok(/Coca-Cola 2L[\s\S]*R\$\s?12,00/.test(text), 'site shows Coca-Cola 2L R$ 12,00');
  ok(/Os favoritos da galera[\s\S]*Heineken Long Neck/.test(text), 'featured product appears in "Os favoritos da galera"');
  const chips = await site.$$eval('[aria-label="Categorias"] button', (b) => b.map((x) => x.textContent));
  ok(chips.join(',') === 'Refrigerantes,Cervejas,Gelo', 'site categories follow the panel order ' + chips.join(','));
  ok(await site.$eval('img[alt="Coca-Cola 2L"]', (img) => img.complete && img.naturalWidth > 0), 'product image loads on the site');

  // price change
  await a.click('text=Coca-Cola 2L');
  await a.waitForURL(/\/admin\/produtos\/[0-9a-f-]{36}$/);
  await a.getByLabel('Preço *').fill('13,00');
  await a.getByRole('button', { name: 'Salvar produto' }).click();
  await a.waitForURL('**/admin/produtos');
  text = await bebidasText();
  ok(/Coca-Cola 2L[\s\S]*R\$\s?13,00/.test(text) && !/R\$\s?12,00/.test(text), 'price change R$ 13,00 shows on the site');
  // promo
  await a.click('text=Coca-Cola 2L');
  await a.getByLabel('Preço promocional').fill('14,00');
  await a.getByRole('button', { name: 'Salvar produto' }).click();
  ok(await a.waitForSelector('text=O preço promocional precisa ser menor que o preço.').then(() => true), 'promo price ≥ price is refused in the form');
  await a.getByLabel('Preço promocional').fill('');
  await a.getByRole('button', { name: 'Cancelar' }).click();

  // sold out
  await a.waitForURL('**/admin/produtos');
  const cocaRow = a.locator('tr', { hasText: 'Coca-Cola 2L' });
  await cocaRow.getByRole('button', { name: 'Esgotar' }).click();
  await a.waitForSelector('text=Produto marcado como esgotado.');
  text = await bebidasText();
  const cocaSite = await site.locator('li', { hasText: 'Coca-Cola 2L' }).first().innerText();
  ok(/ESGOTADO/.test(cocaSite) && !(await site.locator('button[aria-label="Adicionar Coca-Cola 2L ao pedido"]').count()), 'sold-out product shows ESGOTADO and cannot be added');
  await site.screenshot({ path: `${SP}/e2e-site-esgotado.png` });
  await cocaRow.getByRole('button', { name: 'Disponibilizar' }).click();
  await a.waitForSelector('text=Produto disponível novamente.');

  // deactivate → disappears
  await a.locator('tr', { hasText: 'Gelo 5kg' }).getByRole('switch').click();
  await a.waitForSelector('text=Produto desativado: saiu do site.');
  text = await bebidasText();
  ok(!/Gelo 5kg/.test(text), 'deactivated product disappears from the site');
  await a.locator('tr', { hasText: 'Gelo 5kg' }).getByRole('switch').click();
  await a.waitForSelector('text=Produto ativado no site.');

  // duplicate + delete
  await a.locator('tr', { hasText: 'Heineken Long Neck' }).getByRole('button', { name: 'Mais ações' }).click();
  await a.getByRole('menuitem', { name: 'Duplicar' }).click();
  await a.waitForURL(/\/admin\/produtos\/[0-9a-f-]{36}$/);
  ok((await a.getByPlaceholder('Ex.: Coca-Cola 2L').inputValue()) === 'Heineken Long Neck (cópia)', 'duplicate opens the copy (inactive)');
  await a.getByRole('button', { name: 'Excluir' }).click();
  await a.getByRole('button', { name: 'Excluir produto' }).click();
  await a.waitForURL('**/admin/produtos');
  await a.waitForSelector('text=Produto excluído com sucesso.');
  ok(!(await a.locator('text=Heineken Long Neck (cópia)').count()), 'confirm dialog → "Produto excluído com sucesso."');

  console.log('# settings → site');
  await a.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await a.getByLabel('WhatsApp da loja').fill('34988887777');
  await a.getByLabel('Instagram').fill('@copocheio.teste');
  await a.getByLabel('Endereço').fill('Rua das Flores, 100');
  await a.getByLabel('Cidade').fill('Uberlândia');
  await a.getByLabel('Estado').selectOption('MG');
  await a.getByRole('button', { name: 'Salvar', exact: true }).click();
  await a.waitForSelector('text=Dados da loja salvos.');
  await a.getByRole('tab', { name: 'Horários' }).click();
  await a.getByLabel('Sábado: abre às').waitFor({ state: 'detached' }).catch(() => {});
  const satRow = a.locator('li', { hasText: 'Sábado' });
  await satRow.getByRole('switch').click();
  await a.getByLabel('Sábado: abre às').fill('10:00');
  await a.getByLabel('Sábado: fecha às').fill('02:00');
  await a.getByRole('button', { name: 'Salvar', exact: true }).click();
  await a.waitForSelector('text=Horários salvos.');
  await a.getByRole('tab', { name: 'Pagamento' }).click();
  await a.getByLabel('Chave PIX').fill('pix@copocheio.teste');
  await a.getByRole('button', { name: 'Salvar', exact: true }).click();
  await a.waitForSelector('text=Pagamentos salvos.');
  ok(psql("select details from payment_methods where code='pix'") === 'pix@copocheio.teste', 'PIX key saved in Neon (payment_methods)');
  await site.goto(BASE + '/', { waitUntil: 'networkidle' });
  await site.waitForFunction(() => /copocheio\.teste/.test(document.body.innerText));
  const wa = await site.$$eval('#contato a[href^="https://wa.me/"]', (els) => els.map((e) => e.getAttribute('href').split('?')[0]));
  ok(wa.length > 0 && wa.every((h) => h === 'https://wa.me/5534988887777'), 'WhatsApp buttons use the new number ' + JSON.stringify([...new Set(wa)]));
  const contact = await site.$eval('#contato', (e) => e.innerText);
  ok(/@copocheio\.teste/.test(contact), 'Instagram updated on the site');
  ok(/Segunda a Sexta: 09:00 às 23:00/.test(contact) && /Sábado: 10:00 às 02:00/.test(contact) && /Domingo: fechado/.test(contact), 'hours updated on the site');
  // O resto do teste faz pedidos: depois de conferir os horários acima, deixa a loja aberta o dia todo. Sem isto o teste só passa
  // se a hora em que roda cair numa janela aberta (ex.: domingo de manhã a loja fecha e o "Finalizar pedido" fica desligado).
  {
    const allDay = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '23:59' }]));
    const res = await a.context().request.patch(BASE + '/api/admin/store', { data: { opening_hours: allDay } });
    ok(res.status() === 200, 'store kept open all day for the rest of the run (so the result does not depend on the time of day)');
  }
  ok(/Rua das Flores, 100, Uberlândia - MG/.test(contact) && (await site.$('#contato iframe')) !== null, 'address + map on the site');
  await site.$eval('#contato', (e) => e.scrollIntoView());
  await site.waitForTimeout(500);
  await site.screenshot({ path: `${SP}/e2e-site-contato.png` });

  console.log('# site content (hero)');
  await a.goto(BASE + '/admin/site', { waitUntil: 'networkidle' });
  const heroCard = a.locator('section', { hasText: 'A primeira tela do site' });
  await heroCard.getByLabel('Título', { exact: true }).fill('Sua cerveja gelada chega até você.');
  await heroCard.getByLabel('Trecho do título em azul').fill('cerveja gelada');
  await heroCard.getByLabel('Botão principal').fill('Peça já');
  await heroCard.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Hero salvo.');
  await site.goto(BASE + '/', { waitUntil: 'networkidle' });
  await site.waitForFunction(() => /cerveja gelada/.test(document.querySelector('h1').textContent));
  ok((await site.$eval('h1 span', (e) => e.textContent)) === 'cerveja gelada' && /Peça já/.test(await site.$eval('#inicio main', (e) => e.innerText)), 'hero title, blue highlight and button text come from the panel');
  await heroCard.getByLabel('Trecho do título em azul').fill('não existe');
  await heroCard.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Esse trecho precisa estar escrito igual no título.');
  ok(true, 'highlight that is not in the title is refused');
  await heroCard.getByRole('button', { name: 'Textos originais' }).click();
  await heroCard.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Hero salvo.');

  console.log('# banners');
  await a.goto(BASE + '/admin/banners', { waitUntil: 'networkidle' });
  await a.getByRole('button', { name: 'Novo banner' }).click();
  await a.setInputFiles('input[type=file][aria-label="Imagem desktop"]', FX + '/cover-desk.webp');
  await a.getByLabel('Título', { exact: true }).fill('Combo da semana');
  await a.getByLabel('Subtítulo').fill('2 Heineken + gelo com preço especial');
  await a.getByLabel('Texto do botão').fill('Aproveitar');
  await a.getByRole('button', { name: 'Salvar banner' }).click();
  await a.waitForSelector('text=Banner criado.');
  text = await bebidasText();
  ok(/Combo da semana/.test(text) && /Aproveitar/.test(text), 'banner appears on the Bebidas page');
  await site.screenshot({ path: `${SP}/e2e-site-bebidas.png` });

  console.log('# checkout + realtime');
  await a.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
  await a.waitForSelector('text=Ao vivo', { timeout: 15000 });
  ok(true, 'admin live polling connected ("Ao vivo")');
  const c = await newPage(browser, { width: 390, height: 844 }, errors);
  await c.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await c.click('button[aria-label="Adicionar Heineken Long Neck ao pedido"] >> nth=0');
  await c.click('button[aria-label="Aumentar Heineken Long Neck"] >> nth=0');
  await c.click('button[aria-label="Adicionar Gelo 5kg ao pedido"]');
  await c.waitForTimeout(400);
  await c.locator('button', { hasText: 'Ver pedido' }).last().click();
  await c.waitForTimeout(500);
  await c.screenshot({ path: `${SP}/e2e-cliente-gaveta.png` });
  await c.getByRole('link', { name: /Finalizar pedido/ }).click();
  await c.waitForURL('**/checkout');
  ok(await noHScroll(c), 'checkout fits the phone width');
  await c.getByRole('button', { name: /Finalizar pedido/ }).click();
  ok(await c.waitForSelector('text=Informe seu nome.').then(() => true), 'checkout validates required fields');
  await c.getByLabel('Nome *').fill('João Silva');
  await c.getByLabel('Telefone / WhatsApp *').fill('34999990000');
  ok((await c.getByLabel('Telefone / WhatsApp *').inputValue()) === '(34) 99999-0000', 'phone mask');
  await c.getByLabel('Rua / Avenida *').fill('Rua A');
  await c.getByLabel('Número *').fill('123');
  await c.getByLabel('Bairro *').fill('Centro');
  await c.getByLabel('Complemento').fill('Apto 2');
  await c.getByLabel('Ponto de referência').fill('Perto da praça');
  await c.getByLabel('Observações').fill('Bem gelada, por favor');
  const summary = await c.locator('aside').innerText();
  ok(/Subtotal\s*R\$\s?27,80/.test(summary) && /Entrega\s*R\$\s?5,00/.test(summary) && /R\$\s?32,80/.test(summary), 'summary: subtotal 27,80 + entrega 5,00 = 32,80');
  await c.screenshot({ path: `${SP}/e2e-checkout.png`, fullPage: true });
  await c.waitForTimeout(700); // o site só aceita pedido depois de 0,6 s na tela
  await c.getByRole('button', { name: /Finalizar pedido · R\$/ }).click();
  await c.waitForURL(/\/pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/, { timeout: 15000 });
  await c.waitForSelector('text=Pedido recebido!');
  const orderText = await c.evaluate(() => document.body.innerText);
  const num = (/Seu pedido #(\d+) foi enviado para a Copo Cheio\./.exec(orderText) || [])[1];
  ok(!!num, `"Pedido recebido!" + "Seu pedido #${num} foi enviado para a Copo Cheio."`);
  const waHref = await c.getByRole('link', { name: 'Compartilhar pelo WhatsApp' }).first().getAttribute('href');
  const msg = decodeURIComponent(waHref.split('?text=')[1]);
  console.log('--- WhatsApp message ---\n' + msg + '\n------------------------');
  ok(waHref.startsWith('https://wa.me/5534988887777?text='), 'WhatsApp goes to the number set in the panel');
  ok(msg.startsWith(`Olá, Copo Cheio! Quero fazer o pedido #${num}.`) && /Cliente:\nJoão Silva/.test(msg) && /Itens:\n(2x Heineken Long Neck\n1x Gelo 5kg|1x Gelo 5kg\n2x Heineken Long Neck)\n/.test(msg) && /Total:\nR\$\s?32,80/.test(msg) && /Entrega:\nRua A, 123\nCentro – Apto 2\nReferência: Perto da praça/.test(msg) && /Pagamento:\nPIX/.test(msg) && /Observações:\nBem gelada, por favor/.test(msg) && /\n\nAcompanhar pedido:\nhttps?:\/\/[^/]+\/acompanhar-pedido\/[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/.test(msg), 'WhatsApp message follows the template and ends with the tracking link');
  ok(/Chave PIX/.test(orderText) && /pix@copocheio\.teste/.test(orderText), 'order page shows the PIX key set in the panel');
  await c.screenshot({ path: `${SP}/e2e-pedido-recebido.png`, fullPage: true });
  const cartAfter = await c.evaluate(() => localStorage.getItem('copocheio:pedido'));
  ok(cartAfter === '{}', 'cart cleared after the order');

  // admin got it without reloading
  await a.waitForSelector(`text=Pedido #${num} recebido`, { timeout: 20000 });
  ok(true, 'admin toast "NOVO PEDIDO – Pedido #' + num + ' recebido" without reload (polling)');
  ok(/NOVO PEDIDO/.test(await toastText(a)) && /R\$\s?32,80/.test(await toastText(a)), 'toast shows the total');
  await a.waitForSelector(`a:has-text("#${num}")`);
  ok(true, 'order appears in the list in real time');
  ok((await a.evaluate(() => window.__osc)) >= 3, 'new-order sound played (oscillators: ' + (await a.evaluate(() => window.__osc)) + ')');
  ok(/\(1\) Novo pedido/.test(await a.title()), 'tab title shows the new order: ' + (await a.title()));
  await shot(a, 'pedidos-novo');

  console.log('# order detail + status flow');
  await a.click(`a:has-text("#${num}")`);
  await a.waitForSelector(`h1:has-text("PEDIDO #${num}")`);
  const detail = await a.evaluate(() => document.querySelector('main').innerText);
  ok(/João Silva/.test(detail) && /\(34\) 99999-0000/.test(detail) && /2x Heineken Long Neck/.test(detail) && /Rua A, 123/.test(detail) && /Perto da praça/.test(detail) && /PIX/.test(detail) && /Bem gelada/.test(detail) && /TOTAL\s*R\$\s?32,80/.test(detail), 'detail shows client, items, address, payment, notes, total');
  for (const label of ['CONFIRMAR PEDIDO', 'EM PREPARO', 'SAIU PARA ENTREGA', 'ENTREGUE']) {
    await a.getByRole('button', { name: label, exact: true }).click();
    await a.waitForSelector('text=Pedido atualizado.');
    await a.waitForTimeout(600);
  }
  const hist = await a.locator('section', { hasText: 'Histórico' }).innerText();
  ok(/NOVO → CONFIRMADO/.test(hist) && /CONFIRMADO → EM PREPARO/.test(hist) && /EM PREPARO → EM ENTREGA/.test(hist) && /EM ENTREGA → ENTREGUE/.test(hist) && /Dono Teste/.test(hist), 'history: each change with date and admin name');
  ok(/\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}/.test(hist), 'history has dd/mm/yyyy hh:mm');
  await a.getByRole('button', { name: 'Pago' }).click();
  await a.waitForSelector('text=Pagamento atualizado.');
  await a.getByRole('button', { name: 'Imprimir' }).click();
  ok((await a.evaluate(() => window.__printed)) === 1, 'print button calls window.print()');
  await a.emulateMedia({ media: 'print' });
  await a.screenshot({ path: `${SP}/e2e-recibo.png` });
  ok(await a.$eval('#recibo', (e) => getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility === 'visible'), 'printable receipt visible in print mode');
  await a.emulateMedia({ media: 'screen' });
  await shot(a, 'pedido-detalhe');
  await c.reload({ waitUntil: 'networkidle' });
  ok(/ENTREGUE/.test(await c.evaluate(() => document.body.innerText)), 'customer page shows the new status');

  console.log('# stock');
  await a.goto(BASE + '/admin/estoque', { waitUntil: 'networkidle' });
  const geloStock = await a.locator('li', { hasText: 'Gelo 5kg' }).locator('[aria-label^="Estoque:"]').textContent();
  ok(geloStock === '2', 'order took 1 from the Gelo stock (3 → 2): ' + geloStock);
  await a.locator('li', { hasText: 'Gelo 5kg' }).getByRole('button', { name: 'Retirar 1 de Gelo 5kg' }).click();
  await a.waitForTimeout(700);
  await a.locator('li', { hasText: 'Gelo 5kg' }).getByRole('button', { name: 'Retirar 1 de Gelo 5kg' }).click();
  await a.waitForTimeout(900);
  ok(/Esgotado/.test(await a.locator('li', { hasText: 'Gelo 5kg' }).innerText()), 'stock 0 → ESGOTADO automatically');
  text = await bebidasText();
  ok(/ESGOTADO/.test(await site.locator('li', { hasText: 'Gelo 5kg' }).first().innerText()), 'site shows Gelo ESGOTADO');
  await a.locator('li', { hasText: 'Gelo 5kg' }).getByLabel('Quantidade para Gelo 5kg').fill('10');
  await a.locator('li', { hasText: 'Gelo 5kg' }).getByRole('button', { name: '+ Adicionar' }).click();
  await a.waitForTimeout(900);
  ok(/Disponível/.test(await a.locator('li', { hasText: 'Gelo 5kg' }).innerText()), '+10 → available again');
  await shot(a, 'estoque');

  console.log('# simultaneous orders');
  await a.goto(BASE + '/admin/dashboard', { waitUntil: 'networkidle' });
  const before = Number(await a.locator('a', { hasText: 'Pedidos de hoje' }).locator('p').textContent());
  const buyers = await Promise.all([0, 1].map(() => newPage(browser, { width: 390, height: 844 }, errors)));
  const submit = async (p, i) => {
    await p.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await p.click('button[aria-label="Adicionar Coca-Cola 2L ao pedido"]');
    await p.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
    await p.getByLabel('Nome *').fill(`Cliente ${i + 1}`);
    await p.getByLabel('Telefone / WhatsApp *').fill(`3497777000${i}`);
    await p.getByRole('radio', { name: /Retirar na loja/ }).check({ force: true });
    await p.getByRole('radio', { name: /Dinheiro/ }).check({ force: true });
    await p.getByLabel('Troco para quanto? (opcional)').fill('50');
  };
  await Promise.all(buyers.map(submit));
  await Promise.all(buyers.map((p) => p.waitForTimeout(700)));
  await Promise.all(buyers.map((p) => p.getByRole('button', { name: /Finalizar pedido · R\$/ }).click()));
  await Promise.all(buyers.map((p) => p.waitForSelector('text=Pedido recebido!', { timeout: 15000 })));
  await a.waitForFunction((n) => Number([...document.querySelectorAll('a')].find((x) => /Pedidos de hoje/.test(x.textContent))?.querySelector('p')?.textContent) === n + 2, before, { timeout: 25000 });
  ok(true, `dashboard "Pedidos de hoje" ${before} → ${before + 2} without reload`);
  const recent = await a.locator('section', { hasText: 'Pedidos recentes' }).innerText();
  ok(/Cliente 1/.test(recent) && /Cliente 2/.test(recent), 'both simultaneous orders in "Pedidos recentes"');
  await a.waitForTimeout(1500);
  await shot(a, 'dashboard');
  ok(await a.evaluate(() => document.querySelectorAll('svg[role=group] path').length > 0), 'charts rendered');
  await a.locator('svg[role=group]').first().locator('rect[tabindex="0"]').last().hover();
  await a.waitForTimeout(200);
  ok(await a.evaluate(() => /R\$/.test(document.querySelector('.pointer-events-none.absolute.z-10')?.textContent ?? '')), 'chart tooltip on hover');
  await a.getByRole('button', { name: 'Hoje', exact: true }).click();
  await a.waitForTimeout(1200);
  ok((await a.locator('svg[role=group]').first().locator('rect[tabindex="0"]').count()) === 24, 'Hoje = 24 hourly bars');
  await a.getByRole('button', { name: '30 dias' }).click();
  await a.waitForTimeout(1200);
  ok((await a.locator('svg[role=group]').first().locator('rect[tabindex="0"]').count()) === 30, '30 dias = 30 daily bars');
  const topProducts = await a.locator('section', { hasText: 'Produtos mais vendidos' }).innerText();
  ok(/Heineken Long Neck/.test(topProducts) && /Coca-Cola 2L/.test(topProducts), 'top products listed');

  console.log('# orders filters/search');
  await a.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
  await a.getByRole('button', { name: /^Entregues/ }).click();
  await a.waitForTimeout(800);
  ok((await a.locator('tbody tr').count()) === 1, 'filter Entregues');
  await a.getByRole('button', { name: /^Todos/ }).click();
  await a.getByPlaceholder('Número, nome, telefone ou e-mail').fill('Cliente 2');
  await a.waitForTimeout(1000);
  ok((await a.locator('tbody tr').count()) === 1 && /Cliente 2/.test(await a.locator('tbody').innerText()), 'search by name');
  await a.getByPlaceholder('Número, nome, telefone ou e-mail').fill('99999');
  await a.waitForTimeout(1000);
  ok((await a.locator('tbody tr').count()) === 1 && /João Silva/.test(await a.locator('tbody').innerText()), 'search by phone');
  await a.getByPlaceholder('Número, nome, telefone ou e-mail').fill(num);
  await a.waitForTimeout(1000);
  ok((await a.locator('tbody tr').count()) === 1, 'search by order number');
  await a.getByPlaceholder('Número, nome, telefone ou e-mail').fill('');
  await a.waitForTimeout(800);
  const row = a.locator('tr', { hasText: 'Cliente 1' });
  await row.getByRole('button', { name: 'Confirmar' }).click();
  await a.waitForSelector('text=Pedido atualizado.');
  ok(/CONFIRMADO/.test(await row.innerText()), 'quick action "Confirmar" from the list');
  // cancel gives stock back
  await row.getByRole('button', { name: /Ver pedido/ }).click();
  await a.getByRole('button', { name: 'CANCELAR' }).click();
  await a.getByRole('button', { name: 'Cancelar pedido' }).click();
  await a.waitForSelector('text=Pedido atualizado.');
  const locked = await a
    .waitForFunction(() => [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'CONFIRMAR PEDIDO')?.disabled, null, { timeout: 8000 })
    .then(() => true, () => false);
  ok(locked && /CANCELADO/.test(await a.locator('h1').locator('..').innerText()), 'cancelled order: status buttons disabled');

  console.log('# mobile admin');
  const m = await newPage(browser, { width: 390, height: 844 }, errors);
  await m.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await m.fill('#login-email', 'dono@copocheio.local');
  await m.fill('#login-senha', 'senha-forte-123');
  await m.click('button[type=submit]');
  await m.waitForURL('**/admin/dashboard');
  await m.waitForTimeout(1200);
  await m.screenshot({ path: `${SP}/e2e-m-dashboard.png`, fullPage: true });
  for (const path of ['/admin/dashboard', '/admin/pedidos', `/admin/pedidos/${num}`, '/admin/produtos', '/admin/produtos/novo', '/admin/categorias', '/admin/estoque', '/admin/site', '/admin/banners', '/admin/configuracoes']) {
    await m.goto(BASE + path, { waitUntil: 'networkidle' });
    await m.waitForTimeout(700);
    ok(await noHScroll(m), `no horizontal scroll at 390px: ${path}`, await m.evaluate(() => document.documentElement.scrollWidth));
  }
  await m.goto(BASE + '/admin/pedidos', { waitUntil: 'networkidle' });
  await m.waitForTimeout(800);
  ok((await m.locator('table').isVisible()) === false && (await m.locator('ul li', { hasText: 'João Silva' }).count()) > 0, 'orders become cards on mobile');
  await m.screenshot({ path: `${SP}/e2e-m-pedidos.png` });
  await m.getByRole('button', { name: 'Abrir menu' }).click();
  await m.waitForTimeout(400);
  await m.screenshot({ path: `${SP}/e2e-m-menu.png` });
  await m.locator('[aria-label="Menu do painel"]').last().getByText('Produtos').click();
  await m.waitForURL('**/admin/produtos');
  ok(true, 'mobile drawer navigation');

  console.log('# payments + delivery zones in the checkout');
  await a.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await a.getByRole('tab', { name: 'Pagamento' }).click();
  await a.getByRole('switch', { name: /Cartão/ }).click();
  await a.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Pagamentos salvos.');
  await a.getByRole('tab', { name: 'Entrega' }).click();
  await a.getByRole('button', { name: 'Bairro' }).first().click();
  await a.getByLabel('Bairro', { exact: true }).fill('Centro');
  await a.getByLabel('Taxa de entrega').last().fill('4,00');
  await a.getByRole('button', { name: 'Salvar' }).last().click();
  await a.waitForSelector('text=Bairro salvo.');
  await a.getByRole('button', { name: 'Bairro' }).first().click();
  await a.getByLabel('Bairro', { exact: true }).fill('Jardim Europa');
  await a.getByLabel('Taxa de entrega').last().fill('9,50');
  await a.getByRole('button', { name: 'Salvar' }).last().click();
  await a.waitForSelector('text=Bairro salvo.');
  const z = await newPage(browser, { width: 390, height: 844 }, errors);
  await z.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
  await z.click('button[aria-label="Adicionar Coca-Cola 2L ao pedido"]');
  await z.goto(BASE + '/checkout', { waitUntil: 'networkidle' });
  const payLabels = await z.$$eval('[role=radiogroup][aria-label="Forma de pagamento"] label', (l) => l.map((x) => x.innerText.split('\n')[0]));
  ok(payLabels.join(',') === 'PIX,Dinheiro', 'checkout offers only the enabled payment methods: ' + payLabels.join(','));
  const bairros = await z.$$eval('select option', (o) => o.map((x) => x.textContent));
  ok(bairros.some((b) => /^Centro/.test(b)) && bairros.some((b) => /Jardim Europa/.test(b)), 'checkout lists the delivery neighborhoods from the panel: ' + bairros.join(' | '));
  await z.getByLabel('Bairro *').selectOption({ label: bairros.find((b) => /Jardim Europa/.test(b)) });
  ok(/Entrega\s*R\$\s?9,50/.test(await z.locator('aside').innerText()), 'delivery fee follows the neighborhood fee (9,50)');
  await z.context().close();
  await a.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await a.getByRole('tab', { name: 'Pagamento' }).click();
  await a.getByRole('switch', { name: /Cartão/ }).click();
  await a.getByRole('button', { name: 'Salvar' }).click();
  await a.waitForSelector('text=Pagamentos salvos.');

  console.log('# team + password');
  await a.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await a.getByRole('tab', { name: 'Administradores' }).click();
  await a.getByRole('button', { name: 'Adicionar' }).click();
  await a.getByLabel('Nome').fill('Atendente Teste');
  await a.getByLabel('E-mail de login').fill('atendente@copocheio.local');
  await a.getByLabel('Senha inicial').fill('Atendente!Segura-2026');
  await a.getByRole('dialog').getByRole('button', { name: 'Adicionar' }).click();
  await a.waitForSelector('text=Administrador adicionado.');
  ok(/scrypt\$65536\$8\$1\$/.test(psql("select password_hash from admins where email='atendente@copocheio.local'")), 'password stored as a scrypt hash, not plain text');
  const t = await newPage(browser, { width: 1280, height: 800 }, errors);
  await t.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await t.fill('#login-email', 'atendente@copocheio.local');
  await t.fill('#login-senha', 'Atendente!Segura-2026');
  await t.click('button[type=submit]');
  await t.waitForURL('**/admin/dashboard');
  await t.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
  await t.getByRole('tab', { name: 'Administradores' }).click();
  await t.waitForSelector('text=Só o owner pode alterar a equipe.');
  ok((await t.getByRole('button', { name: 'Adicionar' }).count()) === 0, 'non-owner admin cannot manage the team (no Adicionar button)');
  const directList = await t.evaluate(() => fetch('/api/admin/admins').then((r) => r.status));
  ok(directList === 403, 'and the server refuses the team API for a non-owner (403)');
  await t.getByRole('tab', { name: 'Painel' }).click();
  await t.getByLabel('Senha atual').fill('Atendente!Segura-2026');
  await t.getByLabel('Senha nova', { exact: true }).fill('Nova#Senha-Boa-2027x');
  await t.getByLabel('Repita a senha nova').fill('Nova#Senha-Boa-2027x');
  await t.getByRole('button', { name: 'Alterar senha' }).click();
  await t.waitForSelector('text=Senha alterada.');
  const rel = await newPage(browser, { width: 1280, height: 800 }, errors);
  await rel.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
  await rel.fill('#login-email', 'atendente@copocheio.local');
  await rel.fill('#login-senha', 'Nova#Senha-Boa-2027x');
  await rel.click('button[type=submit]');
  await rel.waitForURL('**/admin/dashboard');
  ok(true, 'login works with the changed password');
  await t.context().close();
  await rel.context().close();

  console.log('# server-side session');
  const gone = Number(psql("with d as (delete from admin_sessions where admin_id = (select id from admins where email='dono@copocheio.local') returning 1) select count(*) from d"));
  ok(gone >= 1, 'sessions of the owner removed from Neon (' + gone + ')');
  await a.getByRole('link', { name: 'Produtos' }).first().click();
  await a.waitForURL('**/admin/login', { timeout: 15000 });
  ok(true, 'revoked session: the next panel action sends the owner back to the login (server decides, not the browser)');
  await a.fill('#login-email', 'dono@copocheio.local');
  await a.fill('#login-senha', 'senha-forte-123');
  await a.click('button[type=submit]');
  await a.waitForURL('**/admin/dashboard');

  console.log('# architecture: only /api, no Supabase, no direct storage');
  const external = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('data:') && !/blob\.vercel-storage\.com|fonts\.(googleapis|gstatic)|cloudfront\.net|openstreetmap|google\.com\/maps|instagram|wa\.me/.test(u));
  ok(external.length === 0, 'no unexpected external requests', external.slice(0, 5));
  ok(!requests.some((u) => /supabase/i.test(u)), 'no request to Supabase');
  const apiPaths = [...new Set(requests.filter((u) => u.startsWith(BASE + '/api/')).map((u) => new URL(u).pathname.replace(/[0-9a-f-]{36}/g, ':id').replace(/\/\d+$/, '/:n')))];
  console.log('API paths used by the browser:', apiPaths.join(' '));
  ok(apiPaths.includes('/api/products') && apiPaths.includes('/api/site') && apiPaths.includes('/api/orders'), 'public site uses /api/products, /api/site and /api/orders');

  console.log('# public pages responsive');
  for (const [w, h] of [[1920, 1080], [1366, 768], [768, 1024], [390, 844], [375, 667]]) {
    const p = await newPage(browser, { width: w, height: h }, errors);
    for (const path of ['/', '/bebidas', '/checkout']) {
      await p.goto(BASE + path, { waitUntil: 'networkidle' });
      if (path === '/bebidas' && w === 390) await p.click('button[aria-label="Adicionar Coca-Cola 2L ao pedido"]');
      await p.waitForTimeout(300);
      ok(await noHScroll(p), `no horizontal scroll ${w}x${h} ${path}`);
    }
    await p.context().close();
  }

  console.log('# logout');
  await a.getByRole('button', { name: 'Sair' }).click();
  await a.waitForURL('**/admin/login');
  await a.goto(BASE + '/admin/dashboard', { waitUntil: 'networkidle' });
  ok(new URL(a.url()).pathname === '/admin/login', 'after logout /admin/dashboard redirects to login');

  console.log('\nerrors:', JSON.stringify(errors.slice(0, 10)));
  console.log(fails === 0 ? '\nALL PASSED' : `\n${fails} CHECK(S) FAILED`);
  await browser.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  process.exit(2);
});
