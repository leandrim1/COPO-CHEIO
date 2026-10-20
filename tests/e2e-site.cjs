// Site público no navegador (celular e computador): instalação (PWA) com service worker de verdade, medição de visitas só com consentimento, página de contato e áreas de toque.
//  • service worker: registra, guarda SÓ arquivos estáticos (nunca /api nem páginas), e sem rede a navegação mostra "Você está sem conexão"; ao voltar a rede o site volta ao normal;
//  • medição (GA_MEASUREMENT_ID ligado no servidor): o aviso aparece, "Recusar" não baixa script do Google, "Aceitar" baixa; dá para mudar de ideia na política de privacidade;
//  • "Contato e responsável": página, dados da loja e link no rodapé; nenhuma rolagem lateral no celular;
//  • alvos de toque pequenos respondem num raio de 22 px (área invisível de 44 × 44), sem mudar o desenho.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-site.cjs     (BASE e TEST_DB escolhem o servidor e o banco)
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const { adminLoginViaApi } = require('./e2e-code.cjs');
const { patchBrowser } = require('./e2e-age.cjs');
const { execSync } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:4180';
const ROOT = require('path').join(__dirname, '..');
const stopServer = () => execSync("for pid in $(ps -eo pid,args | awk '/node tests\\/server\\.mjs/ && !/awk/ {print $1}'); do kill $pid; done; sleep 1", { stdio: 'ignore', shell: '/bin/bash' });
const serve = (env = {}) => execSync(`bash ${process.env.SERVE_SCRIPT || ROOT + '/tests/serve.sh'}`, { env: { ...process.env, ...env }, stdio: 'ignore' });

let cookie = '';
async function api(method, path, body) {
  const init = { method, headers: { 'content-type': 'application/json', 'x-real-ip': '10.41.41.41', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined };
  let res;
  for (let i = 0; ; i++) {
    try {
      res = await fetch(BASE + path, init);
      break;
    } catch (e) {
      if (i >= 3) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
let fails = 0;
const ok = (c, msg, extra) => {
  if (!c) fails++;
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};
const errors = [];
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const text = (page) => page.evaluate(() => document.body.innerText);

(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  await api('PATCH', '/api/admin/store', { opening_hours: ALL_DAYS, orders_paused: false, delivery_enabled: true, pickup_enabled: true, delivery_fee: 5, min_order: 0, whatsapp: '5534999990000', instagram: '@copocheiodisk' });
  const cat = (await api('POST', '/api/admin/categories', { name: 'Site' })).data.category;
  for (const [name, price] of [['Cerveja Site', 6], ['Guaraná Site', 9]]) await api('POST', '/api/admin/products', { name, price, category_id: cat.id, confirm_duplicate: true, stock: 50, alcoholic: false });

  const browser = patchBrowser(await chromium.launch());
  const newPage = async (viewport, { webdriverOff = false } = {}) => {
    const mobile = viewport.width < 1000;
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'allow' });
    // O site só registra o service worker fora de automação (navigator.webdriver); aqui desligamos esse sinal para testar o registro de verdade.
    if (webdriverOff) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
    const page = await ctx.newPage();
    await page.route('**/*.mp4', (r) => r.abort());
    page.on('pageerror', (e) => errors.push(e.message));
    return { ctx, page };
  };

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# automação não registra o service worker (os testes enxergam o site de sempre)');
  {
    const { ctx, page } = await newPage({ width: 390, height: 780 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    ok((await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0, 'sob automação (webdriver) nenhum service worker é registrado');
    ok((await page.locator('link[rel="manifest"]').getAttribute('href')) === '/manifest.webmanifest', 'a página aponta para o manifesto');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# service worker de verdade: só estático, offline com aviso, volta ao normal');
  {
    const { ctx, page } = await newPage({ width: 390, height: 780 }, { webdriverOff: true });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r && r.active)), null, { timeout: 15000 });
    ok(true, 'o service worker foi registrado e ativado em produção');
    await page.reload({ waitUntil: 'networkidle' }); // já controlado pelo service worker
    await page.waitForTimeout(500);
    const cached = await page.evaluate(async () => {
      const out = {};
      for (const name of await caches.keys()) out[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
      return out;
    });
    const all = Object.values(cached).flat();
    ok(Object.keys(cached).join() === 'copocheio-static-v1', 'um único cache, com o nome versionado', Object.keys(cached));
    ok(all.includes('/offline.html'), 'a página "sem conexão" está guardada', all);
    ok(all.some((p) => p.startsWith('/assets/')), 'os arquivos versionados do site estão guardados', all);
    ok(!all.some((p) => p.startsWith('/api') || p.startsWith('/admin') || p.startsWith('/pedido') || p.startsWith('/conta') || p.startsWith('/acompanhar') || p.startsWith('/pagar') || p === '/' || p === '/bebidas' || p === '/index.html'), 'NADA de API, página, pedido, conta ou painel foi guardado', all);

    // Sem rede DE VERDADE: o servidor de teste sai do ar. (O modo offline do Playwright só vale para a página, não para o service worker, que continuaria alcançando o servidor.)
    stopServer();
    const apiOffline = await page.evaluate(() => fetch('/api/products').then((r) => 'respondeu ' + r.status, () => 'falhou'));
    ok(apiOffline === 'falhou', 'sem rede, o cardápio (API) NÃO vem de cópia guardada: preço e estoque nunca ficam velhos', apiOffline);
    await page.goto(BASE + '/checkout').catch(() => undefined);
    ok(/Você está sem conexão/.test(await text(page)), 'sem rede, abrir uma página mostra "Você está sem conexão"', (await text(page)).slice(0, 120));
    ok(await noHScroll(page), 'a página "sem conexão" não tem rolagem lateral');
    serve({});
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    ok(/Cerveja Site/.test(await text(page)), 'com o servidor de volta o cardápio normal aparece');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# contato e responsável');
  for (const [name, viewport] of [['celular', { width: 390, height: 780 }], ['computador', { width: 1280, height: 900 }]]) {
    const { ctx, page } = await newPage(viewport);
    await page.goto(BASE + '/contato-e-responsavel', { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-legal="contato-e-responsavel"]');
    ok((await page.locator('h1').innerText()).trim() === 'Contato e responsável', `${name}: título da página`);
    const card = page.locator('[data-store-contact]');
    ok((await card.count()) === 1 && /WhatsApp/.test(await card.innerText()) && /@copocheiodisk/.test(await card.innerText()), `${name}: dados cadastrados da loja (WhatsApp e Instagram) aparecem`);
    ok((await card.locator('a[href*="wa.me"]').count()) === 1 && (await card.locator('a[href="https://instagram.com/copocheiodisk"]').count()) === 1, `${name}: links de WhatsApp e Instagram`);
    ok((await page.locator('footer a[href="/contato-e-responsavel"]').count()) === 1, `${name}: link no rodapé`);
    ok(await noHScroll(page), `${name}: sem rolagem lateral`);
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# áreas de toque de 44 px (sem mudar o desenho)');
  {
    const { ctx, page } = await newPage({ width: 390, height: 780 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const probe = async (selector, label, { horizontal = true } = {}) => {
      const loc = page.locator(selector).first();
      await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
      await page.waitForTimeout(150);
      const res = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = (x, y) => {
          const t = document.elementFromPoint(x, y);
          return Boolean(t && (t === el || el.contains(t)));
        };
        return { w: Math.round(r.width), h: Math.round(r.height), up: hit(cx, cy - 21), down: hit(cx, cy + 21), left: hit(cx - 21, cy), right: hit(cx + 21, cy) };
      });
      const vertical = res.h >= 43 || (res.up && res.down);
      const side = !horizontal || res.w >= 43 || (res.left && res.right);
      ok(vertical && side, `${label} (${res.w}×${res.h}) responde ao toque num raio de 22 px`, res);
    };
    await probe('button[aria-label^="Adicionar "]', 'botão Adicionar');
    await probe('a[href="/"]', 'link Início do topo');
    await page.locator('button[aria-label^="Adicionar "]').first().click();
    await page.waitForTimeout(300);
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const dots = page.locator('button[aria-label^="Ver bebida "]');
    if ((await dots.count()) > 0) await probe('button[aria-label^="Ver bebida "]', 'ponto do carrossel', { horizontal: false });
    else ok(true, 'ponto do carrossel: sem fotos de Hero neste banco de teste (nada a medir)');
    await probe('footer a[aria-label^="Instagram"]', 'Instagram do rodapé');
    await ctx.close();
  }

  // ---------------------------------------------------------------------------------------------------------------------------------
  console.log('# medição de visitas: só com consentimento');
  serve({ GA_MEASUREMENT_ID: 'G-TEST1234' });
  {
    const scriptsOf = (page) => page.evaluate(() => [...document.scripts].map((s) => s.src).filter((s) => /googletagmanager|google-analytics/.test(s)));
    // 1) recusar
    let { ctx, page } = await newPage({ width: 390, height: 780 });
    const googleRequests = [];
    page.on('request', (r) => /googletagmanager|google-analytics/.test(r.url()) && googleRequests.push(r.url()));
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    const banner = page.locator('[data-analytics-consent]');
    await banner.waitFor({ timeout: 8000 });
    ok(/Google Analytics/.test(await banner.innerText()) && (await banner.getByRole('button').count()) === 2, 'o aviso aparece, em português, com "Aceitar" e "Recusar"');
    ok((await scriptsOf(page)).length === 0 && googleRequests.length === 0, 'antes de escolher: nenhum script nem conexão com o Google');
    await page.locator('[data-analytics-deny]').click();
    await page.waitForTimeout(400);
    ok((await banner.count()) === 0, '"Recusar" fecha o aviso');
    await page.goto(BASE + '/privacidade', { waitUntil: 'networkidle' });
    ok((await scriptsOf(page)).length === 0 && googleRequests.length === 0, 'recusado: o Google nunca é chamado, nem em outra página');
    ok((await page.locator('[data-measurement-state]').getAttribute('data-measurement-state')) === 'denied', 'a política de privacidade mostra a escolha: recusada');
    ok(/Google Analytics/.test(await text(page)) && !/não usa anúncios nem ferramentas de estatística de terceiros/.test(await text(page)), 'a política descreve o Google Analytics quando a medição está ligada');
    // 2) mudar de ideia pela política
    await page.locator('[data-measurement-allow]').click();
    await page.waitForTimeout(400);
    ok((await scriptsOf(page)).length === 1 && (await scriptsOf(page))[0] === 'https://www.googletagmanager.com/gtag/js?id=G-TEST1234', 'depois de "Permitir" o script do Google é pedido, com o identificador');
    ok((await page.locator('[data-measurement-state]').getAttribute('data-measurement-state')) === 'granted', 'a política mostra a escolha: aceita');
    await ctx.close();
    // 3) aceitar no aviso
    ({ ctx, page } = await newPage({ width: 1280, height: 900 }));
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.locator('[data-analytics-consent]').waitFor({ timeout: 8000 });
    await page.locator('[data-analytics-accept]').click();
    await page.waitForTimeout(400);
    ok((await scriptsOf(page)).length === 1, '"Aceitar" no aviso carrega a medição');
    ok(await noHScroll(page), 'computador: sem rolagem lateral com o aviso');
    await ctx.close();
    // 4) páginas pessoais e painel: o aviso não atrapalha o painel
    ({ ctx, page } = await newPage({ width: 390, height: 780 }));
    await page.goto(BASE + '/admin/login', { waitUntil: 'networkidle' });
    ok((await page.locator('[data-analytics-consent]').count()) === 0, 'o painel nunca mostra o aviso de medição');
    await ctx.close();
  }
  serve({});
  {
    const { ctx, page } = await newPage({ width: 390, height: 780 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    ok((await page.locator('[data-analytics-consent]').count()) === 0, 'sem GA_MEASUREMENT_ID: nenhum aviso e nenhum script');
    await page.goto(BASE + '/privacidade', { waitUntil: 'networkidle' });
    ok(/não usa anúncios nem ferramentas de estatística de terceiros/.test(await text(page)) && (await page.locator('[data-measurement-state]').count()) === 0, 'sem GA: a política diz que não há estatística de terceiros');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro de JavaScript na página', errors);
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('CRASH', e);
  try {
    serve({});
  } catch {
    /* ignora */
  }
  process.exit(1);
});
