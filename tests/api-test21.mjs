// Provedor de e-mail OPCIONAL (Resend), contra um SIMULADOR da API (tests: nada aqui fala com a Resend de verdade): envio com chave de
// idempotência, erros da API, e os avisos (webhooks) assinados: autenticidade, repetição, ordem trocada, devolução, reclamação e supressão.
// O que NÃO foi verificado contra o serviço real fica dito no relatório final: o formato exato dos avisos e das mensagens de erro.
// usage: bash tests/fresh.sh && node tests/api-test21.mjs
import { execFileSync, execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { Client, check, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const psql = (sql) => execFileSync('psql', [...P, '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const root = new URL('..', import.meta.url).pathname;
const serve = (env = {}) => execSync(`bash ${root}tests/serve.sh`, { env: { ...process.env, ...env }, stdio: 'ignore' });
const API_KEY = 're_chave_falsa_so_de_teste_0123456789';
const SECRET = 'whsec_' + Buffer.from('segredo-do-webhook-so-de-teste-32bytes!').toString('base64');
const PASS = 'senha-antiga-123';
const ALL_DAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, { open: true, start: '00:00', end: '00:00' }]));
let seq = 0;
const fresh = (prefix = 'rs') => `${prefix}${++seq}@exemplo.com`;
let phoneN = 0;
const nextPhone = () => `3493${String(6000000 + ++phoneN).slice(-7)}`;
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
const row = (where) => JSON.parse(psql(`select coalesce((select row_to_json(m) from email_messages m where ${where} order by m.created_at desc limit 1), 'null'::json)`));
const events = (id) => JSON.parse(psql(`select coalesce(json_agg(e order by e.occurred_at, e.received_at), '[]') from email_events e where e.message_id = ${lit(id)}`));

// ---- Simulador da API da Resend -------------------------------------------------------------------------------------------------------
const calls = [];
const fakeApi = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  calls.push({ method: req.method, url: req.url, headers: req.headers, body });
  const to = String(body.to?.[0] ?? '');
  const reply = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (req.headers.authorization !== `Bearer ${API_KEY}`) return reply(401, { name: 'missing_api_key', message: 'API key is invalid' });
  if (/^auth-fail/.test(to)) return reply(403, { name: 'validation_error', message: 'The exemplo.com domain is not verified.' });
  if (/^ratelimit/.test(to)) return reply(429, { name: 'rate_limit_exceeded', message: 'Too many requests.' });
  if (/^invalid-to/.test(to)) return reply(422, { name: 'validation_error', message: 'Invalid `to` field.' });
  if (/^server-error/.test(to)) return reply(500, { name: 'internal_server_error', message: 'Something went wrong.' });
  return reply(200, { id: `fake-${randomUUID()}` });
});
await new Promise((r) => fakeApi.listen(0, '127.0.0.1', r));
const callsTo = (email) => calls.filter((c) => c.body.to?.[0] === email);
const codeSentTo = (email) => /\b(\d{6})\b/.exec(callsTo(email).at(-1)?.body.text ?? '')?.[1];

// ---- Avisos assinados -----------------------------------------------------------------------------------------------------------------
function signed(body, { id = `msg_${randomUUID()}`, ts = Math.floor(Date.now() / 1000), secret = SECRET } = {}) {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}`, 'content-type': 'application/json' };
}
const post = async (body, headers) => {
  try {
    const r = await fetch(`${BASE}/api/email/webhook/resend`, { method: 'POST', headers, body });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch (error) {
    if (!['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'].includes(error.cause?.code)) throw error;
    // Corpo enorme: o servidor recusa e fecha a conexão antes de o cliente terminar de enviar (status 0 = conexão encerrada pelo servidor).
    if (body.length > 100_000) return { status: 0, data: null };
    // Conexão reaproveitada que o servidor já tinha fechado: tenta uma vez de novo.
    const r = await fetch(`${BASE}/api/email/webhook/resend`, { method: 'POST', headers, body });
    return { status: r.status, data: await r.json().catch(() => null) };
  }
};
const hook = (event, opts) => {
  const body = typeof event === 'string' ? event : JSON.stringify(event);
  return post(body, signed(body, opts));
};
const event = (type, providerId, { to = 'cliente@exemplo.com', at = new Date(), data = {} } = {}) => ({ type, created_at: at.toISOString(), data: { email_id: providerId, to: [to], subject: 'Assunto', ...data } });

// ------------------------------------------------------------------------------------------------
section('1. Sem EMAIL_PROVIDER=resend e sem segredo, a rota de avisos nem existe');
{
  const body = JSON.stringify(event('email.delivered', 'x'));
  const r = await post(body, signed(body));
  check('servidor com SMTP: a rota responde 404 (não revela que existe), mesmo com assinatura', r.status === 404, r);
}

// ------------------------------------------------------------------------------------------------
section('2. Modo Resend: envio pela API, com chave só no servidor e chave de idempotência');
serve({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: API_KEY, RESEND_API_URL: `http://127.0.0.1:${fakeApi.address().port}/emails`, RESEND_WEBHOOK_SECRET: SECRET });
const owner = new Client(undefined, '198.51.100.61');
await owner.login();
await owner.patch('/api/admin/store', { opening_hours: ALL_DAYS, delivery_fee: 5, min_order: 0, orders_paused: false, delivery_enabled: true, pickup_enabled: true });
const anon = new Client();
const cat = (await owner.post('/api/admin/categories', { name: 'Cervejas' })).data.category;
const prodId = (await owner.post('/api/admin/products', { name: 'Heineken', price: 8, category_id: cat.id, stock: 100, confirm_duplicate: true })).data.product.id;
const place = async (email) => {
  const r = await new Client().post('/api/orders', { customer_name: 'Pedro Pedido', customer_phone: nextPhone(), customer_email: email, delivery_type: 'pickup', payment_method: 'pix', items: [{ product_id: prodId, quantity: 1 }], idempotency_key: `chave-${randomUUID()}` });
  if (r.status !== 201) throw new Error(`pedido recusado: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.order.order_number;
};
const byOrder = (n) => row(`order_id = (select id from orders where order_number = ${n})`);
const first = fresh('envio');
let firstRow;
{
  const reg = await new Client().post('/api/account/register', { name: 'Cliente Resend', email: first, phone: nextPhone(), password: PASS });
  check('cadastro pelo modo Resend: 202', reg.status === 202, reg.data);
  const call = callsTo(first)[0];
  check('a API recebeu UMA chamada, POST /emails, com a chave no cabeçalho Authorization', calls.filter((c) => c.body.to?.[0] === first).length === 1 && call.method === 'POST' && call.url === '/emails' && call.headers.authorization === `Bearer ${API_KEY}`, call?.headers);
  firstRow = row(`recipient_email = ${lit(first)}`);
  check('a chave de idempotência é o id do registro da mensagem (mesma mensagem, mesma chave, mesmo se tentar de novo)', call.headers['idempotency-key'] === firstRow.id, [call.headers['idempotency-key'], firstRow.id]);
  check('o corpo traz remetente da loja, destinatário, assunto, html e texto, e cabeçalhos de e-mail automático', /Copo Cheio/.test(call.body.from) && call.body.to.length === 1 && Boolean(call.body.subject) && /<html/i.test(call.body.html) && Boolean(call.body.text) && call.body.headers?.['Auto-Submitted'] === 'auto-generated', Object.keys(call.body));
  check('registro: aceito, transporte "resend", id do provedor guardado, sem Message-ID nosso', firstRow.status === 'accepted' && firstRow.transport === 'resend' && /^fake-/.test(firstRow.provider_id) && firstRow.message_id === null, firstRow);
  check('"aceito" aqui significa que a API respondeu 200; entrega só vem pelo aviso assinado', firstRow.delivered_at === null);
  const everything = psql(`select string_agg(row_to_json(m)::text, ' ') from email_messages m`) + psql(`select coalesce(string_agg(row_to_json(e)::text, ' '), '') from email_events e`);
  const code = codeSentTo(first);
  check('chave de API, segredo do webhook e código de confirmação não aparecem nos registros', !everything.includes(API_KEY) && !everything.includes(SECRET) && !everything.includes(SECRET.slice(6)) && Boolean(code) && !new RegExp(`\\b${code}\\b`).test(everything), 'vazou');
}

// ------------------------------------------------------------------------------------------------
section('3. Autenticidade dos avisos: só vale o que vem assinado, recente e inteiro');
{
  const ok = event('email.delivered', firstRow.provider_id, { to: first });
  const body = JSON.stringify(ok);
  const before = psql('select count(*) from email_events');
  const none = await post(body, { 'content-type': 'application/json' });
  check('sem cabeçalhos de assinatura: 401', none.status === 401, none);
  check('assinatura de outro segredo: 401', (await post(body, signed(body, { secret: 'whsec_' + Buffer.from('outro-segredo-qualquer-32-bytes!!').toString('base64') }))).status === 401);
  const h = signed(body);
  check('corpo alterado depois de assinado: 401', (await post(body.replace('Assunto', 'Assunto!'), h)).status === 401);
  check('aviso de 10 minutos atrás (reaproveitado): 401', (await post(body, signed(body, { ts: Math.floor(Date.now() / 1000) - 600 }))).status === 401);
  check('aviso com hora no futuro: 401', (await post(body, signed(body, { ts: Math.floor(Date.now() / 1000) + 600 }))).status === 401);
  check('assinatura vazia ou de versão desconhecida: 401', (await post(body, { ...h, 'svix-signature': '' })).status === 401 && (await post(body, { ...h, 'svix-signature': h['svix-signature'].replace('v1,', 'v9,') })).status === 401);
  check('nada foi gravado pelas tentativas recusadas', psql('select count(*) from email_events') === before);
  check('assinatura certa mas corpo que não é JSON: 400', (await hook('isto não é json')).status === 400);
  check('corpo grande demais: recusado (413, ou conexão encerrada antes de ler)', [413, 0].includes((await post('x'.repeat(300 * 1024), signed('x'.repeat(300 * 1024)))).status));
  check('o mesmo endereço aceita só POST', (await fetch(`${BASE}/api/email/webhook/resend`)).status === 405);
  const ignored = await hook(event('email.sent', firstRow.provider_id));
  check('tipo de aviso que não usamos ("enviado"): 200 e ignorado, nada gravado', ignored.status === 200 && ignored.data.ignored === true && psql('select count(*) from email_events') === before, [ignored, before, psql('select count(*) from email_events')]);
}

// ------------------------------------------------------------------------------------------------
section('4. Entregue, repetido, fora de ordem, aberto');
{
  const id = `msg_${randomUUID()}`;
  const when = new Date(Date.now() - 60_000);
  const delivered = await hook(event('email.delivered', firstRow.provider_id, { to: first, at: when }), { id });
  const m = row(`id = ${lit(firstRow.id)}`);
  check('"entregue" muda o estado e guarda a hora do aviso', delivered.status === 200 && delivered.data.outcome === 'applied' && m.status === 'delivered' && new Date(m.delivered_at).getTime() === when.getTime(), [delivered.data, m.status, m.delivered_at]);
  const again = await hook(event('email.delivered', firstRow.provider_id, { to: first, at: when }), { id });
  check('o MESMO aviso reenviado (mesmo svix-id) vale uma vez só', again.status === 200 && again.data.outcome === 'duplicate' && events(firstRow.id).filter((e) => e.provider === 'resend').length === 1, [again.data, events(firstRow.id)]);
  const late = await hook(event('email.delivery_delayed', firstRow.provider_id, { to: first, at: new Date(Date.now() - 120_000) }));
  check('aviso de "atrasado" que chega DEPOIS de "entregue" não faz a mensagem voltar atrás', late.status === 200 && row(`id = ${lit(firstRow.id)}`).status === 'delivered');
  const open = await hook(event('email.opened', firstRow.provider_id, { to: first }));
  const m2 = row(`id = ${lit(firstRow.id)}`);
  check('"aberto" é contado à parte (só existe se o provedor informar), sem mudar a entrega', open.status === 200 && m2.opens === 1 && m2.status === 'delivered' && m2.first_opened_at !== null, m2);
  const timeline = events(firstRow.id);
  check('a linha do tempo mostra o envio aceito (SMTP/API) e os avisos do provedor', timeline.some((e) => e.provider === 'smtp' && e.type === 'accepted') && timeline.some((e) => e.provider === 'resend' && e.type === 'delivered'), timeline.map((e) => [e.provider, e.type]));
}

// ------------------------------------------------------------------------------------------------
section('5. Devolução definitiva suprime o endereço; temporárias só depois de 3 em 7 dias; reclamação tira das promoções');
{
  const bounceTo = fresh('devolvido');
  await new Client().post('/api/account/register', { name: 'Caixa Cheia', email: bounceTo, phone: nextPhone(), password: PASS });
  const b = row(`recipient_email = ${lit(bounceTo)}`);
  const r = await hook(event('email.bounced', b.provider_id, { to: bounceTo, data: { bounce: { type: 'Permanent', subType: 'General', message: `The recipient ${bounceTo} does not exist` } } }));
  const after = row(`id = ${lit(b.id)}`);
  check('devolução definitiva: mensagem "devolvida", tipo definitivo e hora', r.status === 200 && after.status === 'bounced' && after.bounce_type === 'hard' && after.bounced_at !== null, after);
  const sup = JSON.parse(psql(`select coalesce((select row_to_json(s) from email_suppressions s where email = ${lit(bounceTo)}), 'null'::json)`));
  check('o endereço entrou na lista de supressão pelo aviso do provedor', sup?.reason === 'hard_bounce' && sup.source === 'webhook', sup);
  check('o motivo da devolução guardado não tem o endereço de e-mail', !JSON.stringify(events(b.id)).includes(bounceTo), events(b.id));
  const calls0 = calls.length;
  const n = await place(bounceTo);
  const blocked = await until(() => byOrder(n)?.status === 'blocked' && byOrder(n));
  check('o aviso de um pedido feito depois para o endereço suprimido fica "bloqueada" e nem chega à API do provedor', Boolean(blocked) && blocked.block_reason === 'suppressed' && calls.length === calls0, [blocked?.status, calls.length - calls0]);

  // Temporárias: 2 não suprimem, a 3ª sim (por 7 dias).
  const soft = fresh('lento');
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    ids.push(psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, transport, provider_id, accepted_at, attempts) values ('order_received', 'transactional', 'customer', ${lit(soft)}, 'exemplo.com', 'accepted', 'resend', ${lit('soft-' + i)}, now(), 1) returning id`));
  }
  for (let i = 0; i < 2; i++) await hook(event('email.bounced', `soft-${i + 1}`, { to: soft, data: { bounce: { type: 'Transient' } } }));
  check('duas devoluções temporárias: o endereço NÃO é suprimido', psql(`select count(*) from email_suppressions where email = ${lit(soft)}`) === '0');
  await hook(event('email.bounced', 'soft-3', { to: soft, data: { bounce: { type: 'Transient' } } }));
  const sup3 = JSON.parse(psql(`select coalesce((select row_to_json(s) from email_suppressions s where email = ${lit(soft)}), 'null'::json)`));
  const days = Number(psql(`select extract(epoch from (expires_at - now())) / 86400 from email_suppressions where email = ${lit(soft)}`));
  check('a terceira em 7 dias suprime por 7 dias (não para sempre)', sup3?.reason === 'repeated_soft' && days > 6.9 && days < 7.1, [sup3, days]);

  // "Desconhecida" (tipo estranho ou ausente) nunca suprime.
  const odd = fresh('estranho');
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, transport, provider_id, accepted_at, attempts) values ('order_received', 'transactional', 'customer', ${lit(odd)}, 'exemplo.com', 'accepted', 'resend', 'odd-1', now(), 1)`);
  await hook(event('email.bounced', 'odd-1', { to: odd, data: { bounce: { type: 'Undetermined' } } }));
  check('devolução de tipo indefinido é registrada mas NÃO suprime o endereço', row(`provider_id = 'odd-1'`).status === 'bounced' && psql(`select count(*) from email_suppressions where email = ${lit(odd)}`) === '0');

  // Reclamação de spam: suprime e tira das promoções.
  const fan = fresh('reclama');
  const c = new Client();
  await c.post('/api/account/register', { name: 'Fã Que Reclama', email: fan, phone: nextPhone(), password: PASS, marketing_opt_in: true });
  const verified = await c.post('/api/account/verify-email', { email: fan, code: codeSentTo(fan) });
  check('(preparação) cliente com promoções ligadas', verified.status === 200 && psql(`select marketing from email_preferences where email = ${lit(fan)}`) === 't');
  const f = row(`recipient_email = ${lit(fan)}`);
  const complaint = await hook(event('email.complained', f.provider_id, { to: fan }));
  check('reclamação de spam: mensagem "reclamada", endereço suprimido e promoções desligadas ("reclamação")', complaint.status === 200 && row(`id = ${lit(f.id)}`).status === 'complained' && psql(`select reason from email_suppressions where email = ${lit(fan)}`) === 'complaint' && psql(`select marketing::text || ':' || marketing_unsubscribed_via from email_preferences where email = ${lit(fan)}`) === 'false:reclamacao', row(`id = ${lit(f.id)}`));
}

// ------------------------------------------------------------------------------------------------
section('6. Aviso de mensagem desconhecida: tenta de novo se for recente, ignora se for antigo (mas a reclamação protege o endereço)');
{
  const young = await hook(event('email.delivered', 'nao-existe-1'));
  check('aviso recente de uma mensagem que ainda não conhecemos: 503 (o provedor tenta de novo)', young.status === 503, young);
  const old = await hook(event('email.delivered', 'nao-existe-2', { at: new Date(Date.now() - 20 * 60_000) }));
  check('aviso antigo de mensagem desconhecida (de outro sistema): 200, só registrado', old.status === 200 && old.data.outcome === 'unknown_message', old);
  const who = fresh('sozinho');
  const complaint = await hook(event('email.complained', 'nao-existe-3', { to: who, at: new Date(Date.now() - 20 * 60_000) }));
  check('reclamação antiga de mensagem desconhecida ainda suprime o endereço', complaint.status === 200 && psql(`select reason from email_suppressions where email = ${lit(who)}`) === 'complaint');
}

// ------------------------------------------------------------------------------------------------
section('7. Erros da API do provedor (simulador: textos reais da Resend NÃO verificados)');
{
  // 429 em mensagem que entra na fila: espera e tenta de novo, com a MESMA chave de idempotência.
  const lim = 'ratelimit-1@exemplo.com';
  const n1 = await place(lim);
  const q = await until(() => byOrder(n1)?.status === 'queued' && byOrder(n1).attempts === 1 && byOrder(n1));
  check('429 (limite de requisições): temporário, volta para a fila e tenta de novo depois', Boolean(q) && q.error_kind === 'temporary' && q.error_code === 'HTTP 429' && q.next_attempt_at !== null, q);
  psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where id = ${lit(q.id)}`);
  await owner.post('/api/admin/emails/process');
  const keys = callsTo(lim).map((c) => c.headers['idempotency-key']);
  check('a segunda tentativa usa a MESMA chave de idempotência (a API não duplica se a primeira passou)', keys.length === 2 && keys[0] === keys[1] && keys[0] === q.id, keys);

  // 500: temporário.
  const n2 = await place('server-error-1@exemplo.com');
  const s = await until(() => byOrder(n2)?.status === 'queued' && byOrder(n2).attempts === 1 && byOrder(n2));
  check('500 do provedor: temporário, vai para a fila', Boolean(s) && s.error_kind === 'temporary' && s.error_code === 'HTTP 500', s);

  // 422 falando do destinatário: endereço recusado de vez.
  const inv = 'invalid-to-1@exemplo.com';
  const n3 = await place(inv);
  const iv = await until(() => byOrder(n3)?.status === 'failed' && byOrder(n3));
  check('422 dizendo que o destinatário é inválido: falha de vez e endereço suprimido', Boolean(iv) && iv.error_kind === 'recipient' && iv.bounce_type === 'hard' && psql(`select reason from email_suppressions where email = ${lit(inv)}`) === 'hard_bounce', iv);

  // 403 domínio não verificado: configuração, não destinatário (não suprime, tenta de novo em 1 hora).
  const n4 = await place('auth-fail-1@exemplo.com');
  const a = await until(() => byOrder(n4)?.status === 'queued' && byOrder(n4).attempts === 1 && byOrder(n4));
  const waitMin = Number(psql(`select extract(epoch from (next_attempt_at - now())) / 60 from email_messages where id = ${lit(a.id)}`));
  check('403 (domínio não verificado): erro de CONFIGURAÇÃO — espera ~1 hora e o endereço NÃO é suprimido', Boolean(a) && ['config', 'auth'].includes(a.error_kind) && waitMin > 50 && waitMin < 70 && psql(`select count(*) from email_suppressions where email = 'auth-fail-1@exemplo.com'`) === '0', [a, waitMin]);
  const alerts = (await owner.get('/api/admin/emails/overview?refresh=1')).data.alerts;
  const sa = alerts.find((x) => x.code === 'smtp_auth');
  check('o alerta de configuração fala da Resend (RESEND_API_KEY / domínio verificado), não de SMTP_USER', Boolean(sa) && /Resend/.test(sa.title) && /RESEND_API_KEY/.test(sa.hint) && !/SMTP_USER/.test(sa.hint), alerts);

  // Cadastro (código na tela) com a API recusando: erro claro, nada de "conta criada" sem poder confirmar.
  const reg = await new Client().post('/api/account/register', { name: 'Sem Chance', email: 'ratelimit-2@exemplo.com', phone: nextPhone(), password: PASS });
  check('código de confirmação com a API em 429: o cliente vê "não conseguimos enviar agora" (503), sem repetir sozinho', reg.status === 503 && reg.data.code === 'mail_failed' && row(`recipient_email = 'ratelimit-2@exemplo.com'`).status === 'failed', reg.data);
}

// ------------------------------------------------------------------------------------------------
section('8. Visão geral no modo Resend: o que o provedor informa passa a aparecer — e só isso');
{
  const d = (await owner.get('/api/admin/emails/overview?refresh=1')).data;
  check('transporte Resend: informa aceitação, entrega, devolução e reclamação; NÃO informa abertura nem clique (rastreio desligado)', d.transport.name === 'resend' && JSON.stringify(d.transport.capabilities) === JSON.stringify({ acceptance: true, delivery: true, bounces: true, complaints: true, opens: false, clicks: false }), d.transport);
  check('taxa de entrega "informada pelo provedor" aparece como número; devolução e reclamação também', typeof d.rates.delivered_percent === 'number' && typeof d.rates.bounced_percent === 'number' && typeof d.rates.complaint_percent === 'number', d.rates);
  check('totais com entregues, devolvidas e reclamadas', d.totals.delivered >= 1 && d.totals.bounced >= 1 && d.totals.complained >= 1, d.totals);
  check('estado dos avisos: configurado, último aviso recebido, contagem de recebidos e de recusados (assinatura inválida)', d.webhook.applicable === true && d.webhook.configured === true && d.webhook.last_ok_at !== null && d.webhook.ok_count >= 5 && d.webhook.error_count >= 3 && Boolean(d.webhook.last_error), d.webhook);
  check('reclamação de spam acima do limite seguro vira alerta crítico', d.alerts.some((a) => a.code === 'complaints' && a.severity === 'critical'), d.alerts.map((a) => a.code));
  const note = await until(() => callsTo('dono@copocheio.local').find((c) => /Atenção/.test(c.body.subject)));
  check('o dono foi avisado pelo próprio provedor (e-mail de alerta saiu pela API)', Boolean(note) && /Reclamações de spam/.test(note.body.text), callsTo('dono@copocheio.local').map((c) => c.body.subject));
  const log = readFileSync(`${root}tests/server.log`, 'utf8');
  check('o log do servidor não tem a chave da API, o segredo do webhook nem endereços de cliente', !log.includes(API_KEY) && !log.includes(SECRET.slice(6)) && !/@exemplo\.com/.test(log), (log.match(/.{0,40}@exemplo\.com.{0,20}/) ?? [''])[0]);
  check('sem login, a rota de avisos continua só aceitando assinatura (não depende de sessão)', (await anon.get('/api/admin/emails/overview')).status === 401);
}

serve();
fakeApi.close();
summary();
