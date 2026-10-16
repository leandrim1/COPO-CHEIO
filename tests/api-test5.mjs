// Confirmação obrigatória do e-mail (API real contra Postgres local, SMTP de mentira e DNS simulado).
// Cobre os 10 testes pedidos + abuso, concorrência e falhas do servidor de e-mail.
// usage: bash tests/fresh.sh && node tests/api-test5.mjs
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, check, clearMail, codeFrom, linkFrom, mailMode, mailsTo, registerVerified, section, summary, loginCustomer } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const count = (sql) => Number(psql(sql));
const tokenOf = (link) => link.split('/').pop();
// Mesma conta que o servidor de teste faz com a DATABASE_URL (o servidor guarda só o HMAC do código).
const DATABASE_URL = 'postgresql://user:pass@ep-test.neon.local/neondb?sslmode=require';
const pepper = createHmac('sha256', 'copocheio:email-code:v1').update(DATABASE_URL).digest();
const codeHash = (email, code) => createHmac('sha256', pepper).update(`${email}\n${code}`).digest('hex');

let seq = 0;
const fresh = (prefix = 'pessoa') => `${prefix}${++seq}@exemplo.com`;
const PASS = 'senha-boa-123';
// O cadastro entrega um cookie secreto ao navegador de quem se cadastrou (veja a migration 0009). Estes testes confirmam o e-mail "do mesmo
// navegador", como a pessoa faria; o caso de outro navegador tem suíte própria (api-test10).
const registrationCookies = new Map();
const reg = async (client, over = {}) => {
  const r = await client.post('/api/account/register', { name: 'Pessoa Teste', email: fresh(), phone: '34999990000', password: PASS, ...over });
  if (r.data?.email && client.jar.get('copocheio_cadastro')) registrationCookies.set(r.data.email, client.jar.get('copocheio_cadastro'));
  return r;
};
const verify = (client, email, code) => {
  const mine = registrationCookies.get(String(email).trim().toLowerCase());
  if (mine) client.jar.set('copocheio_cadastro', mine);
  return client.post('/api/account/verify-email', { email, code });
};
const hasSession = (client) => client.cookie.includes('copocheio_cliente=');
const setsSession = (r) => (r.headers.getSetCookie?.() ?? []).some((c) => c.startsWith('copocheio_cliente='));
const resend = (client, email) => client.post('/api/account/resend-verification', { email });
const state = (email) => psql(`select status || '|' || coalesce(email_verified_at::text, '-') from customers where lower(email) = ${lit(email.toLowerCase())}`);
const isPending = (email) => state(email) === 'pending_verification|-';
const isActive = (email) => state(email).startsWith('active|') && !state(email).endsWith('|-');
const customers = () => count('select count(*) from customers');
const customersWith = (email) => count(`select count(*) from customers where email = ${lit(email)}`);
// O banco exige 60 s entre envios: para o teste, a hora dos envios anteriores vai para o passado.
const age = (email, interval = '2 minutes') => psql(`update email_verifications set sent_at = sent_at - interval '${interval}', created_at = created_at - interval '${interval}' where email = ${lit(email)}`);

async function signUp(client, over = {}) {
  const email = over.email ?? fresh();
  const r = await reg(client, { ...over, email });
  const mails = await mailsTo(r.data?.email ?? email);
  const last = mails[mails.length - 1];
  return { r, client, email: r.data?.email ?? email, mails, mail: last, code: codeFrom(last), link: linkFrom(last) };
}

await clearMail();
const owner = new Client();
await owner.login();

// ---- Preparação: loja aberta 24h + um produto (para os testes de pedido) ---------------------------------
const allDays = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: allDays, delivery_fee: 5, min_order: 0 });
const cat = (await owner.post('/api/admin/categories', { name: 'Verificação teste' })).data.category;
const coca = (await owner.post('/api/admin/products', { name: 'Coca 2L', price: 12, category_id: cat.id })).data.product;
const orderBody = (over = {}) => ({ customer_name: 'Ana Souza', customer_phone: '(34) 98888-1111', delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: coca.id, quantity: 1 }], ...over });

// ------------------------------------------------------------------------------------------------------
section('0. Ambiente');
const health = await new Client().get('/api/health');
check('/api/health: banco, blob e e-mail ok', health.status === 200 && health.data.mail === 'ok' && health.data.database === 'ok', health.data);
const mailInfo = await owner.get('/api/admin/mail');
check('painel: e-mail configurado, sem expor segredos', mailInfo.data.configured === true && mailInfo.data.missing.length === 0 && !/secret|SMTP_PASS/i.test(JSON.stringify(mailInfo.data)), mailInfo.data);
check('painel: só admin vê o estado do e-mail', (await new Client().get('/api/admin/mail')).status === 401);

// ------------------------------------------------------------------------------------------------------
section('TESTE 1 — Cadastro com e-mail válido e acessível → confirmação → login');
const c1 = new Client();
const s1 = await signUp(c1, { name: 'Maria Silva', email: '  Maria.Silva@EXEMPLO.com ' });
const email1 = 'maria.silva@exemplo.com';
check('cadastro: 202 pending_verification', s1.r.status === 202 && s1.r.data.status === 'pending_verification', s1.r);
check('devolve e-mail normalizado, máscara, espera de reenvio e validade do código', s1.r.data.email === email1 && s1.r.data.email_masked === 'm***@exemplo.com' && s1.r.data.resend_in === 60 && s1.r.data.code_minutes === 15, s1.r.data);
check('a resposta só tem esses campos (nada de código, link, hash ou senha)', JSON.stringify(Object.keys(s1.r.data).sort()) === JSON.stringify(['code_minutes', 'email', 'email_masked', 'resend_in', 'status']), Object.keys(s1.r.data));
check('o cadastro não abre sessão (só o cookie secreto do cadastro, HttpOnly)', !hasSession(c1) && !setsSession(s1.r) && /^copocheio_cadastro=.+HttpOnly/.test(c1.lastSetCookie), c1.lastSetCookie);
check('banco: pending_verification, sem data de confirmação', isPending(email1), state(email1));
check('1 e-mail enviado, só para o endereço informado', s1.mails.length === 1 && s1.mails[0].to.length === 1 && s1.mails[0].to[0] === email1, s1.mails.map((m) => m.to));
check('o e-mail traz código de 6 dígitos e link de confirmação', /^\d{6}$/.test(s1.code ?? '') && /^https?:\/\/[^/]+\/conta\/verificar\/[A-Za-z0-9_-]{43}$/.test(s1.link ?? ''), s1.link);
check('assunto com o código; remetente configurado', s1.mail.subject.startsWith(`${s1.code} é o seu código de confirmação`) && /loja@copocheio\.test/.test(s1.mail.from), [s1.mail.subject, s1.mail.from]);
check('e-mail automático (Auto-Submitted) e sem a senha em lugar nenhum', s1.mail.headers['auto-submitted'] === 'auto-generated' && !s1.mail.text.includes(PASS) && !s1.mail.html.includes(PASS));
const row1 = psql(`select code_hash, link_hash, attempts, max_attempts, round(extract(epoch from code_expires_at - created_at)), round(extract(epoch from link_expires_at - created_at)), used_at is null from email_verifications where email = ${lit(email1)}`).split('|');
check('banco: só guarda hash (hex de 64) do código e do link, nunca o valor em si', /^[0-9a-f]{64}$/.test(row1[0]) && row1[0] !== s1.code && row1[0] === codeHash(email1, s1.code) && row1[1] === sha(tokenOf(s1.link)), row1);
check('banco: código vale 15 min, link 24 h, 0 de 5 tentativas, ainda não usado', row1[4] === '900' && row1[5] === '86400' && row1[2] === '0' && row1[3] === '5' && row1[6] === 't', row1);
const v1 = await verify(c1, email1, s1.code);
check('código certo: 200 verified', v1.status === 200 && v1.data.verified === true, v1);
check('confirmar o e-mail não abre sessão (a pessoa entra com a senha)', !hasSession(c1) && !setsSession(v1));
check('banco: active e data de confirmação gravada agora', psql(`select status = 'active' and email_verified_at > now() - interval '1 minute' from customers where email = ${lit(email1)}`) === 't');
check('banco: o código foi marcado como usado', psql(`select used_at is not null from email_verifications where email = ${lit(email1)}`) === 't');
const l1 = await loginCustomer(c1, { email: email1.toUpperCase(), password: PASS });
check('login depois de confirmar: 200, cookie HttpOnly, dados da conta', l1.status === 200 && /HttpOnly/i.test(c1.lastSetCookie ?? '') && l1.data.customer?.email === email1, l1);
check('a resposta do login não traz senha nem hash', !/password|hash/i.test(JSON.stringify(l1.data)));
check('/me devolve a conta', (await c1.get('/api/account/me')).data.customer?.email === email1);

// ------------------------------------------------------------------------------------------------------
section('TESTE 2 — Formato inválido é rejeitado');
const invalid = [
  '', ' ', 'abc', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a@@b.com', 'a@b..com', '.a@b.com', 'a.@b.com', 'a..b@c.com', 'a@-b.com', 'a@b-.com', 'a@b.c',
  '"a b"@c.com', 'a(c)@b.com', 'a@[127.0.0.1]', 'a@127.0.0.1', 'joão@gmail.com', 'a@b.com\r\nBcc: x@y.com', 'a@b.com,c@d.com', 'a;b@c.com', 'a<b>@gmail.com',
  `${'a'.repeat(65)}@gmail.com`, `a@${'b'.repeat(64)}.com`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`, 'a@b.com.', 'a@.com', '@', 'a@@',
  "x'; drop table customers; --@gmail.com", 'a@gmail',
];
const before2 = { accounts: customers(), mails: (await mailsTo('')).length };
const c2 = new Client();
const odd = [];
for (const email of invalid) {
  const r = await reg(c2, { email });
  if (!(r.status === 400 && r.data.code === 'invalid_email')) odd.push([email.slice(0, 40), r.status, r.data?.code]);
}
for (const email of [123, null, ['a@gmail.com'], { a: 1 }, true, undefined]) {
  const r = await reg(c2, { email });
  if (!(r.status === 400 && r.data.code === 'invalid_email')) odd.push([JSON.stringify(email), r.status, r.data?.code]);
}
check(`${invalid.length + 6} entradas inválidas: todas 400 invalid_email`, odd.length === 0, odd);
check('nenhuma conta criada e nenhum e-mail enviado por formato inválido', customers() === before2.accounts && (await mailsTo('')).length === before2.mails);
const msg2 = (await reg(c2, { email: 'abc' })).data.error;
check('mensagem clara em português, com exemplo e sem preferir um provedor', /Confira o e-mail/.test(msg2) && /nome@provedor\.com/.test(msg2) && /qualquer provedor/.test(msg2) && !/gmail/i.test(msg2), msg2);

const normal = [
  ['  Ana.Souza@GMAIL.com  ', 'ana.souza@gmail.com'],
  ['ana+loja@gmail.com', 'ana+loja@gmail.com'],
  ['anasouza@gmail.com', 'anasouza@gmail.com'],
  ["o'brien@exemplo.com", "o'brien@exemplo.com"],
  ['bia@mañana.com', 'bia@xn--maana-pta.com'],
  ['carlos​@exemplo.com', 'carlos@exemplo.com'],
  ['DIEGO@Exemplo.COM.BR', 'diego@exemplo.com.br'],
];
const bad = [];
for (const [input, expected] of normal) {
  const r = await reg(new Client(), { email: input });
  if (!(r.status === 202 && r.data.email === expected && count(`select count(*) from customers where email = ${lit(expected)}`) === 1)) bad.push([input, r.status, r.data?.email]);
}
check('normalização: minúsculas, espaços/invisíveis tirados, domínio em punycode', bad.length === 0, bad);
check('normalização não muda o endereço: pontos e +etiqueta são mantidos (3 contas distintas)', count(`select count(*) from customers where email in ('ana.souza@gmail.com','ana+loja@gmail.com','anasouza@gmail.com')`) === 3);
const dup = await reg(new Client(), { email: 'ANA.SOUZA@gmail.com' });
check('mesmo endereço com outra caixa (maiúsculas) é a mesma conta', dup.status === 202 && count(`select count(*) from customers where lower(email) = 'ana.souza@gmail.com'`) === 1);

// ------------------------------------------------------------------------------------------------------
section('TESTE 3 — Domínio inexistente ou que não recebe e-mail é rejeitado');
const rejected = [
  ['dominio-inexistente-xyz.com', 'nxdomain'],
  ['outro-dominio-inexistente.com.br', 'nxdomain'],
  ['sem-registros.com.br', 'no-mail'],
  ['mxnulo.com.br', 'null-mx'],
  ['mxnulo-ponto.com.br', 'null-mx'],
  ['example.com', 'reserved'],
  ['example.org', 'reserved'],
  ['site.test', 'reserved'],
  ['site.invalid', 'reserved'],
  ['loja.local', 'reserved'],
  ['qualquer.example', 'reserved'],
];
const before3 = { accounts: customers(), mails: (await mailsTo('')).length };
const c3 = new Client();
const wrong3 = [];
for (const [domain, reason] of rejected) {
  const r = await reg(c3, { email: `fulano@${domain}` });
  if (!(r.status === 400 && r.data.code === 'invalid_email_domain' && r.data.reason === reason)) wrong3.push([domain, r.status, r.data?.reason]);
}
check(`${rejected.length} domínios inexistentes/sem e-mail/reservados: 400 invalid_email_domain com o motivo certo`, wrong3.length === 0, wrong3);
check('nenhuma conta criada e nenhum e-mail enviado para eles', customers() === before3.accounts && (await mailsTo('')).length === before3.mails);
check('mensagem clara para domínio inexistente', /Não encontramos esse domínio/.test((await reg(c3, { email: 'x@dominio-inexistente-xyz.com' })).data.error));
const inconclusive = ['sem-mx-com-a.com.br', 'so-ipv6.com.br', 'dns-quebrado.com.br', 'dns-lento.com.br', 'so-nxdomain-no-mx.com.br'];
const refused3 = [];
for (const domain of inconclusive) {
  const r = await reg(new Client(), { email: `fulano@${domain}` });
  if (!(r.status === 202 && (await mailsTo(`fulano@${domain}`)).length === 1)) refused3.push([domain, r.status, r.data?.error]);
}
check('sem MX mas com A/AAAA (regra do SMTP) e DNS inconclusivo (SERVFAIL/timeout): segue — quem decide é o e-mail de confirmação', refused3.length === 0, refused3);

// ------------------------------------------------------------------------------------------------------
section('TESTE 4 — Domínio temporário/descartável é bloqueado');
const disposable = ['mailinator.com', '10minutemail.com', 'guerrillamail.com', 'yopmail.com', 'sharklasers.com', 'trashmail.com', 'throwawaymail.com', 'temp-mail.org', 'maildrop.cc', 'getnada.com', 'dispostable.com', 'mohmal.com', 'MAILINATOR.COM', 'sub.mailinator.com', 'a.b.yopmail.com'];
const before4 = { accounts: customers(), mails: (await mailsTo('')).length };
const wrong4 = [];
const c4 = new Client();
for (const domain of disposable) {
  const r = await reg(c4, { email: `fulano@${domain}` });
  if (!(r.status === 400 && r.data.code === 'invalid_email_domain' && r.data.reason === 'disposable')) wrong4.push([domain, r.status, r.data?.reason]);
}
check(`${disposable.length} domínios descartáveis (inclusive subdomínio e maiúsculas): 400 com motivo "disposable"`, wrong4.length === 0, wrong4);
check('nenhuma conta criada e nenhum e-mail enviado para eles', customers() === before4.accounts && (await mailsTo('')).length === before4.mails);
check('mensagem clara', /temporários ou descartáveis/.test((await reg(c4, { email: 'x@mailinator.com' })).data.error));
const legit = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com.br', 'icloud.com', 'uol.com.br', 'bol.com.br', 'proton.me', 'duck.com', 'live.com'];
const blocked4 = [];
for (const domain of legit) {
  const r = await reg(new Client(), { email: `cliente@${domain}` });
  if (r.status !== 202) blocked4.push([domain, r.status, r.data?.error]);
}
check('provedores comuns (Gmail, Outlook, Hotmail, Yahoo, iCloud, UOL, Proton...) nunca são barrados', blocked4.length === 0, blocked4);
const listFile = readFileSync(new URL('../server/disposableDomains.ts', import.meta.url), 'utf8');
check('lista de descartáveis embutida: mais de 50 mil domínios, com a data da atualização', (listFile.match(/\n/g) || []).length > 50000 && /DISPOSABLE_DOMAINS_UPDATED = '\d{4}-\d{2}-\d{2}'/.test(listFile));

// ------------------------------------------------------------------------------------------------------
section('TESTES 5 e 9 — E-mail não confirmado: nenhum acesso, nem chamando a API direto');
const c5 = new Client();
const s5 = await signUp(c5, { name: 'Paulo Pendente', email: 'paulo.pendente@exemplo.com', phone: '34988881111' });
const L5 = await loginCustomer(c5, { email: s5.email, password: PASS });
check('senha certa + e-mail sem confirmar: 403 email_not_verified', L5.status === 403 && L5.data.code === 'email_not_verified', L5);
check('...sem cookie e sem sessão no banco', !hasSession(c5) && !setsSession(L5) && count(`select count(*) from customer_sessions s join customers c on c.id = s.customer_id where c.email = ${lit(s5.email)}`) === 0);
check('...a resposta diz que falta confirmar e quanto tempo falta para reenviar, sem vazar código', L5.data.email_masked === 'p***@exemplo.com' && L5.data.mail_available === true && L5.data.resend_in === 60 && !/\d{6}/.test(JSON.stringify(L5.data)), L5.data);
check('...dentro dos 60 s não manda outro e-mail (sent=false)', L5.data.sent === false && (await mailsTo(s5.email)).length === 1);
const wrongPass = await loginCustomer(new Client(), { email: s5.email, password: 'senha-errada-999' });
check('senha errada em conta pendente: o mesmo 401 genérico (não revela que existe)', wrongPass.status === 401 && wrongPass.data.error === 'E-mail ou senha incorretos.', wrongPass);
const unknown = await loginCustomer(new Client(), { email: 'ninguem@exemplo.com', password: PASS });
check('e-mail inexistente: o mesmo 401 genérico', unknown.status === 401 && unknown.data.error === wrongPass.data.error);

const protectedCalls = [
  ['GET', '/api/account/orders'],
  ['GET', '/api/account/orders/1001'],
  ['POST', '/api/account/orders/claim', { order_number: 1001, code: '7K3M9-QX2VB-4HRD6-WTP8N' }],
  ['PATCH', '/api/account', { name: 'Outro Nome' }],
  ['PATCH', '/api/account/password', { current: PASS, next: 'outra-senha-123' }],
  ['DELETE', '/api/account', { password: PASS }],
];
const notDenied = async (client) => {
  const out = [];
  for (const [method, path, body] of protectedCalls) {
    const r = await client.req(method, path, body);
    if (r.status !== 401) out.push([method, path, r.status]);
  }
  const me = await client.get('/api/account/me');
  if (me.data?.customer !== null) out.push(['GET', '/api/account/me', 'devolveu conta']);
  return out;
};
check('sem cookie: as 6 rotas protegidas da conta respondem 401 e /me não tem conta', (await notDenied(c5)).length === 0, await notDenied(c5));
const guessed = new Client();
guessed.cookie = 'copocheio_cliente=' + 'a'.repeat(43);
check('com um cookie inventado: tudo 401', (await notDenied(guessed)).length === 0);
// Sessão "forjada": linha de sessão válida no banco para a conta que ainda não confirmou (como um bug ou ataque poderia criar).
const forgedToken = 'forjada-' + 'z'.repeat(35);
const pendingId = psql(`select id from customers where email = ${lit(s5.email)}`);
psql(`insert into customer_sessions (token_hash, customer_id, expires_at) values (${lit(sha(forgedToken))}, '${pendingId}', now() + interval '1 day')`);
const forged = new Client();
forged.cookie = `copocheio_cliente=${forgedToken}`;
check('sessão válida no banco para conta SEM e-mail confirmado: o servidor recusa mesmo assim (tudo 401)', (await notDenied(forged)).length === 0, await notDenied(forged));
const guestOrder = await forged.post('/api/orders', orderBody({ customer_phone: '(34) 98888-1111' }));
check('pedido com essa sessão: sai como visitante (nunca ligado à conta não confirmada)', guestOrder.status === 201 && psql(`select customer_id is null from orders where order_number = ${guestOrder.data.order.order_number}`) === 't', guestOrder.data);
const adminWithCustomerCookie = await forged.get('/api/admin/customers');
check('o cookie de cliente não abre o painel', adminWithCustomerCookie.status === 401);
// Conta desativada com e-mail confirmado também fica sem acesso, mesmo com sessão no banco
const dis = await signUp(new Client(), { email: fresh('desativada') });
await verify(new Client(), dis.email, dis.code);
const disId = psql(`select id from customers where email = ${lit(dis.email)}`);
const disToken = 'desativada-' + 'y'.repeat(32);
psql(`insert into customer_sessions (token_hash, customer_id, expires_at) values (${lit(sha(disToken))}, '${disId}', now() + interval '1 day')`);
const disClient = new Client();
disClient.cookie = `copocheio_cliente=${disToken}`;
check('antes de desativar, essa sessão funciona (controle do teste)', (await disClient.get('/api/account/orders')).status === 200);
psql(`update customers set active = false where id = '${disId}'`);
check('conta desativada: a mesma sessão deixa de valer (tudo 401)', (await notDenied(disClient)).length === 0);
psql(`update customers set active = true where id = '${disId}'`);
// Depois de confirmar, a MESMA sessão passa a valer: o que barra é só o estado do e-mail
await verify(new Client(), s5.email, s5.code);
check('banco: conta confirmada', isActive(s5.email));
check('depois de confirmar o e-mail, a mesma sessão passa a funcionar', (await forged.get('/api/account/orders')).status === 200 && (await forged.get('/api/account/me')).data.customer?.email === s5.email);

// ------------------------------------------------------------------------------------------------------
section('TESTE 6 — Código errado, vencido, reutilizado ou de outro endereço é rejeitado');
const A = await signUp(new Client(), { email: fresh('codigo') });
const B = await signUp(new Client(), { email: fresh('codigo') });
const ca = new Client();
const wrong = A.code === '000000' ? '111111' : '000000';
let r6 = await verify(ca, A.email, wrong);
check('código errado: 400 invalid_code (e a conta continua pendente)', r6.status === 400 && r6.data.code === 'invalid_code' && isPending(A.email), r6);
const malformed = ['', '12345', '1234567', 'abcdef', '12 3', '١٢٣٤٥٦', null, 123456, ['123456'], { code: '123456' }, '1234567890123456789012345678901234567890'];
const fmt = [];
for (const code of malformed) {
  const r = await verify(ca, A.email, code);
  if (!(r.status === 400 && r.data.code === 'invalid_code_format')) fmt.push([JSON.stringify(code).slice(0, 30), r.status, r.data?.code]);
}
check('código fora do formato (curto, longo, letras, número, lista, objeto): 400 invalid_code_format', fmt.length === 0, fmt);
check('...e códigos mal formados NÃO gastam tentativas (só o código errado de verdade contou: 1)', psql(`select attempts from email_verifications where email = ${lit(A.email)}`) === '1');
r6 = await verify(ca, B.email, A.code);
check('código de OUTRO endereço não confirma (nem a B nem a A)', r6.status === 400 && isPending(B.email) && isPending(A.email), r6);
const nobody = await verify(ca, 'ninguem.mesmo@exemplo.com', '123456');
check('e-mail sem cadastro: a mesma resposta de código errado (não revela se existe)', nobody.status === 400 && nobody.data.error === r6.data.error && nobody.data.code === r6.data.code, nobody);
const spaced = await verify(new Client(), A.email.toUpperCase(), `${A.code.slice(0, 3)} ${A.code.slice(3)}`);
check('código com espaço no meio e e-mail em maiúsculas: aceito (tolerância de digitação)', spaced.status === 200 && isActive(A.email), spaced);
const reuse = await verify(new Client(), A.email, A.code);
check('código já usado não vale de novo', reuse.status === 400 && reuse.data.code === 'invalid_code', reuse);
const linkAfter = await new Client().post('/api/account/verify-link', { token: tokenOf(A.link) });
check('o link do mesmo e-mail também não vale depois que o código foi usado', linkAfter.status === 400 && linkAfter.data.code === 'invalid_link', linkAfter);

const D = await signUp(new Client(), { email: fresh('vencido') });
psql(`update email_verifications set code_expires_at = now() - interval '1 second' where email = ${lit(D.email)}`);
const expiredCode = await verify(new Client(), D.email, D.code);
check('código vencido (15 min): 400, mesmo sendo o certo', expiredCode.status === 400 && expiredCode.data.code === 'invalid_code' && isPending(D.email), expiredCode);
const linkWorks = await new Client().post('/api/account/verify-link', { token: tokenOf(D.link) });
check('o link (24 h) continua valendo depois que o código venceu: confirma', linkWorks.status === 200 && linkWorks.data.verified === true && linkWorks.data.email === D.email && isActive(D.email), linkWorks);
check('o link devolve só o e-mail mascarado para mostrar, e nada de sessão', linkWorks.data.email_masked === 'v***@exemplo.com' && !setsSession(linkWorks));
const linkAgain = await new Client().post('/api/account/verify-link', { token: tokenOf(D.link) });
check('o mesmo link não vale duas vezes', linkAgain.status === 400 && linkAgain.data.code === 'invalid_link');
const codeAfterLink = await verify(new Client(), D.email, D.code);
check('o código também não vale depois do link', codeAfterLink.status === 400);

const E = await signUp(new Client(), { email: fresh('linkvenc') });
psql(`update email_verifications set link_expires_at = now() - interval '1 second' where email = ${lit(E.email)}`);
const expiredLink = await new Client().post('/api/account/verify-link', { token: tokenOf(E.link) });
check('link vencido (24 h): 400 invalid_link', expiredLink.status === 400 && expiredLink.data.code === 'invalid_link' && isPending(E.email), expiredLink);
const codeStill = await verify(new Client(), E.email, E.code);
check('...e o código ainda dentro dos 15 min confirma', codeStill.status === 200 && isActive(E.email), codeStill);

const junkLinks = ['', 'a', 'x'.repeat(200), '../../etc/passwd', "' or 1=1 --", '%00', 'ç'.repeat(43), 'A'.repeat(43), null, 123, { a: 1 }];
const junkBad = [];
for (const token of junkLinks) {
  const r = await new Client().post('/api/account/verify-link', { token });
  if (!(r.status === 400 && r.data.code === 'invalid_link')) junkBad.push([JSON.stringify(token)?.slice(0, 30), r.status]);
}
check('links inventados ou malformados (vazio, curto, longo, injeção, tipos errados): todos 400 invalid_link, nenhum erro 500', junkBad.length === 0, junkBad);

const G = await signUp(new Client(), { email: fresh('corrida') });
const racers = await Promise.all(Array.from({ length: 6 }, () => verify(new Client(), G.email, G.code)));
check('6 confirmações simultâneas com o mesmo código: exatamente 1 vence (uso único)', racers.filter((x) => x.status === 200).length === 1 && racers.every((x) => [200, 400, 429].includes(x.status)), racers.map((x) => x.status));

// ------------------------------------------------------------------------------------------------------
section('TESTE 7 — Reenvio com limites; códigos anteriores deixam de valer');
const R = await signUp(new Client(), { email: fresh('reenvio'), name: 'Rita Reenvio' });
const rr = () => new Client(); // cada chamada de um IP (os limites por IP são testados no teste 8)
let x = await resend(rr(), R.email);
check('reenvio dentro dos 60 s: responde normal, mas não manda outro e-mail (espera do banco)', x.status === 200 && x.data.ok === true && (await mailsTo(R.email)).length === 1 && count(`select count(*) from email_verifications where email = ${lit(R.email)}`) === 1, x);
age(R.email);
x = await resend(rr(), R.email);
let mails7 = await mailsTo(R.email);
check('depois da espera: um e-mail novo, com código novo', x.status === 200 && mails7.length === 2 && codeFrom(mails7[1]) !== undefined, mails7.length);
const R2 = codeFrom(mails7[1]);
check('banco: o envio anterior foi invalidado e só o novo está ativo', psql(`select count(*) filter (where invalidated_at is not null), count(*) filter (where invalidated_at is null and used_at is null) from email_verifications where email = ${lit(R.email)}`) === '1|1');
const oldCode = await verify(rr(), R.email, R.code);
check('o código do primeiro e-mail deixou de valer', R.code === R2 || (oldCode.status === 400 && oldCode.data.code === 'invalid_code'), oldCode);
const oldLink = await new Client().post('/api/account/verify-link', { token: tokenOf(R.link) });
check('o link do primeiro e-mail também deixou de valer', oldLink.status === 400 && oldLink.data.code === 'invalid_link', oldLink);
// limite por hora: 5 envios
for (let i = 0; i < 3; i++) {
  age(R.email);
  await resend(rr(), R.email);
}
check('5 e-mails enviados na primeira hora', (await mailsTo(R.email)).length === 5);
age(R.email);
x = await resend(rr(), R.email);
check('6º pedido na mesma hora: a resposta é a mesma, mas nenhum e-mail sai (limite de 5 por hora)', x.status === 200 && x.data.ok === true && (await mailsTo(R.email)).length === 5);
age(R.email, '2 hours');
for (let i = 0; i < 5; i++) {
  age(R.email);
  await resend(rr(), R.email);
}
check('depois de passada a hora, volta a enviar (mais 5, total 10 em 24 h)', (await mailsTo(R.email)).length === 10);
age(R.email, '2 hours');
x = await resend(rr(), R.email);
check('11º envio em 24 h: bloqueado pelo limite diário (10), nenhum e-mail novo', x.status === 200 && (await mailsTo(R.email)).length === 10 && count(`select count(*) from email_verifications where email = ${lit(R.email)} and sent_at > now() - interval '24 hours'`) === 10);
age(R.email, '25 hours');
x = await resend(rr(), R.email);
check('passadas 24 h, os envios voltam', (await mailsTo(R.email)).length === 11);
const R11 = await lastCodeOf(R.email);
check('o último código confirma a conta', (await verify(rr(), R.email, R11)).status === 200 && isActive(R.email));
async function lastCodeOf(email) {
  const list = await mailsTo(email);
  return codeFrom(list[list.length - 1]);
}

// Resposta idêntica: existe pendente, não existe ou já confirmado
const U1 = await signUp(new Client(), { email: fresh('uniforme') });
const verifiedMails = (await mailsTo(email1)).length;
const answers = [await resend(rr(), U1.email), await resend(rr(), 'nao.existe.mesmo@exemplo.com'), await resend(rr(), email1)];
check('reenvio: pendente, inexistente e já confirmado dão a MESMA resposta (não revela quem tem conta)', answers.every((a) => a.status === 200 && JSON.stringify(a.data) === JSON.stringify(answers[0].data)), answers.map((a) => a.data));
check('...e para inexistente/já confirmado nenhum e-mail de código sai', (await mailsTo('nao.existe.mesmo@exemplo.com')).length === 0 && (await mailsTo(email1)).length === verifiedMails);
const bogus = await resend(rr(), 'isto-nao-e-email');
check('reenvio com e-mail de formato inválido: 400 invalid_email', bogus.status === 400 && bogus.data.code === 'invalid_email', bogus);

// ---- Falhas do servidor de e-mail -----------------------------------------------------------------------
const S = await signUp(new Client(), { email: fresh('falha') });
age(S.email);
await mailMode('down');
x = await resend(rr(), S.email);
check('servidor de e-mail fora do ar: 503 mail_failed com mensagem amigável', x.status === 503 && x.data.code === 'mail_failed' && /Tente de novo/.test(x.data.error), x);
await mailMode('auth');
age(S.email);
x = await resend(rr(), S.email);
check('usuário/senha do SMTP recusados: 503 mail_failed, sem vazar o motivo técnico ao cliente', x.status === 503 && x.data.code === 'mail_failed' && !/credenc|SMTP_|535|auth/i.test(JSON.stringify(x.data)), x);
await mailMode(null);
check('falha de envio não deixa código novo guardado (nenhuma linha sem envio)', count(`select count(*) from email_verifications where email = ${lit(S.email)} and sent_at is null`) === 0);
check('o código que a pessoa já tinha continua valendo depois da falha', (await verify(rr(), S.email, S.code)).status === 200 && isActive(S.email));
await mailMode('down');
const downReg = await reg(new Client(), { email: 'cadastro.falha@exemplo.com' });
await mailMode(null);
check('cadastro com o servidor de e-mail fora do ar: 503, a pessoa pode tentar de novo', downReg.status === 503 && downReg.data.code === 'mail_failed' && isPending('cadastro.falha@exemplo.com') && count(`select count(*) from email_verifications where email = 'cadastro.falha@exemplo.com'`) === 0, downReg);
const retry = await signUp(new Client(), { email: 'cadastro.falha@exemplo.com' });
check('...e na segunda tentativa recebe o código e confirma', retry.r.status === 202 && (await verify(new Client(), retry.email, retry.code)).status === 200 && isActive(retry.email));
const noBox = await reg(new Client(), { email: 'naoexiste.caixa@exemplo.com' });
check('servidor de e-mail recusa o destinatário (caixa inexistente): 400 mail_recipient_rejected', noBox.status === 400 && noBox.data.code === 'mail_recipient_rejected' && /Confira se digitou certo/.test(noBox.data.error), noBox);
check('...e ninguém recebe código nem ganha acesso por isso', isPending('naoexiste.caixa@exemplo.com') && count(`select count(*) from email_verifications where email = 'naoexiste.caixa@exemplo.com' and sent_at is not null`) === 0);

// ---- Corrida: cadastros simultâneos do mesmo e-mail ---------------------------------------------------------
const raceEmail = fresh('simultaneo');
const sameIp = new Client();
const burst = await Promise.all(Array.from({ length: 5 }, () => reg(sameIp, { email: raceEmail })));
check('5 cadastros simultâneos do mesmo e-mail: todos 202, uma única conta', burst.every((b) => b.status === 202) && count(`select count(*) from customers where email = ${lit(raceEmail)}`) === 1, burst.map((b) => b.status));
check('...e um único e-mail de confirmação (a espera de 60 s vale também para pedidos simultâneos)', (await mailsTo(raceEmail)).length === 1, (await mailsTo(raceEmail)).length);

// ------------------------------------------------------------------------------------------------------
section('TESTE 8 — Tentativas excessivas: bloqueio temporário');
const T = await signUp(new Client(), { email: fresh('tentativas') });
const ct = new Client();
const wrongT = T.code === '123456' ? '654321' : '123456';
const seen = [];
for (let i = 0; i < 5; i++) seen.push((await verify(ct, T.email, wrongT)).status);
check('5 códigos errados seguidos: 400 em todos', seen.every((s) => s === 400), seen);
const blocked = await verify(ct, T.email, T.code);
check('6ª tentativa — até com o código CERTO — é barrada: 429 too_many_attempts', blocked.status === 429 && blocked.data.code === 'too_many_attempts' && /novo código/.test(blocked.data.error), blocked);
check('banco: a conta continua pendente', isPending(T.email));
check('o código esgotado ficou inutilizado no banco (invalidated_at)', psql(`select invalidated_at is not null from email_verifications where email = ${lit(T.email)}`) === 't');
age(T.email);
await resend(new Client(), T.email);
const newCodeT = await lastCodeOf(T.email);
const afterResend = await verify(new Client(), T.email, newCodeT);
check('pedir um código novo (reenvio) libera: o código novo confirma', afterResend.status === 200 && isActive(T.email), afterResend);

// O banco também trava sozinho, sem depender do limitador da API (defesa em profundidade)
const W = await signUp(new Client(), { email: fresh('banco') });
const dbResults = [];
for (let i = 0; i < 5; i++) dbResults.push(psql(`select verify_email_code(${lit(W.email)}, ${lit(sha('x' + i))})`));
const dbRight = psql(`select verify_email_code(${lit(W.email)}, ${lit(codeHash(W.email, W.code))})`);
check('função do banco: 5 erros esgotam o código e o certo não passa mais (sem passar pela API)', dbResults.join(',') === 'invalid,invalid,invalid,invalid,locked' && dbRight !== 'ok' && isPending(W.email), [dbResults, dbRight]);

// Limite por rede (IP): erros espalhados por vários e-mails
const ipClient = new Client();
const ipStatus = [];
for (let i = 0; i < 31; i++) ipStatus.push((await verify(ipClient, `tentativa${i}@exemplo.com`, '999999')).status);
check('30 códigos errados de um mesmo IP (e-mails diferentes, existentes ou não): o 31º é barrado (429)', ipStatus.slice(0, 30).every((s) => s === 400) && ipStatus[30] === 429, ipStatus);
// Limite de cadastros por IP
const flood = new Client();
const floodStatus = [];
for (let i = 0; i < 7; i++) floodStatus.push((await reg(flood, { email: fresh('flood') })).status);
check('cadastros por IP: 6 por hora; o 7º recebe 429', floodStatus.slice(0, 6).every((s) => s === 202) && floodStatus[6] === 429, floodStatus);
check('...outro IP continua cadastrando normalmente', (await reg(new Client())).status === 202);
// Limite de pedidos de código por IP
const askIp = new Client();
const askStatus = [];
for (let i = 0; i < 13; i++) askStatus.push((await resend(askIp, `ninguem${i}@exemplo.com`)).status);
check('pedidos de reenvio por IP: 12 por hora; o 13º recebe 429', askStatus.slice(0, 12).every((s) => s === 200) && askStatus[12] === 429, askStatus);
// Injeção
const before8 = customers();
const evil = ["x'; drop table customers; --", "' or '1'='1", '\u0000', '%', '_', 'a'.repeat(5000)];
const evilBad = [];
for (const email of evil) {
  for (const [path, body] of [['/api/account/login', { email, password: 'x' }], ['/api/account/verify-email', { email, code: '123456' }], ['/api/account/resend-verification', { email }], ['/api/account/register', { name: 'x y', email, phone: '34999990000', password: PASS }]]) {
    const r = await new Client().post(path, body);
    if (r.status >= 500) evilBad.push([path, email.slice(0, 20), r.status]);
  }
}
check('entradas maliciosas (SQL, nulo, curingas, enormes) em login/confirmar/reenviar/cadastro: nenhum erro 500', evilBad.length === 0, evilBad);
check('...e a tabela de clientes segue intacta', customers() === before8);

// ------------------------------------------------------------------------------------------------------
section('TESTE 10 — E-mail confirmado: login e uso normal da conta');
const c10 = new Client();
const l10 = await registerVerified(c10, { name: 'Lia Confirmada', email: 'lia.confirmada@exemplo.com', phone: '34988881111', password: PASS });
check('cadastro → código → login: 200 com cookie', l10.status === 200 && Boolean(c10.cookie));
check('/me traz os dados da conta, sem campos internos', (await c10.get('/api/account/me')).data.customer?.name === 'Lia Confirmada' && !('password_hash' in (await c10.get('/api/account/me')).data.customer) && !('email_verified_at' in (await c10.get('/api/account/me')).data.customer));
const patch = await c10.patch('/api/account', { name: 'Lia Souza', address: 'Rua das Flores', address_number: '10', neighborhood: 'Centro', email: 'outro.email@exemplo.com' });
check('editar perfil funciona', patch.status === 200 && patch.data.customer.name === 'Lia Souza' && patch.data.customer.address === 'Rua das Flores', patch);
check('tentar trocar o e-mail pelo perfil é ignorado: o e-mail verificado não muda', patch.data.customer.email === 'lia.confirmada@exemplo.com' && count(`select count(*) from customers where email = 'outro.email@exemplo.com'`) === 0 && isActive('lia.confirmada@exemplo.com'));
const own = await c10.post('/api/orders', orderBody());
check('pedido feito logado: fica ligado à conta', own.status === 201 && psql(`select customer_id is not null from orders where order_number = ${own.data.order.order_number}`) === 't', own.data);
const list = await c10.get('/api/account/orders');
check('"Meus pedidos" lista o pedido', list.status === 200 && list.data.orders.some((o) => o.order_number === own.data.order.order_number), list.data);
check('detalhe do pedido da própria conta', (await c10.get(`/api/account/orders/${own.data.order.order_number}`)).status === 200);
const guest = new Client();
const gOrder = await guest.post('/api/orders', orderBody({ customer_phone: '(34) 98888-1111' }));
const claim = await c10.post('/api/account/orders/claim', { order_number: gOrder.data.order.order_number, code: gOrder.data.token });
check('vincular um pedido de visitante (código + telefone) funciona na conta confirmada', claim.status === 200, claim);
const pw = await c10.patch('/api/account/password', { current: PASS, next: 'nova-senha-4567' });
check('trocar a senha funciona', pw.status === 200);
check('senha antiga deixa de entrar; a nova entra', (await loginCustomer(new Client(), { email: 'lia.confirmada@exemplo.com', password: PASS })).status === 401 && (await loginCustomer(new Client(), { email: 'lia.confirmada@exemplo.com', password: 'nova-senha-4567' })).status === 200);
const out = await c10.post('/api/account/logout');
check('sair encerra a sessão: rotas protegidas voltam a 401', out.status === 200 && (await notDenied(c10)).length === 0);
const again = await loginCustomer(c10, { email: ' LIA.Confirmada@Exemplo.com ', password: 'nova-senha-4567' });
check('entrar de novo (e-mail com espaços e maiúsculas) funciona', again.status === 200 && (await c10.get('/api/account/me')).data.customer?.id !== undefined);
const adminList = await owner.get('/api/admin/customers?q=lia.confirmada');
const adminRow = adminList.data.customers.find((c) => c.email === 'lia.confirmada@exemplo.com');
check('painel: a conta aparece como active, com a data da confirmação', adminRow?.status === 'active' && Boolean(adminRow.email_verified_at), adminRow);
const pendingRow = (await owner.get(`/api/admin/customers?q=${encodeURIComponent('naoexiste.caixa')}`)).data.customers[0];
check('painel: conta nunca confirmada → pending_verification e email_verified_at nulo', pendingRow?.status === 'pending_verification' && pendingRow.email_verified_at === null, pendingRow);
const off = await owner.patch(`/api/admin/customers/${adminRow.id}`, { active: false });
check('painel desativa a conta: status disabled e a sessão cai', off.status === 200 && off.data.customer.status === 'disabled' && (await notDenied(c10)).length === 0, off.data);
check('conta desativada não entra (401 genérico)', (await loginCustomer(new Client(), { email: 'lia.confirmada@exemplo.com', password: 'nova-senha-4567' })).status === 401);
const on = await owner.patch(`/api/admin/customers/${adminRow.id}`, { active: true });
check('reativada, volta a entrar sem precisar confirmar de novo (a confirmação continua valendo)', on.data.customer.status === 'active' && (await loginCustomer(new Client(), { email: 'lia.confirmada@exemplo.com', password: 'nova-senha-4567' })).status === 200);
const c10c = new Client();
await loginCustomer(c10c, { email: 'lia.confirmada@exemplo.com', password: 'nova-senha-4567' });
const del = await c10c.req('DELETE', '/api/account', { password: 'nova-senha-4567' });
check('excluir a conta (com a senha) funciona e o login deixa de existir', del.status === 200 && (await loginCustomer(new Client(), { email: 'lia.confirmada@exemplo.com', password: 'nova-senha-4567' })).status === 401 && customersWith('lia.confirmada@exemplo.com') === 0);

// ------------------------------------------------------------------------------------------------------
section('Extras — anti-enumeração, cadastro repetido e contas pendentes');
const V = await signUp(new Client(), { email: fresh('dona'), name: 'Dona Original', password: PASS });
await verify(new Client(), V.email, V.code);
const newR = await reg(new Client(), { email: fresh('nova') });
const pendR = await reg(new Client(), { email: U1.email });
const verR = await reg(new Client(), { email: V.email, name: 'Intruso', password: 'senha-do-intruso-1' });
const strip = (r) => JSON.stringify({ ...r.data, email: 'E', email_masked: 'M' });
check('cadastro de e-mail novo, pendente ou já confirmado: a MESMA resposta (só o e-mail muda)', [newR, pendR, verR].every((r) => r.status === 202) && strip(newR) === strip(pendR) && strip(pendR) === strip(verR), [newR.data, pendR.data, verR.data]);
const mails = await mailsTo(V.email);
check('quem já tem conta recebe só um aviso na própria caixa (sem código nem link de confirmação)', mails.length === 2 && /Você já tem uma conta/.test(mails[1].subject) && !/verificar\//.test(mails[1].text) && !/código de confirmação/.test(mails[1].subject), mails.map((m) => m.subject));
await reg(new Client(), { email: V.email });
check('o aviso é limitado a 1 por hora por endereço', (await mailsTo(V.email)).length === 2);
check('o cadastro repetido NÃO sobrescreve a conta confirmada (senha antiga entra, a nova não)', (await loginCustomer(new Client(), { email: V.email, password: PASS })).status === 200 && (await loginCustomer(new Client(), { email: V.email, password: 'senha-do-intruso-1' })).status === 401 && psql(`select name from customers where email = ${lit(V.email)}`) === 'Dona Original');
check('...e não gera código nenhum para a conta confirmada', count(`select count(*) from email_verifications where email = ${lit(V.email)}`) === 1);

const P = await signUp(new Client(), { email: fresh('reivindica'), password: 'primeira-senha-111', name: 'Primeiro' });
age(P.email);
const P2 = await signUp(new Client(), { email: P.email, password: 'segunda-senha-222', name: 'Segundo' });
check('cadastro repetido de e-mail ainda pendente: vale o último (dados novos), com código novo', P2.r.status === 202 && psql(`select name from customers where email = ${lit(P.email)}`) === 'Segundo' && (await mailsTo(P.email)).length === 2);
check('quem prova o acesso à caixa é quem fica com a conta (o código antigo não vale)', P.code === P2.code || (await verify(new Client(), P.email, P.code)).status === 400);
await verify(new Client(), P.email, P2.code);
check('a senha do primeiro cadastro não entra; a do último entra', (await loginCustomer(new Client(), { email: P.email, password: 'primeira-senha-111' })).status === 401 && (await loginCustomer(new Client(), { email: P.email, password: 'segunda-senha-222' })).status === 200);

const X = await signUp(new Client(), { email: fresh('cru'), name: '<img src=x onerror=alert(1)>Bia\r\nBcc: hacker@evil.com' });
check('nome com HTML e quebra de linha: o e-mail HTML escapa e nenhum cabeçalho extra (Bcc) é injetado', X.r.status === 202 && !/<img src=x/i.test(X.mail.html) && !X.mail.headers.bcc && X.mail.to.length === 1 && !/hacker@evil\.com/.test(JSON.stringify(X.mail.headers)), [X.mail.headers.bcc, X.mail.to]);

// Contas que nunca confirmaram são apagadas depois do prazo (a menos que já tenham pedidos)
const stale = await signUp(new Client(), { email: fresh('velha') });
const staleWithOrder = await signUp(new Client(), { email: fresh('velhacompedido') });
const lonely = psql(`select id from customers where email = ${lit(stale.email)}`);
const kept = psql(`select id from customers where email = ${lit(staleWithOrder.email)}`);
const keptOrder = await new Client().post('/api/orders', orderBody());
psql(`update orders set customer_id = '${kept}' where order_number = ${keptOrder.data.order.order_number}`);
psql(`update customers set verify_by = now() - interval '1 day' where id in ('${lonely}', '${kept}')`);
psql('select purge_expired_data()');
check('limpeza: conta pendente vencida e sem pedidos é apagada; com pedidos fica', count(`select count(*) from customers where id = '${lonely}'`) === 0 && count(`select count(*) from customers where id = '${kept}'`) === 1);
check('limpeza não apaga conta confirmada nem pendente dentro do prazo', isActive(email1) && isPending(W.email));

summary();
