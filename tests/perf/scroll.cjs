// Custo de RENDERIZAÇÃO ao rolar o cardápio, sem o ruído da rede: carrega e decodifica tudo, volta ao topo e rola de novo (1200 px/s) com a CPU
// do celular simulado. Soma, na thread principal, o tempo de pintura, camadas, composição e script (do "trace" do Chromium) e conta os quadros
// lentos. usage: node tests/perf/scroll.cjs <url-base> <rótulo> [execuções]
const { launch, newContext, median, percentile, throttle } = require('./lib.cjs');

const [, , BASE, LABEL = 'x', RUNS = '5'] = process.argv;
if (!BASE) {
  console.error('uso: node tests/perf/scroll.cjs <url-base> <rótulo> [execuções]');
  process.exit(1);
}

(async () => {
  const browser = await launch();
  const rows = [];
  for (let r = 0; r < Number(RUNS); r++) {
    const context = await newContext(browser, 'android', { reducedMotion: 'reduce' });
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await page.goto(BASE + '/bebidas', { waitUntil: 'load' });
    await page.waitForSelector('main ul li h3');
    // 1ª passada (sem estrangular): só para baixar e decodificar todas as fotos.
    await page.evaluate(async () => {
      const total = document.documentElement.scrollHeight - innerHeight;
      for (let y = 0; y <= total; y += 500) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((res) => setTimeout(res, 60));
      }
      await Promise.all([...document.images].map((i) => (i.complete ? 1 : new Promise((res) => { i.onload = i.onerror = res; setTimeout(res, 8000); }))));
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(1500);
    await throttle(client, 'android', { network: false });
    await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
    const frames = await page.evaluate(async () => {
      const frames = [];
      let last = performance.now();
      let go = true;
      const tick = (t) => { frames.push(t - last); last = t; if (go) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      const total = document.documentElement.scrollHeight - innerHeight;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const y = Math.min(total, ((performance.now() - t0) / 1000) * 1200);
          window.scrollTo({ top: y, behavior: 'instant' });
          if (y >= total) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      go = false;
      return frames.slice(1);
    });
    const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
    const threads = new Map();
    for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
    const main = new Set([...threads].filter(([, n]) => n === 'CrRendererMain').map(([k]) => k));
    const sums = {};
    for (const e of events) if (e.ph === 'X' && main.has(`${e.pid}:${e.tid}`)) sums[e.name] = (sums[e.name] ?? 0) + e.dur / 1000;
    rows.push({ frames: frames.length, p95: percentile(frames, 95), over50: frames.filter((d) => d > 50).length, task: sums.RunTask, paint: sums.Paint, layerize: sums.Layerize, commit: sums.Commit, prepaint: sums.PrePaint, style: sums.UpdateLayoutTree, layout: sums.Layout });
    await context.close();
  }
  await browser.close();
  const col = (k) => Math.round(median(rows.map((r) => r[k])));
  console.log(`[${LABEL}] ${col('frames')} quadros, p95 ${median(rows.map((r) => r.p95)).toFixed(1)} ms, ${col('over50')} acima de 50 ms | thread principal (ms): total ${col('task')} · pintura ${col('paint')} · camadas ${col('layerize')} · commit ${col('commit')} · pré-pintura ${col('prepaint')} · estilo ${col('style')} · layout ${col('layout')}`);
})();
