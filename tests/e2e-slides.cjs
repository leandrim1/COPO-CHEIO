// Carrosséis (capa e promoções do cardápio): os slides que ainda não aparecem ficam empilhados sob o da vez (opacidade 0), mas DENTRO da tela, e o navegador
// baixaria a foto de todos de uma vez, junto com a que aparece — em rede lenta, a foto que importa (a primeira, quase sempre a maior da tela) espera as outras.
// Aqui se confere que os slides escondidos só pedem a foto depois que a primeira terminou (carregou ou falhou), com prioridade baixa, e que nada muda no que se vê:
// a primeira aparece na hora, os pontos e a troca sozinha continuam funcionando, "reduzir movimento" também, e uma primeira foto quebrada não trava os outros.
// usage: bash tests/fresh.sh && npm run build && node tests/e2e-slides.cjs
const { chromium } = (() => {
  try {
    return require('playwright');
  } catch {
    return require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
  }
})();
const fs = require('fs');
const FX = require('node:path').join(__dirname, 'fixtures');
const BASE = 'http://localhost:4180';
const BLOB = 'http://127.0.0.1:4181';
let fails = 0;
const until = async (fn, ms = 6000) => {
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
  console.log((c ? 'PASS ' : 'FAIL ') + msg + (!c && extra !== undefined ? '  -> ' + JSON.stringify(extra) : ''));
};

let cookie = '';
async function api(method, path, body, raw) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(raw ? { 'content-type': 'image/webp' } : { 'content-type': 'application/json' }), 'x-real-ip': '10.9.9.9', ...(cookie ? { cookie } : {}) },
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.()[0];
  if (set) cookie = set.split(';')[0];
  const t = await res.text();
  return { status: res.status, data: t ? JSON.parse(t) : null };
}
const upload = async (name) => (await api('POST', '/api/admin/upload?folder=banners', fs.readFileSync(`${FX}/${name}`), true)).data.url;
const fileOf = (url) => new URL(url).pathname.split('/').pop();

const errors = [];
// Contexto que anota cada pedido ao Blob (com a hora) e pode segurar (`hold`, ms) ou derrubar (`dead`) a foto de um endereço.
async function newCtx(browser, viewport, { hold = {}, dead = [], reducedMotion } = {}) {
  const ctx = await browser.newContext({ viewport, isMobile: viewport.width < 1000, hasTouch: viewport.width < 1000, deviceScaleFactor: 1, ...(reducedMotion ? { reducedMotion } : {}) });
  const log = [];
  const t0 = Date.now();
  await ctx.route(/\.public\.blob\.vercel-storage\.com\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    log.push({ file: path.split('/').pop(), t: Date.now() - t0 });
    if (dead.some((d) => path.includes(d))) return route.fulfill({ status: 404, body: 'nope' });
    const wait = Object.entries(hold).find(([k]) => path.includes(k))?.[1] ?? 0;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    await route.fulfill({ response: await route.fetch({ url: BLOB + '/f' + path }) });
  });
  const page = await ctx.newPage();
  await page.route('**/*.mp4', (r) => r.abort());
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/mp4|ERR_|net::|Failed to load resource/.test(m.text())) errors.push(m.text());
  });
  return { ctx, page, log, requested: (file) => log.filter((l) => l.file === file) };
}
const coverBox = (page) => page.locator('div.relative.h-44').filter({ has: page.locator('a[href="/acompanhar-pedido"]') }).first();
const opacityOf = (loc) => loc.evaluate((el) => Number(getComputedStyle(el).opacity));

const { adminLoginViaApi } = require('./e2e-code.cjs');
(async () => {
  await adminLoginViaApi(api, { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  const mk = async (body) => (await api('POST', '/api/admin/banners', body)).data.banner;
  const coverA = await mk({ placement: 'cover', title: 'Capa A', image_mobile_url: await upload('cover-mob.webp'), image_desktop_url: await upload('cover-desk.webp') });
  const coverB = await mk({ placement: 'cover', title: 'Capa B', image_mobile_url: await upload('cover2-mob.webp'), image_desktop_url: await upload('cover2-desk.webp') });
  const menuA = await mk({ placement: 'menu', title: 'Promo A', image_desktop_url: await upload('b.webp') });
  const menuB = await mk({ placement: 'menu', title: 'Promo B', image_desktop_url: await upload('a.webp') });
  const file = { coverAm: fileOf(coverA.image_mobile_url), coverBm: fileOf(coverB.image_mobile_url), coverAd: fileOf(coverA.image_desktop_url), coverBd: fileOf(coverB.image_desktop_url), menuA: fileOf(menuA.image_desktop_url), menuB: fileOf(menuB.image_desktop_url) };
  ok(new Set(Object.values(file)).size === 6, 'seis fotos diferentes no Blob (2 da capa em duas versões + 2 do cardápio)', file);
  const browser = await chromium.launch();

  // =============================================================================================
  console.log('# celular: a foto do slide escondido só é pedida depois que a primeira terminou');
  {
    const { ctx, page, log, requested } = await newCtx(browser, { width: 390, height: 844 }, { hold: { [file.coverAm]: 1500, [file.menuA]: 1500 } });
    await page.goto(BASE + '/bebidas', { waitUntil: 'domcontentloaded' });
    ok(await until(() => requested(file.coverAm).length > 0 && requested(file.menuA).length > 0), 'as duas primeiras fotos (capa e cardápio) são pedidas assim que os dados chegam', log);
    await page.waitForTimeout(700); // as duas ainda estão seguradas
    ok(requested(file.coverBm).length === 0 && requested(file.menuB).length === 0, 'enquanto as primeiras não terminam, as fotos dos slides escondidos NÃO são pedidas', log);
    ok(await until(() => requested(file.coverBm).length > 0 && requested(file.menuB).length > 0, 5000), 'quando as primeiras terminam, os escondidos passam a pedir a foto', log);
    ok(requested(file.coverBm).length === 1 && requested(file.menuB).length === 1, 'uma vez cada');
    const firstDone = Math.min(requested(file.coverAm)[0].t, requested(file.menuA)[0].t) + 1400;
    ok(requested(file.coverBm)[0].t >= firstDone && requested(file.menuB)[0].t >= firstDone, 'e só depois de a primeira foto de cada carrossel chegar (≥ 1,4 s depois do pedido dela)', log);
    await page.waitForLoadState('networkidle');
    // Prioridades: a primeira alta, as demais baixas.
    const prio = await page.evaluate(() => {
      const cover = [...document.querySelectorAll('img[alt="Capa A"], img[alt="Capa B"]')].map((i) => [i.alt, i.getAttribute('fetchpriority'), i.getAttribute('loading')]);
      const menu = [...document.querySelectorAll('section[aria-label="Promoções"] img')].map((i, n) => [n, i.getAttribute('fetchpriority'), i.getAttribute('loading')]);
      return { cover, menu };
    });
    ok(JSON.stringify(prio.cover) === JSON.stringify([['Capa A', 'high', 'eager'], ['Capa B', 'low', 'lazy']]), 'capa: a 1ª tem prioridade alta e carga imediata; a 2ª, baixa e preguiçosa', prio.cover);
    ok(JSON.stringify(prio.menu) === JSON.stringify([[0, 'high', 'eager'], [1, 'low', 'lazy']]), 'cardápio: o mesmo', prio.menu);

    // O que se vê não mudou: só o 1º aparece; os pontos levam ao 2º, que já está carregado.
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    const slideA = coverBox(page).locator('a:has(img[alt="Capa A"]), div:has(> picture img[alt="Capa A"])').first();
    const slideB = coverBox(page).locator('a:has(img[alt="Capa B"]), div:has(> picture img[alt="Capa B"])').first();
    ok((await dots.count()) === 2 && (await opacityOf(slideA)) === 1 && (await opacityOf(slideB)) === 0, 'capa: 2 pontos, só o 1º slide aparece');
    await dots.nth(1).click();
    ok(await until(async () => (await opacityOf(slideB)) === 1 && (await opacityOf(slideA)) === 0), 'tocar no 2º ponto mostra o 2º slide');
    ok(await coverBox(page).locator('img[alt="Capa B"]').evaluate((i) => i.complete && i.naturalWidth > 0), 'e a foto dele já estava pronta (nada de espaço vazio)');
    const promo = page.locator('section[aria-label="Promoções"]');
    const promoDots = promo.locator('button[aria-label^="Ver promoção"]');
    ok((await promoDots.count()) === 2 && (await promoDots.nth(0).getAttribute('aria-current')) === 'true', 'cardápio: 2 pontos, o 1º ativo');
    ok(await until(async () => (await promoDots.nth(1).getAttribute('aria-current')) === 'true', 8000), 'cardápio: troca sozinho para o 2º em ~6 s');
    ok(await promo.locator('img').nth(1).evaluate((i) => i.complete && i.naturalWidth > 0), '…e a foto do 2º já estava carregada');
    await ctx.close();
  }

  // =============================================================================================
  console.log('# computador: o mesmo (a foto de fundo desfocada também espera)');
  {
    const { ctx, page, log, requested } = await newCtx(browser, { width: 1280, height: 800 }, { hold: { [file.coverAd]: 1500, [file.menuA]: 1500 } });
    await page.goto(BASE + '/bebidas', { waitUntil: 'domcontentloaded' });
    ok(await until(() => requested(file.coverAd).length > 0 && requested(file.menuA).length > 0), 'as primeiras fotos são pedidas', log);
    await page.waitForTimeout(700);
    ok(requested(file.coverBd).length === 0 && requested(file.menuB).length === 0, 'os escondidos esperam (nem a foto, nem o fundo desfocado, que usa o mesmo endereço)', log);
    ok(await until(() => requested(file.coverBd).length > 0 && requested(file.menuB).length > 0, 5000), 'depois das primeiras, pedem', log);
    await page.waitForLoadState('networkidle');
    const backdrops = await coverBox(page).locator('span[aria-hidden="true"].blur-2xl').count();
    ok(backdrops === 2, 'os dois slides da capa têm o fundo desfocado (como antes)', backdrops);
    await ctx.close();
  }

  // =============================================================================================
  console.log('# "reduzir movimento": os escondidos também carregam (só a troca sozinha para)');
  {
    const { ctx, page, log, requested } = await newCtx(browser, { width: 390, height: 844 }, { reducedMotion: 'reduce' });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    ok(requested(file.coverBm).length >= 1 && requested(file.menuB).length >= 1, 'as fotos dos escondidos foram pedidas', log);
    const dots = coverBox(page).locator('button[aria-label^="Ver destaque"]');
    await dots.nth(1).click();
    ok(await until(async () => (await dots.nth(1).getAttribute('aria-current')) === 'true' && (await opacityOf(coverBox(page).locator('div:has(> picture img[alt="Capa B"])').first())) === 1), 'os pontos funcionam');
    await ctx.close();
  }

  // =============================================================================================
  console.log('# primeira foto da capa quebrada: sai da vez e a seguinte aparece (não fica esperando por ela)');
  {
    const { ctx, page, log, requested } = await newCtx(browser, { width: 390, height: 844 }, { dead: [file.coverAm] });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    ok(requested(file.coverBm).length >= 1, 'a foto do 2º slide foi pedida mesmo com a 1ª quebrada', log);
    ok(await until(async () => (await coverBox(page).locator('img[alt="Capa A"]').count()) === 0), 'o slide quebrado saiu');
    const b = coverBox(page).locator('img[alt="Capa B"]');
    ok(await until(async () => (await b.count()) === 1 && (await b.evaluate((i) => i.complete && i.naturalWidth > 0))), 'o 2º virou o único e está carregado');
    ok((await coverBox(page).locator('button[aria-label^="Ver destaque"]').count()) === 0, 'sem pontos (um slide só)');
    ok(await until(async () => (await opacityOf(b.locator('xpath=ancestor::div[contains(@class,"transition-opacity")][1] | ancestor::a[contains(@class,"transition-opacity")][1]'))) === 1), 'e visível');
    ok((await page.locator('section[aria-label="Promoções"] img').count()) === 2, 'o carrossel do cardápio não foi afetado (2 fotos)');
    await ctx.close();
  }

  // =============================================================================================
  console.log('# um banner só: carrega como sempre');
  {
    await api('DELETE', `/api/admin/banners/${coverB.id}`);
    await api('DELETE', `/api/admin/banners/${menuB.id}`);
    const { ctx, page, log, requested } = await newCtx(browser, { width: 390, height: 844 });
    await page.goto(BASE + '/bebidas', { waitUntil: 'networkidle' });
    ok(requested(file.coverAm).length >= 1 && requested(file.menuA).length >= 1, 'as duas fotos foram pedidas', log);
    ok((await coverBox(page).locator('img[alt="Capa A"]').evaluate((i) => i.complete && i.naturalWidth > 0)) && (await page.locator('section[aria-label="Promoções"] img').evaluate((i) => i.complete && i.naturalWidth > 0)), 'e aparecem');
    ok((await page.locator('section[aria-label="Promoções"] button[aria-label^="Ver promoção"]').count()) === 0, 'sem pontos');
    await ctx.close();
  }

  ok(errors.length === 0, 'nenhum erro no console ou na página', errors.slice(0, 5));
  await browser.close();
  console.log(fails ? `\n${fails} FALHA(S)` : '\nTUDO OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.log('CRASH', e);
  process.exit(2);
});
