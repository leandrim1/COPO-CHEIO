import { spawn } from 'node:child_process';
import { Client, check, section, summary } from './lib.mjs';

const anon = new Client();
const owner = new Client();
await owner.login();

section('Administradores (só o owner) e senhas');
let staff;
{
  check('owner lista administradores', (await owner.get('/api/admin/admins')).data.admins.length === 1);
  check('lista não traz hash de senha', !JSON.stringify((await owner.get('/api/admin/admins')).data).includes('scrypt'));
  const mk = await owner.post('/api/admin/admins', { name: 'Atendente', email: 'Atendente@Copocheio.local', password: 'Caixa#Segura-2026', role: 'admin' });
  check('owner cria administrador', mk.status === 201 && mk.data.admin.email === 'atendente@copocheio.local' && mk.data.admin.role === 'admin', mk.data);
  staff = mk.data.admin;
  check('e-mail repetido → 409', (await owner.post('/api/admin/admins', { name: 'Outro', email: 'atendente@copocheio.local', password: 'Caixa#Segura-2026' })).status === 409);
  check('senha curta → 400', (await owner.post('/api/admin/admins', { name: 'Outro', email: 'novo@x.com', password: '123' })).status === 400);
  check('e-mail inválido → 400', (await owner.post('/api/admin/admins', { name: 'Outro', email: 'novo', password: '12345678' })).status === 400);

  const s = new Client();
  const login = await s.login('atendente@copocheio.local', 'Caixa#Segura-2026');
  check('administrador novo entra', login.data.admin.role === 'admin');
  check('administrador comum usa o painel', (await s.get('/api/admin/orders')).status === 200 && (await s.post('/api/admin/categories', { name: 'Feita pelo atendente' })).status === 201);
  check('administrador comum NÃO gerencia administradores (403)', (await s.get('/api/admin/admins')).status === 403 && (await s.post('/api/admin/admins', { name: 'x', email: 'x@x.com', password: '12345678' })).status === 403);
  check('administrador comum NÃO se promove (403)', (await s.patch(`/api/admin/admins/${staff.id}`, { role: 'owner' })).status === 403);

  // trocar a própria senha
  const wrong = await s.patch('/api/auth/password', { current: 'errada', next: 'nova-senha-123' });
  check('trocar senha com a atual errada → 400', wrong.status === 400);
  check('senha nova curta → 400', (await s.patch('/api/auth/password', { current: 'Caixa#Segura-2026', next: 'curta' })).status === 400);
  const other = new Client();
  await other.login('atendente@copocheio.local', 'Caixa#Segura-2026');
  const change = await s.patch('/api/auth/password', { current: 'Caixa#Segura-2026', next: 'nova-senha-123' });
  check('trocar a própria senha', change.status === 200);
  check('sessão atual continua', (await s.get('/api/admin/orders')).status === 200);
  check('outras sessões da conta são encerradas', (await other.get('/api/admin/orders')).status === 401);
  check('senha antiga não vale mais', (await new Client().post('/api/auth/login', { email: 'atendente@copocheio.local', password: 'Caixa#Segura-2026' })).status === 401);
  check('senha nova vale', (await new Client().post('/api/auth/login', { email: 'atendente@copocheio.local', password: 'nova-senha-123' })).status === 200);

  // owner redefine a senha → sessões derrubadas
  const live = new Client();
  await live.login('atendente@copocheio.local', 'nova-senha-123');
  const reset = await owner.patch(`/api/admin/admins/${staff.id}`, { password: 'redefinida-123' });
  check('owner redefine a senha', reset.status === 200 && !JSON.stringify(reset.data).includes('scrypt'));
  check('sessões abertas dessa pessoa caem', (await live.get('/api/admin/orders')).status === 401);

  // desativar
  const off = await owner.patch(`/api/admin/admins/${staff.id}`, { active: false });
  check('owner desativa administrador', off.data.admin.active === false);
  const sOff = new Client();
  check('desativado não entra', (await sOff.post('/api/auth/login', { email: 'atendente@copocheio.local', password: 'redefinida-123' })).status === 401);
  await owner.patch(`/api/admin/admins/${staff.id}`, { active: true });
  const sBack = new Client();
  await sBack.login('atendente@copocheio.local', 'redefinida-123');
  await owner.patch(`/api/admin/admins/${staff.id}`, { active: false });
  check('desativar derruba a sessão aberta', (await sBack.get('/api/admin/orders')).status === 401);

  // proteções do owner
  const me = (await owner.get('/api/auth/me')).data.admin;
  check('owner não se desativa', (await owner.patch(`/api/admin/admins/${me.id}`, { active: false })).status === 400);
  check('owner não se rebaixa', (await owner.patch(`/api/admin/admins/${me.id}`, { role: 'admin' })).status === 400);
  check('owner não se remove', (await owner.del(`/api/admin/admins/${me.id}`)).status === 400);
  // segundo owner: aí o primeiro pode ser rebaixado por ele, mas nunca o último
  const o2 = (await owner.post('/api/admin/admins', { name: 'Sócio', email: 'socio@copocheio.local', password: 'Socio#Forte-2026', role: 'owner' })).data.admin;
  const c2 = new Client();
  await c2.login('socio@copocheio.local', 'Socio#Forte-2026');
  check('segundo owner rebaixa o primeiro', (await c2.patch(`/api/admin/admins/${me.id}`, { role: 'admin' })).status === 200);
  check('não rebaixa o último owner (nem ele mesmo)', (await c2.patch(`/api/admin/admins/${o2.id}`, { role: 'admin' })).status === 400);
  check('primeiro virou admin comum (403 em /admins)', (await owner.get('/api/admin/admins')).status === 403);
  await c2.patch(`/api/admin/admins/${me.id}`, { role: 'owner' });
  check('owner volta', (await owner.get('/api/admin/admins')).status === 200);
  check('remover administrador', (await owner.del(`/api/admin/admins/${staff.id}`)).status === 200 && (await owner.get('/api/admin/admins')).data.admins.length === 2);
  await owner.del(`/api/admin/admins/${o2.id}`);
  check('sessão de quem foi removido cai', (await c2.get('/api/admin/orders')).status === 401);
}

section('Segurança extra');
{
  // limite por IP de pedidos que deram certo
  const prod = (await owner.get('/api/admin/products')).data.products.find((p) => p.stock === null && p.active && !p.sold_out);
  check('há produto para o teste de IP', !!prod);
  const c = new Client(undefined, '203.0.113.9');
  const results = [];
  for (let i = 0; i < 21; i++) {
    results.push(
      await c.post('/api/orders', {
        customer_name: 'Cliente ' + i,
        customer_phone: `349${String(80000000 + i)}`,
        delivery_type: 'pickup',
        payment_method: 'pix',
        items: [{ product_id: prod.id, quantity: 1 }],
      }),
    );
  }
  check('20 pedidos do mesmo IP passam, o 21º é bloqueado (429)', results.slice(0, 20).every((r) => r.status === 201) && results[20].status === 429, results.map((r) => r.status).join());

  check('corpo não JSON recusado (415)', (await anon.req('POST', '/api/orders', 'oi', { raw: true, headers: { 'content-type': 'text/plain' } })).status === 415);
  check('JSON gigante recusado (413)', (await anon.req('POST', '/api/orders', JSON.stringify({ x: 'a'.repeat(70_000) }), { raw: true, headers: { 'content-type': 'application/json' } })).status === 413);
  const err = await anon.get('/api/admin/orders');
  check('erro não vaza detalhes internos', !/neon|postgres|select |stack/i.test(JSON.stringify(err.data)));
}

section('Sem variáveis de ambiente: mensagem exata');
{
  const code = `
    import { build } from 'esbuild';
    await build({ entryPoints: ['api/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'tests/build/api-noenv.mjs', logLevel: 'error' });
    const { default: handler } = await import('./tests/build/api-noenv.mjs');
    import('node:http').then(({ default: http }) => http.createServer(handler).listen(4195, '127.0.0.1'));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2500));
  const bare = new Client('http://127.0.0.1:4195');
  const site = await bare.get('/api/site');
  check('/api/site sem DATABASE_URL → 503 dizendo qual variável falta', site.status === 503 && site.data.code === 'not_configured' && site.data.missing?.join() === 'DATABASE_URL' && /DATABASE_URL/.test(site.data.error), site.data);
  const health = await bare.get('/api/health');
  check('health sem variáveis', health.data.database === 'missing' && health.data.blob === 'missing', health.data);
  const login = await bare.post('/api/auth/login', { email: 'a@b.com', password: '12345678' });
  check('login sem DATABASE_URL → 503', login.status === 503 && login.data.missing?.[0] === 'DATABASE_URL', login.data);
  child.kill();
}

section('Blob sem token ou privado');
{
  // O servidor de teste tem token; aqui só confere o caminho "token ausente" pela função isolada.
  const code = `
    import { build } from 'esbuild';
    await build({ entryPoints: ['api/index.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: 'tests/build/api-noblob.mjs', logLevel: 'error' });
    const { neonConfig } = await import('@neondatabase/serverless');
    const { startNeonProxy } = await import('./tests/neon-proxy.mjs');
    const p = await startNeonProxy({ connectionString: 'postgres://postgres@127.0.0.1:5433/copocheio_test', port: 0 });
    neonConfig.fetchEndpoint = () => 'http://127.0.0.1:' + p.server.address().port + '/sql';
    process.env.DATABASE_URL = 'postgresql://u:p@ep-x.neon.local/db';
    const { default: handler } = await import('./tests/build/api-noblob.mjs');
    import('node:http').then(({ default: http }) => http.createServer(handler).listen(4196, '127.0.0.1'));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url).pathname, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 3000));
  const c = new Client('http://127.0.0.1:4196');
  await c.login();
  const png = (await import('node:fs')).readFileSync(new URL('./fixtures/a.png', import.meta.url));
  const up = await c.post('/api/admin/upload?folder=products', png, { raw: true, headers: { 'content-type': 'image/png' } });
  check('upload sem BLOB_READ_WRITE_TOKEN → 503 dizendo qual variável falta', up.status === 503 && up.data.missing?.[0] === 'BLOB_READ_WRITE_TOKEN', up.data);
  check('o resto do painel segue funcionando sem o Blob', (await c.get('/api/admin/orders')).status === 200);
  child.kill();
}

summary();
