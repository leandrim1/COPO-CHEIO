// Benchmark do site (Chromium com celular simulado: CPU mais lenta e rede 4G lenta). Mede, para a página escolhida:
//   carga a frio  → FCP, LCP, CLS, TBT, bytes por tipo, requisições, memória (heap JS) e nós do DOM;
//   rolagem       → quadros (p50/p95/máximo, quantos passaram de 50 ms), bytes e fotos baixadas ao rolar o cardápio inteiro;
//   interações    → toque em "Adicionar" (6 produtos espalhados), digitar na busca e abrir o pedido (duração de cada interação, como o INP);
//   volta ao site → quanto baixa de novo e em quanto tempo o cardápio aparece, com o cache do navegador;
//   "jump"        → rola rápido até 45% do cardápio e PARA: quanto tempo até todas as fotos que estão na tela carregarem.
// usage: node tests/perf/bench.cjs --url http://127.0.0.1:4291 --label novo --page /bebidas --profile android --runs 3 --scenario full --out saida.json
//        --scenario: full (tudo acima, menos "jump"), jump ou load (só a carga a frio).  --profile: android | iphone | desktop | weak
const fs = require('fs');
const { PROFILES, launch, newContext, throttle, median, percentile, arg } = require('./lib.cjs');

const URL_BASE = arg('url');
const LABEL = arg('label', 'run');
const PAGE_PATH = arg('page', '/bebidas');
const PROFILE = arg('profile', 'android');
const RUNS = Number(arg('runs', 5));
const OUT = arg('out');
const SCENARIO = arg('scenario', 'full');
if (!URL_BASE) {
  console.error('faltou --url (ex.: --url http://127.0.0.1:4180)');
  process.exit(1);
}
const P = PROFILES[PROFILE];
const tapOrClick = (loc) => (P.mobile ? loc.tap() : loc.click());

// Observadores que rodam dentro da página desde o primeiro instante.
const INIT = () => {
  const w = window;
  w.__perf = { lcp: null, lcpInfo: null, cls: 0, shifts: [], longTasks: [], events: [], productsAt: null, fcp: null };
  const obs = (type, fn, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra });
    } catch {}
  };
  obs('largest-contentful-paint', (e) => {
    w.__perf.lcp = e.startTime;
    w.__perf.lcpInfo = { tag: e.element?.tagName ?? null, url: e.url || null, size: e.size };
  });
  obs('layout-shift', (e) => {
    if (!e.hadRecentInput) {
      w.__perf.cls += e.value;
      w.__perf.shifts.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime) });
    }
  });
  obs('paint', (e) => {
    if (e.name === 'first-contentful-paint') w.__perf.fcp = e.startTime;
  });
  obs('longtask', (e) => w.__perf.longTasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }));
  obs('event', (e) => w.__perf.events.push({ n: e.name, id: e.interactionId, d: Math.round(e.duration) }), { durationThreshold: 16 });
  // Quando o primeiro produto aparece na tela (cartão com nome).
  const mo = new MutationObserver(() => {
    if (!w.__perf.productsAt && document.querySelector('main ul li h3')) {
      w.__perf.productsAt = performance.now();
      mo.disconnect();
    }
  });
  const start = () => mo.observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start);
};

async function run(browser, n) {
  const context = await newContext(browser, PROFILE);
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Performance.enable');
  await throttle(client, PROFILE);
  await page.addInitScript(INIT);

  const reqs = new Map();
  client.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, { url: e.request.url, type: e.type, bytes: 0 }));
  client.on('Network.loadingFinished', (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.bytes = e.encodedDataLength;
      r.done = true;
    }
  });
  const snap = () => {
    const by = {};
    let total = 0;
    let count = 0;
    for (const r of reqs.values()) {
      if (!r.done || r.url.startsWith('data:')) continue;
      const k = r.type === 'XHR' || r.type === 'Fetch' ? 'API' : r.type;
      by[k] ??= { n: 0, bytes: 0 };
      by[k].n++;
      by[k].bytes += r.bytes;
      total += r.bytes;
      count++;
    }
    return { total, count, by };
  };
  const metrics = async () => Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const result = { run: n };

  // ---- 1. Carga fria ------------------------------------------------------------------------------------------
  await page.goto(URL_BASE + PAGE_PATH, { waitUntil: 'load', timeout: 120000 });
  if (PAGE_PATH === '/bebidas') await page.waitForSelector('main ul li h3', { timeout: 120000 });
  await page.waitForTimeout(4000);
  const m1 = await metrics();
  const perf1 = await page.evaluate(() => ({ ...window.__perf, nav: (() => { const nav = performance.getEntriesByType('navigation')[0]; return { dcl: nav.domContentLoadedEventEnd, load: nav.loadEventEnd, ttfb: nav.responseStart }; })() }));
  const longAfterFcp = perf1.longTasks.filter((t) => t.s + t.d > (perf1.fcp ?? 0));
  result.cold = {
    fcp: perf1.fcp,
    lcp: perf1.lcp,
    lcpInfo: perf1.lcpInfo,
    cls: +perf1.cls.toFixed(4),
    shifts: perf1.shifts,
    productsAt: perf1.productsAt,
    ttfb: perf1.nav.ttfb,
    load: perf1.nav.load,
    tbt: longAfterFcp.reduce((s, t) => s + Math.max(0, t.d - 50), 0),
    longTasks: longAfterFcp.length,
    net: snap(),
    cpu: { script: m1.ScriptDuration, layout: m1.LayoutDuration, style: m1.RecalcStyleDuration, task: m1.TaskDuration },
    heapMB: m1.JSHeapUsedSize / 1048576,
    nodes: m1.Nodes,
  };

  if (SCENARIO === 'jump' && PAGE_PATH === '/bebidas') {
    const before = snap();
    await page.evaluate(async () => {
      const total = document.documentElement.scrollHeight - innerHeight;
      const target = total * 0.45;
      const t0 = performance.now();
      await new Promise((resolve) => {
        const step = () => {
          const y = Math.min(target, ((performance.now() - t0) / 1000) * 1200);
          window.scrollTo({ top: y, behavior: 'instant' });
          if (y >= target) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
    });
    const t0 = Date.now();
    let doneMs = null;
    let shown = 0;
    while (Date.now() - t0 < 150000) {
      const state = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('main ul li img')].filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.bottom > 0 && r.top < innerHeight;
        });
        return { n: imgs.length, ok: imgs.filter((el) => el.complete && el.naturalWidth > 0).length };
      });
      shown = state.n;
      if (state.n > 0 && state.ok === state.n) {
        doneMs = Date.now() - t0;
        break;
      }
      await page.waitForTimeout(100);
    }
    const after = snap();
    result.jump = { visibleImages: shown, doneMs, imageBytesUntilDone: (after.by.Image?.bytes ?? 0) - (before.by.Image?.bytes ?? 0), imageCountUntilDone: (after.by.Image?.n ?? 0) - (before.by.Image?.n ?? 0) };
  }

  if (SCENARIO === 'full' && PAGE_PATH === '/bebidas') {
    // ---- 2. Rolagem do cardápio inteiro (1200 px/s), medindo quadros e imagens baixadas ---------------------------------
    const before = snap();
    const mBefore = await metrics();
    const frames = await page.evaluate(async () => {
      const frames = [];
      let last = performance.now();
      let go = true;
      const tick = (t) => {
        frames.push(t - last);
        last = t;
        if (go) requestAnimationFrame(tick);
      };
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
      return { frames, total, ms: performance.now() - t0 };
    });
    // Espera todas as imagens pedidas terminarem (rede ociosa por 3 s), no máximo 160 s: o total é o custo REAL de rolar o cardápio inteiro.
    const idleStart = Date.now();
    let quietSince = Date.now();
    while (Date.now() - idleStart < 160000) {
      const pending = [...reqs.values()].filter((r) => !r.done && !r.url.startsWith('data:')).length;
      if (pending > 0) quietSince = Date.now();
      if (Date.now() - quietSince > 3000) break;
      await page.waitForTimeout(500);
    }
    const idleMs = Date.now() - idleStart;
    const after = snap();
    const mAfter = await metrics();
    const fr = frames.frames.slice(1);
    result.scroll = {
      pageHeight: frames.total + P.viewport.height,
      ms: Math.round(frames.ms),
      idleMs,
      frames: fr.length,
      p50: +percentile(fr, 50).toFixed(1),
      p95: +percentile(fr, 95).toFixed(1),
      max: +Math.max(...fr).toFixed(1),
      over50: fr.filter((d) => d > 50).length,
      over100: fr.filter((d) => d > 100).length,
      imageBytes: (after.by.Image?.bytes ?? 0) - (before.by.Image?.bytes ?? 0),
      imageCount: (after.by.Image?.n ?? 0) - (before.by.Image?.n ?? 0),
      totalBytes: after.total - before.total,
      cpu: { script: mAfter.ScriptDuration - mBefore.ScriptDuration, layout: mAfter.LayoutDuration - mBefore.LayoutDuration, style: mAfter.RecalcStyleDuration - mBefore.RecalcStyleDuration, task: mAfter.TaskDuration - mBefore.TaskDuration },
    };
    result.afterScroll = { net: after, heapMB: mAfter.JSHeapUsedSize / 1048576, nodes: mAfter.Nodes };

    // ---- 3. Interações: tocar em "Adicionar" em produtos espalhados, digitar na busca, abrir o pedido ------------------------
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForTimeout(800);
    await page.evaluate(() => (window.__perf.events.length = 0));
    const adds = page.locator('main ul li button[aria-label^="Adicionar "]');
    for (const idx of [0, 5, 12, 20, 30, 45]) {
      const b = adds.nth(idx);
      await b.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(500);
      await tapOrClick(b).catch(() => {});
      await page.waitForTimeout(700);
    }
    const tapEvents = await page.evaluate(() => window.__perf.events.slice());
    await page.evaluate(() => {
      window.__perf.events.length = 0;
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
    await page.waitForTimeout(500);
    await tapOrClick(page.locator('input[type=search]'));
    await page.keyboard.type('coca', { delay: 160 });
    await page.waitForTimeout(900);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    await page.waitForTimeout(900);
    const typeEvents = await page.evaluate(() => window.__perf.events.slice());
    await page.evaluate(() => (window.__perf.events.length = 0));
    await tapOrClick(page.getByRole('button', { name: /Ver pedido/ }).first()).catch(() => {});
    await page.waitForTimeout(1200);
    const drawerEvents = await page.evaluate(() => window.__perf.events.slice());
    const interactions = (events) => {
      const g = new Map();
      for (const e of events) if (e.id) g.set(e.id, Math.max(g.get(e.id) ?? 0, e.d));
      return [...g.values()];
    };
    result.interaction = { add: interactions(tapEvents), typing: interactions(typeEvents), drawer: interactions(drawerEvents) };
    const m3 = await metrics();
    result.final = { heapMB: m3.JSHeapUsedSize / 1048576, nodes: m3.Nodes };

    // ---- 4. Volta ao site com cache (mesmo navegador): quem volta abre o endereço de novo (não faz "recarregar" forçado) --------
    const beforeRev = snap();
    const t1 = Date.now();
    await page.goto(URL_BASE + PAGE_PATH, { waitUntil: 'load', timeout: 120000 });
    await page.waitForSelector('main ul li h3', { timeout: 120000 });
    result.revisit = { toProductsMs: Date.now() - t1, productsAt: await page.evaluate(() => window.__perf.productsAt) };
    await page.waitForTimeout(3000);
    const afterRev = snap();
    result.revisit.bytes = afterRev.total - beforeRev.total;
    result.revisit.requests = afterRev.count - beforeRev.count;
  }
  await context.close();
  return result;
}

(async () => {
  const browser = await launch();
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await run(browser, i + 1);
    runs.push(r);
    console.log(`[${LABEL}] ${PROFILE} ${PAGE_PATH} execução ${i + 1}/${RUNS}: LCP ${Math.round(r.cold.lcp)} ms · FCP ${Math.round(r.cold.fcp)} ms · CLS ${r.cold.cls} · TBT ${r.cold.tbt} ms · ${(r.cold.net.total / 1024).toFixed(0)} KB em ${r.cold.net.count} requisições${r.scroll ? ` | rolagem p95 ${r.scroll.p95} ms, ${r.scroll.over50} quadros > 50 ms, fotos ${(r.scroll.imageBytes / 1048576).toFixed(1)} MB` : ''}`);
  }
  await browser.close();
  const pick = (f) => median(runs.map(f));
  const summary = {
    label: LABEL, page: PAGE_PATH, profile: PROFILE, runs: RUNS,
    fcp: pick((r) => r.cold.fcp), lcp: pick((r) => r.cold.lcp), cls: pick((r) => r.cold.cls), tbt: pick((r) => r.cold.tbt), longTasks: pick((r) => r.cold.longTasks),
    productsAt: pick((r) => r.cold.productsAt), load: pick((r) => r.cold.load),
    coldBytes: pick((r) => r.cold.net.total), coldRequests: pick((r) => r.cold.net.count),
    coldJS: pick((r) => r.cold.net.by.Script?.bytes), coldCSS: pick((r) => r.cold.net.by.Stylesheet?.bytes), coldImg: pick((r) => r.cold.net.by.Image?.bytes), coldImgN: pick((r) => r.cold.net.by.Image?.n), coldAPI: pick((r) => r.cold.net.by.API?.bytes), coldAPIn: pick((r) => r.cold.net.by.API?.n),
    cpuScript: pick((r) => r.cold.cpu.script), cpuLayout: pick((r) => r.cold.cpu.layout), cpuStyle: pick((r) => r.cold.cpu.style), cpuTask: pick((r) => r.cold.cpu.task),
    heapMB: pick((r) => r.cold.heapMB), nodes: pick((r) => r.cold.nodes),
  };
  if (runs[0].scroll) {
    Object.assign(summary, {
      scrollP50: pick((r) => r.scroll.p50), scrollP95: pick((r) => r.scroll.p95), scrollMax: pick((r) => r.scroll.max), scrollOver50: pick((r) => r.scroll.over50), scrollOver100: pick((r) => r.scroll.over100),
      scrollFrames: pick((r) => r.scroll.frames), scrollIdleMs: pick((r) => r.scroll.idleMs), scrollImgBytes: pick((r) => r.scroll.imageBytes), scrollImgN: pick((r) => r.scroll.imageCount),
      scrollTaskCpu: pick((r) => r.scroll.cpu.task), totalImgBytes: pick((r) => r.afterScroll.net.by.Image?.bytes), totalBytesAfterScroll: pick((r) => r.afterScroll.net.total),
      heapAfterScrollMB: pick((r) => r.afterScroll.heapMB), nodesAfterScroll: pick((r) => r.afterScroll.nodes),
      addMax: pick((r) => Math.max(0, ...r.interaction.add)), addMed: pick((r) => median(r.interaction.add)), typingMax: pick((r) => Math.max(0, ...r.interaction.typing)), typingMed: pick((r) => median(r.interaction.typing)), drawerMax: pick((r) => Math.max(0, ...r.interaction.drawer)),
      heapFinalMB: pick((r) => r.final.heapMB),
      revisitProductsMs: pick((r) => r.revisit.toProductsMs), revisitBytes: pick((r) => r.revisit.bytes), revisitRequests: pick((r) => r.revisit.requests),
    });
  }
  if (runs[0].jump) Object.assign(summary, { jumpVisible: pick((r) => r.jump.visibleImages), jumpDoneMs: pick((r) => r.jump.doneMs), jumpBytes: pick((r) => r.jump.imageBytesUntilDone), jumpImgN: pick((r) => r.jump.imageCountUntilDone) });
  console.log(JSON.stringify(summary, null, 1));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, runs }, null, 1));
})();
