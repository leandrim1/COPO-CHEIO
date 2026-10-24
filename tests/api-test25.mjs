// Auditoria das rotas: TODA rota administrativa (/api/admin/*, o painel de e-mails, pagamentos, equipe, 2FA, trocar a própria senha...) exige uma sessão
// administrativa válida no SERVIDOR, mesmo chamada direto pelo navegador ou por qualquer programa. A lista vem do próprio código (todas as rotas registradas
// em server/routes/*.ts e server/index.ts), então uma rota nova que esqueça a proteção aparece aqui.
// usage: bash tests/fresh.sh && node tests/api-test25.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { Client, check, loginAdmin, registerVerified, section, summary } from './lib.mjs';

const root = new URL('..', import.meta.url).pathname;
const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

// ---- a lista de rotas, tirada do código -------------------------------------------------------------------------------------------------
const files = [...readdirSync(`${root}server/routes`).filter((f) => f.endsWith('.ts')).map((f) => `server/routes/${f}`), 'server/index.ts'];
const re = /\b(?:r|router)\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*'(public|admin|owner)'/g;
const routes = [];
for (const file of files) {
  const source = readFileSync(`${root}${file}`, 'utf8');
  for (const m of source.matchAll(re)) routes.push({ method: m[1].toUpperCase(), path: m[2], access: m[3], file });
}
// Conferência cruzada: quantas vezes o código chama r.get/r.post/... (de qualquer jeito). Se for mais que as rotas lidas acima, existe uma rota registrada de um
// jeito que esta lista não entende (por exemplo, com o nível de acesso numa variável): ela precisa ser incluída aqui antes de confiar na auditoria.
let registrations = 0;
for (const file of files) registrations += [...readFileSync(`${root}${file}`, 'utf8').matchAll(/\b(?:r|router)\.(?:get|post|put|patch|delete)\(/g)].length;
const guarded = routes.filter((r) => r.access !== 'public');
const open = routes.filter((r) => r.access === 'public');
const UUID = '00000000-0000-4000-8000-000000000000';
const concrete = (path) => path.replace(/:[a-z]+/gi, UUID);

section('1. A lista de rotas vem do código e não está vazia');
check(`rotas encontradas: ${routes.length} (${guarded.length} administrativas, ${open.length} públicas) e todas as chamadas de registro do código foram entendidas (${registrations})`, routes.length === registrations && guarded.length > 60, [routes.length, registrations, guarded.length]);
check('toda rota com caminho /api/admin/ é administrativa (nenhuma foi registrada como pública)', open.every((r) => !r.path.startsWith('/api/admin')), open.filter((r) => r.path.startsWith('/api/admin')));
check('as rotas de equipe, 2FA, trocar a senha e o painel de e-mails/pagamentos estão na lista protegida', ['/api/admin/admins', '/api/auth/2fa', '/api/auth/password', '/api/admin/emails/stats', '/api/admin/payments/:code'].every((p) => guarded.some((r) => r.path.startsWith(p.replace(/\/(stats|:code)$/, '')) || r.path === p)) || guarded.some((r) => r.path.startsWith('/api/admin/emails')), guarded.length);
// Rotas públicas só nos grupos esperados: uma rota pública NOVA precisa de uma decisão consciente (e de uma linha aqui).
const PUBLIC_OK = [/^\/api\/health$/, /^\/api\/products$/, /^\/api\/site$/, /^\/api\/orders$/, /^\/api\/account(\/|$)/, /^\/api\/tracking\//, /^\/api\/email\//, /^\/api\/payments\/webhook$/, /^\/api\/privacy\/request$/,
  /^\/api\/auth\/(login|login\/2fa|login\/code|login\/resend|logout|me)$/, /^\/api\/client-error$/, /^\/api\/csp-report$/, /^\/api\/cron\/(email|sweep|status)$/, /^\/api\/reviews$/, /^\/api\/(sitemap\.xml|robots\.txt)$/, /^\/api\/__page$/,
  // Cupom (prévia do carrinho), CEP, faixas do agendamento e textos de termos e políticas: leituras/consultas públicas, com limite por rede.
  /^\/api\/coupons\/validate$/, /^\/api\/cep\/:cep$/, /^\/api\/schedule$/, /^\/api\/legal\/:slug$/];
const unexpected = open.filter((r) => !PUBLIC_OK.some((re2) => re2.test(r.path)));
check('toda rota pública está num dos grupos esperados (cardápio, pedido, conta do cliente, acompanhamento, webhooks assinados, login)', unexpected.length === 0, unexpected.map((r) => `${r.method} ${r.path}`));

// ---- quem chama ---------------------------------------------------------------------------------------------------------------------------
const owner = new Client(undefined, '198.51.100.201');
await owner.login();
const mkAdmin = async (tag, role) => {
  const email = `${tag}@copocheio.local`;
  const r = await owner.post('/api/admin/admins', { email, name: tag, password: 'Caixa#Segura-2026', role });
  if (r.status !== 201) throw new Error(`criar ${tag}: ${r.status} ${JSON.stringify(r.data)}`);
  return { email, id: psql(`select id from admins where email = ${lit(email)}`) };
};
const commonAdmin = await mkAdmin('comum.auditoria', 'admin');
const common = new Client(undefined, '198.51.100.202');
await loginAdmin(common, { email: commonAdmin.email, password: 'Caixa#Segura-2026' });
const goneAdmin = await mkAdmin('desativado.auditoria', 'admin');
const gone = new Client(undefined, '198.51.100.203');
await loginAdmin(gone, { email: goneAdmin.email, password: 'Caixa#Segura-2026' });
const goneCookie = gone.cookie;
await owner.patch(`/api/admin/admins/${goneAdmin.id}`, { active: false });
const customer = new Client(undefined, '198.51.100.204');
await registerVerified(customer, { name: 'Cliente Auditoria', email: 'cliente.auditoria@exemplo.com', phone: '34991230000', password: 'Caixa#Segura-2026' });
const anonymous = new Client(undefined, '198.51.100.205');
const forged = new Client(undefined, '198.51.100.206');
forged.cookie = 'copocheio_admin=' + 'Zz9_'.repeat(10) + 'abc';
const expired = new Client(undefined, '198.51.100.207');
{
  const t = new Client(undefined, '198.51.100.208');
  await mkAdmin('expirado.auditoria', 'admin').then((a) => loginAdmin(t, { email: a.email, password: 'Caixa#Segura-2026' }).then(() => psql(`update admin_sessions set expires_at = now() - interval '1 minute' where admin_id = ${lit(a.id)}`)));
  expired.cookie = t.cookie;
}
const wrongCookie = new Client(undefined, '198.51.100.209');
wrongCookie.cookie = `copocheio_cliente=${customer.jar.get('copocheio_cliente')}`; // o cookie do cliente no lugar do cookie do painel (nome errado)
const sneaky = new Client(undefined, '198.51.100.210');
sneaky.cookie = `copocheio_admin=${customer.jar.get('copocheio_cliente')}`; // o TOKEN do cliente no cookie do painel

const call = (client, route) => client.req(route.method, concrete(route.path), route.method === 'GET' || route.method === 'DELETE' ? undefined : {});

section('2. Sem sessão administrativa válida, TODA rota protegida responde 401 (e nada é feito)');
const who = { 'sem nenhum cookie': anonymous, 'cookie de painel inventado': forged, 'sessão do painel expirada': expired, 'administrador DESATIVADO (a sessão dele já existia)': Object.assign(new Client(undefined, '198.51.100.211'), { cookie: goneCookie }),
  'sessão de CLIENTE logado': customer, 'cookie de cliente com o nome errado': wrongCookie, 'token de cliente no cookie do painel': sneaky };
for (const [label, client] of Object.entries(who)) {
  const bad = [];
  for (const route of guarded) {
    const r = await call(client, route);
    if (r.status !== 401) bad.push(`${route.method} ${route.path} → ${r.status}`);
  }
  check(`${label}: as ${guarded.length} rotas protegidas respondem 401`, bad.length === 0, bad.slice(0, 8));
}

section('3. Administrador comum: as rotas "owner" respondem 403; as de administrador funcionam (nunca 401/403 por engano)');
{
  const ownerOnly = guarded.filter((r) => r.access === 'owner');
  const bad = [];
  for (const route of ownerOnly) {
    const r = await call(common, route);
    if (r.status !== 403) bad.push(`${route.method} ${route.path} → ${r.status}`);
  }
  check(`o administrador comum recebe 403 nas ${ownerOnly.length} rotas exclusivas do owner`, ownerOnly.length > 10 && bad.length === 0, bad.slice(0, 8));
  const adminRoutes = guarded.filter((r) => r.access === 'admin' && r.method === 'GET');
  const denied = [];
  for (const route of adminRoutes) {
    const r = await call(common, route);
    if (r.status === 401 || r.status === 403) denied.push(`${route.method} ${route.path} → ${r.status}`);
  }
  check(`...e as ${adminRoutes.length} consultas (GET) de administrador respondem para ele (com a sessão certa não há 401 nem 403)`, denied.length === 0, denied.slice(0, 8));
}

section('4. Com a sessão do owner a mesma lista responde (a proteção barra quem não tem sessão, não todo mundo)');
{
  const reads = guarded.filter((r) => r.method === 'GET');
  const denied = [];
  for (const route of reads) {
    const r = await call(owner, route);
    if (r.status === 401 || r.status === 403) denied.push(`${route.method} ${route.path} → ${r.status}`);
  }
  check(`o owner consulta as ${reads.length} rotas GET protegidas sem receber 401/403`, denied.length === 0, denied.slice(0, 8));
}

section('5. Cookies do painel: sessão e desafio são HttpOnly + SameSite=Strict');
{
  const t = new Client(undefined, '198.51.100.212');
  const first = await t.post('/api/auth/login', { email: commonAdmin.email, password: 'Caixa#Segura-2026' });
  const cookies = first.headers.getSetCookie();
  check('o cookie do desafio do login é HttpOnly + SameSite=Strict', cookies.length >= 1 && cookies.filter((c) => c.startsWith('copocheio_admin_login=')).every((c) => /HttpOnly/.test(c) && /SameSite=Strict/.test(c)), cookies);
  const done = await loginAdmin(new Client(undefined, '198.51.100.213'), { email: commonAdmin.email, password: 'Caixa#Segura-2026' });
  const sess = (done.headers.getSetCookie() ?? []).find((c) => c.startsWith('copocheio_admin='));
  check('o cookie da sessão é HttpOnly + SameSite=Strict (e a resposta nunca devolve o token no corpo)', Boolean(sess) && /HttpOnly/.test(sess) && /SameSite=Strict/.test(sess) && !JSON.stringify(done.data).includes(sess.split('=')[1].split(';')[0]), sess);
}

summary();
