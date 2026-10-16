// Modos de falha do ambiente: e-mail NÃO configurado e DNS inteiro fora do ar.
// Reinicia o servidor de teste com cada configuração e, no fim, devolve o servidor ao normal.
// usage: bash tests/fresh.sh && node tests/api-test5-modes.mjs
import { execFileSync, execSync } from 'node:child_process';
import { Client, check, codeFrom, mailsTo, section, summary } from './lib.mjs';

const psql = (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-c', sql], { encoding: 'utf8' }).trim();
const serve = (env = {}) => execSync(`bash ${new URL('./serve.sh', import.meta.url).pathname}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const PASS = 'senha-boa-123';

// ---- servidor normal: prepara uma conta pendente e uma confirmada -------------------------------------
serve();
const pendingClient = new Client();
const pend = await pendingClient.post('/api/account/register', { name: 'Pia Pendente', email: 'pia.pendente@exemplo.com', phone: '34999990000', password: PASS });
check('(preparação) conta pendente criada com o e-mail funcionando', pend.status === 202);
const okClient = new Client();
const okReg = await okClient.post('/api/account/register', { name: 'Vera Verificada', email: 'vera.verificada@exemplo.com', phone: '34999991111', password: PASS });
const okCode = codeFrom((await mailsTo('vera.verificada@exemplo.com')).at(-1));
check('(preparação) conta confirmada', okReg.status === 202 && (await okClient.post('/api/account/verify-email', { email: 'vera.verificada@exemplo.com', code: okCode })).status === 200);

// ---------------------------------------------------------------------------------------------------
section('Envio de e-mail NÃO configurado (faltam SMTP_HOST, SMTP_USER, SMTP_PASS)');
serve({ MAIL_MODE: 'none' });
const c = new Client();
const health = await c.get('/api/health');
check('/api/health informa mail: missing', health.status === 200 && health.data.mail === 'missing', health.data);
const before = psql('select count(*) from customers');
const r = await c.post('/api/account/register', { name: 'Sem Email', email: 'sem.email@exemplo.com', phone: '34999992222', password: PASS });
check('cadastro: 503 mail_not_configured com mensagem clara (nada de "conta criada" sem poder confirmar)', r.status === 503 && r.data.code === 'mail_not_configured' && /sem conta/.test(r.data.error), r);
check('...e nenhuma conta é criada', psql('select count(*) from customers') === before && psql(`select count(*) from customers where email = 'sem.email@exemplo.com'`) === '0');
const rs = await c.post('/api/account/resend-verification', { email: 'pia.pendente@exemplo.com' });
check('reenvio: 503 mail_not_configured', rs.status === 503 && rs.data.code === 'mail_not_configured', rs);
const lp = await new Client().post('/api/account/login', { email: 'pia.pendente@exemplo.com', password: PASS });
check('login de conta pendente: 403 email_not_verified, avisando que o envio está indisponível, sem sessão, sem erro 500', lp.status === 403 && lp.data.code === 'email_not_verified' && lp.data.mail_available === false && lp.data.sent === false, lp);
const lvClient = new Client();
const lv = await lvClient.post('/api/account/login', { email: 'vera.verificada@exemplo.com', password: PASS });
check('conta confirmada, sem e-mail configurado: o login com código NÃO funciona (503 mail_not_configured, com o caminho sem conta), e nunca vira sessão sem o código', lv.status === 503 && lv.data.code === 'mail_not_configured' && /sem conta/.test(lv.data.error) && (await lvClient.get('/api/account/me')).data.customer === null, lv);
const lwrong = await new Client().post('/api/account/login', { email: 'vera.verificada@exemplo.com', password: 'senha-errada-999' });
check('...e a senha errada segue recebendo o mesmo 401 de sempre (o 503 só aparece com a senha certa)', lwrong.status === 401, lwrong);
const fg = await new Client().post('/api/account/forgot-password', { email: 'vera.verificada@exemplo.com' });
check('recuperação de senha por e-mail: 503 mail_not_configured, com o caminho alternativo na mensagem (igual para qualquer e-mail)', fg.status === 503 && fg.data.code === 'mail_not_configured' && /Não consigo acessar meu e-mail/.test(fg.data.error) && (await new Client().post('/api/account/forgot-password', { email: 'ninguem@exemplo.com' })).data.code === 'mail_not_configured', fg);
const dup = await new Client().post('/api/account/register', { name: 'Vera Verificada', email: 'vera.verificada@exemplo.com', phone: '34999991111', password: 'outra-senha-999' });
check('cadastro repetido de e-mail existente também recebe 503 (não vira pista de quem tem conta)', dup.status === 503 && dup.data.code === 'mail_not_configured');
const owner = new Client();
await owner.login();
const veraRow = (await owner.get('/api/admin/customers?q=vera.verificada')).data.customers[0];
const veraLink = await owner.post(`/api/admin/customers/${veraRow.id}/reset-link`, {});
const veraCheck = await new Client().post('/api/account/reset-check', { token: veraLink.data.token });
const veraReset = await new Client().post('/api/account/reset', { token: veraLink.data.token, password: 'senha-redefinida-1' });
check('sem e-mail configurado, o link gerado pela loja continua funcionando (consultar e redefinir), sem tentar mandar aviso por e-mail (a senha nova é aceita: o login pede o código e responde 503 porque não há como enviá-lo)', veraCheck.status === 200 && veraReset.status === 200 && (await new Client().post('/api/account/login', { email: 'vera.verificada@exemplo.com', password: 'senha-redefinida-1' })).status === 503, [veraCheck.status, veraReset.status]);
const info = await owner.get('/api/admin/mail');
check('painel: configured=false e lista exatamente o que falta', info.status === 200 && info.data.configured === false && JSON.stringify(info.data.missing) === JSON.stringify(['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']), info.data);
const test = await owner.post('/api/admin/mail/test', {});
check('painel: e-mail de teste responde 503 listando as variáveis que faltam', test.status === 503 && test.data.code === 'mail_not_configured' && test.data.missing.includes('SMTP_PASS') && /SMTP_HOST/.test(test.data.error), test);
const list = await owner.get('/api/admin/customers');
check('painel: contas pendentes continuam listadas com o status certo', list.data.customers.find((x) => x.email === 'pia.pendente@exemplo.com')?.status === 'pending_verification');
const orderRes = await new Client().get('/api/products');
check('o resto do site não depende do e-mail (catálogo responde)', orderRes.status === 200);

// ---------------------------------------------------------------------------------------------------
section('SMTP_USER sem ser e-mail exige MAIL_FROM');
serve({ MAIL_MODE: 'env', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'apikey', SMTP_PASS: 'x' });
const need = await new Client().get('/api/health');
const ownerB = new Client();
await ownerB.login();
const needInfo = await ownerB.get('/api/admin/mail');
check('usuário do SMTP que não é e-mail (ex.: "apikey"): falta MAIL_FROM e o painel diz isso', need.data.mail === 'missing' && JSON.stringify(needInfo.data.missing) === JSON.stringify(['MAIL_FROM']), needInfo.data);

serve({ MAIL_MODE: 'env', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'apikey', SMTP_PASS: 'x', MAIL_FROM: 'Copo Cheio <loja@exemplo.com>' });
const ownerC = new Client();
await ownerC.login();
const fromInfo = await ownerC.get('/api/admin/mail');
check('com MAIL_FROM definida, o envio fica configurado (e o painel mostra o remetente, sem a senha)', fromInfo.data.configured === true && fromInfo.data.from === 'Copo Cheio <loja@exemplo.com>' && !/"x"|pass/i.test(JSON.stringify(fromInfo.data)), fromInfo.data);
serve({ MAIL_MODE: 'env', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'loja@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
const ownerD = new Client();
await ownerD.login();
const gmail = await ownerD.get('/api/admin/mail');
check('Gmail: SMTP_USER já é um e-mail, então MAIL_FROM é opcional (remetente = o próprio e-mail)', gmail.data.configured === true && gmail.data.from === 'Copo Cheio <loja@gmail.com>' && gmail.data.host === 'smtp.gmail.com', gmail.data);

// ---------------------------------------------------------------------------------------------------
section('DNS inteiro fora do ar');
serve({ DNS_MODE: 'broken' });
const d = new Client();
const nx = await d.post('/api/account/register', { name: 'Dns Fora', email: 'fulano@dominio-inexistente-xyz.com', phone: '34999993333', password: PASS });
check('com o DNS todo fora, "domínio inexistente" não pode ser provado: o cadastro segue e o e-mail de confirmação decide', nx.status === 202 && (await mailsTo('fulano@dominio-inexistente-xyz.com')).length === 1, nx);
const dis = await d.post('/api/account/register', { name: 'Dns Fora', email: 'fulano@mailinator.com', phone: '34999993333', password: PASS });
check('descartáveis continuam bloqueados (lista local, não depende do DNS)', dis.status === 400 && dis.data.reason === 'disposable', dis);
const res = await d.post('/api/account/register', { name: 'Dns Fora', email: 'fulano@example.com', phone: '34999993333', password: PASS });
check('domínios reservados continuam bloqueados', res.status === 400 && res.data.reason === 'reserved', res);

// ---- volta ao normal ---------------------------------------------------------------------------------
serve();
const back = await new Client().get('/api/health');
check('servidor de teste restaurado (e-mail ok)', back.data.mail === 'ok', back.data);
summary();
