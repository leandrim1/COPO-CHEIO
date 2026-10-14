// Regras puras do sistema de e-mails: o que fazer com cada resposta de um servidor de e-mail, espera entre tentativas, tipos de
// e-mail e configuração. Sem rede e sem banco.
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const errors = await load('server/email/errors.ts');
const kinds = await load('server/email/kinds.ts');
const config = await load('server/email/config.ts');
const { classifyFailure, redact, retryDelayMs, BACKOFF_MINUTES, TransportFailure } = errors;

// Respostas reais de servidores de e-mail (textos como o nodemailer os entrega).
const smtp = (responseCode, response, command = 'RCPT TO', code = undefined) => Object.assign(new Error(response), { responseCode, response, command, code });

test('endereço que não existe (550 5.1.1 do Gmail): devolução definitiva, não tenta de novo, suprime', () => {
  const f = classifyFailure(smtp(550, '550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the recipient\'s email address for typos. gsmtp'));
  assert.equal(f.kind, 'recipient');
  assert.equal(f.hard, true);
  assert.equal(f.retryable, false);
  assert.equal(f.code, '550 5.1.1');
});

test('o Outlook diz "destinatário não encontrado" com 5.1.10, e o Microsoft 365 com 5.4.1: ambos definitivos', () => {
  const a = classifyFailure(smtp(550, '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup'));
  const b = classifyFailure(smtp(554, '554 5.4.1 Recipient address rejected: Access denied. AS(201806281)'));
  for (const f of [a, b]) {
    assert.equal(f.kind, 'recipient');
    assert.equal(f.hard, true);
    assert.equal(f.retryable, false);
  }
});

test('caixa cheia (5.2.2) e recusas temporárias (4xx): tentam de novo e NÃO suprimem o endereço', () => {
  const full = classifyFailure(smtp(552, '552 5.2.2 Mailbox full'));
  assert.deepEqual([full.kind, full.hard, full.retryable], ['recipient', false, true]);
  const temp = classifyFailure(smtp(450, '450 4.2.1 The user you are trying to contact is receiving mail too quickly'));
  assert.deepEqual([temp.kind, temp.hard, temp.retryable], ['recipient', false, true]);
  const grey = classifyFailure(smtp(451, '451 4.7.1 Greylisted, please try again in 300 seconds', 'DATA'));
  assert.deepEqual([grey.kind, grey.hard, grey.retryable], ['temporary', false, true]);
  const busy = classifyFailure(smtp(421, '421-4.7.0 Try again later, closing connection.', 'CONN'));
  assert.deepEqual([busy.kind, busy.retryable], ['temporary', true]);
});

test('recusa por política (5.7.x: spam, autenticação do remetente, bloqueio): não é problema do endereço', () => {
  const gmail = classifyFailure(smtp(550, '550-5.7.1 Our system has detected that this message is likely unsolicited mail.', 'DATA', 'EMESSAGE'));
  const microsoft = classifyFailure(smtp(550, '550 5.7.515 Access denied, sending domain does not meet the required authentication level', 'DATA'));
  for (const f of [gmail, microsoft]) {
    assert.equal(f.kind, 'policy');
    assert.equal(f.hard, false, 'não suprime o endereço do cliente por culpa nossa');
    assert.equal(f.retryable, false);
  }
  assert.equal(microsoft.code, '550 5.7.515');
});

test('mensagem grande demais (5.3.4) e conteúdo recusado: erro de conteúdo, sem nova tentativa', () => {
  const f = classifyFailure(smtp(552, '552 5.3.4 Message size exceeds fixed limit', 'DATA'));
  assert.deepEqual([f.kind, f.retryable, f.hard], ['content', false, false]);
});

test('usuário e senha do servidor de e-mail recusados: configuração (insiste devagar, nunca suprime)', () => {
  const f = classifyFailure(Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535, response: '535-5.7.8 Username and Password not accepted', command: 'AUTH PLAIN' }));
  assert.equal(f.kind, 'auth');
  assert.equal(f.legacy, 'auth');
  assert.equal(f.retryable, true);
  assert.equal(f.hard, false);
});

test('rede fora do ar, tempo esgotado e DNS: tenta de novo', () => {
  for (const code of ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EDNS', 'EAI_AGAIN']) {
    const f = classifyFailure(Object.assign(new Error('x'), { code }));
    assert.deepEqual([f.kind, f.retryable, f.legacy], ['network', true, 'network'], code);
  }
});

test('sem código estendido: 5xx no destinatário é "caixa inexistente"; depois do conteúdo é política; o resto é erro comum', () => {
  assert.deepEqual(((f) => [f.kind, f.hard])(classifyFailure(smtp(550, '550 caixa postal inexistente'))), ['recipient', true]);
  assert.deepEqual(((f) => [f.kind, f.hard, f.retryable])(classifyFailure(smtp(552, '552 over quota'))), ['recipient', false, true]);
  assert.equal(classifyFailure(smtp(554, '554 transaction failed', 'DATA')).kind, 'policy');
  const other = classifyFailure(smtp(503, '503 bad sequence of commands', 'MAIL FROM'));
  assert.deepEqual([other.kind, other.retryable], ['other', false]);
});

test('endereço mal formado (EENVELOPE sem resposta do servidor): definitivo', () => {
  const f = classifyFailure(Object.assign(new Error('No recipients defined'), { code: 'EENVELOPE' }));
  assert.deepEqual([f.kind, f.hard, f.retryable], ['recipient', true, false]);
});

test('erro desconhecido: tenta de novo (pode ser passageiro) e nunca explode', () => {
  for (const input of [new Error('algo estranho'), null, undefined, 'texto solto', {}]) {
    const f = classifyFailure(input);
    assert.equal(typeof f.detail, 'string');
    assert.equal(f.hard, false);
  }
  assert.equal(classifyFailure(new Error('algo estranho')).retryable, true);
});

test('o motivo guardado NUNCA leva endereço de e-mail, e tem tamanho limitado', () => {
  const f = classifyFailure(smtp(550, '550 5.1.1 <maria.silva@gmail.com>: Recipient address rejected: User unknown in virtual mailbox table para joao+teste@empresa.com.br'));
  assert.doesNotMatch(f.detail, /@/);
  assert.match(f.detail, /<e-mail>/);
  assert.ok(redact('x'.repeat(1000)).length <= 200);
  assert.equal(redact('a   b\n\tc'), 'a b c');
});

test('um transporte que já classificou o próprio erro passa direto', () => {
  const own = { kind: 'config', retryable: true, hard: false, code: 'HTTP 403', detail: 'domínio não verificado', legacy: 'auth' };
  assert.equal(classifyFailure(new TransportFailure(own)), own);
});

test('espera entre tentativas: 2 min, 10 min, 1 h, 4 h, 12 h; erro de usuário/senha espera 1 h; com variação de ±10%', () => {
  assert.deepEqual(BACKOFF_MINUTES, [2, 10, 60, 240, 720]);
  const mid = (attempt, kind) => retryDelayMs(attempt, kind, 0.5) / 60_000;
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => mid(n, 'temporary')), [2, 10, 60, 240, 720]);
  assert.equal(mid(9, 'network'), 720, 'passou do fim da tabela: continua em 12 h');
  assert.equal(mid(1, 'auth'), 60);
  assert.equal(mid(3, 'config'), 60);
  for (const n of [1, 3, 5]) {
    const min = retryDelayMs(n, 'temporary', 0) / 60_000;
    const max = retryDelayMs(n, 'temporary', 1) / 60_000;
    const base = BACKOFF_MINUTES[n - 1];
    assert.ok(Math.abs(min - base * 0.9) < 0.01 && Math.abs(max - base * 1.1) < 0.01, `tentativa ${n}`);
  }
});

// ---- Tipos de e-mail -------------------------------------------------------------------------------------

test('os tipos com segredo (código, link de senha) são "sync" e nunca guardam o assunto; promoções são "queued" e exigem consentimento', () => {
  const { KINDS, GROUP_DAY, RECIPIENT_HARD_DAY, isKind } = kinds;
  const names = Object.keys(KINDS);
  assert.ok(names.length >= 15);
  for (const [name, def] of Object.entries(KINDS)) {
    assert.ok(def.label && def.label.length > 3, `${name}: tem nome em português`);
    assert.ok(['transactional', 'promotional'].includes(def.category), name);
    assert.ok(['customer', 'staff'].includes(def.audience), name);
    if (def.sensitive) assert.equal(def.mode, 'sync', `${name}: com segredo nunca entra na fila`);
    if (def.mode === 'sync') assert.equal(def.maxAttempts, 1, `${name}: sync tenta uma vez`);
    assert.ok(def.perRecipientDay >= 1 && def.perRecipientDay <= RECIPIENT_HARD_DAY, `${name}: teto por destinatário`);
    if (def.group) assert.ok(def.perRecipientDay <= GROUP_DAY[def.group], `${name}: o teto do tipo cabe no do grupo`);
  }
  for (const name of ['verification', 'password_reset', 'mail_test']) assert.equal(KINDS[name].sensitive, true, name);
  assert.equal(KINDS.campaign.category, 'promotional');
  assert.equal(names.filter((n) => KINDS[n].category === 'promotional').length, 1, 'só a campanha é promocional (o teste de campanha é transacional/equipe)');
  assert.equal(KINDS.campaign_test.audience, 'staff');
  for (const name of names.filter((n) => n.startsWith('order_') || n.startsWith('payment_'))) {
    assert.equal(KINDS[name].group, 'order', name);
    assert.equal(KINDS[name].respectsOrderPref, true, name);
    assert.equal(KINDS[name].checkDomain, true, `${name}: o e-mail digitado no pedido ninguém confirmou`);
  }
  assert.equal(isKind('verification'), true);
  assert.equal(isKind('toString'), false);
  assert.equal(isKind('__proto__'), false);
});

// ---- Configuração ----------------------------------------------------------------------------------------

const withEnv = (vars, fn) => {
  const saved = {};
  for (const name of Object.keys(vars)) saved[name] = process.env[name];
  for (const [name, value] of Object.entries(vars)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : (process.env[name] = value);
  }
};
const SMTP = { SMTP_HOST: 'smtp.exemplo.com', SMTP_USER: 'loja@exemplo.com', SMTP_PASS: 'x', MAIL_FROM: undefined, EMAIL_DAILY_LIMIT: undefined, EMAIL_PROMO_DAILY_LIMIT: undefined, MAIL_REPLY_TO: undefined, EMAIL_PROVIDER: undefined };

test('o remetente é lido de "Nome <endereço>" ou do endereço puro', () => {
  assert.deepEqual(config.parseFrom('Copo Cheio <Loja@Exemplo.com.br>'), { display: 'Copo Cheio', email: 'loja@exemplo.com.br', domain: 'exemplo.com.br' });
  assert.deepEqual(config.parseFrom('"Copo Cheio" <loja@exemplo.com.br>'), { display: 'Copo Cheio', email: 'loja@exemplo.com.br', domain: 'exemplo.com.br' });
  assert.deepEqual(config.parseFrom('loja@exemplo.com.br'), { display: '', email: 'loja@exemplo.com.br', domain: 'exemplo.com.br' });
  for (const bad of ['', null, undefined, 'sem arroba', 'a@b']) assert.equal(config.parseFrom(bad), null, String(bad));
});

test('teto diário: Gmail = 450 (conta pessoal manda ~500/dia), outros = sem teto, e a variável manda em tudo', () => {
  assert.equal(withEnv({ ...SMTP, SMTP_HOST: 'smtp.gmail.com' }, () => config.dailyLimit()), 450);
  assert.equal(withEnv({ ...SMTP, SMTP_HOST: 'smtp.gmail.com', EMAIL_DAILY_LIMIT: '100' }, () => config.dailyLimit()), 100);
  assert.equal(withEnv(SMTP, () => config.dailyLimit()), 0);
  assert.equal(withEnv({ ...SMTP, EMAIL_DAILY_LIMIT: '0' }, () => config.dailyLimit()), 0);
  assert.equal(withEnv({ ...SMTP, EMAIL_DAILY_LIMIT: 'abc' }, () => config.dailyLimit()), 0, 'valor inválido é ignorado');
});

test('promoções usam 40% do teto diário (ou 300 sem teto), e a variável manda', () => {
  assert.equal(withEnv({ ...SMTP, SMTP_HOST: 'smtp.gmail.com' }, () => config.promoDailyLimit()), 180);
  assert.equal(withEnv(SMTP, () => config.promoDailyLimit()), 300);
  assert.equal(withEnv({ ...SMTP, EMAIL_PROMO_DAILY_LIMIT: '25' }, () => config.promoDailyLimit()), 25);
});

test('remetente de provedor gratuito é detectado (não existe domínio da loja para autenticar)', () => {
  assert.equal(withEnv({ ...SMTP, MAIL_FROM: 'Copo Cheio <copocheio@gmail.com>' }, () => config.sendsFromFreemail()), true);
  assert.equal(withEnv({ ...SMTP, MAIL_FROM: 'Copo Cheio <loja@copocheio.com.br>' }, () => config.sendsFromFreemail()), false);
  assert.equal(withEnv({ ...SMTP, SMTP_USER: 'copocheio@hotmail.com' }, () => config.sendsFromFreemail()), true);
});

test('Reply-To só vale se for um endereço; o transporte é SMTP, a menos que se peça a Resend', () => {
  assert.equal(withEnv({ ...SMTP, MAIL_REPLY_TO: 'contato@exemplo.com' }, () => config.replyTo()), 'contato@exemplo.com');
  assert.equal(withEnv({ ...SMTP, MAIL_REPLY_TO: 'lixo' }, () => config.replyTo()), undefined);
  assert.equal(withEnv(SMTP, () => config.transportName()), 'smtp');
  assert.equal(withEnv({ ...SMTP, EMAIL_PROVIDER: 'Resend' }, () => config.transportName()), 'resend');
  assert.equal(withEnv({ ...SMTP, EMAIL_PROVIDER: 'qualquer' }, () => config.transportName()), 'smtp');
});
