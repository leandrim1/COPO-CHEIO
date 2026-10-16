// Interações do cardápio com a CPU do celular simulado (só a CPU: a rede é a normal): toque em "Adicionar" (6 produtos espalhados), digitar na
// busca e abrir o pedido. Mostra a duração de cada interação (o que o navegador chama de INP: da ação até a tela mudar), o tempo de CPU da
// thread principal por toque e, para o toque, de onde vem o tempo: atraso de entrada (a thread estava ocupada), processamento (o JavaScript do
// site) e atraso de apresentação (estilo, layout e pintura). usage: node tests/perf/interactions.cjs <url-base> <rótulo> [execuções]
const { launch, newContext, median, throttle } = require('./lib.cjs');

const [, , BASE, LABEL = 'x', RUNS = '3'] = process.argv;
if (!BASE) {
  console.error('uso: node tests/perf/interactions.cjs <url-base> <rótulo> [execuções]');
  process.exit(1);
}

(async () => {
  const browser = await launch();
  const all = { add: [], typing: [], drawer: [], cpuPerTap: [], parts: [] };
  for (let r = 0; r < Number(RUNS); r++) {
    const context = await newContext(browser, 'android');
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__ev = [];
      new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => window.__ev.push({ id: e.interactionId, d: Math.round(e.duration), delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart, pres: e.startTime + e.duration - e.processingEnd })),
      ).observe({ type: 'event', buffered: true, durationThreshold: 16 });
    });
    const client = await context.newCDPSession(page);
    await throttle(client, 'android', { network: false });
    await client.send('Performance.enable');
    await page.goto(BASE + '/bebidas', { waitUntil: 'load' });
    await page.waitForSelector('main ul li h3');
    await page.waitForTimeout(3500); // a primeira tela termina de carregar antes de medir
    const durations = (events) => {
      const g = new Map();
      for (const e of events) if (e.id) g.set(e.id, Math.max(g.get(e.id) ?? 0, e.d));
      return [...g.values()];
    };
    // O evento mais demorado de cada interação, com as três partes dele.
    const longest = (events) => {
      const g = new Map();
      for (const e of events) if (e.id && (!g.has(e.id) || e.d > g.get(e.id).d)) g.set(e.id, e);
      return [...g.values()];
    };
    const take = () => page.evaluate(() => window.__ev.splice(0));
    const task = async () => (await client.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value;
    await take();
    const adds = page.locator('main ul li button[aria-label^="Adicionar "]');
    for (const idx of [0, 5, 12, 20, 30, 45]) {
      const b = adds.nth(idx);
      await b.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(700);
      await take();
      const t0 = await task();
      await b.tap().catch(() => {});
      await page.waitForTimeout(900);
      all.cpuPerTap.push(Math.round(((await task()) - t0) * 1000));
      const events = await take();
      all.add.push(...durations(events));
      all.parts.push(...longest(events));
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(600);
    await take();
    await page.locator('input[type=search]').tap();
    await page.keyboard.type('coca', { delay: 160 });
    await page.waitForTimeout(900);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(900);
    all.typing.push(...durations(await take()));
    await page.getByRole('button', { name: /Ver pedido/ }).first().tap().catch(() => {});
    await page.waitForTimeout(1200);
    all.drawer.push(...durations(await take()));
    await context.close();
  }
  await browser.close();
  const show = (list) => `mediana ${median(list)} ms · máximo ${Math.max(0, ...list)} ms (n=${list.length})`;
  console.log(`[${LABEL}] tocar em "Adicionar": ${show(all.add)}`);
  const part = (k) => Math.round(median(all.parts.map((e) => e[k])));
  console.log(`[${LABEL}]   …do toque, de onde vem o tempo (mediana): atraso de entrada ${part('delay')} ms · processamento (JavaScript) ${part('proc')} ms · atraso de apresentação (estilo/layout/pintura) ${part('pres')} ms`);
  console.log(`[${LABEL}] CPU da thread principal por toque (inclui o que a página faz em volta): ${show(all.cpuPerTap)}`);
  console.log(`[${LABEL}] digitar na busca: ${show(all.typing)}`);
  console.log(`[${LABEL}] abrir o pedido: ${show(all.drawer)}`);
})();
