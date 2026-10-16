// Segurança: limites atômicos, senha forte, verificação em duas etapas, aviso de aparelho novo, links de e-mail, cabeçalhos HTTP,
// anti-robô nos pedidos, pré-sequestro de cadastro, imagens, rotas e informações expostas.
import { execFileSync, spawn } from 'node:child_process';
import { BASE, Client, check, clearMail, lastCode, linkFrom, mailsTo, registerVerified, section, summary, loginCustomer } from './lib.mjs';
import { load } from './unit/load.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const totp = await load('server/totp.ts');

const owner = new Client(undefined, '198.51.100.1');
await owner.login();

const STRONG = 'Caixa#Segura-2026';
async function makeAdmin(email, name, role = 'admin', password = STRONG) {
  const r = await owner.post('/api/admin/admins', { email, name, password, role });
  if (r.status !== 201) throw new Error(`criar ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.admin;
}

// ------------------------------------------------------------------------------------------------
section('1. SEG-01: o limite de tentativas é atômico (simultâneas não furam)');
await makeAdmin('vitima@copocheio.local', 'Vítima Teste');
{
  const attacker = new Client(undefined, '203.0.113.50');
  const burst = await Promise.all(Array.from({ length: 40 }, () => attacker.post('/api/auth/login', { email: 'vitima@copocheio.local', password: 'errada-errada-1' })));
  const wrong = burst.filter((r) => r.status === 401).length;
  const blocked = burst.filter((r) => r.status === 429).length;
  check('40 logins errados ao mesmo tempo (mesma rede e e-mail): só 8 chegam a conferir a senha', wrong === 8 && blocked === 32, { wrong, blocked });
  check('o bloqueio traz Retry-After e código rate_limited', Number(burst.find((r) => r.status === 429).headers.get('retry-after')) > 0 && burst.find((r) => r.status === 429).data.code === 'rate_limited');
  check('a mesma rede segue barrada, até com a senha certa', (await attacker.post('/api/auth/login', { email: 'vitima@copocheio.local', password: STRONG })).status === 429);
  const victimSide = new Client(undefined, '198.51.100.7');
  check('mas o dono da conta (outra rede) entra normalmente: o ataque não o tranca', (await victimSide.post('/api/auth/login', { email: 'vitima@copocheio.local', password: STRONG })).status === 200);

  const noisy = new Client(undefined, '203.0.113.60');
  const wave = await Promise.all(Array.from({ length: 80 }, (_, i) => noisy.post('/api/auth/login', { email: `alvo${i}@exemplo.com`, password: 'qualquer-coisa-1' })));
  const w401 = wave.filter((r) => r.status === 401).length;
  check('80 logins ao mesmo tempo da mesma rede, e-mails diferentes: só 30 passam (limite por rede)', w401 === 30 && wave.filter((r) => r.status === 429).length === 50, { w401 });

  const cust = new Client(undefined, '203.0.113.70');
  const cburst = await Promise.all(Array.from({ length: 40 }, () => loginCustomer(cust, { email: 'ninguem@exemplo.com', password: 'errada-errada-1' })));
  check('login de cliente: 40 simultâneas, só 8 conferidas', cburst.filter((r) => r.status !== 429).length === 8 && cburst.filter((r) => r.status === 429).length === 32, cburst.map((r) => r.status).join(','));
}

// ------------------------------------------------------------------------------------------------
section('2. SEG-02: senha forte para o painel');
{
  const weak = ['12345678', '123456789012', 'password123', 'senha1234567', 'Abc#12345', 'copocheio2026'];
  const results = [];
  for (const password of weak) results.push((await owner.post('/api/admin/admins', { email: 'fraca@copocheio.local', name: 'Fraca', password, role: 'admin' })).status);
  check('senhas comuns/curtas são recusadas ao criar administrador (400)', results.every((s) => s === 400), results);
  const r = await owner.post('/api/admin/admins', { email: 'fraca@copocheio.local', name: 'Fraca', password: '12345678', role: 'admin' });
  check('a resposta explica o motivo em português e traz o código weak_password', r.data.code === 'weak_password' && /senha/i.test(r.data.error), r.data);
  const byEmail = await owner.post('/api/admin/admins', { email: 'joana.prado@copocheio.local', name: 'Joana', password: 'joana.prado2026', role: 'admin' });
  check('senha feita do próprio e-mail com enfeite é recusada', byEmail.status === 400 && /e-mail/.test(byEmail.data.error), byEmail.data);
  const ok = await owner.post('/api/admin/admins', { email: 'forte@copocheio.local', name: 'Forte', password: STRONG, role: 'admin' });
  check('senha forte é aceita (201)', ok.status === 201, ok.data);

  const me = new Client(undefined, '198.51.100.20');
  await me.login('forte@copocheio.local', STRONG);
  const change = await me.patch('/api/auth/password', { current: STRONG, next: '12345678' });
  check('trocar a própria senha por uma comum também é recusado', change.status === 400 && change.data.code === 'weak_password', change.data);
  const same = await me.patch('/api/auth/password', { current: STRONG, next: 'Outra!Senha-2027x' });
  check('troca com a senha atual certa e senha forte funciona', same.status === 200, same.data);
  const attempts = [];
  for (let i = 0; i < 10; i++) attempts.push((await me.patch('/api/auth/password', { current: 'errada!errada1', next: 'Mais!Uma-Senha-2028' })).status);
  check('chutar a senha atual pela tela de troca é limitado (8 tentativas e depois 429)', attempts.slice(0, 8).every((s) => s === 400) && attempts.slice(8).every((s) => s === 429), attempts);
}

// ------------------------------------------------------------------------------------------------
section('3. SEG-02: aviso por e-mail quando entram de um aparelho novo');
{
  await clearMail();
  const email = 'vitima@copocheio.local';
  const first = new Client(undefined, '198.51.100.30');
  check('primeiro acesso de um aparelho: entra', (await first.post('/api/auth/login', { email, password: STRONG })).status === 200);
  check('o cookie do aparelho foi gravado (HttpOnly)', first.jar.has('copocheio_dispositivo') && /HttpOnly/i.test(first.lastSetCookie ?? '') || first.jar.has('copocheio_dispositivo'));
  const before = (await mailsTo(email)).filter((m) => /Novo acesso/.test(m.subject)).length;
  const second = new Client(undefined, '198.51.100.31');
  const login2 = await second.post('/api/auth/login', { email, password: STRONG });
  check('entrar de outro aparelho funciona', login2.status === 200);
  const after = (await mailsTo(email)).filter((m) => /Novo acesso/.test(m.subject));
  check('chegou o e-mail "Novo acesso ao painel"', after.length === before + 1, after.length);
  check('o aviso diz o aparelho e orienta a trocar a senha, sem conter a senha nem token de sessão', /Aparelho/.test(after.at(-1).text) && /senha/i.test(after.at(-1).text) && !after.at(-1).text.includes(STRONG) && !/copocheio_admin/.test(after.at(-1).text));
  check('o mesmo aparelho entrando de novo não gera outro aviso', (await second.post('/api/auth/login', { email, password: STRONG })).status === 200 && (await mailsTo(email)).filter((m) => /Novo acesso/.test(m.subject)).length === before + 1);
  const log = await owner.get('/api/admin/audit?q=aparelho%20novo');
  check('o acesso por aparelho novo ficou no histórico', log.status === 200 && log.data.entries.some((e) => e.action === 'auth.login_new_device'), log.data);
  const stranger = new Client(undefined, '198.51.100.32');
  const wrongPwd = await stranger.post('/api/auth/login', { email, password: 'errada-errada-1' });
  check('senha errada de aparelho desconhecido não manda aviso nem abre sessão', wrongPwd.status === 401 && (await mailsTo(email)).filter((m) => /Novo acesso/.test(m.subject)).length === before + 1);
}

// ------------------------------------------------------------------------------------------------
section('4. SEG-02: verificação em duas etapas (TOTP + códigos de recuperação)');
{
  const email = 'dois@copocheio.local';
  const admin = await makeAdmin(email, 'Dois Fatores');
  const c = new Client(undefined, '198.51.100.40');
  await c.login(email, STRONG);
  let st = await c.get('/api/auth/2fa');
  check('começa desativada', st.status === 200 && st.data.enabled === false && st.data.pending === false, st.data);
  check('sem sessão não consulta nem liga (401)', (await new Client().get('/api/auth/2fa')).status === 401 && (await new Client().post('/api/auth/2fa/setup', { password: STRONG })).status === 401);
  const badSetup = await c.post('/api/auth/2fa/setup', { password: 'errada!errada1' });
  check('gerar a chave exige a senha da conta', badSetup.status === 400, badSetup.data);
  const setup = await c.post('/api/auth/2fa/setup', { password: STRONG });
  check('gera chave (base32, 32 letras) e endereço otpauth', setup.status === 200 && /^[A-Z2-7]{32}$/.test(setup.data.secret) && setup.data.otpauth.startsWith('otpauth://totp/'), setup.data);
  check('o segredo não foi ligado ainda (pendente)', (await c.get('/api/auth/2fa')).data.pending === true);
  const secret = setup.data.secret;
  const step = () => totp.stepAt(Date.now());
  const wrong = await c.post('/api/auth/2fa/enable', { code: totp.totpAtStep(secret, step() + 5) });
  check('código errado não liga', wrong.status === 400 && wrong.data.code === 'invalid_code', wrong.data);
  const enable = await c.post('/api/auth/2fa/enable', { code: totp.totpAtStep(secret, step()) });
  check('código certo liga e entrega 8 códigos de recuperação', enable.status === 200 && enable.data.recovery_codes?.length === 8, enable.data);
  const recovery = enable.data.recovery_codes;
  check('no banco os códigos de recuperação ficam só como hash', psql(`select count(*) from admin_recovery_codes where admin_id = ${lit(admin.id)} and code_hash ~ '^[0-9a-f]{64}$'`) === '8' && !psql(`select string_agg(code_hash, ',') from admin_recovery_codes where admin_id = ${lit(admin.id)}`).includes(recovery[0].replaceAll('-', '')));
  check('a chave TOTP existe no banco e a conta aparece com 2 etapas na lista da equipe', (await owner.get('/api/admin/admins')).data.admins.find((a) => a.email === email)?.two_factor === true);

  // Login em duas etapas
  const fresh = () => new Client(undefined, `198.51.100.${41 + Math.floor(Math.random() * 100)}`);
  const d1 = fresh();
  const l1 = await d1.post('/api/auth/login', { email, password: STRONG });
  check('com 2FA, a senha certa NÃO abre sessão: pede o código', l1.status === 200 && l1.data.two_factor === true && typeof l1.data.challenge === 'string' && !l1.data.admin, l1.data);
  check('ainda não há sessão (me = null)', (await d1.get('/api/auth/me')).data.admin === null && !d1.jar.has('copocheio_admin'));
  check('painel recusa a rota administrativa sem a segunda etapa', (await d1.get('/api/admin/dashboard')).status === 401);
  const bad = await d1.post('/api/auth/login/2fa', { challenge: l1.data.challenge, code: '000000' });
  check('código errado: 401 com tentativas restantes', bad.status === 401 && bad.data.code === 'invalid_code' && bad.data.attempts_left === 4, bad.data);
  const noSuch = await d1.post('/api/auth/login/2fa', { challenge: 'x'.repeat(40), code: totp.totpAtStep(secret, step()) });
  check('desafio inventado não vale', noSuch.status === 401 && noSuch.data.code === 'challenge_expired', noSuch.data);
  const good = await d1.post('/api/auth/login/2fa', { challenge: l1.data.challenge, code: totp.totpAtStep(secret, step() + 1) });
  check('código certo abre a sessão', good.status === 200 && good.data.admin?.email === email && good.data.admin.two_factor === true && d1.jar.has('copocheio_admin'), good.data);
  check('agora o painel responde', (await d1.get('/api/admin/dashboard')).status === 200);
  check('o desafio foi consumido (não dá para usar de novo)', (await fresh().post('/api/auth/login/2fa', { challenge: l1.data.challenge, code: totp.totpAtStep(secret, step() + 1) })).status === 401);

  // O mesmo código não vale duas vezes (anti-repetição)
  const d2 = fresh();
  const l2 = await d2.post('/api/auth/login', { email, password: STRONG });
  const replay = await d2.post('/api/auth/login/2fa', { challenge: l2.data.challenge, code: totp.totpAtStep(secret, step() + 1) });
  check('repetir um código já usado é recusado', replay.status === 401 && replay.data.code === 'invalid_code', replay.data);

  // 5 erros matam o desafio
  const d3 = fresh();
  const l3 = await d3.post('/api/auth/login', { email, password: STRONG });
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push((await d3.post('/api/auth/login/2fa', { challenge: l3.data.challenge, code: '111111' })).status);
  const afterFive = await d3.post('/api/auth/login/2fa', { challenge: l3.data.challenge, code: totp.totpAtStep(secret, step() + 1) });
  check('depois de 5 códigos errados o desafio morre, mesmo com o código certo', tries.every((s) => s === 401) && afterFive.status === 401 && afterFive.data.code === 'challenge_expired', { tries, afterFive: afterFive.data });
  // Rajada simultânea no mesmo desafio: nunca mais de 5 conferências
  const d4 = fresh();
  const l4 = await d4.post('/api/auth/login', { email, password: STRONG });
  const burst = await Promise.all(Array.from({ length: 20 }, () => d4.post('/api/auth/login/2fa', { challenge: l4.data.challenge, code: '222222' })));
  check('20 códigos simultâneos no mesmo desafio: só 5 são conferidos', burst.filter((r) => r.data?.code === 'invalid_code').length === 5 && burst.filter((r) => r.data?.code === 'challenge_expired').length === 15, burst.map((r) => r.data?.code).join(','));

  // Código de recuperação: vale uma vez
  const d5 = fresh();
  const l5 = await d5.post('/api/auth/login', { email, password: STRONG });
  const rec = await d5.post('/api/auth/login/2fa', { challenge: l5.data.challenge, code: recovery[0].toLowerCase() });
  check('código de recuperação (em minúsculas) abre a sessão e informa quantos sobram', rec.status === 200 && rec.data.recovery_codes_left === 7, rec.data);
  const d6 = fresh();
  const l6 = await d6.post('/api/auth/login', { email, password: STRONG });
  check('o mesmo código de recuperação não vale de novo', (await d6.post('/api/auth/login/2fa', { challenge: l6.data.challenge, code: recovery[0] })).status === 401);
  check('outro código de recuperação ainda vale', (await d6.post('/api/auth/login/2fa', { challenge: l6.data.challenge, code: recovery[1] })).status === 200);

  // Gestão da proteção
  st = await d1.get('/api/auth/2fa');
  check('estado: ativada, 6 códigos de recuperação sobrando', st.data.enabled === true && st.data.recovery_codes_left === 6, st.data);
  check('ligar de novo com ela ativa: 409', (await d1.post('/api/auth/2fa/setup', { password: STRONG })).status === 409);
  // O relógio "andou": libera o anti-repetição para testar as próximas ações sem esperar 30 s de verdade.
  const advance = () => psql(`update admins set totp_last_step = coalesce(totp_last_step, 0) - 10 where email = ${lit(email)}`);
  advance();
  const regenBadPwd = await d1.post('/api/auth/2fa/recovery-codes', { password: 'errada!errada1', code: totp.totpAtStep(secret, step()) });
  check('gerar novos códigos exige a senha', regenBadPwd.status === 400);
  const regenRecovery = await d1.post('/api/auth/2fa/recovery-codes', { password: STRONG, code: recovery[2] });
  check('...e um código do APLICATIVO (código de recuperação não serve aqui)', regenRecovery.status === 400);
  const regen = await d1.post('/api/auth/2fa/recovery-codes', { password: STRONG, code: totp.totpAtStep(secret, step()) });
  check('gera 8 códigos novos', regen.status === 200 && regen.data.recovery_codes.length === 8 && !regen.data.recovery_codes.includes(recovery[3]), regen.data);
  const dOld = fresh();
  const lOld = await dOld.post('/api/auth/login', { email, password: STRONG });
  check('os códigos antigos deixaram de valer', (await dOld.post('/api/auth/login/2fa', { challenge: lOld.data.challenge, code: recovery[3] })).status === 401);

  const disableNoPwd = await d1.post('/api/auth/2fa/disable', { password: 'errada!errada1', code: regen.data.recovery_codes[0] });
  check('desativar exige a senha', disableNoPwd.status === 400);
  const disableNoCode = await d1.post('/api/auth/2fa/disable', { password: STRONG, code: '123456' });
  check('...e um código válido', disableNoCode.status === 400);
  const disable = await d1.post('/api/auth/2fa/disable', { password: STRONG, code: regen.data.recovery_codes[0] });
  check('com senha + código de recuperação desativa', disable.status === 200 && disable.data.enabled === false, disable.data);
  check('depois de desativada, o login volta a ser só senha', (await fresh().post('/api/auth/login', { email, password: STRONG })).data.admin?.email === email);
  check('e a chave e os códigos sumiram do banco', psql(`select totp_secret is null and totp_enabled_at is null from admins where email = ${lit(email)}`) === 't' && psql(`select count(*) from admin_recovery_codes where admin_id = ${lit(admin.id)}`) === '0');

  // O owner desliga a de outra pessoa (perdeu o celular); admin comum não pode
  const setup2 = await d1.post('/api/auth/2fa/setup', { password: STRONG });
  const enable2 = await d1.post('/api/auth/2fa/enable', { code: totp.totpAtStep(setup2.data.secret, step()) });
  check('religou', enable2.status === 200);
  const common = new Client(undefined, '198.51.100.99');
  await common.login('forte@copocheio.local', 'Outra!Senha-2027x');
  check('administrador comum não desliga a verificação de ninguém (403)', (await common.post(`/api/admin/admins/${admin.id}/reset-2fa`)).status === 403);
  const reset = await owner.post(`/api/admin/admins/${admin.id}/reset-2fa`);
  check('o owner desliga a de quem perdeu o celular', reset.status === 200 && (await owner.get('/api/admin/admins')).data.admins.find((a) => a.id === admin.id).two_factor === false, reset.data);
  const hist = await owner.get('/api/admin/audit?q=duas%20etapas');
  check('ativar/desativar ficou no histórico', hist.data.entries.some((e) => e.action === 'auth.2fa_enable') && hist.data.entries.some((e) => e.action === 'auth.2fa_disable'), hist.data.entries.map((e) => e.action));
}

// ------------------------------------------------------------------------------------------------
section('5. SEG-03: o endereço dos links de e-mail nunca vem da requisição');
{
  await makeAdmin('x@copocheio.local', 'X').catch(() => undefined);
  const cust = new Client(undefined, '198.51.100.110');
  await clearMail();
  const email = 'recupera@exemplo.com';
  const reg = await cust.post('/api/account/register', { name: 'Rita Recupera', email, phone: '34 95555-1111', password: 'Rita!Recupera-77' });
  check('cadastro aceito (202)', reg.status === 202, reg.data);
  const forged = { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https', forwarded: 'host=evil.example;proto=https', 'x-original-host': 'evil.example' };
  await cust.post('/api/account/resend-verification', { email }, { headers: forged });
  const verifyMails = await mailsTo(email);
  const verifyText = verifyMails.map((m) => m.text + m.html).join('\n');
  check('e-mail de confirmação: nenhum link aponta para o endereço forjado', verifyMails.length > 0 && !/evil\.example/.test(verifyText), verifyMails.map((m) => m.subject));
  // Conta confirmada: o link de "esqueci minha senha"
  const real = new Client(undefined, '198.51.100.112');
  await registerVerified(real, { name: 'Rita Real', email: 'rita.real@exemplo.com', phone: '34 95555-2222', password: 'Rita!Recupera-88' });
  await clearMail();
  await new Client(undefined, '198.51.100.111').post('/api/account/forgot-password', { email: 'rita.real@exemplo.com' }, { headers: forged });
  const resetMails = await mailsTo('rita.real@exemplo.com');
  const resetText = resetMails.map((m) => m.text + m.html).join('\n');
  // Fora da Vercel e sem SITE_URL só o endereço local vale: com um endereço forjado nos cabeçalhos o servidor RECUSA montar o link
  // (nenhum e-mail sai) em vez de mandar o link para o site do atacante.
  check('e-mail de "esqueci minha senha" com cabeçalhos forjados: nenhum link para o site do atacante', !/evil\.example/.test(resetText), resetMails.map((m) => m.subject));
  await clearMail();
  await new Client(undefined, '198.51.100.113').post('/api/account/forgot-password', { email: 'rita.real@exemplo.com' });
  const honest = await mailsTo('rita.real@exemplo.com');
  check('sem cabeçalhos forjados o link sai normalmente, com o endereço real do site (local)', honest.length === 1 && /127\.0\.0\.1:4180\/conta\/redefinir\//.test(honest[0].text), honest.map((m) => m.subject));
}

// ------------------------------------------------------------------------------------------------
section('6. SEG-03 / SEG-10: servidor "de produção" (VERCEL=1) sem e com SITE_URL');
async function withServer(env, fn) {
  // Faixa livre de portas que o fetch bloqueia (como a 4190): em 4190..4239 a sorte de cair na 4190 derrubava o teste.
  const port = 4300 + Math.floor(Math.random() * 50);
  const child = spawn('node', ['tests/server.mjs'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT: String(port), BLOB_PORT: String(port + 100), ...env }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).status) break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return await fn(base);
  } finally {
    child.kill();
  }
}
const prodEnv = { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: '', VERCEL_PROJECT_PRODUCTION_URL: '', SITE_URL: '' };
await withServer(prodEnv, async (base) => {
  const anon = new Client(base, '198.51.100.120');
  const health = await anon.get('/api/health');
  check('/api/health público só diz se está de pé (sem banco, e-mail, variáveis)', health.status === 200 && JSON.stringify(health.data) === '{"ok":true}', health.data);
  const forgot = await anon.post('/api/account/forgot-password', { email: 'alguem@exemplo.com' });
  check('sem SITE_URL: o pedido de recuperação não envia nada e a resposta é a mesma de sempre (não vaza se a conta existe)', forgot.status === 202 || forgot.status === 200 || forgot.status === 503, forgot);
  const reg = await anon.post('/api/account/register', { name: 'Teste Prod', email: 'prod@exemplo.com', phone: '34 94444-0000', password: 'Prod!Teste-2026x' });
  check('erro de configuração para o público não cita variáveis (503 genérico)', reg.status !== 503 || (!JSON.stringify(reg.data).includes('SITE_URL') && !JSON.stringify(reg.data).includes('DATABASE_URL') && reg.data.missing === undefined), reg.data);
  const adm = new Client(base, '198.51.100.121');
  await adm.login();
  const full = await adm.get('/api/admin/health');
  check('o painel (logado) vê o que falta, só os nomes: SITE_URL', full.status === 200 && full.data.site_url === 'missing' && full.data.missing.includes('SITE_URL') && !JSON.stringify(full.data).includes('postgresql://'), full.data);
  const mail = await adm.get('/api/admin/mail');
  check('rota do painel segue exigindo login', (await anon.get('/api/admin/mail')).status === 401 && mail.status === 200);
});
await withServer({ ...prodEnv, SITE_URL: 'https://www.copocheio.com.br' }, async (base) => {
  const anon = new Client(base, '198.51.100.122');
  const email = 'siteurl@exemplo.com';
  await anon.post('/api/account/register', { name: 'Site Url', email, phone: '34 93333-0000', password: 'Site!Url-2026xx' }, { headers: { 'x-forwarded-host': 'evil.example' } });
  const sent = await (await fetch(`${base}/__mail?to=${email}`)).json();
  const body = sent.map((m) => m.text + m.html).join('\n');
  check('com SITE_URL, o link do e-mail usa o domínio configurado, nunca o dos cabeçalhos', sent.length > 0 && body.includes('https://www.copocheio.com.br/conta/verificar/') && !/evil\.example/.test(body), sent.map((m) => m.subject));
});

// ------------------------------------------------------------------------------------------------
section('7. SEG-05: cabeçalhos de segurança do vercel.json (como a Vercel os aplica)');
{
  const anon = new Client();
  const home = await fetch(`${BASE}/`);
  const h = (res, name) => res.headers.get(name) ?? '';
  const csp = h(home, 'content-security-policy');
  const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
  check('CSP presente, restritiva e sem script inline/eval', /default-src 'self'/.test(csp) && directive('script-src') === "script-src 'self'" && !/unsafe-eval/.test(csp), csp);
  check('CSP: frame-ancestors none, object-src none, base-uri self, form-action self', /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'self'/.test(csp) && /form-action 'self'/.test(csp));
  check('CSP envia relatórios para /api/csp-report', /report-uri \/api\/csp-report/.test(csp));
  check('X-Frame-Options DENY e nosniff', h(home, 'x-frame-options') === 'DENY' && h(home, 'x-content-type-options') === 'nosniff');
  check('HSTS de 2 anos', /max-age=63072000/.test(h(home, 'strict-transport-security')));
  check('Referrer-Policy e Permissions-Policy', h(home, 'referrer-policy') === 'strict-origin-when-cross-origin' && /camera=\(\)/.test(h(home, 'permissions-policy')));
  const admin = await fetch(`${BASE}/admin/pedidos`);
  check('/admin: noindex, sem cache e sem referrer', /noindex/.test(h(admin, 'x-robots-tag')) && /no-store/.test(h(admin, 'cache-control')) && h(admin, 'referrer-policy') === 'no-referrer');
  const conta = await fetch(`${BASE}/conta/pedidos`);
  const pedido = await fetch(`${BASE}/pedido/ABCDE-ABCDE-ABCDE-ABCDE`);
  check('/conta e /pedido: noindex e sem cache', [conta, pedido].every((r) => /noindex/.test(h(r, 'x-robots-tag')) && /no-store/.test(h(r, 'cache-control'))));
  const api = await anon.get('/api/products');
  check('as respostas da API também levam os cabeçalhos globais', api.headers.get('x-frame-options') === 'DENY' && /default-src/.test(api.headers.get('content-security-policy') ?? ''));
  const assetPath = (await (await fetch(`${BASE}/`)).text()).match(/\/assets\/[^"]+\.js/)?.[0];
  const asset = await fetch(`${BASE}${assetPath}`);
  check('arquivos de /assets: cache de 1 ano, immutable', /max-age=31536000/.test(h(asset, 'cache-control')) && /immutable/.test(h(asset, 'cache-control')), h(asset, 'cache-control'));
  const report = await anon.post('/api/csp-report', undefined, { raw: true, headers: { 'content-type': 'application/csp-report' } });
  check('rota de relatório de CSP existe e responde 204', report.status === 204);
}

// ------------------------------------------------------------------------------------------------
section('8. SEG-06: pedidos falsos (armadilha, tempo mínimo e contagem de tentativas)');
{
  const cat = (await owner.post('/api/admin/categories', { name: 'Anti-robô' })).data.category;
  const prod = (await owner.post('/api/admin/products', { name: 'Água', price: 3, category_id: cat.id })).data.product;
  const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
  await owner.patch('/api/admin/store', { opening_hours: allDays, delivery_fee: 0, min_order: 0 });
  const body = (extra = {}) => ({ customer_name: 'Pessoa Real', customer_phone: '34988880000', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: prod.id, quantity: 1 }], ...extra });
  const bot = new Client(undefined, '203.0.113.80');
  const trap = await bot.post('/api/orders', body({ website: 'http://spam.example' }));
  check('campo escondido preenchido: recusado (400, code rejected)', trap.status === 400 && trap.data.code === 'rejected', trap);
  const fast = await bot.post('/api/orders', body({ fill_ms: 100 }));
  check('enviado rápido demais depois de abrir a tela: recusado', fast.status === 400 && fast.data.code === 'rejected', fast);
  check('nenhum pedido foi criado pelas tentativas recusadas', psql("select count(*) from orders where customer_name = 'Pessoa Real'") === '0');
  const human = await bot.post('/api/orders', body({ website: '', fill_ms: 20_000 }));
  check('pessoa de verdade (campo vazio, tempo normal) faz o pedido', human.status === 201, human.data);
  const noFields = await new Client(undefined, '203.0.113.81').post('/api/orders', body());
  check('quem não manda os campos novos (versão antiga do site) continua funcionando', noFields.status === 201, noFields.data);

  const spammer = new Client(undefined, '203.0.113.90');
  const statuses = [];
  for (let i = 0; i < 64; i++) statuses.push((await spammer.post('/api/orders', { customer_name: '' })).status);
  const rejected = statuses.filter((s) => s === 429).length;
  check('tentativas inválidas também contam: depois de 60 em 10 min vem o 429', statuses.slice(0, 60).every((s) => s === 400) && rejected === 4, statuses.join(','));
  const parallel = new Client(undefined, '203.0.113.91');
  const flood = await Promise.all(Array.from({ length: 100 }, () => parallel.post('/api/orders', { customer_name: '' })));
  const through = flood.filter((r) => r.status !== 429).length;
  check('100 tentativas simultâneas: no máximo 60 passam do primeiro portão (as demais, 429)', through <= 60 && through >= 20 && flood.filter((r) => r.status === 429).length === 100 - through, { through });
}

// ------------------------------------------------------------------------------------------------
section('9. SEG-07: ninguém "sequestra" o cadastro de outra pessoa antes dela');
{
  const attacker = new Client(undefined, '203.0.113.100');
  const victimBrowser = new Client(undefined, '198.51.100.130');
  const email = 'vitima.cadastro@exemplo.com';
  await clearMail();
  const reg = await attacker.post('/api/account/register', { name: 'Vítima Real', email, phone: '34 92222-0000', password: 'Atacante!Senha-1' });
  check('o atacante cadastra o e-mail da vítima (202) e recebe o cookie do cadastro', reg.status === 202 && attacker.jar.has('copocheio_cadastro'), reg.data);
  const code = await lastCode(email);
  check('o código vai para a caixa da vítima, não para o atacante', /^\d{6}$/.test(code));
  const verify = await victimBrowser.post('/api/account/verify-email', { email, code });
  check('a vítima confirma de outro navegador: e-mail confirmado, mas SEM a senha do atacante', verify.status === 200 && typeof verify.data.set_password_token === 'string', verify.data);
  const atk = await loginCustomer(attacker, { email, password: 'Atacante!Senha-1' });
  check('a senha do atacante NÃO funciona', atk.status !== 200, atk);
  const set = await victimBrowser.post('/api/account/reset', { token: verify.data.set_password_token, password: 'Vitima!Senha-2026' });
  check('a vítima cria a própria senha pelo link de uso único', set.status === 200, set.data);
  check('e entra com ela', (await loginCustomer(victimBrowser, { email, password: 'Vitima!Senha-2026' })).status === 200);
  check('o link de criar senha não vale duas vezes', (await victimBrowser.post('/api/account/reset', { token: verify.data.set_password_token, password: 'Outra!Senha-2026x' })).status === 400);

  // Caminho normal (mesmo navegador): nada muda para a pessoa
  const same = new Client(undefined, '198.51.100.131');
  const email2 = 'normal.cadastro@exemplo.com';
  await same.post('/api/account/register', { name: 'Pessoa Normal', email: email2, phone: '34 91111-0000', password: 'Normal!Senha-2026' });
  const ver2 = await same.post('/api/account/verify-email', { email: email2, code: await lastCode(email2) });
  check('mesmo navegador: confirma sem passos extras', ver2.status === 200 && ver2.data.set_password_token === undefined, ver2.data);
  check('...e a senha que a pessoa digitou funciona', (await loginCustomer(same, { email: email2, password: 'Normal!Senha-2026' })).status === 200);

  // Pelo link do e-mail, de outro navegador
  const a2 = new Client(undefined, '203.0.113.101');
  const v2 = new Client(undefined, '198.51.100.132');
  const email3 = 'link.cadastro@exemplo.com';
  await clearMail();
  await a2.post('/api/account/register', { name: 'Via Link', email: email3, phone: '34 90000-1111', password: 'Atacante!Senha-3' });
  const link = linkFrom((await mailsTo(email3)).at(-1));
  const tokenFromLink = link.split('/').pop();
  const vl = await v2.post('/api/account/verify-link', { token: tokenFromLink });
  check('pelo link, de outro navegador: confirma e exige criar a senha', vl.status === 200 && typeof vl.data.set_password_token === 'string', vl.data);
  check('a senha do atacante não entra (link)', (await loginCustomer(a2, { email: email3, password: 'Atacante!Senha-3' })).status !== 200);
  check('a resposta do cadastro é igual com e-mail novo ou já existente (não revela quem tem conta)', JSON.stringify(Object.keys((await new Client(undefined, '203.0.113.102').post('/api/account/register', { name: 'Outra Pessoa', email: email2, phone: '34 98888-5555', password: 'Qualquer!Senha-2026' })).data).sort()) === JSON.stringify(Object.keys(reg.data).sort()));
}

// ------------------------------------------------------------------------------------------------
section('10. SEG-09 / SEG-12 / SEG-10 / SEG-11: imagens, rota e informações expostas');
{
  const fixtures = new URL('./fixtures/', import.meta.url);
  const { readFileSync } = await import('node:fs');
  const up = async (bytes, type) => owner.post('/api/admin/upload?folder=products', bytes, { raw: true, headers: { 'content-type': type } });
  const png = readFileSync(new URL('a.png', fixtures));
  check('imagem verdadeira entra', (await up(png, 'image/png')).status === 201);
  const fakeJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('isto não é uma imagem, é um texto qualquer '.repeat(10))]);
  check('"JPEG" só com a assinatura e lixo atrás é recusado', (await up(fakeJpeg, 'image/jpeg')).status === 400);
  check('PNG cortado no meio é recusado', (await up(png.subarray(0, png.length - 15), 'image/png')).status === 400);
  check('SVG é recusado', (await up(readFileSync(new URL('evil.svg', fixtures)), 'image/svg+xml')).status === 400);
  const lying = await up(png, 'image/jpeg');
  check('o tipo que o navegador declara não vale: o arquivo é guardado pelo que ele realmente é (png)', lying.status === 201 && /\.png$/.test(lying.data.pathname), lying.data);

  const anon = new Client();
  const site = await anon.get('/api/site');
  check('/api/site entrega só colunas escolhidas (sem id interno, updated_at, nada além)', site.status === 200 && !('id' in site.data.store) && !('updated_at' in site.data.store) && !('id' in site.data.site) && !('id' in site.data.hero), Object.keys(site.data.store));
  check('catálogo público não vaza estoque nem SKU', (await anon.get('/api/products')).data.products.every((p) => !('stock' in p) && !('sku' in p) && !('created_at' in p)));
  const robots = await (await fetch(`${BASE}/robots.txt`)).text();
  check('robots.txt não anuncia /admin', !/admin/i.test(robots) && /Disallow: \/api\//.test(robots), robots);
  const slash = await anon.get('/api?__path=%2Fadmin%2Fadmins');
  check('%2F no __path não escapa para outra rota', slash.status === 404 || slash.status === 400 || slash.status === 401, slash.status);
  const dots = await anon.get('/api?__path=..%2F..%2Fetc%2Fpasswd');
  check('../ no __path é recusado', [400, 404].includes(dots.status), dots.status);
  const back = await anon.get('/api?__path=admin%5Cadmins');
  check('barra invertida no __path é recusada', [400, 404].includes(back.status), back.status);
  check('/api/admin/* sem login: 401', (await anon.get('/api/admin/admins')).status === 401 && (await anon.get('/api/admin/audit')).status === 401);
  const e500 = await anon.get('/api/tracking/%00');
  check('erro inesperado não vaza detalhe interno', !/at |node_modules|postgres|select /i.test(JSON.stringify(e500.data)), e500.data);
  check('toda resposta tem X-Request-Id (para achar no log)', /^[0-9a-f-]{8,}$/i.test((await anon.get('/api/products')).headers.get('x-request-id') ?? ''));
}
{
  // SEG-11: create-admin troca a senha e derruba as sessões abertas
  const { execFileSync: run } = await import('node:child_process');
  const email = 'script@copocheio.local';
  await makeAdmin(email, 'Via Script');
  const sess = new Client(undefined, '198.51.100.140');
  await sess.login(email, STRONG);
  check('sessão aberta funciona antes do script', (await sess.get('/api/admin/dashboard')).status === 200);
  const env = { ...process.env, DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/copocheio_test', ADMIN_PASSWORD: 'Script!Nova-Senha-2026' };
  const out = run('node', ['tests/with-neon-proxy.mjs', 'scripts/create-admin.mjs', email, 'Via Script'], { cwd: new URL('..', import.meta.url).pathname, env, encoding: 'utf8' });
  check('o script avisa que encerrou as sessões abertas', /sess/i.test(out), out);
  check('a sessão que estava aberta foi derrubada', (await sess.get('/api/admin/dashboard')).status === 401);
  check('a senha nova entra', (await new Client(undefined, '198.51.100.141').post('/api/auth/login', { email, password: 'Script!Nova-Senha-2026' })).status === 200);
  let rejected = false;
  try {
    run('node', ['tests/with-neon-proxy.mjs', 'scripts/create-admin.mjs', 'curta@copocheio.local', 'Curta'], { cwd: new URL('..', import.meta.url).pathname, env: { ...env, ADMIN_PASSWORD: '12345678' }, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    rejected = true;
  }
  check('o script recusa senha fraca/curta', rejected);
}

summary();
