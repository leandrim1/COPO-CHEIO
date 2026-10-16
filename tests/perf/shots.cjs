// Capturas de tela DETERMINÍSTICAS (relógio congelado, sem animação) para comparar o visual antes e depois de uma mudança: a página Bebidas em várias
// posições de rolagem e a página inicial, em celular (390 × 844, 2×), tablet (820 × 1100) e computador (1366 × 800). Duas capturas do mesmo site
// saem idênticas pixel a pixel (o ruído é zero), então qualquer diferença é da mudança. Compare com diff.cjs.
// usage: node tests/perf/shots.cjs <url-base> <pasta-de-saída>
const fs = require('fs');
const { launch } = require('./lib.cjs');

const [, , BASE, OUT] = process.argv;
if (!BASE || !OUT) {
  console.error('uso: node tests/perf/shots.cjs <url-base> <pasta-de-saída>');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const VIEWS = [
  { name: 'celular', viewport: { width: 390, height: 844 }, dpr: 2, mobile: true },
  { name: 'tablet', viewport: { width: 820, height: 1100 }, dpr: 1, mobile: true },
  { name: 'desktop', viewport: { width: 1366, height: 800 }, dpr: 1, mobile: false },
];
const T0 = new Date('2026-10-16T15:00:00-03:00');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await launch();
  for (const v of VIEWS) {
    for (const route of ['/bebidas', '/']) {
      const context = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.dpr, isMobile: v.mobile, hasTouch: v.mobile, reducedMotion: 'reduce', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      const page = await context.newPage();
      await page.clock.install({ time: T0 });
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
      if (route === '/bebidas') await page.waitForSelector('main ul li h3');
      await sleep(600);
      // Congela os temporizadores (carrossel, rotação das bebidas, "aberto agora"): nada muda entre uma captura e outra.
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(new Date(now + 50));
      await sleep(200);
      const settle = async () => {
        await Promise.race([
          page.evaluate(async () => {
            const imgs = [...document.images].filter((i) => {
              const r = i.getBoundingClientRect();
              return r.bottom > -200 && r.top < innerHeight + 200 && getComputedStyle(i).display !== 'none';
            });
            await Promise.all(imgs.map((i) => (i.complete ? i.decode().catch(() => undefined) : new Promise((res) => { i.onload = () => i.decode().catch(() => undefined).then(res); i.onerror = res; }))));
          }),
          sleep(9000),
        ]);
        await sleep(500);
      };
      if (route === '/bebidas') {
        const total = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        let i = 0;
        for (const y of [0, 700, 1500, 3200, Math.round(total * 0.5), total]) {
          await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y);
          await sleep(300);
          await settle();
          await page.screenshot({ path: `${OUT}/${v.name}-bebidas-${String(i++).padStart(2, '0')}.png` });
        }
      } else {
        await settle();
        await page.screenshot({ path: `${OUT}/${v.name}-home-00.png` });
      }
      await context.close();
    }
  }
  await browser.close();
  console.log('ok', fs.readdirSync(OUT).length, 'capturas');
})();
