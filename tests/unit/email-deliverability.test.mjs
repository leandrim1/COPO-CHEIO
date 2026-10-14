// Regras puras da entregabilidade: assinatura dos avisos do provedor (Svix), leitura dos avisos, análise de SPF/DMARC/DKIM e decisão dos
// alertas. Sem rede e sem banco.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { load } from './load.mjs';

const svix = await load('server/email/svix.ts');
const hooks = await load('server/email/webhooks.ts');
const dns = await load('server/email/dns.ts');
const alerts = await load('server/email/alerts.ts');
const alertText = await load('server/email/alertText.ts');

// ---- Assinatura dos avisos (Svix) ---------------------------------------------------------------------------------------------------
// Exemplo da documentação da Svix ("Verifying Webhooks Manually"): segredo, id, hora, corpo e a assinatura esperada.
const DOC = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: '1614265330',
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};
const NOW = Number(DOC.timestamp);

test('Svix: o exemplo da documentação confere', () => {
  assert.equal(svix.verifySvix(DOC.secret, { id: DOC.id, timestamp: DOC.timestamp, signature: DOC.signature }, DOC.body, NOW), true);
});

test('Svix: o segredo vale com ou sem o prefixo whsec_', () => {
  assert.equal(svix.verifySvix(DOC.secret.replace('whsec_', ''), { id: DOC.id, timestamp: DOC.timestamp, signature: DOC.signature }, DOC.body, NOW), true);
});

test('Svix: corpo alterado em 1 caractere, id, hora ou segredo diferentes NÃO conferem', () => {
  const h = { id: DOC.id, timestamp: DOC.timestamp, signature: DOC.signature };
  assert.equal(svix.verifySvix(DOC.secret, h, DOC.body.replace('2432232314', '2432232315'), NOW), false);
  assert.equal(svix.verifySvix(DOC.secret, { ...h, id: 'msg_outro' }, DOC.body, NOW), false);
  assert.equal(svix.verifySvix(DOC.secret, { ...h, timestamp: '1614265331' }, DOC.body, NOW), false);
  assert.equal(svix.verifySvix('whsec_' + Buffer.from('outro segredo').toString('base64'), h, DOC.body, NOW), false);
});

test('Svix: aviso velho (ou do futuro) é recusado mesmo com assinatura certa; 5 minutos de folga valem', () => {
  const h = { id: DOC.id, timestamp: DOC.timestamp, signature: DOC.signature };
  assert.equal(svix.verifySvix(DOC.secret, h, DOC.body, NOW + 299), true);
  assert.equal(svix.verifySvix(DOC.secret, h, DOC.body, NOW + 301), false);
  assert.equal(svix.verifySvix(DOC.secret, h, DOC.body, NOW - 301), false);
});

test('Svix: cabeçalhos faltando, assinatura de outra versão ou lixo são recusados', () => {
  const ok = { id: DOC.id, timestamp: DOC.timestamp, signature: DOC.signature };
  for (const bad of [{ ...ok, id: null }, { ...ok, timestamp: null }, { ...ok, signature: null }, { ...ok, signature: '' }, { ...ok, signature: 'v2,' + DOC.signature.slice(3) }, { ...ok, signature: 'lixo' }, { ...ok, timestamp: 'abc' }, { ...ok, timestamp: '-5' }]) {
    assert.equal(svix.verifySvix(DOC.secret, bad, DOC.body, NOW), false);
  }
  assert.equal(svix.verifySvix('', ok, DOC.body, NOW), false, 'segredo vazio nunca confere');
});

test('Svix: durante a troca de segredo o cabeçalho traz várias assinaturas e basta uma conferir', () => {
  const h = { id: DOC.id, timestamp: DOC.timestamp, signature: `v1,${Buffer.from('x'.repeat(32)).toString('base64')} ${DOC.signature}` };
  assert.equal(svix.verifySvix(DOC.secret, h, DOC.body, NOW), true);
  assert.equal(svix.verifySvix(DOC.secret, { ...h, signature: `v1,${Buffer.from('x'.repeat(32)).toString('base64')}` }, DOC.body, NOW), false);
});

test('Svix: assina e confere o que nós mesmos geramos (corpo com acentos e quebras de linha)', () => {
  const secret = 'whsec_' + Buffer.from('segredo-de-teste-com-32-bytes-ok!!').toString('base64');
  const body = '{"type":"email.delivered","data":{"subject":"Pedido #1001 – ação"}}\n';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg_1.${timestamp}.${body}`).digest('base64');
  assert.equal(svix.verifySvix(secret, { id: 'msg_1', timestamp, signature }, body), true);
  assert.equal(svix.verifySvix(secret, { id: 'msg_1', timestamp, signature }, body.trim()), false, 'o corpo tem de ser EXATAMENTE o que chegou');
});

// ---- Leitura dos avisos da Resend ---------------------------------------------------------------------------------------------------
const evt = (type, data = {}, created = '2026-10-14T12:00:00.000Z') => ({ type, created_at: created, data: { email_id: 'abc-123', to: ['Cliente@Exemplo.com'], subject: 'Pedido', ...data } });

test('avisos: entregue, atrasado, reclamação, aberto e clicado viram eventos nossos, com o id do provedor e o destinatário', () => {
  for (const [type, expected] of [['email.delivered', 'delivered'], ['email.delivery_delayed', 'delayed'], ['email.complained', 'complained'], ['email.opened', 'opened'], ['email.clicked', 'clicked'], ['email.failed', 'failed']]) {
    const e = hooks.normalizeResend(evt(type));
    assert.equal(e.type, expected, type);
    assert.equal(e.providerId, 'abc-123');
    assert.equal(e.recipient, 'cliente@exemplo.com');
    assert.equal(e.occurredAt.toISOString(), '2026-10-14T12:00:00.000Z');
  }
});

test('avisos: devolução definitiva (Permanent) é "hard"; temporária (Transient) é "soft"; qualquer outra coisa é "unknown" (nunca suprime)', () => {
  assert.equal(hooks.normalizeResend(evt('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: 'não existe' } })).detail.bounce, 'hard');
  assert.equal(hooks.normalizeResend(evt('email.bounced', { bounce: { type: 'Transient' } })).detail.bounce, 'soft');
  assert.equal(hooks.normalizeResend(evt('email.bounced', { bounce: { type: 'Undetermined' } })).detail.bounce, 'unknown');
  assert.equal(hooks.normalizeResend(evt('email.bounced', {})).detail.bounce, 'unknown');
  assert.equal(hooks.normalizeResend(evt('email.bounced', { bounce: 'Permanent' })).detail.bounce, 'unknown');
});

test('avisos: o motivo da devolução vai sem endereço de e-mail; o clique não guarda o link', () => {
  const b = hooks.normalizeResend(evt('email.bounced', { bounce: { type: 'Permanent', message: 'A caixa cliente@exemplo.com não existe' } }));
  assert.ok(!/@/.test(b.detail.message), b.detail.message);
  const c = hooks.normalizeResend(evt('email.clicked', { click: { link: 'https://x.com/?token=segredo' } }));
  assert.deepEqual(c.detail, {});
});

test('avisos: tipos que não usamos, formatos estranhos e sem id são ignorados', () => {
  assert.equal(hooks.normalizeResend(evt('email.sent')), null);
  assert.equal(hooks.normalizeResend(evt('email.scheduled')), null);
  assert.equal(hooks.normalizeResend(evt('algo.novo')), null);
  assert.equal(hooks.normalizeResend(null), null);
  assert.equal(hooks.normalizeResend('texto'), null);
  assert.equal(hooks.normalizeResend({ type: 'email.delivered' }), null);
  assert.equal(hooks.normalizeResend({ type: 'email.delivered', data: {} }), null);
  assert.equal(hooks.normalizeResend({ type: 'email.delivered', data: { email_id: '' } }), null);
});

test('avisos: data inválida vira "agora"; destinatário inválido vira nulo', () => {
  const e = hooks.normalizeResend({ type: 'email.delivered', created_at: 'ontem', data: { email_id: 'x', to: ['não é e-mail'] } });
  assert.equal(e.recipient, null);
  assert.ok(Math.abs(e.occurredAt.getTime() - Date.now()) < 5000);
});

// ---- SPF ------------------------------------------------------------------------------------------------------------------------------
const levels = (findings) => findings.map((f) => f.level);

test('SPF: sem registro é erro; dois registros é erro', () => {
  assert.deepEqual(levels(dns.analyzeSpf([]).findings), ['error']);
  assert.deepEqual(levels(dns.analyzeSpf(['google-site-verification=abc']).findings), ['error']);
  const two = dns.analyzeSpf(['v=spf1 include:a.com ~all', 'v=spf1 include:b.com ~all']);
  assert.deepEqual(levels(two.findings), ['error']);
  assert.match(two.findings[0].text, /2 registros SPF/);
});

test('SPF: ~all e -all estão certos; ?all avisa; +all é erro; sem all avisa', () => {
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 include:_spf.google.com ~all']).findings), ['ok']);
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 include:_spf.google.com -all']).findings), ['ok']);
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 include:_spf.google.com ?all']).findings), ['warning']);
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 +all']).findings), ['error']);
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 all']).findings), ['error'], '"all" sozinho é "+all"');
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 include:_spf.google.com']).findings), ['warning']);
  assert.deepEqual(levels(dns.analyzeSpf(['v=spf1 redirect=_spf.exemplo.com']).findings), ['ok']);
});

test('SPF: mais de 10 consultas de DNS é erro; perto do limite avisa; ptr avisa', () => {
  const includes = (n) => Array.from({ length: n }, (_, i) => `include:s${i}.exemplo.com`).join(' ');
  assert.ok(levels(dns.analyzeSpf([`v=spf1 ${includes(11)} ~all`]).findings).includes('error'));
  assert.ok(levels(dns.analyzeSpf([`v=spf1 ${includes(8)} ~all`]).findings).includes('warning'));
  assert.ok(!levels(dns.analyzeSpf([`v=spf1 ${includes(3)} ~all`]).findings).some((l) => l !== 'ok'));
  assert.ok(levels(dns.analyzeSpf(['v=spf1 ptr ~all']).findings).includes('warning'));
});

// ---- DMARC ----------------------------------------------------------------------------------------------------------------------------
test('DMARC: ausente avisa e ensina a começar com p=none; p=none é "monitoramento"; quarantine/reject estão ativos', () => {
  const none = dns.analyzeDmarc([]);
  assert.equal(none.record, null);
  assert.equal(none.findings[0].level, 'warning');
  assert.match(none.findings[0].text, /p=none/);
  const monitor = dns.analyzeDmarc(['v=DMARC1; p=none; rua=mailto:dmarc@exemplo.com']);
  assert.equal(monitor.policy, 'none');
  assert.deepEqual(levels(monitor.findings), ['info']);
  assert.deepEqual(levels(dns.analyzeDmarc(['v=DMARC1; p=quarantine; rua=mailto:d@exemplo.com']).findings), ['ok']);
  assert.deepEqual(levels(dns.analyzeDmarc(['v=DMARC1; p=reject; rua=mailto:d@exemplo.com; pct=100']).findings), ['ok']);
});

test('DMARC: sem rua e pct menor que 100 são só informação; política inválida e dois registros são erro', () => {
  assert.deepEqual(levels(dns.analyzeDmarc(['v=DMARC1; p=reject']).findings), ['ok', 'info']);
  assert.ok(dns.analyzeDmarc(['v=DMARC1; p=reject; rua=mailto:d@x.com; pct=50']).findings.some((f) => f.level === 'info' && /50%/.test(f.text)));
  assert.ok(levels(dns.analyzeDmarc(['v=DMARC1; p=banana']).findings).includes('error'));
  assert.ok(levels(dns.analyzeDmarc(['v=DMARC1; p=none', 'v=DMARC1; p=reject']).findings).includes('error'));
});

// ---- Consulta completa com um DNS de mentira -------------------------------------------------------------------------------------------
const nx = () => Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
const fake = (table, { fail = false } = {}) => ({
  resolveTxt: async (name) => {
    if (fail) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    if (!table.txt?.[name]) throw nx();
    return table.txt[name].map((r) => (r.length > 200 ? [r.slice(0, 200), r.slice(200)] : [r]));
  },
  resolveCname: async (name) => {
    if (fail) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    if (!table.cname?.[name]) throw nx();
    return table.cname[name];
  },
  resolveMx: async (name) => {
    if (fail) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
    if (!table.mx?.[name]) throw nx();
    return table.mx[name];
  },
});

test('consulta: domínio bem configurado (SPF, DKIM por TXT, DMARC, MX) fica "ok"', async () => {
  const r = await dns.checkDomainDns('loja.com.br', {
    resolver: fake({
      txt: {
        'loja.com.br': ['v=spf1 include:_spf.google.com ~all'],
        '_dmarc.loja.com.br': ['v=DMARC1; p=quarantine; rua=mailto:d@loja.com.br'],
        'google._domainkey.loja.com.br': ['v=DKIM1; k=rsa; p=MIIBIjANBgkq' + 'A'.repeat(300)],
      },
      mx: { 'loja.com.br': [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
    }),
    now: new Date('2026-10-14T12:00:00Z'),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.checked_at, '2026-10-14T12:00:00.000Z');
  assert.deepEqual(r.dkim.found, [{ selector: 'google', via: 'txt' }], 'o TXT longo vem em pedaços e é juntado');
  assert.deepEqual(r.mx.hosts, ['aspmx.l.google.com']);
});

test('consulta: DKIM por CNAME (como Resend, SendGrid e SES fazem) também conta', async () => {
  const r = await dns.checkDomainDns('loja.com.br', {
    resolver: fake({ txt: { 'loja.com.br': ['v=spf1 include:amazonses.com ~all'], '_dmarc.loja.com.br': ['v=DMARC1; p=none; rua=mailto:d@loja.com.br'] }, cname: { 'resend._domainkey.loja.com.br': ['resend._domainkey.resend.com'] }, mx: { 'loja.com.br': [{ exchange: 'mx.loja.com.br', priority: 10 }] } }),
  });
  assert.deepEqual(r.dkim.found, [{ selector: 'resend', via: 'cname' }]);
  assert.equal(r.status, 'ok', 'p=none é só informação');
});

test('consulta: sem nada configurado é "problema"; sem DKIM nos nomes comuns avisa que NÃO prova ausência', async () => {
  const r = await dns.checkDomainDns('nada.com.br', { resolver: fake({}) });
  assert.equal(r.status, 'problem');
  assert.equal(r.spf.record, null);
  assert.equal(r.dmarc.record, null);
  assert.deepEqual(r.dkim.found, []);
  assert.match(r.dkim.findings[0].text, /NÃO prova/);
  assert.ok(r.mx.findings.some((f) => f.level === 'warning'));
});

test('consulta: só SPF e MX (sem DMARC nem DKIM) pede atenção, não é "problema"', async () => {
  const r = await dns.checkDomainDns('meio.com.br', { resolver: fake({ txt: { 'meio.com.br': ['v=spf1 include:_spf.google.com ~all'] }, mx: { 'meio.com.br': [{ exchange: 'mx.meio.com.br', priority: 1 }] } }) });
  assert.equal(r.status, 'attention');
});

test('consulta: o DNS fora do ar vira "não sei" (não "faltando")', async () => {
  const r = await dns.checkDomainDns('fora.com.br', { resolver: fake({}, { fail: true }) });
  assert.equal(r.status, 'unknown');
  assert.ok(r.spf.findings[0].level === 'info' && /Não foi possível consultar/.test(r.spf.findings[0].text));
  assert.ok(!r.dkim.findings.some((f) => /NÃO prova/.test(f.text)));
});

test('consulta: seletor escolhido pelo dono é o único tentado', async () => {
  const r = await dns.checkDomainDns('loja.com.br', { selectors: ['k9'], resolver: fake({ txt: { 'k9._domainkey.loja.com.br': ['v=DKIM1; p=abc'] } }) });
  assert.deepEqual(r.dkim.tried, ['k9']);
  assert.deepEqual(r.dkim.found, [{ selector: 'k9', via: 'txt' }]);
});

// ---- Alertas ------------------------------------------------------------------------------------------------------------------------------
const base = { total_24h: 0, failed_24h: 0, system_failed_24h: 0, total_7d: 0, rejected_7d: 0, policy_7d: 0, stuck: 0, auth_error_at: null, last_accepted_at: null, accepted_30d: 0, complaints_30d: 0, hard_bounces_30d: 0, provider_accepted_24h: 0, provider_events_24h: 0 };
const ctx = { dailyLimit: 0, usedBudget: 0, freeSender: false, transportDelivery: false, webhookConfigured: false };
const codes = (n, c = {}) => alerts.decideAlerts({ ...base, ...n }, { ...ctx, ...c }).map((a) => `${a.code}:${a.severity}`);

test('alertas: tudo calmo = nenhum alerta', () => {
  assert.deepEqual(codes({ total_24h: 50, total_7d: 200 }), []);
});

test('alertas: usuário/senha recusados e nada aceito depois é crítico; se depois disso saiu algo, não alerta', () => {
  assert.deepEqual(codes({ auth_error_at: '2026-10-14T10:00:00Z' }), ['smtp_auth:critical']);
  assert.deepEqual(codes({ auth_error_at: '2026-10-14T10:00:00Z', last_accepted_at: '2026-10-14T09:00:00Z' }), ['smtp_auth:critical']);
  assert.deepEqual(codes({ auth_error_at: '2026-10-14T10:00:00Z', last_accepted_at: '2026-10-14T11:00:00Z' }), []);
});

test('alertas: falhas de sistema só alertam com volume mínimo (10) e a partir de 20%; 50% é crítico', () => {
  assert.deepEqual(codes({ total_24h: 5, system_failed_24h: 5 }), [], 'poucas mensagens: não alerta');
  assert.deepEqual(codes({ total_24h: 50, system_failed_24h: 9 }), []);
  assert.deepEqual(codes({ total_24h: 50, system_failed_24h: 10 }), ['send_failures:warning']);
  assert.deepEqual(codes({ total_24h: 50, system_failed_24h: 30 }), ['send_failures:critical']);
});

test('alertas: endereços recusados acima de 2% (com pelo menos 3) e recusas por política (5.7.x)', () => {
  assert.deepEqual(codes({ total_7d: 100, rejected_7d: 2 }), []);
  assert.deepEqual(codes({ total_7d: 100, rejected_7d: 3 }), ['hard_rejections:warning']);
  assert.deepEqual(codes({ total_7d: 100, rejected_7d: 3, policy_7d: 1 }), ['hard_rejections:warning']);
  assert.deepEqual(codes({ total_7d: 100, rejected_7d: 20 }), ['hard_rejections:critical']);
  assert.deepEqual(codes({ policy_7d: 2 }), ['policy_blocks:warning']);
  assert.deepEqual(codes({ policy_7d: 10 }), ['policy_blocks:critical']);
});

test('alertas: fila parada há mais de 30 minutos', () => {
  assert.deepEqual(codes({ stuck: 1 }), ['queue_backlog:warning']);
});

test('alertas: teto diário — a partir de 80% atenção, 100% crítico; sem teto não alerta', () => {
  assert.deepEqual(codes({}, { dailyLimit: 450, usedBudget: 359 }), []);
  assert.deepEqual(codes({}, { dailyLimit: 450, usedBudget: 360 }), ['daily_limit:warning']);
  assert.deepEqual(codes({}, { dailyLimit: 450, usedBudget: 450 }), ['daily_limit:critical']);
  assert.deepEqual(codes({}, { dailyLimit: 0, usedBudget: 9999 }), []);
});

test('alertas: spam e devoluções só existem para transporte que AVISA (SMTP puro nunca gera)', () => {
  const n = { accepted_30d: 1000, complaints_30d: 2, hard_bounces_30d: 40 };
  assert.deepEqual(codes(n), [], 'SMTP puro: sem avisos do provedor, não há como saber');
  assert.deepEqual(codes(n, { transportDelivery: true }), ['complaints:warning', 'hard_bounces:warning'], '4% de devoluções definitivas: atenção');
  assert.deepEqual(codes({ ...n, hard_bounces_30d: 60 }, { transportDelivery: true }), ['complaints:warning', 'hard_bounces:critical'], '6%: crítico');
  assert.deepEqual(codes({ accepted_30d: 1000, complaints_30d: 3 }, { transportDelivery: true }), ['complaints:critical']);
  assert.deepEqual(codes({ accepted_30d: 10000, complaints_30d: 5 }, { transportDelivery: true }), [], '0,05% está abaixo da meta');
});

test('alertas: provedor que avisa mas não manda nada em 24 h', () => {
  assert.deepEqual(codes({ provider_accepted_24h: 5, provider_events_24h: 0 }, { transportDelivery: true, webhookConfigured: true }), ['no_events:warning']);
  assert.deepEqual(codes({ provider_accepted_24h: 5, provider_events_24h: 3 }, { transportDelivery: true, webhookConfigured: true }), []);
  assert.deepEqual(codes({ provider_accepted_24h: 5, provider_events_24h: 0 }, { transportDelivery: true, webhookConfigured: false }), []);
});

test('alertas: remetente gratuito é só informação (nunca vira e-mail para o dono)', () => {
  assert.deepEqual(codes({}, { freeSender: true }), ['free_sender:info']);
});

test('alertas: todo código tem texto em português com título, o que houve e o que fazer', () => {
  for (const code of ['smtp_auth', 'send_failures', 'hard_rejections', 'policy_blocks', 'queue_backlog', 'daily_limit', 'complaints', 'hard_bounces', 'no_events', 'free_sender']) {
    const t = alertText.describeAlert(code, { failed: 3, total: 10, percent: 30, rejected: 3, count: 2, used: 360, limit: 450 });
    assert.ok(t.title.length > 8 && t.detail.length > 8 && t.hint.length > 8, code);
    assert.ok(!/undefined|NaN|\[object/.test(`${t.title} ${t.detail} ${t.hint}`), code);
  }
});
