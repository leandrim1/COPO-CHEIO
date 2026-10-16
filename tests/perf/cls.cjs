// Saltos de layout (CLS) da carga a frio, com o elemento que se mexeu em cada salto. usage: node tests/perf/cls.cjs <url-base> [caminho] [android|tablet|desktop]
const { chromium, LAUNCH_ARGS, throttle } = require('./lib.cjs');

const [, , BASE, PATH_ = '/bebidas', PROFILE = 'android'] = process.argv;
if (!BASE) {
  console.error('uso: node tests/perf/cls.cjs <url-base> [caminho] [android|tablet|desktop]');
  process.exit(1);
}
const profiles = {
  android: { viewport: { width: 412, height: 915 }, dpr: 2.625, mobile: true, throttle: 'android' },
  desktop: { viewport: { width: 1366, height: 768 }, dpr: 1, mobile: false, throttle: 'android' },
  tablet: { viewport: { width: 820, height: 1180 }, dpr: 2, mobile: true, throttle: 'android' },
};
const P = profiles[PROFILE];

(async () => {
  const browser = await chromium.launch({ args: LAUNCH_ARGS });
  const context = await browser.newContext({ viewport: P.viewport, deviceScaleFactor: P.dpr, isMobile: P.mobile, hasTouch: P.mobile });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await throttle(client, P.throttle);
  await page.addInitScript(() => {
    window.__shifts = [];
    new PerformanceObserver((list) =>
      list.getEntries().forEach((e) => {
        if (e.hadRecentInput) return;
        window.__shifts.push({ valor: +e.value.toFixed(4), em_ms: Math.round(e.startTime), elementos: (e.sources || []).map((s) => ({ no: s.node ? `${s.node.nodeName}.${String(s.node.className || '').slice(0, 60)}` : null, de: [Math.round(s.previousRect.y), Math.round(s.previousRect.height)], para: [Math.round(s.currentRect.y), Math.round(s.currentRect.height)] })) });
      }),
    ).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(BASE + PATH_, { waitUntil: 'load' });
  if (PATH_ === '/bebidas') await page.waitForSelector('main ul li h3');
  await page.waitForTimeout(5000);
  const shifts = await page.evaluate(() => window.__shifts);
  console.log(`CLS ${shifts.reduce((s, x) => s + x.valor, 0).toFixed(4)} (${shifts.length} salto(s))`);
  if (shifts.length) console.log(JSON.stringify(shifts, null, 1));
  await browser.close();
})();
