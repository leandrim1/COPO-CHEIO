// Peças comuns das ferramentas de medição de desempenho (tests/perf): Playwright (instalado em tests/node_modules), perfis de aparelho e rede,
// estatística simples e as opções do Chromium que deixam a medição repetível. Veja tests/perf/README.md.
const { createRequire } = require('node:module');
const path = require('node:path');

const fromTests = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = fromTests('playwright');

const kbps = (mbps) => (mbps * 1024 * 1024) / 8;

// Perfis de aparelho + rede. "android": celular de entrada/intermediário (412 × 915, DPR 2,625), CPU 4× mais lenta e 4G lento (1,6 Mbps, 150 ms) —
// a mesma ideia do perfil móvel do Lighthouse. "weak": aparelho muito fraco (CPU 6× mais lenta, 0,8 Mbps, 300 ms).
const PROFILES = {
  android: { viewport: { width: 412, height: 915 }, dpr: 2.625, mobile: true, cpu: 4, net: { latency: 150, down: kbps(1.6), up: kbps(0.73) }, ua: 'Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' },
  iphone: { viewport: { width: 390, height: 844 }, dpr: 3, mobile: true, cpu: 4, net: { latency: 150, down: kbps(1.6), up: kbps(0.73) } },
  desktop: { viewport: { width: 1366, height: 768 }, dpr: 1, mobile: false, cpu: 1, net: { latency: 40, down: kbps(10), up: kbps(5) } },
  weak: { viewport: { width: 360, height: 740 }, dpr: 2, mobile: true, cpu: 6, net: { latency: 300, down: kbps(0.8), up: kbps(0.39) }, ua: 'Mozilla/5.0 (Linux; Android 9; SM-J400M) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36' },
};

// O vídeo da capa fica num endereço de fora (CloudFront) que estes testes não alcançam: o endereço aponta para uma porta fechada, igual em todas as
// medições. `--proxy-server=direct://` ignora o proxy do ambiente (só importa onde o ambiente tem um).
const LAUNCH_ARGS = ['--enable-precise-memory-info', '--proxy-server=direct://', '--host-resolver-rules=MAP d8j0ntlcm91z4.cloudfront.net 127.0.0.1:1'];
const launch = (extra = []) => chromium.launch({ args: [...LAUNCH_ARGS, ...extra] });

async function newContext(browser, profile, extra = {}) {
  const P = PROFILES[profile];
  if (!P) throw new Error(`perfil desconhecido: ${profile} (use ${Object.keys(PROFILES).join(', ')})`);
  return browser.newContext({ viewport: P.viewport, deviceScaleFactor: P.dpr, isMobile: P.mobile, hasTouch: P.mobile, userAgent: P.ua, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', ...extra });
}

// Rede e CPU do perfil, pelo protocolo do Chrome (DevTools): é o mesmo estrangulamento do painel "Network" e "Performance" do Chrome.
async function throttle(client, profile, { network = true, cpu = true } = {}) {
  const P = PROFILES[profile];
  if (network) {
    await client.send('Network.enable');
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: P.net.latency, downloadThroughput: P.net.down, uploadThroughput: P.net.up });
  }
  if (cpu && P.cpu > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: P.cpu });
}

const median = (list) => {
  const s = list.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};
const percentile = (list, p) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

module.exports = { chromium, PROFILES, LAUNCH_ARGS, launch, newContext, throttle, median, percentile, arg, flag, root: path.join(__dirname, '..', '..') };
