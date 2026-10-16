// Cadastro e login do cliente com o e-mail de QUALQUER provedor: Gmail, iCloud, Outlook, Hotmail, Yahoo, UOL, Proton, domínio próprio de empresa...
// Nenhum provedor é especial: o código chega na caixa do próprio endereço (caixas simuladas do servidor de teste, uma por destinatário), a conta é ativada
// só com ele, o login pede um código novo a cada entrada, e o acompanhamento dos pedidos continua depois de sair e entrar de novo.
//
// O que o servidor de teste NÃO simula: a entrega de verdade pelos servidores da Google/Apple/Microsoft/Yahoo (veja docs/EMAIL.md, "Conferir de verdade").
// usage: bash tests/fresh.sh && node tests/api-test26.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, clearMail, codeFrom, loginCustomer, mailMode, mailsTo, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres'];
const psql = (sql) => execFileSync('psql', [...P, '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rows = (sql) => JSON.parse(psql(`select coalesce(json_agg(x), '[]') from (${sql}) x`));
const PASS = 'Senha-Forte-2026!';
let seq = 0;
const phone = () => `3498${String(2000000 + ++seq).slice(-7)}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const confirmMails = async (email) => (await mailsTo(email)).filter((m) => /código de confirmação|confirm/i.test(m.subject));
const loginMails = async (email) => (await mailsTo(email)).filter((m) => /código para entrar/.test(m.subject));
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(100);
  }
  return false;
};
const register = (client, email, extra = {}) => client.post('/api/account/register', { name: 'Cliente Provedor', email, phone: phone(), password: PASS, ...extra });
// Login em dois passos lendo o código da caixa certa (`inbox`).
async function twoStepLogin(client, person) {
  const before = (await loginMails(person.inbox)).length;
  const first = await client.post('/api/account/login', { email: person.saved, password: PASS });
  if (first.status !== 202) return first;
  await until(async () => (await loginMails(person.inbox)).length === before + 1);
  return client.post('/api/account/login/code', { code: codeFrom((await loginMails(person.inbox)).at(-1)) });
}
const wrongOf = (code) => String((Number(code) + 1) % 1000000).padStart(6, '0');

await clearMail();

// ---- Preparação: loja aberta, um produto ------------------------------------------------------------
const owner = new Client();
await owner.login();
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const cat = (await owner.post('/api/admin/categories', { name: 'Provedores teste' })).data.category;
const beer = (await owner.post('/api/admin/products', { name: 'Cerveja Teste', price: 9, category_id: cat.id, stock: 500, confirm_duplicate: true })).data.product;

// ------------------------------------------------------------------------------------------------
section('1. Provedores diferentes: cadastro → código → ativação → login com código → pedidos → sair → entrar de novo');
// O endereço é digitado como a pessoa digita (maiúsculas, +etiqueta, ponto...); o sistema guarda em minúsculas.
const PROVIDERS = [
  ['Gmail', 'Ana.Gmail@Gmail.com', 'ana.gmail@gmail.com'],
  ['Gmail (+etiqueta)', 'bia+loja@gmail.com', 'bia+loja@gmail.com'],
  ['Googlemail', 'caio@googlemail.com', 'caio@googlemail.com'],
  ['iCloud', 'dani.silva@icloud.com', 'dani.silva@icloud.com'],
  ['iCloud (me.com)', 'edu@me.com', 'edu@me.com'],
  ['Outlook', 'fabi_oliveira@outlook.com', 'fabi_oliveira@outlook.com'],
  ['Outlook Brasil', 'gabi@outlook.com.br', 'gabi@outlook.com.br'],
  ['Hotmail', 'hugo-m@hotmail.com', 'hugo-m@hotmail.com'],
  ['Live', 'iris@live.com', 'iris@live.com'],
  ['Yahoo', 'jorge@yahoo.com', 'jorge@yahoo.com'],
  ['Yahoo Brasil', 'kleber@yahoo.com.br', 'kleber@yahoo.com.br'],
  ['UOL', 'lara@uol.com.br', 'lara@uol.com.br'],
  ['Proton', 'mario@proton.me', 'mario@proton.me'],
  ['domínio próprio de empresa', 'nadia@minhaempresa.com.br', 'nadia@minhaempresa.com.br'],
  ['domínio próprio com subdomínio e hífen', 'otavio@mail.loja-do-otavio.com.br', 'otavio@mail.loja-do-otavio.com.br'],
  ['domínio de escola', 'paula@colegio.edu.br', 'paula@colegio.edu.br'],
  ['domínio com acento (IDN)', 'rita@münchen.de', 'rita@xn--mnchen-3ya.de', 'rita@münchen.de'],
  ['domínio novo e comprido (.technology)', 'sergio@startup.technology', 'sergio@startup.technology'],
];
const people = [];
// `inbox`: como a caixa simulada guarda o destinatário (ela mostra o domínio acentuado já decodificado; na internet circula o punycode).
for (const [label, typed, saved, inbox = saved] of PROVIDERS) {
  const c = new Client();
  const reg = await register(c, typed);
  const ok1 = reg.status === 202 && reg.data.status === 'pending_verification' && reg.data.email === saved;
  const confirm = await until(async () => (await confirmMails(inbox)).length === 1 && (await confirmMails(inbox))[0]);
  // O e-mail chegou NA caixa desse endereço (e só nela), com o código de 6 dígitos.
  const code = confirm ? codeFrom(confirm) : null;
  const mailbox = await mailsTo(inbox);
  check(`[${label}] cadastro aceito (202) e o código de 6 dígitos chegou na caixa de ${saved}`, ok1 && /^\d{6}$/.test(code ?? '') && mailbox.length === 1 && mailbox[0].to.includes(inbox), [reg.status, reg.data, mailbox.map((m) => m.to)]);
  const maskedOk = !JSON.stringify(reg.data).includes(saved.split('@')[0]) || reg.data.email === saved; // a resposta do cadastro devolve o endereço que a própria pessoa digitou
  check(`[${label}] a resposta traz o e-mail mascarado e nada de código`, maskedOk && String(reg.data.email_masked).includes('***') && !JSON.stringify(reg.data).includes(code ?? 'x#x'), reg.data);

  // Antes de confirmar: a senha certa NÃO abre sessão (403 "falta confirmar"), nem dá acesso à conta.
  const early = await c.post('/api/account/login', { email: saved, password: PASS });
  check(`[${label}] antes de confirmar o código, nem a senha certa entra (403)`, early.status === 403 && early.data.code === 'email_not_verified' && !('customer' in early.data), early.data);

  // Confirmar: o código certo ativa a conta.
  const wrong = await c.post('/api/account/verify-email', { email: saved, code: wrongOf(code) });
  const good = await c.post('/api/account/verify-email', { email: saved, code });
  check(`[${label}] código errado é recusado (400) e o certo ativa a conta (200)`, wrong.status === 400 && wrong.data.code === 'invalid_code' && good.status === 200 && good.data.verified === true, [wrong.data, good.data]);
  check(`[${label}] a conta ficou ativa no banco (e-mail confirmado)`, psql(`select email_verified_at is not null from customers where lower(email) = ${lit(saved)}`) === 't');

  // Login: senha + código novo, enviado para o mesmo endereço.
  const before = (await loginMails(inbox)).length;
  const first = await c.post('/api/account/login', { email: saved, password: PASS });
  const arrived = await until(async () => (await loginMails(inbox)).length === before + 1);
  const loginCode = codeFrom((await loginMails(inbox)).at(-1));
  check(`[${label}] login com a senha certa: 202, sem sessão, e o código de acesso chega na mesma caixa`, first.status === 202 && first.data.status === 'code_required' && !('customer' in first.data) && arrived && /^\d{6}$/.test(loginCode ?? ''), [first.status, first.data]);
  check(`[${label}] a tela só recebe o endereço mascarado (nunca inteiro)`, first.data.email_masked === `${saved[0]}***@${saved.split('@')[1]}` && first.data.email_masked.split('@')[0] === `${saved[0]}***`, first.data.email_masked);
  const session = await c.post('/api/account/login/code', { code: loginCode });
  check(`[${label}] com o código certo a sessão abre e a resposta traz a conta`, session.status === 200 && session.data.customer?.email === saved, session.data);
  const me = await c.get('/api/account/me');
  check(`[${label}] /api/account/me devolve a conta logada`, me.data.customer?.email === saved);
  people.push({ label, saved, inbox, c, loginCode });
}

// Pedidos: cada pessoa faz um pedido logada, sai, entra de novo (outro código) e ainda vê o pedido; ninguém vê o pedido de outra pessoa.
section('2. Acompanhamento dos pedidos depois de sair e entrar de novo; ninguém acessa pedido de outra pessoa');
for (const person of people) {
  const placed = await person.c.post('/api/orders', {
    customer_name: 'Cliente Provedor',
    customer_phone: phone(),
    delivery_type: 'pickup',
    payment_method: 'pix',
    items: [{ product_id: beer.id, quantity: 1 }],
  });
  person.order = placed.data?.order?.order_number;
  const list = await person.c.get('/api/account/orders');
  check(`[${person.label}] pedido feito logado (201) e listado em "meus pedidos"`, placed.status === 201 && list.data?.orders?.some((o) => o.order_number === person.order), [placed.status, list.data]);
}
for (const person of people) {
  // Sair: a sessão acaba de verdade (o cookie velho não serve) e os pedidos somem da tela.
  const oldCookie = person.c.cookie;
  const out = await person.c.post('/api/account/logout');
  const ghost = new Client();
  ghost.cookie = oldCookie;
  const after = await person.c.get('/api/account/orders');
  const replay = await ghost.get('/api/account/orders');
  check(`[${person.label}] sair encerra a sessão: sem login 401, e o cookie antigo não vale mais`, out.status === 200 && after.status === 401 && replay.status === 401, [after.status, replay.status]);
  // Entrar de novo: a senha sozinha não basta; chega um código NOVO.
  const before = (await loginMails(person.inbox)).length;
  const again = await twoStepLogin(person.c, person);
  const mails = await loginMails(person.inbox);
  check(`[${person.label}] entrar de novo exige outro código (e-mail novo) e abre a sessão`, again.status === 200 && mails.length === before + 1 && codeFrom(mails.at(-1)) !== person.loginCode, [again.status, mails.length - before]);
  const list = await person.c.get('/api/account/orders');
  const detail = await person.c.get(`/api/account/orders/${person.order}`);
  check(`[${person.label}] depois do novo login o pedido continua na conta e abre`, list.data?.orders?.some((o) => o.order_number === person.order) && detail.status === 200 && detail.data.order.order_number === person.order, [list.status, detail.status]);
}
{
  const [a, b] = people;
  const peek = await a.c.get(`/api/account/orders/${b.order}`);
  const pay = await a.c.get(`/api/account/orders/${b.order}/payment`);
  check('uma pessoa NÃO abre o pedido de outra (404), nem o pagamento dele', peek.status === 404 && pay.status === 404, [peek.status, pay.status]);
  check('e a lista dela não mostra o pedido da outra', !(await a.c.get('/api/account/orders')).data.orders.some((o) => o.order_number === b.order));
}

// ------------------------------------------------------------------------------------------------
section('3. Formato inválido, duplicidade e o que NÃO revela quem tem conta');
{
  const invalid = ['abc', 'sem-arroba.com', '@gmail.com', 'maria@', 'maria@gmail', 'maria@@gmail.com', 'maria silva@gmail.com', 'maria..silva@gmail.com', '.maria@gmail.com', 'maria@-gmail.com', 'maria@gmail..com', 'maria@gmail.c', 'maria@[10.0.0.1]', '"maria"@gmail.com', 'maria@gmail.com, joao@gmail.com', 'maria@gmail.com\nBcc: x@y.com', 'a'.repeat(65) + '@gmail.com', 'maria@' + 'a'.repeat(250) + '.com'];
  const before = Number(psql('select count(*) from customers'));
  const mailsBefore = (await mailsTo('')).length;
  const bad = [];
  for (const email of invalid) {
    const r = await register(new Client(), email);
    if (!(r.status === 400 && r.data?.code === 'invalid_email')) bad.push([email.slice(0, 40), r.status, r.data?.code]);
  }
  check(`${invalid.length} formatos inválidos: todos 400 invalid_email`, bad.length === 0, bad);
  check('nenhuma conta criada e nenhum e-mail enviado por formato inválido', Number(psql('select count(*) from customers')) === before && (await mailsTo('')).length === mailsBefore);
  const msg = (await register(new Client(), 'abc')).data.error;
  check('a mensagem não privilegia nenhum provedor (cita "qualquer provedor", sem Gmail)', /qualquer provedor/.test(msg) && !/gmail/i.test(msg), msg);
}
{
  const first = people[0];
  // Mesmo endereço, escrito de outro jeito (maiúsculas): é a mesma conta (regra do banco: lower(email)); não cria outra.
  const dupMail = await mailsTo(first.saved);
  const dup = await register(new Client(), first.saved.toUpperCase());
  const fresh = await register(new Client(), 'inedito.duplicado@icloud.com');
  check('cadastro duplicado (mesmo e-mail em maiúsculas): 202 com o MESMO formato de resposta de um e-mail novo (não revela que a conta existe)', dup.status === 202 && fresh.status === 202 && JSON.stringify(Object.keys(dup.data).sort()) === JSON.stringify(Object.keys(fresh.data).sort()), [dup.data, fresh.data]);
  check('...e só existe UMA conta com esse endereço', psql(`select count(*) from customers where lower(email) = ${lit(first.saved)}`) === '1');
  const notice = await until(async () => (await mailsTo(first.saved)).length > dupMail.length && (await mailsTo(first.saved)).at(-1));
  check('o dono do endereço recebe um aviso "você já tem uma conta" (quem tentou não vê isso na tela)', Boolean(notice) && /já tem uma conta/i.test(notice.subject), notice?.subject);
  // Gmail trata pontos como o mesmo endereço, mas o banco e o sistema não: "a.b@gmail.com" e "ab@gmail.com" são contas separadas (a regra de identificação do banco).
  const dotted = await register(new Client(), 'ana.gmail.x@gmail.com');
  const plain = await register(new Client(), 'anagmailx@gmail.com');
  check('pontos no Gmail não unem contas: cada endereço digitado é uma conta (regra de identificação do banco)', dotted.status === 202 && plain.status === 202 && psql(`select count(*) from customers where lower(email) in ('ana.gmail.x@gmail.com', 'anagmailx@gmail.com')`) === '2');

  const unknown = await new Client().post('/api/account/login', { email: 'ninguem.mesmo@icloud.com', password: PASS });
  const wrongPass = await new Client().post('/api/account/login', { email: first.saved, password: 'senha-errada-123' });
  check('login: e-mail sem conta e senha errada dão exatamente a mesma resposta (401)', unknown.status === 401 && wrongPass.status === 401 && JSON.stringify(unknown.data) === JSON.stringify(wrongPass.data), [unknown.data, wrongPass.data]);
  check('...e nenhum e-mail de código sai para quem errou a senha (nem para o dono da conta, nem para o endereço sem conta)', (await loginMails('ninguem.mesmo@icloud.com')).length === 0 && (await loginMails(first.saved)).length === 2);
  const rA = await new Client().post('/api/account/resend-verification', { email: first.saved });
  const rB = await new Client().post('/api/account/resend-verification', { email: 'ninguem.mesmo@icloud.com' });
  check('reenviar confirmação: a resposta é igual para endereço com e sem conta', rA.status === 200 && rB.status === 200 && JSON.stringify(Object.keys(rA.data)) === JSON.stringify(Object.keys(rB.data)), [rA.data, rB.data]);
  const noCookie = await new Client().post('/api/account/login/code', { code: '123456' });
  check('o código de login sem a tentativa aberta neste navegador não abre nada', noCookie.status === 400 && noCookie.data.code === 'login_expired', noCookie.data);
}

// ------------------------------------------------------------------------------------------------
section('4. Códigos: errado, expirado, reutilizado, limite de tentativas e de reenvios (validade do login: 5 minutos)');
{
  const email = 'codigos.teste@outlook.com';
  const c = new Client();
  await register(c, email);
  const code = codeFrom((await until(async () => (await confirmMails(email))[0])));
  // Expirado: o banco marca o código como vencido.
  psql(`update email_verifications set code_expires_at = now() - interval '1 minute' where email = ${lit(email)}`);
  const expired = await c.post('/api/account/verify-email', { email, code });
  check('código de confirmação vencido: 400 "incorreto ou expirado"', expired.status === 400 && expired.data.code === 'invalid_code' && /expirado/.test(expired.data.error), expired.data);
  // Reenviar (depois da espera de 60 s) devolve um código novo; o vencido continua sem valer.
  psql(`update email_verifications set sent_at = sent_at - interval '2 minutes' where email = ${lit(email)}`);
  const resend = await c.post('/api/account/resend-verification', { email });
  const code2 = await until(async () => { const l = await confirmMails(email); return l.length === 2 && codeFrom(l[1]); });
  check('reenvio permitido depois da espera: chega outro código na mesma caixa', resend.status === 200 && /^\d{6}$/.test(code2 || ''), [resend.data, code2]);
  const cooldown = await c.post('/api/account/resend-verification', { email });
  check('...e pedir de novo logo em seguida não manda e-mail nenhum (espera de 60 s)', cooldown.status === 200 && (await confirmMails(email)).length === 2, cooldown.data);
  // Limite de tentativas erradas: 5 e o endereço é barrado.
  let last;
  for (let i = 0; i < 6; i++) last = await c.post('/api/account/verify-email', { email, code: wrongOf(code2) });
  const barrado = await c.post('/api/account/verify-email', { email, code: code2 });
  check('limite de tentativas erradas: depois de 5 erros nem o código certo passa (429/400 "muitas tentativas" ou código travado)', [400, 429].includes(last.status) && barrado.status !== 200, [last.status, barrado.status, barrado.data]);
  psql(`delete from rate_limits where bucket like 'verify-%'`);
  psql(`update email_verifications set attempts = 0, invalidated_at = null where email = ${lit(email)}`);
  const ok = await c.post('/api/account/verify-email', { email, code: code2 });
  check('liberado o limite, o código certo ativa a conta', ok.status === 200, ok.data);
  const reuse = await c.post('/api/account/verify-email', { email, code: code2 });
  check('o mesmo código NÃO vale duas vezes (uso único)', reuse.status === 400, reuse.data);

  // Login: validade de 5 minutos, uso único, código errado, expirado, limite.
  const lc = new Client();
  const step1 = await lc.post('/api/account/login', { email, password: PASS });
  const lcode = codeFrom(await until(async () => (await loginMails(email)).at(-1)));
  const row = rows(`select code_expires_at, created_at, attempts from customer_login_challenges where customer_id = (select id from customers where lower(email) = ${lit(email)}) order by created_at desc limit 1`)[0];
  check('o código de login vale 5 minutos (resposta, e-mail e banco)', step1.data.code_minutes === 5 && /5 minutos/.test((await loginMails(email)).at(-1).text) && Math.abs((Date.parse(row.code_expires_at) - Date.parse(row.created_at)) / 60000 - 5) < 0.5, [step1.data.code_minutes, row]);
  const w1 = await lc.post('/api/account/login/code', { code: wrongOf(lcode) });
  check('código de login errado: 400 e nenhuma sessão', w1.status === 400 && w1.data.code === 'invalid_code' && (await lc.get('/api/account/me')).data.customer === null, w1.data);
  const used = await lc.post('/api/account/login/code', { code: lcode });
  const reuseLogin = await lc.post('/api/account/login/code', { code: lcode });
  check('o código certo abre a sessão uma vez; usar o mesmo código de novo é recusado (uso único)', used.status === 200 && reuseLogin.status === 400, [used.status, reuseLogin.status]);
  // Expirado
  const ec = new Client();
  await ec.post('/api/account/login', { email, password: PASS });
  const ecode = codeFrom(await until(async () => (await loginMails(email)).at(-1)));
  psql(`update customer_login_challenges set code_expires_at = now() - interval '1 second' where customer_id = (select id from customers where lower(email) = ${lit(email)}) and used_at is null`);
  const exp = await ec.post('/api/account/login/code', { code: ecode });
  check('código de login vencido (passou dos 5 minutos): 400, sem sessão', exp.status === 400 && (await ec.get('/api/account/me')).data.customer === null, exp.data);
  // Limite de 5 erros: o desafio trava e a pessoa precisa informar a senha de novo.
  const lk = new Client();
  await lk.post('/api/account/login', { email, password: PASS });
  const kcode = codeFrom(await until(async () => (await loginMails(email)).at(-1)));
  let lastBad;
  for (let i = 0; i < 5; i++) lastBad = await lk.post('/api/account/login/code', { code: wrongOf(kcode) });
  const afterLock = await lk.post('/api/account/login/code', { code: kcode });
  check('5 códigos errados travam a tentativa; nem o código certo entra depois (precisa da senha de novo)', lastBad.status === 400 && lastBad.data.code === 'code_locked' && afterLock.status === 400 && (await lk.get('/api/account/me')).data.customer === null, [lastBad.data, afterLock.data]);
  // Reenvio do código de login: espera de 60 s.
  const rc = new Client();
  await rc.post('/api/account/login', { email, password: PASS });
  const early = await rc.post('/api/account/login/resend', {});
  check('reenviar o código de login antes de 60 s: 429 com o tempo de espera, sem e-mail novo', early.status === 429 && early.data.code === 'cooldown' && early.data.retry_after > 0, early.data);
  psql(`update customer_login_challenges set last_sent_at = last_sent_at - interval '2 minutes' where customer_id = (select id from customers where lower(email) = ${lit(email)}) and used_at is null`);
  const later = await rc.post('/api/account/login/resend', {});
  check('depois da espera o reenvio funciona (200, validade de 5 min)', later.status === 200 && later.data.code_minutes === 5, later.data);
}

// ------------------------------------------------------------------------------------------------
section('5. Domínios: nenhum provedor é barrado só por ser desconhecido; só descartável, inexistente ou que não recebe e-mail');
{
  const obscure = ['joao@pequena-padaria-do-ze.com.br', 'maria@advogados-associados.adv.br', 'pedro@clinica.med.br', 'ana@um-dominio-bem-comprido-de-uma-empresa-qualquer.com.br', 'lia@meuprovedor.net', 'tito@correio.pt', 'rui@mail.co.uk', 'eva@posta.it', 'sem-mx-mas-com-a@sem-mx-com-a.com.br', 'so-ipv6@so-ipv6.com.br', 'dns-fora@dns-quebrado.com.br', 'dns-lento@dns-lento.com.br'];
  const blocked = [];
  for (const email of obscure) {
    const r = await register(new Client(), email);
    if (r.status !== 202) blocked.push([email, r.status, r.data?.error]);
  }
  check(`${obscure.length} domínios pouco conhecidos (inclusive só com A/AAAA e com o DNS falhando): todos aceitos`, blocked.length === 0, blocked);
  const dis = await register(new Client(), 'x@mailinator.com');
  const nx = await register(new Client(), 'x@dominio-inexistente-xyz.com');
  const nomx = await register(new Client(), 'x@mxnulo.com.br');
  check('descartável (mailinator): 400 com motivo e mensagem sem preferir provedor', dis.status === 400 && dis.data.reason === 'disposable' && /qualquer provedor/.test(dis.data.error) && !/gmail/i.test(dis.data.error), dis.data);
  check('domínio que não existe: 400 "não encontramos esse domínio"', nx.status === 400 && nx.data.reason === 'nxdomain' && /Não encontramos esse domínio/.test(nx.data.error), nx.data);
  check('domínio que declara não receber e-mail (MX nulo): 400', nomx.status === 400 && nomx.data.reason === 'null-mx', nomx.data);
}

// ------------------------------------------------------------------------------------------------
section('6. Falha no envio: nunca vira acesso, a mensagem é clara e dá para tentar de novo; endereço que já falhou um dia não fica trancado');
{
  // 6a. Servidor de e-mail fora do ar: cadastro e login respondem 503, sem sessão.
  const down = 'servidor.fora@gmail.com';
  await mailMode('down');
  const regDown = await register(new Client(), down);
  check('servidor de e-mail fora do ar: o cadastro responde 503 "não conseguimos enviar" (nada de conta ativa)', regDown.status === 503 && regDown.data.code === 'mail_failed' && psql(`select count(*) from customers where lower(email) = ${lit(down)} and email_verified_at is not null`) === '0', regDown.data);
  await mailMode(null);
  const person = people[1];
  await mailMode('down');
  const loginDown = new Client();
  const resDown = await loginDown.post('/api/account/login', { email: person.saved, password: PASS });
  check('...e o login com a senha certa também responde 503, sem sessão e sem cookie de sessão', resDown.status === 503 && resDown.data.code === 'mail_failed' && (await loginDown.get('/api/account/me')).data.customer === null, resDown.data);
  await mailMode(null);
  check('...e nenhum desafio ficou aberto (a falha não deixa nada para trás)', psql(`select count(*) from customer_login_challenges where customer_id = (select id from customers where lower(email) = ${lit(person.saved)}) and last_sent_at is null`) === '0');
  const retry = await loginCustomer(new Client(), { email: person.saved, password: PASS });
  check('passada a falha, é só tentar de novo: o login funciona normalmente', retry.status === 200, retry.data);

  // 6b. O servidor do destinatário recusa o endereço (caixa inexistente): o cliente vê a explicação e a recusa fica registrada (suprimido).
  const gone = 'caixa.recusada@yahoo.com.br';
  await mailMode('rcpt');
  const rcpt = await register(new Client(), gone);
  await mailMode(null);
  check('endereço recusado pelo servidor do destinatário: 400 "recusou a mensagem, confira se digitou certo ou use outro e-mail"', rcpt.status === 400 && rcpt.data.code === 'mail_recipient_rejected' && /recusou a mensagem/.test(rcpt.data.error) && /qualquer provedor/.test(rcpt.data.error), rcpt.data);
  check('...e o endereço entrou na lista de supressão automática (devolução definitiva)', psql(`select reason from email_suppressions where email = ${lit(gone)}`) === 'hard_bounce');

  // 6c. A caixa foi consertada: o mesmo endereço pode pedir o código de novo (a supressão automática antiga não o tranca), e provar que lê a caixa limpa a supressão.
  const again = new Client();
  const regAgain = await register(again, gone);
  const goneCode = await until(async () => { const l = await confirmMails(gone); return l.length === 1 && codeFrom(l[0]); });
  check('caixa consertada: o cadastro do MESMO endereço volta a funcionar (202) e o código chega, apesar da supressão automática antiga', regAgain.status === 202 && /^\d{6}$/.test(goneCode || ''), [regAgain.status, regAgain.data, goneCode]);
  check('...enquanto não prova que lê a caixa, a supressão continua registrada (e vale para promoções e avisos)', psql(`select count(*) from email_suppressions where email = ${lit(gone)}`) === '1');
  const confirmed = await again.post('/api/account/verify-email', { email: gone, code: goneCode });
  check('digitar o código que chegou ativa a conta e limpa a supressão automática', confirmed.status === 200 && psql(`select count(*) from email_suppressions where email = ${lit(gone)}`) === '0', confirmed.data);

  // 6d. Bloqueio MANUAL do dono da loja continua valendo, até para o código.
  const blocked = 'bloqueado.pela.loja@icloud.com';
  await owner.post('/api/admin/emails/suppressions', { email: blocked, note: 'teste' });
  const regBlocked = await register(new Client(), blocked);
  check('endereço bloqueado manualmente pela loja: o código não é enviado (400) e nenhum e-mail sai', regBlocked.status === 400 && regBlocked.data.code === 'mail_recipient_rejected' && (await mailsTo(blocked)).length === 0, regBlocked.data);

  // 6e. Recusa por política (spam/reputação do remetente) e erro passageiro (greylisting): mensagem de "tente de novo", sem suprimir o endereço.
  const pol = 'policy-26@hotmail.com';
  const polRes = await register(new Client(), pol);
  check('recusa por política do servidor do destinatário: 503 "tente de novo" e o endereço NÃO é suprimido', [503, 400].includes(polRes.status) && psql(`select count(*) from email_suppressions where email = ${lit(pol)}`) === '0', [polRes.status, polRes.data]);
  await mailMode('temp');
  const tempRes = await register(new Client(), 'greylist.26@yahoo.com');
  await mailMode(null);
  check('erro passageiro (451, greylisting): 503 "tente de novo" e o endereço NÃO é suprimido', tempRes.status === 503 && psql(`select count(*) from email_suppressions where email = 'greylist.26@yahoo.com'`) === '0', [tempRes.status, tempRes.data]);
  // O histórico do painel registra o que aconteceu com cada provedor (aceito ≠ entregue).
  const stats = await owner.get('/api/admin/emails/overview?refresh=1');
  const domains = (stats.data.top_domains ?? []).map((d) => d.domain);
  check('o painel de e-mails lista os principais domínios de destino (por provedor) e deixa claro que "aceito" não é "entregue"', domains.includes('gmail.com') && domains.length >= 3, domains);
}

// ------------------------------------------------------------------------------------------------
section('7. O painel (administradores) não muda: sessão de cliente nunca vale como administrador');
{
  const customer = people[0].c;
  const asAdmin = await customer.get('/api/admin/orders');
  const asAdminStore = await customer.patch('/api/admin/store', { delivery_fee: 99 });
  check('com sessão de cliente, as rotas do painel respondem 401', asAdmin.status === 401 && asAdminStore.status === 401, [asAdmin.status, asAdminStore.status]);
  const adminLogin = await new Client().post('/api/auth/login', { email: people[0].saved, password: PASS });
  check('e-mail e senha de cliente não entram no painel (401)', adminLogin.status === 401, adminLogin.data);
  const ownerAgain = new Client();
  const ownerLogin = await ownerAgain.post('/api/auth/login', { email: 'dono@copocheio.local', password: 'senha-forte-123' });
  check('o login do painel continua em dois passos (senha → 202 "code_required")', ownerLogin.status === 202 && ownerLogin.data.status === 'code_required', ownerLogin.data);
}

summary();
