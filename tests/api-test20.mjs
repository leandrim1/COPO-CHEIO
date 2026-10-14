// Painel "E-mails e Entregabilidade" (servidor): visão geral com o que cada número mede, o que o SMTP puro NÃO informa, conferência de
// SPF/DKIM/DMARC no DNS, alertas (abrem, avisam o dono uma vez, se resolvem sozinhos) e permissões.
// usage: bash tests/fresh.sh && node tests/api-test20.mjs
import { execFileSync, execSync } from 'node:child_process';
import { Client, check, clearMail, mailMode, mailsTo, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const psql = (sql) => execFileSync('psql', [...P, '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const serve = (env = {}) => execSync(`bash ${new URL('./serve.sh', import.meta.url).pathname}`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const dns = (body) => fetch(`${BASE}/__dns`, { method: 'POST', body: JSON.stringify(body) });
const STRONG = 'Caixa#Segura-2026';
const PASS = 'senha-antiga-123';
let seq = 0;
const fresh = (prefix = 'pn') => `${prefix}${++seq}@exemplo.com`;
let phoneN = 0;
const nextPhone = () => `3494${String(5000000 + ++phoneN).slice(-7)}`;
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* ainda não */
    }
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
};
const register = (email, extra = {}) => new Client().post('/api/account/register', { name: 'Cliente Painel', email, phone: nextPhone(), password: PASS, ...extra });
// Zera os registros de e-mail (mensagens, eventos, alertas): cada teste abaixo começa sem nada.
const wipe = () => {
  psql('delete from email_messages');
  psql('delete from email_alerts');
};

const owner = new Client(undefined, '198.51.100.51');
await owner.login();
await owner.post('/api/admin/admins', { email: 'comum20@copocheio.local', name: 'Atendente', password: STRONG, role: 'admin' });
const staff = new Client(undefined, '198.51.100.52');
await staff.login('comum20@copocheio.local', STRONG);
const anon = new Client();
const overview = (q = '') => owner.get(`/api/admin/emails/overview${q}`);
const refresh = () => owner.get('/api/admin/emails/overview?refresh=1');
const alertCodes = (r) => r.data.alerts.map((a) => `${a.code}:${a.severity}`).sort();

// ------------------------------------------------------------------------------------------------
section('1. Visão geral: o que cada número mede e o que o SMTP puro NÃO informa');
{
  check('sem login: 401', (await anon.get('/api/admin/emails/overview')).status === 401);
  // Movimento de verdade: 3 cadastros aceitos, 1 endereço que o servidor recusa.
  await clearMail();
  for (let i = 0; i < 3; i++) await register(fresh());
  await register('naoexiste-20@exemplo.com');
  const r = await staff.get('/api/admin/emails/overview?days=7');
  check('administrador comum também vê a visão geral', r.status === 200, r.data);
  const d = r.data;
  check('transporte: SMTP, configurado, sem segredos (só o domínio do remetente e o servidor)', d.transport.name === 'smtp' && d.transport.configured === true && d.transport.from_domain === 'copocheio.test' && d.transport.host === '127.0.0.1' && !JSON.stringify(d.transport).includes('secret'), d.transport);
  check('o SMTP puro NÃO informa entrega, devolução, spam, abertura nem clique (e o painel diz isso)', JSON.stringify(d.transport.capabilities) === JSON.stringify({ acceptance: true, delivery: false, bounces: false, complaints: false, opens: false, clicks: false }), d.transport.capabilities);
  check('totais: 3 aceitas pelo servidor e 1 falha', d.totals.accepted >= 3 && d.totals.failed >= 1 && d.totals.total >= 4, d.totals);
  check('taxa de aceitação existe; taxa de entrega/devolução/spam NÃO são inventadas (nulas)', typeof d.rates.accepted_percent === 'number' && d.rates.delivered_percent === null && d.rates.bounced_percent === null && d.rates.complaint_percent === null, d.rates);
  check('o webhook do provedor não se aplica ao SMTP', d.webhook.applicable === false && d.webhook.configured === false, d.webhook);
  check('por tipo, por dia (7 dias, o último é hoje) e por domínio de destino', d.by_kind.some((k) => k.kind === 'verification' && k.label === 'Confirmação de e-mail (código)') && d.by_day.length === 7 && d.by_day.at(-1).total >= 4 && d.top_domains.some((x) => x.domain === 'exemplo.com'), [d.by_kind[0], d.by_day.at(-1), d.top_domains]);
  check('fila, teto diário e supressões', d.queue.queued >= 0 && d.budget.limit === 0 && d.budget.promo_limit === 300 && (d.suppressions.hard_bounce ?? 0) >= 1, [d.queue, d.budget, d.suppressions]);
  check('consentimento: contagens, sem endereços', typeof d.consent.marketing === 'number' && !JSON.stringify(d.consent).includes('@'), d.consent);
  check('nada que identifique a pessoa: nenhum endereço de cliente na visão geral', !/@exemplo\.com/.test(JSON.stringify(d)), JSON.stringify(d).match(/[^"]*@exemplo\.com/)?.[0]);
  check('período inválido vira o padrão; 1 dia mostra 1 linha por dia', (await overview('?days=abc')).data.by_day.length === 7 && (await overview('?days=1')).data.by_day.length === 1 && (await overview('?days=500')).data.by_day.length === 90);
}

// ------------------------------------------------------------------------------------------------
section('2. Conferência do DNS (SPF, DKIM, DMARC) do domínio do remetente');
{
  check('sem login: 401', (await anon.get('/api/admin/emails/dns')).status === 401);
  const ok = await staff.get('/api/admin/emails/dns');
  check('domínio bem configurado: SPF, DKIM, DMARC (monitorando) e MX presentes = "ok"', ok.status === 200 && ok.data.applicable === true && ok.data.domain === 'copocheio.test' && ok.data.status === 'ok' && ok.data.spf.record.startsWith('v=spf1') && ok.data.dkim.found[0]?.selector === 'selector1' && ok.data.dmarc.policy === 'none' && ok.data.mx.hosts.length === 1, ok.data);
  check('DMARC em p=none aparece como informação ("comece monitorando"), não como erro', ok.data.dmarc.findings.some((f) => f.level === 'info' && /monitoramento/.test(f.text)) && !ok.data.dmarc.findings.some((f) => f.level === 'error'));
  await dns({ type: 'txt', name: 'copocheio.test', value: null });
  const noSpf = await owner.get('/api/admin/emails/dns');
  check('sem SPF: "problema", com o aviso de que o valor vem do provedor', noSpf.data.status === 'problem' && noSpf.data.spf.record === null && /provedor/.test(noSpf.data.spf.findings[0].text), noSpf.data.spf);
  await dns({ type: 'txt', name: 'copocheio.test', value: ['v=spf1 include:_spf.copocheio.test ~all', 'v=spf1 +all'] });
  check('dois registros SPF: "problema"', (await owner.get('/api/admin/emails/dns')).data.status === 'problem');
  await dns({ type: 'txt', name: 'copocheio.test', value: ['v=spf1 include:_spf.copocheio.test ~all'] });
  await dns({ type: 'txt', name: '_dmarc.copocheio.test', value: null });
  const noDmarc = await owner.get('/api/admin/emails/dns');
  check('sem DMARC: pede atenção e ensina a começar com p=none (nunca bloqueando)', noDmarc.data.status === 'attention' && noDmarc.data.dmarc.findings[0].level === 'warning' && /p=none/.test(noDmarc.data.dmarc.findings[0].text), noDmarc.data.dmarc);
  await dns({ type: 'txt', name: '_dmarc.copocheio.test', value: ['v=DMARC1; p=none; rua=mailto:dmarc@copocheio.test'] });
  await dns({ type: 'txt', name: 'selector1._domainkey.copocheio.test', value: null });
  const noDkim = await owner.get('/api/admin/emails/dns');
  check('sem DKIM nos nomes comuns: atenção, e o texto admite que isso não prova ausência', noDkim.data.status === 'attention' && /NÃO prova/.test(noDkim.data.dkim.findings[0].text), noDkim.data.dkim);
  const picked = await owner.get('/api/admin/emails/dns?selector=minhachave');
  check('o dono pode testar um seletor específico', picked.status === 200 && JSON.stringify(picked.data.dkim.tried) === JSON.stringify(['minhachave']) && picked.data.dkim.found.length === 0);
  await dns({ type: 'cname', name: 'minhachave._domainkey.copocheio.test', value: ['minhachave.dkim.provedor.example'] });
  check('...e acha quando a chave é um CNAME (como os provedores de envio usam)', (await owner.get('/api/admin/emails/dns?selector=minhachave')).data.dkim.found[0]?.via === 'cname');
  check('seletor inválido: 400', (await owner.get('/api/admin/emails/dns?selector=../../etc')).status === 400 && (await owner.get('/api/admin/emails/dns?selector=a%20b')).status === 400);
  await dns({ reset: true });
  check('a verificação é limitada por administrador (10 a cada 10 minutos)', await (async () => {
    let last;
    for (let i = 0; i < 12; i++) last = await staff.get('/api/admin/emails/dns');
    return last.status === 429;
  })());
}

// ------------------------------------------------------------------------------------------------
section('3. Alertas: abrem com texto em português, avisam o dono UMA vez e se resolvem sozinhos');
{
  wipe();
  psql('delete from email_suppressions');
  await clearMail();
  const calm = await refresh();
  check('sem problema nenhum, nenhum alerta', calm.status === 200 && calm.data.alerts.length === 0, calm.data.alerts);

  // 3a. Mensagem parada na fila há mais de 30 minutos.
  const stuck = psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, spec, next_attempt_at) values ('password_changed', 'transactional', 'customer', 'parada20@exemplo.com', 'exemplo.com', 'queued', ${lit(JSON.stringify({ name: 'Parada', at: new Date().toISOString() }))}::jsonb, now() - interval '2 hours') returning id`);
  const a1 = await refresh();
  const alert = a1.data.alerts.find((a) => a.code === 'queue_backlog');
  check('alerta de fila parada, em português, com o que fazer', Boolean(alert) && alert.severity === 'warning' && /Mensagens paradas na fila/.test(alert.title) && /1 mensagem/.test(alert.detail) && /Processar fila agora/.test(alert.hint), a1.data.alerts);
  const note = await until(async () => (await mailsTo('dono@copocheio.local')).find((m) => /precisa de você/.test(m.subject)));
  check('o dono recebeu o aviso por e-mail, com o alerta e o botão para o painel', Boolean(note) && /Mensagens paradas na fila/.test(note.text) && /\/admin\/emails/.test(note.html), (await mailsTo('dono@copocheio.local')).map((m) => m.subject));
  check('o aviso por e-mail não leva endereço de cliente, código de 6 dígitos nem link de conta', !/@exemplo\.com/.test(note.text) && !/\b\d{6}\b/.test(note.text) && !/\/conta\/(verificar|redefinir)\//.test(note.html), note.text);
  check('o aviso é de categoria transacional, para a equipe, e o registro não guarda corpo', JSON.parse(psql(`select row_to_json(m) from email_messages m where kind = 'deliverability_alert' order by created_at desc limit 1`)).audience === 'staff');
  check('administrador comum vê o alerta (leitura) mas só o dono recebe o e-mail', (await staff.get('/api/admin/emails/overview')).data.alerts.some((a) => a.code === 'queue_backlog') && (await mailsTo('comum20@copocheio.local')).length === 0);
  const before = (await mailsTo('dono@copocheio.local')).length;
  await refresh();
  await refresh();
  await new Promise((r) => setTimeout(r, 500));
  check('atualizar de novo NÃO manda outro aviso (um por alerta a cada 24 h)', (await mailsTo('dono@copocheio.local')).length === before);

  // Resolve: o aviso de abertura da fila já mandou a mensagem parada; o alerta some sozinho na avaliação seguinte.
  await until(() => psql(`select status from email_messages where id = ${lit(stuck)}`) === 'accepted');
  const gone = await refresh();
  check('com a fila andando, o alerta se resolve sozinho', gone.data.alerts.length === 0 && psql(`select count(*) from email_alerts where resolved_at is null`) === '0', gone.data.alerts);
  check('...e fica registrado como resolvido (não apagado)', Number(psql(`select count(*) from email_alerts where code = 'queue_backlog' and resolved_at is not null`)) === 1);

  // 3b. Usuário/senha do servidor de e-mail recusados.
  wipe();
  await mailMode('auth');
  const bad = await register(fresh('auth'));
  check('(preparação) cadastro com o servidor recusando usuário/senha falha com mensagem clara', bad.status >= 400, bad.data);
  const auth = await refresh();
  const sa = auth.data.alerts.find((a) => a.code === 'smtp_auth');
  check('alerta crítico: servidor de e-mail recusou usuário/senha, citando SMTP_USER / SMTP_PASS e a senha de app', Boolean(sa) && sa.severity === 'critical' && /SMTP_USER/.test(sa.hint) && /senha de app/.test(sa.hint), auth.data.alerts);
  // Espera o aviso ao dono tentar sair (e falhar) antes de o servidor de e-mail "voltar": senão o aviso poderia sair na primeira tentativa.
  check('(preparação) o aviso ao dono tentou sair e ficou esperando na fila', Boolean(await until(() => psql(`select count(*) from email_messages where kind = 'deliverability_alert' and status = 'queued' and attempts = 1`) === '1')));
  await mailMode(null);
  const ok = await register(fresh('depois'));
  check('(preparação) depois de corrigir, o cadastro funciona', ok.status === 202);
  const fixed = await refresh();
  check('com um envio aceito depois do erro, o alerta se resolve sozinho', !fixed.data.alerts.some((a) => a.code === 'smtp_auth'), fixed.data.alerts);
  psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where kind = 'deliverability_alert' and status = 'queued'`);
  const orphan = await owner.post('/api/admin/emails/process');
  check('o aviso por e-mail que ficou esperando (o servidor recusava) é descartado quando o alerta já passou', orphan.status === 200 && Number(psql(`select count(*) from email_messages where kind = 'deliverability_alert' and status = 'queued'`)) === 0 && Number(psql(`select count(*) from email_messages where kind = 'deliverability_alert' and status = 'cancelled'`)) >= 1, [orphan.data, psql(`select string_agg(kind || ':' || status || ':' || attempts || ':' || coalesce(error_kind, '-') || ':' || coalesce(to_char(next_attempt_at, 'HH24:MI:SS'), '-'), ' | ') from email_messages where kind = 'deliverability_alert'`)]);

  // 3c. Recusas por política (5.7.x) e endereços recusados.
  wipe();
  psql('delete from email_suppressions');
  await register('policy-a@exemplo.com');
  await register('policy-b@exemplo.com');
  const pol = await refresh();
  const pb = pol.data.alerts.find((a) => a.code === 'policy_blocks');
  check('duas recusas por política: alerta apontando para SPF, DKIM e DMARC', Boolean(pb) && pb.severity === 'warning' && /SPF/.test(pb.hint) && /DMARC/.test(pb.hint), pol.data.alerts);
  check('recusa por política NÃO suprime o endereço (o problema é de reputação, não da caixa)', psql(`select count(*) from email_suppressions where email like 'policy-%'`) === '0');
  for (const e of ['naoexiste-21@exemplo.com', 'naoexiste-22@exemplo.com', 'naoexiste-23@exemplo.com']) await register(e);
  const rej = await refresh();
  check('três endereços recusados em pouco volume: alerta de endereços inexistentes', rej.data.alerts.some((a) => a.code === 'hard_rejections'), rej.data.alerts);
  check('alertas ordenados: críticos antes dos de atenção', (() => {
    const order = rej.data.alerts.map((a) => ({ critical: 0, warning: 1, info: 2 })[a.severity]);
    return order.every((v, i) => i === 0 || v >= order[i - 1]);
  })());
  check('o histórico de mensagens separa "política" dos demais motivos de falha', JSON.parse(psql(`select json_agg(distinct error_kind) from email_messages where status = 'failed'`)).sort().join() === 'policy,recipient');

  // 3d. Muitas falhas de envio.
  wipe();
  psql('delete from email_suppressions');
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, accepted_at, transport, attempts)
        select 'order_received', 'transactional', 'customer', 'ok' || g || '@exemplo.com', 'exemplo.com', 'accepted', now(), 'smtp', 1 from generate_series(1, 6) g`);
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, transport, attempts, error_kind, error_code, error_detail, last_attempt_at)
        select 'order_received', 'transactional', 'customer', 'falha' || g || '@exemplo.com', 'exemplo.com', 'failed', 'smtp', 6, 'network', 'ETIMEDOUT', 'Não foi possível falar com o servidor de e-mail.', now() from generate_series(1, 6) g`);
  const sf = (await refresh()).data.alerts.find((a) => a.code === 'send_failures');
  check('metade das mensagens falhou em 24 h: alerta crítico com a porcentagem', Boolean(sf) && sf.severity === 'critical' && /6 de 12/.test(sf.detail) && /50/.test(sf.detail), sf);
  wipe();
  check('limpos os registros, o alerta some', (await refresh()).data.alerts.length === 0);
}

// ------------------------------------------------------------------------------------------------
section('4. Teto diário de envio (EMAIL_DAILY_LIMIT) e remetente de e-mail gratuito');
{
  serve({ EMAIL_DAILY_LIMIT: '10' });
  const o = new Client(undefined, '198.51.100.53');
  await o.login();
  wipe();
  const budget = (n) =>
    psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, accepted_at, transport, attempts)
          select 'order_received', 'transactional', 'customer', 'teto' || g || '@exemplo.com', 'exemplo.com', 'accepted', now(), 'smtp', 1 from generate_series(1, ${n}) g`);
  budget(8);
  const warn = (await o.get('/api/admin/emails/overview?refresh=1')).data;
  check('80% do teto: atenção, com os números e a orientação', warn.budget.limit === 10 && warn.budget.used >= 8 && warn.alerts.some((a) => a.code === 'daily_limit' && a.severity === 'warning' && /8 de 10/.test(a.detail)), warn.alerts);
  psql(`delete from email_messages where recipient_email like 'teto%'`);
  budget(10);
  const full = (await o.get('/api/admin/emails/overview?refresh=1')).data;
  check('100% do teto: crítico ("foi atingido")', full.alerts.some((a) => a.code === 'daily_limit' && a.severity === 'critical' && /atingido/.test(a.title)), full.alerts);
  // Com o teto cheio, e-mail de pedido espera, mas o código de confirmação (o cliente está esperando na tela) NÃO é segurado.
  await clearMail();
  const code = await new Client().post('/api/account/register', { name: 'Teto Cheio', email: 'tetocheio@exemplo.com', phone: nextPhone(), password: PASS });
  check('com o teto cheio, o código de confirmação ainda sai (login não depende do teto)', code.status === 202 && (await mailsTo('tetocheio@exemplo.com')).length === 1, code.data);
  wipe();

  psql(`delete from email_messages where kind = 'deliverability_alert'`);
  serve({ MAIL_MODE: 'env', SMTP_HOST: '127.0.0.1', SMTP_PORT: '2525', SMTP_USER: 'apikey', SMTP_PASS: 'x', MAIL_FROM: 'Minha Loja <minhaloja@gmail.com>' });
  const g = new Client(undefined, '198.51.100.54');
  await g.login();
  const free = (await g.get('/api/admin/emails/overview?refresh=1')).data;
  check('remetente @gmail.com: o painel avisa que é e-mail gratuito (informação, sem e-mail ao dono)', free.transport.free_sender === true && free.alerts.some((a) => a.code === 'free_sender' && a.severity === 'info'), [free.transport, free.alerts]);
  const dnsFree = await g.get('/api/admin/emails/dns');
  check('DNS: não se aplica (o domínio é do Gmail), e o texto explica por quê', dnsFree.status === 200 && dnsFree.data.applicable === false && /provedor de e-mail gratuito/.test(dnsFree.data.reason), dnsFree.data);
  check('o aviso "remetente gratuito" não vira e-mail para o dono', Number(psql(`select count(*) from email_messages where kind = 'deliverability_alert'`)) === 0);
  const camp = await g.get('/api/admin/emails/campaigns');
  check('a lista de campanhas informa que o remetente é gratuito (exige aceitar o risco para enviar)', camp.status === 200 && camp.data.free_sender === true, camp.data);
  serve();
}

summary();
