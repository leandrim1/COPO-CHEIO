// E-mails promocionais: consentimento (caixa desmarcada, só vale depois de provar a caixa de e-mail), descadastro com um clique (RFC 8058),
// preferências, campanhas pelo painel (público certo, confirmação do número, teto diário, cancelamento), LGPD e cron diário.
// usage: bash tests/fresh.sh && node tests/api-test19.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, clearMail, codeFrom, lastCode, mailsTo, section, summary, loginCustomer } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const psql = (sql) => execFileSync('psql', [...P, '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const BASE = process.env.BASE ?? 'http://127.0.0.1:4180';
const CRON_SECRET = 'segredo-do-cron-so-de-teste-0123456789';
const STRONG = 'Caixa#Segura-2026';
const PASS = 'senha-antiga-123';
let seq = 0;
const fresh = (prefix = 'cli') => `${prefix}${++seq}@exemplo.com`;
let phoneN = 0;
const nextPhone = () => `3495${String(4000000 + ++phoneN).slice(-7)}`;
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
const prefs = (email) => JSON.parse(psql(`select coalesce((select row_to_json(p) from email_preferences p where email = ${lit(email)}), 'null'::json)`));
const messages = (where = 'true') => JSON.parse(psql(`select coalesce(json_agg(m order by m.created_at, m.id), '[]') from email_messages m where ${where}`));
const campaignMessages = (id, where = 'true') => messages(`campaign_id = ${lit(id)} and kind = 'campaign' and ${where}`);

const owner = new Client(undefined, '198.51.100.41');
await owner.login();
await owner.post('/api/admin/admins', { email: 'comum19@copocheio.local', name: 'Atendente', password: STRONG, role: 'admin' });
const staff = new Client(undefined, '198.51.100.42');
await staff.login('comum19@copocheio.local', STRONG);
const anon = new Client();

// Cadastra e confirma o e-mail pelo código. `optIn`: valor da caixa "quero receber promoções" (undefined = campo ausente).
async function signup(email, { optIn, name = 'Cliente Promo', how = 'code', client = new Client() } = {}) {
  await clearMail();
  const body = { name, email, phone: nextPhone(), password: PASS };
  if (optIn !== undefined) body.marketing_opt_in = optIn;
  const reg = await client.post('/api/account/register', body);
  if (reg.status !== 202) throw new Error(`cadastro falhou: ${reg.status} ${JSON.stringify(reg.data)}`);
  const mail = (await mailsTo(email)).find((m) => /confirm/i.test(m.subject));
  return { client, reg, mail, verify: async () => {
    if (how === 'link') {
      const token = /\/conta\/verificar\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1];
      return client.post('/api/account/verify-link', { token });
    }
    return client.post('/api/account/verify-email', { email, code: codeFrom(mail) });
  } };
}

// ------------------------------------------------------------------------------------------------
section('1. Consentimento no cadastro: a caixa vem desmarcada; marcar é só um pedido, que vale depois de provar a caixa de e-mail');
const yes = fresh('quer');
const no = fresh('nao');
const link = fresh('link');
const oldEmail = fresh('velho');
{
  const a = await signup(yes, { optIn: true });
  check('cadastro com a caixa marcada: ainda NÃO é consentimento (fica pendente)', prefs(yes)?.marketing === false && prefs(yes)?.marketing_pending_at !== null, prefs(yes));
  check('o e-mail de confirmação cita a escolha (sem isso o consentimento não vale)', /promoç/i.test(a.mail.text) && /novidades e promo/i.test(a.mail.html), a.mail.text.slice(0, 600));
  const v = await a.verify();
  check('confirmar o e-mail com o código vale como o aceite', v.status === 200, v.data);
  const p = prefs(yes);
  check('consentimento registrado com data, origem (cadastro) e versão do texto', p.marketing === true && p.marketing_consent_source === 'cadastro' && p.marketing_consent_at !== null && p.marketing_consent_text === 'v1' && p.marketing_pending_at === null, p);

  const b = await signup(no, {});
  check('sem a caixa (campo ausente): nenhum pedido pendente', prefs(no)?.marketing_pending_at == null && !/promoç/i.test(b.mail.text), prefs(no));
  await b.verify();
  check('...e depois de confirmar, continua SEM promoções', (prefs(no)?.marketing ?? false) === false);
  const c = await signup(fresh('falso'), { optIn: false });
  check('caixa explicitamente desmarcada: nada pendente', prefs(c.reg.data.email)?.marketing_pending_at == null);

  // Confirmação pelo botão do e-mail (link) também vale.
  const l = await signup(link, { optIn: true, how: 'link' });
  const lv = await l.verify();
  check('confirmar pelo link do e-mail também registra o aceite', lv.status === 200 && prefs(link)?.marketing === true && prefs(link)?.marketing_consent_source === 'cadastro', [lv.status, prefs(link)]);

  // Pedido pendente com mais de 7 dias não vale.
  const o = await signup(oldEmail, { optIn: true });
  psql(`update email_preferences set marketing_pending_at = now() - interval '8 days' where email = ${lit(oldEmail)}`);
  await o.verify();
  check('pedido pendente com mais de 7 dias NÃO vira consentimento', prefs(oldEmail)?.marketing === false, prefs(oldEmail));
}
{
  // Quem não é o dono do e-mail não consegue ligar as promoções dele.
  const victim = fresh('vitima');
  const mine = await signup(victim, { optIn: false });
  await mine.verify();
  await clearMail();
  const attack = await new Client().post('/api/account/register', { name: 'Atacante', email: victim, phone: nextPhone(), password: 'outra-senha-999', marketing_opt_in: true });
  check('cadastrar de novo um e-mail que já tem conta responde igual (202) e NÃO liga promoções nem deixa pedido pendente', attack.status === 202 && (prefs(victim)?.marketing ?? false) === false && prefs(victim)?.marketing_pending_at == null, prefs(victim));
  check('o dono da conta só recebe o aviso "você já tem uma conta" (sem código, sem promoção)', (await mailsTo(victim)).every((m) => !/promo/i.test(m.text)), (await mailsTo(victim)).map((m) => m.subject));
  // Atacante cadastra um e-mail NOVO que não é dele, marcando a caixa: o dono recebe o código com o aviso; ignorando-o, nada é ligado.
  const stranger = fresh('terceiro');
  await signup(stranger, { optIn: true });
  check('e-mail de terceiro cadastrado com a caixa marcada e NUNCA confirmado: nada é consentido', prefs(stranger)?.marketing === false);
}

// ------------------------------------------------------------------------------------------------
section('2. Preferências na conta (logado): ligar e desligar, com registro');
const acct = fresh('conta');
let me;
{
  const s = await signup(acct, { optIn: false });
  await s.verify();
  me = s.client;
  await loginCustomer(me, { email: acct, password: PASS });
  check('sem login: 401', (await anon.get('/api/account/email-preferences')).status === 401 && (await anon.patch('/api/account/email-preferences', { marketing: true })).status === 401);
  const g = await me.get('/api/account/email-preferences');
  check('começa desligado e com avisos de pedido ligados', g.status === 200 && g.data.marketing === false && g.data.notify_orders === true && /Copo Cheio/.test(g.data.consent_text), g.data);
  const on = await me.patch('/api/account/email-preferences', { marketing: true });
  check('ligar as promoções em Minha conta', on.status === 200 && on.data.marketing === true && prefs(acct).marketing_consent_source === 'conta' && prefs(acct).marketing_consent_text === 'v1', [on.data, prefs(acct)]);
  const off = await me.patch('/api/account/email-preferences', { marketing: false, notify_orders: false });
  check('desligar promoções e avisos de pedido', off.status === 200 && off.data.marketing === false && off.data.notify_orders === false && prefs(acct).marketing_unsubscribed_via === 'conta', [off.data, prefs(acct)]);
  await me.patch('/api/account/email-preferences', { notify_orders: true });
  check('valor que não é verdadeiro/falso: 400; corpo vazio: 400', (await me.patch('/api/account/email-preferences', { marketing: 'sim' })).status === 400 && (await me.patch('/api/account/email-preferences', {})).status === 400);
}

// ------------------------------------------------------------------------------------------------
section('3. Campanha: permissões e regras de conteúdo');
const good = { name: 'Promo de sexta', subject: 'Sexta com cerveja gelada na Copo Cheio', preheader: 'Ofertas só hoje', title: 'Sexta de promoção', body: 'Hoje tem cerveja gelada com preço especial.\n\nPeça pelo site e receba em casa.', cta_label: 'Ver ofertas', cta_url: 'https://copocheio-nu.vercel.app/bebidas' };
let C1;
{
  check('sem login: 401', (await anon.get('/api/admin/emails/campaigns')).status === 401);
  check('administrador comum vê a lista mas NÃO cria, edita, apaga, testa nem envia (403)', (await staff.get('/api/admin/emails/campaigns')).status === 200 && (await staff.post('/api/admin/emails/campaigns', good)).status === 403);
  const bad = [
    ['assunto com "Re:" falso', { subject: 'Re: seu pedido' }],
    ['assunto em MAIÚSCULAS', { subject: 'PROMOÇÃO IMPERDÍVEL SÓ HOJE' }],
    ['botão com link http', { cta_url: 'http://exemplo.com/oferta' }],
    ['botão com encurtador', { cta_url: 'https://bit.ly/abc123' }],
    ['botão com usuário e senha no link', { cta_url: 'https://user:pass@exemplo.com/x' }],
    ['texto do botão sem endereço', { cta_url: null }],
    ['endereço do botão sem texto', { cta_label: null }],
    ['sem título', { title: '' }],
    ['assunto com quebra de linha (injeção de cabeçalho)', { subject: 'Oi\r\nBcc: alguem@exemplo.com' }],
    ['título com quebra de linha', { title: 'Linha 1\nLinha 2' }],
  ];
  for (const [label, patch] of bad) check(`recusa: ${label}`, (await owner.post('/api/admin/emails/campaigns', { ...good, ...patch })).status === 400);
  const created = await owner.post('/api/admin/emails/campaigns', good);
  check('o owner cria a campanha como rascunho', created.status === 201 && /^[0-9a-f-]{36}$/.test(created.data.id), created.data);
  C1 = created.data.id;
  const got = await staff.get(`/api/admin/emails/campaigns/${C1}`);
  check('o rascunho aparece com o texto e zero enviados', got.status === 200 && got.data.campaign.status === 'draft' && got.data.campaign.sent === 0 && got.data.campaign.body.includes('cerveja gelada'), got.data);
  check('editar o rascunho', (await owner.patch(`/api/admin/emails/campaigns/${C1}`, { ...good, name: 'Promo de sexta (2)' })).status === 200);
  check('campanha que não existe: 404', (await owner.get('/api/admin/emails/campaigns/00000000-0000-4000-8000-000000000000')).status === 404);
}

// ------------------------------------------------------------------------------------------------
section('4. Teste de envio: vai SÓ para o e-mail de quem pediu, marcado como teste');
{
  await clearMail();
  const t = await owner.post(`/api/admin/emails/campaigns/${C1}/test`);
  check('teste enviado', t.status === 200 && t.data.to === 'dono@copocheio.local', t.data);
  const got = await mailsTo('dono@copocheio.local');
  const m = got.find((x) => /^\[Teste\]/.test(x.subject));
  check('chegou com [Teste] no assunto e o aviso de que ninguém mais recebeu', Boolean(m) && /Ninguém mais recebeu/.test(m.text), got.map((x) => x.subject));
  check('o teste de uma promoção chega com os cabeçalhos de PROMOÇÃO (descadastro de um clique) e sem "e-mail automático", como o cliente vai receber', Boolean(m) && /\/api\/email\/unsubscribe\//.test(String(m.headers['list-unsubscribe'])) && m.headers['list-unsubscribe-post'] === 'List-Unsubscribe=One-Click' && !m.headers['auto-submitted'] && !m.headers['x-auto-response-suppress'], m?.headers);
  check('o teste é registrado como "teste de campanha" (transacional), não como envio da campanha', messages(`kind = 'campaign_test'`).length === 1 && messages(`kind = 'campaign'`).length === 0);
  check('administrador comum não testa (403)', (await staff.post(`/api/admin/emails/campaigns/${C1}/test`)).status === 403);
}

// ------------------------------------------------------------------------------------------------
section('5. Público da campanha: só quem consentiu, com conta ativa e e-mail confirmado, fora da lista de supressão');
const people = {};
{
  // quer1, quer2: consentem. B: consentiu e saiu. C: nunca consentiu. D: consentiu mas está suprimido. E: consentiu mas a conta foi desativada.
  // F: só pedido pendente. G: e-mail com "marketing" ligado mas sem conta (cliente de pedido).
  for (const [key, opt] of [['quer1', true], ['quer2', true], ['saiu', true], ['nunca', false], ['suprimido', true], ['inativo', true], ['pendente', true]]) {
    people[key] = fresh(key);
    const s = await signup(people[key], { optIn: opt });
    if (key !== 'pendente') await s.verify();
  }
  psql(`insert into email_preferences (email, marketing, marketing_consent_at, marketing_consent_source, marketing_consent_text) values (${lit('visitante19@exemplo.com')}, true, now(), 'conta', 'v1')`);
  await Promise.all([people.saiu].map((e) => anon.patch(`/api/email/preferences/${prefsToken(e)}`, { marketing: false })));
  psql(`insert into email_suppressions (email, reason, source) values (${lit(people.suprimido)}, 'manual', 'admin')`);
  psql(`update customers set active = false where lower(email) = ${lit(people.inativo)}`);

  const list = await owner.get('/api/admin/emails/campaigns');
  const eligible = JSON.parse(psql(`select coalesce(json_agg(p.email order by p.email), '[]') from email_preferences p join customers c on lower(c.email) = p.email and c.active and c.email_verified_at is not null where p.marketing and not exists (select 1 from email_suppressions s where s.email = p.email and (s.expires_at is null or s.expires_at > now()))`));
  const expected = [yes, link, people.quer1, people.quer2].sort();
  check('o público é exatamente: quem consentiu (no cadastro, pelo link do e-mail) e confirmou o e-mail', JSON.stringify(eligible) === JSON.stringify(expected), [eligible, expected]);
  check('o painel mostra esse mesmo número', list.status === 200 && list.data.audience === expected.length, list.data.audience);
  check('NÃO estão: quem saiu, quem nunca consentiu, o suprimido, a conta desativada, o pedido pendente, o antigo vencido, a conta que desligou e o endereço sem conta', [people.saiu, people.nunca, people.suprimido, people.inativo, people.pendente, 'visitante19@exemplo.com', no, oldEmail, acct].every((e) => !eligible.includes(e)), eligible);
}
function prefsToken(email) {
  const p = prefs(email);
  return `${p.id}_${p.link_key}`;
}

// ------------------------------------------------------------------------------------------------
section('6. Enviar: o dono confirma o NÚMERO de destinatários; a lista que mudou é recusada');
let sent1;
{
  const audience = (await owner.get('/api/admin/emails/campaigns')).data.audience;
  check('sem confirmar o número: 409 com o número atual', (await owner.post(`/api/admin/emails/campaigns/${C1}/send`, {})).status === 409);
  const wrong = await owner.post(`/api/admin/emails/campaigns/${C1}/send`, { confirm_count: audience + 1 });
  check('número diferente do atual: 409 "a lista mudou", sem enviar nada', wrong.status === 409 && wrong.data.code === 'audience_changed' && wrong.data.audience === audience && campaignMessages(C1).length === 0, wrong.data);
  check('administrador comum não envia (403)', (await staff.post(`/api/admin/emails/campaigns/${C1}/send`, { confirm_count: audience })).status === 403);
  await clearMail();
  sent1 = await owner.post(`/api/admin/emails/campaigns/${C1}/send`, { confirm_count: audience });
  check('número certo: aceito (202) e enfileirado para todos do público', sent1.status === 202 && sent1.data.queued === audience, sent1.data);
  const done = await until(() => campaignMessages(C1).length === audience && campaignMessages(C1).every((m) => m.status === 'accepted'), 15000);
  check('todos foram aceitos pelo servidor de e-mail', Boolean(done), campaignMessages(C1).map((m) => [m.recipient_email, m.status]));
  const rows = campaignMessages(C1);
  check('promocional, uma mensagem por pessoa, chave de unicidade e receita só com o id da campanha', rows.every((m) => m.category === 'promotional' && m.kind === 'campaign' && m.dedupe_key === `campaign:${C1}:${m.recipient_email}`) && new Set(rows.map((m) => m.recipient_email)).size === rows.length, rows.slice(0, 2));
  check('a campanha termina sozinha ("concluída") com o número enviado', (await until(async () => (await owner.get(`/api/admin/emails/campaigns/${C1}`)).data.campaign.status === 'done')) && (await owner.get(`/api/admin/emails/campaigns/${C1}`)).data.campaign.sent === audience, (await owner.get(`/api/admin/emails/campaigns/${C1}`)).data);
  check('enviar de novo a mesma campanha: 409', (await owner.post(`/api/admin/emails/campaigns/${C1}/send`, { confirm_count: audience })).status === 409);
  check('editar ou apagar depois de enviada: 409', (await owner.patch(`/api/admin/emails/campaigns/${C1}`, good)).status === 409 && (await owner.del(`/api/admin/emails/campaigns/${C1}`)).status === 409);

  // O e-mail que chegou.
  const mine = (await mailsTo(yes)).find((m) => m.subject === good.subject);
  check('quem consentiu recebeu a campanha, com o assunto e o texto escritos pelo dono', Boolean(mine) && /cerveja gelada/.test(mine.text) && /Peça pelo site/.test(mine.text), (await mailsTo(yes)).map((m) => m.subject));
  check('e quem NÃO está no público não recebeu nada', (await Promise.all([people.saiu, people.nunca, people.suprimido, people.inativo, people.pendente, 'visitante19@exemplo.com'].map(mailsTo))).every((l) => !l.some((m) => m.subject === good.subject)));
  const token = `${prefs(yes).id}_${prefs(yes).link_key}`;
  check('cabeçalho de descadastro com um clique (RFC 8058): List-Unsubscribe com https e List-Unsubscribe-Post', mine.headers['list-unsubscribe']?.includes(`/api/email/unsubscribe/${token}`) && /^<https?:\/\/[^>]+>$/.test(String(mine.headers['list-unsubscribe']).trim()) && mine.headers['list-unsubscribe-post'] === 'List-Unsubscribe=One-Click', [mine.headers['list-unsubscribe'], mine.headers['list-unsubscribe-post']]);
  check('promoção NÃO é marcada como e-mail automático (Auto-Submitted) nem some com respostas', !mine.headers['auto-submitted'] && !mine.headers['x-auto-response-suppress']);
  check('o corpo traz o link "Cancelar inscrição" e o motivo de a pessoa estar recebendo', mine.html.includes(`/conta/emails/${token}`) && /Cancelar inscrição/.test(mine.text) && /pediu para receber novidades/i.test(mine.text), mine.text.slice(-600));
  check('o botão aponta DIRETO para o link escrito pelo dono (sem redirecionador de rastreio)', mine.html.includes(`href="${good.cta_url}"`) && !/track|redirect|click\./i.test(mine.html.replace(good.cta_url, '')), [...mine.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
  check('sem pixel de abertura (o envio por SMTP não rastreia aberturas)', !/<img[^>]+\b(width|height)=["']?1["']?[\s>\/]/i.test(mine.html));
  const hdrs = String(mine.from);
  check('o remetente é o da loja', /Copo Cheio/.test(hdrs) && /loja@copocheio\.test/.test(hdrs), hdrs);
}

// ------------------------------------------------------------------------------------------------
section('7. Descadastro com um clique (RFC 8058), sem login e sem cookie');
{
  const token = prefsToken(yes);
  const url = `/api/email/unsubscribe/${token}`;
  const bare = new Client();
  // Quem abre o endereço num navegador (leitores de e-mail antigos fazem GET em vez do POST do RFC 8058) vai para a página de preferências.
  // O GET nunca muda nada: programas de segurança "abrem" os links dos e-mails sozinhos.
  const peek = await fetch(`${BASE}${url}`, { redirect: 'manual', headers: { 'x-real-ip': '198.51.100.77' } });
  check('GET no endereço do descadastro: leva à página de preferências (302), sem cache, e NÃO descadastra', peek.status === 302 && peek.headers.get('location') === `/conta/emails/${token}` && peek.headers.get('cache-control') === 'no-store' && prefs(yes).marketing === true && prefs(yes).marketing_unsubscribed_at === null, [peek.status, peek.headers.get('location'), prefs(yes)]);
  check('GET com link adulterado ou inventado: 404, igual ao POST', (await fetch(`${BASE}${url.slice(0, -1)}${url.endsWith('0') ? '1' : '0'}`, { redirect: 'manual', headers: { 'x-real-ip': '198.51.100.77' } })).status === 404 && (await fetch(`${BASE}/api/email/unsubscribe/abc`, { redirect: 'manual', headers: { 'x-real-ip': '198.51.100.77' } })).status === 404);
  const r = await bare.req('POST', url, 'List-Unsubscribe=One-Click', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('o POST do provedor de caixa de entrada (form, sem cookie) cancela as promoções', r.status === 200 && r.data.ok === true && prefs(yes).marketing === false && prefs(yes).marketing_unsubscribed_via === 'one_click' && prefs(yes).marketing_unsubscribed_at !== null, [r.status, prefs(yes)]);
  check('repetir o clique é inofensivo (200)', (await bare.req('POST', url, 'List-Unsubscribe=One-Click', { raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status === 200);
  check('só as promoções param: avisos de pedido e e-mails da conta continuam', prefs(yes).notify_orders === true);
  check('link adulterado, de outro endereço ou inventado: 404 igual', (await bare.post(`/api/email/unsubscribe/${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`)).status === 404 && (await bare.post('/api/email/unsubscribe/abc')).status === 404 && (await bare.post('/api/email/unsubscribe/00000000-0000-4000-8000-000000000000_00000000000000000000000000000000')).status === 404);
  check('o descadastro tira a pessoa do público da próxima campanha', JSON.parse(psql(`select count(*) from email_preferences where email = ${lit(yes)} and marketing`)) === 0);
  const g = await anon.get(`/api/email/preferences/${token}`);
  check('a página de preferências mostra "desligado" e que ele pode voltar a ligar (conta confirmada)', g.status === 200 && g.data.marketing === false && g.data.can_enable_marketing === true, g.data);
  const back = await anon.patch(`/api/email/preferences/${token}`, { marketing: true });
  check('voltar a receber pelo próprio link do e-mail (conta confirmada)', back.status === 200 && back.data.marketing === true && prefs(yes).marketing_consent_source === 'link', [back.status, prefs(yes)]);
  await anon.post(`/api/email/unsubscribe/${token}`);
  check('e cancelar de novo', prefs(yes).marketing === false);
}

// ------------------------------------------------------------------------------------------------
section('8. Cancelamento, teto diário de promoções, descadastro no meio do envio e teto por pessoa');
const fillBudget = () =>
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, transport, attempts, accepted_at, last_attempt_at)
        select 'campaign', 'promotional', 'customer', 'preenche' || g || '@exemplo.com', 'exemplo.com', 'accepted', 'smtp', 1, now(), now() from generate_series(1, 300) g`);
const emptyBudget = () => psql(`delete from email_messages where recipient_email like 'preenche%'`);
const waitDeferred = (id, n) => until(() => campaignMessages(id).length === n && campaignMessages(id).every((m) => m.status === 'queued' && /teto diário/.test(m.error_detail ?? '')));
let C2;
{
  // 8a. Cancelar uma campanha em andamento: o que está na fila não sai. (O teto do dia está cheio, então tudo fica esperando.)
  fillBudget();
  const created = await owner.post('/api/admin/emails/campaigns', { ...good, name: 'Promo 3', subject: 'Terceira promoção cancelada' });
  const id = created.data.id;
  const audience = (await owner.get('/api/admin/emails/campaigns')).data.audience;
  await clearMail();
  await owner.post(`/api/admin/emails/campaigns/${id}/send`, { confirm_count: audience });
  check('com o teto do dia cheio, nenhuma sai: todas esperam na fila SEM gastar tentativa', Boolean(await waitDeferred(id, audience)) && campaignMessages(id).every((m) => m.attempts === 0), campaignMessages(id).map((m) => [m.status, m.attempts, m.error_detail]));
  const waitMin = Number(psql(`select extract(epoch from (min(next_attempt_at) - now())) / 60 from email_messages where campaign_id = ${lit(id)} and kind = 'campaign'`));
  check('a próxima tentativa é daqui a ~30 minutos', waitMin > 25 && waitMin < 31, waitMin);
  check('administrador comum não cancela (403)', (await staff.post(`/api/admin/emails/campaigns/${id}/cancel`)).status === 403);
  const c = await owner.post(`/api/admin/emails/campaigns/${id}/cancel`);
  check('o owner cancela: as mensagens da fila deixam de existir para o envio', c.status === 200 && c.data.stopped === audience && campaignMessages(id).every((m) => m.status === 'cancelled' && m.spec === null && m.next_attempt_at === null), [c.data, campaignMessages(id).map((m) => m.status)]);
  emptyBudget();
  await owner.post('/api/admin/emails/process');
  await new Promise((r) => setTimeout(r, 400));
  check('cancelada não envia mesmo depois que o teto liberou', (await mailsTo(people.quer1)).filter((m) => m.subject === 'Terceira promoção cancelada').length === 0);
  check('cancelar de novo: 409', (await owner.post(`/api/admin/emails/campaigns/${id}/cancel`)).status === 409);
  check('a campanha cancelada aparece como cancelada, sem enviadas', (await owner.get(`/api/admin/emails/campaigns/${id}`)).data.campaign.status === 'cancelled' && (await owner.get(`/api/admin/emails/campaigns/${id}`)).data.campaign.sent === 0);
}
{
  // 8b. Teto diário de promoções cheio: as mensagens esperam; quem se descadastra no meio do envio não recebe o resto.
  fillBudget();
  await anon.patch(`/api/email/preferences/${prefsToken(yes)}`, { marketing: true });
  const created = await owner.post('/api/admin/emails/campaigns', { ...good, name: 'Promo 2', subject: 'Segunda promoção da semana' });
  C2 = created.data.id;
  const audience = (await owner.get('/api/admin/emails/campaigns')).data.audience;
  check('o público volta a ter 4 (quem tinha saído voltou pelo link do próprio e-mail)', audience === 4, audience);
  await clearMail();
  const s = await owner.post(`/api/admin/emails/campaigns/${C2}/send`, { confirm_count: audience });
  check('campanha enfileirada com o teto do dia já cheio', s.status === 202 && s.data.queued === audience, s.data);
  check('nenhuma saiu: todas esperam, adiadas', Boolean(await waitDeferred(C2, audience)));
  check('nenhum e-mail da campanha chegou ao servidor de e-mail', (await mailsTo(yes)).filter((m) => m.subject === 'Segunda promoção da semana').length === 0);
  // Descadastro NO MEIO do envio.
  await anon.post(`/api/email/unsubscribe/${prefsToken(people.quer2)}`);
  // O dia "virou": libera o teto e apressa as mensagens.
  emptyBudget();
  psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where campaign_id = ${lit(C2)} and kind = 'campaign'`);
  for (let i = 0; i < 3; i++) await owner.post('/api/admin/emails/process');
  await until(() => campaignMessages(C2).every((m) => !['queued', 'sending'].includes(m.status)), 15000);
  const after = Object.fromEntries(campaignMessages(C2).map((m) => [m.recipient_email, m.status]));
  const quer2 = campaignMessages(C2, `recipient_email = ${lit(people.quer2)}`)[0];
  check('quem se descadastrou no meio do envio ficou "bloqueada: sem consentimento" e não recebeu', quer2?.status === 'blocked' && quer2.block_reason === 'no_consent' && (await mailsTo(people.quer2)).filter((m) => m.subject === 'Segunda promoção da semana').length === 0, after);
  check('os outros receberam normalmente (uma vez cada)', [yes, link, people.quer1].every((e) => after[e] === 'accepted') && (await mailsTo(people.quer1)).filter((m) => m.subject === 'Segunda promoção da semana').length === 1, after);
  const camp = (await until(async () => (await owner.get(`/api/admin/emails/campaigns/${C2}`)).data.campaign.status === 'done')) && (await owner.get(`/api/admin/emails/campaigns/${C2}`)).data.campaign;
  check('campanha com bloqueios termina como concluída, separando enviados e pulados', camp && camp.sent === 3 && camp.skipped === 1 && camp.pending === 0, camp);
}
{
  // 8c. Teto por pessoa: no máximo 2 promoções por dia para o mesmo endereço.
  await anon.patch(`/api/email/preferences/${prefsToken(people.quer2)}`, { marketing: true });
  const four = await owner.post('/api/admin/emails/campaigns', { ...good, name: 'Promo 4', subject: 'Quarta promoção do dia' });
  await owner.post(`/api/admin/emails/campaigns/${four.data.id}/send`, { confirm_count: (await owner.get('/api/admin/emails/campaigns')).data.audience });
  await until(() => campaignMessages(four.data.id).length > 0 && campaignMessages(four.data.id).every((m) => !['queued', 'sending'].includes(m.status)), 15000);
  const hit = campaignMessages(four.data.id, `recipient_email = ${lit(people.quer1)}`)[0];
  check('o endereço que já recebeu 2 promoções hoje fica "bloqueada: teto por endereço" e não recebe a 3ª', hit?.status === 'blocked' && hit.block_reason === 'recipient_limit' && (await mailsTo(people.quer1)).filter((m) => m.subject === 'Quarta promoção do dia').length === 0, hit);
  const fresh1 = campaignMessages(four.data.id, `recipient_email = ${lit(people.quer2)}`)[0];
  check('quem recebeu só uma recebe a seguinte (quer2 perdeu a segunda por ter saído)', fresh1?.status === 'accepted', fresh1);
}

// ------------------------------------------------------------------------------------------------
section('9. Promoção nunca bloqueia nem depende de e-mail de conta/pedido; descadastro não afeta código de login');
{
  const email = people.nunca;
  await clearMail();
  await new Client().post('/api/account/forgot-password', { email });
  check('quem nunca aceitou promoção recebe o link de nova senha (e-mail de conta não depende do consentimento)', (await mailsTo(email)).some((m) => /^Redefinir/.test(m.subject)), (await mailsTo(email)).map((m) => m.subject));
  await clearMail();
  const c = new Client();
  await loginCustomer(c, { email, password: PASS });
  check('o histórico separa as categorias: promoções são "promotional", o resto "transactional"', JSON.parse(psql(`select coalesce(json_agg(distinct category), '[]') from email_messages where kind <> 'campaign'`)).every((x) => x === 'transactional'));
}

// ------------------------------------------------------------------------------------------------
section('10. LGPD: apagar a conta (ou anonimizar) tira o endereço dos registros de e-mail');
{
  const gone = fresh('lgpd');
  const s = await signup(gone, { optIn: true });
  await s.verify();
  await loginCustomer(s.client, { email: gone, password: PASS });
  check('antes: há mensagens e preferências desse endereço', messages(`recipient_email = ${lit(gone)}`).length >= 1 && prefs(gone) !== null);
  const del = await s.client.del('/api/account', { password: PASS });
  check('o cliente apaga a própria conta', del.status === 200, del.data);
  check('depois: nenhuma mensagem guarda o endereço, nenhuma preferência, nenhuma supressão', messages(`recipient_email = ${lit(gone)}`).length === 0 && prefs(gone) === null && psql(`select count(*) from email_suppressions where email = ${lit(gone)}`) === '0');
  check('...e o endereço não aparece em nenhum lugar dos registros de e-mail', psql(`select count(*) from email_messages m where row_to_json(m)::text ilike ${lit('%' + gone + '%')}`) === '0' && psql(`select count(*) from email_events e where e.detail::text ilike ${lit('%' + gone + '%')}`) === '0');

  const byOwner = fresh('apagado');
  const s2 = await signup(byOwner, { optIn: true });
  await s2.verify();
  const customerId = psql(`select id from customers where lower(email) = ${lit(byOwner)}`);
  check('o owner exclui a conta pelo painel', (await owner.del(`/api/admin/customers/${customerId}`)).status === 200);
  check('...e os registros de e-mail daquele endereço também somem', messages(`recipient_email = ${lit(byOwner)}`).length === 0 && prefs(byOwner) === null);

  const anonymous = fresh('anonimo');
  const s3 = await signup(anonymous, { optIn: true });
  await s3.verify();
  const an = await owner.post('/api/admin/privacy/anonymize', { email: anonymous });
  check('anonimizar a pessoa a pedido dela limpa também os registros de e-mail', an.status === 200 && messages(`recipient_email = ${lit(anonymous)}`).length === 0 && prefs(anonymous) === null, an.data);

  // Limpeza automática: registros com mais de 180 dias saem; o que está na fila fica.
  const e = fresh('antigo');
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, created_at) values ('order_received', 'transactional', 'customer', ${lit(e)}, 'exemplo.com', 'accepted', now() - interval '200 days'), ('order_received', 'transactional', 'customer', ${lit(e)}, 'exemplo.com', 'queued', now() - interval '200 days')`);
  psql('select purge_expired_data()');
  check('a limpeza apaga registros com mais de 180 dias, menos os que ainda estão na fila', psql(`select string_agg(status, ',') from email_messages where recipient_email = ${lit(e)}`) === 'queued' || psql(`select count(*) from email_messages where recipient_email = ${lit(e)} and status = 'accepted'`) === '0');
}

// ------------------------------------------------------------------------------------------------
section('11. Cron diário: só com o segredo; processa a fila e faz a limpeza');
{
  const noAuth = await anon.get('/api/cron/email');
  check('sem o segredo: 401', noAuth.status === 401);
  check('segredo errado ou em outro formato: 401', (await anon.get('/api/cron/email', { headers: { authorization: 'Bearer errado' } })).status === 401 && (await anon.get('/api/cron/email', { headers: { authorization: CRON_SECRET } })).status === 401);
  psql(`insert into email_messages (kind, category, audience, recipient_email, recipient_domain, status, spec, next_attempt_at) values ('password_changed', 'transactional', 'customer', 'cron19@exemplo.com', 'exemplo.com', 'queued', ${lit(JSON.stringify({ name: 'Cron', at: new Date().toISOString() }))}::jsonb, now() - interval '1 minute')`);
  const ok = await anon.get('/api/cron/email', { headers: { authorization: `Bearer ${CRON_SECRET}` } });
  check('com o segredo: 200 e a fila é processada', ok.status === 200 && ok.data.ok === true && ok.data.queue.processed >= 1, ok.data);
  check('...a mensagem da fila saiu', (await until(async () => (await mailsTo('cron19@exemplo.com')).length === 1)) !== false);
  check('a resposta do cron nunca fica em cache', /no-store/.test(ok.headers.get('cache-control') ?? ''), ok.headers.get('cache-control'));
}

summary();
