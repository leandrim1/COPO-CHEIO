// Quando a foto principal da página aparece de verdade (candidatos a LCP ao longo de 12 s depois da carga) e a linha do tempo das imagens (início → fim,
// tamanho, prioridade), com a rede e a CPU do celular simulado. Mostra também fotos pedidas duas vezes e avisos do console (ex.: foto adiantada e não usada).
// O LCP "do laboratório" de outras ferramentas pode parar antes de a foto chegar; aqui se espera até a rede assentar.
// usage: node tests/perf/lcp.cjs <url-base> <rótulo> [execuções] [perfil: android|weak|desktop] [página: /bebidas]
const { launch, newContext, throttle, median } = require('./lib.cjs');

const [, , BASE, LABEL = 'x', RUNS = '3', PROFILE = 'android', PAGE = '/bebidas'] = process.argv;
if (!BASE) {
  console.error('uso: node tests/perf/lcp.cjs <url-base> <rótulo> [execuções] [perfil] [página]');
  process.exit(1);
}

(async () => {
  const browser = await launch();
  const out = [];
  for (let r = 0; r < Number(RUNS); r++) {
    const context = await newContext(browser, PROFILE);
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__lcp = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__lcp.push({ t: Math.round(e.startTime), tag: e.element?.tagName, url: (e.url || '').split('/').pop() }))).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const client = await context.newCDPSession(page);
    await throttle(client, PROFILE);
    const warns = [];
    page.on('console', (m) => {
      if (m.type() === 'warning' || m.type() === 'error') warns.push(m.text().slice(0, 160));
    });
    const reqs = new Map();
    let t0 = null;
    client.on('Network.requestWillBeSent', (e) => {
      if (t0 === null) t0 = e.timestamp;
      reqs.set(e.requestId, { url: e.request.url, s: e.timestamp - t0, type: e.type, prio: e.request.initialPriority });
    });
    client.on('Network.loadingFinished', (e) => {
      const q = reqs.get(e.requestId);
      if (q) {
        q.e = e.timestamp - t0;
        q.bytes = e.encodedDataLength;
      }
    });
    await page.goto(BASE + PAGE, { waitUntil: 'load', timeout: 120000 });
    if (PAGE === '/bebidas') await page.waitForSelector('main ul li h3', { timeout: 120000 });
    await page.waitForTimeout(12000);
    const lcp = await page.evaluate(() => window.__lcp);
    const last = lcp[lcp.length - 1];
    const imgs = [...reqs.values()].filter((q) => q.type === 'Image' && q.e).map((q) => ({ n: q.url.split('/').pop(), s: Math.round(q.s * 1000), e: Math.round(q.e * 1000), kb: Math.round(q.bytes / 1024), prio: q.prio }));
    const counts = {};
    for (const i of imgs) counts[i.n] = (counts[i.n] ?? 0) + 1;
    out.push({ lcp: last?.t, el: last ? `${last.tag}:${last.url}` : null, imgs, dup: Object.entries(counts).filter(([, n]) => n > 1), warns });
    await context.close();
  }
  await browser.close();
  console.log(`[${LABEL}] ${PROFILE} ${PAGE}: LCP (candidato final) por execução ${out.map((o) => o.lcp).join(', ')} ms · mediana ${median(out.map((o) => o.lcp))} ms · elemento ${out[0].el}`);
  console.log(`  fotos pedidas mais de uma vez: ${JSON.stringify(out[0].dup)} · avisos do console: ${JSON.stringify(out[0].warns)}`);
  console.log('  fotos (1ª execução, na ordem do pedido):');
  for (const i of out[0].imgs.sort((a, b) => a.s - b.s).slice(0, 16)) console.log(`   ${String(i.s).padStart(5)} → ${String(i.e).padStart(5)} ms  ${String(i.kb).padStart(4)} KB  ${String(i.prio).padEnd(8)} ${i.n}`);
})();
