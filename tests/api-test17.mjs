// E-mails: registro de cada mensagem, falhas do servidor de e-mail (definitiva, temporária, de configuração, de política), fila com nova
// tentativa, lista de supressão e painel. API real contra Postgres local + SMTP de mentira.
// usage: bash tests/fresh.sh && node tests/api-test17.mjs
import { execFileSync } from 'node:child_process';
import { Client, check, clearMail, mailMode, mailStats, mailsTo, registerVerified, section, summary } from './lib.mjs';

const P = ['-h', '127.0.0.1', '-p', '5433', '-U', 'postgres', '-d', 'copocheio_test', '-tAq', '-v', 'ON_ERROR_STOP=1'];
const psql = (sql) => execFileSync('psql', [...P, '-c', sql], { encoding: 'utf8' }).trim();
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const STRONG = 'Caixa#Segura-2026';
const PASS = 'senha-antiga-123';
const NEW = 'senha-nova-456';
let seq = 0;
const fresh = (prefix = 'em') => `${prefix}${++seq}@exemplo.com`;
const rows = (where = 'true') => JSON.parse(psql(`select coalesce(json_agg(m order by m.created_at), '[]') from email_messages m where ${where}`));
const row = (where) => rows(where)[0];
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

const owner = new Client(undefined, '198.51.100.17');
await owner.login();
await owner.post('/api/admin/admins', { email: 'comum17@copocheio.local', name: 'Atendente', password: STRONG, role: 'admin' });
const staff = new Client(undefined, '198.51.100.18');
await staff.login('comum17@copocheio.local', STRONG);
const anon = new Client();

// ------------------------------------------------------------------------------------------------
section('1. Cada e-mail enviado vira um registro (sem código, link, corpo nem receita)');
const email1 = fresh();
await clearMail();
const reg = await new Client().post('/api/account/register', { name: 'Ana Registro', email: email1, phone: '34999990001', password: PASS });
check('cadastro: 202', reg.status === 202, reg.data);
const mail1 = (await mailsTo(email1))[0];
const code1 = /\b(\d{6})\b/.exec(mail1?.text ?? '')?.[1];
const link1 = /\/conta\/verificar\/([A-Za-z0-9_-]+)/.exec(mail1?.text ?? '')?.[1];
check('o e-mail saiu com código e link', Boolean(code1 && link1), mail1?.subject);
const r1 = row(`recipient_email = ${lit(email1)}`);
check('registro criado: tipo verification, transacional, para o cliente', r1?.kind === 'verification' && r1.category === 'transactional' && r1.audience === 'customer', r1);
check('aceito pelo servidor SMTP, 1 tentativa, pelo transporte smtp', r1?.status === 'accepted' && r1.attempts === 1 && r1.transport === 'smtp' && r1.accepted_at !== null, r1);
check('o assunto NÃO é guardado (tem o código): só o nome do tipo', r1?.subject === 'Confirmação de e-mail (código)' && !String(r1.subject).includes(code1), r1?.subject);
check('o Message-ID é nosso (<id do registro@domínio do remetente>) e é o mesmo do e-mail que saiu', r1?.message_id === `<${r1.id}@copocheio.test>` && mail1.headers['message-id'] === r1.message_id, [r1?.message_id, mail1.headers['message-id']]);
check('sem receita (spec) guardada: o tipo tem segredo', r1?.spec === null);
check('domínio do destinatário guardado para as estatísticas', r1?.recipient_domain === 'exemplo.com');
const everything = psql(`select string_agg(row_to_json(m)::text, ' ') from email_messages m`) + psql(`select coalesce(string_agg(row_to_json(e)::text, ' '), '') from email_events e`);
check('o código e o link do e-mail não aparecem em lugar nenhum do registro nem dos eventos', !everything.includes(code1) && !everything.includes(link1), 'vazou');
check('transacional: e-mail automático (Auto-Submitted) e sem List-Unsubscribe', mail1.headers['auto-submitted'] === 'auto-generated' && !mail1.headers['list-unsubscribe']);
const ev1 = JSON.parse(psql(`select json_agg(e order by e.occurred_at) from email_events e where e.message_id = ${lit(r1.id)}`));
check('linha do tempo: 1 evento "accepted" da tentativa 1', ev1?.length === 1 && ev1[0].type === 'accepted' && ev1[0].provider === 'smtp' && ev1[0].detail?.attempt === 1, ev1);

// ------------------------------------------------------------------------------------------------
section('2. Painel: histórico e permissões');
{
  check('sem login: 401', (await anon.get('/api/admin/emails/messages')).status === 401);
  const list = await staff.get('/api/admin/emails/messages');
  check('administrador comum vê o histórico', list.status === 200 && list.data.messages.some((m) => m.id === r1.id), list.data);
  const m = list.data.messages.find((x) => x.id === r1.id);
  check('a linha traz o nome do tipo em português, o estado e o destinatário', m.kind_label === 'Confirmação de e-mail (código)' && m.status === 'accepted' && m.recipient_email === email1, m);
  const keys = Object.keys(m);
  check('a lista nunca traz corpo, receita nem segredo', !keys.some((k) => /^(spec|html|text|body|code|token|link)/.test(k)), keys);
  const detail = await staff.get(`/api/admin/emails/messages/${r1.id}`);
  check('detalhe com a linha do tempo', detail.status === 200 && detail.data.events.length === 1 && detail.data.message.message_id === r1.message_id, detail.data);
  check('filtro por status, tipo e busca por e-mail', (await staff.get('/api/admin/emails/messages?status=failed&kind=verification')).data.messages.every((x) => x.status === 'failed' && x.kind === 'verification') && (await staff.get(`/api/admin/emails/messages?q=${email1}`)).data.messages.length === 1);
  check('filtro inválido: 400', (await staff.get('/api/admin/emails/messages?status=xyz')).status === 400 && (await staff.get('/api/admin/emails/messages?kind=xyz')).status === 400 && (await staff.get('/api/admin/emails/messages?from=ontem')).status === 400);
  check('administrador comum NÃO reenvia, cancela, processa a fila nem mexe na lista de supressão (403)',
    (await staff.post(`/api/admin/emails/messages/${r1.id}/retry`)).status === 403 && (await staff.post(`/api/admin/emails/messages/${r1.id}/cancel`)).status === 403 && (await staff.post('/api/admin/emails/process')).status === 403 &&
      (await staff.post('/api/admin/emails/suppressions', { email: 'x@exemplo.com' })).status === 403 && (await staff.del('/api/admin/emails/suppressions/x%40exemplo.com')).status === 403);
  check('mensagem que não existe: 404', (await staff.get('/api/admin/emails/messages/00000000-0000-4000-8000-000000000000')).status === 404);
}

// ------------------------------------------------------------------------------------------------
section('3. Endereço inexistente (550 5.1.1): devolução definitiva suprime o endereço e nada mais é tentado');
const bad = 'naoexiste-17@exemplo.com';
{
  await clearMail();
  const before = await mailStats();
  const r = await new Client().post('/api/account/register', { name: 'Caixa Inexistente', email: bad, phone: '34999990002', password: PASS });
  check('cadastro com endereço que o servidor recusa: 400 (mensagem clara)', r.status === 400 && r.data.code === 'mail_recipient_rejected', r.data);
  const f = row(`recipient_email = ${lit(bad)}`);
  check('registro: failed, destinatário, devolução definitiva (hard) com o código SMTP', f?.status === 'failed' && f.error_kind === 'recipient' && f.bounce_type === 'hard' && /550 5\.1\.1/.test(f.error_code), f);
  check('o motivo guardado não tem endereço de e-mail', !/@/.test(f.error_detail ?? ''), f?.error_detail);
  const sup = JSON.parse(psql(`select row_to_json(s) from email_suppressions s where email = ${lit(bad)}`) || 'null');
  check('o endereço entrou na lista de supressão (hard_bounce, visto pelo SMTP)', sup?.reason === 'hard_bounce' && sup.source === 'smtp', sup);
  const afterFirst = await mailStats();
  check('o servidor de e-mail foi procurado 1 vez', afterFirst.rcpt === before.rcpt + 1, [before, afterFirst]);
  // Segunda tentativa: nem chega ao servidor.
  const again = await new Client().post('/api/account/register', { name: 'Caixa Inexistente', email: bad, phone: '34999990002', password: PASS });
  const afterSecond = await mailStats();
  check('segunda tentativa: 400 sem procurar o servidor de e-mail de novo (já está na lista)', again.status === 400 && afterSecond.rcpt === afterFirst.rcpt, [again.status, afterFirst, afterSecond]);
  const blocked = rows(`recipient_email = ${lit(bad)} and status = 'blocked'`);
  check('...e o registro mostra "bloqueada: endereço suprimido"', blocked.length === 1 && blocked[0].block_reason === 'suppressed', blocked);
  const sups = await staff.get('/api/admin/emails/suppressions');
  check('a lista de supressão aparece no painel (administrador comum só vê)', sups.status === 200 && sups.data.suppressions.some((s) => s.email === bad && s.reason === 'hard_bounce'), sups.data);
  // O owner tira o endereço da lista (ex.: a caixa foi criada depois).
  check('owner tira o endereço da lista', (await owner.del(`/api/admin/emails/suppressions/${encodeURIComponent(bad)}`)).status === 200 && psql(`select count(*) from email_suppressions where email = ${lit(bad)}`) === '0');
  check('tirar de novo: 404', (await owner.del(`/api/admin/emails/suppressions/${encodeURIComponent(bad)}`)).status === 404);
  const log = (await owner.get('/api/admin/audit?limit=30')).data.entries.map((e) => e.summary).join(' | ');
  check('a ação do owner fica no histórico de atividades', /Tirou um endereço da lista de supressão/.test(log), log);
}

// ------------------------------------------------------------------------------------------------
section('4. Falha temporária: o aviso de segurança NÃO se perde, volta para a fila e sai na nova tentativa');
const acct = fresh('senha');
{
  const c = new Client();
  await registerVerified(c, { name: 'Bia Senha', email: acct, phone: '34999990003', password: PASS });
  await clearMail();
  const forgot = await new Client().post('/api/account/forgot-password', { email: acct });
  check('pede o link de nova senha', forgot.status === 200);
  const token = /\/conta\/redefinir\/([A-Za-z0-9_-]+)/.exec((await mailsTo(acct)).find((m) => /^Redefinir/.test(m.subject))?.text ?? '')?.[1];
  check('link de redefinição recebido', Boolean(token));
  await mailMode('temp'); // o servidor de e-mail passa a responder 451 (tente mais tarde)
  const done = await new Client().post('/api/account/reset', { token, password: NEW });
  check('a senha foi trocada mesmo com o servidor de e-mail com problema (200)', done.status === 200, done.data);
  const q = row(`recipient_email = ${lit(acct)} and kind = 'password_changed'`);
  check('o aviso "senha alterada" ficou na fila (queued), com tentativa 1, motivo temporário e hora da próxima', q?.status === 'queued' && q.attempts === 1 && q.error_kind === 'recipient' && /451/.test(q.error_code) && q.next_attempt_at !== null, q);
  const waitMin = Number(psql(`select extract(epoch from (next_attempt_at - now())) / 60 from email_messages where id = ${lit(q.id)}`));
  check('a próxima tentativa é daqui a ~2 minutos (espera crescente: 2 min na primeira)', waitMin > 1.5 && waitMin < 2.6, waitMin);
  check('a receita foi guardada (para refazer o e-mail) e só tem o nome e a data', JSON.stringify(Object.keys(q.spec).sort()) === JSON.stringify(['at', 'name']), q.spec);
  check('nenhum e-mail "senha alterada" saiu ainda', (await mailsTo(acct)).filter((m) => /^Sua senha foi alterada/.test(m.subject)).length === 0);
  // Ainda não é hora: processar não faz nada.
  const early = await owner.post('/api/admin/emails/process');
  check('antes da hora, processar a fila não pega a mensagem', early.status === 200 && early.data.processed === 0, early.data);
  // O servidor volta; a hora chega.
  await mailMode(null);
  psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where id = ${lit(q.id)}`);
  const run = await owner.post('/api/admin/emails/process');
  check('na hora, o owner processa a fila: 1 mensagem, 1 aceita', run.status === 200 && run.data.processed === 1 && run.data.accepted === 1, run.data);
  const sent = (await mailsTo(acct)).filter((m) => /^Sua senha foi alterada/.test(m.subject));
  check('o e-mail saiu na segunda tentativa (refeito a partir da receita, com o nome)', sent.length === 1 && /Bia/.test(sent[0].text), sent.map((m) => m.subject));
  const after = row(`id = ${lit(q.id)}`);
  check('registro: accepted na tentativa 2, receita apagada, sem erro', after.status === 'accepted' && after.attempts === 2 && after.spec === null && after.error_kind === null && after.error_code === null, after);
  const ev = JSON.parse(psql(`select json_agg(e.type order by e.occurred_at) from email_events e where e.message_id = ${lit(q.id)}`));
  check('linha do tempo: tentativa 1 adiada (deferred), tentativa 2 aceita', JSON.stringify(ev) === JSON.stringify(['deferred', 'accepted']), ev);
  check('processar de novo não reenvia (nada vencido)', (await owner.post('/api/admin/emails/process')).data.processed === 0 && (await mailsTo(acct)).filter((m) => /^Sua senha foi alterada/.test(m.subject)).length === 1);
}

// ------------------------------------------------------------------------------------------------
section('5. Falhas do servidor de e-mail: configuração (usuário/senha), recusa por política e esgotar tentativas');
{
  // 5.1 Usuário/senha recusados: espera longa (1 h), não suprime ninguém, avisa pela fila
  const who = fresh('auth');
  const c = new Client();
  await registerVerified(c, { name: 'Caio Auth', email: who, phone: '34999990004', password: PASS });
  await mailMode('auth');
  await owner.post('/api/admin/customers/' + (await owner.get(`/api/admin/customers?q=${who}`)).data.customers[0].id + '/reset-link');
  const q = row(`recipient_email = ${lit(who)} and kind = 'admin_reset_notice'`);
  check('aviso do link de nova senha com "usuário/senha recusados": fica na fila com erro de configuração (auth)', q?.status === 'queued' && q.error_kind === 'auth', q);
  const waitMin = Number(psql(`select extract(epoch from (next_attempt_at - now())) / 60 from email_messages where id = ${lit(q.id)}`));
  check('...e espera ~1 hora para tentar de novo (não adianta insistir em configuração errada)', waitMin > 50 && waitMin < 70, waitMin);
  check('...sem suprimir o endereço do cliente (o erro é nosso, não dele)', psql(`select count(*) from email_suppressions where email = ${lit(who)}`) === '0');
  await mailMode(null);

  // 5.2 Recusa por política depois do conteúdo (5.7.1): falha de vez, sem suprimir, sem nova tentativa
  const pol = 'policy-17@exemplo.com';
  psql(`insert into customers (name, email, phone, password_hash, email_verified_at) values ('Paulo Política', ${lit(pol)}, '34999990005', 'x', now())`);
  const dup = await new Client().post('/api/account/register', { name: 'Outro', email: pol, phone: '34999990006', password: PASS });
  check('cadastro de e-mail que já tem conta: mesma resposta de sempre (202)', dup.status === 202, dup.data);
  const p = row(`recipient_email = ${lit(pol)} and kind = 'already_registered'`);
  check('aviso "você já tem conta" recusado por política (5.7.1): failed, tipo policy, sem nova tentativa', p?.status === 'failed' && p.error_kind === 'policy' && /554 5\.7\.1/.test(p.error_code) && p.bounce_type === 'policy', p);
  check('...sem suprimir (política do servidor de destino não é problema do endereço)', psql(`select count(*) from email_suppressions where email = ${lit(pol)}`) === '0');

  // 5.3 Esgotar as tentativas: caixa cheia (5.2.2) muda de ideia 4 vezes e desiste; owner pode reenviar
  const full = 'full-17@exemplo.com';
  psql(`insert into customers (name, email, phone, password_hash, email_verified_at) values ('Cheia', ${lit(full)}, '34999990007', 'x', now())`);
  await new Client().post('/api/account/register', { name: 'Outro', email: full, phone: '34999990008', password: PASS });
  let f = row(`recipient_email = ${lit(full)} and kind = 'already_registered'`);
  check('caixa cheia (5.2.2): temporário, volta para a fila (não suprime)', f?.status === 'queued' && f.error_kind === 'recipient' && /552 5\.2\.2/.test(f.error_code), f);
  for (let i = 2; i <= 4; i++) {
    psql(`update email_messages set next_attempt_at = now() - interval '1 minute' where id = ${lit(f.id)}`);
    await owner.post('/api/admin/emails/process');
    f = row(`id = ${lit(f.id)}`);
  }
  check('depois da 4ª tentativa (limite do tipo) desiste: failed, e a receita continua para um reenvio manual', f.status === 'failed' && f.attempts === 4 && f.spec !== null, f);
  check('...sem suprimir o endereço', psql(`select count(*) from email_suppressions where email = ${lit(full)}`) === '0');
  const retry = await owner.post(`/api/admin/emails/messages/${f.id}/retry`);
  check('o owner manda reenviar: volta para a fila com as tentativas zeradas', retry.status === 200 && row(`id = ${lit(f.id)}`).status === 'queued' && row(`id = ${lit(f.id)}`).attempts === 0);
  const cancel = await owner.post(`/api/admin/emails/messages/${f.id}/cancel`);
  check('...e cancelar (a caixa continua cheia): cancelada e a receita some', cancel.status === 200 && row(`id = ${lit(f.id)}`).status === 'cancelled' && row(`id = ${lit(f.id)}`).spec === null);
  check('reenviar uma mensagem que não falhou: 409', (await owner.post(`/api/admin/emails/messages/${r1.id}/retry`)).status === 409);
}

// ------------------------------------------------------------------------------------------------
section('6. Segredo nunca no registro, e o registro nunca atrapalha o código de login');
{
  const everythingNow = psql(`select string_agg(row_to_json(m)::text, ' ') from email_messages m`) + ' ' + psql(`select string_agg(row_to_json(e)::text, ' ') from email_events e`);
  check('nenhum registro tem as senhas dos testes', !everythingNow.includes(PASS) && !everythingNow.includes(NEW) && !everythingNow.includes('secret'));
  check('nenhum registro guarda endereço dentro do motivo da falha', !/@/.test(psql(`select coalesce(string_agg(coalesce(error_detail, ''), ' '), '') from email_messages`)));
  // Se o banco do registro falhar, o código de login sai do mesmo jeito.
  psql(`alter table email_messages add constraint quebra_17 check (false) not valid`);
  try {
    const who = fresh('quebra');
    await clearMail();
    const r = await new Client().post('/api/account/register', { name: 'Registro Quebrado', email: who, phone: '34999990009', password: PASS });
    check('com a tabela de registro quebrada, o cadastro funciona e o código de confirmação chega (202)', r.status === 202 && (await mailsTo(who)).length === 1, [r.status, r.data]);
  } finally {
    psql('alter table email_messages drop constraint quebra_17');
  }
}

summary();
