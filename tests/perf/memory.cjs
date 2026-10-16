// Memória do navegador depois de rolar o cardápio inteiro (celular simulado, rede normal: só a memória importa aqui). Lê a memória proporcional (PSS)
// dos processos do Chromium desta página em /proc (Linux) — inclui as fotos decodificadas, que o heap do JavaScript não mostra — e soma os pixels das
// fotos carregadas. usage: node tests/perf/memory.cjs <url-base> <rótulo> [execuções]
const fs = require('fs');
const { launch, newContext, median } = require('./lib.cjs');

const [, , BASE, LABEL = 'x', RUNS = '3'] = process.argv;
if (!BASE) {
  console.error('uso: node tests/perf/memory.cjs <url-base> <rótulo> [execuções]');
  process.exit(1);
}
const pss = (pid) => {
  try {
    return Number(/Pss:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1]) / 1024;
  } catch {
    return null;
  }
};

(async () => {
  const rows = [];
  for (let r = 0; r < Number(RUNS); r++) {
    const browser = await launch();
    const context = await newContext(browser, 'android');
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Performance.enable');
    const browserClient = await browser.newBrowserCDPSession(); // a lista de processos só existe na sessão do navegador (não da página)
    await page.goto(BASE + '/bebidas', { waitUntil: 'load' });
    await page.waitForSelector('main ul li h3');
    await page.waitForTimeout(1500);
    const procs = async () => {
      const out = { renderer: 0, gpu: 0, total: 0 };
      for (const p of (await browserClient.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] }))).processInfo) {
        const m = pss(p.id);
        if (m === null) continue;
        if (p.type === 'renderer') out.renderer += m;
        if (p.type === 'GPU') out.gpu += m;
        if (['renderer', 'GPU', 'browser', 'utility'].includes(p.type)) out.total += m;
      }
      return out;
    };
    const start = await procs();
    await page.evaluate(async () => {
      const total = document.documentElement.scrollHeight;
      for (let y = 0; y <= total; y += 450) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise((res) => setTimeout(res, 120));
      }
      await Promise.all([...document.images].map((i) => (i.complete ? 1 : new Promise((res) => { i.onload = i.onerror = res; setTimeout(res, 6000); }))));
    });
    await page.waitForTimeout(2500);
    const end = await procs();
    const m = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
    const imgs = await page.evaluate(() => {
      const list = [...document.images].filter((i) => i.currentSrc && i.complete && i.naturalWidth > 0);
      return { n: list.length, decodedMB: list.reduce((s, i) => s + i.naturalWidth * i.naturalHeight * 4, 0) / 1048576 };
    });
    rows.push({ start, end, jsHeapMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, imgs });
    await browser.close();
  }
  const f = (k) => median(rows.map(k)).toFixed(0);
  console.log(`[${LABEL}] memória (PSS, MB) no início → depois de rolar tudo: renderizador ${f((r) => r.start.renderer)} → ${f((r) => r.end.renderer)} · GPU ${f((r) => r.start.gpu)} → ${f((r) => r.end.gpu)} · navegador inteiro ${f((r) => r.start.total)} → ${f((r) => r.end.total)} | heap JS ${f((r) => r.jsHeapMB)} MB · ${f((r) => r.nodes)} nós · ${f((r) => r.imgs.n)} fotos (≈ ${f((r) => r.imgs.decodedMB)} MB de pixels decodificados)`);
})();
