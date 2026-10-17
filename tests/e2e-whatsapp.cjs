// WhatsApp da loja no navegador: os botões do site abrem o chat do número da loja (cheio e com mensagem), o painel mostra o
// número, um link do WhatsApp funciona como link de banner e, com a API fora do ar, o botão de ajuda ainda leva à loja.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-whatsapp.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180', BLOB = 'http://127.0.0.1:4181';
const NUMBER = '553492441191'; // migration 0026 (a 0008 gravou 5534991283384 e a 0026 troca)
const LINK = 'https://api.whatsapp.com/send/?phone=553492441191&text&type=phone_number&app_absent=0';
let cookie = '';
async function api(method, path, body, raw) {
  const init = { method, headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) }, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) };
  let res;
  for (let i = 0; ; i++) { try { res = await fetch(BASE + path, init); break; } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 400)); } }
  const set = res.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const t = await res.text(); return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
const ok = (c, msg, extra) => { if (!c) fails++; console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); };
// O aviso "Dados da loja salvos." da gravação anterior pode continuar na tela e satisfazer o waitForSelector antes de a nova gravação terminar:
// por isso o resultado de cada gravação é esperado pela API (até 6 s), nunca por uma única leitura logo após o clique.
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}
const errors = [];
async function newCtx(browser, viewport) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000 });
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => { await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + new URL(route.request().url()).pathname }) }); });
  // O WhatsApp de verdade não é aberto nos testes: o destino só devolve uma página simples.
  await ctx.route(/^https:\/\/(wa\.me|api\.whatsapp\.com)\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp</title>ok' }));
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page };
}
const waLinks = (page) => page.evaluate(() => [...document.querySelectorAll('a[href*="wa.me"], a[href*="whatsapp.com"]')].map((a) => ({ href: a.href, text: a.textContent.trim(), target: a.target, rel: a.rel })));

const { adminLoginViaApi, finishAdminLogin } = require('./e2e-code.cjs');
(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  for (const b of (await api('GET', '/api/admin/banners')).data.banners) await api('DELETE', `/api/admin/banners/${b.id}`);
  const browser = await chromium.launch();

  console.log('# página inicial: Contato e chamada final');
  for (const [w, h] of [[390, 844], [1280, 800]]) {
    const { ctx, page } = await newCtx(browser, { width: w, height: h });
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const links = (await waLinks(page)).filter((l) => /Chamar/.test(l.text));
    ok(links.length >= 2, `${w}px: os botões "Chamar agora" e "Chamar no WhatsApp" existem (${links.length})`, links);
    ok(links.every((l) => l.href.startsWith(`https://wa.me/${NUMBER}?text=`)), `${w}px: todos abrem o chat do número da loja (wa.me/${NUMBER})`, links.map((l) => l.href));
    ok(links.every((l) => decodeURIComponent(l.href).includes('Olá, Copo Cheio!')), `${w}px: com a mensagem pronta`, links.map((l) => l.href));
    ok(links.every((l) => l.target === '_blank' && /noopener/.test(l.rel)), `${w}px: abrem em outra aba, com noopener`, links);
    // clicar de verdade
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.getByRole('link', { name: 'Chamar no WhatsApp' }).first().click()]);
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    ok(popup.url().startsWith(`https://wa.me/${NUMBER}?text=`), `${w}px: o clique leva ao chat da loja`, popup.url());
    await ctx.close();
  }

  console.log('# página Bebidas: cardápio ainda vazio');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 800 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const links = (await waLinks(page)).filter((l) => /Chamar/.test(l.text));
    ok(links.length === 1 && links[0].href.startsWith(`https://wa.me/${NUMBER}?text=`), 'o botão "Chamar no WhatsApp" do cardápio vazio abre o chat da loja', links);
    await ctx.close();
  }

  console.log('# API fora do ar e sem cópia no navegador: o botão de ajuda continua levando à loja');
  {
    const { ctx, page } = await newCtx(browser, { width: 390, height: 844 });
    await page.route('**/api/**', (r) => r.abort());
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForSelector('text=Não conseguimos carregar o cardápio', { timeout: 10000 });
    const links = (await waLinks(page)).filter((l) => /Chamar/.test(l.text));
    ok(links.length === 1 && links[0].href.startsWith(`https://wa.me/${NUMBER}?text=`), 'sem API e sem cópia salva, o botão usa o número da loja (e não abre o WhatsApp "em branco")', links);
    await ctx.close();
  }

  console.log('# painel: Configurações → Loja');
  {
    const { ctx, page } = await newCtx(browser, { width: 1280, height: 900 });
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    await page.fill('#login-email', 'dono@copocheio.local');
    await page.fill('#login-senha', 'senha-forte-123');
    await page.click('button[type=submit]');
    await finishAdminLogin(page);
    await page.waitForURL('**/admin/dashboard');
    await page.goto(BASE + '/admin/configuracoes', { waitUntil: 'networkidle' });
    const field = page.getByLabel('WhatsApp da loja');
    ok((await field.inputValue()) === '(34) 9244-1191', 'o campo "WhatsApp da loja" mostra (34) 9244-1191', await field.inputValue());
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    await page.waitForSelector('text=Dados da loja salvos.');
    ok((await api('GET', '/api/admin/settings')).data.store.whatsapp === NUMBER, 'salvar sem mexer mantém o número (55 + DDD + número)');
    // trocar e voltar
    await field.fill('(34) 98888-7777');
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    await page.waitForSelector('text=Dados da loja salvos.');
    ok(await until(async () => (await api('GET', '/api/site')).data.store.whatsapp === '5534988887777'), 'trocar o número pelo painel muda o site na hora');
    {
      const c2 = await newCtx(browser, { width: 390, height: 844 });
      await c2.page.goto(BASE + '/', { waitUntil: 'networkidle' });
      const links = (await waLinks(c2.page)).filter((l) => /Chamar/.test(l.text));
      ok(links.every((l) => l.href.startsWith('https://wa.me/5534988887777?text=')), 'e os botões do site passam a abrir o novo número', links.map((l) => l.href));
      await c2.ctx.close();
    }
    await field.fill('');
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    await page.waitForSelector('text=Dados da loja salvos.');
    ok(await until(async () => (await api('GET', '/api/site')).data.store.whatsapp === null), 'apagar o número no painel deixa a loja sem WhatsApp (o site obedece o painel)');
    {
      const c3 = await newCtx(browser, { width: 390, height: 844 });
      await c3.page.goto(BASE + '/', { waitUntil: 'networkidle' });
      const links = (await waLinks(c3.page)).filter((l) => /Chamar/.test(l.text));
      ok(links.every((l) => l.href.startsWith('https://wa.me/?text=')), 'sem número no painel, o botão abre o WhatsApp para a pessoa escolher o contato (como a tela do painel avisa)', links.map((l) => l.href));
      await c3.ctx.close();
    }
    await field.fill('(34) 9244-1191');
    await page.getByRole('button', { name: /Salvar/ }).first().click();
    await page.waitForSelector('text=Dados da loja salvos.');
    ok(await until(async () => (await api('GET', '/api/site')).data.store.whatsapp === NUMBER), 'e voltar ao número da loja');
    await ctx.close();
  }

  console.log('# link do WhatsApp como link de banner (o "PEÇA AGORA" do cardápio)');
  {
    const up = async (name) => (await api('POST', '/api/admin/upload?folder=banners', fs.readFileSync(`${FX}/${name}`), true)).data.url;
    await api('POST', '/api/admin/banners', { placement: 'menu', title: 'Peça agora', image_desktop_url: await up('poster.webp'), link: LINK });
    await api('POST', '/api/admin/banners', { placement: 'cover', title: 'Capa', image_desktop_url: await up('cover-41.webp'), image_mobile_url: await up('cover-mob2.webp'), link: LINK });
    for (const [w, h] of [[390, 844], [1280, 800]]) {
      const { ctx, page } = await newCtx(browser, { width: w, height: h });
      await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const banners = await page.evaluate((link) => [...document.querySelectorAll(`a[href="${link}"]`)].map((a) => ({ target: a.target, rel: a.rel, where: a.closest('section[aria-label="Promoções"]') ? 'cardápio' : 'capa' })), LINK);
      ok(banners.length === 2 && banners.every((b) => b.target === '_blank' && /noopener/.test(b.rel)), `${w}px: capa e banner do cardápio abrem o link do WhatsApp em outra aba, com noopener`, banners);
      const [popup] = await Promise.all([ctx.waitForEvent('page'), page.locator('section[aria-label="Promoções"] a').first().click()]);
      ok(popup.url().startsWith('https://api.whatsapp.com/send/?phone=553492441191'), `${w}px: tocar no banner abre o WhatsApp da loja`, popup.url());
      await ctx.close();
    }
    for (const b of (await api('GET', '/api/admin/banners')).data.banners) await api('DELETE', `/api/admin/banners/${b.id}`);
  }

  await browser.close();
  ok(errors.length === 0, 'nenhum erro de JavaScript', errors.slice(0, 4));
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
