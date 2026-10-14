// Servidor de teste: site estático (dist) + a função /api exatamente como a Vercel a chamaria,
// com Neon -> Postgres local (proxy HTTP) e Vercel Blob -> API falsa local.
import { neonConfig } from '@neondatabase/serverless';
import { build } from 'esbuild';
import http from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startNeonProxy } from './neon-proxy.mjs';
import { installDnsMock } from './dnsmock.mjs';
import { startMailSink } from './mailsink.mjs';
import { describeState, signBody, sim, updateCharge } from './payments-sim.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT ?? 4173);
const DIST = process.env.STATIC_DIR ?? join(root, 'dist');
const pgUrl = process.env.TEST_PG_URL ?? 'postgres://postgres@127.0.0.1:5433/copocheio_test';

// --- Neon ---
const proxy = await startNeonProxy({ connectionString: pgUrl, port: 0 });
const proxyPort = proxy.server.address().port;
neonConfig.fetchEndpoint = () => `http://127.0.0.1:${proxyPort}/sql`;

// --- Vercel Blob falso ---
const files = new Map();
const blobStore = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (process.env.BLOB_LOG) console.log('[blob]', req.method, req.url, JSON.stringify({ auth: req.headers.authorization?.slice(0, 20), store: req.headers['x-vercel-blob-store-id'] }));
  if (process.env.BLOB_MODE === 'oidc' && (req.method === 'PUT' || url.pathname === '/delete') && !(req.headers.authorization === `Bearer ${process.env.VERCEL_OIDC_TOKEN}` && /teststore/.test(String(req.headers['x-vercel-blob-store-id'])))) {
    return json(401, { error: { code: 'forbidden', message: 'oidc credentials missing' } });
  }
  if (req.method === 'PUT') {
    const pathname = url.searchParams.get('pathname');
    if (process.env.BLOB_FAIL) return json(400, { error: { code: 'forbidden', message: 'private store' } });
    files.set(pathname, { body, type: req.headers['x-content-type'] ?? 'application/octet-stream' });
    return json(200, {
      url: `https://teststore.public.blob.vercel-storage.com/${pathname}`,
      downloadUrl: `https://teststore.public.blob.vercel-storage.com/${pathname}?download=1`,
      pathname,
      contentType: req.headers['x-content-type'],
      contentDisposition: 'inline',
      etag: '"etag"',
    });
  }
  if (req.method === 'POST' && url.pathname === '/delete') {
    for (const u of JSON.parse(body.toString()).urls) files.delete(new URL(u).pathname.slice(1));
    return json(200, {});
  }
  if (req.method === 'GET' && url.pathname === '/__files') return json(200, [...files.keys()]);
  if (req.method === 'GET' && url.pathname.startsWith('/f/')) {
    const f = files.get(decodeURIComponent(url.pathname.slice(3)));
    if (!f) return res.writeHead(404).end();
    return res.writeHead(200, { 'content-type': f.type }).end(f.body);
  }
  return json(404, { error: { code: 'not_found', message: 'nope' } });
});
await new Promise((r) => blobStore.listen(Number(process.env.BLOB_PORT ?? 0), '127.0.0.1', r));
process.env.VERCEL_BLOB_API_URL = `http://127.0.0.1:${blobStore.address().port}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const FAKE_OIDC = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ sub: 'owner:team:project:copocheio:environment:production', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
if (process.env.BLOB_MODE === 'oidc') {
  // Blob novo: sem BLOB_READ_WRITE_TOKEN; OIDC da Vercel + BLOB_STORE_ID
  delete process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_STORE_ID = 'store_teststore';
  process.env.VERCEL_OIDC_TOKEN = FAKE_OIDC;
} else process.env[process.env.BLOB_TOKEN_NAME ?? 'BLOB_READ_WRITE_TOKEN'] = 'vercel_blob_rw_teststore_abc123';
process.env.DATABASE_URL = 'postgresql://user:pass@ep-test.neon.local/neondb?sslmode=require';

// --- E-mail (SMTP de mentira) e DNS de mentira ---
// MAIL_MODE=none sobe o servidor SEM variáveis SMTP (para testar "e-mail não configurado"); DNS_MODE=broken derruba o DNS.
// MAIL_MODE=env mantém as variáveis SMTP exatamente como vieram do ambiente (para testar combinações parciais).
const sink = ['none', 'env'].includes(process.env.MAIL_MODE ?? '') ? null : await startMailSink(Number(process.env.SINK_PORT ?? 0));
if (sink) {
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(sink.port);
  process.env.SMTP_SECURE = 'false';
  process.env.SMTP_USER = 'loja@copocheio.test';
  process.env.SMTP_PASS = 'secret';
  process.env.MAIL_FROM = 'Copo Cheio <loja@copocheio.test>';
} else if (process.env.MAIL_MODE !== 'env') for (const name of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']) delete process.env[name];
installDnsMock({ broken: process.env.DNS_MODE === 'broken' });
// Segredo do cron diário (/api/cron/email): valor só dos testes. Em produção vem das variáveis da Vercel.
process.env.CRON_SECRET ??= 'segredo-do-cron-so-de-teste-0123456789';

// --- API (a mesma função que a Vercel executa) ---
await build({
  entryPoints: [join(root, 'api/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: join(here, 'build/api.mjs'),
  logLevel: 'error',
  // Só nos testes: no lugar da fábrica de operadoras (que em produção não devolve nenhuma), entra o SIMULADOR de tests/payments-sim.mjs.
  plugins: [
    {
      name: 'simulador-de-pagamento',
      setup(b) {
        b.onResolve({ filter: /\/factory\.js$/ }, (args) => {
          if (!args.importer.endsWith('server/payments/provider.ts')) return undefined;
          // PAYMENTS_SIM=validapay: o adaptador REAL da ValidaPay (server/payments/validapay.ts), apontado para o servidor ValidaPay FALSO dos testes.
          if (process.env.PAYMENTS_SIM === 'validapay') return { path: join(here, 'factory-validapay.ts') };
          return { path: join(here, 'payments-sim.mjs'), external: true };
        });
      },
    },
  ],
});
// O HTML que a função entrega aos robôs é o index.html da mesma pasta de arquivos estáticos que este servidor serve.
process.env.SHELL_HTML_FILE ??= join(DIST, 'index.html');
const { default: api } = await import(`./build/api.mjs?${Date.now()}`);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

// ---- vercel.json como a Vercel o lê ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const { getTransformedRoutes } = require('@vercel/routing-utils');
const transformed = getTransformedRoutes(JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')));
if (transformed.error) throw new Error(`vercel.json inválido: ${JSON.stringify(transformed.error)}`);
const ROUTES = transformed.routes ?? [];

function staticFile(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  let file = normalize(join(DIST, decoded));
  if (!file.startsWith(DIST)) return null;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

function hasAll(conditions, req, url) {
  return conditions.every((c) => {
    let actual;
    if (c.type === 'header') actual = req.headers[String(c.key).toLowerCase()];
    else if (c.type === 'query') actual = url.searchParams.get(c.key);
    else if (c.type === 'cookie') {
      const pair = String(req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=')).find(([name]) => name === c.key);
      actual = pair ? pair.slice(1).join('=') : undefined;
    }
    else if (c.type === 'host') actual = req.headers.host;
    if (actual === undefined || actual === null) return false;
    return c.value === undefined ? true : new RegExp(c.value).test(String(actual));
  });
}

function resolveRoute(req, url) {
  const headers = {};
  for (const r of ROUTES) {
    if (r.handle === 'filesystem') {
      // api/index.ts é a função de /api: na Vercel ela vem da etapa de arquivos, antes das reescritas.
      if (url.pathname === '/api') return { kind: 'function', headers };
      const file = staticFile(url.pathname === '/' ? '/index.html' : url.pathname);
      if (file) return { kind: 'static', file, headers };
      continue;
    }
    if (!r.src) continue;
    const m = new RegExp(r.src).exec(url.pathname);
    if (!m) continue;
    if (r.has && !hasAll(r.has, req, url)) continue;
    if (r.missing && hasAll(r.missing, req, url)) continue;
    // Redirecionamento do vercel.json: resposta 307/308 com o Location que a biblioteca calculou.
    if (r.status && r.headers?.Location) return { kind: 'redirect', status: r.status, location: r.headers.Location, headers };
    if (r.headers) Object.assign(headers, r.headers);
    if (r.dest) return { kind: 'rewrite', dest: r.dest.replace(/\$(\d)/g, (_x, i) => m[Number(i)] ?? ''), headers };
  }
  return { kind: 'none', headers };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // Só para os testes: ler os e-mails "enviados" e simular falhas do servidor de e-mail.
  if (url.pathname === '/__mail' && sink) {
    if (req.method === 'DELETE') {
      sink.messages.length = 0;
      return res.writeHead(200).end('{}');
    }
    const to = (url.searchParams.get('to') ?? '').toLowerCase();
    const list = sink.messages.filter((m) => !to || m.to.includes(to));
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
  }
  if (url.pathname === '/__mail/stats' && sink) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sink.stats));
  }
  if (url.pathname === '/__mail/mode' && sink && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    sink.mode.failure = body.failure ?? null;
    sink.mode.delayMs = body.delayMs ?? 0;
    return res.writeHead(200).end('{}');
  }
  // Só para os testes: controla o simulador de operadora de pagamento e dispara "avisos" (webhooks) assinados para a rota real.
  if (url.pathname.startsWith('/__pay/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const reply = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/__pay/reset') {
      sim.reset();
      return reply(200, {});
    }
    if (url.pathname === '/__pay/mode') {
      Object.assign(sim.mode, body);
      return reply(200, sim.mode);
    }
    if (url.pathname === '/__pay/state') return reply(200, describeState());
    if (url.pathname.startsWith('/__pay/charge/')) {
      const snap = updateCharge(decodeURIComponent(url.pathname.slice('/__pay/charge/'.length)), body);
      return snap ? reply(200, snap) : reply(404, { error: 'cobrança desconhecida' });
    }
    if (url.pathname === '/__pay/webhook') {
      // body: { events | (id, type, chargeId, reference, snapshot), sign: false | 'wrong', raw: 'texto qualquer' }
      const text = typeof body.raw === 'string' ? body.raw : JSON.stringify(body.events ? { events: body.events } : { id: body.id, type: body.type, charge_id: body.chargeId, reference: body.reference, snapshot: body.snapshot });
      const headers = { 'content-type': 'application/json' };
      if (body.sign !== false) headers['x-simulador-assinatura'] = body.sign === 'wrong' ? 'a'.repeat(64) : signBody(text);
      const response = await fetch(`http://127.0.0.1:${PORT}/api/payments/webhook`, { method: 'POST', headers, body: text });
      return reply(200, { status: response.status, body: await response.json().catch(() => null) });
    }
    return reply(404, {});
  }
  // Roteamento IGUAL ao do vercel.json: as regras vêm da biblioteca da própria Vercel (@vercel/routing-utils), na mesma ordem em que a
  // plataforma as aplica: cabeçalhos, arquivos estáticos e só então as reescritas (que podem exigir um cabeçalho, como o User-Agent).
  const outcome = resolveRoute(req, url);
  const send = (status, headers, body) => {
    res.writeHead(status, { ...outcome.headers, ...headers });
    res.end(body);
  };
  // Cabeçalhos do vercel.json valem também para as respostas da função (a função, se quiser, sobrescreve os dela).
  const callApi = (apiUrl) => {
    if (process.env.REWRITE === '0') {
      // Sem reescrita (vite dev e alguns testes): a função recebe o endereço original.
    } else req.url = apiUrl;
    for (const [name, value] of Object.entries(outcome.headers)) res.setHeader(name, value);
    Promise.resolve(api(req, res)).catch((e) => {
      console.error('API crash', e);
      res.statusCode = 500;
      res.end('crash');
    });
  };
  if (outcome.kind === 'redirect') return send(outcome.status, { location: outcome.location, 'cache-control': 'no-store' }, '');
  if (outcome.kind === 'function') return callApi(req.url);
  if (outcome.kind === 'static') return send(200, { 'content-type': MIME[extname(outcome.file)] ?? 'application/octet-stream' }, readFileSync(outcome.file));
  if (outcome.kind === 'rewrite' && outcome.dest.startsWith('/api')) {
    // A reescrita junta a consulta original ao destino (?__path=...&resto).
    const original = url.search ? url.search.slice(1) : '';
    const dest = outcome.dest + (original ? (outcome.dest.includes('?') ? '&' : '?') + original : '');
    return callApi(dest);
  }
  if (outcome.kind === 'rewrite') {
    const file = staticFile(outcome.dest.split('?')[0]);
    if (file) return send(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }, readFileSync(file));
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return callApi(req.url);
  send(404, { 'content-type': 'text/plain' }, 'not found');
});
server.listen(PORT, '127.0.0.1', () => console.log(`test server on http://127.0.0.1:${PORT} (blob fake on ${process.env.VERCEL_BLOB_API_URL})`));
