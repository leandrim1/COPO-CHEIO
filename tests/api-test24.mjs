// Login do PAINEL com código por e-mail, a CADA entrada (migration 0024): a senha certa sozinha não abre sessão; o servidor manda um código de 6 dígitos
// para o e-mail da própria conta administrativa e só abre a sessão quando o código volta certo, do MESMO navegador (cookie do desafio). Cobre também a
// sessão (cookie, expiração, logout, rotação), o isolamento entre cliente e administrador e o funcionamento junto do aplicativo autenticador (TOTP).
// usage: bash tests/fresh.sh && node tests/api-test24.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client, check, clearMail, codeFrom, loginAdmin, loginCustomer, mailMode, mailsTo, registerVerified, section, summary } from './lib.mjs';
import { load } from './unit/load.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql) => execFileSync('psql', [...P, '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rows = (sql) => JSON.parse(psql(`select coalesce(json_agg(x), '[]') from (${sql}) x`));
const totp = await load('server/totp.ts');

const STRONG = 'Caixa#Segura-2026';
const NEW_PASS = 'Outra#Senha-2027x';
const owner = new Client(undefined, '198.51.100.1');
await owner.login();

let seq = 0;
const base = new Map();
const rawMails = async (email) => (await mailsTo(email)).filter((m) => /código de acesso ao painel/.test(m.subject));
// Cada administrador nasce limpo: o login do dono que o criou não conta aqui, e o desafio do login de preparação (se houve) sai.
async function makeAdmin(tag, role = 'admin') {
  const email = `${tag}.${++seq}@copocheio.local`;
  const r = await owner.post('/api/admin/admins', { email, name: `Admin ${tag}`, password: STRONG, role });
  if (r.status !== 201) throw new Error(`criar administrador falhou: ${r.status} ${JSON.stringify(r.data)}`);
  const id = psql(`select id from admins where lower(email) = ${lit(email)}`);
  base.set(email, (await rawMails(email)).length);
  return { email, id };
}
const challenge = (id) => rows(`select * from admin_email_challenges where admin_id = ${lit(id)} order by created_at`);
const adminMails = async (email) => (await rawMails(email)).slice(base.get(email) ?? 0);
const lastCodeOf = async (email) => codeFrom((await adminMails(email)).at(-1));
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const cookieNames = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split('=')[0]);
const cookieLine = (res, name) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';
const secrets = []; // tudo o que NÃO pode aparecer em log: códigos e senhas usados aqui

await clearMail();

// ------------------------------------------------------------------------------------------------
section('1. A senha certa NÃO abre sessão: o servidor manda o código e espera ele voltar');
const A = await makeAdmin('ana');
{
  const browser = new Client(undefined, '198.51.100.11');
  const first = await browser.post('/api/auth/login', { email: A.email, password: STRONG });
  check('senha certa: 202 "code_required", sem dados do administrador', first.status === 202 && first.data.status === 'code_required' && !('admin' in first.data), first.data);
  check('a resposta traz o e-mail mascarado (nunca inteiro), a espera do reenvio (60 s) e a validade do código (5 min)', String(first.data.email_masked).includes('*') && !String(first.data.email_masked).includes('ana.1@') && first.data.resend_in === 60 && first.data.code_minutes === 5 && first.data.expires_in === 300, first.data);
  check('a resposta NÃO carrega o código em lugar nenhum (corpo, cabeçalhos)', !JSON.stringify(first.data).match(/\b\d{6}\b/) && ![...first.headers.entries()].some(([k, v]) => /\b\d{6}\b/.test(v) && !/date|etag|x-request-id/.test(k)), first.data);
  const names = cookieNames(first);
  check('NENHUM cookie de sessão foi entregue; só o cookie do desafio de login', names.includes('copocheio_admin_login') && !names.includes('copocheio_admin'), names);
  const line = cookieLine(first, 'copocheio_admin_login');
  check('o cookie do desafio é HttpOnly, SameSite=Strict e dura 15 min', /HttpOnly/.test(line) && /SameSite=Strict/.test(line) && /Max-Age=900/.test(line), line);
  check('sem sessão: /api/auth/me é nulo e as rotas administrativas respondem 401', (await browser.get('/api/auth/me')).data.admin === null && (await browser.get('/api/admin/dashboard')).status === 401 && (await browser.get('/api/admin/orders')).status === 401);

  const mails = await adminMails(A.email);
  check('chegou UM e-mail "código de acesso ao painel", para o e-mail da conta', mails.length === 1 && /^\d{6} é o seu código de acesso ao painel/.test(mails[0].subject), mails.map((m) => m.subject));
  const code = codeFrom(mails[0]);
  secrets.push(code);
  check('o e-mail traz o código, a validade (5 minutos), o aparelho e o aviso "Não foi você?" (sem link de acesso)', /^\d{6}$/.test(code) && /5 minutos/.test(mails[0].text) && /Não foi você/.test(mails[0].text) && /\(.* no .*\)|navegador/i.test(mails[0].text) && !/\/admin\/(login|dashboard)\/[A-Za-z0-9_-]{8,}/.test(mails[0].html), mails[0].text.slice(0, 400));
  check('é e-mail automático de conta (Auto-Submitted) e sem descadastro de promoção', mails[0].headers['auto-submitted'] === 'auto-generated' && !mails[0].headers['list-unsubscribe'], mails[0].headers);

  const [row] = challenge(A.id);
  check('banco: um desafio, só com hashes (o código e o cookie não estão em nenhuma coluna), 0 erros, código de 5 min e desafio de 15 min', challenge(A.id).length === 1 && /^[0-9a-f]{64}$/.test(row.code_hash) && /^[0-9a-f]{64}$/.test(row.nonce_hash) && row.attempts === 0 && row.used_at === null && !JSON.stringify(row).includes(code)
    && Math.abs((Date.parse(row.code_expires_at) - Date.parse(row.created_at)) / 60000 - 5) < 0.5 && Math.abs((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60000 - 15) < 0.5, row);
  const dump = execFileSync('pg_dump', [...P, '-d', 'copocheio_test', '--data-only', '-t', 'admin_email_challenges'], { encoding: 'utf8' });
  check('pg_dump da tabela: o código não aparece', !dump.includes(code));
  const ledger = rows(`select kind, subject, category, audience, status from email_messages where kind = 'admin_login_code' and recipient_email = ${lit(A.email)}`);
  check('o registro de e-mails guarda só o nome do tipo (nunca o assunto com o código), aceito, transacional e para a equipe', ledger.length === 1 && ledger[0].subject === 'Código de acesso ao painel' && !/\d{6}/.test(ledger[0].subject) && ledger[0].status === 'accepted' && ledger[0].audience === 'staff', ledger);

  const ok = await browser.post('/api/auth/login/code', { code });
  check('o código certo, do mesmo navegador: 200 com os dados do administrador', ok.status === 200 && ok.data.admin?.email === A.email && ok.data.admin.role === 'admin', ok.data);
  const names2 = cookieNames(ok);
  check('agora SIM entrega o cookie da sessão e apaga o cookie do desafio', names2.includes('copocheio_admin') && /Max-Age=0/.test(cookieLine(ok, 'copocheio_admin_login')), names2);
  const sc = cookieLine(ok, 'copocheio_admin');
  check('o cookie da sessão é HttpOnly, SameSite=Strict e dura 14 dias (Secure só em https)', /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Max-Age=1209600/.test(sc) && !/Secure/.test(sc), sc);
  check('o painel responde para a sessão nova e /api/auth/me devolve o administrador', (await browser.get('/api/admin/dashboard')).status === 200 && (await browser.get('/api/auth/me')).data.admin?.email === A.email);
  check('o desafio fica marcado como usado e last_login_at foi gravado', challenge(A.id)[0].used_at !== null && psql(`select last_login_at is not null from admins where id = ${lit(A.id)}`) === 't');
  const again = await new Client(undefined, '198.51.100.12').post('/api/auth/login/code', { code });
  check('o mesmo código não serve de novo (uso único), nem de outro navegador', again.status === 400, again.data);
  const audit = (await owner.get('/api/admin/audit?entity=admin&limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('o histórico de atividades registra a entrada "com código por e-mail"', /Entrou no painel .* com código por e-mail/.test(audit), audit);
}

// ------------------------------------------------------------------------------------------------
section('2. Quem erra a senha, não existe, está desativado ou é cliente nunca chega ao código');
{
  const B = await makeAdmin('beto');
  const before = (await rawMails(B.email)).length;
  const bad = await new Client().post('/api/auth/login', { email: B.email, password: 'senha-errada-123' });
  const ghost = await new Client().post('/api/auth/login', { email: 'ninguem.mesmo@copocheio.local', password: 'senha-errada-123' });
  check('senha errada e e-mail inexistente: o MESMO 401, sem cookie de desafio', bad.status === 401 && ghost.status === 401 && bad.data.error === ghost.data.error && !cookieNames(bad).includes('copocheio_admin_login'), [bad.data, ghost.data]);
  check('nenhum e-mail foi enviado e nenhum desafio foi aberto', (await rawMails(B.email)).length === before && challenge(B.id).length === 0);
  const off = await makeAdmin('carol');
  await owner.patch(`/api/admin/admins/${off.id}`, { active: false });
  const inactive = await new Client().post('/api/auth/login', { email: off.email, password: STRONG });
  check('administrador DESATIVADO com a senha certa: o mesmo 401 genérico, sem e-mail e sem desafio', inactive.status === 401 && inactive.data.error === bad.data.error && (await adminMails(off.email)).length === 0 && challenge(off.id).length === 0, inactive.data);
  // Cliente comum (conta de cliente) usando o login do painel
  const cust = new Client();
  await registerVerified(cust, { name: 'Cliente Comum', email: 'cliente.comum@exemplo.com', phone: '34991230000', password: STRONG });
  const asCustomer = await new Client().post('/api/auth/login', { email: 'cliente.comum@exemplo.com', password: STRONG });
  check('credenciais de CLIENTE no login do painel: o mesmo 401 genérico (um cliente não vira administrador)', asCustomer.status === 401 && asCustomer.data.error === bad.data.error && !cookieNames(asCustomer).some((n) => n.startsWith('copocheio_admin')), asCustomer.data);
  const burst = await Promise.all(Array.from({ length: 6 }, () => new Client().post('/api/auth/login', { email: B.email, password: 'errada-errada-1' })));
  check('6 tentativas erradas em rajada: nenhum e-mail sai', burst.every((r) => [401, 429].includes(r.status)) && (await rawMails(B.email)).length === before);
  check('campos vazios ou enormes: 400', (await new Client().post('/api/auth/login', { email: '', password: '' })).status === 400 && (await new Client().post('/api/auth/login', { email: 'a@b.com', password: 'x'.repeat(300) })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('3. O código só vale no navegador que digitou a senha (quem só leu o e-mail não entra)');
{
  const C = await makeAdmin('caio');
  const victim = new Client(undefined, '198.51.100.21');
  await victim.post('/api/auth/login', { email: C.email, password: STRONG });
  const code = await lastCodeOf(C.email);
  secrets.push(code);
  const thief = new Client(undefined, '198.51.100.22');
  const noCookie = await thief.post('/api/auth/login/code', { code });
  check('outro navegador (sem o cookie do desafio) com o código CERTO: 400 login_expired, sem sessão', noCookie.status === 400 && noCookie.data.code === 'login_expired' && !cookieNames(noCookie).includes('copocheio_admin'), noCookie.data);
  const forged = new Client(undefined, '198.51.100.23');
  forged.cookie = 'copocheio_admin_login=' + 'A'.repeat(32);
  const f = await forged.post('/api/auth/login/code', { code });
  check('com um cookie inventado: 400 e sem sessão', f.status === 400 && (await forged.get('/api/auth/me')).data.admin === null, f.data);
  const other = await makeAdmin('dani');
  const swap = new Client(undefined, '198.51.100.24');
  await swap.post('/api/auth/login', { email: other.email, password: STRONG });
  const wrongBrowser = await swap.post('/api/auth/login/code', { code });
  check('o código de uma conta no desafio de OUTRA conta não vale', wrongBrowser.status === 400 && (await swap.get('/api/auth/me')).data.admin === null, wrongBrowser.data);
  check('o dono ainda consegue entrar com o código depois dessas tentativas dos outros', (await victim.post('/api/auth/login/code', { code })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('4. Código errado: 5 erros e o desafio inteiro deixa de valer (é preciso informar a senha de novo)');
{
  const D = await makeAdmin('edu');
  const b = new Client(undefined, '198.51.100.31');
  await b.post('/api/auth/login', { email: D.email, password: STRONG });
  const saved = b.cookie;
  const code = await lastCodeOf(D.email);
  secrets.push(code);
  const wrong = wrongOf(code);
  for (const bad of ['abc123', '12345', '', '1234567', '12 34 5']) {
    const r = await b.post('/api/auth/login/code', { code: bad });
    check(`formato inválido (${JSON.stringify(bad)}): 400 invalid_code_format e não conta como erro`, r.status === 400 && r.data.code === 'invalid_code_format', r.data);
  }
  check('...nenhum erro foi contado', challenge(D.id)[0].attempts === 0);
  const e1 = await b.post('/api/auth/login/code', { code: `${wrong.slice(0, 3)} ${wrong.slice(3)}` });
  check('código errado: 400 invalid_code, mensagem em português e sem sessão', e1.status === 400 && e1.data.code === 'invalid_code' && /incorreto ou expirado/.test(e1.data.error) && (await b.get('/api/auth/me')).data.admin === null, e1.data);
  for (let i = 0; i < 3; i++) await b.post('/api/auth/login/code', { code: wrong });
  check('4 erros: o desafio ainda está aberto', challenge(D.id)[0].attempts === 4 && challenge(D.id)[0].invalidated_at === null);
  const e5 = await b.post('/api/auth/login/code', { code: wrong });
  check('o 5º erro bloqueia o desafio (400 code_locked) e apaga o cookie', e5.status === 400 && e5.data.code === 'code_locked' && /Max-Age=0/.test(cookieLine(e5, 'copocheio_admin_login')), e5.data);
  check('depois de bloqueado, nem o código CERTO entra', (await b.post('/api/auth/login/code', { code })).status === 400 && (await b.get('/api/auth/me')).data.admin === null);
  const c2 = new Client(undefined, '198.51.100.32');
  c2.cookie = saved;
  check('...nem guardando o cookie de antes (o desafio foi invalidado no banco)', (await c2.post('/api/auth/login/code', { code })).status === 400 && challenge(D.id)[0].invalidated_at !== null);
  const r = await loginAdmin(new Client(undefined, '198.51.100.33'), { email: D.email, password: STRONG });
  check('informar a senha de novo abre um desafio novo, e o código novo entra', r.status === 200 && r.data.admin?.email === D.email, r.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Validade: o código vale 5 minutos e o desafio 15; vencido, não entra');
{
  const E = await makeAdmin('fabi');
  const b = new Client(undefined, '198.51.100.41');
  await b.post('/api/auth/login', { email: E.email, password: STRONG });
  const code = await lastCodeOf(E.email);
  secrets.push(code);
  psql(`update admin_email_challenges set code_expires_at = now() - interval '1 second' where admin_id = ${lit(E.id)}`);
  const late = await b.post('/api/auth/login/code', { code });
  check('código vencido (mesmo certo): 400 e sem sessão', late.status === 400 && (await b.get('/api/auth/me')).data.admin === null, late.data);
  psql(`update admin_email_challenges set code_expires_at = now() + interval '3 minutes', expires_at = now() - interval '1 second' where admin_id = ${lit(E.id)}`);
  check('desafio vencido (mesmo com o código dentro do prazo): 400', (await b.post('/api/auth/login/code', { code })).status === 400);
  const rs = await b.post('/api/auth/login/resend', {});
  check('reenviar num desafio vencido: 400 login_expired', rs.status === 400 && rs.data.code === 'login_expired', rs.data);
}

// ------------------------------------------------------------------------------------------------
section('6. Reenviar o código: espera de 60 s, o código novo substitui o antigo, no máximo 4 por tentativa');
{
  const F = await makeAdmin('gabi');
  const b = new Client(undefined, '198.51.100.51');
  await b.post('/api/auth/login', { email: F.email, password: STRONG });
  const first = await lastCodeOf(F.email);
  secrets.push(first);
  const tooSoon = await b.post('/api/auth/login/resend', {});
  check('reenviar logo em seguida: 429 cooldown, com a espera', tooSoon.status === 429 && tooSoon.data.code === 'cooldown' && tooSoon.data.retry_after > 0 && tooSoon.data.retry_after <= 60 && Number(tooSoon.headers.get('retry-after')) > 0, tooSoon.data);
  check('...e nenhum e-mail novo saiu', (await adminMails(F.email)).length === 1);
  const age = (id) => psql(`update admin_email_challenges set last_sent_at = last_sent_at - interval '2 minutes' where admin_id = ${lit(id)}`);
  age(F.id);
  const rs = await b.post('/api/auth/login/resend', {});
  check('depois de 60 s: 200, e chega o e-mail novo (validade 5 min)', rs.status === 200 && rs.data.ok === true && rs.data.resend_in === 60 && rs.data.code_minutes === 5 && rs.data.expires_in === 300 && (await adminMails(F.email)).length === 2, rs.data);
  const second = await lastCodeOf(F.email);
  secrets.push(second);
  check('o código novo é outro', second !== first, [first, second]);
  const oldTry = await b.post('/api/auth/login/code', { code: first });
  check('o código ANTIGO deixa de valer depois do reenvio', oldTry.status === 400, oldTry.data);
  check('o código novo entra', (await b.post('/api/auth/login/code', { code: second })).status === 200);

  const G = await makeAdmin('hugo');
  const g = new Client(undefined, '198.51.100.52');
  await g.post('/api/auth/login', { email: G.email, password: STRONG });
  for (let i = 0; i < 3; i++) {
    age(G.id);
    const r = await g.post('/api/auth/login/resend', {});
    if (r.status !== 200) check(`reenvio ${i + 2} de 4 deveria passar`, false, r.data);
  }
  check('cada tentativa de login manda no máximo 4 e-mails (1 + 3 reenvios)', (await adminMails(G.email)).length === 4 && challenge(G.id)[0].sends === 4);
  age(G.id);
  const fifth = await g.post('/api/auth/login/resend', {});
  check('o 5º envio da mesma tentativa: 429 resend_limit (informe a senha de novo)', fifth.status === 429 && fifth.data.code === 'resend_limit' && (await adminMails(G.email)).length === 4, fifth.data);
  check('reenviar sem cookie de desafio: 400 login_expired', (await new Client().post('/api/auth/login/resend', {})).data.code === 'login_expired');
}

// ------------------------------------------------------------------------------------------------
section('7. Entrar de novo logo em seguida (mesmo navegador) não manda outro e-mail; outro navegador manda');
{
  const H = await makeAdmin('iara');
  const b = new Client(undefined, '198.51.100.61');
  const r1 = await b.post('/api/auth/login', { email: H.email, password: STRONG });
  const r2 = await b.post('/api/auth/login', { email: H.email, password: STRONG });
  check('duplo clique em "Entrar": os dois dão 202 e só UM e-mail sai', r1.status === 202 && r2.status === 202 && (await adminMails(H.email)).length === 1, [r1.status, r2.status]);
  check('...o segundo não troca o cookie e diz quanto falta para reenviar e para o código expirar', !cookieNames(r2).includes('copocheio_admin_login') && r2.data.resend_in > 0 && r2.data.resend_in <= 60 && r2.data.expires_in > 200 && r2.data.expires_in <= 300, r2.data);
  const code = await lastCodeOf(H.email);
  secrets.push(code);
  check('...e o código do primeiro e-mail entra', (await b.post('/api/auth/login/code', { code })).status === 200);
  const other = new Client(undefined, '198.51.100.62');
  const r3 = await other.post('/api/auth/login', { email: H.email, password: STRONG });
  check('outro navegador: novo desafio e novo e-mail (o código do outro não serve nele)', r3.status === 202 && cookieNames(r3).includes('copocheio_admin_login') && (await adminMails(H.email)).length === 2);
  const code2 = await lastCodeOf(H.email);
  secrets.push(code2);
  check('o desafio de um navegador não vale no outro', (await new Client(undefined, '198.51.100.63').post('/api/auth/login/code', { code: code2 })).status === 400);
  check('...e o código novo entra no navegador que pediu', (await other.post('/api/auth/login/code', { code: code2 })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('8. Limites: 8 pedidos de código sem entrar por hora; quem entra de verdade não é limitado; e-mail fora do ar não abre sessão');
{
  const J = await makeAdmin('kika');
  const results = [];
  let last;
  for (let i = 0; i < 9; i++) {
    last = await new Client(undefined, `198.51.100.${70 + i}`).post('/api/auth/login', { email: J.email, password: STRONG });
    results.push(last.status);
  }
  check('8 pedidos de código sem entrar passam (202) e o 9º é barrado (429), sem e-mail novo', results.slice(0, 8).every((s) => s === 202) && results[8] === 429 && last.data.code === 'rate_limited' && (await adminMails(J.email)).length === 8, results);
  check('o 9º também não abre desafio nem cookie', !cookieNames(last).includes('copocheio_admin_login') && challenge(J.id).length === 8);

  const K = await makeAdmin('lais');
  let okLogins = 0;
  for (let i = 0; i < 11; i++) if ((await loginAdmin(new Client(undefined, `198.51.100.${90 + i}`), { email: K.email, password: STRONG })).status === 200) okLogins++;
  check('11 entradas de verdade seguidas (cada uma com o seu código) passam: o teto de 8 por hora só conta quem NÃO entra', okLogins === 11, okLogins);

  const M = await makeAdmin('mara');
  await mailMode('data');
  const down = new Client(undefined, '198.51.100.110');
  const bad = await down.post('/api/auth/login', { email: M.email, password: STRONG });
  check('servidor de e-mail recusando a mensagem: erro (nunca 200/202), sem sessão e sem cookie de desafio', bad.status >= 400 && !cookieNames(bad).some((n) => ['copocheio_admin', 'copocheio_admin_login'].includes(n)) && (await down.get('/api/auth/me')).data.admin === null && (await down.get('/api/admin/dashboard')).status === 401, bad.data);
  check('o desafio que não pôde ser enviado é descartado (nada fica aberto)', challenge(M.id).length === 0);
  await mailMode(null);
  const okAgain = await loginAdmin(new Client(undefined, '198.51.100.111'), { email: M.email, password: STRONG });
  check('quando o e-mail volta, o login funciona normalmente (e a nova tentativa pode ser feita na hora)', okAgain.status === 200, okAgain.data);
  // Um servidor de e-mail "fora do ar" de verdade (nem conecta)
  const N = await makeAdmin('nina');
  await mailMode('down');
  const downBad = await new Client(undefined, '198.51.100.112').post('/api/auth/login', { email: N.email, password: STRONG });
  check('servidor de e-mail fora do ar (421): 503 "tente de novo", sem sessão', downBad.status === 503 && !cookieNames(downBad).includes('copocheio_admin') && /Tente de novo/.test(downBad.data.error), downBad.data);
  await mailMode(null);
}

// ------------------------------------------------------------------------------------------------
section('9. Trocar a senha, desativar ou excluir o administrador derruba o desafio aberto');
{
  const L = await makeAdmin('olga');
  const sess = new Client(undefined, '198.51.100.120');
  await loginAdmin(sess, { email: L.email, password: STRONG });
  const attempt = new Client(undefined, '198.51.100.121');
  await attempt.post('/api/auth/login', { email: L.email, password: STRONG });
  const code = await lastCodeOf(L.email);
  secrets.push(code);
  const changed = await sess.patch('/api/auth/password', { current: STRONG, next: NEW_PASS });
  check('(preparação) o administrador troca a senha por outra sessão', changed.status === 200, changed.data);
  const late = await attempt.post('/api/auth/login/code', { code });
  check('o código pedido ANTES da troca de senha deixa de valer (mesmo certo)', late.status === 400 && (await attempt.get('/api/auth/me')).data.admin === null, late.data);
  check('com a senha nova e um código novo, entra; a antiga nem chega a pedir código', (await loginAdmin(new Client(undefined, '198.51.100.122'), { email: L.email, password: NEW_PASS })).status === 200 && (await new Client(undefined, '198.51.100.123').post('/api/auth/login', { email: L.email, password: STRONG })).status === 401);

  const O = await makeAdmin('paulo');
  const o = new Client(undefined, '198.51.100.124');
  await o.post('/api/auth/login', { email: O.email, password: STRONG });
  const ocode = await lastCodeOf(O.email);
  await owner.patch(`/api/admin/admins/${O.id}`, { active: false });
  check('administrador desativado depois de pedir o código: o código não vale', (await o.post('/api/auth/login/code', { code: ocode })).status === 400 && (await o.get('/api/auth/me')).data.admin === null);

  const Q = await makeAdmin('quel');
  await loginAdmin(new Client(undefined, '198.51.100.125'), { email: Q.email, password: STRONG });
  await new Client(undefined, '198.51.100.126').post('/api/auth/login', { email: Q.email, password: STRONG });
  check('(preparação) a conta tem desafios gravados', challenge(Q.id).length >= 2);
  const del = await owner.del(`/api/admin/admins/${Q.id}`);
  check('excluir o administrador apaga também os desafios de login (cascata)', del.status === 200 && Number(psql(`select count(*) from admin_email_challenges where admin_id = ${lit(Q.id)}`)) === 0, del.data);
}

// ------------------------------------------------------------------------------------------------
section('10. Sessão: rotação, expiração, logout efetivo e isolamento entre cliente e administrador');
{
  const R = await makeAdmin('rita');
  const b = new Client(undefined, '198.51.100.130');
  await loginAdmin(b, { email: R.email, password: STRONG });
  const oldToken = b.jar.get('copocheio_admin');
  check('(preparação) a sessão abriu e o painel responde', Boolean(oldToken) && (await b.get('/api/admin/dashboard')).status === 200);
  check('no banco só o HASH da sessão fica guardado (o token em si não)', psql(`select count(*) from admin_sessions where token_hash = ${lit(oldToken)}`) === '0' && Number(psql(`select count(*) from admin_sessions where admin_id = ${lit(R.id)}`)) === 1);
  // Entrar de novo com a sessão antiga ainda no navegador: o identificador muda e o antigo morre
  await loginAdmin(b, { email: R.email, password: STRONG });
  const newToken = b.jar.get('copocheio_admin');
  const stale = new Client(undefined, '198.51.100.131');
  stale.cookie = `copocheio_admin=${oldToken}`;
  check('o login com sessão já aberta RENOVA o identificador: o antigo deixa de valer e o novo vale', newToken && newToken !== oldToken && (await stale.get('/api/admin/dashboard')).status === 401 && (await b.get('/api/admin/dashboard')).status === 200, [oldToken, newToken]);
  check('continua uma única sessão dessa conta neste navegador', Number(psql(`select count(*) from admin_sessions where admin_id = ${lit(R.id)}`)) === 1);

  // Expiração
  psql(`update admin_sessions set expires_at = now() - interval '1 second' where admin_id = ${lit(R.id)}`);
  check('sessão expirada: 401 em toda rota administrativa e /api/auth/me nulo', (await b.get('/api/admin/dashboard')).status === 401 && (await b.get('/api/admin/products')).status === 401 && (await b.get('/api/auth/me')).data.admin === null);

  // Logout efetivo
  const lo = new Client(undefined, '198.51.100.132');
  await loginAdmin(lo, { email: R.email, password: STRONG });
  const tokenBefore = lo.jar.get('copocheio_admin');
  const out = await lo.post('/api/auth/logout');
  check('logout: 200, apaga o cookie e a sessão sai do banco', out.status === 200 && /Max-Age=0/.test(cookieLine(out, 'copocheio_admin')) && Number(psql(`select count(*) from admin_sessions where admin_id = ${lit(R.id)} and expires_at > now()`)) === 0);
  const replay = new Client(undefined, '198.51.100.133');
  replay.cookie = `copocheio_admin=${tokenBefore}`;
  check('o cookie roubado ANTES do logout não vale depois dele (401)', (await replay.get('/api/admin/dashboard')).status === 401 && (await replay.get('/api/auth/me')).data.admin === null);

  // Sessão de cliente nunca é aceita como administrativa
  const cust = new Client(undefined, '198.51.100.134');
  await registerVerified(cust, { name: 'Cliente Sessao', email: 'cliente.sessao@exemplo.com', phone: '34991239999', password: STRONG });
  check('(preparação) o cliente está logado na conta dele', (await cust.get('/api/account/me')).data.customer?.email === 'cliente.sessao@exemplo.com');
  const custToken = cust.jar.get('copocheio_cliente');
  const adminRoutes = ['/api/admin/dashboard', '/api/admin/orders', '/api/admin/products', '/api/admin/customers', '/api/admin/admins', '/api/admin/audit', '/api/admin/categories', '/api/auth/2fa'];
  const asCustomer = await Promise.all(adminRoutes.map((p) => cust.get(p)));
  check('com a sessão de CLIENTE, toda rota administrativa responde 401', asCustomer.every((r) => r.status === 401), asCustomer.map((r) => r.status));
  const sneaky = new Client(undefined, '198.51.100.135');
  sneaky.cookie = `copocheio_admin=${custToken}`;
  check('...nem o token do cliente colocado no cookie do painel (são mundos diferentes)', (await sneaky.get('/api/admin/dashboard')).status === 401 && (await sneaky.get('/api/auth/me')).data.admin === null);
  check('e o administrador logado não é aceito como cliente', (await owner.get('/api/account/me')).data.customer === null && (await owner.get('/api/account/orders')).status === 401);
}

// ------------------------------------------------------------------------------------------------
section('11. Permissões: administrador comum não vira owner, e não existe rota pública para criar administradores');
{
  const S = await makeAdmin('sara', 'admin');
  const s = new Client(undefined, '198.51.100.140');
  await loginAdmin(s, { email: S.email, password: STRONG });
  const attempts = [
    ['POST', '/api/admin/admins', { email: 'novo.admin@copocheio.local', name: 'Novo', password: STRONG, role: 'owner' }],
    ['PATCH', `/api/admin/admins/${S.id}`, { role: 'owner' }],
    ['PATCH', `/api/admin/admins/${S.id}`, { active: true, role: 'owner' }],
    ['DELETE', `/api/admin/admins/${S.id}`, undefined],
    ['POST', `/api/admin/admins/${S.id}/reset-2fa`, {}],
    ['GET', '/api/admin/admins', undefined],
  ];
  const results = [];
  for (const [method, path, body] of attempts) results.push((await s.req(method, path, body)).status);
  check('o administrador COMUM tenta se promover, criar owner, excluir ou listar a equipe: tudo 403', results.every((r) => r === 403), results);
  check('...e continua "admin" no banco', psql(`select role from admins where id = ${lit(S.id)}`) === 'admin');
  const anon = new Client(undefined, '198.51.100.141');
  const open = [
    ['POST', '/api/admin/admins', { email: 'invasor@copocheio.local', name: 'Invasor', password: STRONG, role: 'owner' }],
    ['POST', '/api/auth/register', { email: 'invasor@copocheio.local', name: 'Invasor', password: STRONG }],
    ['POST', '/api/admin/register', { email: 'invasor@copocheio.local', password: STRONG }],
    ['POST', '/api/admins', { email: 'invasor@copocheio.local', password: STRONG }],
    ['POST', '/api/auth/signup', { email: 'invasor@copocheio.local', password: STRONG }],
  ];
  const openResults = [];
  for (const [method, path, body] of open) openResults.push((await anon.req(method, path, body)).status);
  check('sem login, nenhuma rota cria administrador (401/404/405, nunca 2xx)', openResults.every((r) => [401, 404, 405].includes(r)), openResults);
  check('...e nenhum administrador "invasor" existe', psql(`select count(*) from admins where email like 'invasor%'`) === '0');
  check('conta de cliente não ganha acesso ao criar o próprio cadastro com o e-mail de um administrador (a loja não mistura as duas tabelas)', (await new Client().post('/api/account/register', { name: 'Fake', email: S.email, phone: '34990001111', password: STRONG })).status !== 500);
}

// ------------------------------------------------------------------------------------------------
section('12. Junto do aplicativo autenticador (TOTP): o código do e-mail NÃO o substitui (ele vira a terceira etapa)');
{
  const T = await makeAdmin('tiago');
  const c = new Client(undefined, '198.51.100.150');
  await loginAdmin(c, { email: T.email, password: STRONG });
  const setup = await c.post('/api/auth/2fa/setup', { password: STRONG });
  const secret = setup.data.secret;
  const step = () => totp.stepAt(Date.now());
  const enable = await c.post('/api/auth/2fa/enable', { code: totp.totpAtStep(secret, step()) });
  check('(preparação) o aplicativo foi ligado nesta conta', enable.status === 200);

  const d = new Client(undefined, '198.51.100.151');
  const first = await d.post('/api/auth/login', { email: T.email, password: STRONG });
  check('com o aplicativo ligado, a senha certa ainda pede PRIMEIRO o código do e-mail (e não já o do aplicativo)', first.status === 202 && first.data.status === 'code_required' && !first.data.challenge, first.data);
  const early = await d.post('/api/auth/login/2fa', { challenge: 'x'.repeat(43), code: totp.totpAtStep(secret, step()) });
  check('não dá para pular o e-mail indo direto ao código do aplicativo (nenhum desafio dele existe)', early.status === 401 && early.data.code === 'challenge_expired' && (await d.get('/api/auth/me')).data.admin === null, early.data);
  const second = await d.post('/api/auth/login/code', { code: await lastCodeOf(T.email) });
  check('o código do e-mail certo NÃO abre a sessão: devolve o desafio do aplicativo', second.status === 200 && second.data.two_factor === true && typeof second.data.challenge === 'string' && !second.data.admin && !cookieNames(second).includes('copocheio_admin'), second.data);
  check('...e a rota administrativa continua fechada', (await d.get('/api/admin/dashboard')).status === 401);
  const third = await d.post('/api/auth/login/2fa', { challenge: second.data.challenge, code: totp.totpAtStep(secret, step() + 1) });
  check('com o código do aplicativo (3ª etapa) a sessão abre', third.status === 200 && third.data.admin?.email === T.email && (await d.get('/api/admin/dashboard')).status === 200, third.data);
  const audit = (await owner.get('/api/admin/audit?entity=admin&limit=40')).data.entries.map((e) => e.summary).join(' | ');
  check('o histórico diz que usou a verificação em duas etapas E o código por e-mail', /com verificação em duas etapas e código por e-mail/.test(audit), audit);
}

// ------------------------------------------------------------------------------------------------
section('13. Proteções gerais: CSRF, limite por rede, nada sensível em log');
{
  const U = await makeAdmin('uma');
  check('origem estranha (CSRF) é recusada nas rotas novas (403)', (await new Client().post('/api/auth/login/code', { code: '123456' }, { headers: { origin: 'https://evil.example' } })).status === 403 && (await new Client().post('/api/auth/login/resend', {}, { headers: { origin: 'https://evil.example' } })).status === 403);
  const ip = '203.0.113.150';
  const spam = [];
  for (let i = 0; i < 34; i++) {
    const c = new Client(undefined, ip);
    c.cookie = 'copocheio_admin_login=' + 'B'.repeat(30);
    spam.push((await c.post('/api/auth/login/code', { code: '000000' })).status);
  }
  check('muitos códigos errados da mesma rede: passa a responder 429 (limite por rede)', spam.slice(0, 30).every((s) => s === 400) && spam.slice(30).every((s) => s === 429), spam);
  void U;
  // Nada de senha, código ou cookie no log do servidor
  const log = readFileSync(new URL('./server.log', import.meta.url), 'utf8');
  const leaked = [...new Set([...secrets, STRONG, NEW_PASS, 'senha-forte-123'])].filter((v) => log.includes(v));
  check('o log do servidor não tem nenhuma senha nem código usados nestes testes', leaked.length === 0, leaked.map((v) => v.replace(/./g, '*')));
  check('...nem o cookie do desafio nem o da sessão', !/copocheio_admin(_login)?=[A-Za-z0-9_-]{20,}/.test(log));
}

summary();
