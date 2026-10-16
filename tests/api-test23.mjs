// Login do cliente com código por e-mail, a CADA entrada (migration 0023): a senha certa sozinha não abre sessão; o servidor manda um código de
// 6 dígitos para o e-mail da conta e só abre a sessão quando o código volta certo, do MESMO navegador (cookie do desafio).
// usage: bash tests/fresh.sh && node tests/api-test23.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, clearMail, codeFrom, loginCustomer, mailMode, mailsTo, registerVerified, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql) => execFileSync('psql', [...P, '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const PASS = 'Senha-Forte-2026!';
const NEW_PASS = 'Outra-Senha-2027!';
let seq = 0;
// Cada conta nasce limpa: o cadastro de teste já fez UM login com código (o do registerVerified); aqui esse desafio e esse e-mail saem da conta.
const base = new Map();
const rawLoginMails = async (email) => (await mailsTo(email)).filter((m) => /código para entrar/.test(m.subject));
const newAccount = async (tag) => {
  const email = `${tag}.${++seq}@exemplo.com`;
  const c = new Client();
  await registerVerified(c, { name: `Cliente ${tag}`, email, phone: `3499${String(1000000 + seq).slice(-7)}`, password: PASS });
  await c.post('/api/account/logout');
  const id = psql(`select id from customers where lower(email) = ${lit(email)}`);
  psql(`delete from customer_login_challenges where customer_id = ${lit(id)}`);
  base.set(email, (await rawLoginMails(email)).length);
  return { email, id };
};
const rows = (sql) => JSON.parse(psql(`select coalesce(json_agg(x), '[]') from (${sql}) x`));
const challenge = (id) => rows(`select * from customer_login_challenges where customer_id = ${lit(id)} order by created_at`);
const loginMails = async (email) => (await rawLoginMails(email)).slice(base.get(email) ?? 0);
const lastLoginCode = async (email) => {
  const list = await loginMails(email);
  return codeFrom(list[list.length - 1]);
};
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');
const cookieNames = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split('=')[0]);
const cookieLine = (res, name) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';

await clearMail();

// ------------------------------------------------------------------------------------------------
section('1. A senha certa NÃO abre sessão: o servidor manda o código e espera ele voltar');
const A = await newAccount('ana');
{
  const browser = new Client();
  const first = await browser.post('/api/account/login', { email: A.email, password: PASS });
  check('senha certa: 202 "code_required", sem dados do cliente', first.status === 202 && first.data.status === 'code_required' && !('customer' in first.data), first.data);
  check('a resposta traz o e-mail mascarado (nunca inteiro), a espera do reenvio (60 s) e a validade do código (10 min)', String(first.data.email_masked).includes('*') && !String(first.data.email_masked).includes('ana.1@') && first.data.resend_in === 60 && first.data.code_minutes === 10, first.data);
  const names = cookieNames(first);
  check('NENHUM cookie de sessão foi entregue; só o cookie do desafio de login', names.includes('copocheio_login') && !names.includes('copocheio_cliente'), names);
  const line = cookieLine(first, 'copocheio_login');
  check('o cookie do desafio é HttpOnly, SameSite=Lax e dura 30 min', /HttpOnly/.test(line) && /SameSite=Lax/.test(line) && /Max-Age=1800/.test(line), line);
  check('sem sessão: /api/account/me é nulo e as rotas da conta respondem 401', (await browser.get('/api/account/me')).data.customer === null && (await browser.get('/api/account/orders')).status === 401);

  const mails = await loginMails(A.email);
  check('chegou UM e-mail "código para entrar", para o e-mail da conta', mails.length === 1 && /^\d{6} é o seu código para entrar/.test(mails[0].subject), mails.map((m) => m.subject));
  const code = codeFrom(mails[0]);
  check('o e-mail traz o código de 6 dígitos, a validade e o aviso "Não foi você?" (sem link de confirmação nem de senha)', /^\d{6}$/.test(code) && /10 minutos/.test(mails[0].text) && /Não foi você/.test(mails[0].text) && !/\/conta\/(verificar|redefinir)\//.test(mails[0].html), mails[0].text.slice(0, 300));
  check('é e-mail automático de conta (Auto-Submitted) e sem descadastro de promoção', mails[0].headers['auto-submitted'] === 'auto-generated' && !mails[0].headers['list-unsubscribe'], mails[0].headers);

  const row = challenge(A.id);
  check('banco: um desafio, só com hashes (o código e o cookie não estão em nenhuma coluna), 0 erros e prazo de 30 min', row.length === 1 && /^[0-9a-f]{64}$/.test(row[0].code_hash) && /^[0-9a-f]{64}$/.test(row[0].nonce_hash) && row[0].attempts === 0 && row[0].used_at === null && !JSON.stringify(row[0]).includes(code), row[0]);
  const dump = execFileSync('pg_dump', [...P, '-d', 'copocheio_test', '--data-only', '-t', 'customer_login_challenges'], { encoding: 'utf8' });
  check('pg_dump da tabela: o código não aparece', !dump.includes(code));
  const ledger = rows(`select kind, subject, category, audience, status from email_messages where kind = 'login_code' and recipient_email = ${lit(A.email)}`);
  check('o registro de e-mails guarda só o nome do tipo (nunca o assunto com o código), aceito de primeira, transacional e para cliente (o cadastro de teste fez o 1º login)', ledger.length === 2 && ledger.every((x) => x.subject === 'Código para entrar na conta' && !/\d{6}/.test(x.subject) && x.status === 'accepted' && x.category === 'transactional' && x.audience === 'customer'), ledger);
  check('...e nenhuma coluna do registro guarda o código desta mensagem', !JSON.stringify(rows(`select * from email_messages where kind = 'login_code' and recipient_email = ${lit(A.email)}`)).includes(code));

  // O código abre a sessão
  const ok = await browser.post('/api/account/login/code', { code });
  check('o código certo, do mesmo navegador: 200 com os dados do cliente', ok.status === 200 && ok.data.customer?.email === A.email, ok.data);
  const names2 = cookieNames(ok);
  check('agora SIM entrega o cookie de sessão e apaga o cookie do desafio', names2.includes('copocheio_cliente') && /Max-Age=0/.test(cookieLine(ok, 'copocheio_login')), names2);
  check('/api/account/me devolve o cliente e last_login_at foi gravado', (await browser.get('/api/account/me')).data.customer?.email === A.email && psql(`select last_login_at is not null from customers where id = ${lit(A.id)}`) === 't');
  check('o desafio fica marcado como usado', challenge(A.id)[0].used_at !== null);
  const again = await new Client().post('/api/account/login/code', { code });
  check('o mesmo código não serve de novo (uso único), nem de outro navegador', again.status === 400, again.data);
  check('...nem pelo navegador que já usou (o cookie foi apagado): pede para começar de novo', (await browser.post('/api/account/login/code', { code })).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('2. Quem erra a senha nunca chega ao código (ninguém enche a caixa de e-mail de outra pessoa)');
{
  const B = await newAccount('bia');
  const before = (await mailsTo(B.email)).length;
  const bad = await new Client().post('/api/account/login', { email: B.email, password: 'senha-errada-123' });
  const ghost = await new Client().post('/api/account/login', { email: 'ninguem.mesmo@exemplo.com', password: 'senha-errada-123' });
  check('senha errada e e-mail inexistente: o MESMO 401, sem cookie de desafio', bad.status === 401 && ghost.status === 401 && bad.data.error === ghost.data.error && !cookieNames(bad).includes('copocheio_login'), [bad.data, ghost.data]);
  check('nenhum e-mail foi enviado e nenhum desafio foi aberto', (await mailsTo(B.email)).length === before && challenge(B.id).length === 0);
  const burst = await Promise.all(Array.from({ length: 6 }, () => new Client().post('/api/account/login', { email: B.email, password: 'errada-errada-1' })));
  check('6 tentativas erradas em rajada: nenhum e-mail sai e nenhum desafio abre', burst.every((r) => r.status === 401 || r.status === 429) && (await mailsTo(B.email)).length === before && challenge(B.id).length === 0);
  // Conta pendente (e-mail não confirmado): continua no fluxo de confirmação, sem código de login.
  const pend = new Client();
  const email = 'pendente.23@exemplo.com';
  await pend.post('/api/account/register', { name: 'Pendente', email, phone: '34990001111', password: PASS });
  const r = await new Client().post('/api/account/login', { email, password: PASS });
  check('conta com e-mail ainda não confirmado: 403 email_not_verified (e não um código de login)', r.status === 403 && r.data.code === 'email_not_verified' && (await loginMails(email)).length === 0, r.data);
}

// ------------------------------------------------------------------------------------------------
section('3. O código só vale no navegador que digitou a senha (quem só leu o e-mail não entra)');
{
  const C = await newAccount('caio');
  const victim = new Client();
  await victim.post('/api/account/login', { email: C.email, password: PASS });
  const code = await lastLoginCode(C.email);
  const thief = new Client();
  const noCookie = await thief.post('/api/account/login/code', { code });
  check('outro navegador (sem o cookie do desafio) com o código CERTO: 400 login_expired, sem sessão', noCookie.status === 400 && noCookie.data.code === 'login_expired' && !cookieNames(noCookie).includes('copocheio_cliente'), noCookie.data);
  const forged = new Client();
  forged.cookie = 'copocheio_login=' + 'A'.repeat(32);
  const f = await forged.post('/api/account/login/code', { code });
  check('com um cookie inventado: 400 e sem sessão', f.status === 400 && (await forged.get('/api/account/me')).data.customer === null, f.data);
  const swap = new Client();
  await swap.post('/api/account/login', { email: (await newAccount('dani')).email, password: PASS });
  const wrongBrowser = await swap.post('/api/account/login/code', { code });
  check('o código de uma conta no desafio de OUTRA conta não vale', wrongBrowser.status === 400 && (await swap.get('/api/account/me')).data.customer === null, wrongBrowser.data);
  check('o dono ainda consegue entrar com o código depois dessas tentativas dos outros', (await victim.post('/api/account/login/code', { code })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('4. Código errado: 5 erros e o desafio inteiro deixa de valer (é preciso informar a senha de novo)');
{
  const D = await newAccount('edu');
  const b = new Client();
  await b.post('/api/account/login', { email: D.email, password: PASS });
  const saved = b.cookie;
  const code = await lastLoginCode(D.email);
  const wrong = wrongOf(code);
  for (const bad of ['abc123', '12345', '', '1234567', '12 34 5']) {
    const r = await b.post('/api/account/login/code', { code: bad });
    check(`formato inválido (${JSON.stringify(bad)}): 400 invalid_code_format e não conta como erro`, r.status === 400 && r.data.code === 'invalid_code_format', r.data);
  }
  check('...nenhum erro foi contado', challenge(D.id)[0].attempts === 0);
  const spaced = `${wrong.slice(0, 3)} ${wrong.slice(3)}`;
  const e1 = await b.post('/api/account/login/code', { code: spaced });
  check('código errado (com espaço no meio, que é aceito): 400 invalid_code, mensagem em português e sem sessão', e1.status === 400 && e1.data.code === 'invalid_code' && /incorreto ou expirado/.test(e1.data.error) && (await b.get('/api/account/me')).data.customer === null, e1.data);
  for (let i = 0; i < 3; i++) await b.post('/api/account/login/code', { code: wrong });
  check('4 erros: o desafio ainda está aberto', challenge(D.id)[0].attempts === 4 && challenge(D.id)[0].invalidated_at === null);
  const e5 = await b.post('/api/account/login/code', { code: wrong });
  check('o 5º erro bloqueia o desafio (400 code_locked) e apaga o cookie', e5.status === 400 && e5.data.code === 'code_locked' && /Max-Age=0/.test(cookieLine(e5, 'copocheio_login')), e5.data);
  check('depois de bloqueado, nem o código CERTO entra', (await b.post('/api/account/login/code', { code })).status === 400 && (await b.get('/api/account/me')).data.customer === null);
  const c2 = new Client();
  c2.cookie = saved;
  check('...nem guardando o cookie de antes (o desafio foi invalidado no banco)', (await c2.post('/api/account/login/code', { code })).status === 400 && challenge(D.id)[0].invalidated_at !== null);
  // Recomeçar pela senha dá um desafio novo, que funciona
  const fresh = new Client();
  const r = await loginCustomer(fresh, { email: D.email, password: PASS });
  check('informar a senha de novo abre um desafio novo, e o código novo entra', r.status === 200 && r.data.customer?.email === D.email, r.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Validade: o código vale 10 minutos e o desafio 30');
{
  const E = await newAccount('fabi');
  const b = new Client();
  await b.post('/api/account/login', { email: E.email, password: PASS });
  const code = await lastLoginCode(E.email);
  const [row] = challenge(E.id);
  check('banco: código vale 10 min e o desafio 30 min', Math.abs((Date.parse(row.code_expires_at) - Date.parse(row.created_at)) / 60000 - 10) < 0.5 && Math.abs((Date.parse(row.expires_at) - Date.parse(row.created_at)) / 60000 - 30) < 0.5, row);
  psql(`update customer_login_challenges set code_expires_at = now() - interval '1 second' where customer_id = ${lit(E.id)}`);
  const late = await b.post('/api/account/login/code', { code });
  check('código vencido (mesmo certo): 400 e sem sessão', late.status === 400 && (await b.get('/api/account/me')).data.customer === null, late.data);
  psql(`update customer_login_challenges set code_expires_at = now() + interval '5 minutes', expires_at = now() - interval '1 second' where customer_id = ${lit(E.id)}`);
  check('desafio vencido (mesmo com o código dentro do prazo): 400', (await b.post('/api/account/login/code', { code })).status === 400);
  const rs = await b.post('/api/account/login/resend', {});
  check('reenviar num desafio vencido: 400 login_expired', rs.status === 400 && rs.data.code === 'login_expired', rs.data);
}

// ------------------------------------------------------------------------------------------------
section('6. Reenviar o código: espera de 60 s, o código novo substitui o antigo, no máximo 5 por tentativa');
{
  const F = await newAccount('gabi');
  const b = new Client();
  await b.post('/api/account/login', { email: F.email, password: PASS });
  const first = await lastLoginCode(F.email);
  const tooSoon = await b.post('/api/account/login/resend', {});
  check('reenviar logo em seguida: 429 cooldown, com a espera', tooSoon.status === 429 && tooSoon.data.code === 'cooldown' && tooSoon.data.retry_after > 0 && tooSoon.data.retry_after <= 60 && Number(tooSoon.headers.get('retry-after')) > 0, tooSoon.data);
  check('...e nenhum e-mail novo saiu', (await loginMails(F.email)).length === 1);
  const age = () => psql(`update customer_login_challenges set last_sent_at = last_sent_at - interval '2 minutes' where customer_id = ${lit(F.id)}`);
  age();
  const rs = await b.post('/api/account/login/resend', {});
  check('depois de 60 s: 200, e chega o e-mail novo', rs.status === 200 && rs.data.ok === true && rs.data.resend_in === 60 && rs.data.code_minutes === 10 && (await loginMails(F.email)).length === 2, rs.data);
  const second = await lastLoginCode(F.email);
  check('o código novo é outro', second !== first, [first, second]);
  // o antigo deixa de valer, o novo vale
  const oldTry = await b.post('/api/account/login/code', { code: first });
  check('o código ANTIGO deixa de valer depois do reenvio', oldTry.status === 400, oldTry.data);
  check('o reenvio zera os erros do código anterior', challenge(F.id)[0].attempts <= 1);
  const ok = await b.post('/api/account/login/code', { code: second });
  check('o código novo entra', ok.status === 200 && ok.data.customer?.email === F.email, ok.data);

  // Teto de 5 envios por tentativa
  const G = await newAccount('hugo');
  const g = new Client();
  await g.post('/api/account/login', { email: G.email, password: PASS });
  for (let i = 0; i < 4; i++) {
    psql(`update customer_login_challenges set last_sent_at = last_sent_at - interval '2 minutes' where customer_id = ${lit(G.id)}`);
    const r = await g.post('/api/account/login/resend', {});
    if (r.status !== 200) check(`reenvio ${i + 2} de 5 deveria passar`, false, r.data);
  }
  check('cada tentativa de login manda no máximo 5 e-mails (1 + 4 reenvios)', (await loginMails(G.email)).length === 5 && challenge(G.id)[0].sends === 5);
  psql(`update customer_login_challenges set last_sent_at = last_sent_at - interval '2 minutes' where customer_id = ${lit(G.id)}`);
  const sixth = await g.post('/api/account/login/resend', {});
  check('o 6º envio da mesma tentativa: 429 resend_limit (informe a senha de novo)', sixth.status === 429 && sixth.data.code === 'resend_limit' && (await loginMails(G.email)).length === 5, sixth.data);
  check('reenviar sem cookie de desafio: 400 login_expired', (await new Client().post('/api/account/login/resend', {})).data.code === 'login_expired');

  // Se a função caiu entre o envio e a confirmação (last_sent_at nunca gravado), o código daquela tentativa não vale, mas o reenvio é liberado depois de 20 s.
  const R = await newAccount('rita');
  const r = new Client();
  await r.post('/api/account/login', { email: R.email, password: PASS });
  const orphan = await lastLoginCode(R.email);
  psql(`update customer_login_challenges set last_sent_at = null where customer_id = ${lit(R.id)}`);
  check('tentativa "sem envio confirmado": o código dela não vale (nem o certo)', (await r.post('/api/account/login/code', { code: orphan })).status === 400);
  const early = await r.post('/api/account/login/resend', {});
  check('...e logo em seguida o reenvio espera um instante (429)', early.status === 429 && early.data.code === 'cooldown', early.data);
  psql(`update customer_login_challenges set created_at = created_at - interval '1 minute' where customer_id = ${lit(R.id)}`);
  const released = await r.post('/api/account/login/resend', {});
  check('depois de 20 s o reenvio é liberado e o código novo entra', released.status === 200 && (await r.post('/api/account/login/code', { code: await lastLoginCode(R.email) })).status === 200, released.data);
}

// ------------------------------------------------------------------------------------------------
section('7. Entrar de novo logo em seguida (mesmo navegador) não manda outro e-mail; outro navegador manda');
{
  const H = await newAccount('iara');
  const b = new Client();
  const r1 = await b.post('/api/account/login', { email: H.email, password: PASS });
  const r2 = await b.post('/api/account/login', { email: H.email, password: PASS });
  check('duplo clique em "Entrar": os dois dão 202 e só UM e-mail sai', r1.status === 202 && r2.status === 202 && (await loginMails(H.email)).length === 1, [r1.status, r2.status]);
  check('...o segundo não troca o cookie (o código já enviado continua valendo) e diz quanto falta para reenviar', !cookieNames(r2).includes('copocheio_login') && r2.data.resend_in > 0 && r2.data.resend_in <= 60, r2.data);
  const code = await lastLoginCode(H.email);
  check('...e o código do primeiro e-mail entra', (await b.post('/api/account/login/code', { code })).status === 200);
  const other = new Client();
  const r3 = await other.post('/api/account/login', { email: H.email, password: PASS });
  check('outro navegador: novo desafio e novo e-mail (o código do outro não serve nele)', r3.status === 202 && cookieNames(r3).includes('copocheio_login') && (await loginMails(H.email)).length === 2);
  const code2 = await lastLoginCode(H.email);
  check('o desafio de um navegador não vale no outro', (await new Client().post('/api/account/login/code', { code: code2 })).status === 400);
  check('...e o código novo entra no navegador que pediu', (await other.post('/api/account/login/code', { code: code2 })).status === 200);
}

// ------------------------------------------------------------------------------------------------
section('8. A CADA entrada pede o código: sair e entrar de novo exige um código novo');
{
  const I = await newAccount('joao');
  const b = new Client();
  const l1 = await loginCustomer(b, { email: I.email, password: PASS });
  check('1ª entrada com o código: 200', l1.status === 200);
  await b.post('/api/account/logout');
  check('depois de sair, a sessão não vale mais', (await b.get('/api/account/me')).data.customer === null);
  const l2 = await b.post('/api/account/login', { email: I.email, password: PASS });
  check('entrar de novo com a senha: 202 pedindo outro código (a senha sozinha nunca basta)', l2.status === 202 && l2.data.status === 'code_required' && (await b.get('/api/account/me')).data.customer === null);
  const codes = (await loginMails(I.email)).map(codeFrom);
  check('dois e-mails de código no total (um por entrada)', codes.length >= 2);
  const l2b = await b.post('/api/account/login/code', { code: codes[codes.length - 1] });
  check('...e o código novo entra', l2b.status === 200);
  // sessão antiga (de outro aparelho) não é afetada por novas entradas
  const keep = new Client();
  await loginCustomer(keep, { email: I.email, password: PASS });
  check('uma segunda sessão (outro aparelho) convive com a primeira', (await keep.get('/api/account/me')).data.customer?.email === I.email && (await b.get('/api/account/me')).data.customer?.email === I.email);
}

// ------------------------------------------------------------------------------------------------
section('9. Limites: 10 e-mails de código por hora por conta; o servidor de e-mail fora do ar não abre sessão');
{
  const J = await newAccount('kika');
  let last;
  const results = [];
  for (let i = 0; i < 11; i++) {
    last = await new Client().post('/api/account/login', { email: J.email, password: PASS });
    results.push(last.status);
  }
  check('10 pedidos de código em 1 hora passam (202) e o 11º é barrado (429), sem e-mail novo', results.slice(0, 10).every((s) => s === 202) && results[10] === 429 && last.data.code === 'rate_limited' && (await loginMails(J.email)).length === 10, results);
  check('o 11º também não abre desafio nem cookie', !cookieNames(last).includes('copocheio_login') && challenge(J.id).length === 10);

  const K = await newAccount('lais');
  await mailMode('data');
  const down = new Client();
  const bad = await down.post('/api/account/login', { email: K.email, password: PASS });
  check('servidor de e-mail recusando a mensagem: erro (nunca 200/202), sem sessão e sem cookie de desafio', bad.status >= 400 && !cookieNames(bad).some((n) => ['copocheio_cliente', 'copocheio_login'].includes(n)) && (await down.get('/api/account/me')).data.customer === null, bad.data);
  check('o desafio que não pôde ser enviado é descartado (nada fica aberto)', challenge(K.id).length === 0);
  await mailMode(null);
  const okAgain = await loginCustomer(new Client(), { email: K.email, password: PASS });
  check('quando o e-mail volta, o login funciona normalmente', okAgain.status === 200, okAgain.data);
}

// ------------------------------------------------------------------------------------------------
section('10. Trocar a senha, desativar ou excluir a conta derruba o desafio aberto');
{
  const L = await newAccount('mara');
  const sess = new Client();
  await loginCustomer(sess, { email: L.email, password: PASS });
  const attempt = new Client();
  await attempt.post('/api/account/login', { email: L.email, password: PASS });
  const code = await lastLoginCode(L.email);
  const changed = await sess.patch('/api/account/password', { current: PASS, next: NEW_PASS });
  check('(preparação) a conta troca a senha por outra sessão', changed.status === 200, changed.data);
  const late = await attempt.post('/api/account/login/code', { code });
  check('o código pedido ANTES da troca de senha deixa de valer (mesmo certo)', late.status === 400 && (await attempt.get('/api/account/me')).data.customer === null, late.data);
  const withNew = await loginCustomer(new Client(), { email: L.email, password: NEW_PASS });
  check('com a senha nova e um código novo, entra', withNew.status === 200);
  check('a senha antiga não chega nem a pedir código', (await new Client().post('/api/account/login', { email: L.email, password: PASS })).status === 401);

  const M = await newAccount('nair');
  const m = new Client();
  await m.post('/api/account/login', { email: M.email, password: PASS });
  const mcode = await lastLoginCode(M.email);
  psql(`update customers set active = false where id = ${lit(M.id)}`);
  check('conta desativada depois de pedir o código: o código não vale', (await m.post('/api/account/login/code', { code: mcode })).status === 400);
  psql(`update customers set active = true where id = ${lit(M.id)}`);

  const N = await newAccount('olga');
  const n = new Client();
  await loginCustomer(n, { email: N.email, password: PASS });
  await new Client().post('/api/account/login', { email: N.email, password: PASS });
  check('(preparação) a conta tem desafios gravados', challenge(N.id).length >= 2);
  const del = await n.req('DELETE', '/api/account', { password: PASS });
  check('excluir a conta apaga também os desafios de login (cascata)', del.status === 200 && Number(psql(`select count(*) from customer_login_challenges where customer_id = ${lit(N.id)}`)) === 0, del.data);
}

// ------------------------------------------------------------------------------------------------
section('11. Simultaneidade e proteções gerais');
{
  const O = await newAccount('paulo');
  const b = new Client();
  await b.post('/api/account/login', { email: O.email, password: PASS });
  const code = await lastLoginCode(O.email);
  const both = await Promise.all([b.post('/api/account/login/code', { code }), b.post('/api/account/login/code', { code })]);
  const oks = both.filter((r) => r.status === 200).length;
  check('dois envios do mesmo código ao mesmo tempo: só um vira sessão (uso único atômico)', oks === 1 && both.some((r) => r.status === 400), both.map((r) => r.status));
  check('origem estranha (CSRF) é recusada nas rotas novas (403)', (await new Client().post('/api/account/login/code', { code: '123456' }, { headers: { origin: 'https://evil.example' } })).status === 403 && (await new Client().post('/api/account/login/resend', {}, { headers: { origin: 'https://evil.example' } })).status === 403);
  // Rajada de erros de código de uma mesma rede: o limite por rede (30 em 15 min) vale
  const Q = await newAccount('quel');
  const ip = '203.0.113.99';
  const spam = [];
  for (let i = 0; i < 34; i++) {
    const c = new Client(undefined, ip);
    c.cookie = 'copocheio_login=' + 'B'.repeat(30);
    spam.push((await c.post('/api/account/login/code', { code: '000000' })).status);
  }
  check('muitos códigos errados da mesma rede: passa a responder 429 (limite por rede)', spam.slice(0, 30).every((s) => s === 400) && spam.slice(30).every((s) => s === 429), spam);
  void Q;
  check('o painel (login do dono) segue como antes: só senha (e o 2FA dele, se ligado)', (await new Client().login()).status === 200);
}

summary();
