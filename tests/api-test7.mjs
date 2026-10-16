// Recuperação de senha por e-mail (API real contra Postgres local + SMTP de mentira).
// usage: bash tests/fresh.sh && node tests/api-test7.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { Client, check, clearMail, codeFrom, mailMode, mailsTo, registerVerified, section, summary, loginCustomer } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const count = (sql) => Number(psql(sql));
const PASS = 'senha-antiga-123';
const NEW = 'senha-nova-456';
let seq = 0;
const fresh = (prefix = 'rec') => `${prefix}${++seq}@exemplo.com`;

const forgot = (client, email) => client.post('/api/account/forgot-password', { email });
const timed = async (fn) => {
  const t = Date.now();
  const r = await fn();
  return { ...r, ms: Date.now() - t };
};
const resetMails = async (email) => (await mailsTo(email)).filter((m) => /^Redefinir sua senha/.test(m.subject));
const changedMails = async (email) => (await mailsTo(email)).filter((m) => /^Sua senha foi alterada/.test(m.subject));
const linkOf = (mail) => /(https?:\/\/[^\s]+\/conta\/redefinir\/([A-Za-z0-9_-]+))/.exec(mail.text);
const tokenOf = (mail) => linkOf(mail)[2];
const reset = (client, token, password = NEW) => client.post('/api/account/reset', { token, password });
const check_ = (client, token) => client.post('/api/account/reset-check', { token });
// A espera de 60 s do banco: o horário dos envios anteriores vai para o passado.
const age = (email, interval = '2 minutes') => psql(`update customer_password_resets set sent_at = sent_at - interval '${interval}', created_at = created_at - interval '${interval}' where email = ${lit(email)}`);
const newAccount = async (name = 'Ana Souza', email = fresh(), password = PASS) => {
  const c = new Client();
  await registerVerified(c, { name, email, phone: '34999990000', password });
  return { c, email, password };
};
const pendingAccount = async (name = 'Paulo Pendente', email = fresh('pend')) => {
  await new Client().post('/api/account/register', { name, email, phone: '34999991111', password: PASS });
  return { email };
};

function analyze(html) {
  const VOID = new Set(['meta', 'img', 'br', 'hr', 'input', 'link']);
  const stack = [];
  const problems = [];
  const imgs = [];
  const links = [];
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === 'img') imgs.push(attrs);
        if (name === 'a') links.push(attrs.href ?? '');
        if (!VOID.has(name)) stack.push(name);
      },
      onclosetag(name, implied) {
        if (VOID.has(name)) return;
        const top = stack.pop();
        if (top !== name) problems.push(`</${name}> fechou, mas o aberto era <${top}>`);
        else if (implied) problems.push(`</${name}> foi fechado sozinho`);
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  if (stack.length) problems.push(`sem fechar: ${stack.join(',')}`);
  return { problems, imgs, links };
}

await clearMail();
const owner = new Client();
await owner.login();
// Loja aberta 24h + um produto (para o teste de recuperação por pedido)
const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0 });
const cat = (await owner.post('/api/admin/categories', { name: 'Recuperação teste' })).data.category;
await owner.post('/api/admin/products', { name: 'Coca 2L', price: 12, category_id: cat.id });

// ------------------------------------------------------------------------------------------------------
section('1. Pedir o link: conta ativa e confirmada');
const A = await newAccount('ana souza');
const deviceA = new Client();
await loginCustomer(deviceA, { email: A.email, password: PASS });
check('(preparação) a Ana está logada em outro aparelho', (await deviceA.get('/api/account/me')).data.customer?.email === A.email);
const verifiedAt = psql(`select email_verified_at from customers where email = ${lit(A.email)}`);
const f1 = await timed(() => forgot(new Client(), A.email));
check('pedido: 200 { ok, resend_in: 60, minutes: 60 } e nada mais (nem link, nem código, nem aviso de que a conta existe)', f1.status === 200 && JSON.stringify(f1.data) === JSON.stringify({ ok: true, resend_in: 60, minutes: 60 }), f1.data);
const mails1 = await resetMails(A.email);
check('1 e-mail "Redefinir sua senha", só para o endereço da conta', mails1.length === 1 && mails1[0].to.length === 1 && mails1[0].to[0] === A.email && mails1[0].subject === 'Redefinir sua senha – Copo Cheio', mails1.map((m) => [m.to, m.subject]));
const m1 = mails1[0];
const hi = analyze(m1.html);
check('o e-mail usa o layout da marca (logo, "Redefina sua senha", botão "Criar nova senha") e o HTML é bem formado', hi.problems.length === 0 && hi.imgs.length === 1 && /<h1[^>]*>Redefina sua senha<\/h1>/.test(m1.html) && />Criar nova senha<\/a>/.test(m1.html) && /Olá, <strong[^>]*>Ana<\/strong>!/.test(m1.html), hi.problems);
check('validade (60 minutos) e uso único estão no e-mail, em HTML e em texto', /60 minutos<\/strong> e só pode ser usado uma vez/.test(m1.html) && /60 minutos e só pode ser usado uma vez/.test(m1.text));
const token1 = tokenOf(m1);
check('o botão e o texto levam ao mesmo endereço /conta/redefinir/<43 caracteres>', token1.length === 43 && hi.links.includes(linkOf(m1)[1]) && m1.html.split(linkOf(m1)[1]).length >= 4, token1);
check('e-mail automático, sem a senha, sem JavaScript e sem rastreamento', m1.headers['auto-submitted'] === 'auto-generated' && !/<script|javascript:|onerror=/i.test(m1.html) && !m1.html.includes(PASS) && !m1.text.includes(PASS));
const row1 = psql(`select via, email, round(extract(epoch from expires_at - created_at)), sent_at is not null, used_at is null, created_by is null, token_hash from customer_password_resets where email = ${lit(A.email)}`).split('|');
check('banco: via=email, endereço, vale 60 min, enviado, não usado, sem administrador', row1[0] === 'email' && row1[1] === A.email && row1[2] === '3600' && row1[3] === 't' && row1[4] === 't' && row1[5] === 't', row1);
check('banco: só o hash (SHA-256) do link — o link em si não está em nenhuma coluna', row1[6] === sha(token1) && psql(`select count(*) from customer_password_resets where row(customer_password_resets.*)::text like ${lit('%' + token1 + '%')}`) === '0');
const ck = await check_(new Client(), token1);
check('reset-check: link válido devolve só o e-mail mascarado', ck.status === 200 && ck.data.valid === true && ck.data.email_masked === `${A.email[0]}***@exemplo.com` && Object.keys(ck.data).length === 2, ck.data);
const weak = await reset(new Client(), token1, 'curta');
check('senha curta: 400 e o link NÃO é gasto', weak.status === 400 && (await check_(new Client(), token1)).status === 200, weak.data);
const done = new Client();
const r1 = await reset(done, token1);
check('redefinir: 200 { ok, email, email_masked, verified: false } (conta já estava confirmada)', r1.status === 200 && r1.data.ok === true && r1.data.email === A.email && r1.data.verified === false, r1.data);
check('redefinir NÃO abre sessão (sem cookie): a pessoa entra com a senha nova', !done.cookie && !r1.headers.get('set-cookie'));
check('senha antiga não entra; a nova entra', (await loginCustomer(new Client(), { email: A.email, password: PASS })).status === 401 && (await loginCustomer(new Client(), { email: A.email, password: NEW })).status === 200);
check('o aparelho que estava logado foi desconectado (todas as sessões da conta caem)', (await deviceA.get('/api/account/me')).data.customer === null);
check('o e-mail continua confirmado, com a mesma data de antes', psql(`select email_verified_at from customers where email = ${lit(A.email)}`) === verifiedAt);
check('o mesmo link não vale duas vezes (reset e reset-check: 400 invalid_link)', (await reset(new Client(), token1, 'outra-senha-789')).data.code === 'invalid_link' && (await check_(new Client(), token1)).data.code === 'invalid_link');
const changed = await changedMails(A.email);
check('a Ana recebe o aviso "Sua senha foi alterada", com data e hora, sem senha nem link', changed.length === 1 && /redefinida em <strong[^>]*>\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}<\/strong>/.test(changed[0].html) && !/redefinir\//.test(changed[0].html + changed[0].text) && !changed[0].html.includes(NEW) && analyze(changed[0].html).problems.length === 0, changed[0]?.text);
const stamp = /(\d{2})\/(\d{2})\/(\d{4}) às (\d{2}):(\d{2})/.exec(changed[0].text);
const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
const then = new Date(`${stamp[3]}-${stamp[2]}-${stamp[1]}T${stamp[4]}:${stamp[5]}:00`);
check('...e a hora escrita é a do fuso da loja (America/Sao_Paulo), de agora', Math.abs(now - then) < 5 * 60_000, [stamp[0], now.toISOString()]);

// quem ficou bloqueado por errar a senha volta a entrar
const L = await newAccount('Lia Bloqueada');
const lockClient = new Client();
for (let i = 0; i < 8; i++) await loginCustomer(lockClient, { email: L.email, password: 'errada-' + i });
check('(preparação) 8 senhas erradas bloqueiam o login dessa rede (429), mesmo com a senha certa', (await loginCustomer(lockClient, { email: L.email, password: PASS })).status === 429);
await forgot(new Client(), L.email);
await reset(new Client(), tokenOf((await resetMails(L.email))[0]));
check('redefinir a senha libera o login bloqueado', (await loginCustomer(lockClient, { email: L.email, password: NEW })).status === 200);

// ------------------------------------------------------------------------------------------------------
section('2. Não revela quem tem conta');
const E1 = await newAccount('Elisa', fresh('uniforme'));
const D = await newAccount('Desativada', fresh('desativada'));
const dRow = (await owner.get(`/api/admin/customers?q=${encodeURIComponent(D.email)}`)).data.customers[0];
await owner.patch(`/api/admin/customers/${dRow.id}`, { active: false });
const P = await pendingAccount('Pendente', fresh('pendente'));
const targets = [E1.email, 'nao.existe.mesmo@exemplo.com', D.email, P.email];
const answers = await Promise.all(targets.map((email) => timed(() => forgot(new Client(), email))));
check('conta ativa, inexistente, desativada e pendente: a MESMA resposta (200, mesmo JSON)', answers.every((a) => a.status === 200 && JSON.stringify(a.data) === JSON.stringify(answers[0].data)), answers.map((a) => a.data));
check('a resposta demora o mesmo mínimo (≥ 1,5 s) com ou sem conta, e o tempo não separa quem tem conta de quem não tem', answers.every((a) => a.ms >= 1500) && Math.max(...answers.map((a) => a.ms)) - Math.min(...answers.map((a) => a.ms)) < 1500, answers.map((a) => a.ms));
check('e-mail só para conta ativa/pendente: nenhum para a inexistente nem para a desativada', (await resetMails(E1.email)).length === 1 && (await resetMails('nao.existe.mesmo@exemplo.com')).length === 0 && (await resetMails(D.email)).length === 0 && (await resetMails(P.email)).length === 1);
const spaced = await forgot(new Client(), `  ${A.email.toUpperCase()}  `);
check('maiúsculas e espaços não impedem (mesma conta)', spaced.status === 200);
const badFormats = ['', ' ', 'abc', 'a@', '@b.com', 'a b@c.com', 'a@b', null, 123, ['a@b.com'], { a: 1 }];
const badRes = [];
for (const email of badFormats) {
  const r = await forgot(new Client(), email);
  if (!(r.status === 400 && r.data.code === 'invalid_email')) badRes.push([JSON.stringify(email), r.status]);
}
check('formato inválido: 400 invalid_email (igual para todos, sem consultar o banco)', badRes.length === 0, badRes);
check('corpo que não é JSON: 415; origem de outro site: 403', (await new Client().req('POST', '/api/account/forgot-password', 'email=a@b.com', { raw: true, headers: { 'content-type': 'text/plain' } })).status === 415 && (await new Client().post('/api/account/forgot-password', { email: A.email }, { headers: { origin: 'https://evil.example' } })).status === 403);
const nul = await new Client().req('POST', '/api/account/forgot-password', '{"email":"a\\u0000@b.com"}', { raw: true, headers: { 'content-type': 'application/json' } });
check('caractere nulo no e-mail: 400 (nunca 500)', nul.status === 400, nul);

// ------------------------------------------------------------------------------------------------------
section('3. Limites: espera, por hora, por dia e por rede');
const R = await newAccount('Rita Reenvio', fresh('limite'));
await forgot(new Client(), R.email);
await forgot(new Client(), R.email);
check('segundo pedido dentro dos 60 s: responde igual, mas não manda outro e-mail (espera do banco)', (await resetMails(R.email)).length === 1);
const firstToken = tokenOf((await resetMails(R.email))[0]);
age(R.email);
await forgot(new Client(), R.email);
const rMails = await resetMails(R.email);
check('depois da espera: e-mail novo, com link novo', rMails.length === 2 && tokenOf(rMails[1]) !== firstToken);
check('o link anterior deixou de valer; só o mais novo vale', (await check_(new Client(), firstToken)).status === 400 && (await check_(new Client(), tokenOf(rMails[1]))).status === 200);
check('banco: o link antigo continua na tabela (vencido), então segue contando nos limites', count(`select count(*) from customer_password_resets where email = ${lit(R.email)} and expires_at <= now()`) === 1);
for (let i = 0; i < 3; i++) {
  age(R.email);
  await forgot(new Client(), R.email);
}
check('5 e-mails na primeira hora', (await resetMails(R.email)).length === 5);
age(R.email);
await forgot(new Client(), R.email);
check('6º pedido na mesma hora: mesma resposta, nenhum e-mail (limite de 5 por hora)', (await resetMails(R.email)).length === 5);
age(R.email, '2 hours');
for (let i = 0; i < 5; i++) {
  age(R.email);
  await forgot(new Client(), R.email);
}
check('passada a hora, voltam a sair (mais 5, total 10 em 24 h)', (await resetMails(R.email)).length === 10);
age(R.email, '2 hours');
await forgot(new Client(), R.email);
check('11º em 24 h: bloqueado pelo limite diário (10)', (await resetMails(R.email)).length === 10);
age(R.email, '25 hours');
await forgot(new Client(), R.email);
check('passadas 24 h, volta a enviar', (await resetMails(R.email)).length === 11);

const ipClient = new Client();
psql(`insert into rate_limits (bucket, key) select 'forgot-ip', ${lit(ipClient.ip)} from generate_series(1, 10)`);
const ipBlocked = await forgot(ipClient, A.email);
check('por rede: 10 pedidos por hora de um mesmo IP; o 11º recebe 429 (existindo a conta ou não)', ipBlocked.status === 429 && (await forgot(ipClient, 'nao.existe@exemplo.com')).status === 429, ipBlocked);
check('...e outro IP segue normal', (await forgot(new Client(), 'qualquer@exemplo.com')).status === 200);
const mailIp = new Client();
psql(`insert into rate_limits (bucket, key) select 'mail-ip', ${lit(mailIp.ip)} from generate_series(1, 15)`);
check('limite de e-mails por rede (15 por hora, dividido com a confirmação de cadastro): 429 rate_limited para todos os endereços', (await forgot(mailIp, E1.email)).data.code === 'rate_limited' && (await forgot(mailIp, 'nao.existe@exemplo.com')).data.code === 'rate_limited');
const onlyReal = new Client();
await forgot(onlyReal, 'sem.conta.nenhuma@exemplo.com');
check('só e-mail que saiu de verdade conta no limite por rede (consulta de endereço sem conta não gasta)', count(`select count(*) from rate_limits where bucket = 'mail-ip' and key = ${lit(onlyReal.ip)}`) === 0);
const onlyReal2 = new Client();
const F = await newAccount('Fabio', fresh('conta'));
await forgot(onlyReal2, F.email);
check('...e o que saiu conta 1', count(`select count(*) from rate_limits where bucket = 'mail-ip' and key = ${lit(onlyReal2.ip)}`) === 1);

// ------------------------------------------------------------------------------------------------------
section('4. O link: vencido, inventado, simultâneo e de outra conta');
const V = await newAccount('Vera', fresh('link'));
await forgot(new Client(), V.email);
const vToken = tokenOf((await resetMails(V.email))[0]);
psql(`update customer_password_resets set expires_at = now() - interval '1 second' where token_hash = ${lit(sha(vToken))}`);
check('link vencido (60 minutos): reset-check e reset respondem 400 invalid_link', (await check_(new Client(), vToken)).data.code === 'invalid_link' && (await reset(new Client(), vToken)).data.code === 'invalid_link');
check('...e a senha não mudou', (await loginCustomer(new Client(), { email: V.email, password: PASS })).status === 200);
const junk = ['', 'a', 'x'.repeat(200), '../../etc/passwd', "' or 1=1 --", '%00', 'ç'.repeat(43), 'A'.repeat(43), null, 123, { a: 1 }, ['x']];
const junkBad = [];
for (const t of junk) {
  const a = await check_(new Client(), t);
  const b = await reset(new Client(), t);
  if (!(a.status === 400 && a.data.code === 'invalid_link' && b.status === 400 && b.data.code === 'invalid_link')) junkBad.push([JSON.stringify(t)?.slice(0, 20), a.status, b.status]);
}
check('links inventados ou malformados (vazio, curto, longo, injeção, tipos errados): sempre 400 invalid_link, nunca 500', junkBad.length === 0, junkBad);
const W = await newAccount('Wilson', fresh('corrida'));
await forgot(new Client(), W.email);
const wToken = tokenOf((await resetMails(W.email))[0]);
const race = await Promise.all(Array.from({ length: 6 }, (_, i) => reset(new Client(), wToken, `senha-da-corrida-${i}`)));
check('6 redefinições simultâneas com o mesmo link: exatamente 1 vence (uso único)', race.filter((r) => r.status === 200).length === 1 && race.every((r) => [200, 400].includes(r.status)), race.map((r) => r.status));
const X = await newAccount('Xavier', fresh('outra'));
const Y = await newAccount('Yara', fresh('outra'));
await forgot(new Client(), X.email);
const xToken = tokenOf((await resetMails(X.email))[0]);
const cross = await new Client().post('/api/account/reset', { token: xToken, password: NEW, email: Y.email });
check('o link só redefine a conta dele: e-mail de outra conta no corpo é ignorado', cross.status === 200 && (await loginCustomer(new Client(), { email: X.email, password: NEW })).status === 200 && (await loginCustomer(new Client(), { email: Y.email, password: PASS })).status === 200);
const bruteIp = new Client();
const bruteStatuses = [];
for (let i = 0; i < 11; i++) bruteStatuses.push((await reset(bruteIp, 'tentativa-' + 'x'.repeat(30) + i)).status);
check('tentativas com link errado: 10 por rede a cada 15 min; a 11ª recebe 429', bruteStatuses.slice(0, 10).every((s) => s === 400) && bruteStatuses[10] === 429, bruteStatuses);
const checkIp = new Client();
psql(`insert into rate_limits (bucket, key) select 'reset-check-ip', ${lit(checkIp.ip)} from generate_series(1, 60)`);
check('consulta do link (reset-check): 60 por rede a cada 15 min; depois, 429', (await check_(checkIp, 'a'.repeat(43))).status === 429);

// ------------------------------------------------------------------------------------------------------
section('5. Conta que nunca confirmou o e-mail e links gerados pela loja');
const Pd = await pendingAccount('Paulo', fresh('pend'));
const pdBefore = (await mailsTo(Pd.email)).length;
check('(preparação) a conta está pending_verification e há um código de confirmação em aberto', psql(`select status from customers where email = ${lit(Pd.email)}`) === 'pending_verification' && count(`select count(*) from email_verifications where email = ${lit(Pd.email)} and used_at is null and invalidated_at is null`) === 1 && pdBefore === 1);
await forgot(new Client(), Pd.email);
const pdToken = tokenOf((await resetMails(Pd.email))[0]);
const pdReset = await reset(new Client(), pdToken, 'senha-do-paulo-2');
check('link de e-mail usado por conta pendente: troca a senha E confirma o e-mail (verified: true)', pdReset.status === 200 && pdReset.data.verified === true, pdReset.data);
check('banco: status active, data de confirmação gravada, códigos de confirmação em aberto invalidados', psql(`select status from customers where email = ${lit(Pd.email)}`) === 'active' && psql(`select email_verified_at > now() - interval '1 minute' from customers where email = ${lit(Pd.email)}`) === 't' && count(`select count(*) from email_verifications where email = ${lit(Pd.email)} and used_at is null and invalidated_at is null`) === 0);
check('depois disso o Paulo entra com a senha nova (sem código) e o código antigo não vale', (await loginCustomer(new Client(), { email: Pd.email, password: 'senha-do-paulo-2' })).status === 200 && (await new Client().post('/api/account/verify-email', { email: Pd.email, code: codeFrom((await mailsTo(Pd.email))[0]) })).status === 400);
check('...e recebe o aviso de senha alterada (o e-mail agora está confirmado)', (await changedMails(Pd.email)).length === 1);

// link gerado pela loja (WhatsApp): NÃO prova acesso ao e-mail
const Q = await pendingAccount('Quiteria', fresh('pend'));
const qRow = (await owner.get(`/api/admin/customers?q=${encodeURIComponent(Q.email)}`)).data.customers[0];
const adminLink = await owner.post(`/api/admin/customers/${qRow.id}/reset-link`, {});
const qReset = await reset(new Client(), adminLink.data.token, 'senha-da-quiteria');
check('link gerado pela loja numa conta pendente: troca a senha mas NÃO confirma o e-mail', adminLink.status === 201 && qReset.status === 200 && qReset.data.verified === false && psql(`select status from customers where email = ${lit(Q.email)}`) === 'pending_verification');
check('...então o login continua pedindo a confirmação do e-mail (403) e não manda aviso de senha alterada', (await loginCustomer(new Client(), { email: Q.email, password: 'senha-da-quiteria' })).data.code === 'email_not_verified' && (await changedMails(Q.email)).length === 0);
const Z = await newAccount('Zeca', fresh('loja'));
const zRow = (await owner.get(`/api/admin/customers?q=${encodeURIComponent(Z.email)}`)).data.customers[0];
const zLink = await owner.post(`/api/admin/customers/${zRow.id}/reset-link`, {});
check('link da loja em conta confirmada continua funcionando (como antes) e não manda o aviso de e-mail', (await reset(new Client(), zLink.data.token, NEW)).status === 200 && (await changedMails(Z.email)).length === 0 && psql(`select via from customer_password_resets where token_hash = ${lit(sha(zLink.data.token))}`) === 'admin');
// quando a loja gera um link, o de e-mail pendente deixa de valer (e vice-versa): vale o mais novo
const T = await newAccount('Teca', fresh('troca'));
await forgot(new Client(), T.email);
const tMailToken = tokenOf((await resetMails(T.email))[0]);
const tRow = (await owner.get(`/api/admin/customers?q=${encodeURIComponent(T.email)}`)).data.customers[0];
const tAdmin = await owner.post(`/api/admin/customers/${tRow.id}/reset-link`, {});
check('a loja gerar um link novo invalida o link de e-mail anterior (vale o mais novo)', (await check_(new Client(), tMailToken)).status === 400 && (await check_(new Client(), tAdmin.data.token)).status === 200);
const dAdmin = await owner.post(`/api/admin/customers/${dRow.id}/reset-link`, {});
check('conta desativada: se a loja gerar um link, a senha muda mas a conta continua desativada (não entra)', (await reset(new Client(), dAdmin.data.token, NEW)).status === 200 && psql(`select status from customers where email = ${lit(D.email)}`) === 'disabled' && (await loginCustomer(new Client(), { email: D.email, password: NEW })).status === 401);

// defesas do banco (mesmo que algo fora da API mexa nos dados)
const S = await pendingAccount('Silvia', fresh('defesa'));
await forgot(new Client(), S.email);
const sToken = tokenOf((await resetMails(S.email))[0]);
psql(`update customers set email = ${lit('mudou.' + S.email)} where email = ${lit(S.email)}`);
const sReset = await reset(new Client(), sToken, 'senha-da-silvia-1');
check('defesa: se o e-mail da conta já não é o que recebeu o link, a senha muda mas o e-mail NÃO é confirmado', sReset.status === 200 && sReset.data.verified === false && psql(`select status from customers where email = ${lit('mudou.' + S.email)}`) === 'pending_verification');
const U = await pendingAccount('Ulisses', fresh('naoenviado'));
const uId = psql(`select id from customers where email = ${lit(U.email)}`);
psql(`insert into customer_password_resets (token_hash, customer_id, expires_at, via, email) values (${lit(sha('token-nao-enviado-' + 'z'.repeat(26)))}, '${uId}', now() + interval '1 hour', 'email', ${lit(U.email)})`);
const uReset = await reset(new Client(), 'token-nao-enviado-' + 'z'.repeat(26), 'senha-do-ulisses-1');
check('defesa: link de e-mail que nunca foi enviado (sent_at vazio) não confirma o e-mail', uReset.status === 200 && uReset.data.verified === false && psql(`select status from customers where email = ${lit(U.email)}`) === 'pending_verification');

// qualquer outra troca de senha também derruba os links de e-mail ainda abertos
const K = await newAccount('Karina', fresh('outras'));
await forgot(new Client(), K.email);
const kToken = tokenOf((await resetMails(K.email))[0]);
const kChange = await K.c.patch('/api/account/password', { current: PASS, next: 'senha-trocada-logada-1' });
check('trocar a senha logada (Minha conta) invalida os links de redefinição que estavam em aberto', kChange.status === 200 && (await check_(new Client(), kToken)).status === 400);
const K2 = await newAccount('Katia', fresh('outras'));
const k2Order = await new Client().post('/api/orders', { customer_name: 'Katia', customer_phone: '(34) 99999-0000', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: (await owner.get('/api/admin/products')).data.products.find((p) => p.stock === null && p.active && !p.sold_out)?.id, quantity: 1 }] });
if (k2Order.status === 201) {
  const claim = await K2.c.post('/api/account/orders/claim', { order_number: k2Order.data.order.order_number, code: k2Order.data.token });
  await forgot(new Client(), K2.email);
  const k2Token = tokenOf((await resetMails(K2.email))[0]);
  const rec = await new Client().post('/api/account/recover', { email: K2.email, phone: '34999990000', order_number: k2Order.data.order.order_number, code: k2Order.data.token, password: 'senha-por-pedido-1' });
  check('recuperar pela via sem e-mail (telefone + pedido) também invalida os links de e-mail em aberto', claim.status === 200 && rec.status === 200 && (await check_(new Client(), k2Token)).status === 400, [claim.status, rec.status]);
} else check('(preparação) pedido para a recuperação por telefone + pedido', false, k2Order.data);

// ------------------------------------------------------------------------------------------------------
section('6. Falhas do servidor de e-mail');
const M = await newAccount('Marta', fresh('falha'));
await forgot(new Client(), M.email);
const mToken = tokenOf((await resetMails(M.email))[0]);
age(M.email);
await mailMode('down');
const down = await forgot(new Client(), M.email);
await mailMode(null);
check('servidor de e-mail fora do ar: a resposta é a mesma (200), sem revelar a falha', down.status === 200 && JSON.stringify(down.data) === JSON.stringify(f1.data), down);
check('...nenhum link novo fica guardado (nenhuma linha sem envio) e o que a pessoa já tinha continua valendo', count(`select count(*) from customer_password_resets where email = ${lit(M.email)} and sent_at is null`) === 0 && (await check_(new Client(), mToken)).status === 200);
await forgot(new Client(), M.email);
check('...e a falha não gastou a espera: ao voltar, o próximo pedido já envia', (await resetMails(M.email)).length === 2);
await mailMode('auth');
age(M.email);
const authFail = await forgot(new Client(), M.email);
await mailMode(null);
check('usuário/senha do SMTP recusados: mesma resposta e sem vazar o motivo', authFail.status === 200 && !/credenc|SMTP_|535|auth/i.test(JSON.stringify(authFail.data)));
// (o cadastro já recusa esse endereço no servidor de teste, então a conta é criada com outro e o e-mail muda por SQL)
const noBox = await newAccount('Nobox', fresh('rej'));
psql(`update customers set email = 'naoexiste.recupera@exemplo.com' where email = ${lit(noBox.email)}`);
const rej = await forgot(new Client(), 'naoexiste.recupera@exemplo.com');
check('servidor de e-mail recusa o destinatário: mesma resposta (200)', rej.status === 200 && JSON.stringify(rej.data) === JSON.stringify(f1.data));

// ------------------------------------------------------------------------------------------------------
section('7. Limpeza e conteúdo dos dados guardados');
const Pg = await newAccount('Pedro', fresh('limpeza'));
const pgId = psql(`select id from customers where email = ${lit(Pg.email)}`);
psql(`insert into customer_password_resets (token_hash, customer_id, expires_at, via, email, created_at) values (${lit(sha('velho-nao-enviado'))}, '${pgId}', now() + interval '1 hour', 'email', ${lit(Pg.email)}, now() - interval '2 hours')`);
psql(`insert into customer_password_resets (token_hash, customer_id, expires_at, via, email, sent_at) values (${lit(sha('enviado-recente'))}, '${pgId}', now() - interval '30 minutes', 'email', ${lit(Pg.email)}, now() - interval '90 minutes')`);
psql(`insert into customer_password_resets (token_hash, customer_id, expires_at, via, email, sent_at, used_at) values (${lit(sha('usado-antigo'))}, '${pgId}', now() - interval '9 days', 'email', ${lit(Pg.email)}, now() - interval '9 days', now() - interval '9 days')`);
psql('select purge_expired_data()');
check('limpeza: apaga link de e-mail que nunca foi enviado e link usado há mais de 7 dias', count(`select count(*) from customer_password_resets where token_hash in (${lit(sha('velho-nao-enviado'))}, ${lit(sha('usado-antigo'))})`) === 0);
check('...e mantém o link enviado há pouco (ele ainda conta nos limites por hora/dia)', count(`select count(*) from customer_password_resets where token_hash = ${lit(sha('enviado-recente'))}`) === 1);
check('nenhuma coluna da tabela guarda o endereço de e-mail em texto fora de "email" e nenhum link em texto puro', count(`select count(*) from customer_password_resets where token_hash !~ '^[0-9a-f]{64}$'`) === 0);

// ------------------------------------------------------------------------------------------------------
section('8. Conteúdo do e-mail com dados hostis');
const H = await newAccount('<img src=x onerror=alert(1)>Bia\r\nBcc: hacker@evil.com', fresh('hostil'));
await forgot(new Client(), H.email);
const hm = (await resetMails(H.email))[0];
check('nome com HTML e quebra de linha: escapado no HTML e nenhum cabeçalho extra (Bcc)', !/<img src=x/i.test(hm.html) && !hm.headers.bcc && hm.to.length === 1 && analyze(hm.html).problems.length === 0, hm.headers.bcc);

summary();
