// Lighthouse (simulação padrão: celular = Moto G Power, 4G lento, CPU 4×; computador = rede de 10 Mbps, sem estrangular a CPU) sobre o site de TESTE, usando o
// Chromium do Playwright. O Lighthouse NÃO faz parte do projeto (não é dependência): instale numa pasta à parte —
//   mkdir -p /tmp/lh && cd /tmp/lh && npm init -y && npm i lighthouse@12
// e rode DE LÁ, apontando para este arquivo:   node /caminho/do/projeto/tests/perf/lighthouse.mjs <url> <rótulo> <mobile|desktop> <execuções> <saída.json>
// (as bibliotecas são procuradas a partir da pasta onde o comando é executado).
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(`${process.cwd()}/`);
const lighthouse = (await import(require.resolve('lighthouse'))).default;
const chromeLauncher = await import(require.resolve('chrome-launcher'));
const playwright = createRequire(new URL('../package.json', import.meta.url))('playwright');

const [, , URL_, LABEL = 'x', FORM = 'mobile', RUNS = '3', OUT] = process.argv;
if (!URL_) {
  console.error('uso: node tests/perf/lighthouse.mjs <url> <rótulo> <mobile|desktop> <execuções> <saída.json>');
  process.exit(1);
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

const results = [];
for (let i = 0; i < Number(RUNS); i++) {
  const chrome = await chromeLauncher.launch({
    chromePath: playwright.chromium.executablePath(),
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--proxy-server=direct://', '--host-resolver-rules=MAP d8j0ntlcm91z4.cloudfront.net 127.0.0.1:1'],
  });
  try {
    const flags = { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'], formFactor: FORM };
    const config =
      FORM === 'desktop'
        ? { extends: 'lighthouse:default', settings: { formFactor: 'desktop', screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }, throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } } }
        : undefined;
    const { lhr } = await lighthouse(URL_, flags, config);
    const a = lhr.audits;
    const items = a['network-requests']?.details?.items ?? [];
    const sum = (f) => items.filter(f).reduce((t, x) => t + (x.transferSize ?? 0), 0);
    results.push({
      desempenho: Math.round((lhr.categories.performance.score ?? 0) * 100),
      acessibilidade: Math.round((lhr.categories.accessibility.score ?? 0) * 100),
      boas_praticas: Math.round((lhr.categories['best-practices'].score ?? 0) * 100),
      seo: Math.round((lhr.categories.seo.score ?? 0) * 100),
      fcp: Math.round(a['first-contentful-paint'].numericValue),
      lcp: Math.round(a['largest-contentful-paint'].numericValue),
      tbt: Math.round(a['total-blocking-time'].numericValue),
      cls: +(a['cumulative-layout-shift'].numericValue ?? 0).toFixed(3),
      speedIndex: Math.round(a['speed-index'].numericValue),
      requisicoes: items.length,
      transferKB: Math.round(items.reduce((t, x) => t + (x.transferSize ?? 0), 0) / 1024),
      jsKB: Math.round(sum((x) => x.resourceType === 'Script') / 1024),
      imagensKB: Math.round(sum((x) => x.resourceType === 'Image') / 1024),
      elementoLCP: a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet?.slice(0, 120) ?? null,
      oportunidades: Object.values(a).filter((x) => x.details?.type === 'opportunity' && x.numericValue > 100).map((x) => `${x.id}:${Math.round(x.numericValue)}ms`),
    });
  } finally {
    await chrome.kill();
  }
}
const keys = Object.keys(results[0]).filter((k) => typeof results[0][k] === 'number');
const mediana = Object.fromEntries(keys.map((k) => [k, median(results.map((r) => r[k]))]));
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ rotulo: LABEL, url: URL_, formato: FORM, execucoes: results, mediana }, null, 2));
console.log(`${LABEL} ${FORM} ${URL_}`);
console.log(JSON.stringify(mediana));
console.log('elemento do LCP:', results[0].elementoLCP);
console.log('oportunidades:', results[0].oportunidades.join(', '));
