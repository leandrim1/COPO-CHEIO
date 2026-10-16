// E-mail de QUALQUER provedor: nada no cadastro/login pode preferir o Gmail nem barrar um provedor só por ele ser pouco conhecido.
// Cobre o formato do endereço, a lista de e-mails descartáveis (só barra serviço de e-mail temporário), as mensagens, a dica de erro de digitação
// e quais e-mails passam por cima de uma devolução automática antiga (só os códigos/links que a própria pessoa pediu).
import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from './load.mjs';

const addr = await load('server/emailAddress.ts');
const dom = await load('server/mailDomain.ts');
const kinds = await load('server/email/kinds.ts');
const hint = await load('src/site/emailHint.ts');
const login = await load('server/loginCode.ts');
const adminCode = await load('server/adminLoginCode.ts');

const PROVIDERS = `gmail.com googlemail.com icloud.com me.com mac.com outlook.com outlook.com.br hotmail.com hotmail.com.br live.com live.com.br msn.com yahoo.com yahoo.com.br ymail.com rocketmail.com aol.com uol.com.br bol.com.br terra.com.br globo.com globomail.com ig.com.br oi.com.br r7.com zipmail.com.br click21.com.br
proton.me protonmail.com pm.me tutanota.com tuta.com tutamail.com tuta.io zoho.com zohomail.com gmx.com gmx.net gmx.de web.de mail.com mail.ru yandex.com yandex.ru fastmail.com fastmail.fm hey.com mailbox.org posteo.de runbox.com startmail.com hushmail.com
duck.com simplelogin.com anonaddy.com privaterelay.appleid.com mozmail.com 126.com 163.com qq.com sina.com naver.com daum.net hanmail.net rediffmail.com orange.fr free.fr laposte.net sfr.fr wanadoo.fr libero.it virgilio.it t-online.de freenet.de btinternet.com sky.com virginmedia.com comcast.net verizon.net att.net sbcglobal.net cox.net charter.net bellsouth.net earthlink.net optonline.net shaw.ca rogers.com telus.net bigpond.com optusnet.com.au
copocheio.com.br minhaempresa.com.br escola.edu.br prefeitura.sp.gov.br universidade.edu usp.br ufmg.br gov.br empresa.com contabilidade.net.br meusite.dev startup.io agencia.digital loja.shop mail.xyz exemplo.app pequena-padaria-do-ze.com.br advogados-associados.adv.br clinica.med.br correio.pt mail.co.uk posta.it`.split(/\s+/).filter(Boolean);

test(`formato: ${PROVIDERS.length} domínios de provedores e empresas são aceitos (minúsculas, maiúsculas e com +etiqueta)`, () => {
  assert.ok(PROVIDERS.length >= 100, String(PROVIDERS.length));
  for (const domain of PROVIDERS) {
    assert.equal(addr.parseEmail(`maria.silva@${domain}`).email, `maria.silva@${domain}`, domain);
    assert.equal(addr.parseEmail(`Maria_Silva+loja@${domain.toUpperCase()}`).email, `maria_silva+loja@${domain}`, domain);
  }
});

test('descartáveis: nenhum provedor legítimo está na lista de e-mail temporário', () => {
  const flagged = PROVIDERS.filter((domain) => dom.isDisposableDomain(domain));
  assert.deepEqual(flagged, []);
  // ...e o que é realmente temporário continua barrado (inclusive subdomínio e maiúsculas).
  for (const domain of ['mailinator.com', 'guerrillamail.com', 'sub.mailinator.com', 'MAILINATOR.COM'.toLowerCase()]) assert.equal(dom.isDisposableDomain(domain), true, domain);
});

test('formato: o que é recusado continua recusado (não relaxa a segurança para aceitar mais provedores)', () => {
  for (const bad of ['abc', 'maria@', '@gmail.com', 'maria@gmail', 'maria..s@gmail.com', '.maria@gmail.com', 'maria.@gmail.com', 'a b@gmail.com', 'maria@[10.0.0.1]', '"maria"@gmail.com', 'maria@my_domain.com', 'maria@gmail.c', 'a@b@c.com']) {
    assert.throws(() => addr.parseEmail(bad), (e) => e.status === 400 && e.extra?.code === 'invalid_email', bad);
  }
});

test('domínio com acento vira punycode, igual na internet (e o mesmo endereço digitado de outro jeito dá o mesmo resultado)', () => {
  assert.equal(addr.parseEmail('rita@münchen.de').email, 'rita@xn--mnchen-3ya.de');
  assert.equal(addr.parseEmail('RITA@MÜNCHEN.DE').email, 'rita@xn--mnchen-3ya.de');
  assert.equal(addr.parseEmail('rita​@gmail.com').email, 'rita@gmail.com'); // caractere invisível colado pelo teclado do celular
});

test('mensagens de erro: nenhuma privilegia um provedor (sem Gmail/Outlook/Yahoo) e todas dizem que qualquer provedor vale quando falam de provedor', () => {
  const texts = [...Object.values(dom.DOMAIN_MESSAGE)];
  for (const bad of ['abc', 'maria@gmail']) {
    try {
      addr.parseEmail(bad);
    } catch (error) {
      texts.push(error.message);
    }
  }
  for (const text of texts) assert.doesNotMatch(text, /gmail|outlook|hotmail|yahoo|icloud/i, text);
  assert.match(dom.DOMAIN_MESSAGE.disposable, /qualquer provedor/);
  assert.match(dom.DOMAIN_MESSAGE.disposable, /temporários ou descartáveis/);
});

test('máscara: mostra só a primeira letra e o domínio inteiro, para qualquer provedor', () => {
  assert.equal(addr.maskEmail('maria.silva@icloud.com'), 'm***@icloud.com');
  assert.equal(addr.maskEmail('joao@mail.loja-do-joao.com.br'), 'j***@mail.loja-do-joao.com.br');
  assert.doesNotMatch(addr.maskEmail('maria.silva@hotmail.com'), /maria|silva/);
});

test('dica de erro de digitação: sugere o provedor popular certo, e SÓ sugere (qualquer outro endereço passa em branco)', () => {
  const typos = {
    'maria@gmial.com': 'maria@gmail.com',
    'maria@gmai.com': 'maria@gmail.com',
    'maria@gamil.com': 'maria@gmail.com',
    'maria@gmail.con': 'maria@gmail.com',
    'maria@gmail.com.br': 'maria@gmail.com',
    'maria@hotmial.com': 'maria@hotmail.com',
    'maria@hotnail.com': 'maria@hotmail.com',
    'maria@outlok.com': 'maria@outlook.com',
    'maria@yaho.com': 'maria@yahoo.com',
    'maria@iclod.com': 'maria@icloud.com',
    'maria@icloud.con': 'maria@icloud.com',
    'maria@uol.com': 'maria@uol.com.br',
  };
  for (const [typed, fixed] of Object.entries(typos)) assert.equal(hint.suggestEmail(typed), fixed, typed);
  // Endereços certos de provedores populares, de empresas e de provedores parecidos com um popular: nenhuma sugestão.
  for (const ok of ['maria@gmail.com', 'maria@icloud.com', 'maria@outlook.com.br', 'maria@hotmail.com.br', 'maria@email.com', 'maria@mail.com', 'maria@gmx.com', 'maria@minhaempresa.com.br', 'maria@copocheio.com.br', 'maria', 'a@b', 'maria@@gmail.com']) {
    assert.equal(hint.suggestEmail(ok), null, ok);
  }
  // Nenhum domínio dos provedores da lista ganha sugestão (a dica nunca atrapalha um endereço certo).
  const wrong = PROVIDERS.filter((domain) => hint.suggestEmail(`x@${domain}`) !== null);
  assert.deepEqual(wrong, []);
});

test('supressão automática: só os códigos e links pedidos pela própria pessoa passam por cima dela', () => {
  const survivors = Object.keys(kinds.KINDS).filter((name) => kinds.KINDS[name].survivesAutoSuppression);
  assert.deepEqual(survivors.sort(), ['admin_login_code', 'login_code', 'password_reset', 'verification']);
  for (const name of survivors) assert.equal(kinds.KINDS[name].userInitiated && kinds.KINDS[name].sensitive, true, name);
  // Promoções, avisos e e-mails de pedido continuam respeitando a lista de supressão.
  for (const name of ['campaign', 'order_received', 'payment_confirmed', 'already_registered', 'password_changed', 'admin_new_login']) {
    if (name in kinds.KINDS) assert.notEqual(kinds.KINDS[name].survivesAutoSuppression, true, name);
  }
});

test('validade dos códigos de login: 5 minutos (cliente e painel)', () => {
  assert.equal(login.LOGIN_CODE_MINUTES, 5);
  assert.equal(adminCode.ADMIN_CODE_MINUTES, 5);
});

test('DNS: provedor desconhecido só é barrado quando o DNS prova que o domínio não existe ou não recebe e-mail', async () => {
  const { Resolver } = await import('node:dns/promises');
  const make = (answers) => {
    const r = new Resolver();
    const err = (code) => Object.assign(new Error(code), { code });
    const pick = (type, domain) => {
      const v = (answers[domain] ?? { mx: [{ exchange: `mx.${domain}`, priority: 10 }], a: ['198.51.100.1'], aaaa: 'ENODATA' })[type];
      if (typeof v === 'string') throw err(v);
      return v;
    };
    r.resolveMx = async (d) => pick('mx', d);
    r.resolve4 = async (d) => pick('a', d);
    r.resolve6 = async (d) => pick('aaaa', d);
    return r;
  };
  const cases = {
    // [domínio, respostas, aceito?]
    'pequena-padaria.com.br': [undefined, true],
    'so-com-a.com.br': [{ 'so-com-a.com.br': { mx: 'ENODATA', a: ['203.0.113.5'], aaaa: 'ENODATA' } }, true],
    'dns-com-erro.com.br': [{ 'dns-com-erro.com.br': { mx: 'ESERVFAIL', a: 'ESERVFAIL', aaaa: 'ESERVFAIL' } }, true],
    'tempo-esgotado.com.br': [{ 'tempo-esgotado.com.br': { mx: 'ETIMEOUT', a: 'ETIMEOUT', aaaa: 'ETIMEOUT' } }, true],
    'nao-existe.com.br': [{ 'nao-existe.com.br': { mx: 'ENOTFOUND', a: 'ENOTFOUND', aaaa: 'ENOTFOUND' } }, false],
    'nao-recebe.com.br': [{ 'nao-recebe.com.br': { mx: [{ exchange: '', priority: 0 }], a: 'ENODATA', aaaa: 'ENODATA' } }, false],
  };
  for (const [domain, [answers, accepted]] of Object.entries(cases)) {
    const verdict = await dom.checkMailDomain(domain, make(answers ?? {}));
    assert.equal(verdict.ok, accepted, `${domain}: ${JSON.stringify(verdict)}`);
  }
});
